import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { Redis } from "ioredis";
import { z } from "zod";
import { defineCursor, defineDraft } from "../handle.js";
import { createHandleContext } from "../runtime/handle.js";
import type { ProviderRedisClient } from "../runtime/redis.js";
import { createRedisProviderRuntimeState } from "../runtime/state.js";

// Real-Redis regression for ADR-0012 handles: the compare-and-set Lua script
// must not re-encode provider values (cjson turns `[]` into `{}`), and the
// runtime must hand back exactly what was validated on every read and replay.

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
		`[handle-redis] SKIP: real Redis is unavailable at ${redisUrl}; handle Lua integration tests were not run (${redisUnavailableReason}).`,
	);
}

const runId = `handle-redis-test-${randomUUID()}`;

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

const Basket = defineDraft({
	name: "basket",
	schema: z.object({
		items: z.array(z.object({ sku: z.string(), qty: z.number().int() })),
		tags: z.array(z.string()),
		note: z.string().optional(),
	}),
	result: z.object({ orderId: z.string(), lines: z.array(z.string()) }),
	ttl: { idle: "10m", max: "1h" },
});

const Page = defineCursor({
	name: "rpage",
	schema: z.object({ seen: z.array(z.string()), page: z.number().int() }),
	ttl: "10m",
});

function createContext() {
	const providerId = `${runId}-${randomUUID().slice(0, 8)}`;
	const state = createRedisProviderRuntimeState({
		redisUrl: `${redisUrl}#${providerId}`,
		providerId,
		__redisClient: integrationRedis as ProviderRedisClient,
	});
	return createHandleContext({
		providerId,
		state,
		request: { headers: {}, connectionId: "redis-test-connection" },
	});
}

describe.skipIf(!redisAvailable)("ctx.handle on real Redis (Lua compare-and-set)", () => {
	test("keeps empty arrays through create, sliding-ttl reads, updates, and commit replay", async () => {
		const ctx = createContext();
		const handle = await ctx.create(Basket, { items: [], tags: [] });

		// Every read of an active draft touches its ttl through compare-and-set.
		expect((await ctx.read(Basket, handle)).data).toEqual({ items: [], tags: [] });
		expect((await ctx.read(Basket, handle)).data).toEqual({ items: [], tags: [] });

		const updated = await ctx.update(Basket, handle, (data) => ({ ...data, note: "gift" }));
		expect(updated.data).toEqual({ items: [], tags: [], note: "gift" });
		expect((await ctx.read(Basket, handle)).data).toEqual({ items: [], tags: [], note: "gift" });

		const committed = await ctx.commit(Basket, handle, async () => ({ orderId: "o-1", lines: [] }));
		expect(committed).toMatchObject({ status: "committed", result: { orderId: "o-1", lines: [] } });
		const replay = await ctx.commit(Basket, handle, async () => ({ orderId: "o-2", lines: ["x"] }));
		expect(replay).toMatchObject({ status: "replayed", result: { orderId: "o-1", lines: [] } });
		expect((await ctx.read(Basket, handle)).result).toEqual({ orderId: "o-1", lines: [] });
	});

	test("preserves createdAt across compare-and-set refreshes without re-encoding the value", async () => {
		const ctx = createContext();
		const handle = await ctx.create(Page, { seen: [], page: 1 });
		const first = await ctx.read(Page, handle);
		const second = await ctx.read(Page, handle);
		expect(second.createdAt).toBe(first.createdAt);
		expect(second.data).toEqual({ seen: [], page: 1 });
	});
});
