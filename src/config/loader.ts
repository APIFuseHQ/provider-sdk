import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import Redis from "ioredis";

import { BoundedExpiringMap } from "../runtime/bounded-expiring-map";
import type { ProviderProxyPolicy, TraceConfig } from "../types";

export const SMARTPROXY_APP_KEY_ENV = "APIFUSE__PROXY__SMARTPROXY_APP_KEY";
export const SMARTPROXY_MAX_LIFETIME_MINUTES = 2000;
export const DEFAULT_SMARTPROXY_POOL_SIZE = 20;
export const SMARTPROXY_MAX_POOL_SIZE = 20;
export const DEFAULT_PROXY_PROVIDER_ENV = "APIFUSE__PROXY__PROVIDER";
export const DEFAULT_PROXY_COUNTRY_ENV = "APIFUSE__PROXY__DEFAULT_COUNTRY";
export const DEFAULT_PROXY_LIFETIME_ENV =
	"APIFUSE__PROXY__DEFAULT_LIFETIME_MINUTES";
export const PROVIDER_CACHE_REDIS_URL_ENV =
	"APIFUSE__PROVIDER__CACHE_REDIS_URL";
export const PROVIDER_STATE_REDIS_URL_ENV =
	"APIFUSE__PROVIDER__STATE_REDIS_URL";
export const REDIS_URL_ENV = "APIFUSE__REDIS__URL";

export type ProxyOptions = {
	url: string;
};

export type ProxyConfig = Partial<ProxyOptions> & {
	provider?: string;
	apiKey?: string;
};

export type BrowserConfig = {
	executablePath?: string;
	headless?: boolean;
};

export type SessionConfig = {
	storage?: "sqlite" | "supabase";
	path?: string;
};

export type ApiFuseConfig = {
	proxy?: ProxyConfig;
	browser?: BrowserConfig;
	session?: SessionConfig;
	trace?: TraceConfig;
	credentials?: Record<string, Record<string, string>>;
};

export type ProxyResolutionOptions = {
	proxy?: string;
	upstream?: { proxy?: boolean | ProviderProxyPolicy };
	apifuseConfig?: Pick<ApiFuseConfig, "proxy">;
	proxyPolicy?: ProviderProxyPolicy;
	affinityKey?: string;
	/** Zero-based proxy-pool attempt index used by SDK transports for failover. */
	proxyAttempt?: number;
	telemetry?: ProxyTelemetrySink;
};

export type ProxyCacheStatus =
	| "memory_hit"
	| "redis_hit"
	| "allocator"
	| "soft_stale_refresh"
	| "lock_wait"
	| "redis_error"
	| "redis_corrupt"
	| "disabled";

export type SmartproxyAllocatorBodyClass =
	| "network_error"
	| "http_error"
	| "empty"
	| "json_without_proxies"
	| "text_without_proxies"
	| "usable_proxy_endpoints";

export type ProxyResolutionTelemetryEvent = {
	provider: "smartproxy";
	cacheStatus: ProxyCacheStatus;
	cacheHit: boolean;
	resolutionMs: number;
	allocatorMs?: number;
	allocatorStatus?: number;
	allocatorBodyClass?: SmartproxyAllocatorBodyClass;
	allocatorAttempts?: number;
	lockWaitMs?: number;
	redisReadMs?: number;
	redisWriteMs?: number;
	poolAgeMs?: number;
	poolExpiresInMs?: number;
	attempts: number;
	refreshes?: number;
};

export type ProxyAttemptTelemetryEvent = {
	provider: "smartproxy";
	attempt: number;
	poolIndex?: number;
	proxyHash?: string;
	outcome: "ok" | "error";
	errorCode?: string;
	status?: number;
	durationMs?: number;
};

export type ProxyTelemetrySink = {
	recordProxyResolution(event: ProxyResolutionTelemetryEvent): void;
	recordProxyAttempt?(event: ProxyAttemptTelemetryEvent): void;
};

export type ResolvedProxyConfig = {
	shouldWarn: boolean;
	url?: string;
	source?: "explicit" | "env" | "config" | "smartproxy-allocator";
	diagnostics?: Record<string, string | number | boolean>;
};

export class ProxyResolutionError extends Error {
	readonly code: "PROXY_REQUIRED" | "PROXY_ALLOCATION_FAILED";
	readonly telemetry?: ProxyResolutionTelemetryEvent;

	constructor(
		code: "PROXY_REQUIRED" | "PROXY_ALLOCATION_FAILED",
		message: string,
		options?: { cause?: unknown; telemetry?: ProxyResolutionTelemetryEvent },
	) {
		super(message, options);
		this.name = "ProxyResolutionError";
		this.code = code;
		this.telemetry = options?.telemetry;
	}
}

type CachedProxyPool = {
	urls: string[];
	allocatedAt: number;
	refreshAfter: number;
	expiresAt: number;
	diagnostics?: Record<string, string | number | boolean>;
};

type SmartproxyAllocationResult = {
	pool: CachedProxyPool;
	telemetry: ProxyResolutionTelemetryEvent;
};

type ProxyRedisClient = Pick<
	Redis,
	"connect" | "del" | "eval" | "get" | "on" | "pttl" | "set" | "status"
>;

const proxyInflight = new Map<string, Promise<SmartproxyAllocationResult>>();
const redisClients = new Map<string, ProxyRedisClient>();
let proxyRedisForTests: ProxyRedisClient | undefined;
let smartproxyAllocatorDeadlineMsForTests: number | undefined;

