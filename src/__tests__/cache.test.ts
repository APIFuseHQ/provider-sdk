import { afterEach, describe, expect, it } from "bun:test";

import {
	createBypassProviderCache,
	createProviderCache,
	resetProviderCacheForTests,
} from "../runtime/cache";

describe("provider cache", () => {
	afterEach(() => {
		resetProviderCacheForTests();
	});

	it("builds stable secret-safe keys", () => {
		const cache = createProviderCache({ providerId: "kma" });
		const first = cache.key("forecast", {
			nx: "60",
			ny: "127",
			serviceKey: "secret-1",
		});
		const second = cache.key("forecast", {
			serviceKey: "secret-2",
			ny: "127",
			nx: "60",
		});

		expect(first).toBe(second);
		expect(first).not.toContain("secret");
	});

	it("keeps non-secret token-shaped selectors in cache keys", () => {
		const cache = createProviderCache({ providerId: "paged-api" });
		const firstPage = cache.key("list", {
			pageToken: "page-1",
			query: "weather",
		});
		const secondPage = cache.key("list", {
			pageToken: "page-2",
			query: "weather",
		});
		const nextPage = cache.key("list", {
			nextToken: "page-2",
			query: "weather",
		});

		expect(firstPage).not.toBe(secondPage);
		expect(firstPage).not.toBe(nextPage);
	});

	it("returns fresh hits without calling the loader", async () => {
		let now = 1_000;
		let calls = 0;
		const cache = createProviderCache({
			providerId: "kma",
			now: () => now,
		});
		const key = cache.key("forecast", { nx: 60, ny: 127 });

		const miss = await cache.getOrSet(
			key,
			async () => {
				calls += 1;
				return { temperature: 21 };
			},
			{ ttlMs: 1_000 },
		);
		now += 100;
		const hit = await cache.getOrSet(
			key,
			async () => {
				calls += 1;
				return { temperature: 99 };
			},
			{ ttlMs: 1_000 },
		);

		expect(calls).toBe(1);
		expect(miss.meta.hit).toBe(false);
		expect(hit.meta.hit).toBe(true);
		expect(hit.meta.stale).toBe(false);
		expect(hit.value).toEqual({ temperature: 21 });
		expect(cache.responseMeta()?.hit).toBe(true);
	});

	it("returns stale cached value when loader fails inside stale window", async () => {
		let now = 1_000;
		const cache = createProviderCache({
			providerId: "kma",
			now: () => now,
		});
		const key = cache.key("forecast", { nx: 60, ny: 127 });

		await cache.getOrSet(key, async () => ({ temperature: 21 }), {
			ttlMs: 100,
			staleIfErrorMs: 1_000,
		});
		now += 500;

		const stale = await cache.getOrSet(
			key,
			async () => {
				throw new Error("upstream 429");
			},
			{ ttlMs: 100, staleIfErrorMs: 1_000 },
		);

		expect(stale.value).toEqual({ temperature: 21 });
		expect(stale.meta.hit).toBe(true);
		expect(stale.meta.stale).toBe(true);
		expect(cache.responseMeta()?.stale).toBe(true);
	});

	it("coalesces concurrent misses for the same key", async () => {
		const cache = createProviderCache({ providerId: "kma" });
		const key = cache.key("forecast", { nx: 60, ny: 127 });
		let calls = 0;

		const loader = async () => {
			calls += 1;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return { temperature: 21 };
		};

		const [left, right] = await Promise.all([
			cache.getOrSet(key, loader, { ttlMs: 1_000 }),
			cache.getOrSet(key, loader, { ttlMs: 1_000 }),
		]);

		expect(calls).toBe(1);
		expect(left.value).toEqual(right.value);
	});

	it("bounds in-memory entries with least-recently-used eviction", async () => {
		const cache = createProviderCache({
			providerId: "kma",
			memoryMaxEntries: 2,
		});

		await cache.set("first", { value: 1 }, { ttlMs: 1_000 });
		await cache.set("second", { value: 2 }, { ttlMs: 1_000 });
		await cache.get("first");
		await cache.set("third", { value: 3 }, { ttlMs: 1_000 });

		expect(await cache.get("first")).not.toBeNull();
		expect(await cache.get("second")).toBeNull();
		expect(await cache.get("third")).not.toBeNull();
	});

	it("fails open when Redis is unavailable", async () => {
		const cache = createProviderCache({
			providerId: "kma",
			redisUrl: "redis://127.0.0.1:1",
		});
		const key = cache.key("forecast", { nx: 60, ny: 127 });

		const result = await cache.getOrSet(key, async () => ({ ok: true }), {
			ttlMs: 1_000,
		});

		expect(result.value).toEqual({ ok: true });
		expect(result.meta.source).toBe("loader");
	});

	it("bypass cache always calls the loader", async () => {
		const cache = createBypassProviderCache({ providerId: "recording" });
		const key = cache.key("fixture", { id: "weather" });
		let calls = 0;

		const first = await cache.getOrSet(key, async () => {
			calls += 1;
			return { call: calls };
		});
		const second = await cache.getOrSet(key, async () => {
			calls += 1;
			return { call: calls };
		});

		expect(calls).toBe(2);
		expect(first.value).toEqual({ call: 1 });
		expect(second.value).toEqual({ call: 2 });
		expect(await cache.get(key)).toBeNull();
		expect(cache.responseMeta()?.source).toBe("loader");
	});
});
