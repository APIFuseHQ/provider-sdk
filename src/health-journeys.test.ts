import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
	centered,
	defineHealthJourney,
	defineProvider,
	defineSmsOtpMatcher,
	delayed,
	every,
} from "./define";

const noopHandler = async () => ({});

function dummyOperation() {
	return {
		description: "Dummy operation for health journey tests.",
		input: z.object({}),
		output: z.object({}),
		handler: noopHandler,
	};
}

describe("health journey authoring", () => {
	it("serializes an 8h cadence with ISO duration jitter", () => {
		expect(every("8h", { jitter: "PT20M" })).toEqual({
			kind: "interval",
			interval: "PT8H",
			jitter: "PT20M",
		});
	});

	it("serializes centered schedule randomization with normalized duration", () => {
		expect(every("24h", { randomize: centered("6h") })).toEqual({
			kind: "interval",
			interval: "PT24H",
			randomize: { mode: "centered", maxOffset: "PT6H" },
		});
	});

	it("serializes delayed schedule randomization with normalized duration", () => {
		expect(delayed("45m")).toEqual({
			mode: "delayed",
			maxDelay: "PT45M",
		});
	});

	it("characterizes shorthand schedule duration normalization", () => {
		const accepted: Array<[string, string]> = [
			["8h", "PT8H"],
			[" 8h ", "PT8H"],
			["45m", "PT45M"],
			["30s", "PT30S"],
			["1d", "P1D"],
			["PT20M", "PT20M"],
		];

		for (const [interval, normalized] of accepted) {
			expect(every(interval).interval).toBe(normalized);
		}

		const rejected: Array<[string, RegExp]> = [
			["0h", /positive duration/],
			["+1h", /ISO 8601 duration/],
			["0.5h", /ISO 8601 duration/],
			[".5h", /ISO 8601 duration/],
			["1 h", /ISO 8601 duration/],
			["1 hour", /ISO 8601 duration/],
			["1day", /ISO 8601 duration/],
			["1 day", /ISO 8601 duration/],
			["1ms", /ISO 8601 duration/],
		];
		for (const [interval, message] of rejected) {
			expect(() => every(interval)).toThrow(message);
		}
	});

	it("rejects schedules that define both jitter and randomize", () => {
		expect(() =>
			every("24h", { jitter: "PT20M", randomize: centered("6h") }),
		).toThrow(/Schedule cannot define both jitter and randomize/);
	});

	it("rejects malformed health journey randomization objects", () => {
		const baseProvider = {
			id: "bad-randomize-provider",
			version: "1.0.0",
			runtime: "shared" as const,
			meta: {
				displayName: "Bad Randomize",
				descriptionKey: "meta.description",
				category: "test",
			},
			operations: {
				ping: dummyOperation(),
			},
		};

		expect(() =>
			defineProvider({
				...baseProvider,
				healthJourneys: [
					defineHealthJourney({
						id: "bad-extra",
						schedule: {
							...every("24h", { randomize: centered("6h") }),
							randomize: {
								mode: "centered",
								maxOffset: "PT6H",
								extra: true,
							},
						} as never,
						coversOperations: ["ping"],
						steps: [{ id: "ping", operationId: "ping", kind: "operation" }],
					}),
				],
			}),
		).toThrow(/Unknown field "extra"/);

		expect(() =>
			defineProvider({
				...baseProvider,
				healthJourneys: [
					defineHealthJourney({
						id: "bad-mode",
						schedule: {
							...every("24h"),
							randomize: { mode: "spread", maxDelay: "PT6H" },
						} as never,
						coversOperations: ["ping"],
						steps: [{ id: "ping", operationId: "ping", kind: "operation" }],
					}),
				],
			}),
		).toThrow(/mode must be "centered" or "delayed"/);

		expect(() =>
			defineProvider({
				...baseProvider,
				healthJourneys: [
					defineHealthJourney({
						id: "bad-duration",
						schedule: {
							...every("24h"),
							randomize: { mode: "delayed", maxDelay: "PT0S" },
						} as never,
						coversOperations: ["ping"],
						steps: [{ id: "ping", operationId: "ping", kind: "operation" }],
					}),
				],
			}),
		).toThrow(/duration must be positive/);

		expect(() =>
			defineProvider({
				...baseProvider,
				healthJourneys: [
					defineHealthJourney({
						id: "bad-conflict",
						schedule: {
							kind: "interval",
							interval: "PT24H",
							jitter: "PT20M",
							randomize: { mode: "centered", maxOffset: "PT6H" },
						},
						coversOperations: ["ping"],
						steps: [{ id: "ping", operationId: "ping", kind: "operation" }],
					}),
				],
			}),
		).toThrow(/cannot define both jitter and randomize/);
	});

	it("extracts Yogiyo OTP samples with national service code origins", () => {
		const matcher = defineSmsOtpMatcher({
			id: "yogiyo-phone-otp",
			country: "KR",
			locale: "ko-KR",
			origins: [
				{
					kind: "nationalServiceCode",
					country: "KR",
					value: "16615270",
					display: "1661-5270",
				},
			],
			code: { pattern: /요기요\s*인증번호는\s*\[([0-9]{4})\]/ },
			maxAge: "PT5M",
			waitTimeout: "PT2M30S",
			clockSkew: "PT10S",
		});

		expect(
			matcher.extractOtp(
				"<#> 요기요 인증번호는 [3953] 입니다. 위 번호를 인증 창에 입력하세요. pbQWBvNHjoE",
			),
		).toBe("3953");
	});

	it("extracts Modu Parking OTP samples while preserving leading zeros", () => {
		const matcher = defineSmsOtpMatcher({
			id: "modu-phone-otp",
			country: "KR",
			locale: "ko-KR",
			origins: [
				{
					kind: "nationalServiceCode",
					country: "KR",
					value: "18998242",
					display: "1899-8242",
				},
			],
			code: { pattern: /\[모두의주차장\]\s*인증번호는\s*([0-9]{4})\s*입니다/ },
			maxAge: "PT5M",
			waitTimeout: "PT2M30S",
		});

		expect(
			matcher.extractOtp(
				"[모두의주차장]인증번호는 0919 입니다. 정확히 입력해주세요.",
			),
		).toBe("0919");
	});

	it("extracts OTPs repeatably when authors pass a stateful regex", () => {
		const matcher = defineSmsOtpMatcher({
			id: "global-regex-otp",
			country: "KR",
			origins: [
				{ kind: "nationalServiceCode", country: "KR", value: "16615270" },
			],
			code: { pattern: /인증번호는\s*\[([0-9]{4})\]/g },
			maxAge: "PT5M",
			waitTimeout: "PT2M30S",
		});
		const body = "요기요 인증번호는 [3953] 입니다.";

		expect(matcher.extractOtp(body)).toBe("3953");
		expect(matcher.extractOtp(body)).toBe("3953");
	});

	it("keeps regex source and flags available for contract snapshots", () => {
		const pattern = /인증번호는\s*\[([0-9]{4})\]/giu;
		const matcher = defineSmsOtpMatcher({
			id: "global-regex-otp",
			country: "KR",
			origins: [
				{ kind: "nationalServiceCode", country: "KR", value: "16615270" },
			],
			code: { pattern },
			maxAge: "PT5M",
			waitTimeout: "PT2M30S",
		});

		const matcherPattern = matcher.code.pattern;
		expect(matcherPattern).toBeInstanceOf(RegExp);
		if (!(matcherPattern instanceof RegExp)) {
			throw new Error("Expected SMS matcher pattern to be a RegExp");
		}
		expect(matcherPattern.source).toBe(pattern.source);
		expect(matcherPattern.flags).toBe("giu");
	});

	it("does not count parentheses inside regex character classes as captures", () => {
		const matcher = defineSmsOtpMatcher({
			id: "character-class-otp",
			country: "KR",
			origins: [
				{ kind: "nationalServiceCode", country: "KR", value: "16615270" },
			],
			code: { pattern: /인증번호[()]\s*([0-9]{4})/ },
			maxAge: "PT5M",
			waitTimeout: "PT2M30S",
		});

		expect(matcher.extractOtp("요기요 인증번호( 3953")).toBe("3953");
	});

	it("rejects non-standard sender list fields", () => {
		expect(() =>
			defineSmsOtpMatcher({
				id: "bad",
				country: "KR",
				origins: [
					{ kind: "nationalServiceCode", country: "KR", value: "16615270" },
				],
				code: { pattern: /([0-9]{4})/ },
				maxAge: "PT5M",
				waitTimeout: "PT2M30S",
				// @ts-expect-error verify runtime validation for object-shaped provider JS.
				senders: ["1661-5270"],
			}),
		).toThrow(/senders|origins/);
	});

	it("allows operations to be covered by a health journey", () => {
		const provider = defineProvider({
			id: "journey-provider",
			version: "1.0.0",
			runtime: "shared",
			meta: {
				displayName: "Journey",
				descriptionKey: "meta.description",
				category: "test",
			},
			operations: {
				"send-otp": dummyOperation(),
				"confirm-otp": dummyOperation(),
			},
			healthJourneys: [
				defineHealthJourney({
					id: "phone-auth",
					schedule: every("8h", { jitter: "PT20M" }),
					coversOperations: ["send-otp", "confirm-otp"],
					steps: [
						{ id: "send", operationId: "send-otp", kind: "operation" },
						{ id: "confirm", operationId: "confirm-otp", kind: "operation" },
					],
				}),
			],
		});

		expect(provider.healthJourneys?.[0]?.schedule.interval).toBe("PT8H");
	});

	it("validates health journey manual trigger policies", () => {
		const provider = defineProvider({
			id: "manual-journey-provider",
			version: "1.0.0",
			runtime: "shared",
			meta: {
				displayName: "Manual Journey",
				descriptionKey: "meta.description",
				category: "test",
			},
			operations: {
				"start-payment": dummyOperation(),
			},
			healthJourneys: [
				defineHealthJourney({
					id: "payment-url",
					schedule: every("8h", { jitter: "PT20M" }),
					coversOperations: ["start-payment"],
					manualTrigger: {
						enabled: true,
						requiresAcknowledgement: true,
						risk: "sms_or_payment",
						minManualInterval: "PT8H",
						publicRationale:
							"Replays a bounded SMS/payment URL health journey only after operator acknowledgement.",
					},
					steps: [
						{ id: "start", operationId: "start-payment", kind: "operation" },
					],
				}),
			],
		});

		expect(provider.healthJourneys?.[0]?.manualTrigger).toEqual({
			enabled: true,
			requiresAcknowledgement: true,
			risk: "sms_or_payment",
			minManualInterval: "PT8H",
			publicRationale:
				"Replays a bounded SMS/payment URL health journey only after operator acknowledgement.",
		});
	});

	it("rejects malformed manual trigger policies", () => {
		expect(() =>
			defineProvider({
				id: "bad-manual-journey-provider",
				version: "1.0.0",
				runtime: "shared",
				meta: {
					displayName: "Bad Manual Journey",
					descriptionKey: "meta.description",
					category: "test",
				},
				operations: {
					"start-payment": dummyOperation(),
				},
				healthJourneys: [
					defineHealthJourney({
						id: "payment-url",
						schedule: every("8h", { jitter: "PT20M" }),
						coversOperations: ["start-payment"],
						manualTrigger: {
							enabled: true,
							requiresAcknowledgement: true,
							// @ts-expect-error runtime validation covers JS provider declarations.
							risk: "dangerous",
							minManualInterval: "PT8H",
							publicRationale: "manual run",
						},
						steps: [
							{ id: "start", operationId: "start-payment", kind: "operation" },
						],
					}),
				],
			}),
		).toThrow(/manualTrigger.risk/);
	});

	it("rejects disabled manual trigger policies with enabled-only fields", () => {
		expect(() =>
			defineProvider({
				id: "bad-disabled-manual-journey-provider",
				version: "1.0.0",
				runtime: "shared",
				meta: {
					displayName: "Bad Disabled Manual Journey",
					descriptionKey: "meta.description",
					category: "test",
				},
				operations: {
					"start-payment": dummyOperation(),
				},
				healthJourneys: [
					defineHealthJourney({
						id: "payment-url",
						schedule: every("8h", { jitter: "PT20M" }),
						coversOperations: ["start-payment"],
						manualTrigger: {
							enabled: false,
							reason: "manual replay disabled",
							// @ts-expect-error runtime validation covers JS provider declarations.
							requiresAcknowledgement: true,
						},
						steps: [
							{ id: "start", operationId: "start-payment", kind: "operation" },
						],
					}),
				],
			}),
		).toThrow(/requiresAcknowledgement/);
	});

	it("rejects enabled manual trigger policies with disabled-only reason fields", () => {
		expect(() =>
			defineProvider({
				id: "bad-enabled-manual-journey-provider",
				version: "1.0.0",
				runtime: "shared",
				meta: {
					displayName: "Bad Enabled Manual Journey",
					descriptionKey: "meta.description",
					category: "test",
				},
				operations: {
					"start-payment": dummyOperation(),
				},
				healthJourneys: [
					defineHealthJourney({
						id: "payment-url",
						schedule: every("8h", { jitter: "PT20M" }),
						coversOperations: ["start-payment"],
						manualTrigger: {
							enabled: true,
							requiresAcknowledgement: true,
							risk: "sms_or_payment",
							minManualInterval: "PT8H",
							publicRationale: "operator-acknowledged payment journey",
							// @ts-expect-error runtime validation covers JS provider declarations.
							reason: "disabled-only field",
						},
						steps: [
							{ id: "start", operationId: "start-payment", kind: "operation" },
						],
					}),
				],
			}),
		).toThrow(/reason/);
	});

	it("rejects zero-length manual trigger intervals", () => {
		expect(() =>
			defineProvider({
				id: "zero-interval-manual-journey-provider",
				version: "1.0.0",
				runtime: "shared",
				meta: {
					displayName: "Zero Interval Manual Journey",
					descriptionKey: "meta.description",
					category: "test",
				},
				operations: {
					"start-payment": dummyOperation(),
				},
				healthJourneys: [
					defineHealthJourney({
						id: "payment-url",
						schedule: every("8h", { jitter: "PT20M" }),
						coversOperations: ["start-payment"],
						manualTrigger: {
							enabled: true,
							requiresAcknowledgement: true,
							risk: "sms_or_payment",
							minManualInterval: "PT0S",
							publicRationale: "operator-acknowledged payment journey",
						},
						steps: [
							{ id: "start", operationId: "start-payment", kind: "operation" },
						],
					}),
				],
			}),
		).toThrow(/minManualInterval.*positive duration/);
	});

	it("requires acknowledgement for manual triggers with side-effect risk", () => {
		expect(() =>
			defineProvider({
				id: "unacknowledged-risk-manual-journey-provider",
				version: "1.0.0",
				runtime: "shared",
				meta: {
					displayName: "Unacknowledged Risk",
					descriptionKey: "meta.description",
					category: "test",
				},
				operations: {
					"start-payment": dummyOperation(),
				},
				healthJourneys: [
					defineHealthJourney({
						id: "payment-url",
						schedule: every("8h", { jitter: "PT20M" }),
						coversOperations: ["start-payment"],
						manualTrigger: {
							enabled: true,
							requiresAcknowledgement: false,
							risk: "sms_or_payment",
							minManualInterval: "PT8H",
							publicRationale: "payment journey",
						},
						steps: [
							{ id: "start", operationId: "start-payment", kind: "operation" },
						],
					}),
				],
			}),
		).toThrow(/requiresAcknowledgement.*true/);
	});

	it("types provider-authored journey runtime state and operation events", () => {
		const provider = defineProvider({
			id: "journey-runtime-provider",
			version: "1.0.0",
			runtime: "shared",
			meta: {
				displayName: "Journey Runtime",
				descriptionKey: "meta.description",
				category: "test",
			},
			operations: {
				"recover-resource": dummyOperation(),
			},
			healthJourneys: [
				defineHealthJourney({
					id: "resource-recovery",
					schedule: every("8h", { jitter: "PT20M" }),
					coversOperations: ["recover-resource"],
					steps: [
						{
							id: "verify-recovery",
							kind: "assertion",
							coversOperations: ["recover-resource"],
						},
					],
					run: async (ctx) => {
						const namespace = ctx.state.namespace("health.resource.v1", {
							defaultTtl: "1h",
							maxTtl: "1d",
							maxEntries: 10,
							maxValueBytes: 1024,
						});
						await namespace.set("resource:example", { state: "seen" });
						await namespace.list({ prefix: "resource:" });
						await ctx.event.operation({
							operationId: "recover-resource",
							stepId: "verify-recovery",
							status: "ok",
						});
						return { status: "ok" };
					},
				}),
			],
		});

		expect(provider.healthJourneys?.[0]?.id).toBe("resource-recovery");
	});

	it("rejects duplicate SMS matcher ids within a journey", () => {
		const matcher = defineSmsOtpMatcher({
			id: "phone-otp",
			country: "KR",
			origins: [
				{ kind: "nationalServiceCode", country: "KR", value: "16615270" },
			],
			code: { pattern: /([0-9]{4})/ },
			maxAge: "PT5M",
			waitTimeout: "PT2M30S",
		});

		expect(() =>
			defineProvider({
				id: "duplicate-matcher-provider",
				version: "1.0.0",
				runtime: "shared",
				meta: {
					displayName: "Journey",
					descriptionKey: "meta.description",
					category: "test",
				},
				operations: {
					"send-otp": dummyOperation(),
				},
				healthJourneys: [
					defineHealthJourney({
						id: "phone-auth",
						schedule: every("8h", { jitter: "PT20M" }),
						coversOperations: ["send-otp"],
						smsMatchers: [matcher, matcher],
						steps: [{ id: "send", operationId: "send-otp", kind: "operation" }],
					}),
				],
			}),
		).toThrow(/duplicate matcher id "phone-otp"/);
	});
});
