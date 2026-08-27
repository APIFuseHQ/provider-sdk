import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
	defineHealthJourney,
	defineHealthScenario,
	defineProvider,
	every,
	type HealthScenarioV1,
} from "./index.js";

function validScenario(): HealthScenarioV1 {
	return {
		scenarioVersion: 1,
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
		healthJourneys: [journey] as never,
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

describe("declarative health scenarios", () => {
	it("accepts a journey with a valid scenario and no run", () => {
		const scenario = defineHealthScenario(validScenario());
		const provider = providerWithJourney(defineHealthJourney({ ...journeyBase(), scenario }));
		expect(provider.healthJourneys?.[0]?.scenario).toEqual(scenario);
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
});
