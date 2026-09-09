import { describe, expect, test } from "bun:test";
import { createProviderCache, type ProviderCacheOptions } from "../cache.js";
import { bindCacheTelemetry, CacheTelemetryCollector } from "../cache-telemetry.js";
import { RequestTelemetry } from "../request-telemetry.js";

const emptySpans = {
	spans: [],
	byName: new Map(),
	count: () => 0,
	durationMs: () => 0,
};
import { createMemoryProviderRuntimeState } from "../state.js";
import { instrumentProviderRuntimeState, StateTelemetryCollector } from "../state-telemetry.js";
import { createTraceContext } from "../trace.js";

describe("cache and state telemetry contributors", () => {
	test("binds telemetry internally while preserving the public cache options", async () => {
		const publicKeys: Record<keyof ProviderCacheOptions, true> = {
			providerId: true,
			redisUrl: true,
			memoryMaxEntries: true,
			now: true,
		};
		expect(Object.keys(publicKeys)).toEqual(["providerId", "redisUrl", "memoryMaxEntries", "now"]);
		const options = { providerId: "binding", redisUrl: "" };
		const collector = new CacheTelemetryCollector();
		expect(bindCacheTelemetry(options, collector)).toBe(options);
		expect(Reflect.ownKeys(options)).toEqual(["providerId", "redisUrl"]);
		await createProviderCache(options).get("binding-miss");
		expect(collector.toLogPayload(emptySpans)?.lookups).toBe(1);
	});
	test("reduces cache lookups and redacts log-only keys while keeping header ingestible", async () => {
		const cacheTelemetry = new CacheTelemetryCollector({
			redact: (text) => text.replace("secret", "[REDACTED]"),
		});
		const cache = createProviderCache(
			bindCacheTelemetry(
				{
					providerId: "telemetry",
					redisUrl: "",
				},
				cacheTelemetry,
			),
		);
		const key = cache.key("lookup", { secret: "secret-value" });
		await cache.getOrSet(key, async () => ({ ok: true }), { ttlMs: 1_000 });
		const log = cacheTelemetry.toLogPayload(emptySpans)!;
		expect(log.lookups).toBe(1);
		expect(log.writes).toBe(1);
		expect(log.samples[0]?.key).not.toContain("secret-value");
		const telemetry = new RequestTelemetry(createTraceContext());
		telemetry.register(cacheTelemetry);
		expect(telemetry.toHeaderValue()).toBeDefined();
	});

	test("observes state operation outcomes and redacts keys without changing behavior", async () => {
		const stateTelemetry = new StateTelemetryCollector({
			redact: (text) => text.replace("token", "[REDACTED]"),
		});
		const state = instrumentProviderRuntimeState(
			createMemoryProviderRuntimeState(),
			stateTelemetry,
			(text) => text.replace("token", "[REDACTED]"),
		);
		const namespace = state.forConnection("connection").namespace("test", {
			defaultTtl: "1h",
			maxTtl: "1d",
			maxEntries: 2,
			maxValueBytes: 1024,
		});
		await namespace.set("token-key", { ok: true });
		expect((await namespace.get("token-key"))?.value).toEqual({ ok: true });
		const log = stateTelemetry.toLogPayload(emptySpans)!;
		expect(log.ops.set).toBe(1);
		expect(log.ops.get).toBe(1);
		expect(log.samples[0]?.key).toContain("[REDACTED]");
	});
});
