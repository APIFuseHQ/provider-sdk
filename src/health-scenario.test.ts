import { describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";
import {
	defineHealthJourney,
	defineHealthScenario,
	errorRefs,
	every,
	EXPECTED_ERROR_REFUSAL_CODES,
	type ExpectedError,
	FRESHNESS_GUARD_REASON_COPY,
	FRESHNESS_GUARD_REASON_KEY,
	type HealthJourneyDefinition,
	type HealthCheckCase,
	type HealthScenario,
	type HealthStep,
	isExpectedErrorByCode,
	type OperationCachePolicy,
	type OperationErrorCode,
	type OperationResult,
	type ProviderDefinition,
	SDK_OWNED_HEALTH_REASON_COPY,
	withFreshnessGuards,
} from "./index.js";
import { defineTestProvider as defineProvider } from "./__tests__/test-utils.js";
import { PROVIDER_ERROR_LOCALES } from "./i18n/error-messages.js";
import {
	SDK_ERROR_REGISTRY_BY_CODE,
	SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES,
} from "./error-resolution.js";

const PING_FRESHNESS_GUARD: HealthStep = {
	id: "ping.freshness",
	result: "ping-result.freshness",
	kind: "guard",
	condition: {
		kind: "predicate",
		operator: "not_equals",
		actual: { ref: { namespace: "steps", binding: "ping-result", path: ["served_stale_cache"] } },
		expected: true,
	},
	onFail: {
		attribute: [
			{
				operationId: "ping",
				status: "degraded",
				reasonCode: "served_stale_cache",
				reasonKey: FRESHNESS_GUARD_REASON_KEY,
			},
		],
		stop: "scenario",
	},
};

function validScenario(): HealthScenario {
	return {
		scenarioVersion: 2,
		id: "ping-health",
		display: { titleKey: "health.ping.title", descriptionKey: "health.ping.description" },
		schedule: { kind: "interval", intervalMs: 30_000, jitterMs: 0 },
		timeoutMs: 10_000,
		coversOperations: ["ping"],
		credentialRefs: [],
		steps: [
			{
				id: "ping",
				result: "ping-result",
				kind: "operation",
				operationId: "ping",
				inputTemplate: {},
			},
			{
				id: "assert-ping",
				result: "assert-result",
				kind: "assert",
				coversOperations: ["ping"],
				expression: {
					kind: "predicate",
					operator: "status_2xx",
					actual: {
						ref: { namespace: "steps", binding: "ping-result", path: ["status_code"] },
					},
				},
			},
		],
	};
}

function providerWithJourney(journey: unknown) {
	return defineProvider({
		id: "declarative-health-test",
		version: "1.0.0",
		runtime: "shared",
		meta: {
			displayName: "Declarative health test",
			descriptionKey: "provider.description",
			category: "test",
		},
		operations: {
			ping: {
				riskClass: "read",
				description: "Ping",
				input: z.object({}),
				output: z.object({}),
				handler: async () => ({}),
			},
		},
		healthJourneys: [journey] as HealthJourneyDefinition[],
	});
}

function providerWithCase(caseValue: unknown): ProviderDefinition {
	return defineProvider({
		id: "declarative-case-test",
		version: "1.0.0",
		runtime: "shared",
		meta: {
			displayName: "Declarative case test",
			descriptionKey: "provider.description",
			category: "test",
		},
		operations: {
			ping: {
				riskClass: "read",
				description: "Ping",
				input: z.object({}),
				output: z.object({}),
				handler: async () => ({}),
				healthCheck: {
					interval: "1m",
					// test-invalid: the helper must pass mutually exclusive case fields to runtime validation.
					cases: [caseValue] as never,
				},
			},
			pong: {
				riskClass: "read",
				description: "Pong",
				input: z.object({}),
				output: z.object({}),
				handler: async () => ({}),
				healthCheckUnsupported: { reason: "Only used as unrelated coverage in tests." },
			},
		},
	});
}

/** `defineHealthScenario` followed by the attachment `defineProvider` does for a stale-serving `ping`. */
function guarded(input: unknown): HealthScenario {
	return withFreshnessGuards(defineHealthScenario(input), new Set(["ping"]));
}

function providerWithStaleCase(
	scenario: unknown,
	cache: OperationCachePolicy = { staleIfErrorMs: 60_000 },
	providerCache = true,
): ProviderDefinition {
	return defineProvider({
		id: "stale-case-test",
		version: "1.0.0",
		runtime: "shared",
		...(providerCache ? { cache: true as const } : {}),
		meta: {
			displayName: "Stale case test",
			descriptionKey: "provider.description",
			category: "test",
		},
		operations: {
			ping: {
				riskClass: "read",
				description: "Ping",
				input: z.object({}),
				output: z.object({}),
				handler: async () => ({}),
				cache,
				healthCheck: {
					interval: "1m",
					// test-invalid: the helper passes an unparsed scenario to runtime validation.
					cases: [{ name: "ping probe", scenario }] as never,
				},
			},
		},
	});
}

function providerWithStaleJourney(journey: unknown): ProviderDefinition {
	return defineProvider({
		id: "stale-journey-test",
		version: "1.0.0",
		runtime: "shared",
		cache: true,
		meta: {
			displayName: "Stale journey test",
			descriptionKey: "provider.description",
			category: "test",
		},
		operations: {
			ping: {
				riskClass: "read",
				description: "Ping",
				input: z.object({}),
				output: z.object({}),
				handler: async () => ({}),
				cache: { staleIfErrorMs: 60_000 },
			},
		},
		healthJourneys: [journey] as HealthJourneyDefinition[],
	});
}

function caseScenario(provider: ProviderDefinition): HealthScenario {
	const scenario = provider.operations.ping?.healthCheck?.cases[0]?.scenario;
	if (scenario === undefined) throw new Error("expected a case scenario");
	return scenario;
}

function journeyBase() {
	return {
		id: "ping-health",
		schedule: every("1h"),
		coversOperations: ["ping"] as const,
		steps: [{ id: "ping", operationId: "ping", kind: "operation" as const }] as const,
	};
}

function itemPredicate(binding: string) {
	return {
		kind: "predicate" as const,
		operator: "non_empty" as const,
		actual: { ref: { namespace: "item" as const, binding, path: [] } },
	};
}

function quantifier(quantifierKind: "every" | "any", binding = "entry") {
	return {
		kind: "quantifier" as const,
		quantifier: quantifierKind,
		items: {
			ref: { namespace: "steps" as const, binding: "ping-result", path: ["data", "items"] },
		},
		itemBinding: binding,
		maxItems: 100,
		clause: itemPredicate(binding),
	};
}

function scenarioWithCandidateBlock(memberCount: number) {
	const memberIds = Array.from({ length: memberCount }, (_, index) => `candidate-${index}`);
	const blockSteps = memberIds.map((id, index) => ({
		id,
		result: `${id}-result`,
		kind: "operation" as const,
		operationId: "ping",
		inputTemplate:
			index === 0
				? {
						candidate: {
							ref: {
								namespace: "candidate" as const,
								binding: "candidate-item",
								path: ["item" as const],
							},
						},
					}
				: {},
	}));
	if (blockSteps[0])
		Object.assign(blockSteps[0], {
			candidate: {
				scope: "step_block" as const,
				items: { namespace: "steps" as const, binding: "ping-result", path: ["data", "items"] },
				itemBinding: "candidate-item",
				itemType: "object" as const,
				members: memberIds,
				maxAttempts: 10,
				accept: { kind: "predicate" as const, operator: "is_true" as const, actual: true },
			},
		});
	return { ...validScenario(), steps: [validScenario().steps[0], ...blockSteps] };
}

describe("declarative health scenarios", () => {
	it("accepts a typed operation case scenario parsed like defineHealthScenario", () => {
		const input = validScenario();
		const expected = defineHealthScenario(input);
		const healthCase: HealthCheckCase<Record<string, never>, Record<string, never>> = {
			name: "ping probe",
			input: {},
			scenario: expected,
		};

		const provider = providerWithCase(healthCase);

		expect(provider.operations.ping.healthCheck?.cases[0]?.scenario).toEqual(expected);
	});

	it("rejects a case scenario combined with prepareInput", () => {
		expect(() =>
			providerWithCase({
				name: "ping probe",
				input: {},
				scenario: validScenario(),
				prepareInput: () => ({}),
			}),
		).toThrow(
			'Provider "declarative-case-test" operation "ping" health-check case "ping probe" cannot declare scenario with prepareInput.',
		);
	});

	it("rejects a case scenario combined with assertions", () => {
		expect(() =>
			providerWithCase({
				name: "ping probe",
				input: {},
				scenario: validScenario(),
				assertions: () => {},
			}),
		).toThrow(
			'Provider "declarative-case-test" operation "ping" health-check case "ping probe" cannot declare scenario with assertions.',
		);
	});

	it("validates case scenarios with HealthScenarioSchema", () => {
		expect(() =>
			providerWithCase({
				name: "ping probe",
				input: {},
				scenario: { ...validScenario(), scenarioVersion: 1 },
			}),
		).toThrow(
			'Provider "declarative-case-test" operation "ping" health-check case "ping probe" has an invalid scenario: it must conform to HealthScenario.',
		);
	});

	it("rejects case scenario coverage of an unrelated operation", () => {
		expect(() =>
			providerWithCase({
				name: "ping probe",
				input: {},
				scenario: { ...validScenario(), coversOperations: ["pong"] },
			}),
		).toThrow(
			'Provider "declarative-case-test" operation "ping" health-check case "ping probe" scenario.coversOperations cannot claim unrelated operation "pong".',
		);
	});

	it("keeps imperative operation cases unchanged", () => {
		const assertions = () => {};
		const prepareInput = () => ({});
		const provider = providerWithCase({
			name: "legacy ping probe",
			input: {},
			prepareInput,
			assertions,
		});
		const healthCase = provider.operations.ping.healthCheck?.cases[0];

		expect(healthCase?.prepareInput).toBe(prepareInput);
		expect(healthCase?.assertions).toBe(assertions);
	});

	it("accepts a journey with a valid scenario and no run", () => {
		const scenario = defineHealthScenario(validScenario());
		const provider = providerWithJourney(defineHealthJourney({ ...journeyBase(), scenario }));
		expect(provider.healthJourneys?.[0]?.scenario).toEqual(scenario);
	});

	it("authors v2 scenarios only", () => {
		expect(() => defineHealthScenario({ ...validScenario(), scenarioVersion: 1 })).toThrow();
	});

	it("keeps health-journey-executable for a journey with neither run nor scenario", () => {
		expect(() =>
			providerWithJourney(
				// test-invalid: runtime validation must reject a journey missing both run and scenario.
				defineHealthJourney(journeyBase() as never),
			),
		).toThrow(/health-journey-executable/);
	});

	it("rejects a journey with both run and scenario", () => {
		expect(() =>
			providerWithJourney(
				defineHealthJourney({
					...journeyBase(),
					scenario: defineHealthScenario(validScenario()),
					run: async () => ({ status: "ok" as const }),
					// test-invalid: runtime validation must reject a journey that declares both run and scenario.
				} as never),
			),
		).toThrow(/health-journey-run-scenario-exclusive/);
	});

	it("rejects retry and candidate attempt bounds", () => {
		const retry = validScenario();
		const retryStep = retry.steps[0];
		if (retryStep?.kind !== "operation") throw new Error("expected operation step");
		retryStep.retry = {
			maxAttempts: 4,
			retryOn: ["timeout"],
			backoff: { kind: "fixed", delayMs: 0 },
		};
		expect(() => defineHealthScenario(retry)).toThrow();

		const candidate = validScenario();
		const candidateStep = candidate.steps[0];
		if (candidateStep?.kind !== "operation") throw new Error("expected operation step");
		candidateStep.candidate = {
			items: { namespace: "steps", binding: "items", path: ["value"] },
			itemBinding: "item",
			itemType: "string",
			maxAttempts: 11,
			accept: { kind: "predicate", operator: "is_true", actual: true },
		};
		expect(() => defineHealthScenario(candidate)).toThrow();
	});

	it("admits relative-date offsets from -365 to 365 days", () => {
		const node = (offsetDays: number) => ({
			relativeDate: {
				anchor: "operation_started_at" as const,
				offsetDays,
				timeZone: "Asia/Seoul" as const,
				format: "YYYY-MM-DD" as const,
			},
		});
		const withStartOffset = (offsetDays: number) => {
			const scenario = validScenario();
			const step = scenario.steps[0];
			if (step?.kind !== "operation") throw new Error("expected operation step");
			step.inputTemplate = { start_date: node(offsetDays), end_date: node(0) };
			return scenario;
		};
		for (const offsetDays of [-365, -182, -1, 0, 1, 365]) {
			expect(defineHealthScenario(withStartOffset(offsetDays))).toEqual(
				withStartOffset(offsetDays),
			);
		}
		for (const offsetDays of [-366, 366, -0.5, 1.5]) {
			expect(() => defineHealthScenario(withStartOffset(offsetDays))).toThrow();
		}
	});

	it("rejects selector depth, property byte length, and index bounds", () => {
		const selector = {
			...validScenario(),
			steps: [
				{
					id: "extract",
					result: "extracted",
					kind: "extract",
					from: { namespace: "steps", binding: "ping-result", path: ["data"] },
					selector: {
						root: "$",
						segments: Array.from({ length: 13 }, () => ({ kind: "property", name: "x" })),
					},
					valueType: "string",
					required: true,
				},
			],
		};
		expect(() => defineHealthScenario(selector)).toThrow();

		const property = structuredClone(selector);
		const propertyStep = property.steps[0];
		if (propertyStep?.kind !== "extract") throw new Error("expected extract step");
		propertyStep.selector.segments = [{ kind: "property", name: "😀".repeat(33) }];
		expect(() => defineHealthScenario(property)).toThrow();

		const index = structuredClone(selector);
		const indexStep = index.steps[0];
		if (indexStep?.kind !== "extract") throw new Error("expected extract step");
		// test-invalid: runtime validation must reject an index selector above 10000.
		indexStep.selector.segments = [{ kind: "index", index: 10_001 }] as never;
		expect(() => defineHealthScenario(index)).toThrow();
	});

	it("rejects step count and serialized-size bounds", () => {
		const tooManySteps = validScenario();
		tooManySteps.steps = Array.from({ length: 65 }, (_, index) => ({
			id: `ping-${index}`,
			result: `result-${index}`,
			kind: "operation" as const,
			operationId: "ping",
			inputTemplate: {},
			// test-invalid: runtime validation must reject more than 64 steps.
		})) as never;
		expect(() => defineHealthScenario(tooManySteps)).toThrow();

		const tooLarge = validScenario();
		const operation = tooLarge.steps[0];
		if (operation?.kind !== "operation") throw new Error("expected operation step");
		operation.inputTemplate = { payload: "x".repeat(128 * 1024) };
		expect(() => defineHealthScenario(tooLarge)).toThrow(/128 KiB/);
	});

	it("rejects schedule, timeout, cooldown, and manual interval bounds", () => {
		const invalidScenarios = [
			{ ...validScenario(), schedule: { kind: "interval", intervalMs: 29_999, jitterMs: 0 } },
			{ ...validScenario(), schedule: { kind: "interval", intervalMs: 604_800_001, jitterMs: 0 } },
			{ ...validScenario(), schedule: { kind: "interval", intervalMs: 30_000, jitterMs: 30_001 } },
			{ ...validScenario(), timeoutMs: 999 },
			{ ...validScenario(), timeoutMs: 600_001 },
			{ ...validScenario(), timeoutMs: 30_001 },
			{ ...validScenario(), cooldownMs: -1 },
			{ ...validScenario(), cooldownMs: 86_400_001 },
			{
				...validScenario(),
				manualTrigger: {
					enabled: true,
					requiresAcknowledgement: false,
					risk: "read_only",
					minManualIntervalMs: 999,
					publicRationaleKey: "health.manual.rationale",
				},
			},
		];
		for (const scenario of invalidScenarios) expect(() => defineHealthScenario(scenario)).toThrow();
	});

	it("rejects unknown fields and function values at any depth", () => {
		expect(() =>
			defineHealthScenario({
				...validScenario(),
				display: { titleKey: "health.ping.title", unknown: true },
			}),
		).toThrow();

		const executable = validScenario();
		const operation = executable.steps[0];
		if (operation?.kind !== "operation") throw new Error("expected operation step");
		// test-invalid: runtime validation must reject a function value at any depth.
		operation.inputTemplate = { nested: { callback: () => "forbidden" } } as never;
		expect(() => defineHealthScenario(executable)).toThrow();
	});

	it("returns JSON data that survives a serialization round trip unchanged", () => {
		const scenario = defineHealthScenario(validScenario());
		expect(JSON.parse(JSON.stringify(scenario))).toEqual(scenario);
	});

	it("accepts a find_first extract selector", () => {
		const scenario = validScenario();
		scenario.steps = [
			...scenario.steps,
			{
				id: "find-item",
				result: "found-item",
				kind: "extract",
				from: { namespace: "steps", binding: "ping-result", path: ["data", "items"] },
				selector: {
					kind: "find_first",
					itemBinding: "entry",
					predicate: itemPredicate("entry"),
					maxScan: 100,
				},
				valueType: "object",
				required: true,
			},
			// test-invalid: the extra extract step is assembled as a closed union member outside the helper.
		] as never;
		expect(defineHealthScenario(scenario).steps.at(-1)).toEqual(scenario.steps.at(-1));
	});

	it("attaches a freshness guard right after every unguarded operation step of a stale-serving operation", () => {
		const parsed = defineHealthScenario(validScenario());
		expect(parsed.steps.map((step) => step.id)).toEqual(["ping", "assert-ping"]);
		const guarded = withFreshnessGuards(parsed, new Set(["ping"]));
		expect(guarded.steps.map((step) => step.id)).toEqual(["ping", "ping.freshness", "assert-ping"]);
		expect(guarded.steps[1]).toEqual(PING_FRESHNESS_GUARD);
		expect(withFreshnessGuards(guarded, new Set(["ping"]))).toEqual(guarded);
		// Only an operation that declares the stale window is guarded.
		expect(withFreshnessGuards(parsed, new Set(["pong"]))).toEqual(parsed);
		expect(withFreshnessGuards(parsed, new Set())).toEqual(parsed);
	});

	it("leaves an authored freshness verdict alone and does not guard uncovered reads", () => {
		const base = validScenario();
		const authored: HealthStep = {
			...PING_FRESHNESS_GUARD,
			id: "guard-freshness",
			result: "freshness-guarded",
			onFail: {
				attribute: [
					{
						operationId: "ping",
						status: "degraded",
						reasonCode: "served_stale_cache",
						reasonKey: "health.ping.servedStaleCache",
					},
				],
				stop: "scenario",
			},
		};
		const prepare: HealthStep = {
			id: "prepare",
			result: "prepare-result",
			kind: "operation",
			operationId: "pong",
			inputTemplate: {},
		};
		const parsed = guarded({
			...base,
			steps: [prepare, base.steps[0], authored, base.steps[1]],
		});
		expect(parsed.steps.map((step) => step.id)).toEqual([
			"prepare",
			"ping",
			"guard-freshness",
			"assert-ping",
		]);
	});

	it("guards ahead of an authored freshness guard that attributes expected_absence or follows another guard", () => {
		const base = validScenario();
		const absence: HealthStep = {
			...PING_FRESHNESS_GUARD,
			id: "guard-freshness",
			result: "freshness-guarded",
			onFail: {
				attribute: [
					{
						operationId: "ping",
						status: "degraded",
						reasonCode: "expected_absence",
						reasonKey: "health.ping.calm",
					},
				],
				stop: "scenario",
			},
		};
		expect(
			guarded({ ...base, steps: [base.steps[0], absence] }).steps.map((step) => step.id),
		).toEqual(["ping", "ping.freshness", "guard-freshness"]);

		const rows: HealthStep = {
			id: "guard-rows",
			result: "rows-guarded",
			kind: "guard",
			condition: {
				kind: "predicate",
				operator: "non_empty",
				actual: { ref: { namespace: "steps", binding: "ping-result", path: ["data"] } },
			},
			onFail: {
				attribute: [
					{
						operationId: "ping",
						status: "degraded",
						reasonCode: "expected_absence",
						reasonKey: "health.ping.empty",
					},
				],
				stop: "scenario",
			},
		};
		const late: HealthStep = { ...PING_FRESHNESS_GUARD, id: "guard-late", result: "late-guarded" };
		expect(
			guarded({ ...base, steps: [base.steps[0], rows, late] }).steps.map((step) => step.id),
		).toEqual(["ping", "ping.freshness", "guard-rows", "guard-late"]);
	});

	it("honours an authored assert that rejects the stale serve as the verdict", () => {
		const base = validScenario();
		const assertion = base.steps[1];
		if (assertion?.kind !== "assert") throw new Error("expected assert step");
		assertion.expression = {
			kind: "all",
			clauses: [
				assertion.expression,
				{
					kind: "predicate",
					operator: "equals",
					actual: false,
					expected: {
						ref: { namespace: "steps", binding: "ping-result", path: ["served_stale_cache"] },
					},
				},
			],
		};
		expect(guarded(base).steps.map((step) => step.id)).toEqual(["ping", "assert-ping"]);
	});

	it("places the guards for step_block members after the block", () => {
		const parsed = guarded(scenarioWithCandidateBlock(2));
		expect(parsed.steps.map((step) => step.id)).toEqual([
			"ping",
			"ping.freshness",
			"candidate-0",
			"candidate-1",
			"candidate-1.freshness",
			"candidate-0.freshness",
		]);
	});

	it("holds the step budget for what the monitor receives, attached guards included", () => {
		const steps = Array.from({ length: 33 }, (_, index) => ({
			id: `ping-${index}`,
			result: `result-${index}`,
			kind: "operation" as const,
			operationId: "ping",
			inputTemplate: {},
		}));
		const scenario = (count: number) => ({ ...validScenario(), steps: steps.slice(0, count) });
		expect(defineHealthScenario(scenario(33)).steps).toHaveLength(33);
		expect(() => providerWithStaleCase(scenario(33))).toThrow(/invalid scenario/);
		expect(caseScenario(providerWithStaleCase(scenario(32))).steps).toHaveLength(64);
	});

	it("attaches the guard in defineProvider only for an operation that declares cache.staleIfErrorMs", () => {
		const scenario = defineHealthScenario(validScenario());
		const stale = caseScenario(providerWithStaleCase(scenario));
		expect(stale.steps.map((step) => step.id)).toEqual(["ping", "ping.freshness", "assert-ping"]);
		expect(stale.steps[1]).toEqual(PING_FRESHNESS_GUARD);
		expect(caseScenario(providerWithCase({ name: "ping probe", scenario }))).toEqual(scenario);
		// The journey scenario of the same operation is guarded the same way.
		const journeyProvider = providerWithStaleJourney(
			defineHealthJourney({ ...journeyBase(), scenario }),
		);
		expect(journeyProvider.healthJourneys?.[0]?.scenario?.steps.map((step) => step.id)).toEqual([
			"ping",
			"ping.freshness",
			"assert-ping",
		]);
	});

	it("rejects a cache policy without the cache capability, a non-window, or an unknown field", () => {
		const scenario = defineHealthScenario(validScenario());
		expect(() => providerWithStaleCase(scenario, { staleIfErrorMs: 60_000 }, false)).toThrow(
			/does not declare the cache capability/,
		);
		for (const staleIfErrorMs of [0, -1, 1.5, Number.NaN]) {
			expect(() => providerWithStaleCase(scenario, { staleIfErrorMs })).toThrow(
				/staleIfErrorMs must be an integer of at least 1 ms/,
			);
		}
		expect(() =>
			// test-invalid: runtime validation must reject an unknown cache policy field.
			providerWithStaleCase(scenario, { staleIfErrorMs: 1, ttlMs: 1 } as never),
		).toThrow(/Unknown field "ttlMs"/);
	});

	it("accepts every and any quantifiers", () => {
		for (const quantifierKind of ["every", "any"] as const) {
			const scenario = validScenario();
			const assertion = scenario.steps[1];
			if (assertion?.kind !== "assert") throw new Error("expected assert step");
			assertion.expression = quantifier(quantifierKind);
			expect(defineHealthScenario(scenario).steps[1]).toEqual(assertion);
		}
	});

	it("accepts a step_block candidate", () => {
		const scenario = scenarioWithCandidateBlock(2);
		expect(defineHealthScenario(scenario).steps).toHaveLength(3);
	});

	it("rejects nested quantifiers and enclosing itemBinding shadowing", () => {
		const nested = validScenario();
		const nestedAssertion = nested.steps[1];
		if (nestedAssertion?.kind !== "assert") throw new Error("expected assert step");
		nestedAssertion.expression = {
			...quantifier("every", "outer"),
			clause: quantifier("any", "inner"),
			// test-invalid: runtime validation must reject a nested quantifier.
		} as never;
		expect(() => defineHealthScenario(nested)).toThrow();

		const shadowed = validScenario();
		const shadowedAssertion = shadowed.steps[1];
		if (shadowedAssertion?.kind !== "assert") throw new Error("expected assert step");
		shadowedAssertion.expression = {
			...quantifier("every", "entry"),
			clause: quantifier("any", "entry"),
			// test-invalid: runtime validation must reject an itemBinding that shadows its enclosing binding.
		} as never;
		expect(() => defineHealthScenario(shadowed)).toThrow();
	});

	it("enforces step_block member bounds", () => {
		expect(() => defineHealthScenario(scenarioWithCandidateBlock(1))).toThrow();
		expect(defineHealthScenario(scenarioWithCandidateBlock(16)).steps).toHaveLength(17);
		expect(() => defineHealthScenario(scenarioWithCandidateBlock(17))).toThrow();
	});

	it("enforces quantifier and find_first scan bounds", () => {
		for (const maxItems of [0, 101]) {
			const scenario = validScenario();
			const assertion = scenario.steps[1];
			if (assertion?.kind !== "assert") throw new Error("expected assert step");
			assertion.expression = { ...quantifier("every"), maxItems };
			expect(() => defineHealthScenario(scenario)).toThrow();
		}

		for (const maxScan of [0, 101]) {
			const scenario = validScenario();
			scenario.steps = [
				...scenario.steps,
				{
					id: "find-item",
					result: "found-item",
					kind: "extract",
					from: { namespace: "steps", binding: "ping-result", path: ["data", "items"] },
					selector: {
						kind: "find_first",
						itemBinding: "entry",
						predicate: itemPredicate("entry"),
						maxScan,
					},
					valueType: "object",
					required: true,
				},
				// test-invalid: runtime validation must reject find_first maxScan outside [1,100].
			] as never;
			expect(() => defineHealthScenario(scenario)).toThrow();
		}
	});

	it("rejects step_block maxAttempts above 10", () => {
		const scenario = scenarioWithCandidateBlock(2);
		const operation = scenario.steps[1];
		const candidate = operation && "candidate" in operation ? operation.candidate : undefined;
		if (operation?.kind !== "operation" || !candidate)
			throw new Error("expected candidate operation");
		candidate.maxAttempts = 11;
		expect(() => defineHealthScenario(scenario)).toThrow();
	});

	it("rejects expressions nested past depth 8", () => {
		const scenario = validScenario();
		const assertion = scenario.steps[1];
		if (assertion?.kind !== "assert") throw new Error("expected assert step");
		let expression: unknown = {
			kind: "predicate",
			operator: "is_true",
			actual: true,
		};
		for (let depth = 0; depth < 9; depth += 1) expression = { kind: "not", clause: expression };
		// test-invalid: runtime validation must reject expression depth above 8.
		assertion.expression = expression as never;
		expect(() => defineHealthScenario(scenario)).toThrow(/expression depth exceeds 8/);
	});

	it("requires attemptTimeoutMs when retryOn includes timeout", () => {
		const scenario = validScenario();
		const operation = scenario.steps[0];
		if (operation?.kind !== "operation") throw new Error("expected operation step");
		operation.retry = {
			maxAttempts: 1,
			retryOn: ["timeout"],
			backoff: { kind: "fixed", delayMs: 0 },
		};
		expect(() => defineHealthScenario(scenario)).toThrow(/timeout retry requires attemptTimeoutMs/);
	});

	it("rejects step timeouts beyond the scenario and duplicate ids or results", () => {
		const lateStep = validScenario();
		lateStep.steps[0].timeoutMs = lateStep.timeoutMs + 1;
		expect(() => defineHealthScenario(lateStep)).toThrow(
			/step timeout must not exceed the scenario timeout/,
		);

		const duplicateId = validScenario();
		duplicateId.steps[1].id = duplicateId.steps[0].id;
		expect(() => defineHealthScenario(duplicateId)).toThrow(/duplicate step/);

		const duplicateResult = validScenario();
		duplicateResult.steps[1].result = duplicateResult.steps[0].result;
		expect(() => defineHealthScenario(duplicateResult)).toThrow(/duplicate result binding/);
	});

	it("authors a stale-cache freshness guard against the operation step result", () => {
		// A provider that reads its upstream through `staleIfErrorMs` answers an
		// upstream outage with a 200 whose body satisfies every `data` assertion.
		// `served_stale_cache` is the only operand that separates that from a live
		// read, so the authoring surface has to carry it and the closed AST has to
		// accept a guard pointed at it.
		const staleCacheField: keyof OperationResult = "served_stale_cache";
		const projected: OperationResult = {
			kind: "operation_result",
			status_code: 200,
			data: {},
			request_id: "req-1",
			duration_ms: 1,
			served_stale_cache: false,
		};
		expect(projected[staleCacheField]).toBe(false);

		const base = validScenario();
		const scenario: HealthScenario = {
			...base,
			steps: [
				...base.steps,
				{
					id: "guard-freshness",
					result: "freshness-guarded",
					kind: "guard",
					condition: {
						kind: "predicate",
						operator: "not_equals",
						actual: {
							ref: { namespace: "steps", binding: "ping-result", path: ["served_stale_cache"] },
						},
						expected: true,
					},
					onFail: {
						attribute: [
							{
								operationId: "ping",
								status: "degraded",
								reasonCode: "served_stale_cache",
								reasonKey: "health.ping.servedStaleCache",
							},
						],
						stop: "scenario",
					},
				},
			],
		};
		const parsed = defineHealthScenario(scenario);
		expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
	});

	it("resolves a duplicate code to its last declaration before exposing a reference, as the server does", () => {
		const refs = errorRefs([
			{ code: "NO_DATA", status: 404 },
			{ code: "NO_DATA", status: 422 },
			{ code: "EMPTY", status: 422 },
			{ code: "EMPTY", status: 404 },
		] as const) as Record<string, { code: string; status: number } | undefined>;
		expect(refs.NO_DATA).toBeUndefined();
		expect(refs.EMPTY).toEqual({ code: "EMPTY", status: 404 });
	});

	it("references a declared absence code by value and serializes it as status and code", () => {
		const errorCodes = [
			{ code: "NO_DATA", status: 404, description: "No alert is issued today." },
			{ code: "BAD_DISTRICT", status: 400, description: "Unknown district." },
			{ code: "UPSTREAM_REJECTED", status: 409, description: "Refused upstream." },
			{ code: "RATE_LIMITED", status: 404, description: "Mis-declared refusal." },
			{ code: "UNMAPPED", description: "No status." },
		] as const satisfies readonly OperationErrorCode[];
		const errors = errorRefs(errorCodes);
		expect(errors).toEqual({
			NO_DATA: { code: "NO_DATA", status: 404 },
			BAD_DISTRICT: { code: "BAD_DISTRICT", status: 400 },
		});
		// @ts-expect-error test-invalid: a 409 is an upstream refusal, not an absence
		errors.UPSTREAM_REJECTED;
		// @ts-expect-error test-invalid: a rate-limit code is never an absence, whatever its declared status
		errors.RATE_LIMITED;
		// @ts-expect-error test-invalid: a code without a declared absence status is not offered
		errors.UNMAPPED;
		// @ts-expect-error test-invalid: an undeclared code does not exist
		errors.TYPO;
		const widened: readonly OperationErrorCode[] = errorCodes;
		// @ts-expect-error test-invalid: a widened declaration offers no reference at all
		errorRefs(widened).NO_DATA;

		const base = validScenario();
		const [operation, ...rest] = base.steps;
		if (operation.kind !== "operation") throw new Error("expected operation step");
		const attribute = [
			{
				operationId: "ping",
				status: "degraded",
				reasonCode: "expected_absence",
				reasonKey: "health.ping.calm",
			},
		] as const;
		const parsed = defineHealthScenario({
			...base,
			steps: [{ ...operation, expectedErrors: [{ error: errors.NO_DATA, attribute }] }, ...rest],
		});
		const parsedOperation = parsed.steps[0];
		expect(
			parsedOperation.kind === "operation" ? parsedOperation.expectedErrors : undefined,
		).toEqual([{ status: 404, code: "NO_DATA", attribute: [...attribute] }]);

		for (const error of [
			{ code: "RATE_LIMITED", status: 404 },
			{ code: "NO_DATA", status: 409 },
			{ code: "NO_DATA", status: 401 },
			undefined,
		]) {
			expect(() =>
				defineHealthScenario({
					...base,
					steps: [{ ...operation, expectedErrors: [{ error, attribute }] }, ...rest],
				}),
			).toThrow();
		}
	});

	it("tags a by-code entry for the old path's lint without changing the wire shape", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const base = validScenario();
			const [operation, ...rest] = base.steps;
			if (operation.kind !== "operation") throw new Error("expected operation step");
			const attribute = [
				{
					operationId: "ping",
					status: "degraded",
					reasonCode: "expected_absence",
					reasonKey: "health.ping.calm",
				},
			] as const;
			const errors = errorRefs([{ code: "NO_ROUTE", status: 404 }] as const);
			const parsed = defineHealthScenario({
				...base,
				steps: [
					{
						...operation,
						expectedErrors: [
							{ status: 404, code: "NO_DATA", attribute },
							{ error: errors.NO_ROUTE, attribute },
						],
					},
					...rest,
				],
			});
			const step = parsed.steps[0];
			const entries = step.kind === "operation" ? step.expectedErrors : undefined;
			expect(entries?.map((entry) => isExpectedErrorByCode(entry))).toEqual([true, false]);
			expect(entries?.[0]).toEqual({ status: 404, code: "NO_DATA", attribute: [...attribute] });
			expect(JSON.stringify(entries?.[0])).toBe(
				JSON.stringify(entries?.[1]).replace("NO_ROUTE", "NO_DATA"),
			);
			expect(Object.keys(entries?.[0] ?? {})).toEqual(["status", "code", "attribute"]);
			// The tag survives the guard attachment defineProvider does.
			const guardedStep = withFreshnessGuards(parsed, new Set(["ping"])).steps[0];
			expect(
				guardedStep.kind === "operation"
					? isExpectedErrorByCode(guardedStep.expectedErrors?.[0])
					: undefined,
			).toBe(true);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("ships the freshness guard copy in every locale the SDK negotiates", () => {
		expect(Object.keys(FRESHNESS_GUARD_REASON_COPY).sort()).toEqual(
			[...PROVIDER_ERROR_LOCALES].sort(),
		);
		expect(SDK_OWNED_HEALTH_REASON_COPY[FRESHNESS_GUARD_REASON_KEY]).toBe(
			FRESHNESS_GUARD_REASON_COPY,
		);
		for (const sentence of Object.values(FRESHNESS_GUARD_REASON_COPY))
			expect(sentence.length).toBeGreaterThan(0);
	});

	it("pins the refusal codes the reference type excludes to the SDK registries", () => {
		const registered = [
			...Array.from(SDK_ERROR_REGISTRY_BY_CODE)
				.filter(
					([, registration]) =>
						registration.category === "upstream_auth" ||
						registration.category === "upstream_rate_limited",
				)
				.map(([code]) => code),
			...Array.from(SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES)
				.filter(([code, status]) => status === 401 || code === "MISSING_SECRET")
				.map(([code]) => code),
		];
		expect(new Set<string>(EXPECTED_ERROR_REFUSAL_CODES)).toEqual(new Set(registered));
	});

	it("authors a declared non-2xx absence on the operation step", () => {
		// An upstream that answers "nothing to return" with an error envelope
		// (404 NO_DATA on a quiet day) never reaches a guard: the monitor ends the
		// attempt on a non-2xx before any guard runs. The declaration therefore
		// lives on the operation step and reuses the guard attribution, narrowed
		// to the one reason an error envelope can mean.
		const base = validScenario();
		const [operation, ...rest] = base.steps;
		if (operation.kind !== "operation") throw new Error("expected operation step");
		const expectedError: ExpectedError = {
			status: 404,
			code: "NO_DATA",
			attribute: [
				{
					operationId: "ping",
					status: "degraded",
					reasonCode: "expected_absence",
					reasonKey: "health.ping.calm",
				},
			],
		};
		const scenario: HealthScenario = {
			...base,
			steps: [{ ...operation, expectedErrors: [expectedError] }, ...rest],
		};
		const parsed = defineHealthScenario(scenario);
		expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
		const parsedOperation = parsed.steps[0];
		expect(
			parsedOperation.kind === "operation" ? parsedOperation.expectedErrors : undefined,
		).toEqual([expectedError]);
	});

	it("rejects expected errors that are not an absence", () => {
		const withExpectedErrors = (expectedErrors: unknown) => {
			const base = validScenario();
			const [operation, ...rest] = base.steps;
			return { ...base, steps: [{ ...operation, expectedErrors }, ...rest] };
		};
		const attribute = (reasonCode: string) => [
			{ operationId: "ping", status: "degraded", reasonCode, reasonKey: "health.ping.calm" },
		];
		// Only `expected_absence`: a stale-cache serve is a 2xx and has no error
		// envelope to declare.
		expect(() =>
			defineHealthScenario(
				withExpectedErrors([
					{ status: 404, code: "NO_DATA", attribute: attribute("served_stale_cache") },
				]),
			),
		).toThrow();
		// The retry classes and credential refusals are never an absence.
		for (const status of [401, 403, 429, 500, 502, 503, 200, 399]) {
			expect(() =>
				defineHealthScenario(
					withExpectedErrors([
						{ status, code: "NO_DATA", attribute: attribute("expected_absence") },
					]),
				),
			).toThrow();
		}
		// Empty list, empty attribution, unknown fields, duplicate answers.
		expect(() => defineHealthScenario(withExpectedErrors([]))).toThrow();
		expect(() =>
			defineHealthScenario(withExpectedErrors([{ status: 404, code: "NO_DATA", attribute: [] }])),
		).toThrow();
		expect(() =>
			defineHealthScenario(
				withExpectedErrors([
					{ status: 404, code: "NO_DATA", attribute: attribute("expected_absence"), retry: true },
				]),
			),
		).toThrow();
		expect(() =>
			defineHealthScenario(
				withExpectedErrors([
					{ status: 404, code: "NO_DATA", attribute: attribute("expected_absence") },
					{ status: 404, code: "NO_DATA", attribute: attribute("expected_absence") },
				]),
			),
		).toThrow(/duplicate expected error 404 NO_DATA/);
		// Two different answers on one step are fine.
		expect(() =>
			defineHealthScenario(
				withExpectedErrors([
					{ status: 404, code: "NO_DATA", attribute: attribute("expected_absence") },
					{ status: 404, code: "NO_ROUTE", attribute: attribute("expected_absence") },
				]),
			),
		).not.toThrow();
	});

	it("round-trips v2 additions through JSON unchanged", () => {
		const scenario = validScenario();
		const assertion = scenario.steps[1];
		if (assertion?.kind !== "assert") throw new Error("expected assert step");
		assertion.expression = quantifier("every");
		const parsed = defineHealthScenario(scenario);
		expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
	});
});
