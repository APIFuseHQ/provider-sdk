import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
	DECLARATION_INVALID_CODE,
	DECLARATION_RULE_IDS,
	type DeclarationViolation,
	validateFailClosedDeclaration,
} from "../declaration-validation.js";
import { defineProvider } from "../define.js";
import { isProviderError } from "../errors.js";
import type { HealthCheckSuite, ProviderDefinition } from "../types.js";

function operation() {
	return {
		input: z.object({}),
		output: z.object({ ok: z.boolean() }),
		handler: async () => ({ ok: true }),
	};
}

function provider(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
	return {
		id: "declaration-test-provider",
		version: "1.0.0",
		runtime: "standard",
		meta: {
			displayName: "Declaration Test",
			descriptionKey: "providers.declarationTest.description",
			category: "test",
		},
		operations: { ping: operation() },
		...overrides,
	};
}

function rejectedViolations(declaration: ProviderDefinition): DeclarationViolation[] {
	try {
		validateFailClosedDeclaration(declaration);
	} catch (error) {
		expect(isProviderError(error)).toBe(true);
		if (!isProviderError(error)) throw error;
		expect(error.code).toBe(DECLARATION_INVALID_CODE);
		const details = error.details as { violations?: DeclarationViolation[] };
		expect(details.violations).toBeArray();
		return details.violations ?? [];
	}
	throw new Error("Expected declaration validation to fail");
}

function expectRule(
	declaration: ProviderDefinition,
	ruleId: DeclarationViolation["ruleId"],
	path: string,
): void {
	const violation = rejectedViolations(declaration).find((entry) => entry.ruleId === ruleId);
	expect(violation).toMatchObject({ ruleId, path });
	expect(violation?.fix).toBeString();
	expect(violation?.fix.includes("\n")).toBe(false);
}

