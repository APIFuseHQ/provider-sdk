import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { centered, defineOperation, defineProvider } from "../define";
import { ValidationError } from "../errors";
import type { HealthCheckAssertionContext, HealthCheckCase } from "../types";

function providerWithHealthCheckInterval(interval: string) {
	return defineProvider({
		id: "test-provider",
		version: "1.0.0",
		runtime: "standard",
		meta: {
			displayName: "T",
			descriptionKey: "meta.description",
			category: "demo",
		},
		operations: {
			ping: {
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				async handler() {
					return { ok: true };
				},
				healthCheck: {
					interval: interval as never,
					cases: [
						{
							name: "x",
							input: {},
							assertions: () => {},
						},
					],
				},
			},
		},
	});
}

describe("HealthCheckCase type inference (TInput/TOutput flow)", () => {
	it("flows TOutput from operation.output schema into ctx.data", () => {
		const operation = defineOperation({
			input: z.object({ market: z.string() }),
			output: z.object({ price: z.number(), tradeId: z.string() }),
			async handler(_ctx, input) {
				return { price: 100, tradeId: input.market };
			},
			healthCheck: {
				interval: "1m",
				cases: [
					{
						name: "BTC price positive",
						input: { market: "KRW-BTC" },
						assertions: (ctx) => {
							const _typedPrice: number = ctx.data.price;
							const _typedId: string = ctx.data.tradeId;
							const _status: number = ctx.status;
							const _duration: number = ctx.durationMs;
							expect(typeof ctx.data.price).toBe("number");
						},
					},
				],
			},
		});
		expect(operation.healthCheck?.cases.length).toBe(1);
		expect(operation.healthCheck?.interval).toBe("1m");
	});

	it("rejects unknown fields on healthCheck suite with hint", () => {
		expect(() =>
			defineProvider({
				id: "test-provider",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "T",
					descriptionKey: "meta.description",
					category: "demo",
				},
				operations: {
					ping: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheck: {
							interval: "1m",
							caes: [],
							cases: [
								{
									name: "x",
									input: {},
									assertions: () => {},
								},
							],
						} as never,
					},
				},
			}),
		).toThrow(/Did you mean "cases"\?/);
	});

	it("rejects empty cases array", () => {
		expect(() =>
			defineProvider({
				id: "test-provider",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "T",
					descriptionKey: "meta.description",
					category: "demo",
				},
				operations: {
					ping: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheck: {
							interval: "1m",
							cases: [] as never,
						},
					},
				},
			}),
		).toThrow(ValidationError);
	});

	it("accepts arbitrary positive ms-style probe intervals", () => {
		const provider = defineProvider({
			id: "test-provider",
			version: "1.0.0",
			runtime: "standard",
			meta: {
				displayName: "T",
				descriptionKey: "meta.description",
				category: "demo",
			},
			operations: {
				ping: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					async handler() {
						return { ok: true };
					},
					healthCheck: {
						interval: "2m",
						cases: [
							{
								name: "x",
								input: {},
								assertions: () => {},
							},
						],
					},
				},
			},
			healthMonitor: {
				probeOverrides: {
					"test-provider/ping": { interval: "8h" },
				},
			},
		});

		expect(provider.operations.ping.healthCheck?.interval).toBe("2m");
		expect(
			provider.healthMonitor?.probeOverrides?.["test-provider/ping"]?.interval,
		).toBe("8h");
	});

	it("characterizes positive ms-style healthCheck interval validation", () => {
		const cases: Array<[string, boolean]> = [
			["1", true],
			[" 1 ", true],
			["1ms", true],
			["1 msec", true],
			["1day", true],
			["1 day", true],
			["0.5h", true],
			[".5h", true],
			["+1h", true],
			["1 hr", true],
			["1hrs", true],
			["1 secs", true],
			["1y", true],
			["1w", true],
			["0", false],
			["-1h", false],
			["1 month", false],
			["1mo", false],
			["Infinity", false],
			["1e3ms", false],
			["1.2.3s", false],
			["", false],
			["   ", false],
		];

		for (const [interval, accepted] of cases) {
			if (accepted) {
				expect(
					providerWithHealthCheckInterval(interval).operations.ping.healthCheck
						?.interval,
				).toBe(interval);
			} else {
				expect(() => providerWithHealthCheckInterval(interval)).toThrow(
					/positive ms-style duration string/,
				);
			}
		}
	});

	it("accepts operation healthCheck schedule randomization", () => {
		const provider = defineProvider({
			id: "test-provider",
			version: "1.0.0",
			runtime: "standard",
			meta: {
				displayName: "T",
				descriptionKey: "meta.description",
				category: "demo",
			},
			operations: {
				ping: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					async handler() {
						return { ok: true };
					},
					healthCheck: {
						interval: "24h",
						schedule: { randomize: centered("6h") },
						cases: [
							{
								name: "x",
								input: {},
								assertions: () => {},
							},
						],
					},
				},
			},
		});

		expect(provider.operations.ping.healthCheck?.schedule).toEqual({
			randomize: { mode: "centered", maxOffset: "PT6H" },
		});
	});

	it("uses characterized ms-style intervals when validating randomization bounds", () => {
		const provider = defineProvider({
			id: "test-provider",
			version: "1.0.0",
			runtime: "standard",
			meta: {
				displayName: "T",
				descriptionKey: "meta.description",
				category: "demo",
			},
			operations: {
				ping: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					async handler() {
						return { ok: true };
					},
					healthCheck: {
						interval: "+12h",
						schedule: { randomize: centered("6h") },
						cases: [
							{
								name: "x",
								input: {},
								assertions: () => {},
							},
						],
					},
				},
			},
		});

		expect(provider.operations.ping.healthCheck?.schedule).toEqual({
			randomize: { mode: "centered", maxOffset: "PT6H" },
		});
	});

	it("rejects operation healthCheck schedule jitter", () => {
		expect(() =>
			defineProvider({
				id: "test-provider",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "T",
					descriptionKey: "meta.description",
					category: "demo",
				},
				operations: {
					ping: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheck: {
							interval: "24h",
							schedule: { jitter: "PT20M" },
							cases: [
								{
									name: "x",
									input: {},
									assertions: () => {},
								},
							],
						} as never,
					},
				},
			}),
		).toThrow(
			/schedule\.jitter is not supported.*Use schedule\.randomize instead/,
		);
	});

	it("rejects operation healthCheck randomization duration as long as interval", () => {
		expect(() =>
			defineProvider({
				id: "test-provider",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "T",
					descriptionKey: "meta.description",
					category: "demo",
				},
				operations: {
					ping: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheck: {
							interval: "6h",
							schedule: { randomize: centered("6h") },
							cases: [
								{
									name: "x",
									input: {},
									assertions: () => {},
								},
							],
						},
					},
				},
			}),
		).toThrow(/duration must be shorter than schedule interval/);
	});

	it("accepts provider, suite, case, and runtime override policy fields", () => {
		const provider = defineProvider({
			id: "test-provider",
			version: "1.0.0",
			runtime: "standard",
			meta: {
				displayName: "T",
				descriptionKey: "meta.description",
				category: "demo",
			},
			operations: {
				ping: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					async handler() {
						return { ok: true };
					},
					healthCheck: {
						interval: "2m",
						timeoutMs: 30_000,
						degradedThresholdMs: 5_000,
						cases: [
							{
								name: "x",
								input: {},
								timeoutMs: 10_000,
								degradedThresholdMs: 2_000,
								assertions: () => {},
							},
						],
					},
				},
			},
			healthMonitor: {
				defaultProbeTimeoutMs: 45_000,
				defaultDegradedThresholdMs: 8_000,
				probeOverrides: {
					"test-provider/write-canary": {
						timeoutMs: 60_000,
						degradedThresholdMs: 10_000,
					},
				},
			},
		});

		expect(provider.healthMonitor?.defaultProbeTimeoutMs).toBe(45_000);
		expect(provider.operations.ping.healthCheck?.timeoutMs).toBe(30_000);
		expect(provider.operations.ping.healthCheck?.cases[0]?.timeoutMs).toBe(
			10_000,
		);
		expect(
			provider.healthMonitor?.probeOverrides?.["test-provider/write-canary"]
				?.timeoutMs,
		).toBe(60_000);
	});

	it("rejects invalid provider and case timeout policy fields", () => {
		expect(() =>
			defineProvider({
				id: "test-provider",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "T",
					descriptionKey: "meta.description",
					category: "demo",
				},
				operations: {
					ping: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheck: {
							interval: "1m",
							cases: [
								{
									name: "x",
									input: {},
									assertions: () => {},
								},
							],
						},
					},
				},
				healthMonitor: {
					defaultProbeTimeoutMs: 0,
				},
			}),
		).toThrow(/healthMonitor\.defaultProbeTimeoutMs/);

		expect(() =>
			defineProvider({
				id: "test-provider",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "T",
					descriptionKey: "meta.description",
					category: "demo",
				},
				operations: {
					ping: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheck: {
							interval: "1m",
							cases: [
								{
									name: "x",
									input: {},
									timeoutMs: 60_001,
									assertions: () => {},
								},
							],
						},
					},
				},
			}),
		).toThrow(/healthCheck\.cases\[0\]\.timeoutMs/);
	});

	it("rejects malformed probe interval strings", () => {
		expect(() =>
			defineProvider({
				id: "test-provider",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "T",
					descriptionKey: "meta.description",
					category: "demo",
				},
				operations: {
					ping: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheck: {
							interval: "tomorrow" as never,
							cases: [
								{
									name: "x",
									input: {},
									assertions: () => {},
								},
							],
						},
					},
				},
			}),
		).toThrow(/positive ms-style duration string/);
	});

	it("rejects healthCheck and healthCheckUnsupported declared together", () => {
		expect(() =>
			defineProvider({
				id: "test-provider",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "T",
					descriptionKey: "meta.description",
					category: "demo",
				},
				operations: {
					ping: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheck: {
							interval: "1m",
							cases: [
								{
									name: "x",
									input: {},
									assertions: () => {},
								},
							],
						},
						healthCheckUnsupported: { reason: "conflict" },
					},
				},
			}),
		).toThrow(/declares both healthCheck and healthCheckUnsupported/);
	});

	it("rejects empty reason on healthCheckUnsupported", () => {
		expect(() =>
			defineProvider({
				id: "test-provider",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "T",
					descriptionKey: "meta.description",
					category: "demo",
				},
				operations: {
					ping: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheckUnsupported: { reason: "   " },
					},
				},
			}),
		).toThrow(/reason must be a non-empty string/);
	});

	it("accepts a valid healthCheckUnsupported declaration", () => {
		const provider = defineProvider({
			id: "test-provider",
			version: "1.0.0",
			runtime: "standard",
			meta: {
				displayName: "T",
				descriptionKey: "meta.description",
				category: "demo",
			},
			operations: {
				"wipe-all": {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					async handler() {
						return { ok: true };
					},
					healthCheckUnsupported: {
						reason: "Destructive mutation; cannot probe in production",
						trackedIn: "https://example.com/issues/1",
					},
				},
			},
		});
		expect(
			provider.operations["wipe-all"]?.healthCheckUnsupported?.reason,
		).toContain("Destructive");
	});

	it("accepts provider-level healthMonitor with requiredSecrets", () => {
		const provider = defineProvider({
			id: "test-provider",
			version: "1.0.0",
			runtime: "standard",
			meta: {
				displayName: "T",
				descriptionKey: "meta.description",
				category: "demo",
			},
			operations: {
				ping: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					async handler() {
						return { ok: true };
					},
					healthCheckUnsupported: { reason: "skip for test" },
				},
			},
			healthMonitor: {
				requiredSecrets: ["APIFUSE__HEALTH_MONITOR__TEST_TOKEN"],
				probeOverrides: {
					"test-provider/auth-flow": { interval: "1h" },
				},
				serviceAccount: "sa_health_monitor_prod",
			},
		});
		expect(provider.healthMonitor?.requiredSecrets).toEqual([
			"APIFUSE__HEALTH_MONITOR__TEST_TOKEN",
		]);
		expect(
			provider.healthMonitor?.probeOverrides?.["test-provider/auth-flow"]
				?.interval,
		).toBe("1h");
	});

	it("rejects unknown field on provider healthMonitor", () => {
		expect(() =>
			defineProvider({
				id: "test-provider",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "T",
					descriptionKey: "meta.description",
					category: "demo",
				},
				operations: {
					ping: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheckUnsupported: { reason: "skip" },
					},
				},
				healthMonitor: { interval: "1m" } as never,
			}),
		).toThrow(/Unknown field "interval"/);
	});

	it("rejects invalid provider healthMonitor probe override interval", () => {
		expect(() =>
			defineProvider({
				id: "test-provider",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "T",
					descriptionKey: "meta.description",
					category: "demo",
				},
				operations: {
					ping: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheckUnsupported: { reason: "skip" },
					},
				},
				healthMonitor: {
					probeOverrides: {
						"test-provider/auth-flow": { interval: "later" },
					},
				} as never,
			}),
		).toThrow(/invalid healthMonitor\.probeOverrides/);
	});

	it("rejects duplicate case names within a suite", () => {
		expect(() =>
			defineProvider({
				id: "test-provider",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "T",
					descriptionKey: "meta.description",
					category: "demo",
				},
				operations: {
					ping: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheck: {
							interval: "1m",
							cases: [
								{
									name: "same",
									input: {},
									assertions: () => {},
								},
								{
									name: "same",
									input: {},
									assertions: () => {},
								},
							],
						},
					},
				},
			}),
		).toThrow(/duplicate case name "same"/);
	});

	it("HealthCheckCase generic shape compiles with assertions returning result", () => {
		const c: HealthCheckCase<{ q: string }, { hits: number }> = {
			name: "search returns hits",
			input: { q: "test" },
			assertions: (ctx: HealthCheckAssertionContext<{ hits: number }>) => {
				if (ctx.data.hits < 0) throw new Error("hits cannot be negative");
				return ctx.data.hits === 0
					? { status: "degraded", label: "no results" }
					: { status: "ok", label: `${ctx.data.hits} hits` };
			},
		};
		expect(c.name).toBe("search returns hits");
	});
});
