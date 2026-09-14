import { describe, expect, it } from "bun:test";
import { z } from "zod";

import type { HealthScenario, HealthStep } from "../health-scenario.js";
import { type LintDiagnostic, lintProvider } from "../lint.js";
import { describeKey } from "../schema.js";

const OPERATION_KEY = "listItems";

function described<TSchema extends z.ZodType>(schema: TSchema, key: string): TSchema {
	return describeKey(schema, key);
}

function operation(healthCheck?: unknown, source?: string) {
	return {
		descriptionKey: `operations.${OPERATION_KEY}.description`,
		input: described(z.object({}), `operations.${OPERATION_KEY}.input.description`),
		output: described(z.object({}), `operations.${OPERATION_KEY}.output.description`),
		fixtures: { request: {}, response: {} },
		...(source === undefined ? {} : { source }),
		...(healthCheck === undefined ? {} : { healthCheck }),
	};
}

function lint(
	healthCheck?: unknown,
	extra: { providerSourceFiles?: Record<string, string>; operationSource?: string } = {},
): LintDiagnostic[] {
	return lintProvider({
		id: "demo",
		allowedHosts: ["example.com"],
		reviewed: "2026-09-14",
		providerSourceFiles: extra.providerSourceFiles,
		operations: { [OPERATION_KEY]: operation(healthCheck, extra.operationSource) },
	});
}

function rules(diagnostics: LintDiagnostic[], rule: string): LintDiagnostic[] {
	return diagnostics.filter((diagnostic) => diagnostic.rule === rule);
}

const UNMONITORED = "health-check-assertions-not-monitored";
const UNGUARDED_STALE = "health-check-stale-serve-unguarded";

/** Minimal scenario; only whether a step names the operand matters here. */
function scenario(steps: [HealthStep, ...HealthStep[]]): HealthScenario {
	return {
		scenarioVersion: 2,
		id: `${OPERATION_KEY}.probe`,
		display: { titleKey: `health.operations.${OPERATION_KEY}.probe.title` },
		schedule: { kind: "interval", intervalMs: 3_600_000, jitterMs: 0 },
		timeoutMs: 15_000,
		coversOperations: [OPERATION_KEY],
		credentialRefs: [],
		steps,
	};
}

const READ_STEP: HealthStep = {
	id: "read",
	result: "response",
	kind: "operation",
	operationId: OPERATION_KEY,
	inputTemplate: {},
};

/** The shape provider-sdk#331 documents and apifuse-provider-han-river#24 ships. */
const FRESHNESS_GUARD: HealthStep = {
	id: "guard-freshness",
	result: "freshness-guarded",
	kind: "guard",
	condition: {
		kind: "predicate",
		operator: "not_equals",
		actual: { ref: { namespace: "steps", binding: "response", path: ["served_stale_cache"] } },
		expected: true,
	},
	onFail: {
		attribute: [
			{
				operationId: OPERATION_KEY,
				status: "degraded",
				reasonCode: "expected_absence",
				reasonKey: `health.operations.${OPERATION_KEY}.probe.servedStaleCache`,
			},
		],
		stop: "scenario",
	},
};

describe("health-check monitorability lint", () => {
	it("warns that an assertions-only case is published but never executed", () => {
		const diagnostics = rules(
			lint({ interval: "1h", cases: [{ name: "dense", input: {}, assertions: () => {} }] }),
			UNMONITORED,
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.level).toBe("warn");
		expect(diagnostics[0]?.field).toBe(`operations.${OPERATION_KEY}.healthCheck.cases`);
		expect(diagnostics[0]?.message).toContain('case "dense"');
		expect(diagnostics[0]?.message).toContain("monitoring_unavailable");
	});

	it("names every unmonitored case on the operation in one diagnostic", () => {
		const diagnostics = rules(
			lint({
				interval: "1h",
				cases: [
					{ name: "dense", input: {}, assertions: () => {} },
					{ name: "sparse", input: {}, assertions: () => {} },
				],
			}),
			UNMONITORED,
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain('cases "dense", "sparse"');
	});

	it("stays silent for a case that carries a scenario", () => {
		expect(
			rules(
				lint({
					interval: "1h",
					cases: [{ name: "dense", input: {}, scenario: scenario([READ_STEP]) }],
				}),
				UNMONITORED,
			),
		).toEqual([]);
	});

	it("stays silent for an operation with no health check at all", () => {
		expect(rules(lint(undefined), UNMONITORED)).toEqual([]);
	});

	it("warns when a stale-if-error read has no served_stale_cache guard", () => {
		const diagnostics = rules(
			lint(
				{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: scenario([READ_STEP]) }] },
				{
					providerSourceFiles: {
						"upstream/client.ts":
							"await ctx.cache.getOrSet(key, load, { ttlMs: 60_000, staleIfErrorMs: 300_000 });",
					},
				},
			),
			UNGUARDED_STALE,
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.level).toBe("warn");
		expect(diagnostics[0]?.field).toBe("healthCheck");
		expect(diagnostics[0]?.message).toContain("upstream/client.ts");
		expect(diagnostics[0]?.message).toContain("expected_absence");
	});

	it("clears once any scenario guards served_stale_cache", () => {
		expect(
			rules(
				lint(
					{
						interval: "1h",
						cases: [
							{
								name: "dense",
								input: {},
								scenario: scenario([READ_STEP, FRESHNESS_GUARD]),
							},
						],
					},
					{
						providerSourceFiles: {
							"upstream/client.ts": "{ ttlMs: 60_000, staleIfErrorMs: 300_000 }",
						},
					},
				),
				UNGUARDED_STALE,
			),
		).toEqual([]);
	});

	it("ignores staleIfErrorMs that only appears in test sources", () => {
		expect(
			rules(
				lint(
					{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: scenario([READ_STEP]) }] },
					{
						providerSourceFiles: {
							"__tests__/client.test.ts": "expect(options.staleIfErrorMs).toBe(300_000);",
							"upstream/client.spec.ts": "staleIfErrorMs",
						},
					},
				),
				UNGUARDED_STALE,
			),
		).toEqual([]);
	});

	it("reads staleIfErrorMs out of the operation handler source too", () => {
		const diagnostics = rules(
			lint(
				{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: scenario([READ_STEP]) }] },
				{ operationSource: "ctx.cache.getOrSet(k, l, { staleIfErrorMs: 300_000 })" },
			),
			UNGUARDED_STALE,
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain(`operations.${OPERATION_KEY} handler`);
	});

	it("does not ask for a freshness guard when the provider declares no health check", () => {
		expect(
			rules(
				lint(undefined, {
					providerSourceFiles: { "upstream/client.ts": "staleIfErrorMs: 300_000" },
				}),
				UNGUARDED_STALE,
			),
		).toEqual([]);
	});

	it("keeps both rules warning-level so the migrating fleet does not go red", () => {
		const diagnostics = lint(
			{ interval: "1h", cases: [{ name: "dense", input: {}, assertions: () => {} }] },
			{ providerSourceFiles: { "upstream/client.ts": "staleIfErrorMs: 300_000" } },
		);

		const health = diagnostics.filter((diagnostic) =>
			[UNMONITORED, UNGUARDED_STALE].includes(diagnostic.rule),
		);
		expect(health).toHaveLength(2);
		expect(health.every((diagnostic) => diagnostic.level === "warn")).toBe(true);
	});
});