const PROXY_CACHE_PREFIX = "apifuse:proxy:smartproxy:v1";
const REDIS_TIMEOUT_MS = 150;
const SMARTPROXY_LOCK_TTL_MS = 10_000;
const SMARTPROXY_LOCK_POLL_MAX_MS = 9_000;
const SMARTPROXY_DEADLINE_MARGIN_MS = 1_000;
const SMARTPROXY_INVALIDATION_SKIP_REDIS_MS = 30_000;
const SMARTPROXY_ALLOCATOR_MAX_ATTEMPTS = 3;
const SMARTPROXY_ALLOCATOR_DEADLINE_MS =
	SMARTPROXY_LOCK_TTL_MS - SMARTPROXY_DEADLINE_MARGIN_MS;
const SMARTPROXY_ALLOCATOR_RETRY_BASE_MS = 25;
// Smartproxy API extraction returns fresh IP:port candidates; the `life`
// parameter controls session duration intent, not a hard endpoint lease. Keep
// successful extractions only briefly to collapse concurrent requests and avoid
// reusing stale raw CONNECT endpoints as if they were valid for `life` minutes.
const SMARTPROXY_EXTRACTION_CACHE_TTL_MS = 15_000;
const SMARTPROXY_EXTRACTION_SOFT_REFRESH_MS = 10_000;
const SMARTPROXY_POOL_CACHE_MAX_ENTRIES = 1_000;
const SMARTPROXY_INVALIDATION_CACHE_MAX_ENTRIES = 1_000;
const proxyCache = new BoundedExpiringMap<string, CachedProxyPool>({
	maxEntries: SMARTPROXY_POOL_CACHE_MAX_ENTRIES,
	expiresAt: (pool) => pool.expiresAt,
});
const invalidatedProxyKeys = new BoundedExpiringMap<string, number>({
	maxEntries: SMARTPROXY_INVALIDATION_CACHE_MAX_ENTRIES,
	expiresAt: (invalidatedUntil) => invalidatedUntil,
});

function redisUrlFromEnv(): string | undefined {
	return (
		process.env.APIFUSE__PROVIDER__CACHE_REDIS_URL?.trim() ||
		process.env[REDIS_URL_ENV]?.trim() ||
		undefined
	);
}

export function providerCacheRedisUrlFromEnv(): string | undefined {
	return redisUrlFromEnv();
}

export function providerStateRedisUrlFromEnv(): string | undefined {
	return (
		process.env[PROVIDER_STATE_REDIS_URL_ENV]?.trim() ||
		process.env[PROVIDER_CACHE_REDIS_URL_ENV]?.trim() ||
		process.env[REDIS_URL_ENV]?.trim() ||
		undefined
	);
}

/** @internal Test-only hook for exercising shared proxy-cache behavior. */
export function __setProxyRedisForTests(
	redis: ProxyRedisClient | undefined,
): void {
	proxyRedisForTests = redis;
}

export function __setSmartproxyAllocatorDeadlineMsForTests(
	deadlineMs: number | undefined,
): void {
	smartproxyAllocatorDeadlineMsForTests = deadlineMs;
}

/** @internal Test-only hook for verifying proxy-cache lifecycle invariants. */
export function __getProxyResolutionCacheStatsForTests(): {
	proxyCacheEntries: number;
	proxyInflightEntries: number;
	invalidatedProxyKeyEntries: number;
} {
	return {
		proxyCacheEntries: proxyCache.size,
		proxyInflightEntries: proxyInflight.size,
		invalidatedProxyKeyEntries: invalidatedProxyKeys.size,
	};
}

function getProxyRedis(): ProxyRedisClient | undefined {
	if (proxyRedisForTests) return proxyRedisForTests;
	const redisUrl = redisUrlFromEnv();
	if (!redisUrl) return undefined;
	const existing = redisClients.get(redisUrl);
	if (existing) return existing;

	const redis = new Redis(redisUrl, {
		connectTimeout: REDIS_TIMEOUT_MS,
		enableOfflineQueue: false,
		lazyConnect: true,
		maxRetriesPerRequest: 0,
		retryStrategy: () => null,
	});
	redis.on("error", () => {
		// Fail-open to allocator/memory; Redis connectivity must not choose direct egress.
	});
	redisClients.set(redisUrl, redis);
	return redis;
}

async function withRedisTimeout<T>(
	operation: () => Promise<T>,
): Promise<T | undefined> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<undefined>((resolve) => {
			timeoutId = setTimeout(() => resolve(undefined), REDIS_TIMEOUT_MS);
		});
		return await Promise.race([operation().catch(() => undefined), timeout]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}

function redisStatus(redis: ProxyRedisClient): string {
	return redis.status;
}

