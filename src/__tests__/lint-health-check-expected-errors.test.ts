import { describe, expect, it } from "bun:test";
import { z } from "zod";

import type { ExpectedError, HealthScenario, HealthStep } from "../health-scenario.js";
import { type LintDiagnostic, lintProvider } from "../lint.js";
import { describeKey } from "../schema.js";

const OPERATION_KEY = "weatherAlerts";
const UNDECLARED = "health-check-expected-error-undeclared";
const NOT_AN_ABSENCE = "health-check-expected-error-not-an-absence";

type ErrorCodeDeclaration = { code: string; status?: number; retryable?: boolean };

function operation(healthCheck?: unknown, errorCodes?: readonly ErrorCodeDeclaration[]) {
	return {
		descriptionKey: `operations.${OPERATION_KEY}.description`,
		input: describeKey(z.object({}), `operations.${OPERATION_KEY}.input.description`),
		output: describeKey(z.object({}), `operations.${OPERATION_KEY}.output.description`),
		fixtures: { request: {}, response: {} },
		...(errorCodes === undefined ? {} : { errorCodes }),
		...(healthCheck === undefined ? {} : { healthCheck }),
	};
}

function lint(
	expectedErrors: readonly [ExpectedError, ...ExpectedError[]],
	errorCodes?: readonly ErrorCodeDeclaration[],
): LintDiagnostic[] {
	const read: HealthStep = {
		id: "read",
		result: "response",
		kind: "operation",
		operationId: OPERATION_KEY,
		inputTemplate: {},
		expectedErrors,
	};
	const scenario: HealthScenario = {
		scenarioVersion: 2,
		id: `${OPERATION_KEY}.probe`,
		display: { titleKey: `health.operations.${OPERATION_KEY}.probe.title` },
		schedule: { kind: "interval", intervalMs: 3_600_000, jitterMs: 0 },
		timeoutMs: 15_000,
		coversOperations: [OPERATION_KEY],
		credentialRefs: [],
		steps: [read],
	};
	return lintProvider({
		id: "demo",
		allowedHosts: ["example.com"],
		reviewed: "2026-10-12",
		operations: {
			[OPERATION_KEY]: operation({ cases: [{ name: "national", scenario }] }, errorCodes),
		},
	}).filter((diagnostic) => diagnostic.rule === UNDECLARED || diagnostic.rule === NOT_AN_ABSENCE);
}

function expected(status: number, code: string): ExpectedError {
	return {
		status,
		code,
		attribute: [
			{
				operationId: OPERATION_KEY,
				status: "degraded",
				reasonCode: "expected_absence",
				reasonKey: `health.operations.${OPERATION_KEY}.probe.calm`,
			},
		],
	};
}

