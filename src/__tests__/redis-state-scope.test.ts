import { randomUUID } from "node:crypto";
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

});