async function ensureRedisReady(redis: ProxyRedisClient): Promise<boolean> {
	if (redisStatus(redis) === "ready") return true;
	if (redisStatus(redis) === "wait" || redisStatus(redis) === "end") {
		const connected = await withRedisTimeout(async () => {
			await redis.connect();
			return true;
		});
		return connected === true && redisStatus(redis) === "ready";
	}
	return false;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function smartproxyRedisPoolKey(cacheKey: string): string {
	return `${PROXY_CACHE_PREFIX}:pool:${sha256(cacheKey)}`;
}

function smartproxyRedisLockKey(cacheKey: string): string {
	return `${PROXY_CACHE_PREFIX}:lock:${sha256(cacheKey)}`;
}

function isFresh(pool: CachedProxyPool, now: number): boolean {
	return pool.expiresAt > now;
}

function shouldSoftRefresh(pool: CachedProxyPool, now: number): boolean {
	return isFresh(pool, now) && pool.refreshAfter <= now;
}

function telemetryForPool(
	pool: CachedProxyPool,
	cacheStatus: ProxyCacheStatus,
	startedAt: number,
	extra: Partial<ProxyResolutionTelemetryEvent> = {},
): ProxyResolutionTelemetryEvent {
	const now = Date.now();
	return {
		provider: "smartproxy",
		cacheStatus,
		cacheHit: cacheStatus !== "allocator",
		resolutionMs: Math.max(0, now - startedAt),
		poolAgeMs: Math.max(0, now - pool.allocatedAt),
		poolExpiresInMs: Math.max(0, pool.expiresAt - now),
		attempts: 1,
		...extra,
	};
}

function telemetryForFailure(
	cacheStatus: ProxyCacheStatus,
	startedAt: number,
	extra: Partial<ProxyResolutionTelemetryEvent> = {},
): ProxyResolutionTelemetryEvent {
	return {
		provider: "smartproxy",
		cacheStatus,
		cacheHit: false,
		resolutionMs: Math.max(0, Date.now() - startedAt),
		attempts: 1,
		...extra,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toProxyDiagnostics(
	value: unknown,
): Record<string, string | number | boolean> | undefined {
	if (!isRecord(value)) return undefined;
	const diagnostics: Record<string, string | number | boolean> = {};
	for (const [key, item] of Object.entries(value)) {
		if (
			typeof item === "string" ||
			typeof item === "number" ||
			typeof item === "boolean"
		) {
			diagnostics[key] = item;
		}
	}
	return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}

function safeParseSmartproxyPool(raw: string | null): CachedProxyPool | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return null;
		const record = parsed;
		if (
			record.version !== 1 ||
			record.proxyProvider !== "smartproxy" ||
			!Array.isArray(record.urls) ||
			typeof record.allocatedAt !== "number" ||
			typeof record.refreshAfter !== "number" ||
			typeof record.expiresAt !== "number"
		) {
			return null;
		}
		const urls = record.urls.filter(
			(url): url is string => typeof url === "string" && url.startsWith("http"),
		);
		if (urls.length === 0) return null;
		return {
			urls,
			allocatedAt: record.allocatedAt,
			refreshAfter: record.refreshAfter,
			expiresAt: record.expiresAt,
			diagnostics: toProxyDiagnostics(record.diagnostics),
		};
	} catch {
		return null;
	}
}

function serializeSmartproxyPool(pool: CachedProxyPool): string {
	return JSON.stringify({
		version: 1,
		proxyProvider: "smartproxy",
		urls: pool.urls,
		allocatedAt: pool.allocatedAt,
		refreshAfter: pool.refreshAfter,
		expiresAt: pool.expiresAt,
		diagnostics: pool.diagnostics,
	});
}

function normalizeProxyUrl(url?: string): string | undefined {
	const normalized = url?.trim();
	return normalized ? applyStickyProxySession(normalized) : undefined;
}

function readPositiveIntegerEnv(name: string): string | undefined {
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	if (!/^[1-9]\d*$/.test(raw)) {
		throw new Error(`${name} must be a positive integer`);
	}
	return raw;
}

function applyStickyProxySession(proxyUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(proxyUrl);
	} catch {
		return proxyUrl;
	}

	if (!parsed.hostname || !parsed.username || !parsed.password) {
		return proxyUrl;
	}

	const host = parsed.hostname.toLowerCase();
	if (!host.includes("smartproxy") && !host.includes("decodo")) {
		return proxyUrl;
	}

	const username = decodeURIComponent(parsed.username);
	const sessionId =
		process.env.APIFUSE__PROXY__SESSION_ID?.trim() || "apifuse-shared";
	const sessionDuration = readPositiveIntegerEnv(
		"APIFUSE__PROXY__SESSION_DURATION",
	);
	const stickyUsername = host.includes("smartproxy")
		? buildSmartproxyUsername(username, sessionId, sessionDuration)
		: buildDecodoUsername(username, sessionId, sessionDuration ?? "60");

	parsed.username = stickyUsername;
	return parsed.toString();
}

function buildSmartproxyUsername(
	username: string,
	sessionId: string,
	sessionDuration?: string,
): string {
	const parts = username.split("_");
	const configuredLife = parts
		.find((part) => part.startsWith("life-"))
		?.slice("life-".length);
	const baseUsername = parts
		.filter((part) => !part.startsWith("session-") && !part.startsWith("life-"))
		.join("_");
	return `${baseUsername}_session-${sessionId}_life-${sessionDuration ?? configuredLife ?? "60"}`;
}

function buildDecodoUsername(
	username: string,
	sessionId: string,
	sessionDuration: string,
): string {
	const withoutSticky = username.replace(
		/-session-.+-sessionduration-\d+$/,
		"",
	);
	const baseUsername = withoutSticky.startsWith("user-")
		? withoutSticky
		: `user-${withoutSticky}`;
	return `${baseUsername}-session-${sessionId}-sessionduration-${sessionDuration}`;
}

