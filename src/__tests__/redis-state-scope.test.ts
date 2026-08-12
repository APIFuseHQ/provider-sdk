import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { ProviderRedisClient } from "../runtime/redis.js";
import { createRedisProviderRuntimeState } from "../runtime/state.js";
import type { StateNamespaceOptions } from "../types.js";

type StoredString = { value: string; expiresAt?: number };

class FakeStateRedis {
	readonly status = "ready";
	readonly strings = new Map<string, StoredString>();
	readonly sortedSets = new Map<string, Map<string, number>>();
	private evalTail: Promise<void> = Promise.resolve();

	on(): this {
		return this;
	}
	off(): this {
		return this;
	}
	once(): this {
		return this;
	}

	private pruneString(key: string): void {
		const row = this.strings.get(key);
		if (row?.expiresAt !== undefined && row.expiresAt <= Date.now()) this.strings.delete(key);
	}

	async get(key: string): Promise<string | null> {
		this.pruneString(key);
		return this.strings.get(key)?.value ?? null;
	}

	async mget(...input: Array<string | string[]>): Promise<(string | null)[]> {
		const keys = input.flat();
		return await Promise.all(keys.map((key) => this.get(key)));
	}

	async set(key: string, value: string, mode?: string, duration?: number): Promise<"OK"> {
		const expiresAt =
			mode === "PXAT"
				? duration
				: mode === "PX" && duration !== undefined
					? Date.now() + duration
					: undefined;
		this.strings.set(key, { value, expiresAt });
		return "OK";
	}

	async scan(
		_cursor: string,
		_match: "MATCH",
		pattern: string,
		_count: "COUNT",
		_countValue: number,
	): Promise<[string, string[]]> {
		const literalPrefix = pattern.slice(0, -1).replace(/\\(.)/g, "$1");
		for (const key of this.strings.keys()) this.pruneString(key);
		const keys = Array.from(this.strings.keys()).filter((key) => key.startsWith(literalPrefix));
		return ["0", keys];
	}

	private sortedSet(key: string): Map<string, number> {
		const existing = this.sortedSets.get(key);
		if (existing) return existing;
		const created = new Map<string, number>();
		this.sortedSets.set(key, created);
		return created;
	}

	async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number> {
		const minimum = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min);
		const maximum = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max);
		let removed = 0;
		for (const [member, score] of this.sortedSet(key)) {
			if (score >= minimum && score <= maximum) {
				this.sortedSet(key).delete(member);
				removed += 1;
			}
		}
		return removed;
	}

	async zrangebyscore(
		key: string,
		min: number | string,
		max: number | string,
		_limit: "LIMIT",
		offset: number,
		limit: number,
	): Promise<string[]> {
		const minimum = Number(min);
		const maximum = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max);
		return Array.from(this.sortedSet(key))
			.filter(([, score]) => score >= minimum && score <= maximum)
			.sort((left, right) => left[1] - right[1])
			.slice(offset, offset + limit)
			.map(([member]) => member);
	}

	async eval(script: string, keyCount: number, ...input: Array<string | number>): Promise<unknown> {
		let release: (() => void) | undefined;
		const previous = this.evalTail;
		this.evalTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await this.evalAtomically(script, keyCount, input);
		} finally {
			release?.();
		}
	}

	private async evalAtomically(
		script: string,
		keyCount: number,
		input: Array<string | number>,
	): Promise<unknown> {
		const keys = input.slice(0, keyCount).map(String);
		const args = input.slice(keyCount).map(String);
		if (script.includes("local next_cursor")) return await this.evalBackfill(keys, args);
		if (script.includes("local current_version")) return await this.evalCompareAndSet(keys, args);
		if (script.includes('redis.call("SET", KEYS[1], ARGV[1], "PX"')) {
			await this.set(keys[0] as string, args[0] as string, "PX", Number(args[1]));
			this.sortedSet(keys[1] as string).delete(keys[0] as string);
			this.sortedSet(keys[1] as string).delete(keys[2] as string);
			return 1;
		}
		return await this.evalSet(keys, args);
	}

	private async evalSet(keys: string[], args: string[]): Promise<[number, string | null]> {
		const [valueKey, indexKey, legacyKey] = keys;
		const [now, maxEntries, expiresAt, , envelope] = args;
		await this.zremrangebyscore(indexKey as string, "-inf", Number(now));
		const index = this.sortedSet(indexKey as string);
		index.delete(legacyKey as string);
		if (!index.has(valueKey as string) && index.size >= Number(maxEntries)) return [0, null];
		await this.set(valueKey as string, envelope as string, "PXAT", Number(expiresAt));
		index.set(valueKey as string, Number(expiresAt));
		return [1, envelope as string];
	}

	private async evalCompareAndSet(
		keys: string[],
		args: string[],
	): Promise<[number, string | null]> {
		const [valueKey, indexKey, legacyKey] = keys;
		const [expectedVersion, now, maxEntries, expiresAt, , envelope] = args;
		const scoped = await this.get(valueKey as string);
		let current = scoped;
		if (scoped !== null && (JSON.parse(scoped) as { deleted?: boolean }).deleted === true) {
			current = null;
		} else if (scoped === null) {
			current = await this.get(legacyKey as string);
		}
		const currentVersion =
			current === null ? 0 : Number((JSON.parse(current) as { version: number }).version);
		if (currentVersion !== Number(expectedVersion)) return [-1, current];
		await this.zremrangebyscore(indexKey as string, "-inf", Number(now));
		const index = this.sortedSet(indexKey as string);
		index.delete(legacyKey as string);
		if (!index.has(valueKey as string) && index.size >= Number(maxEntries)) return [0, null];
		await this.set(valueKey as string, envelope as string, "PXAT", Number(expiresAt));
		index.set(valueKey as string, Number(expiresAt));
		return [1, envelope as string];
	}

	private async evalBackfill(keys: string[], args: string[]): Promise<number> {
		const [indexKey, cursorKey] = keys;
		const [now, indexTtl, nextCursor, ...entries] = args;
		await this.zremrangebyscore(indexKey as string, "-inf", Number(now));
		const index = this.sortedSet(indexKey as string);
		for (let offset = 0; offset < entries.length; offset += 4) {
			const [legacyKey, expected, expiresAt, scopedKey] = entries.slice(offset, offset + 4);
			if (
				(await this.get(legacyKey as string)) === expected &&
				(await this.get(scopedKey as string)) === null
			) {
				if (!index.has(legacyKey as string)) index.set(legacyKey as string, Number(expiresAt));
			} else {
				index.delete(legacyKey as string);
			}
		}
		await this.set(cursorKey as string, nextCursor as string, "PX", Number(indexTtl));
		return index.size;
	}
}

