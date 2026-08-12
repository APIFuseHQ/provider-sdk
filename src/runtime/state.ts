import { createHash } from "node:crypto";
import { providerStateRedisUrlFromEnv } from "../config/loader.js";
import { ProviderError } from "../errors.js";
import type {
	ProviderRuntimeState,
	ProviderStateNamespace,
	StateCasResult,
	StateNamespaceOptions,
	StateValue,
	StateWriteOptions,
} from "../types.js";
import {
	createProviderRedisClient,
	ensureRedisReady,
	type ProviderRedisClient,
	withRedisTimeout,
} from "./redis.js";

const DEFAULT_REDIS_TIMEOUT_MS = 250;
const REDIS_STATE_PREFIX = "apifuse:provider-state:v2";
const LEGACY_REDIS_STATE_PREFIX = "apifuse:provider-state:v1";
const PROVIDER_SCOPE_DISCRIMINATOR = "scope:provider";
const MISSING_CONNECTION_SCOPE_DISCRIMINATOR = "scope:connection:missing";
const LEGACY_INDEX_SCAN_COUNT = 256;
const LEGACY_INDEX_SCAN_MAX_PAGES = 8;
const SET_WITH_QUOTA_SCRIPT = `
local now = tonumber(ARGV[1])
local max_entries = tonumber(ARGV[2])
local expires_at = tonumber(ARGV[3])
local index_ttl = tonumber(ARGV[4])
local envelope = ARGV[5]

redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)
redis.call("ZREM", KEYS[2], KEYS[3])
local indexed = redis.call("ZSCORE", KEYS[2], KEYS[1])
if not indexed and redis.call("ZCARD", KEYS[2]) >= max_entries then
	return {0, false}
end

redis.call("SET", KEYS[1], envelope, "PXAT", expires_at)
redis.call("ZADD", KEYS[2], expires_at, KEYS[1])
redis.call("PEXPIRE", KEYS[2], index_ttl)
return {1, envelope}
`;

const COMPARE_AND_SET_WITH_QUOTA_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current then
	local ok, decoded = pcall(cjson.decode, current)
	if ok and type(decoded) == "table" and decoded.deleted == true then
		current = false
	end
elseif redis.call("EXISTS", KEYS[1]) == 0 then
	current = redis.call("GET", KEYS[3])
end
local current_version = 0
if current then
	local ok, decoded = pcall(cjson.decode, current)
	if not ok or type(decoded) ~= "table" or type(decoded.version) ~= "number" then
		return {-2, current}
	end
	current_version = decoded.version
end
if current_version ~= tonumber(ARGV[1]) then
	return {-1, current or false}
end

local now = tonumber(ARGV[2])
local max_entries = tonumber(ARGV[3])
local expires_at = tonumber(ARGV[4])
local index_ttl = tonumber(ARGV[5])
local envelope = ARGV[6]
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)
redis.call("ZREM", KEYS[2], KEYS[3])
local indexed = redis.call("ZSCORE", KEYS[2], KEYS[1])
if not indexed and redis.call("ZCARD", KEYS[2]) >= max_entries then
	return {0, false}
end

redis.call("SET", KEYS[1], envelope, "PXAT", expires_at)
redis.call("ZADD", KEYS[2], expires_at, KEYS[1])
redis.call("PEXPIRE", KEYS[2], index_ttl)
return {1, envelope}
`;

const DELETE_WITH_INDEX_SCRIPT = `
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
redis.call("ZREM", KEYS[2], KEYS[1], KEYS[3])
return 1
`;

// Legacy v1 keys have no scope discriminator. Every operation that depends on
// the namespace index advances a bounded SCAN cursor and lazily imports active
// v1 envelopes into the scoped v2 ZSET. The cursor is deliberately cyclic
// rather than permanently "complete": an old pod may still write during a
// rolling deploy. Each list/write call does a fixed amount of migration work;
// Redis KEYS and unbounded scans remain forbidden.
//
// TODO(remove v1 state dual-read): delete this migration after all v1 writers
// are gone and the longest StateNamespaceOptions.maxTtl has elapsed.
const BACKFILL_LEGACY_INDEX_SCRIPT = `
local now = tonumber(ARGV[1])
local index_ttl = tonumber(ARGV[2])
local next_cursor = ARGV[3]

redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
for i = 4, #ARGV, 4 do
	local key = ARGV[i]
	local expected = ARGV[i + 1]
	local expires_at = tonumber(ARGV[i + 2])
	local scoped_key = ARGV[i + 3]
	if redis.call("GET", key) == expected and redis.call("EXISTS", scoped_key) == 0 then
		redis.call("ZADD", KEYS[1], "NX", expires_at, key)
	else
		redis.call("ZREM", KEYS[1], key)
	end
end
if redis.call("EXISTS", KEYS[1]) == 1 then
	redis.call("PEXPIRE", KEYS[1], index_ttl)
end
redis.call("SET", KEYS[2], next_cursor, "PX", index_ttl)
return redis.call("ZCARD", KEYS[1])
`;

type RedisProviderRuntimeStateOptions = {
	readonly redisUrl: string;
	readonly providerId?: string;
	/** Test seam; production callers use redisUrl-backed client sharing. */
	readonly __redisClient?: ProviderRedisClient;
};

type RedisStateEnvelope = {
	readonly value: unknown;
	readonly version: number;
	readonly expiresAt: string;
	readonly createdAt: string;
	readonly updatedAt: string;
};

type RedisStateTombstone = {
	readonly deleted: true;
};

type RedisBackend = {
	readonly redis: ProviderRedisClient;
};

const redisBackends = new Map<string, RedisBackend>();

function getRedisBackend(
	redisUrl: string,
	injectedRedis?: ProviderRedisClient,
): RedisBackend {
	const existing = redisBackends.get(redisUrl);
	if (existing) return existing;
	const redis =
		injectedRedis ??
		createProviderRedisClient({
			redisUrl,
			timeoutMs: DEFAULT_REDIS_TIMEOUT_MS,
			onError: () => {
				// Runtime state operations fail closed at their call sites. Avoid noisy
				// unhandled Redis errors from background reconnect attempts.
			},
		});
	const backend = { redis };
	redisBackends.set(redisUrl, backend);
	return backend;
}

async function withRequiredRedis<T>(operation: () => Promise<T>): Promise<T> {
	return await withRedisTimeout(operation, {
		timeoutMs: DEFAULT_REDIS_TIMEOUT_MS,
		onTimeout: () => {
			throw new UnsupportedProviderStateError("Provider runtime state Redis timed out");
		},
		onError: () => {
			throw new UnsupportedProviderStateError("Provider runtime state Redis is unavailable");
		},
	});
}

async function requireRedisReady(redis: ProviderRedisClient): Promise<void> {
	if (await ensureRedisReady(redis, DEFAULT_REDIS_TIMEOUT_MS)) return;
	throw new UnsupportedProviderStateError("Provider runtime state Redis is unavailable");
}

function connectionScopeDiscriminator(connectionId: string | undefined): string {
	if (connectionId === undefined) return MISSING_CONNECTION_SCOPE_DISCRIMINATOR;
	const digest = createHash("sha256").update(connectionId, "utf8").digest("hex");
	return `scope:connection:sha256:${digest}`;
}

function providerStatePrefix(
	providerId: string | undefined,
	namespace: string,
	scopeDiscriminator: string,
): string {
	return `${REDIS_STATE_PREFIX}:${providerId ?? "default"}:${namespace}:${scopeDiscriminator}`;
}

function providerStateKey(
	providerId: string | undefined,
	namespace: string,
	scopeDiscriminator: string,
	key: string,
): string {
	return `${providerStatePrefix(providerId, namespace, scopeDiscriminator)}:${key}`;
}

function legacyProviderStatePrefix(providerId: string | undefined, namespace: string): string {
	return `${LEGACY_REDIS_STATE_PREFIX}:${providerId ?? "default"}:${namespace}`;
}

function legacyProviderStateKey(
	providerId: string | undefined,
	namespace: string,
	key: string,
): string {
	return `${legacyProviderStatePrefix(providerId, namespace)}:${key}`;
}

function publicStateKey(redisKey: string, prefixes: readonly string[]): string {
	for (const prefix of prefixes) {
		const prefixWithSeparator = `${prefix}:`;
		if (redisKey.startsWith(prefixWithSeparator)) {
			return redisKey.slice(prefixWithSeparator.length);
		}
	}
	return redisKey;
}

function redisGlobLiteral(value: string): string {
	return value.replace(/[\\*?\[\]]/g, "\\$&");
}

function parseStateDurationMs(ttl: StateWriteOptions["ttl"]): number {
	const match = /^(\d+)(ms|s|m|h|d)$/.exec(ttl ?? "1h");
	if (!match) return 3_600_000;
	const amount = Number(match[1]);
	const unit = match[2];
	const multiplier =
		unit === "ms"
			? 1
			: unit === "s"
				? 1_000
				: unit === "m"
					? 60_000
					: unit === "h"
						? 3_600_000
						: 86_400_000;
	return Math.max(1, amount * multiplier);
}

function resolveExpiresAt(ttl: StateWriteOptions["ttl"]): string {
	return new Date(Date.now() + parseStateDurationMs(ttl)).toISOString();
}

function envelopeFromJson(
	key: string,
	raw: string | null,
	// biome-ignore lint/suspicious/noExplicitAny: state envelopes deserialize caller-owned generic values.
): StateValue<any> | null {
	if (!raw) return null;
	// A corrupt/undecodable persisted envelope must be treated as absent rather
	// than throwing a raw JSON.parse SyntaxError: an uncaught SyntaxError escapes
	// the provider error taxonomy, is masked as internal_error 500, and is then
	// retried by the hub (2026-07-22 catchtable reserve RCA, candidate A). Returning
	// null also keeps list() from aborting the whole scan on a single bad entry.
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const record: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
	if (
		typeof record.version !== "number" ||
		typeof record.expiresAt !== "string" ||
		typeof record.createdAt !== "string" ||
		typeof record.updatedAt !== "string" ||
		!("value" in record)
	) {
		return null;
	}
	return {
		key,
		value: record.value,
		version: record.version,
		expiresAt: record.expiresAt,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

function isStateTombstone(raw: string | null): boolean {
	if (!raw) return false;
	try {
		const parsed: unknown = JSON.parse(raw);
		return (
			parsed !== null &&
			typeof parsed === "object" &&
			!Array.isArray(parsed) &&
			(parsed as { deleted?: unknown }).deleted === true
		);
	} catch {
		return false;
	}
}

function redisEnvelope(
	value: unknown,
	version: number,
	createdAt: string,
	expiresAt: string,
): RedisStateEnvelope {
	const updatedAt = new Date().toISOString();
	return { value, version, expiresAt, createdAt, updatedAt };
}

class RedisProviderStateNamespace implements ProviderStateNamespace {
	constructor(
		private readonly backend: RedisBackend,
		private readonly providerId: string | undefined,
		private readonly namespaceName: string,
		private readonly options: StateNamespaceOptions,
		private readonly scopeDiscriminator: string,
	) {}

	private redisKey(key: string): string {
		return providerStateKey(
			this.providerId,
			this.namespaceName,
			this.scopeDiscriminator,
			key,
		);
	}

	private legacyRedisKey(key: string): string {
		return legacyProviderStateKey(this.providerId, this.namespaceName, key);
	}

	private statePrefixes(): readonly [string, string] {
		return [
			providerStatePrefix(
				this.providerId,
				this.namespaceName,
				this.scopeDiscriminator,
			),
			legacyProviderStatePrefix(this.providerId, this.namespaceName),
		];
	}

	private indexKey(): string {
		// Keep bookkeeping outside the caller-owned keyspace. A provider may use
		// any state key (including "__index"), so a suffix inside the namespace
		// could turn the ZSET into a string and break every subsequent write.
		const namespaceIdentity = Buffer.from(
			providerStatePrefix(
				this.providerId,
				this.namespaceName,
				this.scopeDiscriminator,
			),
			"utf8",
		).toString("base64url");
		return `${REDIS_STATE_PREFIX}:index:${namespaceIdentity}`;
	}

	private legacyScanCursorKey(): string {
		return `${this.indexKey()}:legacy-scan-cursor`;
	}

	private legacyPrefix(): string {
		return `${legacyProviderStatePrefix(this.providerId, this.namespaceName)}:`;
	}

	private async backfillLegacyIndex(): Promise<void> {
		await requireRedisReady(this.backend.redis);
		const cursorKey = this.legacyScanCursorKey();
		let cursor =
			(await withRequiredRedis(() => this.backend.redis.get(cursorKey))) ?? "0";
		const pattern = `${redisGlobLiteral(this.legacyPrefix())}*`;
		const indexTtlMs = parseStateDurationMs(this.options.maxTtl);

		for (let page = 0; page < LEGACY_INDEX_SCAN_MAX_PAGES; page += 1) {
			const [nextCursor, keys] = await withRequiredRedis(() =>
				this.backend.redis.scan(
					cursor,
					"MATCH",
					pattern,
					"COUNT",
					LEGACY_INDEX_SCAN_COUNT,
				),
			);
			const rawValues =
				keys.length > 0
					? await withRequiredRedis(() => this.backend.redis.mget(keys))
					: [];
			const now = Date.now();
			const activeLegacyArgs: string[] = [];
			for (const [index, raw] of rawValues.entries()) {
				const key = keys[index];
				if (!key || !raw) continue;
				const publicKey = publicStateKey(key, this.statePrefixes());
				const envelope = envelopeFromJson(publicKey, raw);
				const expiresAtMs = envelope ? Date.parse(envelope.expiresAt) : Number.NaN;
				if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) continue;
				activeLegacyArgs.push(
					key,
					raw,
					String(expiresAtMs),
					this.redisKey(publicKey),
				);
			}
			await withRequiredRedis(() =>
				this.backend.redis.eval(
					BACKFILL_LEGACY_INDEX_SCRIPT,
					2,
					this.indexKey(),
					cursorKey,
					String(now),
					String(indexTtlMs),
					nextCursor,
					...activeLegacyArgs,
				),
			);
			cursor = nextCursor;
			if (cursor === "0") break;
		}
	}

	private async indexedKeys(limit: number): Promise<string[]> {
		await requireRedisReady(this.backend.redis);
		const now = Date.now();
		return await withRequiredRedis(async () => {
			await this.backend.redis.zremrangebyscore(this.indexKey(), "-inf", now);
			return await this.backend.redis.zrangebyscore(
				this.indexKey(),
				now + 1,
				"+inf",
				"LIMIT",
				0,
				limit,
			);
		});
	}

	private async readRaw(key: string): Promise<string | null> {
		await requireRedisReady(this.backend.redis);
		const [scopedRaw, legacyRaw] = await withRequiredRedis(() =>
			this.backend.redis.mget(this.redisKey(key), this.legacyRedisKey(key)),
		);
		// A scoped tombstone intentionally suppresses legacy fallback after delete.
		return scopedRaw ?? legacyRaw;
	}

	private enforceValueSize(value: unknown): void {
		const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
		if (bytes > this.options.maxValueBytes) {
			throw new UnsupportedProviderStateError(
				`Provider runtime state value exceeds maxValueBytes (${bytes} > ${this.options.maxValueBytes})`,
			);
		}
	}

	private quotaExceeded(): UnsupportedProviderStateError {
		return new UnsupportedProviderStateError(
			`Provider runtime state namespace quota exceeded (${this.options.maxEntries + 1} > ${this.options.maxEntries})`,
		);
	}

	private writeTiming(ttl: StateWriteOptions["ttl"]): {
		expiresAt: string;
		expiresAtMs: number;
		indexTtlMs: number;
	} {
		const ttlMs = parseStateDurationMs(ttl ?? this.options.defaultTtl);
		const maxTtlMs = parseStateDurationMs(this.options.maxTtl);
		if (ttlMs > maxTtlMs) {
			throw new UnsupportedProviderStateError(
				`Provider runtime state ttl exceeds maxTtl (${ttlMs} > ${maxTtlMs})`,
			);
		}
		const expiresAtMs = Date.now() + ttlMs;
		return {
			expiresAt: new Date(expiresAtMs).toISOString(),
			expiresAtMs,
			indexTtlMs: maxTtlMs,
		};
	}

	async list<T>(options?: { limit?: number; prefix?: string }): Promise<StateValue<T>[]> {
		const requestedLimit = Math.max(0, options?.limit ?? this.options.maxEntries);
		if (requestedLimit === 0) return [];
		await this.backfillLegacyIndex();
		const keys = await this.indexedKeys(this.options.maxEntries * 2);
		if (keys.length === 0) return [];
		const values = await withRequiredRedis(() => this.backend.redis.mget(keys));
		const currentPrefix = `${this.statePrefixes()[0]}:`;
		const rows = new Map<string, { value: StateValue<T>; scoped: boolean }>();
		for (const [index, raw] of values.entries()) {
			const redisKey = keys[index];
			if (!redisKey) continue;
			const publicKey = publicStateKey(redisKey, this.statePrefixes());
			if (options?.prefix && !publicKey.startsWith(options.prefix)) continue;
			const value = envelopeFromJson(publicKey, raw);
			if (!value) continue;
			const scoped = redisKey.startsWith(currentPrefix);
			const existing = rows.get(publicKey);
			if (!existing || (scoped && !existing.scoped)) rows.set(publicKey, { value, scoped });
		}
		return Array.from(rows.values(), ({ value }) => value).slice(0, requestedLimit);
	}

	async get<T>(key: string): Promise<StateValue<T> | null> {
		const raw = await this.readRaw(key);
		if (isStateTombstone(raw)) return null;
		return envelopeFromJson(key, raw);
	}

	async set<T>(key: string, value: T, options?: StateWriteOptions): Promise<StateValue<T>> {
		this.enforceValueSize(value);
		await this.backfillLegacyIndex();
		const current = await this.get<T>(key);
		const createdAt = current?.createdAt ?? new Date().toISOString();
		const version = (current?.version ?? 0) + 1;
		const timing = this.writeTiming(options?.ttl);
		const envelope = redisEnvelope(value, version, createdAt, timing.expiresAt);
		await requireRedisReady(this.backend.redis);
		const result = await withRequiredRedis(() =>
			this.backend.redis.eval(
				SET_WITH_QUOTA_SCRIPT,
				3,
				this.redisKey(key),
				this.indexKey(),
				this.legacyRedisKey(key),
				String(Date.now()),
				String(this.options.maxEntries),
				String(timing.expiresAtMs),
				String(timing.indexTtlMs),
				JSON.stringify(envelope),
			),
		);
		if (!Array.isArray(result) || Number(result[0]) !== 1) {
			throw this.quotaExceeded();
		}
		return {
			key,
			value,
			version,
			expiresAt: timing.expiresAt,
			createdAt,
			updatedAt: envelope.updatedAt,
		};
	}

	async patch<T extends Record<string, unknown>>(
		key: string,
		partial: Partial<T>,
		options?: StateWriteOptions,
	): Promise<StateValue<T>> {
		const current = (await this.get<Record<string, unknown>>(key))?.value ?? {};
		// biome-ignore lint/suspicious/noExplicitAny: patch preserves the caller-provided generic state shape.
		const merged: any = { ...current, ...partial };
		return await this.set<T>(key, merged, options);
	}

	async compareAndSet<T>(
		key: string,
		expectedVersion: number,
		value: T,
		options?: StateWriteOptions,
	): Promise<StateCasResult<T>> {
		this.enforceValueSize(value);
		await this.backfillLegacyIndex();
		const current = await this.get<T>(key);
		if ((current?.version ?? 0) !== expectedVersion) {
			return { ok: false, current };
		}
		const createdAt = current?.createdAt ?? new Date().toISOString();
		const timing = this.writeTiming(options?.ttl);
		const envelope = redisEnvelope(
			value,
			expectedVersion + 1,
			createdAt,
			timing.expiresAt,
		);
		await requireRedisReady(this.backend.redis);
		const result = await withRequiredRedis(() =>
			this.backend.redis.eval(
				COMPARE_AND_SET_WITH_QUOTA_SCRIPT,
				3,
				this.redisKey(key),
				this.indexKey(),
				this.legacyRedisKey(key),
				String(expectedVersion),
				String(Date.now()),
				String(this.options.maxEntries),
				String(timing.expiresAtMs),
				String(timing.indexTtlMs),
				JSON.stringify(envelope),
			),
		);
		if (Array.isArray(result) && Number(result[0]) === 0) {
			throw this.quotaExceeded();
		}
		if (!Array.isArray(result) || Number(result[0]) !== 1) {
			const rawCurrent = Array.isArray(result) && typeof result[1] === "string" ? result[1] : null;
			return { ok: false, current: envelopeFromJson(key, rawCurrent) };
		}
		return {
			ok: true,
			value: {
				key,
				value,
				version: envelope.version,
				expiresAt: timing.expiresAt,
				createdAt,
				updatedAt: envelope.updatedAt,
			},
		};
	}

	async delete(key: string): Promise<void> {
		await requireRedisReady(this.backend.redis);
		const tombstone = JSON.stringify({ deleted: true } satisfies RedisStateTombstone);
		await withRequiredRedis(() =>
			this.backend.redis.eval(
				DELETE_WITH_INDEX_SCRIPT,
				3,
				this.redisKey(key),
				this.indexKey(),
				this.legacyRedisKey(key),
				tombstone,
				String(parseStateDurationMs(this.options.maxTtl)),
			),
		);
	}

	async increment(
		key: string,
		field: string,
		delta = 1,
		options?: StateWriteOptions,
	): Promise<StateValue<Record<string, unknown>>> {
		const current = (await this.get<Record<string, unknown>>(key))?.value ?? {};
		const previous = typeof current[field] === "number" ? current[field] : 0;
		return await this.set(key, { ...current, [field]: previous + delta }, options);
	}
}

class RedisProviderRuntimeState implements ProviderRuntimeState {
	readonly backend: RedisBackend;
	readonly providerId?: string;
	readonly redisUrl: string;
	readonly scopeDiscriminator: string;

	constructor(
		options: RedisProviderRuntimeStateOptions,
		scopeDiscriminator = MISSING_CONNECTION_SCOPE_DISCRIMINATOR,
	) {
		this.backend = getRedisBackend(options.redisUrl, options.__redisClient);
		this.providerId = options.providerId;
		this.redisUrl = options.redisUrl;
		this.scopeDiscriminator = scopeDiscriminator;
	}

	forConnection(connectionId: string | undefined): ProviderRuntimeState {
		return new RedisProviderRuntimeState(
			{ redisUrl: this.redisUrl, providerId: this.providerId },
			connectionScopeDiscriminator(connectionId),
		);
	}

	namespace(name: string, options: StateNamespaceOptions): ProviderStateNamespace {
		return new RedisProviderStateNamespace(
			this.backend,
			this.providerId,
			name,
			options,
			options.scope === "provider" ? PROVIDER_SCOPE_DISCRIMINATOR : this.scopeDiscriminator,
		);
	}
}

export class UnsupportedProviderStateError extends ProviderError {
	constructor(message = "Provider runtime state is not available in this runtime") {
		super(message, { code: "PROVIDER_STATE_UNSUPPORTED" });
		this.name = "UnsupportedProviderStateError";
	}
}

class UnsupportedProviderStateNamespace implements ProviderStateNamespace {
	async list<T>(_options?: { limit?: number; prefix?: string }): Promise<StateValue<T>[]> {
		throw new UnsupportedProviderStateError();
	}
	async get<T>(_key: string): Promise<StateValue<T> | null> {
		throw new UnsupportedProviderStateError();
	}
	async set<T>(_key: string, _value: T, _options?: StateWriteOptions): Promise<StateValue<T>> {
		throw new UnsupportedProviderStateError();
	}
	async patch<T extends Record<string, unknown>>(
		_key: string,
		_partial: Partial<T>,
		_options?: StateWriteOptions,
	): Promise<StateValue<T>> {
		throw new UnsupportedProviderStateError();
	}
	async compareAndSet<T>(
		_key: string,
		_expectedVersion: number,
		_value: T,
		_options?: StateWriteOptions,
	): Promise<StateCasResult<T>> {
		throw new UnsupportedProviderStateError();
	}
	async delete(_key: string): Promise<void> {
		throw new UnsupportedProviderStateError();
	}
	async increment(
		_key: string,
		_field: string,
		_delta?: number,
		_options?: StateWriteOptions,
	): Promise<StateValue<Record<string, unknown>>> {
		throw new UnsupportedProviderStateError();
	}
}

class UnsupportedProviderRuntimeState implements ProviderRuntimeState {
	forConnection(_connectionId: string | undefined): ProviderRuntimeState {
		return new UnsupportedProviderRuntimeState();
	}

	namespace(_name: string, _options: StateNamespaceOptions): ProviderStateNamespace {
		return new UnsupportedProviderStateNamespace();
	}
}

class MemoryProviderStateNamespace implements ProviderStateNamespace {
	// biome-ignore lint/suspicious/noExplicitAny: in-memory state stores heterogeneous generic values by key.
	readonly values = new Map<string, StateValue<any>>();

	constructor(private readonly options: StateNamespaceOptions) {}

	private enforceValueSize(value: unknown): void {
		const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
		if (bytes > this.options.maxValueBytes) {
			throw new UnsupportedProviderStateError(
				`Provider runtime state value exceeds maxValueBytes (${bytes} > ${this.options.maxValueBytes})`,
			);
		}
	}

	private enforceWritePolicy(key: string, value: unknown, ttl: StateWriteOptions["ttl"]): void {
		this.enforceValueSize(value);
		const ttlMs = parseStateDurationMs(ttl ?? this.options.defaultTtl);
		const maxTtlMs = parseStateDurationMs(this.options.maxTtl);
		if (ttlMs > maxTtlMs) {
			throw new UnsupportedProviderStateError(
				`Provider runtime state ttl exceeds maxTtl (${ttlMs} > ${maxTtlMs})`,
			);
		}
		if (!this.values.has(key) && this.values.size >= this.options.maxEntries) {
			throw new UnsupportedProviderStateError(
				`Provider runtime state namespace quota exceeded (${this.options.maxEntries + 1} > ${this.options.maxEntries})`,
			);
		}
	}

	private pruneExpired(nowMs = Date.now()): void {
		for (const [key, row] of this.values.entries()) {
			if (row.expiresAt && Date.parse(row.expiresAt) <= nowMs) {
				this.values.delete(key);
			}
		}
	}

	async list<T>(_options?: { limit?: number; prefix?: string }): Promise<StateValue<T>[]> {
		this.pruneExpired();
		const rows = Array.from(this.values.values()).filter((value) =>
			_options?.prefix ? value.key.startsWith(_options.prefix) : true,
		);
		return rows.slice(0, _options?.limit);
	}

	async get<T>(key: string): Promise<StateValue<T> | null> {
		this.pruneExpired();
		return this.values.get(key) ?? null;
	}

	async set<T>(key: string, value: T, options?: StateWriteOptions): Promise<StateValue<T>> {
		this.pruneExpired();
		this.enforceWritePolicy(key, value, options?.ttl);
		const now = new Date().toISOString();
		const current = this.values.get(key);
		const expiresAt = resolveMemoryStateExpiresAt(options?.ttl ?? this.options.defaultTtl);
		const row = {
			key,
			value,
			version: (current?.version ?? 0) + 1,
			expiresAt,
			createdAt: current?.createdAt ?? now,
			updatedAt: now,
		} satisfies StateValue<T>;
		this.values.set(key, row);
		return row;
	}

	async patch<T extends Record<string, unknown>>(
		_key: string,
		_partial: Partial<T>,
		_options?: StateWriteOptions,
	): Promise<StateValue<T>> {
		throw new UnsupportedProviderStateError(
			"In-memory provider runtime state does not support patch",
		);
	}

	async compareAndSet<T>(
		key: string,
		expectedVersion: number,
		value: T,
		options?: StateWriteOptions,
	): Promise<StateCasResult<T>> {
		this.pruneExpired();
		const current = this.values.get(key) as StateValue<T> | undefined;
		if ((current?.version ?? 0) !== expectedVersion) {
			return { ok: false, current: current ?? null };
		}
		this.enforceWritePolicy(key, value, options?.ttl);
		const now = new Date().toISOString();
		const stored = {
			key,
			value,
			version: expectedVersion + 1,
			expiresAt: resolveMemoryStateExpiresAt(
				options?.ttl ?? this.options.defaultTtl,
			),
			createdAt: current?.createdAt ?? now,
			updatedAt: now,
		} satisfies StateValue<T>;
		this.values.set(key, stored);
		return { ok: true, value: stored };
	}

	async delete(key: string): Promise<void> {
		this.values.delete(key);
	}

	async increment(
		_key: string,
		_field: string,
		_delta = 1,
		_options?: StateWriteOptions,
	): Promise<StateValue<Record<string, unknown>>> {
		throw new UnsupportedProviderStateError(
			"In-memory provider runtime state does not support increment",
		);
	}
}

type MemoryProviderStateBackend = {
	readonly namespaces: Map<string, MemoryProviderStateNamespace>;
};

class MemoryProviderRuntimeState implements ProviderRuntimeState {
	constructor(
		private readonly backend: MemoryProviderStateBackend = { namespaces: new Map() },
		private readonly scopeDiscriminator = MISSING_CONNECTION_SCOPE_DISCRIMINATOR,
	) {}

	forConnection(connectionId: string | undefined): ProviderRuntimeState {
		return new MemoryProviderRuntimeState(
			this.backend,
			connectionScopeDiscriminator(connectionId),
		);
	}

	namespace(name: string, options: StateNamespaceOptions): ProviderStateNamespace {
		const scopeDiscriminator =
			options.scope === "provider" ? PROVIDER_SCOPE_DISCRIMINATOR : this.scopeDiscriminator;
		const namespaceIdentity = `${scopeDiscriminator}\0${name}`;
		const existing = this.backend.namespaces.get(namespaceIdentity);
		if (existing) return existing;
		const created = new MemoryProviderStateNamespace(options);
		this.backend.namespaces.set(namespaceIdentity, created);
		return created;
	}
}

function resolveMemoryStateExpiresAt(ttl: StateWriteOptions["ttl"]): string {
	const match = /^(\d+)(ms|s|m|h|d)$/.exec(ttl ?? "1h");
	if (!match) return new Date(Date.now() + 3_600_000).toISOString();
	const amount = Number(match[1]);
	const unit = match[2];
	const multiplier =
		unit === "ms"
			? 1
			: unit === "s"
				? 1_000
				: unit === "m"
					? 60_000
					: unit === "h"
						? 3_600_000
						: 86_400_000;
	return new Date(Date.now() + amount * multiplier).toISOString();
}

export function createRedisProviderRuntimeState(
	options: RedisProviderRuntimeStateOptions,
): ProviderRuntimeState {
	return new RedisProviderRuntimeState(options);
}

export function createProviderRuntimeStateFromEnv(
	options: { readonly providerId?: string; readonly allowMemoryFallback?: boolean } = {},
): ProviderRuntimeState {
	const redisUrl = providerStateRedisUrlFromEnv();
	if (redisUrl) {
		return createRedisProviderRuntimeState({
			redisUrl,
			providerId: options.providerId,
		});
	}
	if (options.allowMemoryFallback === true) {
		return new MemoryProviderRuntimeState();
	}
	return createUnsupportedProviderRuntimeState();
}

export function createMemoryProviderRuntimeState(): ProviderRuntimeState {
	return new MemoryProviderRuntimeState();
}

export function createUnsupportedProviderRuntimeState(): ProviderRuntimeState {
	return new UnsupportedProviderRuntimeState();
}
