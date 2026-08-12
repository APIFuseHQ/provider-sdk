import { createHash, createHmac } from "node:crypto";

import { providerCacheRedisUrlFromEnv } from "../config/loader.js";
import { ProviderError } from "../errors.js";
import type {
	ProviderCache,
	ProviderCacheGetOrSetOptions,
	ProviderCacheKeyOptions,
	ProviderCacheLookupMeta,
	ProviderCacheResponseMeta,
	ProviderCacheResult,
} from "../types.js";
import {
	createProviderRedisClient,
	ensureRedisReady,
	type ProviderRedisClient,
	withRedisTimeout,
} from "./redis.js";

type CacheSource = ProviderCacheLookupMeta["source"];

type CacheEnvelope = {
	value: unknown;
	writtenAt: number;
	freshUntil: number;
	staleUntil: number;
};

type MemoryEntry = CacheEnvelope & {
	expiresAt: number;
	lastAccessedAt: number;
};

type SharedCacheBackend = {
	redis?: ProviderRedisClient;
	memory: Map<string, MemoryEntry>;
	inflight: Map<string, Promise<ProviderCacheResult<unknown>>>;
};

export type ProviderCacheOptions = {
	providerId: string;
	redisUrl?: string;
	memoryMaxEntries?: number;
	now?: () => number;
};

export const APIFUSE__CACHE__KEY_PEPPER_ENV = "APIFUSE__CACHE__KEY_PEPPER";

const DEFAULT_PREFIX = "apifuse:provider-cache:v1";
const DEFAULT_MEMORY_MAX_ENTRIES = 1_000;
const DEFAULT_REDIS_TIMEOUT_MS = 150;
const SECRET_SCOPED_KEY_MARKER = "[secret-scoped";
const SECRET_FIELD_NAMES = new Set([
	"authorization",
	"cookie",
	"password",
	"secret",
	"servicekey",
	"service_key",
	"token",
	"apikey",
	"api_key",
	"access_token",
	"refresh_token",
]);

const sharedBackends = new Map<string, SharedCacheBackend>();
let warnedAboutUnpepperedSecretKeys = false;

function backendKey(redisUrl: string | undefined): string {
	return redisUrl ?? "memory";
}

function getSharedBackend(redisUrl: string | undefined): SharedCacheBackend {
	const key = backendKey(redisUrl);
	const existing = sharedBackends.get(key);
	if (existing) return existing;

	const backend: SharedCacheBackend = {
		memory: new Map(),
		inflight: new Map(),
	};

	if (redisUrl) {
		const redis = createProviderRedisClient({
			redisUrl,
			timeoutMs: DEFAULT_REDIS_TIMEOUT_MS,
			onError: () => {
				// Fail-open: cache connectivity must never fail provider execution.
			},
		});
		backend.redis = redis;
	}

	sharedBackends.set(key, backend);
	return backend;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shouldRedactField(name: string, extra: Set<string>): boolean {
	const normalized = name.toLowerCase();
	return (
		SECRET_FIELD_NAMES.has(normalized) ||
		extra.has(normalized) ||
		normalized.includes("authorization") ||
		normalized.includes("cookie") ||
		normalized.includes("password") ||
		normalized.includes("secret")
	);
}

type NormalizedKeyPart = {
	value: unknown;
	secretScoped: boolean;
};

function unsupportedSecretValue(path: string, reason: string): never {
	throw new ProviderError(`Secret cache-key values must be JSON-safe; ${reason} at ${path}.`, {
		code: "CACHE_KEY_SECRET_VALUE_UNSUPPORTED",
		fix: "Convert the secret cache-key selector to JSON-safe primitives, arrays, or plain objects.",
	});
}

function assertJsonSafeSecretValue(
	value: unknown,
	reportedPath: string,
	ancestors = new Set<object>(),
): void {
	if (value === undefined) return;
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			unsupportedSecretValue(reportedPath, "non-finite numbers are unsupported");
		if (Object.is(value, -0))
			unsupportedSecretValue(reportedPath, "negative zero is unsupported");
		return;
	}
	if (typeof value !== "object") {
		unsupportedSecretValue(reportedPath, `${typeof value} values are unsupported`);
	}
	if (ancestors.has(value))
		unsupportedSecretValue(reportedPath, "cyclic values are unsupported");

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getOwnPropertySymbols(value).length > 0) {
				unsupportedSecretValue(reportedPath, "symbol-keyed array properties are unsupported");
			}
			const expectedNames = new Set(["length"]);
			for (let index = 0; index < value.length; index += 1) {
				const key = String(index);
				expectedNames.add(key);
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor)
					unsupportedSecretValue(reportedPath, "sparse arrays are unsupported");
				if (!descriptor.enumerable || !("value" in descriptor)) {
					unsupportedSecretValue(reportedPath, "array accessors are unsupported");
				}
				assertJsonSafeSecretValue(descriptor.value, reportedPath, ancestors);
			}
			if (Object.getOwnPropertyNames(value).some((name) => !expectedNames.has(name))) {
				unsupportedSecretValue(reportedPath, "custom array properties are unsupported");
			}
			return;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			unsupportedSecretValue(reportedPath, "non-plain objects are unsupported");
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			unsupportedSecretValue(reportedPath, "symbol-keyed properties are unsupported");
		}
		for (const key of Object.getOwnPropertyNames(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) {
				unsupportedSecretValue(
					reportedPath,
					"non-enumerable properties and accessors are unsupported",
				);
			}
			assertJsonSafeSecretValue(descriptor.value, reportedPath, ancestors);
		}
	} finally {
		ancestors.delete(value);
	}
}