function syncProxyEnv(config: ApiFuseConfig): void {
	const configProxyUrl = normalizeProxyUrl(config.proxy?.url);
	if (!process.env.APIFUSE__PROXY__URL && configProxyUrl) {
		process.env.APIFUSE__PROXY__URL = configProxyUrl;
	}
}

export function resolveProxyConfig(
	options: ProxyResolutionOptions = {},
): ResolvedProxyConfig {
	const explicitProxyUrl = normalizeProxyUrl(options.proxy);
	if (explicitProxyUrl) {
		return { shouldWarn: false, url: explicitProxyUrl };
	}

	const policy = resolvePolicy(options);
	if (policy?.mode === "disabled") {
		return { shouldWarn: false };
	}

	const legacyProxyRequested =
		options.upstream?.proxy === true || (!policy && options.upstream?.proxy);
	if (!legacyProxyRequested) {
		return { shouldWarn: false };
	}

	const envProxyUrl = normalizeProxyUrl(process.env.APIFUSE__PROXY__URL);
	if (envProxyUrl) {
		return { shouldWarn: false, url: envProxyUrl };
	}

	const configuredProxyUrl = normalizeProxyUrl(
		options.apifuseConfig?.proxy?.url,
	);
	if (configuredProxyUrl) {
		return { shouldWarn: false, url: configuredProxyUrl };
	}

	return { shouldWarn: true };
}

export async function resolveProxyConfigAsync(
	options: ProxyResolutionOptions = {},
): Promise<ResolvedProxyConfig> {
	const explicitProxyUrl = normalizeProxyUrl(options.proxy);
	if (explicitProxyUrl) {
		return { shouldWarn: false, url: explicitProxyUrl, source: "explicit" };
	}

	const policy = resolvePolicy(options);
	if (!policy) {
		return resolveProxyConfig(options);
	}
	if (policy.mode === "disabled") {
		return { shouldWarn: false };
	}

	const provider = resolveProxyProvider(policy);
	if (provider !== "smartproxy") {
		return resolveProxyConfig({
			...options,
			upstream: { proxy: true },
		});
	}

	const appKey = process.env[SMARTPROXY_APP_KEY_ENV]?.trim();
	if (!appKey) {
		if (policy.mode === "required") {
			throw new ProxyResolutionError(
				"PROXY_REQUIRED",
				`Smartproxy egress is required but ${SMARTPROXY_APP_KEY_ENV} is not configured.`,
			);
		}
		return { shouldWarn: true };
	}
	const lifetimeMinutes = resolveSmartproxyLifetime(policy);

	try {
		const allocated = await allocateSmartproxy(
			policy,
			appKey,
			lifetimeMinutes,
			options.affinityKey,
		);
		options.telemetry?.recordProxyResolution(allocated.telemetry);
		const poolIndex = selectProxyPoolIndex(
			allocated.pool.urls.length,
			options.proxyAttempt,
		);
		return {
			shouldWarn: false,
			url: allocated.pool.urls[poolIndex],
			source: "smartproxy-allocator",
			diagnostics: {
				...allocated.pool.diagnostics,
				poolSize: allocated.pool.urls.length,
				poolIndex,
			},
		};
	} catch (error) {
		if (error instanceof ProxyResolutionError && error.telemetry) {
			options.telemetry?.recordProxyResolution(error.telemetry);
		}
		if (policy.mode === "required") {
			throw error instanceof ProxyResolutionError
				? error
				: new ProxyResolutionError(
						"PROXY_ALLOCATION_FAILED",
						"Smartproxy allocator failed for required proxy egress.",
						{ cause: error },
					);
		}
		return { shouldWarn: true };
	}
}

function resolvePolicy(
	options: ProxyResolutionOptions,
): ProviderProxyPolicy | undefined {
	if (options.proxyPolicy) {
		return options.proxyPolicy;
	}
	const upstreamProxy = options.upstream?.proxy;
	if (upstreamProxy && typeof upstreamProxy === "object") {
		return upstreamProxy;
	}
	return undefined;
}

function resolveProxyProvider(policy: ProviderProxyPolicy): string {
	return (
		policy.provider ??
		process.env[DEFAULT_PROXY_PROVIDER_ENV]?.trim().toLowerCase() ??
		"custom"
	);
}

function resolveSmartproxyCountry(
	policy: ProviderProxyPolicy,
): string | undefined {
	return (
		policy.geo?.country ??
		process.env[DEFAULT_PROXY_COUNTRY_ENV]?.trim().toUpperCase() ??
		undefined
	);
}

function resolveSmartproxyLifetime(policy: ProviderProxyPolicy): number {
	const configuredLifetime =
		policy.session?.lifetimeMinutes ??
		readPositiveNumberEnv(DEFAULT_PROXY_LIFETIME_ENV, 30);
	return Math.min(
		SMARTPROXY_MAX_LIFETIME_MINUTES,
		Math.max(1, Math.floor(configuredLifetime)),
	);
}

function readPositiveNumberEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive number`);
	}
	return parsed;
}

function resolveSmartproxyPoolSize(policy: ProviderProxyPolicy): number {
	return Math.min(
		SMARTPROXY_MAX_POOL_SIZE,
		Math.max(
			1,
			Math.floor(policy.session?.poolSize ?? DEFAULT_SMARTPROXY_POOL_SIZE),
		),
	);
}

function selectProxyPoolIndex(poolSize: number, attempt = 0): number {
	if (poolSize <= 1) {
		return 0;
	}
	const normalizedAttempt = Number.isFinite(attempt)
		? Math.max(0, Math.floor(attempt))
		: 0;
	return normalizedAttempt % poolSize;
}

function buildSmartproxyCacheKey(
	policy: ProviderProxyPolicy,
	affinityKey: string | undefined,
	lifetimeMinutes: number,
): string {
	const poolSize = resolveSmartproxyPoolSize(policy);
	return JSON.stringify({
		provider: "smartproxy",
		country: resolveSmartproxyCountry(policy),
		affinity: policy.session?.affinity ?? "request",
		affinityKey:
			(policy.session?.affinity ?? "request") === "request"
				? undefined
				: affinityKey,
		lifetimeMinutes,
		poolSize,
	});
}

async function allocateSmartproxy(
	policy: ProviderProxyPolicy,
	appKey: string,
	lifetimeMinutes: number,
	affinityKey: string | undefined,
): Promise<SmartproxyAllocationResult> {
	const cacheKey = buildSmartproxyCacheKey(
		policy,
		affinityKey,
		lifetimeMinutes,
	);
	const startedAt = Date.now();
	const now = startedAt;
	const invalidatedUntil = invalidatedProxyKeys.get(cacheKey, now) ?? 0;
	const skipCached = invalidatedUntil > now;
	const cached = skipCached ? undefined : proxyCache.get(cacheKey, now);
	if (cached) {
		if (shouldSoftRefresh(cached, now)) {
			void refreshSmartproxyPool(cacheKey, policy, appKey, lifetimeMinutes);
			return {
				pool: cached,
				telemetry: telemetryForPool(cached, "soft_stale_refresh", startedAt, {
					refreshes: 1,
				}),
			};
		}
		return {
			pool: cached,
			telemetry: telemetryForPool(cached, "memory_hit", startedAt),
		};
	}

	if (!skipCached) {
		const redisResult = await readSmartproxyRedisPool(cacheKey, startedAt);
		if (redisResult) return redisResult;
	}

	const existingInflight = proxyInflight.get(cacheKey);
	if (existingInflight) {
		const result = await existingInflight;
		return {
			pool: result.pool,
			telemetry: telemetryForPool(result.pool, "lock_wait", startedAt, {
				lockWaitMs: Math.max(0, Date.now() - startedAt),
			}),
		};
	}

	const promise = allocateSmartproxyShared(
		cacheKey,
		policy,
		appKey,
		lifetimeMinutes,
		startedAt,
	).finally(() => {
		proxyInflight.delete(cacheKey);
	});
	proxyInflight.set(cacheKey, promise);
	const result = await promise;
	invalidatedProxyKeys.delete(cacheKey);
	return result;
}

async function readSmartproxyRedisPool(
	cacheKey: string,
	startedAt: number,
): Promise<SmartproxyAllocationResult | null> {
	const redis = getProxyRedis();
	if (!redis || !(await ensureRedisReady(redis))) return null;
	const redisStartedAt = Date.now();
	const raw = await withRedisTimeout(() =>
		redis.get(smartproxyRedisPoolKey(cacheKey)),
	);
	const redisReadMs = Math.max(0, Date.now() - redisStartedAt);
	if (typeof raw !== "string") return null;
	const pool = safeParseSmartproxyPool(raw);
	if (!pool) {
		await withRedisTimeout(() => redis.del(smartproxyRedisPoolKey(cacheKey)));
		return null;
	}
	const now = Date.now();
	if (!isFresh(pool, now)) return null;
	proxyCache.set(cacheKey, pool, now);
	return {
		pool,
		telemetry: telemetryForPool(pool, "redis_hit", startedAt, { redisReadMs }),
	};
}

async function refreshSmartproxyPool(
	cacheKey: string,
	policy: ProviderProxyPolicy,
	appKey: string,
	lifetimeMinutes: number,
): Promise<void> {
	try {
		await allocateSmartproxyShared(
			cacheKey,
			policy,
			appKey,
			lifetimeMinutes,
			Date.now(),
			{
				background: true,
			},
		);
	} catch {
		// Soft refresh is opportunistic; current fresh pool remains usable.
	}
}

async function allocateSmartproxyShared(
	cacheKey: string,
	policy: ProviderProxyPolicy,
	appKey: string,
	lifetimeMinutes: number,
	startedAt: number,
	options: { background?: boolean } = {},
): Promise<SmartproxyAllocationResult> {
	const redis = getProxyRedis();
	if (!redis || !(await ensureRedisReady(redis))) {
		return await allocateAndStoreSmartproxyPool(
			cacheKey,
			policy,
			appKey,
			lifetimeMinutes,
			startedAt,
			{ cacheStatus: "allocator" },
		);
	}

	const poolKey = smartproxyRedisPoolKey(cacheKey);
	const lockKey = smartproxyRedisLockKey(cacheKey);
	const waitStartedAt = Date.now();

	while (Date.now() - waitStartedAt < SMARTPROXY_LOCK_POLL_MAX_MS) {
		const token = randomUUID();
		const acquired = await withRedisTimeout(() =>
			redis.set(lockKey, token, "PX", SMARTPROXY_LOCK_TTL_MS, "NX"),
		);
		if (acquired === "OK") {
			try {
				return await allocateAndStoreSmartproxyPool(
					cacheKey,
					policy,
					appKey,
					lifetimeMinutes,
					startedAt,
					{
						cacheStatus: options.background
							? "soft_stale_refresh"
							: "allocator",
						redis,
						poolKey,
					},
				);
			} finally {
				await releaseSmartproxyRedisLock(redis, lockKey, token);
			}
		}

		const redisResult = await readSmartproxyRedisPool(cacheKey, startedAt);
		if (redisResult) {
			return {
				pool: redisResult.pool,
				telemetry: {
					...redisResult.telemetry,
					cacheStatus: "lock_wait",
					cacheHit: true,
					lockWaitMs: Math.max(0, Date.now() - waitStartedAt),
				},
			};
		}

		const pttl = await withRedisTimeout(() => redis.pttl(lockKey));
		if (typeof pttl === "number" && pttl <= 0) {
			continue;
		}
		if (
			Date.now() - startedAt >
			SMARTPROXY_LOCK_POLL_MAX_MS - SMARTPROXY_DEADLINE_MARGIN_MS
		) {
			break;
		}
		await sleep(
			Math.min(500, Math.max(50, typeof pttl === "number" ? pttl : 100)),
		);
	}

	throw new ProxyResolutionError(
		"PROXY_ALLOCATION_FAILED",
		"Smartproxy allocator lock did not produce a usable proxy pool before the request deadline.",
		{
			telemetry: telemetryForFailure("lock_wait", startedAt, {
				lockWaitMs: Math.max(0, Date.now() - waitStartedAt),
			}),
		},
	);
}

async function releaseSmartproxyRedisLock(
	redis: ProxyRedisClient,
	lockKey: string,
	token: string,
): Promise<void> {
	await withRedisTimeout(() =>
		redis.eval(
			'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
			1,
			lockKey,
			token,
		),
	);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout>;
		const onAbort = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.reason);
		};
		timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function smartproxyAllocatorDeadlineMs(): number {
	return (
		smartproxyAllocatorDeadlineMsForTests ?? SMARTPROXY_ALLOCATOR_DEADLINE_MS
	);
}

function createDeadlineAbortController(deadlineAt: number): {
	controller: AbortController;
	dispose: () => void;
} {
	const controller = new AbortController();
	const remainingMs = deadlineAt - Date.now();
	if (remainingMs <= 0) {
		controller.abort(new Error("Smartproxy allocator deadline exceeded."));
		return { controller, dispose: () => undefined };
	}
	const timeout = setTimeout(() => {
		controller.abort(new Error("Smartproxy allocator deadline exceeded."));
	}, remainingMs);
	return {
		controller,
		dispose: () => clearTimeout(timeout),
	};
}

function smartproxyAllocatorDeadlineFailure(
	attempt: number,
): SmartproxyAllocatorFailure {
	return {
		ok: false,
		attempt,
		bodyClass: "network_error",
		cause: new Error("Smartproxy allocator deadline exceeded."),
	};
}

function smartproxyAllocatorDeadlineError(): Error {
	return new Error("Smartproxy allocator deadline exceeded.");
}

async function readSmartproxyAllocatorBodyWithDeadline(
	response: Response,
	signal: AbortSignal,
): Promise<string> {
	if (signal.aborted) {
		throw signal.reason ?? smartproxyAllocatorDeadlineError();
	}

	return await new Promise<string>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
		};
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onAbort = () => {
			settle(() => reject(signal.reason ?? smartproxyAllocatorDeadlineError()));
		};

		signal.addEventListener("abort", onAbort, { once: true });

		try {
			void response.text().then(
				(body) => settle(() => resolve(body)),
				(error: unknown) => settle(() => reject(error)),
			);
		} catch (error) {
			settle(() => reject(error));
		}
	});
}

async function allocateAndStoreSmartproxyPool(
	cacheKey: string,
	policy: ProviderProxyPolicy,
	appKey: string,
	lifetimeMinutes: number,
	startedAt: number,
	options: {
		cacheStatus: ProxyCacheStatus;
		redis?: ProxyRedisClient;
		poolKey?: string;
	},
): Promise<SmartproxyAllocationResult> {
	const poolSize = resolveSmartproxyPoolSize(policy);
	const allocatorUrl = buildSmartproxyAllocatorUrl(
		policy,
		appKey,
		lifetimeMinutes,
		poolSize,
	);
	const allocatorStartedAt = Date.now();
	const allocatorDeadlineAt =
		allocatorStartedAt + smartproxyAllocatorDeadlineMs();
	let allocation: SmartproxyAllocatorSuccess | undefined;
	let lastFailure: SmartproxyAllocatorFailure | undefined;
	for (
		let attempt = 1;
		attempt <= SMARTPROXY_ALLOCATOR_MAX_ATTEMPTS;
		attempt += 1
	) {
		if (Date.now() >= allocatorDeadlineAt) {
			lastFailure = smartproxyAllocatorDeadlineFailure(attempt);
			break;
		}
		const attemptResult = await fetchSmartproxyAllocatorAttempt(
			allocatorUrl,
			attempt,
			allocatorDeadlineAt,
		);
		if (attemptResult.ok) {
			allocation = attemptResult;
			break;
		}
		lastFailure = attemptResult;
		if (attempt < SMARTPROXY_ALLOCATOR_MAX_ATTEMPTS) {
			if (Date.now() >= allocatorDeadlineAt) break;
			const { controller, dispose } =
				createDeadlineAbortController(allocatorDeadlineAt);
			try {
				await sleep(smartproxyAllocatorBackoffMs(attempt), controller.signal);
			} catch {
				break;
			} finally {
				dispose();
			}
		}
	}

	const allocatorMs = Math.max(0, Date.now() - allocatorStartedAt);
	const allocatorAttempts =
		allocation?.attempt ??
		lastFailure?.attempt ??
		SMARTPROXY_ALLOCATOR_MAX_ATTEMPTS;
	const allocatorBodyClass =
		lastFailure?.bodyClass ?? allocation?.bodyClass ?? "usable_proxy_endpoints";
	const allocatorStatus = lastFailure ? lastFailure.status : allocation?.status;

	if (!allocation) {
		throw new ProxyResolutionError(
			"PROXY_ALLOCATION_FAILED",
			smartproxyAllocatorFailureMessage(lastFailure),
			{
				cause: lastFailure?.cause,
				telemetry: telemetryForFailure(options.cacheStatus, startedAt, {
					allocatorMs,
					allocatorAttempts,
					allocatorBodyClass,
					...(allocatorStatus === undefined ? {} : { allocatorStatus }),
					attempts: allocatorAttempts,
				}),
			},
		);
	}

	const urls = allocation.urls;

	const allocatedAt = Date.now();
	const ttlMs = SMARTPROXY_EXTRACTION_CACHE_TTL_MS;
	const refreshAfter = allocatedAt + SMARTPROXY_EXTRACTION_SOFT_REFRESH_MS;
	const result: CachedProxyPool = {
		urls,
		allocatedAt,
		refreshAfter,
		expiresAt: allocatedAt + ttlMs,
		diagnostics: {
			provider: "smartproxy",
			country: resolveSmartproxyCountry(policy) ?? "default",
			lifetimeMinutes,
			affinity: policy.session?.affinity ?? "request",
			rawConnect: true,
		},
	};
	proxyCache.set(cacheKey, result, allocatedAt);
	if (options.redis && options.poolKey) {
		const redis = options.redis;
		const poolKey = options.poolKey;
		const redisWriteStartedAt = Date.now();
		await withRedisTimeout(() =>
			redis.set(
				poolKey,
				serializeSmartproxyPool(result),
				"PX",
				Math.max(1_000, result.expiresAt - Date.now()),
			),
		);
		return {
			pool: result,
			telemetry: telemetryForPool(result, options.cacheStatus, startedAt, {
				allocatorMs,
				allocatorAttempts,
				allocatorBodyClass,
				...(allocatorStatus === undefined ? {} : { allocatorStatus }),
				attempts: allocatorAttempts,
				redisWriteMs: Math.max(0, Date.now() - redisWriteStartedAt),
			}),
		};
	}
	return {
		pool: result,
		telemetry: telemetryForPool(result, options.cacheStatus, startedAt, {
			allocatorMs,
			allocatorAttempts,
			allocatorBodyClass,
			...(allocatorStatus === undefined ? {} : { allocatorStatus }),
			attempts: allocatorAttempts,
		}),
	};
}

type SmartproxyAllocatorAttemptResult =
	| SmartproxyAllocatorSuccess
	| SmartproxyAllocatorFailure;

type SmartproxyAllocatorSuccess = {
	ok: true;
	attempt: number;
	status: number;
	bodyClass: SmartproxyAllocatorBodyClass;
	urls: string[];
};

type SmartproxyAllocatorFailure = {
	ok: false;
	attempt: number;
	status?: number;
	bodyClass: SmartproxyAllocatorBodyClass;
	cause?: unknown;
};

async function fetchSmartproxyAllocatorAttempt(
	allocatorUrl: string,
	attempt: number,
	deadlineAt: number,
): Promise<SmartproxyAllocatorAttemptResult> {
	const { controller, dispose } = createDeadlineAbortController(deadlineAt);
	let response: Response;
	try {
		response = await fetch(allocatorUrl, {
			headers: { Accept: "application/json,text/plain;q=0.9,*/*;q=0.8" },
			signal: controller.signal,
		});
	} catch (error) {
		dispose();
		return {
			ok: false,
			attempt,
			bodyClass: "network_error",
			cause: error,
		};
	}

	let body: string;
	try {
		body = await readSmartproxyAllocatorBodyWithDeadline(
			response,
			controller.signal,
		);
	} catch (error) {
		dispose();
		return {
			ok: false,
			attempt,
			status: response.status,
			bodyClass: "network_error",
			cause: error,
		};
	} finally {
		dispose();
	}

	if (!response.ok) {
		return {
			ok: false,
			attempt,
			status: response.status,
			bodyClass: "http_error",
		};
	}

	const urls = parseSmartproxyAllocatorProxies(body);
	const bodyClass = classifySmartproxyAllocatorBody(body, urls);
	if (urls.length === 0) {
		return {
			ok: false,
			attempt,
			status: response.status,
			bodyClass,
		};
	}
	return {
		ok: true,
		attempt,
		status: response.status,
		bodyClass,
		urls,
	};
}

function smartproxyAllocatorBackoffMs(attempt: number): number {
	const base =
		SMARTPROXY_ALLOCATOR_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
	const jitter = Math.floor(Math.random() * SMARTPROXY_ALLOCATOR_RETRY_BASE_MS);
	return base + jitter;
}

function smartproxyAllocatorFailureMessage(
	failure: SmartproxyAllocatorFailure | undefined,
): string {
	if (!failure) {
		return "Smartproxy allocator failed.";
	}
	if (failure.bodyClass === "network_error") {
		return "Smartproxy allocator request failed.";
	}
	if (failure.bodyClass === "http_error") {
		return `Smartproxy allocator returned HTTP ${failure.status ?? "error"}.`;
	}
	return "Smartproxy allocator response did not contain a usable proxy endpoint.";
}

function buildSmartproxyAllocatorUrl(
	policy: ProviderProxyPolicy,
	appKey: string,
	lifetimeMinutes: number,
	poolSize: number,
): string {
	const params = new URLSearchParams({
		app_key: appKey,
		pt: "9",
		num: String(poolSize),
		life: String(lifetimeMinutes),
		protocol: "1",
		format: "txt",
		lb: "\\n",
	});
	const country = resolveSmartproxyCountry(policy);
	if (country) {
		params.set("cc", country);
	}
	return `https://www.smartproxy.org/web_v1/ip/get-ip-v3?${params.toString()}`;
}

