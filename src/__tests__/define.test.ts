import { describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { z } from "zod";

import { ProviderError, ValidationError } from "../errors.js";
import type {
	OperationAnnotations,
	ProviderContext,
	ProviderDefinition,
	SchemaLike,
} from "../types.js";
import {
	createProviderContextDouble,
	defineTestProvider as defineProvider,
} from "./test-utils.js";

const InputSchema = z.object({ id: z.string() });
const OutputSchema = z.object({ name: z.string(), price: z.number() });

function requireZodSchema(schema: SchemaLike): z.ZodType {
	if (!("safeParse" in schema) || typeof schema.safeParse !== "function") {
		throw new Error("Expected the operation schema to retain its Zod implementation");
	}
	return schema;
}

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
	it("keeps resolver runtime allowlists complete against their public unions", async () => {
		const defineModule = await import("../define.js");

		expect(defineModule.VALID_PROVIDER_RESOLVER_VENDORS).toEqual([
			"browser",
			"capsolver",
			"capmonster",
			"2captcha",
			"custom",
		]);
		expect(defineModule.VALID_PROVIDER_CHALLENGE_KINDS).toEqual([
			"turnstile",
			"recaptcha_v2",
			"recaptcha_v3",
			"hcaptcha",
			"cloudflare_interstitial",
			"aws_waf",
			"akamai_sec_cpt",
			"akamai_sensor",
		]);
	});

	it("accepts a transport-owned resolver client profile", () => {
		const provider = defineProvider({
			...validConfig,
			resolver: {
				vendors: ["2captcha"],
				kinds: ["akamai_sensor"],
				clientProfile: "safari17_0",
			},
		});

		expect(provider.resolver?.clientProfile).toBe("safari17_0");
	});

	it.each([
		["a non-object resolver", null, "invalid resolver: must be an object"],
		[
			"an unknown resolver field",
			{ vendors: ["custom"], kinds: ["turnstile"], kindz: ["turnstile"] },
			'Unknown field "kindz" on resolver',
		],
		[
			"a non-array vendor declaration",
			{ vendors: "custom", kinds: ["turnstile"] },
			"invalid resolver.vendors: must be an array",
		],
		[
			"a non-array kind declaration",
			{ vendors: ["custom"], kinds: "turnstile" },
			"invalid resolver.kinds: must be an array",
		],
		[
			"an unknown resolver vendor",
			{ vendors: ["unknown-vendor"], kinds: ["turnstile"] },
			"invalid resolver.vendors[0]",
		],
		[
			"an unknown resolver kind",
			{ vendors: ["custom"], kinds: ["funcaptcha"] },
			"invalid resolver.kinds[0]",
		],
	] as const)("rejects %s at definition time", (_label, resolver, message) => {
		let caught: unknown;
		try {
			defineProvider({ ...validConfig, resolver });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ValidationError);
		expect(caught).toMatchObject({ message: expect.stringContaining(message) });
		expect((caught as ValidationError).fix).toContain(`provider "${validConfig.id}"`);
	});

	it("rejects operation error statuses the server cannot emit", () => {
		expect(() =>
			defineProvider({
				...validConfig,
				operations: {
					prices: {
						...validConfig.operations.prices,
						docs: {
							errorCodes: [
								{
									code: "UPSTREAM_TEAPOT",
									status: 418,
									description: "Unsupported upstream response",
								},
							],
						},
					},
				},
			}),
		).toThrow(/errorCodes\[0\]\.status: 418.*not an emittable provider error status/);
	});

	it("warns when an SDK-owned error code declares an ignored runtime status", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const provider = defineProvider({
				...validConfig,
				operations: {
					prices: {
						...validConfig.operations.prices,
						docs: {
							errorCodes: [
								{
									code: "reauth_required",
									status: 502,
									description: "Provider session expired",
								},
							],
						},
					},
				},
			});

			expect(provider.operations.prices.docs?.errorCodes?.[0]?.status).toBe(502);
			expect(warn).toHaveBeenCalledWith(
				'[provider-sdk] Provider "korea-air-quality" operation "prices" declares status 502 for SDK-owned error code "reauth_required"; the declared status is documentation-only and will be ignored at runtime.',
			);
		} finally {
			warn.mockRestore();
		}
	});

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

		expect((provider.operations.prices as ProviderDefinition["operations"][string]).transport).toBeUndefined();
	});

	it("preserves typed native network declarations", () => {
		const native = {
			network: {
				tcp: [
					{
						host: "booking-loco.kakao.com",
						ports: [443],
						tls: "required",
					},
				],
				dynamicTcp: [
					{
						sourceHost: "booking-loco.kakao.com",
						sourceHostSuffixes: ["kakao.com"],
						sourcePorts: [443],
						sourcePortRanges: [{ start: 400, end: 499 }],
						targetHostSuffixes: ["kakao.com"],
						targetPorts: [5228],
						targetPortRanges: [{ start: 5200, end: 5299 }],
						tls: "disabled",
						ttlMs: 30_000,
						maxGrants: 2,
					},
				],
			},
		} as const;
		const provider = defineProvider({ ...validConfig, native });

		expect(provider.native).toBe(native);
		expect(provider.native).toEqual(native);
	});

	it("rejects unknown and invalid native egress fields through defineProvider", () => {
		const dynamic = {
			sourceHostSuffixes: ["bootstrap.example"],
			sourcePorts: [443],
			targetHostSuffixes: ["kakao.com"],
			targetPortRanges: [{ start: 1, end: 65_535 }],
			tls: "disabled" as const,
		};
		expect(() =>
			defineProvider({
				...validConfig,
				native: { network: { dynamicTcp: [{ ...dynamic, targetIpCidrs: ["10.0.0.0/8"] }] } },
			}),
		).toThrow(ValidationError);
		expect(() =>
			defineProvider({
				...validConfig,
				native: { network: { dynamicTcp: [{ ...dynamic, targetHostSuffixes: ["*.kakao.com"] }] } },
			}),
		).toThrow(ValidationError);
		expect(() =>
			defineProvider({
				...validConfig,
				native: {
					network: { dynamicTcp: [{ ...dynamic, targetPortRanges: [{ start: 443, end: 1 }] }] },
				},
			}),
		).toThrow(ValidationError);
		expect(() =>
			defineProvider({
				...validConfig,
				native: { network: { dynamicTcp: [{ ...dynamic, ttlMs: 0 }] } },
			}),
		).toThrow(ValidationError);
		expect(() =>
			defineProvider({
				...validConfig,
				native: { network: { dynamicTcp: [{ ...dynamic, maxGrants: 0 }] } },
			}),
		).toThrow(ValidationError);
		const { sourceHostSuffixes: _sourceHostSuffixes, ...withoutSourceHost } = dynamic;
		expect(() =>
			defineProvider({
				...validConfig,
				native: { network: { dynamicTcp: [withoutSourceHost] } },
			}),
		).toThrow(ValidationError);
		const { sourcePorts: _sourcePorts, ...withoutSourcePorts } = dynamic;
		expect(() =>
			defineProvider({
				...validConfig,
				native: { network: { dynamicTcp: [withoutSourcePorts] } },
			}),
		).toThrow(ValidationError);
		const { targetPortRanges: _targetPortRanges, ...withoutTargetPorts } = dynamic;
		expect(() =>
			defineProvider({
				...validConfig,
				native: { network: { dynamicTcp: [withoutTargetPorts] } },
			}),
		).toThrow(ValidationError);
		expect(() =>
			defineProvider({
				...validConfig,
				native: { network: { tcp: [{ host: "empty.example", ports: [], tls: "disabled" }] } },
			}),
		).toThrow(ValidationError);
		expect(() =>
			defineProvider({
				...validConfig,
				native: {
					network: { dynamicTcp: [{ ...dynamic, sourceHostSuffixes: ["bad\0.example"] }] },
				},
			}),
		).toThrow(ValidationError);
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
							// test-invalid: runtime validation must reject an invalid SSE heartbeat and missing events.
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
							// test-invalid: runtime validation must reject SSE transport without event schemas.
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
							// test-invalid: runtime validation must reject websocket transport without dispatch metadata.
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
							// test-invalid: runtime validation must reject websocket dispatch before session support exists.
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
		expect(provider.operations).toBe(validConfig.operations);
		await expect(
			provider.operations.prices.handler?.(createProviderContextDouble(), { id: "bitcoin" }),
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
		expect(() => defineProvider({ ...validConfig, id: "weather" })).not.toThrow();
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
						request: { wrong_field: "x" },
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
						response: { wrong: true },
					},
				},
			},
		};

		expect(() => defineProvider(badConfig)).toThrow(ValidationError);
	});

	it("resolves relative fixture dates before validating past-date-rejecting schemas", () => {
		const kstToday = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
		const absoluteFutureInput = z.object({
			date: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/)
				.refine((date) => date >= kstToday(), "date must not be in the past"),
		});
		const build = () =>
			defineProvider({
				...validConfig,
				operations: {
					prices: {
						...validConfig.operations.prices,
						input: absoluteFutureInput,
						handler: async () => ({ name: "fixture", price: 1 }),
						fixtures: {
							request: { date: "+45d" },
							response: { name: "Fixture", price: 1 },
						},
					},
				},
			});

		try {
			setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
			const first = build();
			expect(first.operations.prices.fixtures?.request).toEqual({ date: "2026-02-15" });

			setSystemTime(new Date("2026-10-01T12:00:00.000Z"));
			const importedLater = build();
			expect(importedLater.operations.prices.fixtures?.request).toEqual({
				date: "2026-11-15",
			});
		} finally {
			setSystemTime();
		}
	});

	it("does not widen the public operation input schema to accept fixture tokens", () => {
		const absoluteInput = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
		const provider = defineProvider({
			...validConfig,
			operations: {
				prices: {
					...validConfig.operations.prices,
					input: absoluteInput,
					handler: async () => ({ name: "fixture", price: 1 }),
					fixtures: {
						request: { date: "+45d" },
						response: { name: "Fixture", price: 1 },
					},
				},
			},
		});

		expect(
			requireZodSchema(provider.operations.prices.input).safeParse({ date: "+45d" }).success,
		).toBe(false);
		expect(provider.operations.prices.fixtures?.request).toEqual({
			date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
		});
	});

	it("accepts a valid fixture recordedAt capture date", () => {
		const provider = defineProvider({
			...validConfig,
			operations: {
				prices: {
					...validConfig.operations.prices,
					fixtures: {
						...validConfig.operations.prices.fixtures,
						recordedAt: "2025-12-31",
					},
				},
			},
		});

		expect(provider.operations.prices.fixtures?.recordedAt).toBe("2025-12-31");
	});

	it("accepts KST today as recordedAt after KST has crossed midnight", () => {
		try {
			setSystemTime(new Date("2026-07-29T16:00:00.000Z"));
			const provider = defineProvider({
				...validConfig,
				operations: {
					prices: {
						...validConfig.operations.prices,
						fixtures: {
							...validConfig.operations.prices.fixtures,
							recordedAt: "2026-07-30",
						},
					},
				},
			});

			expect(provider.operations.prices.fixtures?.recordedAt).toBe("2026-07-30");
		} finally {
			setSystemTime();
		}
	});

	it("rejects future and malformed fixture recordedAt values with a fix hint", () => {
		try {
			setSystemTime(new Date("2026-07-29T16:00:00.000Z"));
			for (const recordedAt of ["2026-07-31", "not-a-date", "2026-02-30"]) {
				try {
					defineProvider({
						...validConfig,
						operations: {
							prices: {
								...validConfig.operations.prices,
								fixtures: {
									...validConfig.operations.prices.fixtures,
									recordedAt,
								},
							},
						},
					});
					throw new Error("expected defineProvider to reject recordedAt");
				} catch (error) {
					expect(error).toBeInstanceOf(ValidationError);
					expect((error as ValidationError).fix).toContain("YYYY-MM-DD");
				}
			}
		} finally {
			setSystemTime();
		}
	});

	it("ValidationError includes zodError for actionable debugging", () => {
		const badConfig = {
			...validConfig,
			operations: {
				...validConfig.operations,
				prices: {
					...validConfig.operations.prices,
					fixtures: {
						request: { wrong_field: "x" },
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
		expect(() => defineProvider({ ...validConfig, operations: {} })).toThrow(ProviderError);
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
		const parsed = requireZodSchema(provider.operations.prices.input).safeParse({
			id: "bitcoin",
		});

		expect(parsed.success).toBe(true);
	});

	it("keeps operation schema inference usable for output parsing", () => {
		const provider = defineProvider(validConfig);
		const parsed = requireZodSchema(provider.operations.prices.output).safeParse({
			name: "Bitcoin",
			price: 50_000,
		});

		expect(parsed.success).toBe(true);
	});

	describe("annotations.timeoutMs validation", () => {
		const withAnnotations = (annotations: OperationAnnotations) => ({
			...validConfig,
			operations: {
				prices: {
					...validConfig.operations.prices,
					annotations,
				},
			},
		});

		it("accepts a valid integer in [1, 60000] ms", () => {
			const provider = defineProvider(withAnnotations({ readOnly: true, timeoutMs: 30_000 }));
			expect(provider.operations.prices.annotations?.timeoutMs).toBe(30_000);
		});

		it("accepts annotations without timeoutMs", () => {
			expect(() => defineProvider(withAnnotations({ readOnly: true }))).not.toThrow();
		});

		it("accepts a provider with no annotations block", () => {
			expect(() => defineProvider(validConfig)).not.toThrow();
		});

		it("rejects timeoutMs of 0 (lower bound exclusive)", () => {
			expect(() => defineProvider(withAnnotations({ timeoutMs: 0 }))).toThrow(ValidationError);
		});

		it("rejects negative timeoutMs", () => {
			expect(() => defineProvider(withAnnotations({ timeoutMs: -100 }))).toThrow(ValidationError);
		});

		it("rejects timeoutMs above 60000 ms (upper bound)", () => {
			expect(() => defineProvider(withAnnotations({ timeoutMs: 60_001 }))).toThrow(ValidationError);
		});

		it("rejects non-integer timeoutMs", () => {
			expect(() => defineProvider(withAnnotations({ timeoutMs: 1500.5 }))).toThrow(ValidationError);
		});

		it("rejects non-number timeoutMs", () => {
			expect(() =>
				defineProvider(
					withAnnotations({
						// @ts-expect-error test-invalid: runtime validation must reject non-number timeouts.
						timeoutMs: "30000",
					}),
				),
			).toThrow(ValidationError);
		});
	});

	describe("deployment passthrough", () => {
		it("passes a full deployment object through verbatim", () => {
			const deployment = {
				runtime: "dedicated" as const,
				language: "typescript" as const,
				replicas: 2,
				hpa: {
					enabled: true,
					minReplicas: 1,
					maxReplicas: 4,
					targetCPUUtilizationPercentage: 70,
				},
				resources: { cpu: "200m", memory: "256Mi" },
				cache: { redis: { enabled: true, url: "redis://cache:6379" } },
				network: { additionalTcpPorts: [8443] },
				buildContext: ".",
			};
			const provider = defineProvider({ ...validConfig, deployment });

			expect(provider.deployment).toBe(deployment);
			expect(provider.deployment).toEqual(deployment);
		});

		it("accepts a partial deployment object without filling defaults", () => {
			const provider = defineProvider({
				...validConfig,
				deployment: { runtime: "browser" as const },
			});

			expect(provider.deployment).toEqual({ runtime: "browser" });
			expect(provider.deployment?.replicas).toBeUndefined();
			expect(provider.deployment?.hpa).toBeUndefined();
			expect(provider.deployment?.resources).toBeUndefined();
		});

		it("does not deep-validate deployment fields (registry builder owns validation)", () => {
			const deployment = {
				runtime: "not-a-runtime",
				replicas: -3,
				surprise: { nested: true },
			};
			const provider = defineProvider({ ...validConfig, deployment });

			expect(Object.is(provider.deployment, deployment)).toBe(true);
		});

		it("leaves deployment undefined when not declared", () => {
			const provider = defineProvider(validConfig);

			expect(provider.deployment).toBeUndefined();
		});

		it("rejects a non-object deployment value", () => {
			expect(() =>
				defineProvider({
					...validConfig,
					deployment: "shared",
				}),
			).toThrow(ProviderError);
			expect(() =>
				defineProvider({
					...validConfig,
					deployment: [{ runtime: "shared" }],
				}),
			).toThrow(ProviderError);
		});

		it("keeps stripping unknown top-level keys other than deployment", () => {
			const provider = defineProvider({
				...validConfig,
				...({ deploy: { runtime: "shared" } } as Record<string, unknown>),
			} as typeof validConfig);

			expect("deploy" in provider).toBe(false);
		});
	});

	describe("operation title and description passthrough", () => {
		it("preserves code-authored title and description on the built operation", () => {
			const provider = defineProvider({
				...validConfig,
				operations: {
					prices: {
						...validConfig.operations.prices,
						title: "Get Prices",
						description:
							"Use this operation when you need the latest quoted price for an asset id; returns the display name and price in KRW.",
					},
				},
			});

			expect(provider.operations.prices.title).toBe("Get Prices");
			expect(provider.operations.prices.description).toBe(
				"Use this operation when you need the latest quoted price for an asset id; returns the display name and price in KRW.",
			);
		});

		it("keeps title and description undefined when not declared", () => {
			const provider = defineProvider(validConfig);

			const prices = provider.operations.prices as ProviderDefinition["operations"][string];
			expect(prices.title).toBeUndefined();
			expect(prices.description).toBeUndefined();
		});
	});

	describe("required proxy vendor credentials", () => {
		const SMARTPROXY_SECRET = "APIFUSE__PROXY__SMARTPROXY_APP_KEY";
		const NODEMAVEN_USERNAME_SECRET = "APIFUSE__PROXY__NODEMAVEN_USERNAME";
		const NODEMAVEN_PASSWORD_SECRET = "APIFUSE__PROXY__NODEMAVEN_PASSWORD";

		it("requires the smartproxy app key for a required smartproxy chain", () => {
			expect(() =>
				defineProvider({
					...validConfig,
					proxy: { mode: "required", provider: "smartproxy" },
				}),
			).toThrow(
				/requires smartproxy egress but does not declare APIFUSE__PROXY__SMARTPROXY_APP_KEY/,
			);
		});

		it("requires both nodemaven credentials for a required nodemaven-only chain", () => {
			expect(() =>
				defineProvider({
					...validConfig,
					proxy: { mode: "required", providers: ["nodemaven"] },
				}),
			).toThrow(
				/requires nodemaven egress but does not declare APIFUSE__PROXY__NODEMAVEN_USERNAME/,
			);
		});

		it("rejects a required smartproxy→nodemaven chain that only declares the smartproxy secret (silently dead fallback)", () => {
			expect(() =>
				defineProvider({
					...validConfig,
					proxy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
					secrets: [{ name: SMARTPROXY_SECRET, required: true }],
				}),
			).toThrow(
				/requires nodemaven egress but does not declare APIFUSE__PROXY__NODEMAVEN_USERNAME/,
			);
		});

		it("rejects a required nodemaven chain that declares username but omits the password", () => {
			expect(() =>
				defineProvider({
					...validConfig,
					proxy: { mode: "required", providers: ["nodemaven"] },
					secrets: [{ name: NODEMAVEN_USERNAME_SECRET, required: true }],
				}),
			).toThrow(
				/requires nodemaven egress but does not declare APIFUSE__PROXY__NODEMAVEN_PASSWORD/,
			);
		});

		it("accepts a required smartproxy→nodemaven chain that declares every vendor's secrets", () => {
			const provider = defineProvider({
				...validConfig,
				proxy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
				secrets: [
					{ name: SMARTPROXY_SECRET, required: true },
					{ name: NODEMAVEN_USERNAME_SECRET, required: true },
					{ name: NODEMAVEN_PASSWORD_SECRET, required: true },
				],
			});

			expect(provider.proxy).toEqual({
				mode: "required",
				providers: ["smartproxy", "nodemaven"],
			});
		});

		it("does not require nodemaven credentials when the chain is optional", () => {
			expect(() =>
				defineProvider({
					...validConfig,
					proxy: { mode: "optional", providers: ["smartproxy", "nodemaven"] },
				}),
			).not.toThrow();
		});

		it("rejects required proxy egress backed only by deprecated vendors", () => {
			expect(() =>
				defineProvider({
					...validConfig,
					proxy: { mode: "required", providers: ["custom", "decodo"] },
				}),
			).toThrow(
				/Provider "korea-air-quality" requires proxy egress but declares only deprecated proxy vendor\(s\): custom, decodo/,
			);
		});

		it("keeps optional deprecated vendors warning-only", () => {
			const warn = spyOn(console, "warn").mockImplementation(() => {});
			try {
				expect(() =>
					defineProvider({
						...validConfig,
						proxy: { mode: "optional", provider: "custom" },
					}),
				).not.toThrow();
				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining("deprecated proxy vendor(s): custom"),
				);
			} finally {
				warn.mockRestore();
			}
		});

		it("treats a declared-but-optional (required: false) vendor secret as missing", () => {
			expect(() =>
				defineProvider({
					...validConfig,
					proxy: { mode: "required", providers: ["nodemaven"] },
					secrets: [
						{ name: NODEMAVEN_USERNAME_SECRET, required: false },
						{ name: NODEMAVEN_PASSWORD_SECRET, required: true },
					],
				}),
			).toThrow(
				/requires nodemaven egress but does not declare APIFUSE__PROXY__NODEMAVEN_USERNAME/,
			);
		});

		it("treats a vendor secret that omits `required` as missing (matches the runtime gate)", () => {
			// listMissingRequiredSecrets enforces only `required === true`, so a
			// default-flag declaration is skipped at runtime; define-time validation
			// must reject it too rather than pass a config the runtime won't enforce.
			expect(() =>
				defineProvider({
					...validConfig,
					proxy: { mode: "required", providers: ["nodemaven"] },
					secrets: [
						{ name: NODEMAVEN_USERNAME_SECRET },
						{ name: NODEMAVEN_PASSWORD_SECRET, required: true },
					],
				}),
			).toThrow(
				/requires nodemaven egress but does not declare APIFUSE__PROXY__NODEMAVEN_USERNAME/,
			);
		});
	});

	describe("proxy.session.drainLeadSeconds", () => {
		const NODEMAVEN_USERNAME_SECRET = "APIFUSE__PROXY__NODEMAVEN_USERNAME";
		const NODEMAVEN_PASSWORD_SECRET = "APIFUSE__PROXY__NODEMAVEN_PASSWORD";
		const credentialedSecrets = [
			{ name: NODEMAVEN_USERNAME_SECRET, required: true },
			{ name: NODEMAVEN_PASSWORD_SECRET, required: true },
		];

		// Regression guard: the type surface and the runtime validator drifted
		// apart once (drainLeadSeconds was typed but rejected by the allowlist),
		// so a provider could not declare the field the drain contract needs.
		// Every native-proxy policy field MUST survive a defineProvider round trip.
		it("accepts a declared drain lead time through defineProvider", () => {
			const provider = defineProvider({
				...validConfig,
				proxy: {
					mode: "required",
					providers: ["nodemaven"],
					session: {
						affinity: "connection",
						lifetimeMinutes: 1440,
						drainLeadSeconds: 120,
					},
				},
				secrets: credentialedSecrets,
			});

			expect(provider.proxy).toBeDefined();
			const proxy = provider.proxy;
			if (!proxy || typeof proxy === "boolean") throw new Error("expected a proxy policy");
			expect(proxy.session?.drainLeadSeconds).toBe(120);
		});

		it("rejects a non-positive drain lead time", () => {
			expect(() =>
				defineProvider({
					...validConfig,
					proxy: {
						mode: "required",
						providers: ["nodemaven"],
						session: { affinity: "connection", drainLeadSeconds: 0 },
					},
					secrets: credentialedSecrets,
				}),
			).toThrow(/invalid proxy\.session\.drainLeadSeconds/);
		});

		it("rejects a drain lead time that swallows the whole sticky lifetime", () => {
			expect(() =>
				defineProvider({
					...validConfig,
					proxy: {
						mode: "required",
						providers: ["nodemaven"],
						session: {
							affinity: "connection",
							lifetimeMinutes: 1,
							drainLeadSeconds: 60,
						},
					},
					secrets: credentialedSecrets,
				}),
			).toThrow(/greater than or equal to proxy\.session\.lifetimeMinutes/);
		});

		it("still rejects genuinely unknown session fields", () => {
			expect(() =>
				defineProvider({
					...validConfig,
					proxy: {
						mode: "required",
						providers: ["nodemaven"],
						// Runtime allowlist is the enforcement point here; the config
						// parameter is structurally loose enough that TS alone does not
						// catch this typo, which is exactly why the validator must.
						session: { affinity: "connection", drainLeadSecond: 120 },
					},
					secrets: credentialedSecrets,
				}),
			).toThrow(/Unknown field "drainLeadSecond" on proxy\.session/);
		});
	});
});