function containsUndefined(value: unknown): boolean {
	if (value === undefined) return true;
	if (Array.isArray(value)) return value.some(containsUndefined);
	if (isRecord(value)) return Object.values(value).some(containsUndefined);
	return false;
}

function tagSecretValue(value: unknown): unknown {
	if (value === undefined) return ["undefined"];
	if (value === null) return ["null"];
	if (typeof value === "string") return ["string", value];
	if (typeof value === "number") return ["number", value];
	if (typeof value === "boolean") return ["boolean", value];
	if (Array.isArray(value)) return ["array", value.map(tagSecretValue)];
	return [
		"object",
		Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
			key,
			tagSecretValue(entry),
		]),
	];
}

function serializeSecretValue(value: unknown): string {
	if (!containsUndefined(value)) return JSON.stringify([value]);
	return `undefined-v1:${JSON.stringify(tagSecretValue(value))}`;
}

function warnAboutUnpepperedSecretKey(): void {
	if (warnedAboutUnpepperedSecretKeys) return;
	warnedAboutUnpepperedSecretKeys = true;
	console.warn(
		JSON.stringify({
			level: "warn",
			event: "provider_cache_secret_key_unpeppered",
			message: `Secret-bearing cache keys are using unkeyed SHA-256 because ${APIFUSE__CACHE__KEY_PEPPER_ENV} is not configured.`,
		}),
	);
}

function normalizeKeyPart(
	value: unknown,
	extra: Set<string>,
	pepper: string | undefined,
): NormalizedKeyPart {
	if (Array.isArray(value)) {
		const entries = value.map((entry) => normalizeKeyPart(entry, extra, pepper));
		return {
			value: entries.map((entry) => entry.value),
			secretScoped: entries.some((entry) => entry.secretScoped),
		};
	}
	if (isRecord(value)) {
		const normalized: Record<string, unknown> = Object.create(null);
		let secretScoped = false;
		for (const key of Object.keys(value).sort()) {
			const part = shouldRedactField(key, extra)
				? hashSecretValue(value[key], key, extra, pepper)
				: normalizeKeyPart(value[key], extra, pepper);
			normalized[key] = part.value;
			secretScoped ||= part.secretScoped;
		}
		return { value: normalized, secretScoped };
	}
	return { value, secretScoped: false };
}

function hashSecretValue(
	value: unknown,
	fieldName: string,
	extra: Set<string>,
	pepper: string | undefined,
): NormalizedKeyPart {
	assertJsonSafeSecretValue(value, `${fieldName} (inside secret value)`);
	const canonical = serializeSecretValue(normalizeKeyPart(value, extra, pepper).value);
	if (pepper === undefined) {
		warnAboutUnpepperedSecretKey();
		const digest = createHash("sha256").update(canonical).digest("hex");
		return { value: `sha256:${digest}`, secretScoped: true };
	}
	const digest = createHmac("sha256", pepper).update(canonical).digest("hex");
	return { value: `hmac-sha256:${digest}`, secretScoped: true };
}