function parseSmartproxyAllocatorProxies(body: string): string[] {
	const trimmed = body.trim();
	if (!trimmed) {
		return [];
	}

	try {
		const parsed: unknown = JSON.parse(trimmed);
		const data =
			parsed && typeof parsed === "object" && "data" in parsed
				? parsed.data
				: undefined;
		const list =
			data && typeof data === "object" && "list" in data
				? data.list
				: undefined;
		if (Array.isArray(list)) {
			return list
				.map((item) => {
					if (!item || typeof item !== "object") {
						return null;
					}
					const ip = "ip" in item && typeof item.ip === "string" ? item.ip : "";
					const port =
						"port" in item &&
						(typeof item.port === "string" || typeof item.port === "number")
							? item.port
							: "";
					return ip && port ? `http://${ip}:${port}` : null;
				})
				.filter((url): url is string => url !== null);
		}
	} catch {
		// Text allocator format falls through.
	}

	return trimmed
		.split(/\r?\n/)
		.map((item) => item.trim())
		.filter((item) => /^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(item))
		.map((line) => `http://${line}`);
}

function classifySmartproxyAllocatorBody(
	body: string,
	urls: string[],
): SmartproxyAllocatorBodyClass {
	if (urls.length > 0) {
		return "usable_proxy_endpoints";
	}
	const trimmed = body.trim();
	if (!trimmed) {
		return "empty";
	}
	try {
		JSON.parse(trimmed);
		return "json_without_proxies";
	} catch {
		return "text_without_proxies";
	}
}

