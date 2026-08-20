import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { isProviderError } from "../errors.js";
import {
	APIFUSE__CACHE__KEY_PEPPER_ENV,
	createBypassProviderCache,
	createProviderCache,
	resetProviderCacheForTests,
} from "../runtime/cache.js";

const originalCacheKeyPepper = process.env[APIFUSE__CACHE__KEY_PEPPER_ENV];
const originalConsoleWarn = console.warn;

describe("provider cache", () => {
	beforeEach(() => {
		process.env[APIFUSE__CACHE__KEY_PEPPER_ENV] = "cache-test-pepper";
	});

	afterEach(() => {
		resetProviderCacheForTests();
		console.warn = originalConsoleWarn;
		if (originalCacheKeyPepper === undefined) {
			delete process.env[APIFUSE__CACHE__KEY_PEPPER_ENV];
		} else {
			process.env[APIFUSE__CACHE__KEY_PEPPER_ENV] = originalCacheKeyPepper;
		}
	});

	it("exports the cache-key pepper environment variable name", () => {
		expect(APIFUSE__CACHE__KEY_PEPPER_ENV).toBe("APIFUSE__CACHE__KEY_PEPPER");
	});

	it("uses a construction-time HMAC pepper for secret selectors", () => {
		process.env[APIFUSE__CACHE__KEY_PEPPER_ENV] = "pepper-a";
		const firstCache = createProviderCache({ providerId: "peppered-api" });
		const samePepperCache = createProviderCache({ providerId: "peppered-api" });

		process.env[APIFUSE__CACHE__KEY_PEPPER_ENV] = "pepper-b";
		const differentPepperCache = createProviderCache({ providerId: "peppered-api" });
		const parts = { accountId: "account-1", password: "1234" };
		const first = firstCache.key("profile", parts);
		const same = samePepperCache.key("profile", parts);
		const different = differentPepperCache.key("profile", parts);

		expect(first).toBe(same);
		expect(first).not.toBe(different);
	});

	it("preserves legacy SHA-256 keys and warns once when the pepper is unset", () => {
		delete process.env[APIFUSE__CACHE__KEY_PEPPER_ENV];
		const warn = mock((message: unknown) => void message);
		console.warn = warn;
		const cache = createProviderCache({ providerId: "kma" });

		const key = cache.key("forecast", {
			nx: "60",
			ny: "127",
			serviceKey: "secret-1",
		});
		cache.key("forecast", { serviceKey: "secret-2" });

		expect(key).toBe("apifuse:provider-cache:v1:kma:forecast:9a1d1fcd7fea7447ed6bdad5adcb65cd");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
			level: "warn",
			event: "provider_cache_secret_key_unpeppered",
			message:
				"Secret-bearing cache keys are using unkeyed SHA-256 because APIFUSE__CACHE__KEY_PEPPER is not configured.",
		});
	});

	it("hashes secret selectors without collapsing distinct values", () => {
		const cache = createProviderCache({ providerId: "kma" });
		const first = cache.key("forecast", {
			nx: "60",
			ny: "127",
			serviceKey: "secret-1",
		});
		const same = cache.key("forecast", {
			serviceKey: "secret-1",
			ny: "127",
			nx: "60",
		});
		const different = cache.key("forecast", {
			serviceKey: "secret-2",
			ny: "127",
			nx: "60",
		});

		expect(first).toBe(same);
		expect(first).not.toBe(different);
		expect(first).not.toContain("secret-1");
		expect(different).not.toContain("secret-2");
	});

	it("hashes configured and nested non-string secret values canonically", () => {
		const cache = createProviderCache({ providerId: "nested-api" });
		const options = { redactFields: ["partition"] };
		const first = cache.key(
			"batch",
			{
				requests: [
					{
						authorization: { credential: "credential-a", level: 1 },
						partition: 7,
					},
				],
			},
			options,
		);
		const reordered = cache.key(
			"batch",
			{
				requests: [
					{
						partition: 7,
						authorization: { level: 1, credential: "credential-a" },
					},
				],
			},
			options,
		);
		const differentAuthorization = cache.key(
			"batch",
			{
				requests: [
					{
						authorization: { credential: "credential-b", level: 1 },
						partition: 7,
					},
				],
			},
			options,
		);
		const differentPartition = cache.key(
			"batch",
			{
				requests: [
					{
						authorization: { credential: "credential-a", level: 1 },
						partition: 8,
					},
				],
			},
			options,
		);

		expect(first).toBe(reordered);
		expect(first).not.toBe(differentAuthorization);
		expect(first).not.toBe(differentPartition);
		expect(first).not.toContain("credential-a");
		expect(differentAuthorization).not.toContain("credential-b");
	});

	it("distinguishes undefined secret values from null and missing fields", () => {
		const cache = createProviderCache({ providerId: "typed-api" });
		const withUndefined = cache.key("profile", {
			accountId: "account-1",
			password: undefined,
		});
		const withNull = cache.key("profile", { accountId: "account-1", password: null });
		const missing = cache.key("profile", { accountId: "account-1" });

		expect(withUndefined).not.toBe(withNull);
		expect(withUndefined).not.toBe(missing);
		expect(withNull).not.toBe(missing);
		expect(() => cache.key("profile", { password: () => "secret" })).toThrow(
			"function values are unsupported",
		);
		expect(() => cache.key("profile", { password: Symbol("secret") })).toThrow(
			"symbol values are unsupported",
		);
	});

	it("rejects non-JSON-safe object secrets instead of hashing them as empty objects", () => {
		class Credential {
			readonly value = "secret";
		}

		const cache = createProviderCache({ providerId: "typed-api" });
		const unsupported = [
			new Map([["key", "value"]]),
			new Set(["value"]),
			new Date(0),
			new Credential(),
		];

		for (const password of unsupported) {
			expect(() => cache.key("profile", { password })).toThrow("non-plain objects are unsupported");
		}
	});

	it("does not expose nested secret property names in JSON-safety errors", () => {
		const cache = createProviderCache({ providerId: "typed-api" });
		const readError = () => {
			try {
				cache.key("profile", {
					serviceKey: { privateEnvelope: { hiddenCallback: () => "secret" } },
				});
			} catch (error) {
				if (!isProviderError(error)) throw error;
				return error;
			}
			throw new Error("Expected cache.key to reject the secret value");
		};

		const error = readError();
		expect(error.code).toBe("CACHE_KEY_SECRET_VALUE_UNSUPPORTED");
		expect(error.message).toContain("function values are unsupported");
		expect(error.message).toContain("serviceKey (inside secret value)");
		expect(error.message).not.toContain("privateEnvelope");
		expect(error.message).not.toContain("hiddenCallback");
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
		expect(firstPage).toBe(
			"apifuse:provider-cache:v1:paged-api:list:51e926bf708b4e4a6e6d6df175ee8e97",
		);
		expect(secondPage).toBe(
			"apifuse:provider-cache:v1:paged-api:list:f43be8b3da6fa665e05258a16dfae7ed",
		);
		expect(nextPage).toBe(
			"apifuse:provider-cache:v1:paged-api:list:cd09173fba2a3d62111fa180d22ea6a2",
		);
	});

	it("returns cache hits for stable hashed secret selectors", async () => {
		const cache = createProviderCache({ providerId: "tenant-api" });
		const firstKey = cache.key("profile", {
			accountId: "account-1",
			authorization: "Bearer tenant-secret",
		});
		const sameKey = cache.key("profile", {
			authorization: "Bearer tenant-secret",
			accountId: "account-1",
		});
		let calls = 0;

		await cache.getOrSet(
			firstKey,
			async () => {
				calls += 1;
				return { name: "Ada" };
			},
			{ ttlMs: 1_000 },
		);
		const hit = await cache.getOrSet(
			sameKey,
			async () => {
				calls += 1;
				return { name: "Grace" };
			},
			{ ttlMs: 1_000 },
		);

		expect(firstKey).toBe(sameKey);
		expect(calls).toBe(1);
		expect(hit.meta.hit).toBe(true);
		expect(hit.value).toEqual({ name: "Ada" });
	});

	it("redacts secret-scoped response metadata while preserving non-secret keys", async () => {
		const cache = createProviderCache({ providerId: "metadata-api" });
		const secretKey = cache.key("profile", {
			accountId: "account-1",
			password: "1234",
		});
		const publicKey = cache.key("catalog", { page: 2 });

		const secretResult = await cache.getOrSet(secretKey, async () => ({ private: true }), {
			ttlMs: 1_000,
		});
		await cache.getOrSet(publicKey, async () => ({ public: true }), { ttlMs: 1_000 });

		expect(secretResult.meta.key).toBe(secretKey);
		expect(cache.responseMeta()?.keys).toEqual(["[secret-scoped#1]", publicKey]);
		expect(cache.responseMeta()?.keys).not.toContain(secretKey);
	});

	it("keeps distinct secret-scoped metadata entries while deduplicating real keys", async () => {
		const cache = createProviderCache({ providerId: "metadata-api" });
		const firstKey = cache.key("profile", { password: "first" });
		const secondKey = cache.key("profile", { password: "second" });

		await cache.getOrSet(firstKey, async () => ({ value: 1 }), { ttlMs: 1_000 });
		await cache.getOrSet(secondKey, async () => ({ value: 2 }), { ttlMs: 1_000 });
		await cache.getOrSet(firstKey, async () => ({ value: 3 }), { ttlMs: 1_000 });

		expect(cache.responseMeta()?.keys).toEqual(["[secret-scoped#1]", "[secret-scoped#2]"]);
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

		const stale = await cache.getOrSet<{ temperature: number }>(
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
		}, { ttlMs: 1 });
		const second = await cache.getOrSet(key, async () => {
			calls += 1;
			return { call: calls };
		}, { ttlMs: 1 });

		expect(calls).toBe(2);
		expect(first.value).toEqual({ call: 1 });
		expect(second.value).toEqual({ call: 2 });
		expect(await cache.get(key)).toBeNull();
		expect(cache.responseMeta()?.source).toBe("loader");
	});

	it("masks and deduplicates bypass-cache secret metadata by real key", async () => {
		const cache = createBypassProviderCache({ providerId: "recording" });
		const firstKey = cache.key("fixture", { token: "first" });
		const secondKey = cache.key("fixture", { token: "second" });

		await cache.getOrSet(firstKey, async () => ({ value: 1 }), { ttlMs: 1 });
		await cache.getOrSet(secondKey, async () => ({ value: 2 }), { ttlMs: 1 });
		await cache.getOrSet(firstKey, async () => ({ value: 3 }), { ttlMs: 1 });

		expect(cache.responseMeta()?.keys).toEqual(["[secret-scoped#1]", "[secret-scoped#2]"]);
	});
});
