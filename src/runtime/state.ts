import { providerStateRedisUrlFromEnv } from "../config/loader";
import { ProviderError } from "../errors";
import type {
	ProviderRuntimeState,
	ProviderStateNamespace,
	StateCasResult,
	StateNamespaceOptions,
	StateValue,
	StateWriteOptions,
} from "../types";
import {
	createProviderRedisClient,
	ensureRedisReady,
	type ProviderRedisClient,
	withRedisTimeout,
} from "./redis";

const DEFAULT_REDIS_TIMEOUT_MS = 250;
const REDIS_STATE_PREFIX = "apifuse:provider-state:v1";

type RedisProviderRuntimeStateOptions = {
	readonly redisUrl: string;
	readonly providerId?: string;
};

type RedisStateEnvelope = {
	readonly value: unknown;
	readonly version: number;
	readonly expiresAt: string;
	readonly createdAt: string;
	readonly updatedAt: string;
};

type RedisBackend = {
	readonly redis: ProviderRedisClient;
};

const redisBackends = new Map<string, RedisBackend>();

function getRedisBackend(redisUrl: string): RedisBackend {
	const existing = redisBackends.get(redisUrl);
	if (existing) return existing;
	const redis = createProviderRedisClient({
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
			throw new UnsupportedProviderStateError(
				"Provider runtime state Redis timed out",
			);
		},
		onError: () => {
			throw new UnsupportedProviderStateError(
				"Provider runtime state Redis is unavailable",
			);
		},
	});
}

async function requireRedisReady(redis: ProviderRedisClient): Promise<void> {
	if (await ensureRedisReady(redis, DEFAULT_REDIS_TIMEOUT_MS)) return;
	throw new UnsupportedProviderStateError(
		"Provider runtime state Redis is unavailable",
	);
}

function providerStatePrefix(
	providerId: string | undefined,
	namespace: string,
): string {
	return `${REDIS_STATE_PREFIX}:${providerId ?? "default"}:${namespace}`;
}

function providerStateKey(
	providerId: string | undefined,
	namespace: string,
	key: string,
): string {
	return `${providerStatePrefix(providerId, namespace)}:${key}`;
}

function publicStateKey(
	providerId: string | undefined,
	namespace: string,
	redisKey: string,
): string {
	const prefix = `${providerStatePrefix(providerId, namespace)}:`;
	return redisKey.startsWith(prefix) ? redisKey.slice(prefix.length) : redisKey;
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
	const parsed: unknown = JSON.parse(raw);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const record: Record<string, unknown> = Object.fromEntries(
		Object.entries(parsed),
	);
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
	) {}

	private redisKey(key: string): string {
		return providerStateKey(this.providerId, this.namespaceName, key);
	}

	private prefix(): string {
		return `${providerStatePrefix(this.providerId, this.namespaceName)}:`;
	}

	private async activeKeys(): Promise<string[]> {
		await requireRedisReady(this.backend.redis);
		return await withRequiredRedis(() =>
			this.backend.redis.keys(`${this.prefix()}*`),
		);
	}

	private enforceValueSize(value: unknown): void {
		const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
		if (bytes > this.options.maxValueBytes) {
			throw new UnsupportedProviderStateError(
				`Provider runtime state value exceeds maxValueBytes (${bytes} > ${this.options.maxValueBytes})`,
			);
		}
	}

	private async enforceMaxEntries(key: string): Promise<void> {
		const keys = await this.activeKeys();
		const redisKey = this.redisKey(key);
		const otherKeys = keys.filter((candidate) => candidate !== redisKey);
		if (otherKeys.length >= this.options.maxEntries) {
			throw new UnsupportedProviderStateError(
				`Provider runtime state namespace quota exceeded (${otherKeys.length + 1} > ${this.options.maxEntries})`,
			);
		}
	}

	async list<T>(options?: {
		limit?: number;
		prefix?: string;
	}): Promise<StateValue<T>[]> {
		const keys = (await this.activeKeys()).filter((key) => {
			const publicKey = publicStateKey(
				this.providerId,
				this.namespaceName,
				key,
			);
			return options?.prefix ? publicKey.startsWith(options.prefix) : true;
		});
		const limited = keys.slice(0, Math.max(0, options?.limit ?? keys.length));
		if (limited.length === 0) return [];
		const values = await withRequiredRedis(() =>
			this.backend.redis.mget(limited),
		);
		return values.flatMap((raw, index) => {
			const key = limited[index];
			if (!key) return [];
			const value = envelopeFromJson(
				publicStateKey(this.providerId, this.namespaceName, key),
				raw,
			);
			return value ? [value] : [];
		});
	}

	async get<T>(key: string): Promise<StateValue<T> | null> {
		await requireRedisReady(this.backend.redis);
		const raw = await withRequiredRedis(() =>
			this.backend.redis.get(this.redisKey(key)),
		);
		return envelopeFromJson(key, raw);
	}

	async set<T>(
		key: string,
		value: T,
		options?: StateWriteOptions,
	): Promise<StateValue<T>> {
		this.enforceValueSize(value);
		await this.enforceMaxEntries(key);
		const current = await this.get<T>(key);
		const createdAt = current?.createdAt ?? new Date().toISOString();
		const version = (current?.version ?? 0) + 1;
		const ttl = options?.ttl ?? this.options.defaultTtl;
		const ttlMs = parseStateDurationMs(ttl);
		const expiresAt = resolveExpiresAt(ttl);
		const envelope = redisEnvelope(value, version, createdAt, expiresAt);
		await withRequiredRedis(() =>
			this.backend.redis.set(
				this.redisKey(key),
				JSON.stringify(envelope),
				"PX",
				ttlMs,
			),
		);
		return {
			key,
			value,
			version,
			expiresAt,
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
		const current = await this.get<T>(key);
		if ((current?.version ?? 0) !== expectedVersion) {
			return { ok: false, current };
		}
		return { ok: true, value: await this.set(key, value, options) };
	}

	async delete(key: string): Promise<void> {
		await requireRedisReady(this.backend.redis);
		await withRequiredRedis(() => this.backend.redis.del(this.redisKey(key)));
	}

	async increment(
		key: string,
		field: string,
		delta = 1,
		options?: StateWriteOptions,
	): Promise<StateValue<Record<string, unknown>>> {
		const current = (await this.get<Record<string, unknown>>(key))?.value ?? {};
		const previous = typeof current[field] === "number" ? current[field] : 0;
		return await this.set(
			key,
			{ ...current, [field]: previous + delta },
			options,
		);
	}
}

