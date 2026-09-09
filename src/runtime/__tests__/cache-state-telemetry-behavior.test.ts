import { Redis } from "ioredis";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createProviderCache, resetProviderCacheForTests } from "../cache.js";
import { bindCacheTelemetry, CacheTelemetryCollector } from "../cache-telemetry.js";
import { guardCacheTelemetry, type CacheTelemetrySink } from "../cache-telemetry.js";
import { createMemoryProviderRuntimeState } from "../state.js";
import { createRedisProviderRuntimeState } from "../state.js";
import { instrumentProviderRuntimeState, StateTelemetryCollector } from "../state-telemetry.js";
import { createTelemetryObserver } from "../http-telemetry-guard.js";
import { UnsupportedProviderStateError } from "../state.js";

const options = { defaultTtl: "1h", maxTtl: "1d", maxEntries: 2, maxValueBytes: 64 } as const;
afterEach(resetProviderCacheForTests);

function cacheRun(record: boolean, n: number) {
	const telemetry = record
		? new CacheTelemetryCollector({ redact: (s) => s.replace("SENTINEL12CHARS", "[REDACTED]") })
		: undefined;
	const cache = createProviderCache(
		bindCacheTelemetry({ providerId: `diff-${n}`, redisUrl: "" }, telemetry),
	);
	return { cache, telemetry };
}

