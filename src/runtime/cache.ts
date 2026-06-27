import { createHash } from "node:crypto";

import { providerCacheRedisUrlFromEnv } from "../config/loader";
import type {
	ProviderCache,
	ProviderCacheGetOrSetOptions,
	ProviderCacheKeyOptions,
	ProviderCacheLookupMeta,
	ProviderCacheResponseMeta,
	ProviderCacheResult,
} from "../types";
import {
	createProviderRedisClient,
	ensureRedisReady,
	type ProviderRedisClient,
	withRedisTimeout,
} from "./redis";

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

const DEFAULT_PREFIX = "apifuse:provider-cache:v1";
const DEFAULT_MEMORY_MAX_ENTRIES = 1_000;
const DEFAULT_REDIS_TIMEOUT_MS = 150;
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

function normalizeKeyPart(value: unknown, extra: Set<string>): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => normalizeKeyPart(entry, extra));
	}
	if (isRecord(value)) {
		const normalized: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			if (shouldRedactField(key, extra)) continue;
			normalized[key] = normalizeKeyPart(value[key], extra);
		}
		return normalized;
	}
	return value;
}

function stableHash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(value))
		.digest("hex")
		.slice(0, 32);
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

function resultWithValue<T>(
	value: unknown,
	meta: ProviderCacheLookupMeta,
): ProviderCacheResult<T> {
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

function sourceSummary(
	events: ProviderCacheLookupMeta[],
): ProviderCacheResponseMeta["source"] {
	const sources = new Set(events.map((event) => event.source));
	if (sources.size === 0) return undefined;
	if (sources.size === 1) return events[0]?.source;
	return "mixed";
}

async function withRedisFallback<T>(
	operation: () => Promise<T>,
): Promise<T | undefined> {
	return await withRedisTimeout(operation, {
		timeoutMs: DEFAULT_REDIS_TIMEOUT_MS,
		onTimeout: () => undefined,
		onError: () => undefined,
	});
}

export function createProviderCache(
	options: ProviderCacheOptions,
): ProviderCache {
	const redisUrl = options.redisUrl ?? providerCacheRedisUrlFromEnv();
	const backend = getSharedBackend(redisUrl);
	const memoryMaxEntries = Math.max(
		1,
		options.memoryMaxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES,
	);
	const now = options.now ?? Date.now;
	const events: ProviderCacheLookupMeta[] = [];

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

	function rememberEnvelope(
		key: string,
		envelope: CacheEnvelope,
		currentTime: number,
	): void {
		sweepMemory(currentTime);
		backend.memory.delete(key);
		backend.memory.set(key, {
			...envelope,
			expiresAt: envelope.staleUntil,
			lastAccessedAt: currentTime,
		});
		enforceMemoryLimit();
	}

	function touchMemory(
		key: string,
		entry: MemoryEntry,
		currentTime: number,
	): void {
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
				const memoryResult = resultFromEnvelope<T>(
					key,
					memoryEntry,
					currentTime,
					"memory",
				);
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
		const freshTtlMs = jitteredTtlMs(
			cacheOptions.ttlMs,
			cacheOptions.jitterPct,
		);
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
		await withRedisFallback(() =>
			redis.set(key, JSON.stringify(envelope), "PX", staleTtlMs),
		);
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
			const extra = new Set(
				(keyOptions?.redactFields ?? []).map((field) => field.toLowerCase()),
			);
			const normalized = normalizeKeyPart(parts, extra);
			return `${DEFAULT_PREFIX}:${options.providerId}:${namespace}:${stableHash(normalized)}`;
		},

		async get<T = unknown>(
			key: string,
		): Promise<ProviderCacheResult<T> | null> {
			const result = await read<T>(key);
			if (result) record(result.meta);
			return result;
		},

		set: write,

		async delete(key: string): Promise<void> {
			backend.memory.delete(key);
			const redis = backend.redis;
			if (
				!redis ||
				!(await ensureRedisReady(redis, DEFAULT_REDIS_TIMEOUT_MS))
			) {
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
				const result = resultWithValue<T>(
					inflightResult.value,
					inflightResult.meta,
				);
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
				keys: Array.from(new Set(events.map((event) => event.key))),
				source: sourceSummary(events),
			};
		},
	};
}

export function createBypassProviderCache(
	options: Pick<ProviderCacheOptions, "providerId">,
): ProviderCache {
	const events: ProviderCacheLookupMeta[] = [];

	return {
		key(namespace, parts, keyOptions?: ProviderCacheKeyOptions) {
			const extra = new Set(
				(keyOptions?.redactFields ?? []).map((field) => field.toLowerCase()),
			);
			const normalized = normalizeKeyPart(parts, extra);
			return `${DEFAULT_PREFIX}:${options.providerId}:${namespace}:${stableHash(normalized)}`;
		},

		async get<T = unknown>(
			_key: string,
		): Promise<ProviderCacheResult<T> | null> {
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
				keys: Array.from(new Set(events.map((event) => event.key))),
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
}
