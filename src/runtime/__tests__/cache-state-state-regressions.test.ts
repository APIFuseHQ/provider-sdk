import { describe, expect, it } from "bun:test";
import { Redis } from "ioredis";
import {
	createMemoryProviderRuntimeState,
	createRedisProviderRuntimeState,
	getStateViolation,
	UnsupportedProviderStateError,
} from "../state.js";
import { instrumentProviderRuntimeState, StateTelemetryCollector } from "../state-telemetry.js";

const spans = { spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 };
const options = { defaultTtl: "1h", maxTtl: "1h", maxEntries: 1, maxValueBytes: 16 } as const;
let redisSequence = 0;

function redisState() {
	const calls: string[] = [];
	const redis = new Redis({ lazyConnect: true });
	redis.status = "ready";
	redis.sendCommand = async (command) => {
		calls.push(command.name);
		if (command.name === "get") return null;
		if (command.name === "eval") return [1];
		throw new Error(`Unexpected Redis command ${command.name}`);
	};
	const state = createRedisProviderRuntimeState({
		redisUrl: `redis://state-round3-${redisSequence++}`,
		__redisClient: redis,
	});
	return { state, calls };
}

describe("round-three state telemetry regressions", () => {
	it("counts successful Redis-touching operations and excludes zero-command list", async () => {
		const { state, calls } = redisState();
		const sink = new StateTelemetryCollector();
		const ns = instrumentProviderRuntimeState(state, sink).namespace("counts", options);
		for (const limit of [0, -1]) {
			expect(await ns.list({ limit })).toEqual([]);
			expect(calls).toEqual([]);
			expect(sink.toLogPayload(spans)?.redisRoundTrips).toBe(0);
		}
		for (let index = 0; index < 3; index += 1) await ns.set(`key-${index}`, "v");
		expect(calls).toEqual(["get", "eval", "get", "eval", "get", "eval"]);
		const log = sink.toLogPayload(spans)!;
		expect(String(log.redisMode)).toBe("configured");
		expect(log.redisRoundTrips).toBe(3);
		expect(String(sink.toHeaderPayload(log).redisMode)).toBe("configured");
		expect(sink.toHeaderPayload(log).redisRoundTrips).toBe(3);
		expect(log).not.toHaveProperty("configured");
	});

	it("recognizes zero-command lists without rereading caller options", async () => {
		const { state, calls } = redisState();
		const sink = new StateTelemetryCollector();
		const wrapped = instrumentProviderRuntimeState(state, sink);
		const ns = wrapped.namespace("no-op", options);
		let reads = 0;
		expect(
			await ns.list({
				get limit() {
					reads += 1;
					return 0;
				},
			}),
		).toEqual([]);
		expect(reads).toBe(1);
		expect(await wrapped.namespace("zero-capacity", { ...options, maxEntries: 0 }).list()).toEqual(
			[],
		);
		expect(calls).toEqual([]);
		expect(sink.toLogPayload(spans)?.redisRoundTrips).toBe(0);
	});

	for (const hook of ["setRedisConfigured", "record", "markTelemetryFailed"] as const) {
		for (const failure of ["throw", "reject"] as const) {
			it(`isolates ${failure} from state ${hook} with log-only failure marking`, async () => {
				const unhandled: unknown[] = [];
				const listener = (error: unknown) => unhandled.push(error);
				process.on("unhandledRejection", listener);
				try {
					const sink = new StateTelemetryCollector();
					const sentinel = new Error(`state ${hook} ${failure}`);
					const fail = () => {
						if (failure === "reject") return Promise.reject(sentinel);
						throw sentinel;
					};
					if (hook === "markTelemetryFailed") {
						const mark = sink.markTelemetryFailed.bind(sink);
						sink.markTelemetryFailed = () => {
							mark();
							return fail();
						};
						sink.record = () => {
							throw sentinel;
						};
					} else {
						sink[hook] = fail;
					}
					const state = createMemoryProviderRuntimeState();
					const original = state.namespace("observer", options);
					const expected = await original.set("key", "v");
					const observed = instrumentProviderRuntimeState(state, sink).namespace(
						"observer",
						options,
					);
					expect(await observed.get("key")).toBe(expected);
					expect(await observed.get("missing")).toBeNull();
					const log = sink.toLogPayload(spans)!;
					expect(log.telemetryFailed).toBe(true);
					expect(sink.toHeaderPayload(log)).not.toHaveProperty("telemetryFailed");
					await Bun.sleep(0);
					expect(unhandled).toEqual([]);
				} finally {
					process.off("unhandledRejection", listener);
				}
			});
		}
	}

	for (const backend of ["memory", "redis"] as const) {
		it(`classifies ${backend} violations without adding error fields`, async () => {
			const sink = new StateTelemetryCollector();
			const { state } = redisState();
			const ns = instrumentProviderRuntimeState(
				backend === "memory" ? createMemoryProviderRuntimeState() : state,
				sink,
			).namespace("errors", options);
			const ownNames = Object.getOwnPropertyNames(new UnsupportedProviderStateError());
			for (const [kind, operation] of [
				["size", () => ns.set("key", "v".repeat(100))],
				["ttl", () => ns.set("key", "v", { ttl: "2h" })],
			] as const) {
				let caught: unknown;
				try {
					await operation();
				} catch (error) {
					caught = error;
				}
				expect(caught).toBeInstanceOf(UnsupportedProviderStateError);
				expect(getStateViolation(caught)).toBe(kind);
				expect(Object.getOwnPropertyNames(caught)).toEqual(ownNames);
				expect(JSON.stringify(caught)).toBe(
					'{"options":{"code":"PROVIDER_STATE_UNSUPPORTED"},"name":"UnsupportedProviderStateError"}',
				);
			}
			const log = sink.toLogPayload(spans)!;
			expect(log.violations.size).toBe(1);
			expect(log.violations.ttl).toBe(1);
			expect(log.violations.error).toBe(0);
		});
	}
});