function metadataKeys(
	events: ProviderCacheLookupMeta[],
	secretScopedKeys: Set<string>,
): string[] {
	let secretScopedIndex = 0;
	return Array.from(new Set(events.map((event) => event.key))).map((key) => {
		if (!secretScopedKeys.has(key)) return key;
		secretScopedIndex += 1;
		return `${SECRET_SCOPED_KEY_MARKER}#${secretScopedIndex}]`;
	});
}

function stableHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function jitteredTtlMs(ttlMs: number, jitterPct: number | undefined): number {
	if (!jitterPct || jitterPct <= 0) return ttlMs;
	const bounded = Math.min(jitterPct, 0.5);
	const delta = ttlMs * bounded;
	const multiplier = 1 - bounded + (Math.random() * delta * 2) / ttlMs;
	return Math.max(1, Math.round(ttlMs * multiplier));
}

function safeParseEnvelope(raw: string | null): CacheEnvelope | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			!isRecord(parsed) ||
			typeof parsed.writtenAt !== "number" ||
			typeof parsed.freshUntil !== "number" ||
			typeof parsed.staleUntil !== "number" ||
			!("value" in parsed)
		) {
			return null;
		}
		return {
			value: parsed.value,
			writtenAt: parsed.writtenAt,
			freshUntil: parsed.freshUntil,
			staleUntil: parsed.staleUntil,
		};
	} catch {
		return null;
	}
}

function resultWithValue<T>(value: unknown, meta: ProviderCacheLookupMeta): ProviderCacheResult<T> {
	return {
		value: <T>value,
		meta,
	};
}

function resultFromEnvelope<T>(
	key: string,
	envelope: CacheEnvelope,
	now: number,
	source: CacheSource,
): ProviderCacheResult<T> | null {
	if (now > envelope.staleUntil) return null;
	return resultWithValue<T>(envelope.value, {
		key,
		hit: true,
		stale: now > envelope.freshUntil,
		ageMs: Math.max(0, now - envelope.writtenAt),
		source,
	});
}

function sourceSummary(events: ProviderCacheLookupMeta[]): ProviderCacheResponseMeta["source"] {
	const sources = new Set(events.map((event) => event.source));
	if (sources.size === 0) return undefined;
	if (sources.size === 1) return events[0]?.source;
	return "mixed";
}

async function withRedisFallback<T>(operation: () => Promise<T>): Promise<T | undefined> {
	return await withRedisTimeout(operation, {
		timeoutMs: DEFAULT_REDIS_TIMEOUT_MS,
		onTimeout: () => undefined,
		onError: () => undefined,
	});
}

