import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
	APIFUSE__CACHE__KEY_PEPPER_ENV,
	createProviderCache,
	resetProviderCacheForTests,
	withOperationCachePolicy,
} from "../runtime/cache.js";

const originalCacheKeyPepper = process.env[APIFUSE__CACHE__KEY_PEPPER_ENV];
const originalConsoleWarn = console.warn;

describe("operation cache policy", () => {
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

	it("applies the operation's declared stale window to every write and honours a per-call one with a warning", async () => {
		const warn = mock((message: unknown) => void message);
		console.warn = warn;
		let now = 1_000;
		const inner = createProviderCache({ providerId: "kma", now: () => now });
		const scoped = withOperationCachePolicy(
			inner,
			{ providerId: "kma", operationId: "forecast" },
			{ staleIfErrorMs: 1_000 },
		);
		const key = scoped.key("forecast", { nx: 60, ny: 127 });
		await scoped.getOrSet(key, async () => ({ temperature: 21 }), { ttlMs: 100 });
		now += 500;
		const stale = await scoped.getOrSet<{ temperature: number }>(
			key,
			async () => {
				throw new Error("upstream 429");
			},
			{ ttlMs: 100 },
		);
		expect(stale.value).toEqual({ temperature: 21 });
		expect(stale.meta.stale).toBe(true);
		expect(scoped.responseMeta()?.stale).toBe(true);
		expect(warn).not.toHaveBeenCalled();

		// The per-call option still wins (0 turns stale serving off for this key)
		// and is reported once per operation.
		const perCallKey = scoped.key("forecast", { nx: 61, ny: 127 });
		await scoped.set(perCallKey, { temperature: 22 }, { ttlMs: 100, staleIfErrorMs: 0 });
		now += 500;
		await expect(
			scoped.getOrSet(
				perCallKey,
				async () => {
					throw new Error("upstream 429");
				},
				{ ttlMs: 100, staleIfErrorMs: 0 },
			),
		).rejects.toThrow("upstream 429");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			'[provider-sdk] Operation "kma.forecast" passes staleIfErrorMs to ctx.cache; declare it once as cache: { staleIfErrorMs: 0 } on the operation so the SDK applies it to every cache write and attaches the health freshness guard. The per-call option is removed in the next minor.',
		);
	});

	it("leaves an operation without a cache policy on the per-call options", async () => {
		const warn = mock((message: unknown) => void message);
		console.warn = warn;
		let now = 1_000;
		const inner = createProviderCache({ providerId: "kma", now: () => now });
		const scoped = withOperationCachePolicy(
			inner,
			{ providerId: "kma", operationId: "forecast" },
			undefined,
		);
		const key = scoped.key("forecast", { nx: 60, ny: 127 });
		await scoped.getOrSet(key, async () => ({ temperature: 21 }), { ttlMs: 100 });
		now += 500;
		await expect(
			scoped.getOrSet(
				key,
				async () => {
					throw new Error("upstream 429");
				},
				{ ttlMs: 100 },
			),
		).rejects.toThrow("upstream 429");
		expect(warn).not.toHaveBeenCalled();
	});
});
