import { describe, expect, it } from "bun:test";
import { z } from "zod";

import type { ExpectedError, HealthScenario, HealthStep } from "../health-scenario.js";
import { type LintDiagnostic, lintProvider } from "../lint.js";
import { describeKey } from "../schema.js";

const OPERATION_KEY = "weatherAlerts";
const UNMATCHABLE = "health-check-expected-error-unmatchable";
const NOT_AN_ABSENCE = "health-check-expected-error-not-an-absence";

/** A handler that throws the provider code from the upstream's own answer. */
const UPSTREAM_THROW = (code: string) =>
	`throw new ProviderError("nothing today", { code: "${code}", status: 404, category: "upstream_http" });`;
/** The same code thrown with no category: classed provider_error, source apifuse. */
const BARE_THROW = (code: string) =>
	`throw new ProviderError("nothing today", { code: "${code}", status: 404 });`;

type ErrorCodeDeclaration = { code: string; status?: number; retryable?: boolean };

function operation(
	healthCheck?: unknown,
	errorCodes?: readonly ErrorCodeDeclaration[],
	source?: string,
) {
	return {
		descriptionKey: `operations.${OPERATION_KEY}.description`,
		input: describeKey(z.object({}), `operations.${OPERATION_KEY}.input.description`),
		output: describeKey(z.object({}), `operations.${OPERATION_KEY}.output.description`),
		fixtures: { request: {}, response: {} },
		...(errorCodes === undefined ? {} : { errorCodes }),
		...(source === undefined ? {} : { source }),
		...(healthCheck === undefined ? {} : { healthCheck }),
	};
}