describe("cache behavior differential with telemetry on/off", () => {
	it("keeps unsupported state errors byte-identical", () => {
		const error = new UnsupportedProviderStateError();
		expect(Object.getOwnPropertyNames(error)).toEqual([
			"message",
			"options",
			"name",
			"originalLine",
			"originalColumn",
			"line",
			"column",
			"sourceURL",
			"stack",
		]);
		expect(JSON.stringify(error)).toBe(
			'{"options":{"code":"PROVIDER_STATE_UNSUPPORTED"},"name":"UnsupportedProviderStateError"}',
		);
	});
	it("projects the three cache Redis modes", () => {
		const absent = new CacheTelemetryCollector();
		expect(
			absent.toLogPayload({ spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 }),
		).toBeUndefined();
		absent.recordLookup({ key: "k", hit: true, stale: false, source: "redis" });
		expect(
			String(
				absent.toLogPayload({ spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 })
					?.redisMode,
			),
		).toBe("configured");
		const degraded = new CacheTelemetryCollector();
		degraded.setRedisConfigured(true);
		degraded.recordRedisFallback();
		expect(
			String(
				degraded.toLogPayload({ spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 })
					?.redisMode,
			),
		).toBe("degraded");
	});
	it("pins hit, miss, stale, write, loader, expiry and concurrent lookup behavior", async () => {
		const outcomes: string[] = [];
		for (const record of [false, true]) {
			resetProviderCacheForTests();
			const { cache, telemetry } = cacheRun(record, 1);
			const key = cache.key("scenario", { id: "SENTINEL12CHARS" });
			const miss = await cache.get(key);
			const loaded = await cache.getOrSet(key, async () => "value", {
				ttlMs: 1,
				staleIfErrorMs: 1000,
				jitterPct: 0,
			});
			const hit = await cache.get(key);
			await new Promise((resolve) => setTimeout(resolve, 3));
			const stale = await cache.get(key);
			const concurrent = await Promise.all([
				cache.getOrSet("concurrent", async () => "same", { ttlMs: 1000, jitterPct: 0 }),
				cache.getOrSet("concurrent", async () => "different", { ttlMs: 1000, jitterPct: 0 }),
			]);
			cache.delete(key);
			expect(miss).toBeNull();
			expect(loaded.value).toBe("value");
			expect(hit?.value).toBe("value");
			expect(stale?.value).toBe("value");
			expect(concurrent.map((x) => x.value)).toEqual(["same", "same"]);
			outcomes.push(
				JSON.stringify({
					loaded: loaded.value,
					hit: hit?.value,
					stale: stale?.value,
					concurrent: concurrent.map((x) => x.value),
					responseMeta: cache.responseMeta(),
				}),
			);
			if (telemetry) {
				const log = telemetry.toLogPayload({
					spans: [],
					byName: new Map(),
					count: () => 0,
					durationMs: () => 0,
				})!;
				expect(log.lookups).toBeGreaterThanOrEqual(5);
				expect(JSON.stringify(log)).not.toContain("SENTINEL12CHARS");
				expect(log.samples[0]?.key).not.toContain("SENTINEL12CHARS");
			}
		}
		expect(outcomes[0]).toBe(outcomes[1]);
	});

	it("records loader source and write failures once while request still succeeds", async () => {
		const telemetry = new CacheTelemetryCollector();
		const cache = createProviderCache(
			bindCacheTelemetry(
				{
					providerId: "redis-down-cache",
					redisUrl: "redis://127.0.0.1:1",
				},
				telemetry,
			),
		);
		const result = await cache.getOrSet("loader-key", async () => ({ value: "ok" }), {
			ttlMs: 1000,
			jitterPct: 0,
		});
		expect(result.value).toEqual({ value: "ok" });
		const log = telemetry.toLogPayload({
			spans: [],
			byName: new Map(),
			count: () => 0,
			durationMs: () => 0,
		})!;
		expect(log.source.loader).toBe(1);
		expect(log.writes).toBe(1);
		expect(log.writeErrors).toBe(1);
		expect(log.redisFallbacks).toBeGreaterThanOrEqual(1);
		expect(String(log.redisMode)).toBe("degraded");
	});
	it("records a failed loader lookup before rethrowing the same error", async () => {
		const telemetry = new CacheTelemetryCollector();
		const cache = createProviderCache(
			bindCacheTelemetry({ providerId: "loader-error", redisUrl: "" }, telemetry),
		);
		const error = new Error("loader fail");
		let caught: unknown;
		try {
			await cache.getOrSet(
				"failure",
				async () => {
					throw error;
				},
				{ ttlMs: 1000 },
			);
		} catch (value) {
			caught = value;
		}
		expect(caught).toBe(error);
		const log = telemetry.toLogPayload({
			spans: [],
			byName: new Map(),
			count: () => 0,
			durationMs: () => 0,
		})!;
		expect(log.lookups).toBe(1);
		expect(log.misses).toBe(1);
		expect(log.loaderErrors).toBe(1);
	});
	it("records both sides of a shared in-flight load", async () => {
		for (const outcome of ["reject", "resolve"] as const) {
			resetProviderCacheForTests();
			const ownerTelemetry = new CacheTelemetryCollector();
			const followerTelemetry = new CacheTelemetryCollector();
			const owner = createProviderCache(
				bindCacheTelemetry({ providerId: `inflight-${outcome}-owner` }, ownerTelemetry),
			);
			const follower = createProviderCache(
				bindCacheTelemetry({ providerId: `inflight-${outcome}-follower` }, followerTelemetry),
			);
			let started!: () => void;
			const loaderStarted = new Promise<void>((resolve) => (started = resolve));
			let release!: () => void;
			const gate = new Promise<void>((resolve) => (release = resolve));
			const error = new Error(`inflight ${outcome}`);
			const ownerPromise = owner.getOrSet(
				"shared",
				async () => {
					started();
					await gate;
					if (outcome === "reject") throw error;
					return "shared-value";
				},
				{ ttlMs: 1000, jitterPct: 0 },
			);
			await loaderStarted;
			const followerPromise = follower.getOrSet("shared", async () => "unused", {
				ttlMs: 1000,
				jitterPct: 0,
			});
			release();
			if (outcome === "reject") {
				const [ownerError, followerError] = await Promise.all([
					ownerPromise.catch((value) => value),
					followerPromise.catch((value) => value),
				]);
				expect(ownerError).toBe(error);
				expect(followerError).toBe(error);
			} else {
				const [ownerResult, followerResult] = await Promise.all([ownerPromise, followerPromise]);
				expect(ownerResult.value).toBe("shared-value");
				expect(followerResult.value).toBe("shared-value");
			}
			const spans = { spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 };
			const ownerLog = ownerTelemetry.toLogPayload(spans)!;
			const followerLog = followerTelemetry.toLogPayload(spans)!;
			expect(ownerLog.lookups).toBe(1);
			expect(followerLog.lookups).toBe(1);
			expect(ownerLog.loaderErrors).toBe(outcome === "reject" ? 1 : 0);
			expect(followerLog.loaderErrors).toBe(outcome === "reject" ? 1 : 0);
			if (outcome === "resolve")
				expect(JSON.stringify(owner.responseMeta())).toBe(JSON.stringify(follower.responseMeta()));
		}
	});
});

