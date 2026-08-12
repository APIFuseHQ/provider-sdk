import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { Redis } from "ioredis";
import type { ProviderRedisClient } from "../runtime/redis.js";
import { createRedisProviderRuntimeState } from "../runtime/state.js";
import type { StateNamespaceOptions } from "../types.js";

const redisUrl = process.env.APIFUSE__TEST__REDIS_URL?.trim() || "redis://127.0.0.1:6379";
const integrationRedis = new Redis(redisUrl, {
	connectTimeout: 250,
	enableOfflineQueue: false,
	lazyConnect: true,
	maxRetriesPerRequest: 0,
	retryStrategy: () => null,
});
integrationRedis.on("error", () => {});

let redisUnavailableReason: string | undefined;
try {
	await integrationRedis.connect();
	await integrationRedis.ping();
} catch (error) {
	redisUnavailableReason = error instanceof Error ? error.message : String(error);
	integrationRedis.disconnect();
}
const redisAvailable = redisUnavailableReason === undefined;
if (!redisAvailable) {
	console.warn(
		`[redis-state-scope] SKIP: real Redis is unavailable at ${redisUrl}; Lua integration tests were not run (${redisUnavailableReason}).`,
	);
}

const namespaceOptions = {
	defaultTtl: "1h",
	maxTtl: "1d",
	maxEntries: 10,
	maxValueBytes: 1024,
} satisfies StateNamespaceOptions;

const runId = `state-scope-test-${randomUUID()}`;
let nextRedisId = 0;
function createRedisState() {
	nextRedisId += 1;
	const providerId = `${runId}-${nextRedisId}`;
	const backendId = `${redisUrl}#${providerId}`;
	const state = createRedisProviderRuntimeState({
		redisUrl: backendId,
		providerId,
		__redisClient: integrationRedis as ProviderRedisClient,
	});
	return { providerId, redis: integrationRedis, state };
}

function legacyKey(providerId: string, namespace: string, key: string): string {
	return `apifuse:provider-state:v1:${providerId}:${namespace}:${key}`;
}

function scopedKey(
	providerId: string,
	namespace: string,
	connectionId: string,
	key: string,
): string {
	const digest = createHash("sha256").update(connectionId).digest("hex");
	return `apifuse:provider-state:v2:${providerId}:${namespace}:scope:connection:sha256:${digest}:${key}`;
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

function isOwnedTestKey(key: string): boolean {
	if (key.includes(runId)) return true;
	const indexPrefix = "apifuse:provider-state:v2:index:";
	if (!key.startsWith(indexPrefix)) return false;
	const encoded = key.slice(indexPrefix.length).split(":", 1)[0];
	if (!encoded) return false;
	try {
		return Buffer.from(encoded, "base64url").toString("utf8").includes(runId);
	} catch {
		return false;
	}
}

afterAll(async () => {
	if (!redisAvailable) return;
	let cursor = "0";
	do {
		const [nextCursor, keys] = await integrationRedis.scan(cursor, "COUNT", 256);
		const owned = keys.filter(isOwnedTestKey);
		if (owned.length > 0) await integrationRedis.del(...owned);
		cursor = nextCursor;
	} while (cursor !== "0");
	integrationRedis.disconnect();
});

describe.skipIf(!redisAvailable)("Redis provider runtime state scoping (real Redis Lua)", () => {
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

	test("atomically adopts a legacy value into only one concrete connection scope", async () => {
		const { providerId, redis, state } = createRedisState();
		const oldKey = legacyKey(providerId, "attempts.v1", "consumed");
		await redis.set(oldKey, legacyEnvelope({ consumed: true }, 7), "PX", 3_600_000);
		const missingConnection = state.namespace("attempts.v1", namespaceOptions);
		const connectionA = state
			.forConnection("secret-connection-id")
			.namespace("attempts.v1", namespaceOptions);
		const connectionB = state
			.forConnection("connection-b")
			.namespace("attempts.v1", namespaceOptions);

		expect(await missingConnection.get("consumed")).toBeNull();
		expect(JSON.parse((await redis.get(oldKey)) as string)).not.toHaveProperty("deleted");
		expect((await connectionA.get<{ consumed: boolean }>("consumed"))?.value).toEqual({
			consumed: true,
		});
		expect((await connectionA.list()).map((row) => row.key)).toContain("consumed");
		expect(await connectionB.get("consumed")).toBeNull();
		expect(JSON.parse((await redis.get(oldKey)) as string)).toEqual({ deleted: true });

		const currentScopedKey = scopedKey(
			providerId,
			"attempts.v1",
			"secret-connection-id",
			"consumed",
		);
		expect(await redis.get(currentScopedKey)).not.toBeNull();
		expect(currentScopedKey).not.toContain("secret-connection-id");
		await redis.del(currentScopedKey);
		expect(await connectionA.get("consumed")).toBeNull();
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

	test("version-0 CAS cannot win while a live legacy value exists", async () => {
		const { providerId, redis, state } = createRedisState();
		const oldKey = legacyKey(providerId, "guards.v1", "guard");
		// A key without Redis expiry is still live and must block version-0 CAS.
		await redis.set(oldKey, legacyEnvelope("legacy", 1));
		const namespace = state.forConnection("connection-a").namespace("guards.v1", namespaceOptions);

		const result = await namespace.compareAndSet("guard", 0, "duplicate");
		expect(result.ok).toBe(false);
		expect(result.current?.value).toBe("legacy");
		expect((await namespace.get<string>("guard"))?.value).toBe("legacy");
		expect(JSON.parse((await redis.get(oldKey)) as string)).toEqual({ deleted: true });
	});

	test("missing-connection CAS is blocked by legacy state without adopting it", async () => {
		const { providerId, redis, state } = createRedisState();
		const oldKey = legacyKey(providerId, "guards.v1", "guard");
		const oldEnvelope = legacyEnvelope("legacy", 1);
		await redis.set(oldKey, oldEnvelope, "PX", 3_600_000);
		const namespace = state.namespace("guards.v1", namespaceOptions);

		expect((await namespace.compareAndSet("guard", 0, "duplicate")).ok).toBe(false);
		expect(await redis.get(oldKey)).toBe(oldEnvelope);
		expect(await namespace.get("guard")).toBeNull();
	});

	test("CAS migrates a matching legacy value in the same atomic script", async () => {
		const { providerId, redis, state } = createRedisState();
		const oldKey = legacyKey(providerId, "guards.v1", "guard");
		await redis.set(oldKey, legacyEnvelope("legacy", 4), "PX", 3_600_000);
		const namespace = state.forConnection("connection-a").namespace("guards.v1", namespaceOptions);

		const result = await namespace.compareAndSet("guard", 4, "scoped");
		expect(result.ok).toBe(true);
		expect(result.value.version).toBe(5);
		expect((await namespace.get<string>("guard"))?.value).toBe("scoped");
		expect(JSON.parse((await redis.get(oldKey)) as string)).toEqual({ deleted: true });
	});

	test("delete tombstones both a scoped key and its live legacy predecessor", async () => {
		const { providerId, redis, state } = createRedisState();
		const oldKey = legacyKey(providerId, "guards.v1", "guard");
		await redis.set(oldKey, legacyEnvelope("legacy", 2), "PX", 3_600_000);
		const namespace = state.forConnection("connection-a").namespace("guards.v1", namespaceOptions);

		await namespace.delete("guard");
		expect(await namespace.get("guard")).toBeNull();
		expect(JSON.parse((await redis.get(oldKey)) as string)).toEqual({ deleted: true });
	});
});
