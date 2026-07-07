import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { defineProvider } from "../define";
import { ProviderError, ValidationError } from "../errors";
import type { ProviderContext } from "../types";

const InputSchema = z.object({ id: z.string() });
const OutputSchema = z.object({ name: z.string(), price: z.number() });

const validConfig = {
	id: "korea-air-quality",
	version: "1.0.0",
	runtime: "standard" as const,
	meta: {
		displayName: "AirKorea Realtime",
		descriptionKey: "meta.description",
		category: "finance",
		tags: ["prices"],
	},
	operations: {
		prices: {
			input: InputSchema,
			output: OutputSchema,
			handler: async (_ctx: ProviderContext, input: unknown) => {
				const parsed = InputSchema.parse(input);

				return {
					name: parsed.id,
					price: 50_000,
				};
			},
			fixtures: {
				request: { id: "bitcoin" },
				response: { name: "Bitcoin", price: 50_000 },
			},
			healthCheckUnsupported: {
				reason: "test fixture",
			},
		},
	},
};

describe("defineProvider", () => {
	it("accepts operation contract metadata", () => {
		const provider = defineProvider({
			...validConfig,
			operations: {
				prices: {
					...validConfig.operations.prices,
					contract: { version: "1.1.0", lifecycle: "beta" as const },
				},
			},
		});

		expect(provider.operations.prices.contract?.version).toBe("1.1.0");
	});

	it("accepts additive operation transport metadata", () => {
		const provider = defineProvider({
			...validConfig,
			operations: {
				prices: {
					...validConfig.operations.prices,
					transport: {
						kind: "sse",
						heartbeatMs: 10_000,
						idleTimeoutMs: 30_000,
						maxDurationMs: 120_000,
						resumable: "last-event-id",
						events: {
							delta: z.object({ id: z.string(), value: z.number() }),
						},
					},
				},
			},
		});

		expect(provider.operations.prices.transport?.kind).toBe("sse");
	});

	it("keeps transport optional for existing JSON operations", () => {
		const provider = defineProvider(validConfig);

		expect(provider.operations.prices.transport).toBeUndefined();
	});

	it("accepts native TCP egress metadata", () => {
		const provider = defineProvider({
			...validConfig,
			native: {
				network: {
					tcp: [
						{ host: "talk.kakao.com", ports: [5228, 5229], tls: "required" },
					],
				},
			},
		});

		expect(provider.native?.network?.tcp?.[0]).toEqual({
			host: "talk.kakao.com",
			ports: [5228, 5229],
			tls: "required",
		});
	});

	it("rejects malformed native TCP egress metadata", () => {
		const cases = [
			{ host: "", ports: [5228], tls: "required" },
			{ host: "*.example.com", ports: [5228], tls: "required" },
			{ host: "example.com", ports: [], tls: "required" },
			{ host: "example.com", ports: [0], tls: "required" },
			{ host: "example.com", ports: [65536], tls: "required" },
			{ host: "example.com", ports: [5228], tls: "maybe" },
		];

		for (const rule of cases) {
			expect(() =>
				defineProvider({
					...validConfig,
					native: {
						network: {
							tcp: [rule],
						},
					},
				} as never),
			).toThrow(ValidationError);
		}
	});

	it("rejects invalid operation transport metadata", () => {
		expect(() =>
			defineProvider({
				...validConfig,
				operations: {
					prices: {
						...validConfig.operations.prices,
						transport: {
							kind: "sse",
							heartbeatMs: 0,
						} as never,
					},
				},
			}),
		).toThrow(ValidationError);
	});

	it("rejects SSE transport without declared event schemas", () => {
		expect(() =>
			defineProvider({
				...validConfig,
				operations: {
					prices: {
						...validConfig.operations.prices,
						transport: {
							kind: "sse",
						} as never,
					},
				},
			}),
		).toThrow(ValidationError);
	});

	it("rejects SSE transport with an empty event schema map", () => {
		expect(() =>
			defineProvider({
				...validConfig,
				operations: {
					prices: {
						...validConfig.operations.prices,
						transport: {
							kind: "sse",
							events: {},
						},
					},
				},
			}),
		).toThrow(ValidationError);
	});

	it("requires websocket dispatch to be explicitly unsupported", () => {
		expect(() =>
			defineProvider({
				...validConfig,
				operations: {
					prices: {
						...validConfig.operations.prices,
						transport: {
							kind: "websocket",
						} as never,
					},
				},
			}),
		).toThrow(ValidationError);
	});

	it("rejects websocket dispatch before gateway-managed sessions", () => {
		expect(() =>
			defineProvider({
				...validConfig,
				operations: {
					prices: {
						...validConfig.operations.prices,
						transport: {
							kind: "websocket",
							dispatch: "raw-tunnel",
						} as never,
					},
				},
			}),
		).toThrow(ValidationError);
	});

	it("rejects deprecated operation contract metadata without migration guidance", () => {
		expect(() =>
			defineProvider({
				...validConfig,
				operations: {
					prices: {
						...validConfig.operations.prices,
						contract: { lifecycle: "deprecated" as const },
					},
				},
			}),
		).toThrow(ValidationError);
	});

	it("returns provider with top-level identity fields accessible", () => {
		const provider = defineProvider(validConfig);

		expect(provider.id).toBe("korea-air-quality");
		expect(provider.version).toBe("1.0.0");
		expect(provider.runtime).toBe("standard");
		expect(provider.meta.displayName).toBe("AirKorea Realtime");
	});

	it("accepts provider-level Early Access visibility metadata", () => {
		const provider = defineProvider({
			...validConfig,
			access: { visibility: "early_access" },
		});

		expect(provider.access?.visibility).toBe("early_access");
	});

	it("rejects invalid provider-level visibility metadata", () => {
		expect(() =>
			defineProvider({
				...validConfig,
				access: { visibility: "private_beta" as "public" },
			}),
		).toThrow(ProviderError);
	});

	it("preserves operation definitions", async () => {
		const provider = defineProvider(validConfig);
		await expect(
			provider.operations.prices.handler?.({} as never, { id: "bitcoin" }),
		).resolves.toEqual({ name: "bitcoin", price: 50_000 });
	});

	it("throws ProviderError for invalid id format - uppercase", () => {
		expect(() =>
			defineProvider({
				...validConfig,
				id: "AirKoreaRealtime",
			}),
		).toThrow(ProviderError);
	});

	it("throws ProviderError for invalid id format - single word", () => {
		expect(() =>
			defineProvider({ ...validConfig, id: "weather" }),
		).not.toThrow();
	});

	it("throws ProviderError for invalid id format - spaces", () => {
		expect(() =>
			defineProvider({
				...validConfig,
				id: "weather api",
			}),
		).toThrow(ProviderError);
	});

	it("throws ProviderError for invalid id format - underscore", () => {
		expect(() =>
			defineProvider({
				...validConfig,
				id: "weather_api",
			}),
		).toThrow(ProviderError);
	});

	it("throws ValidationError when operation fixture.request does not match input schema", () => {
		const badConfig = {
			...validConfig,
			operations: {
				...validConfig.operations,
				prices: {
					...validConfig.operations.prices,
					fixtures: {
						request: { wrong_field: "x" } as unknown as z.infer<
							typeof InputSchema
						>,
						response: validConfig.operations.prices.fixtures.response,
					},
				},
			},
		};

		expect(() => defineProvider(badConfig)).toThrow(ValidationError);
	});

	it("throws ValidationError when operation fixture.response does not match output schema", () => {
		const badConfig = {
			...validConfig,
			operations: {
				...validConfig.operations,
				prices: {
					...validConfig.operations.prices,
					fixtures: {
						request: validConfig.operations.prices.fixtures.request,
						response: { wrong: true } as unknown as z.infer<
							typeof OutputSchema
						>,
					},
				},
			},
		};

		expect(() => defineProvider(badConfig)).toThrow(ValidationError);
	});

	it("ValidationError includes zodError for actionable debugging", () => {
		const badConfig = {
			...validConfig,
			operations: {
				...validConfig.operations,
				prices: {
					...validConfig.operations.prices,
					fixtures: {
						request: { wrong_field: "x" } as unknown as z.infer<
							typeof InputSchema
						>,
						response: validConfig.operations.prices.fixtures.response,
					},
				},
			},
		};

		try {
			defineProvider(badConfig);
		} catch (error) {
			expect(error instanceof ValidationError).toBe(true);
			expect((error as ValidationError).zodError).toBeDefined();
		}
	});

	it("ProviderError has fix hint for invalid id", () => {
		try {
			defineProvider({ ...validConfig, id: "BAD_ID" });
		} catch (error) {
			expect(error instanceof ProviderError).toBe(true);
			expect((error as ProviderError).fix).toBeDefined();
		}
	});

	it("throws ProviderError when no operations defined", () => {
		expect(() => defineProvider({ ...validConfig, operations: {} })).toThrow(
			ProviderError,
		);
	});

	it("works without operation fixtures", () => {
		const noFixturesConfig = {
			...validConfig,
			operations: {
				...validConfig.operations,
				prices: {
					...validConfig.operations.prices,
					fixtures: undefined,
				},
			},
		};

		const provider = defineProvider(noFixturesConfig);

		expect(provider.id).toBe("korea-air-quality");
		expect(provider.operations.prices.fixtures).toBeUndefined();
	});

	it("requires browser config when runtime is browser", () => {
		expect(() =>
			defineProvider({
				...validConfig,
				runtime: "browser",
			}),
		).toThrow(ProviderError);
	});

	it("rejects browser config when runtime is not browser", () => {
		expect(() =>
			defineProvider({
				...validConfig,
				browser: { engine: "nodriver" },
			}),
		).toThrow(ProviderError);
	});

	it("keeps operation schema inference usable for input parsing", () => {
		const provider = defineProvider(validConfig);
		const parsed = provider.operations.prices.input?.safeParse({
			id: "bitcoin",
		});

		expect(parsed?.success).toBe(true);
	});

	it("keeps operation schema inference usable for output parsing", () => {
		const provider = defineProvider(validConfig);
		const parsed = provider.operations.prices.output?.safeParse({
			name: "Bitcoin",
			price: 50_000,
		});

		expect(parsed?.success).toBe(true);
	});

	describe("annotations.timeoutMs validation", () => {
		const withAnnotations = (annotations: unknown) => ({
			...validConfig,
			operations: {
				prices: {
					...validConfig.operations.prices,
					annotations,
				},
			},
		});

		it("accepts a valid integer in [1, 60000] ms", () => {
			const provider = defineProvider(
				withAnnotations({ readOnly: true, timeoutMs: 30_000 }),
			);
			expect(provider.operations.prices.annotations?.timeoutMs).toBe(30_000);
		});

		it("accepts annotations without timeoutMs", () => {
			expect(() =>
				defineProvider(withAnnotations({ readOnly: true })),
			).not.toThrow();
		});

		it("accepts a provider with no annotations block", () => {
			expect(() => defineProvider(validConfig)).not.toThrow();
		});

		it("rejects timeoutMs of 0 (lower bound exclusive)", () => {
			expect(() => defineProvider(withAnnotations({ timeoutMs: 0 }))).toThrow(
				ValidationError,
			);
		});

		it("rejects negative timeoutMs", () => {
			expect(() =>
				defineProvider(withAnnotations({ timeoutMs: -100 })),
			).toThrow(ValidationError);
		});

		it("rejects timeoutMs above 60000 ms (upper bound)", () => {
			expect(() =>
				defineProvider(withAnnotations({ timeoutMs: 60_001 })),
			).toThrow(ValidationError);
		});

		it("rejects non-integer timeoutMs", () => {
			expect(() =>
				defineProvider(withAnnotations({ timeoutMs: 1500.5 })),
			).toThrow(ValidationError);
		});

		it("rejects non-number timeoutMs", () => {
			expect(() =>
				defineProvider(
					withAnnotations({
						timeoutMs: "30000" as unknown as number,
					}),
				),
			).toThrow(ValidationError);
		});
	});
});