export function createProviderCache(options: ProviderCacheOptions): ProviderCache {
	const redisUrl = options.redisUrl ?? providerCacheRedisUrlFromEnv();
	const configuredPepper = process.env[APIFUSE__CACHE__KEY_PEPPER_ENV];
	const pepper = configuredPepper && configuredPepper.length > 0 ? configuredPepper : undefined;
	const backend = getSharedBackend(redisUrl);
	const memoryMaxEntries = Math.max(1, options.memoryMaxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES);
	const now = options.now ?? Date.now;
	const events: ProviderCacheLookupMeta[] = [];
	const secretScopedKeys = new Set<string>();

	function record(meta: ProviderCacheLookupMeta): void {
		events.push(meta);
	}

	function sweepMemory(currentTime: number): void {
		for (const [entryKey, entry] of backend.memory) {
			if (entry.expiresAt <= currentTime) {
				backend.memory.delete(entryKey);
			}
		}
	}

	function enforceMemoryLimit(): void {
		while (backend.memory.size > memoryMaxEntries) {
			const oldestKey = backend.memory.keys().next().value;
			if (typeof oldestKey !== "string") return;
			backend.memory.delete(oldestKey);
		}
	}

	function rememberEnvelope(key: string, envelope: CacheEnvelope, currentTime: number): void {
		sweepMemory(currentTime);
		backend.memory.delete(key);
		backend.memory.set(key, {
			...envelope,
			expiresAt: envelope.staleUntil,
			lastAccessedAt: currentTime,
		});
		enforceMemoryLimit();
	}

	function touchMemory(key: string, entry: MemoryEntry, currentTime: number): void {
		backend.memory.delete(key);
		backend.memory.set(key, { ...entry, lastAccessedAt: currentTime });
	}

	async function readRedis<T>(
		key: string,
		currentTime: number,
	): Promise<{
		envelope: CacheEnvelope;
		result: ProviderCacheResult<T>;
	} | null> {
		const redis = backend.redis;
		if (!redis || !(await ensureRedisReady(redis, DEFAULT_REDIS_TIMEOUT_MS))) {
			return null;
		}

		const raw = await withRedisFallback(async () => {
			return await redis.get(key);
		});
		if (typeof raw !== "string" && raw !== null) return null;

		const envelope = safeParseEnvelope(raw);
		if (!envelope) return null;

		const result = resultFromEnvelope<T>(key, envelope, currentTime, "redis");
		if (!result) return null;

		rememberEnvelope(key, envelope, currentTime);
		return { envelope, result };
	}

	async function read<T>(key: string): Promise<ProviderCacheResult<T> | null> {
		const currentTime = now();
		const memoryEntry = backend.memory.get(key);
		let staleMemoryResult: ProviderCacheResult<T> | null = null;
		let staleMemoryWrittenAt: number | undefined;
		if (memoryEntry) {
			if (memoryEntry.expiresAt <= currentTime) {
				backend.memory.delete(key);
			} else {
				const memoryResult = resultFromEnvelope<T>(key, memoryEntry, currentTime, "memory");
				if (memoryResult && !memoryResult.meta.stale) {
					touchMemory(key, memoryEntry, currentTime);
					return memoryResult;
				}
				staleMemoryResult = memoryResult;
				staleMemoryWrittenAt = memoryEntry.writtenAt;
				touchMemory(key, memoryEntry, currentTime);
			}
		}

		const redisResult = await readRedis<T>(key, currentTime);
		if (redisResult) {
			if (!staleMemoryResult) return redisResult.result;
			if (
				!redisResult.result.meta.stale ||
				redisResult.envelope.writtenAt >= (staleMemoryWrittenAt ?? 0)
			) {
				return redisResult.result;
			}
		}

		return staleMemoryResult;
	}

	async function write<T>(
		key: string,
		value: T,
		cacheOptions: ProviderCacheGetOrSetOptions,
	): Promise<void> {
		const currentTime = now();
		const freshTtlMs = jitteredTtlMs(cacheOptions.ttlMs, cacheOptions.jitterPct);
		const staleIfErrorMs = cacheOptions.staleIfErrorMs ?? 0;
		const staleTtlMs = freshTtlMs + staleIfErrorMs;
		const envelope: CacheEnvelope = {
			value,
			writtenAt: currentTime,
			freshUntil: currentTime + freshTtlMs,
			staleUntil: currentTime + staleTtlMs,
		};
		rememberEnvelope(key, envelope, currentTime);

		const redis = backend.redis;
		if (!redis || !(await ensureRedisReady(redis, DEFAULT_REDIS_TIMEOUT_MS))) {
			return;
		}
		await withRedisFallback(() => redis.set(key, JSON.stringify(envelope), "PX", staleTtlMs));
	}

	async function loadAndStore<T>(
		key: string,
		loader: () => Promise<T>,
		cacheOptions: ProviderCacheGetOrSetOptions,
		staleCandidate: ProviderCacheResult<T> | null,
	): Promise<ProviderCacheResult<T>> {
		try {
			const value = await loader();
			await write(key, value, cacheOptions);
			return {
				value,
				meta: {
					key,
					hit: false,
					stale: false,
					source: "loader",
				},
			};
		} catch (error) {
			if (staleCandidate?.meta.stale) {
				return staleCandidate;
			}
			throw error;
		}
	}

	return {
		key(namespace, parts, keyOptions?: ProviderCacheKeyOptions) {
			const extra = new Set((keyOptions?.redactFields ?? []).map((field) => field.toLowerCase()));
			const normalized = normalizeKeyPart(parts, extra, pepper);
			const key = `${DEFAULT_PREFIX}:${options.providerId}:${namespace}:${stableHash(normalized.value)}`;
			if (normalized.secretScoped) secretScopedKeys.add(key);
			return key;
		},

		async get<T = unknown>(key: string): Promise<ProviderCacheResult<T> | null> {
			const result = await read<T>(key);
			if (result) record(result.meta);
			return result;
		},

		set: write,

		async delete(key: string): Promise<void> {
			backend.memory.delete(key);
			const redis = backend.redis;
			if (!redis || !(await ensureRedisReady(redis, DEFAULT_REDIS_TIMEOUT_MS))) {
				return;
			}
			await withRedisFallback(() => redis.del(key));
		},

		async getOrSet<T = unknown>(
			key: string,
			loader: () => Promise<T>,
			cacheOptions: ProviderCacheGetOrSetOptions,
		): Promise<ProviderCacheResult<T>> {
			const existing = await read<T>(key);
			if (existing && !existing.meta.stale) {
				record(existing.meta);
				return existing;
			}

			const existingInflight = backend.inflight.get(key);
			if (existingInflight) {
				const inflightResult = await existingInflight;
				const result = resultWithValue<T>(inflightResult.value, inflightResult.meta);
				record(result.meta);
				return result;
			}

			const promise: Promise<ProviderCacheResult<unknown>> = loadAndStore(
				key,
				loader,
				cacheOptions,
				existing,
			).finally(() => {
				backend.inflight.delete(key);
			});
			backend.inflight.set(key, promise);
			const loaded = await promise;
			const result = resultWithValue<T>(loaded.value, loaded.meta);
			record(result.meta);
			return result;
		},

		responseMeta(): ProviderCacheResponseMeta | undefined {
			if (events.length === 0) return undefined;
			return {
				hit: events.some((event) => event.hit),
				stale: events.some((event) => event.stale),
				keys: metadataKeys(events, secretScopedKeys),
				source: sourceSummary(events),
			};
		},
	};
}