describe("state behavior differential with telemetry on/off", () => {
	it("projects not-configured, configured, and degraded state modes", async () => {
		const spans = { spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 };
		const memory = new StateTelemetryCollector();
		memory.record({ op: "get", ms: 1, backend: "memory", ok: true });
		expect(String(memory.toLogPayload(spans)?.redisMode)).toBe("not_configured");
		const connected = new StateTelemetryCollector();
		connected.record({ op: "get", ms: 1, backend: "redis", ok: true });
		expect(String(connected.toLogPayload(spans)?.redisMode)).toBe("configured");
		const degraded = new StateTelemetryCollector();
		degraded.record({ op: "get", ms: 1, backend: "redis", ok: false, violation: "error" });
		expect(String(degraded.toLogPayload(spans)?.redisMode)).toBe("degraded");
		const state = instrumentProviderRuntimeState(
			createRedisProviderRuntimeState({
				redisUrl: "redis://127.0.0.1:1",
				providerId: `degraded-${Date.now()}`,
			}),
			degraded,
		);
		await expect(state.namespace("x", options).get("k")).rejects.toThrow("Redis");
		expect(String(degraded.toLogPayload(spans)?.backend)).toBe("redis");
	});

	it("pins get/set/patch/delete/cas/increment and policy errors", async () => {
		for (const record of [false, true]) {
			const telemetry = record
				? new StateTelemetryCollector({ redact: (s) => s.replace("SENTINEL12CHARS", "[REDACTED]") })
				: undefined;
			const state = instrumentProviderRuntimeState(
				createMemoryProviderRuntimeState(),
				telemetry ?? { record() {} },
			);
			const ns = state.namespace("diff", options);
			const set = await ns.set("user:SENTINEL12CHARS:profile", {
				count: 1,
				value: "SENTINEL12CHARS",
			});
			const get = await ns.get("user:SENTINEL12CHARS:profile");
			const casOk = await ns.compareAndSet("user:SENTINEL12CHARS:profile", 1, { count: 2 });
			const casConflict = await ns.compareAndSet("user:SENTINEL12CHARS:profile", 1, { count: 3 });
			await ns.delete("user:SENTINEL12CHARS:profile");
			await expect(ns.patch("x", { a: 1 })).rejects.toThrow("does not support patch");
			await expect(ns.increment("x", "a")).rejects.toThrow("does not support increment");
			await expect(ns.set("too-big", "x".repeat(100))).rejects.toThrow("maxValueBytes");
			expect(set.value.count).toBe(1);
			expect((get?.value as { count: number } | undefined)?.count).toBe(1);
			expect(casOk.ok).toBe(true);
			expect(casConflict.ok).toBe(false);
			if (telemetry) {
				const log = telemetry.toLogPayload({
					spans: [],
					byName: new Map(),
					count: () => 0,
					durationMs: () => 0,
				})!;
				expect(log.ops.set).toBeGreaterThanOrEqual(1);
				expect(log.ops.get).toBe(1);
				expect(log.ops.cas).toBe(2);
				expect(log.violations.unsupported).toBeGreaterThanOrEqual(2);
				expect(JSON.stringify(log)).not.toContain("SENTINEL12CHARS");
				expect(JSON.stringify(telemetry)).not.toContain("SENTINEL12CHARS");
			}
		}
	});
	it("classifies policy violations by error-instance side table", async () => {
		const collector = new StateTelemetryCollector();
		const ns = instrumentProviderRuntimeState(
			createMemoryProviderRuntimeState(),
			collector,
		).namespace("policy", { defaultTtl: "1h", maxTtl: "1h", maxEntries: 1, maxValueBytes: 16 });
		await ns.set("one", "ok");
		await expect(ns.set("two", "ok")).rejects.toThrow();
		await expect(ns.set("one", "x".repeat(100))).rejects.toThrow();
		await expect(ns.set("one", "ok", { ttl: "2h" })).rejects.toThrow();
		await expect(ns.patch("x", { a: 1 })).rejects.toThrow();
		const log = collector.toLogPayload({
			spans: [],
			byName: new Map(),
			count: () => 0,
			durationMs: () => 0,
		})!;
		expect(log.violations.quota).toBe(1);
		expect(log.violations.size).toBe(1);
		expect(log.violations.ttl).toBe(1);
		expect(log.violations.unsupported).toBe(1);
		collector.record({ op: "get", ms: 1, backend: "memory", ok: false, violation: "error" });
		expect(
			collector.toLogPayload({ spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 })!
				.violations.error,
		).toBe(1);
	});

	it("redacts raw state keys, records redaction failure, and bounds UTF-16", async () => {
		const seen: string[] = [];
		const collector = new StateTelemetryCollector({
			redact: (key) => {
				seen.push(key);
				if (key === "throw") throw new Error("redact");
				return key.replace("SENTINEL12CHARS", "[REDACTED]");
			},
		});
		const state = instrumentProviderRuntimeState(
			createMemoryProviderRuntimeState(),
			collector,
			(key) => {
				if (key === "throw") throw new Error("redact");
				return key.replace("SENTINEL12CHARS", "[REDACTED]");
			},
		);
		const ns = state.namespace("keys", options);
		await ns.set("user:SENTINEL12CHARS:profile", { value: "SENTINEL12CHARS" });
		await ns.get("throw").catch(() => undefined);
		const long = "x".repeat(10 * 1024 * 1024);
		await ns.get(long);
		const log = collector.toLogPayload({
			spans: [],
			byName: new Map(),
			count: () => 0,
			durationMs: () => 0,
		})!;
		expect(log.samples.find((s) => s.key.includes("REDACTED"))?.key).toBe(
			"user:[REDACTED]:profile",
		);
		expect(log.samples.some((s) => s.key === "[REDACTION_FAILED]")).toBe(true);
		expect(log.samples.every((s) => s.key.length <= 300)).toBe(true);
		expect(seen).toContain(long);
	});

	it("does not double count provider re-wrapping or namespace handles", async () => {
		const collector = new StateTelemetryCollector();
		const once = instrumentProviderRuntimeState(createMemoryProviderRuntimeState(), collector);
		const twice = instrumentProviderRuntimeState(once, collector);
		await twice.namespace("nested", options).set("key", { ok: true });
		const log = collector.toLogPayload({
			spans: [],
			byName: new Map(),
			count: () => 0,
			durationMs: () => 0,
		})!;
		expect(log.ops.set).toBe(1);
	});
});