class RedisProviderRuntimeState implements ProviderRuntimeState {
	readonly backend: RedisBackend;
	readonly providerId?: string;

	constructor(options: RedisProviderRuntimeStateOptions) {
		this.backend = getRedisBackend(options.redisUrl);
		this.providerId = options.providerId;
	}

	namespace(
		name: string,
		options: StateNamespaceOptions,
	): ProviderStateNamespace {
		return new RedisProviderStateNamespace(
			this.backend,
			this.providerId,
			name,
			options,
		);
	}
}

export class UnsupportedProviderStateError extends ProviderError {
	constructor(
		message = "Provider runtime state is not available in this runtime",
	) {
		super(message, { code: "PROVIDER_STATE_UNSUPPORTED" });
		this.name = "UnsupportedProviderStateError";
	}
}

class UnsupportedProviderStateNamespace implements ProviderStateNamespace {
	async list<T>(_options?: {
		limit?: number;
		prefix?: string;
	}): Promise<StateValue<T>[]> {
		throw new UnsupportedProviderStateError();
	}
	async get<T>(_key: string): Promise<StateValue<T> | null> {
		throw new UnsupportedProviderStateError();
	}
	async set<T>(
		_key: string,
		_value: T,
		_options?: StateWriteOptions,
	): Promise<StateValue<T>> {
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
	namespace(
		_name: string,
		_options: StateNamespaceOptions,
	): ProviderStateNamespace {
		return new UnsupportedProviderStateNamespace();
	}
}

class MemoryProviderStateNamespace implements ProviderStateNamespace {
	// biome-ignore lint/suspicious/noExplicitAny: in-memory state stores heterogeneous generic values by key.
	readonly values = new Map<string, StateValue<any>>();

	constructor(private readonly options: StateNamespaceOptions) {}

	private pruneExpired(nowMs = Date.now()): void {
		for (const [key, row] of this.values.entries()) {
			if (row.expiresAt && Date.parse(row.expiresAt) <= nowMs) {
				this.values.delete(key);
			}
		}
	}

	async list<T>(_options?: {
		limit?: number;
		prefix?: string;
	}): Promise<StateValue<T>[]> {
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

	async set<T>(
		key: string,
		value: T,
		options?: StateWriteOptions,
	): Promise<StateValue<T>> {
		this.pruneExpired();
		const now = new Date().toISOString();
		const current = this.values.get(key);
		const expiresAt = resolveMemoryStateExpiresAt(
			options?.ttl ?? this.options.defaultTtl,
		);
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
		_key: string,
		_expectedVersion: number,
		_value: T,
		_options?: StateWriteOptions,
	): Promise<StateCasResult<T>> {
		throw new UnsupportedProviderStateError(
			"In-memory provider runtime state does not support compareAndSet",
		);
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

class MemoryProviderRuntimeState implements ProviderRuntimeState {
	readonly namespaces = new Map<string, MemoryProviderStateNamespace>();

	namespace(
		name: string,
		_options: StateNamespaceOptions,
	): ProviderStateNamespace {
		const existing = this.namespaces.get(name);
		if (existing) return existing;
		const created = new MemoryProviderStateNamespace(_options);
		this.namespaces.set(name, created);
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
	options: {
		readonly providerId?: string;
		readonly allowMemoryFallback?: boolean;
	} = {},
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