const namespaceOptions = {
	defaultTtl: "1h",
	maxTtl: "1d",
	maxEntries: 10,
	maxValueBytes: 1024,
} satisfies StateNamespaceOptions;

let nextRedisId = 0;
function createRedisState() {
	const redis = new FakeStateRedis();
	nextRedisId += 1;
	const state = createRedisProviderRuntimeState({
		redisUrl: `redis://state-scope-test-${nextRedisId}`,
		providerId: "test-provider",
		__redisClient: redis as unknown as ProviderRedisClient,
	});
	return { redis, state };
}

function legacyEnvelope(value: unknown, version = 1): string {
	const now = new Date().toISOString();
	return JSON.stringify({
		value,
		version,
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
		createdAt: now,
		updatedAt: now,
	});
}

describe("Redis provider runtime state scoping", () => {
	test("isolates values and quota between connection scopes", async () => {
		const { state } = createRedisState();
		const options = { ...namespaceOptions, maxEntries: 1 };
		const connectionA = state.forConnection("connection-a").namespace("attempts.v1", options);
		const connectionB = state.forConnection("connection-b").namespace("attempts.v1", options);

		await connectionA.set("active", "a");
		expect(await connectionB.get("active")).toBeNull();
		await connectionB.set("active", "b");
		expect((await connectionA.get<string>("active"))?.value).toBe("a");
		expect((await connectionB.get<string>("active"))?.value).toBe("b");
		await expect(connectionA.set("second", true)).rejects.toThrow("namespace quota exceeded");
	});

	test("shares an explicitly provider-global namespace", async () => {
		const { state } = createRedisState();
		const options = { ...namespaceOptions, scope: "provider" } satisfies StateNamespaceOptions;
		const connectionA = state.forConnection("connection-a").namespace("health.v1", options);
		const connectionB = state.forConnection("connection-b").namespace("health.v1", options);

		await connectionA.set("monitor", "healthy");
		expect((await connectionB.get<string>("monitor"))?.value).toBe("healthy");
	});

	test("dual-reads v1 values and rewrites only the hashed v2 connection key", async () => {
		const { redis, state } = createRedisState();
		const legacyKey = "apifuse:provider-state:v1:test-provider:attempts.v1:consumed";
		await redis.set(legacyKey, legacyEnvelope({ consumed: true }, 7));
		const namespace = state
			.forConnection("secret-connection-id")
			.namespace("attempts.v1", namespaceOptions);

		expect((await namespace.get<{ consumed: boolean }>("consumed"))?.value).toEqual({
			consumed: true,
		});
		expect((await namespace.list()).map((row) => row.key)).toContain("consumed");
		const rewritten = await namespace.set("consumed", { consumed: false });
		expect(rewritten.version).toBe(8);

		const digest = createHash("sha256").update("secret-connection-id").digest("hex");
		const scopedKey = `apifuse:provider-state:v2:test-provider:attempts.v1:scope:connection:sha256:${digest}:consumed`;
		expect(await redis.get(scopedKey)).not.toBeNull();
		expect(await redis.get(legacyKey)).not.toBeNull();
		expect(scopedKey).not.toContain("secret-connection-id");
	});

	test("keeps same-scope CAS atomic without cross-scope interference", async () => {
		const { state } = createRedisState();
		const connectionA = state
			.forConnection("connection-a")
			.namespace("guards.v1", namespaceOptions);
		const connectionB = state
			.forConnection("connection-b")
			.namespace("guards.v1", namespaceOptions);
		await connectionA.set("guard", "initial-a");
		await connectionB.set("guard", "initial-b");

		const sameScope = await Promise.all([
			connectionA.compareAndSet("guard", 1, "winner-1"),
			connectionA.compareAndSet("guard", 1, "winner-2"),
		]);
		expect(sameScope.filter((result) => result.ok)).toHaveLength(1);
		expect((await connectionB.compareAndSet("guard", 1, "winner-b")).ok).toBe(true);
	});

	test("CAS migrates a matching legacy value into the scoped key", async () => {
		const { redis, state } = createRedisState();
		const legacyKey = "apifuse:provider-state:v1:test-provider:guards.v1:guard";
		await redis.set(legacyKey, legacyEnvelope("legacy", 4));
		const namespace = state.forConnection("connection-a").namespace("guards.v1", namespaceOptions);

		const result = await namespace.compareAndSet("guard", 4, "scoped");
		expect(result.ok).toBe(true);
		expect((await namespace.get<string>("guard"))?.value).toBe("scoped");
		expect(await redis.get(legacyKey)).not.toBeNull();
	});
});