export function createBypassProviderCache(
	options: Pick<ProviderCacheOptions, "providerId">,
): ProviderCache {
	const configuredPepper = process.env[APIFUSE__CACHE__KEY_PEPPER_ENV];
	const pepper = configuredPepper && configuredPepper.length > 0 ? configuredPepper : undefined;
	const events: ProviderCacheLookupMeta[] = [];
	const secretScopedKeys = new Set<string>();

	return {
		key(namespace, parts, keyOptions?: ProviderCacheKeyOptions) {
			const extra = new Set((keyOptions?.redactFields ?? []).map((field) => field.toLowerCase()));
			const normalized = normalizeKeyPart(parts, extra, pepper);
			const key = `${DEFAULT_PREFIX}:${options.providerId}:${namespace}:${stableHash(normalized.value)}`;
			if (normalized.secretScoped) secretScopedKeys.add(key);
			return key;
		},

		async get<T = unknown>(_key: string): Promise<ProviderCacheResult<T> | null> {
			return null;
		},

		async set(): Promise<void> {
			// Intentionally disabled for SDK tools that must hit upstream directly.
		},

		async delete(): Promise<void> {
			// Intentionally disabled for SDK tools that must hit upstream directly.
		},

		async getOrSet<T = unknown>(
			key: string,
			loader: () => Promise<T>,
		): Promise<ProviderCacheResult<T>> {
			const value = await loader();
			const meta: ProviderCacheLookupMeta = {
				key,
				hit: false,
				stale: false,
				source: "loader",
			};
			events.push(meta);
			return { value, meta };
		},

		responseMeta(): ProviderCacheResponseMeta | undefined {
			if (events.length === 0) return undefined;
			return {
				hit: false,
				stale: false,
				keys: metadataKeys(events, secretScopedKeys),
				source: sourceSummary(events),
			};
		},
	};
}

export function resetProviderCacheForTests(): void {
	for (const backend of sharedBackends.values()) {
		backend.memory.clear();
		backend.inflight.clear();
		backend.redis?.disconnect();
	}
	sharedBackends.clear();
	warnedAboutUnpepperedSecretKeys = false;
}