describe("cache/state guard edge set", () => {
	it("absorbs throw, reject, never-settle, garbage, species throw and frozen returns for cache hooks", async () => {
		const edges = [
			() => {
				throw new Error("throw");
			},
			() => Promise.reject(new Error("reject")),
			() => new Promise(() => {}),
			() => 7,
			() => {
				const p = Promise.resolve();
				Object.defineProperty(p, "constructor", {
					value: class {
						static get [Symbol.species]() {
							throw new Error("species");
						}
					},
				});
				return p;
			},
			() => Object.freeze(Promise.resolve()),
		];
		for (const edge of edges) {
			let marked = 0;
			let httpMarked = 0;
			createTelemetryObserver({
				markTelemetryFailed: () => {
					httpMarked += 1;
				},
			})(edge);
			const cacheSink = guardCacheTelemetry({
				markTelemetryFailed: () => {
					marked += 1;
				},
				recordLookup: () => edge(),
				recordWrite: () => edge(),
				recordLoaderError: () => edge(),
				recordWriteError: () => edge(),
				recordRedisFallback: () => edge(),
			});
			cacheSink.recordLookup({ key: "k", hit: false, stale: false, source: "memory" });
			cacheSink.recordWrite();
			cacheSink.recordLoaderError?.();
			cacheSink.recordWriteError?.();
			cacheSink.recordRedisFallback();
			await Promise.resolve();
			expect(marked).toBe(1);
			expect(httpMarked).toBe(1);
		}
	});
});