export function clearProxyResolutionCache(): void {
	proxyCache.clear();
	proxyInflight.clear();
	invalidatedProxyKeys.clear();
}

function markSmartproxyCacheInvalidated(
	options: ProxyResolutionOptions = {},
): string | undefined {
	const policy = resolvePolicy(options);
	if (!policy || policy.mode === "disabled") {
		return undefined;
	}
	if (resolveProxyProvider(policy) !== "smartproxy") {
		return undefined;
	}

	const lifetimeMinutes = resolveSmartproxyLifetime(policy);
	const cacheKey = buildSmartproxyCacheKey(
		policy,
		options.affinityKey,
		lifetimeMinutes,
	);
	const now = Date.now();
	invalidatedProxyKeys.set(
		cacheKey,
		now + SMARTPROXY_INVALIDATION_SKIP_REDIS_MS,
		now,
	);
	proxyCache.delete(cacheKey);
	proxyInflight.delete(cacheKey);
	return cacheKey;
}

export function invalidateProxyResolutionCache(
	options: ProxyResolutionOptions = {},
): boolean {
	return markSmartproxyCacheInvalidated(options) !== undefined;
}

export async function invalidateProxyResolutionCacheAsync(
	options: ProxyResolutionOptions = {},
): Promise<boolean> {
	const cacheKey = markSmartproxyCacheInvalidated(options);
	if (!cacheKey) return false;
	const redis = getProxyRedis();
	try {
		if (redis && (await ensureRedisReady(redis))) {
			await withRedisTimeout(() => redis.del(smartproxyRedisPoolKey(cacheKey)));
		}
	} catch {
		// Cache invalidation must not turn a stale proxy retry into a Redis outage.
	}
	return true;
}