function probeScenario(steps: [HealthStep, ...HealthStep[]]): HealthScenario {
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

function lint(
	expectedErrors: readonly [ExpectedError, ...ExpectedError[]],
	errorCodes?: readonly ErrorCodeDeclaration[],
	source?: string,
): LintDiagnostic[] {
	const read: HealthStep = {
		id: "read",
		result: "response",
		kind: "operation",
		operationId: OPERATION_KEY,
		inputTemplate: {},
		expectedErrors,
	};
	return lintProvider({
		id: "demo",
		allowedHosts: ["example.com"],
		reviewed: "2026-10-12",
		operations: {
			[OPERATION_KEY]: operation(
				{ cases: [{ name: "national", scenario: probeScenario([read]) }] },
				errorCodes,
				source,
			),
		},
	}).filter((diagnostic) => diagnostic.rule === UNMATCHABLE || diagnostic.rule === NOT_AN_ABSENCE);
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

const FIELD = `operations.${OPERATION_KEY}.healthCheck.cases[0].scenario.steps[0].expectedErrors`;

describe("health-check expectedErrors lint", () => {
	it("accepts an SDK-registered upstream code at its canonical status", () => {
		// NO_DATA is registered 404 / upstream_http, so the envelope is the
		// upstream's (source upstream_failure) however the handler throws it —
		// including through a table-driven helper with no literal code.
		expect(lint([expected(404, "NO_DATA")])).toEqual([]);
		expect(
			lint(
				[expected(404, "NO_DATA")],
				undefined,
				"throw new ProviderError(entry.message, { code: entry.code, retryable: false });",
			),
		).toEqual([]);
	});

	it("accepts a provider code declared in errorCodes and thrown as an upstream answer", () => {
		expect(
			lint(
				[expected(404, "NO_FORECAST")],
				[{ code: "NO_FORECAST", status: 404 }],
				UPSTREAM_THROW("NO_FORECAST"),
			),
		).toEqual([]);
		// A helper that receives the code but pins the category still names the
		// upstream as the source; the linter cannot exclude it, so it counts.
		expect(
			lint(
				[expected(404, "NO_FORECAST")],
				[{ code: "NO_FORECAST", status: 404 }],
				'throw new ProviderError(message, { code, status: 404, category: "upstream_http" });',
			),
		).toEqual([]);
	});

	it("accepts a mapping table that spreads the category in only when the row sets one", () => {
		// korea-disaster-alert upstream/errors.ts: the throw site reads code and
		// category from a table row, so the category is not a literal there. The
		// row may carry an upstream category, so the site may serve the
		// upstream's envelope; the entry is not provably dead.
		const tableThrow = [
			"const CODE_MAP = {",
			'\t"03": { code: "NO_FORECAST", retryable: false, message: "nothing today", category: "upstream_http" },',
			"};",
			"const mapped = CODE_MAP[resultCode];",
			"throw new ProviderError(mapped.message, {",
			"\tcode: mapped.code,",
			"\tretryable: mapped.retryable,",
			"\t...(mapped.category ? { category: mapped.category } : {}),",
			"\t...(mapped.fix ? { fix: mapped.fix } : {}),",
			"\tdetails: { upstreamResultCode: resultCode, source },",
			"});",
		].join("\n");
		expect(
			lint([expected(404, "NO_FORECAST")], [{ code: "NO_FORECAST", status: 404 }], tableThrow),
		).toEqual([]);
	});

	it("accepts a helper that passes code and category through as shorthand members", () => {
		const helperThrow =
			"function upstreamAnswer(message, code, category) { return new ProviderError(message, { code, category }); }";
		expect(
			lint([expected(404, "NO_FORECAST")], [{ code: "NO_FORECAST", status: 404 }], helperThrow),
		).toEqual([]);
	});

	it("rejects a code the operation neither declares nor the SDK registers", () => {
		const diagnostics = lint([expected(404, "NO_FORECAST")]);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			rule: UNMATCHABLE,
			level: "error",
			field: `${FIELD}[0]`,
		});
		expect(diagnostics[0]?.message).toContain('"NO_FORECAST"');
		expect(diagnostics[0]?.message).toContain("HTTP 500");
	});

	it("rejects a status the runtime never serves for the code", () => {
		// Declared 404, declared as expected at 410: the monitor matches both
		// fields, so the entry is dead.
		const declared = lint(
			[expected(410, "NO_FORECAST")],
			[{ code: "NO_FORECAST", status: 404 }],
			UPSTREAM_THROW("NO_FORECAST"),
		);
		expect(declared).toHaveLength(1);
		expect(declared[0]).toMatchObject({ rule: UNMATCHABLE, level: "error" });
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

	it("resolves a duplicate errorCodes declaration the way the runtime does", () => {
		// buildOperationErrorCodeLookup builds a Map, so the LAST declaration of
		// a code is the one served.
		const lastWins = lint(
			[expected(404, "NO_FORECAST")],
			[
				{ code: "NO_FORECAST", status: 410 },
				{ code: "NO_FORECAST", status: 404 },
			],
			UPSTREAM_THROW("NO_FORECAST"),
		);
		expect(lastWins).toEqual([]);
		const firstIsStale = lint(
			[expected(404, "NO_FORECAST")],
			[
				{ code: "NO_FORECAST", status: 404 },
				{ code: "NO_FORECAST", status: 410 },
			],
			UPSTREAM_THROW("NO_FORECAST"),
		);
		expect(firstIsStale).toHaveLength(1);
		expect(firstIsStale[0]?.message).toContain("serves status 410");
	});

	it("rejects a code whose envelope the serve layer attributes elsewhere", () => {
		// Registered as an upstream refusal: served with source upstream_rule.
		const rejected = lint([expected(409, "UPSTREAM_REJECTED")]);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]).toMatchObject({ rule: UNMATCHABLE, level: "error" });
		expect(rejected[0]?.message).toContain('source "upstream_rule"');
		expect(rejected[0]?.message).toContain("registered as upstream_rejected");
		// Status-mapped but not an upstream code: classed provider_error, source apifuse.
		const invalid = lint([expected(400, "INVALID_REQUEST")]);
		expect(invalid).toHaveLength(1);
		expect(invalid[0]?.message).toContain('source "apifuse"');
		// A declared rejection status classes a provider code as a refusal.
		const rejectionStatus = lint(
			[expected(410, "GONE_TODAY")],
			[{ code: "GONE_TODAY", status: 410 }],
			'throw new ProviderError("gone", { code: "GONE_TODAY", status: 410 });',
		);
		expect(rejectionStatus).toHaveLength(1);
		expect(rejectionStatus[0]?.message).toContain("upstream_rejected");
	});

	it("rejects a provider code thrown without an upstream category", () => {
		// No category at the throw site: provider_error, source apifuse — the
		// monitor never sees the upstream's envelope.
		for (const source of [undefined, BARE_THROW("NO_FORECAST")]) {
			const diagnostics = lint(
				[expected(404, "NO_FORECAST")],
				[{ code: "NO_FORECAST", status: 404 }],
				source,
			);
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]).toMatchObject({ rule: UNMATCHABLE, level: "error" });
			expect(diagnostics[0]?.message).toContain('source "apifuse"');
			expect(diagnostics[0]?.message).toContain('category: "upstream_http"');
		}
		// A site that throws ANOTHER literal code says nothing about this one.
		const unrelated = lint(
			[expected(404, "NO_FORECAST")],
			[{ code: "NO_FORECAST", status: 404 }],
			UPSTREAM_THROW("NO_STATION"),
		);
		expect(unrelated).toHaveLength(1);
		expect(unrelated[0]?.message).toContain('source "apifuse"');
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
			UPSTREAM_THROW("MEMBERS_ONLY"),
		);
		expect(forbiddenStatus).toHaveLength(1);
		expect(forbiddenStatus[0]).toMatchObject({ rule: NOT_AN_ABSENCE });
	});

	it("names every bad entry on a step and leaves good ones alone", () => {
		const diagnostics = lint(
			[expected(404, "NO_DATA"), expected(404, "NO_FORECAST"), expected(404, "RATE_LIMITED")],
			[{ code: "NO_FORECAST", status: 410 }],
			UPSTREAM_THROW("NO_FORECAST"),
		);
		expect(diagnostics.map((diagnostic) => [diagnostic.rule, diagnostic.field])).toEqual([
			[UNMATCHABLE, `${FIELD}[1]`],
			[NOT_AN_ABSENCE, `${FIELD}[2]`],
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
		const scenario = probeScenario([
			read,
			{
				id: "read",
				result: "response",
				kind: "operation",
				operationId: OPERATION_KEY,
				inputTemplate: {},
			},
		]);
		const diagnostics = lintProvider({
			id: "demo",
			allowedHosts: ["example.com"],
			reviewed: "2026-10-12",
			operations: {
				[OPERATION_KEY]: operation(
					{ cases: [{ name: "national", scenario }] },
					[{ code: "NO_HELPER_DATA", status: 404 }],
					UPSTREAM_THROW("NO_HELPER_DATA"),
				),
				helper: {
					descriptionKey: "operations.helper.description",
					input: describeKey(z.object({}), "operations.helper.input.description"),
					output: describeKey(z.object({}), "operations.helper.output.description"),
					fixtures: { request: {}, response: {} },
				},
			},
		}).filter((diagnostic) => diagnostic.rule === UNMATCHABLE);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain('for operation "helper"');
	});
});