const observerSpans = { spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 };
describe("every cache sink method is isolated", () => {
	for (const method of [
		"setRedisConfigured",
		"recordLookup",
		"recordWrite",
		"recordLoaderError",
		"recordWriteError",
		"recordRedisFallback",
		"recordRedisRoundTrip",
		"markTelemetryFailed",
	] as const) {
		for (const failure of ["throw", "reject"] as const) {
			it(`${method} ${failure}: preserves results and marks failure only in logs`, async () => {
				let unhandledRejection = 0;
				const onUnhandled = () => {
					unhandledRejection += 1;
				};
				process.on("unhandledRejection", onUnhandled);
				let redisFails = false;
				let sinkCalls = 0;
				const connect = spyOn(Redis.prototype, "connect").mockImplementation(async function (
					this: Redis,
				) {
					this.status = "ready";
				});
				const send = spyOn(Redis.prototype, "sendCommand").mockImplementation(async (command) => {
					if (redisFails) throw new Error("Redis failed");
					if (command.name === "get") return null;
					if (command.name === "set") return "OK";
					if (command.name === "del") return 0;
					throw new Error(`Unexpected Redis command ${command.name}`);
				});
				try {
					const collector = new CacheTelemetryCollector();
					const sink: CacheTelemetrySink = new Proxy(collector, {
						get(target, property) {
							if (
								property === method ||
								(method === "markTelemetryFailed" && property === "recordLookup")
							) {
								return () => {
									if (property === method) sinkCalls += 1;
									if (property === "markTelemetryFailed") target.markTelemetryFailed();
									if (failure === "throw") throw new Error("observer failed");
									return Promise.reject(new Error("observer failed"));
								};
							}
							const value = Reflect.get(target, property);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
					const cache = createProviderCache(
						bindCacheTelemetry(
							{ providerId: `guard-${method}-${failure}`, redisUrl: "redis://guard.test" },
							sink,
						),
					);
					const value = { ok: true };
					const result = await cache.getOrSet("guard-value", async () => value, { ttlMs: 1000 });
					expect(result.value).toBe(value);
					expect((await cache.get("guard-value"))?.value).toBe(value);
					const sentinel = new Error("loader failure");
					expect(
						await cache
							.getOrSet(
								"guard-error",
								async () => {
									throw sentinel;
								},
								{ ttlMs: 1000 },
							)
							.catch((error) => error),
					).toBe(sentinel);
					await cache.delete("guard-value");
					expect(await cache.get("guard-value")).toBeNull();
					redisFails = true;
					await cache.set("fallback-write", value, { ttlMs: 1000 });
					expect((await cache.get("fallback-write"))?.value).toBe(value);
					expect(await cache.get("fallback-read")).toBeNull();
					expect(sinkCalls).toBeGreaterThan(0);
					await new Promise((resolve) => setTimeout(resolve, 0));
					const log = collector.toLogPayload(observerSpans)!;
					expect(log.telemetryFailed).toBe(true);
					expect(collector.toHeaderPayload(log)).not.toHaveProperty("telemetryFailed");
					expect(unhandledRejection).toBe(0);
				} finally {
					process.off("unhandledRejection", onUnhandled);
					resetProviderCacheForTests();
					send.mockRestore();
					connect.mockRestore();
				}
			});
		}
	}
});