describe("health-check expectedErrors lint", () => {
	it("accepts an SDK-registered code at its canonical status", () => {
		// NO_DATA is registered as 404 upstream_http; the fleet does not re-declare it.
		expect(lint([expected(404, "NO_DATA")])).toEqual([]);
	});

	it("accepts a provider code declared in errorCodes at the declared status", () => {
		expect(lint([expected(404, "NO_FORECAST")], [{ code: "NO_FORECAST", status: 404 }])).toEqual(
			[],
		);
	});

	it("rejects a code the operation neither declares nor the SDK registers", () => {
		const diagnostics = lint([expected(404, "NO_FORECAST")]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			rule: UNDECLARED,
			level: "error",
			field: `operations.${OPERATION_KEY}.healthCheck.cases[0].scenario.steps[0].expectedErrors[0]`,
		});
		expect(diagnostics[0]?.message).toContain('"NO_FORECAST"');
		expect(diagnostics[0]?.message).toContain("HTTP 500");
	});

	it("rejects a status the runtime never serves for the code", () => {
		// Declared 404, declared as expected at 410: the monitor matches both
		// fields, so the entry is dead.
		const declared = lint([expected(410, "NO_FORECAST")], [{ code: "NO_FORECAST", status: 404 }]);
		expect(declared).toHaveLength(1);
		expect(declared[0]).toMatchObject({ rule: UNDECLARED, level: "error" });
		expect(declared[0]?.message).toContain("serves status 404");
		// Registered NO_DATA is 404 whatever the operation says it expects.
		const registered = lint([expected(410, "NO_DATA")]);
		expect(registered).toHaveLength(1);
		expect(registered[0]?.message).toContain("serves status 404");
		// A declaration without a status serves 500.
		const unstated = lint([expected(404, "NO_FORECAST")], [{ code: "NO_FORECAST" }]);
		expect(unstated).toHaveLength(1);
		expect(unstated[0]?.message).toContain("carries no status");
	});

	it("rejects credential and rate-limit codes whatever status they serve", () => {
		for (const [status, code] of [
			[400, "UPSTREAM_AUTH_ERROR"],
			[400, "MISSING_SECRET"],
			[404, "RATE_LIMITED"],
		] as const) {
			const diagnostics = lint([expected(status, code)]);
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]).toMatchObject({ rule: NOT_AN_ABSENCE, level: "error" });
			expect(diagnostics[0]?.message).toContain(`"${code}"`);
		}
		// A provider code declared at a credential-refusal status is the same
		// fault under another name.
		const forbiddenStatus = lint(
			[expected(404, "MEMBERS_ONLY")],
			[{ code: "MEMBERS_ONLY", status: 403 }],
		);
		expect(forbiddenStatus).toHaveLength(1);
		expect(forbiddenStatus[0]).toMatchObject({ rule: NOT_AN_ABSENCE });
	});

	it("names every bad entry on a step and leaves good ones alone", () => {
		const diagnostics = lint(
			[expected(404, "NO_DATA"), expected(404, "NO_FORECAST"), expected(404, "RATE_LIMITED")],
			[{ code: "NO_FORECAST", status: 410 }],
		);
		expect(diagnostics.map((diagnostic) => [diagnostic.rule, diagnostic.field])).toEqual([
			[
				UNDECLARED,
				`operations.${OPERATION_KEY}.healthCheck.cases[0].scenario.steps[0].expectedErrors[1]`,
			],
			[
				NOT_AN_ABSENCE,
				`operations.${OPERATION_KEY}.healthCheck.cases[0].scenario.steps[0].expectedErrors[2]`,
			],
		]);
	});

	it("resolves the code against the step's operation, not the case's", () => {
		// A scenario may read a helper operation before the one under probe; the
		// code must be one the helper serves.
		const read: HealthStep = {
			id: "read-helper",
			result: "helper-response",
			kind: "operation",
			operationId: "helper",
			inputTemplate: {},
			expectedErrors: [
				{
					status: 404,
					code: "NO_HELPER_DATA",
					attribute: [
						{
							operationId: OPERATION_KEY,
							status: "degraded",
							reasonCode: "expected_absence",
							reasonKey: "health.operations.helper.calm",
						},
					],
				},
			],
		};
		const scenario: HealthScenario = {
			scenarioVersion: 2,
			id: `${OPERATION_KEY}.probe`,
			display: { titleKey: `health.operations.${OPERATION_KEY}.probe.title` },
			schedule: { kind: "interval", intervalMs: 3_600_000, jitterMs: 0 },
			timeoutMs: 15_000,
			coversOperations: [OPERATION_KEY],
			credentialRefs: [],
			steps: [
				read,
				{
					id: "read",
					result: "response",
					kind: "operation",
					operationId: OPERATION_KEY,
					inputTemplate: {},
				},
			],
		};
		const diagnostics = lintProvider({
			id: "demo",
			allowedHosts: ["example.com"],
			reviewed: "2026-10-12",
			operations: {
				[OPERATION_KEY]: operation({ cases: [{ name: "national", scenario }] }, [
					{ code: "NO_HELPER_DATA", status: 404 },
				]),
				helper: {
					descriptionKey: "operations.helper.description",
					input: describeKey(z.object({}), "operations.helper.input.description"),
					output: describeKey(z.object({}), "operations.helper.output.description"),
					fixtures: { request: {}, response: {} },
				},
			},
		}).filter((diagnostic) => diagnostic.rule === UNDECLARED);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain('for operation "helper"');
	});
});
