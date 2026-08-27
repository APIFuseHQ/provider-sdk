import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
	defineHealthJourney,
	defineHealthScenario,
	every,
	type HealthJourneyDefinition,
	type HealthScenario,
} from "./index.js";
import { defineTestProvider as defineProvider } from "./__tests__/test-utils.js";

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
				description: "Ping",
				input: z.object({}),
				output: z.object({}),
				handler: async () => ({}),
			},
		},
		healthJourneys: [journey] as HealthJourneyDefinition[],
	});
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
	it("accepts a journey with a valid scenario and no run", () => {
		const scenario = defineHealthScenario(validScenario());
		const provider = providerWithJourney(defineHealthJourney({ ...journeyBase(), scenario }));
		expect(provider.healthJourneys?.[0]?.scenario).toEqual(scenario);
	});

	it("authors v2 scenarios only", () => {
		expect(() => defineHealthScenario({ ...validScenario(), scenarioVersion: 1 })).toThrow();
	});

	it("keeps health-journey-executable for a journey with neither run nor scenario", () => {
		expect(() => providerWithJourney(defineHealthJourney(journeyBase() as never))).toThrow(
			/health-journey-executable/,
		);
	});

	it("rejects a journey with both run and scenario", () => {
		expect(() =>
			providerWithJourney(
				defineHealthJourney({
					...journeyBase(),
					scenario: defineHealthScenario(validScenario()),
					run: async () => ({ status: "ok" as const }),
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
		] as never;
		expect(defineHealthScenario(scenario).steps.at(-1)).toEqual(scenario.steps.at(-1));
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
		} as never;
		expect(() => defineHealthScenario(nested)).toThrow();

		const shadowed = validScenario();
		const shadowedAssertion = shadowed.steps[1];
		if (shadowedAssertion?.kind !== "assert") throw new Error("expected assert step");
		shadowedAssertion.expression = {
			...quantifier("every", "entry"),
			clause: quantifier("any", "entry"),
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

	it("round-trips v2 additions through JSON unchanged", () => {
		const scenario = validScenario();
		const assertion = scenario.steps[1];
		if (assertion?.kind !== "assert") throw new Error("expected assert step");
		assertion.expression = quantifier("every");
		const parsed = defineHealthScenario(scenario);
		expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
	});
});