export function defineConfig(config: ApiFuseConfig): ApiFuseConfig {
	return config;
}

async function importConfig(filePath: string): Promise<ApiFuseConfig | null> {
	try {
		const moduleUrl = new URL(`file://${encodeURI(filePath)}`);
		const mod = (await import(moduleUrl.href)) as { default?: ApiFuseConfig };
		if (mod.default && typeof mod.default === "object") {
			return mod.default;
		}
		console.warn(`[provider-sdk] Ignoring invalid config export: ${filePath}`);
		return {};
	} catch (error) {
		console.warn(`[provider-sdk] Failed to load config ${filePath}:`, error);
		return null;
	}
}

export async function loadApiFuseConfig(
	dir: string = process.cwd(),
): Promise<ApiFuseConfig> {
	const tsPath = path.resolve(dir, "apifuse.config.ts");
	if (existsSync(tsPath)) {
		const config = await importConfig(tsPath);
		const resolvedConfig = config ?? {};
		syncProxyEnv(resolvedConfig);
		return resolvedConfig;
	}

	const jsPath = path.resolve(dir, "apifuse.config.js");
	if (existsSync(jsPath)) {
		const config = await importConfig(jsPath);
		const resolvedConfig = config ?? {};
		syncProxyEnv(resolvedConfig);
		return resolvedConfig;
	}

	return {};
}