describe("fail-closed provider declaration validation", () => {
	it("runs from defineProvider before returning the declaration", () => {
		expect(() =>
			defineProvider({
				...provider({ proxy: true }),
				operations: {
					ping: {
						...operation(),
						healthCheckUnsupported: { reason: "Not exercised by this validation fixture." },
					},
				},
			}),
		).toThrow(
			expect.objectContaining({
				code: DECLARATION_INVALID_CODE,
				details: {
					violations: [
						expect.objectContaining({
							ruleId: DECLARATION_RULE_IDS.proxyExplicitPolicy,
							path: "proxy",
						}),
					],
				},
			}),
		);
	});

	it("requires executable health journeys", () => {
		expectRule(
			provider({
				healthJourneys: [
					// @ts-expect-error test-invalid: validation must reject a journey without an executable run handler.
					{
						id: "ping-journey",
						schedule: { kind: "interval", interval: "PT1H" },
						coversOperations: ["ping"],
						steps: [{ id: "ping", kind: "operation", operationId: "ping" }],
					},
				],
			}),
			DECLARATION_RULE_IDS.journeyExecutable,
			"healthJourneys.ping-journey.run",
		);
		expect(() =>
			validateFailClosedDeclaration(
				provider({
					healthJourneys: [
						{
							id: "ping-journey",
							schedule: { kind: "interval", interval: "PT1H" },
							coversOperations: ["ping"],
							steps: [{ id: "ping", kind: "operation", operationId: "ping" }],
							run: async () => ({ status: "ok" }),
						},
					],
				}),
			),
		).not.toThrow();
	});

	it("accepts function-gated health cases (skip is reported, not silent)", () => {
		const healthCheck = {
			interval: "1m" as const,
			cases: [
				{
					name: "ping",
					input: {},
					assertions: () => {},
					enabled: () => true,
				},
			],
		} satisfies HealthCheckSuite;
		expect(() =>
			validateFailClosedDeclaration(
				provider({ operations: { ping: { ...operation(), healthCheck } } }),
			),
		).not.toThrow();
		expect(() =>
			validateFailClosedDeclaration(
				provider({
					operations: {
						ping: {
							...operation(),
							healthCheck: {
								interval: "1m",
								cases: [{ name: "ping", input: {}, assertions: () => {} }],
							},
						},
					},
				}),
			),
		).not.toThrow();
	});

	it("rejects operation schemas that cannot serialize", () => {
		expectRule(
			provider({
				operations: {
					ping: { ...operation(), output: z.string().transform((value) => value.trim()) },
				},
			}),
			DECLARATION_RULE_IDS.schemaSerializable,
			"operations.ping.output",
		);
		expect(() => validateFailClosedDeclaration(provider())).not.toThrow();
	});

	it("rejects transform-bearing SSE event schemas under the same rule", () => {
		const sseOperation = {
			...operation(),
			transport: {
				kind: "sse" as const,
				events: { tick: z.string().transform((value) => value.trim()) },
			},
		};
		expectRule(
			provider({ operations: { ping: sseOperation } }),
			DECLARATION_RULE_IDS.schemaSerializable,
			"operations.ping.transport.events.tick",
		);
	});

	it("rejects proxy: true and retains proxy: false", () => {
		expectRule(provider({ proxy: true }), DECLARATION_RULE_IDS.proxyExplicitPolicy, "proxy");
		expect(() => validateFailClosedDeclaration(provider({ proxy: false }))).not.toThrow();
	});

	it("makes proxy.provider and proxy.providers mutually exclusive", () => {
		expectRule(
			provider({
				proxy: { mode: "required", provider: "smartproxy", providers: ["nodemaven"] },
			}),
			DECLARATION_RULE_IDS.proxyVendorExclusive,
			"proxy",
		);
		expect(() =>
			validateFailClosedDeclaration(
				provider({ proxy: { mode: "required", providers: ["nodemaven"] } }),
			),
		).not.toThrow();
	});

	it("rejects mixed managed and deprecated static proxy chains", () => {
		expectRule(
			provider({ proxy: { mode: "required", providers: ["smartproxy", "custom"] } }),
			DECLARATION_RULE_IDS.proxyNoMixedVendors,
			"proxy.providers",
		);
		expect(() =>
			validateFailClosedDeclaration(
				provider({ proxy: { mode: "required", providers: ["smartproxy", "nodemaven"] } }),
			),
		).not.toThrow();
	});

	it("limits Smartproxy geo declarations to country", () => {
		expectRule(
			provider({
				proxy: {
					mode: "required",
					providers: ["smartproxy"],
					geo: { country: "KR", city: "Seoul" },
				},
			}),
			DECLARATION_RULE_IDS.proxySmartproxyGeo,
			"proxy.geo.city",
		);
		expect(() =>
			validateFailClosedDeclaration(
				provider({
					proxy: { mode: "required", providers: ["smartproxy"], geo: { country: "KR" } },
				}),
			),
		).not.toThrow();
	});

	it("rejects operation-level upstream proxy declarations", () => {
		expectRule(
			provider({
				operations: { ping: { ...operation(), upstream: { proxy: true } } },
			}),
			DECLARATION_RULE_IDS.operationUpstreamProxy,
			"operations.ping.upstream.proxy",
		);
		expect(() =>
			validateFailClosedDeclaration(
				provider({
					operations: {
						ping: {
							...operation(),
							upstream: { baseUrl: "https://example.test", proxy: false },
						},
					},
				}),
			),
		).not.toThrow();
		expectRule(
			provider({
				operations: {
					ping: {
						...operation(),
						upstream: { proxy: { mode: "optional", providers: ["nodemaven"] } },
					},
				},
			}),
			DECLARATION_RULE_IDS.operationUpstreamProxy,
			"operations.ping.upstream.proxy",
		);
	});

	it("collects every provider-level violation before throwing", () => {
		const violations = rejectedViolations(
			provider({
				proxy: true,
				operations: {
					ping: {
						...operation(),
						input: z.string().transform((value) => value),
						upstream: { proxy: true },
					},
				},
			}),
		);
		expect(violations.map((violation) => violation.ruleId)).toEqual([
			DECLARATION_RULE_IDS.schemaSerializable,
			DECLARATION_RULE_IDS.proxyExplicitPolicy,
			DECLARATION_RULE_IDS.operationUpstreamProxy,
		]);
	});
});
