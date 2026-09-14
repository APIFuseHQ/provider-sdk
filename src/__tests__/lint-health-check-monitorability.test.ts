import { describe, expect, it } from "bun:test";
import { z } from "zod";

import type { AssertionExpression, HealthScenario, HealthStep } from "../health-scenario.js";
import { type LintDiagnostic, lintProvider } from "../lint.js";
import { describeKey } from "../schema.js";

const OPERATION_KEY = "listItems";
const UNMONITORED = "health-check-assertions-not-monitored";
const UNGUARDED_STALE = "health-check-stale-serve-unguarded";
const STALE_CLIENT =
	"await ctx.cache.getOrSet(key, load, { ttlMs: 60_000, staleIfErrorMs: 300_000 });";

function described<TSchema extends z.ZodType>(schema: TSchema, key: string): TSchema {
	return describeKey(schema, key);
}

type OperationFixture = {
	descriptionKey: string;
	input: z.ZodType;
	output: z.ZodType;
	fixtures: { request: unknown; response: unknown };
	source?: string;
	healthCheck?: unknown;
};

function operation(healthCheck?: unknown, source?: string): OperationFixture {
	return {
		descriptionKey: `operations.${OPERATION_KEY}.description`,
		input: described(z.object({}), `operations.${OPERATION_KEY}.input.description`),
		output: described(z.object({}), `operations.${OPERATION_KEY}.output.description`),
		fixtures: { request: {}, response: {} },
		...(source === undefined ? {} : { source }),
		...(healthCheck === undefined ? {} : { healthCheck }),
	};
}

function lintFleet(
	operations: Record<string, OperationFixture>,
	providerSourceFiles?: Record<string, string>,
): LintDiagnostic[] {
	return lintProvider({
		id: "demo",
		allowedHosts: ["example.com"],
		reviewed: "2026-09-14",
		providerSourceFiles,
		operations,
	});
}

function lint(
	healthCheck?: unknown,
	extra: { providerSourceFiles?: Record<string, string>; operationSource?: string } = {},
): LintDiagnostic[] {
	return lintFleet(
		{ [OPERATION_KEY]: operation(healthCheck, extra.operationSource) },
		extra.providerSourceFiles,
	);
}

function rules(diagnostics: LintDiagnostic[], rule: string): LintDiagnostic[] {
	return diagnostics.filter((diagnostic) => diagnostic.rule === rule);
}

function scenario(
	steps: [HealthStep, ...HealthStep[]],
	operationId = OPERATION_KEY,
): HealthScenario {
	return {
		scenarioVersion: 2,
		id: `${operationId}.probe`,
		display: { titleKey: `health.operations.${operationId}.probe.title` },
		schedule: { kind: "interval", intervalMs: 3_600_000, jitterMs: 0 },
		timeoutMs: 15_000,
		coversOperations: [operationId],
		credentialRefs: [],
		steps,
	};
}

/**
 * The operation step a probe is about. Its `operationId` and `result` both
 * matter: the lint only accepts a freshness reference bound to the result of a
 * step that invoked the case's own operation.
 */
function readStep(operationId: string): HealthStep {
	return {
		id: `read-${operationId}`,
		result: `${operationId}-response`,
		kind: "operation",
		operationId,
		inputTemplate: {},
	};
}

/** The shape provider-sdk#331 documents and apifuse-provider-han-river#24 ships. */
function freshnessGuard(operationId: string, binding = `${operationId}-response`): HealthStep {
	return {
		id: `guard-${operationId}-freshness`,
		result: `${operationId}-freshness-guarded`,
		kind: "guard",
		condition: {
			kind: "predicate",
			operator: "not_equals",
			actual: { ref: { namespace: "steps", binding, path: ["served_stale_cache"] } },
			expected: true,
		},
		onFail: {
			attribute: [
				{
					operationId,
					status: "degraded",
					reasonCode: "expected_absence",
					reasonKey: `health.operations.${operationId}.probe.servedStaleCache`,
				},
			],
			stop: "scenario",
		},
	};
}

function rowsGuard(operationId: string, reasonKey: string): HealthStep {
	return {
		id: `guard-${operationId}-rows`,
		result: `${operationId}-rows-guarded`,
		kind: "guard",
		condition: {
			kind: "predicate",
			operator: "array_length_gte",
			actual: {
				ref: { namespace: "steps", binding: `${operationId}-response`, path: ["data", "items"] },
			},
			expected: 1,
		},
		onFail: {
			attribute: [{ operationId, status: "degraded", reasonCode: "expected_absence", reasonKey }],
			stop: "scenario",
		},
	};
}

/** A guard whose condition is supplied by the test. */
function conditionGuard(condition: AssertionExpression): HealthStep {
	return {
		id: "guard-condition",
		result: "condition-guarded",
		kind: "guard",
		condition,
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
}

const READ_STEP = readStep(OPERATION_KEY);
const FRESHNESS_GUARD = freshnessGuard(OPERATION_KEY);

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
				{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
			),
			UNGUARDED_STALE,
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.level).toBe("warn");
		expect(diagnostics[0]?.field).toBe("healthCheck");
		expect(diagnostics[0]?.message).toContain("upstream/client.ts");
		expect(diagnostics[0]?.message).toContain("expected_absence");
	});

	it("clears once the case guards served_stale_cache", () => {
		expect(
			rules(
				lint(
					{
						interval: "1h",
						cases: [{ name: "dense", input: {}, scenario: scenario([READ_STEP, FRESHNESS_GUARD]) }],
					},
					{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
				),
				UNGUARDED_STALE,
			),
		).toEqual([]);
	});

	it("keeps warning about the operation a sibling operation's guard does not cover", () => {
		const diagnostics = rules(
			lintFleet(
				{
					guardedOp: operation({
						interval: "1h",
						cases: [
							{
								name: "guarded",
								input: {},
								scenario: scenario(
									[readStep("guardedOp"), freshnessGuard("guardedOp")],
									"guardedOp",
								),
							},
						],
					}),
					bareOp: operation({
						interval: "1h",
						cases: [
							{ name: "bare", input: {}, scenario: scenario([readStep("bareOp")], "bareOp") },
						],
					}),
				},
				{ "upstream/client.ts": STALE_CLIENT },
			),
			UNGUARDED_STALE,
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain('bareOp "bare"');
		expect(diagnostics[0]?.message).not.toContain('guardedOp "guarded"');
	});

	it("keeps warning about an unguarded sibling CASE on the same operation", () => {
		const diagnostics = rules(
			lint(
				{
					interval: "1h",
					cases: [
						{ name: "guarded", input: {}, scenario: scenario([READ_STEP, FRESHNESS_GUARD]) },
						{ name: "bare", input: {}, scenario: scenario([READ_STEP]) },
					],
				},
				{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
			),
			UNGUARDED_STALE,
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain(`${OPERATION_KEY} "bare"`);
		expect(diagnostics[0]?.message).not.toContain(`${OPERATION_KEY} "guarded"`);
	});

	it("does not accept a guard on a preparatory step as coverage for the checked operation", () => {
		// The scenario reads `prepareIds` first and guards THAT result's freshness,
		// then invokes the operation the case is about. The checked read is still
		// unguarded.
		const prepared = scenario([readStep("prepareIds"), freshnessGuard("prepareIds"), READ_STEP]);

		expect(
			rules(
				lint(
					{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: prepared }] },
					{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
				),
				UNGUARDED_STALE,
			),
		).toHaveLength(1);
	});

	it("accepts an assert step on the operand as freshness coverage", () => {
		const asserted = scenario([
			READ_STEP,
			{
				id: "verify",
				result: "verified",
				kind: "assert",
				coversOperations: [OPERATION_KEY],
				expression: {
					kind: "predicate",
					operator: "not_equals",
					actual: {
						ref: {
							namespace: "steps",
							binding: `${OPERATION_KEY}-response`,
							path: ["served_stale_cache"],
						},
					},
					expected: true,
				},
			},
		]);

		expect(
			rules(
				lint(
					{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: asserted }] },
					{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
				),
				UNGUARDED_STALE,
			),
		).toEqual([]);
	});

	it("does not accept the operand as a literal outside an executed verdict", () => {
		// An `inputTemplate` value and a `reasonKey` both carry the exact string;
		// a substring search over the serialized scenario would call this guarded.
		const markedRead: HealthStep = {
			...readStep(OPERATION_KEY),
			kind: "operation",
			operationId: OPERATION_KEY,
			inputTemplate: { marker: "served_stale_cache" },
		};
		const decoy = scenario([
			markedRead,
			rowsGuard(OPERATION_KEY, `health.operations.${OPERATION_KEY}.probe.served_stale_cache`),
		]);

		expect(
			rules(
				lint(
					{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: decoy }] },
					{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
				),
				UNGUARDED_STALE,
			),
		).toHaveLength(1);
	});

	it("does not accept a payload field that happens to be named the same", () => {
		const payloadRef = scenario([
			READ_STEP,
			{
				id: "guard-payload",
				result: "payload-guarded",
				kind: "guard",
				condition: {
					kind: "predicate",
					operator: "not_equals",
					actual: {
						ref: {
							namespace: "steps",
							binding: `${OPERATION_KEY}-response`,
							path: ["data", "served_stale_cache"],
						},
					},
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
			},
		]);

		expect(
			rules(
				lint(
					{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: payloadRef }] },
					{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
				),
				UNGUARDED_STALE,
			),
		).toHaveLength(1);
	});

	it("does not accept the operand read off a non-operation step binding", () => {
		const extractRef = scenario([
			READ_STEP,
			{
				id: "pull",
				result: "extracted",
				kind: "extract",
				from: {
					namespace: "steps",
					binding: `${OPERATION_KEY}-response`,
					path: ["data"],
				},
				selector: {
					root: "$",
					segments: [
						{ kind: "property", name: "items" },
						{ kind: "index", index: 0 },
					],
				},
				valueType: "object",
				required: true,
			},
			freshnessGuard(OPERATION_KEY, "extracted"),
		]);

		expect(
			rules(
				lint(
					{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: extractRef }] },
					{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
				),
				UNGUARDED_STALE,
			),
		).toHaveLength(1);
	});

	it("ignores staleIfErrorMs that only appears in non-serving sources", () => {
		expect(
			rules(
				lint(
					{
						interval: "1h",
						cases: [{ name: "dense", input: {}, scenario: scenario([READ_STEP]) }],
					},
					{
						providerSourceFiles: {
							"__tests__/client.test.ts": "expect(options.staleIfErrorMs).toBe(300_000);",
							"upstream/client.spec.ts": "staleIfErrorMs: 300_000",
							"tests/cache.ts": "staleIfErrorMs: 300_000",
							"__mocks__/cache.ts": "staleIfErrorMs: 300_000",
						},
					},
				),
				UNGUARDED_STALE,
			),
		).toEqual([]);
	});

	it("ignores a comment documenting that stale-if-error is deliberately unused", () => {
		expect(
			rules(
				lint(
					{
						interval: "1h",
						cases: [{ name: "dense", input: {}, scenario: scenario([READ_STEP]) }],
					},
					{
						providerSourceFiles: {
							"upstream/client.ts":
								"// staleIfErrorMs intentionally not used: an alert feed must never answer stale.\n/* staleIfErrorMs: 300_000 was removed in #12 */\nawait ctx.cache.getOrSet(key, load, { ttlMs: 60_000 });",
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
				{ operationSource: STALE_CLIENT },
			),
			UNGUARDED_STALE,
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain(`operations.${OPERATION_KEY} handler`);
		// Handler evidence names the serving operation exactly, so no caveat.
		expect(diagnostics[0]?.message).not.toContain("cannot attribute to one operation");
	});

	it("lists only the operations whose own handler serves stale", () => {
		const diagnostics = rules(
			lintFleet({
				staleOp: {
					...operation({
						interval: "1h",
						cases: [
							{ name: "stale", input: {}, scenario: scenario([readStep("staleOp")], "staleOp") },
						],
					}),
					source: STALE_CLIENT,
				},
				plainOp: {
					...operation({
						interval: "1h",
						cases: [
							{ name: "plain", input: {}, scenario: scenario([readStep("plainOp")], "plainOp") },
						],
					}),
					source: "return upstream.read(input);",
				},
			}),
			UNGUARDED_STALE,
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain('staleOp "stale"');
		expect(diagnostics[0]?.message).not.toContain('plainOp "plain"');
	});

	it("degrades to provider-wide when any file also carries the cache call", () => {
		// `getOperationSource` returns the runtime's `handler.toString()`, which
		// type erasure and reformatting make textually unequal to the TypeScript
		// on disk, so a file cannot be matched back to the handler that declares
		// it. File evidence therefore widens the listing, with the caveat saying
		// so — over-listing at warn level, never a silent pass.
		const diagnostics = rules(
			lintFleet(
				{
					staleOp: {
						...operation({
							interval: "1h",
							cases: [
								{
									name: "stale",
									input: {},
									scenario: scenario([readStep("staleOp")], "staleOp"),
								},
							],
						}),
						source: STALE_CLIENT,
					},
					plainOp: {
						...operation({
							interval: "1h",
							cases: [
								{
									name: "plain",
									input: {},
									scenario: scenario([readStep("plainOp")], "plainOp"),
								},
							],
						}),
						source: "return upstream.read(input);",
					},
				},
				{ "operations/stale-op.ts": `export const handler = async () => {\n${STALE_CLIENT}\n};` },
			),
			UNGUARDED_STALE,
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain('staleOp "stale"');
		expect(diagnostics[0]?.message).toContain('plainOp "plain"');
		expect(diagnostics[0]?.message).toContain("cannot attribute to one operation");
	});

	it("says so when a helper the linter cannot attribute carries the cache call", () => {
		const diagnostics = rules(
			lint(
				{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: scenario([READ_STEP]) }] },
				{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
			),
			UNGUARDED_STALE,
		);

		expect(diagnostics[0]?.message).toContain("cannot attribute to one operation");
	});

	it("recognises the shorthand cache option", () => {
		expect(
			rules(
				lint(
					{
						interval: "1h",
						cases: [{ name: "dense", input: {}, scenario: scenario([READ_STEP]) }],
					},
					{
						providerSourceFiles: {
							"upstream/client.ts":
								"const staleIfErrorMs = 300_000;\nawait ctx.cache.getOrSet(key, load, { ttlMs, staleIfErrorMs });",
						},
					},
				),
				UNGUARDED_STALE,
			),
		).toHaveLength(1);
	});

	it("stays unattributed when a shared helper shares a file with a handler", () => {
		// Removing the attributed handler's own text still leaves the helper's
		// call, so the sibling operation's uncovered probe must still be listed.
		const diagnostics = rules(
			lintFleet(
				{
					staleOp: {
						...operation({
							interval: "1h",
							cases: [
								{
									name: "stale",
									input: {},
									scenario: scenario([readStep("staleOp"), freshnessGuard("staleOp")], "staleOp"),
								},
							],
						}),
						source: STALE_CLIENT,
					},
					siblingOp: {
						...operation({
							interval: "1h",
							cases: [
								{
									name: "sibling",
									input: {},
									scenario: scenario([readStep("siblingOp")], "siblingOp"),
								},
							],
						}),
						source: "return sharedRead(input);",
					},
				},
				{
					"upstream/client.ts": `${STALE_CLIENT}\nexport const sharedRead = async () => ${STALE_CLIENT}`,
				},
			),
			UNGUARDED_STALE,
		);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain('siblingOp "sibling"');
		expect(diagnostics[0]?.message).toContain("cannot attribute to one operation");
	});

	it("rejects a freshness clause that passes for a stale serve", () => {
		const weakConditions: AssertionExpression[] = [
			{
				kind: "predicate",
				operator: "exists",
				actual: {
					ref: {
						namespace: "steps",
						binding: `${OPERATION_KEY}-response`,
						path: ["served_stale_cache"],
					},
				},
			},
			{
				kind: "predicate",
				operator: "type_is",
				actual: {
					ref: {
						namespace: "steps",
						binding: `${OPERATION_KEY}-response`,
						path: ["served_stale_cache"],
					},
				},
				expected: "boolean",
			},
			{
				kind: "any",
				clauses: [
					{
						kind: "predicate",
						operator: "status_2xx",
						actual: {
							ref: {
								namespace: "steps",
								binding: `${OPERATION_KEY}-response`,
								path: ["status_code"],
							},
						},
					},
					{
						kind: "predicate",
						operator: "not_equals",
						actual: {
							ref: {
								namespace: "steps",
								binding: `${OPERATION_KEY}-response`,
								path: ["served_stale_cache"],
							},
						},
						expected: true,
					},
				],
			},
		];
		for (const condition of weakConditions) {
			const weak = scenario([READ_STEP, conditionGuard(condition)]);

			expect(
				rules(
					lint(
						{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: weak }] },
						{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
					),
					UNGUARDED_STALE,
				),
			).toHaveLength(1);
		}
	});

	it("accepts the equivalent forms that do reject a stale serve", () => {
		const operand = {
			ref: {
				namespace: "steps" as const,
				binding: `${OPERATION_KEY}-response`,
				path: ["served_stale_cache"],
			},
		};
		const strongConditions: AssertionExpression[] = [
			{ kind: "predicate", operator: "equals", actual: operand, expected: false },
			{
				kind: "not",
				clause: { kind: "predicate", operator: "is_true", actual: operand },
			},
			{
				kind: "all",
				clauses: [
					{
						kind: "predicate",
						operator: "status_2xx",
						actual: {
							ref: {
								namespace: "steps",
								binding: `${OPERATION_KEY}-response`,
								path: ["status_code"],
							},
						},
					},
					{ kind: "predicate", operator: "not_equals", actual: operand, expected: true },
				],
			},
		];
		for (const condition of strongConditions) {
			const strong = scenario([READ_STEP, conditionGuard(condition)]);

			expect(
				rules(
					lint(
						{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: strong }] },
						{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
					),
					UNGUARDED_STALE,
				),
			).toEqual([]);
		}
	});

	it("does not accept a freshness guard placed after another guard", () => {
		// A row guard firing first stops the scenario and attributes a stale,
		// empty serve to "no rows" — the reason the guidance orders freshness
		// first. A later freshness guard is shadowed and is not coverage.
		const misordered = scenario([
			READ_STEP,
			rowsGuard(OPERATION_KEY, `health.operations.${OPERATION_KEY}.probe.noRows`),
			FRESHNESS_GUARD,
		]);

		expect(
			rules(
				lint(
					{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: misordered }] },
					{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
				),
				UNGUARDED_STALE,
			),
		).toHaveLength(1);
	});

	it("accepts the freshness guard placed before a row guard", () => {
		const ordered = scenario([
			READ_STEP,
			FRESHNESS_GUARD,
			rowsGuard(OPERATION_KEY, `health.operations.${OPERATION_KEY}.probe.noRows`),
		]);

		expect(
			rules(
				lint(
					{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: ordered }] },
					{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
				),
				UNGUARDED_STALE,
			),
		).toEqual([]);
	});

	it("accepts the freshness reference written on the expected side", () => {
		const mirrored = conditionGuard({
			kind: "predicate",
			operator: "equals",
			actual: false,
			expected: {
				ref: {
					namespace: "steps",
					binding: `${OPERATION_KEY}-response`,
					path: ["served_stale_cache"],
				},
			},
		});

		expect(
			rules(
				lint(
					{
						interval: "1h",
						cases: [{ name: "dense", input: {}, scenario: scenario([READ_STEP, mirrored]) }],
					},
					{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
				),
				UNGUARDED_STALE,
			),
		).toEqual([]);
	});

	it("does not accept a freshness guard that degrades a different operation", () => {
		const misattributed: HealthStep = {
			...conditionGuard({
				kind: "predicate",
				operator: "not_equals",
				actual: {
					ref: {
						namespace: "steps",
						binding: `${OPERATION_KEY}-response`,
						path: ["served_stale_cache"],
					},
				},
				expected: true,
			}),
			kind: "guard",
			condition: {
				kind: "predicate",
				operator: "not_equals",
				actual: {
					ref: {
						namespace: "steps",
						binding: `${OPERATION_KEY}-response`,
						path: ["served_stale_cache"],
					},
				},
				expected: true,
			},
			onFail: {
				attribute: [
					{
						operationId: "someOtherOperation",
						status: "degraded",
						reasonCode: "expected_absence",
						reasonKey: `health.operations.${OPERATION_KEY}.probe.servedStaleCache`,
					},
				],
				stop: "scenario",
			},
		};

		expect(
			rules(
				lint(
					{
						interval: "1h",
						cases: [{ name: "dense", input: {}, scenario: scenario([READ_STEP, misattributed]) }],
					},
					{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
				),
				UNGUARDED_STALE,
			),
		).toHaveLength(1);
	});

	it("requires a freshness check for each read when the scenario invokes twice", () => {
		const firstRead: HealthStep = {
			id: "read-first",
			result: "first-response",
			kind: "operation",
			operationId: OPERATION_KEY,
			inputTemplate: { page: 1 },
		};
		const secondRead: HealthStep = {
			id: "read-second",
			result: "second-response",
			kind: "operation",
			operationId: OPERATION_KEY,
			inputTemplate: { page: 2 },
		};
		const staleRef = (binding: string) => ({
			ref: { namespace: "steps" as const, binding, path: ["served_stale_cache"] },
		});
		// Guarding only the first read, and an `any` over both, each pass whenever
		// EITHER response is fresh — the second read can still be stale.
		const onlyFirst = scenario([
			firstRead,
			conditionGuard({
				kind: "predicate",
				operator: "not_equals",
				actual: staleRef("first-response"),
				expected: true,
			}),
			secondRead,
		]);
		const eitherOne = scenario([
			firstRead,
			secondRead,
			conditionGuard({
				kind: "any",
				clauses: [
					{
						kind: "predicate",
						operator: "not_equals",
						actual: staleRef("first-response"),
						expected: true,
					},
					{
						kind: "predicate",
						operator: "not_equals",
						actual: staleRef("second-response"),
						expected: true,
					},
				],
			}),
		]);

		for (const partial of [onlyFirst, eitherOne]) {
			expect(
				rules(
					lint(
						{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: partial }] },
						{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
					),
					UNGUARDED_STALE,
				),
			).toHaveLength(1);
		}

		const both = scenario([
			firstRead,
			conditionGuard({
				kind: "predicate",
				operator: "not_equals",
				actual: staleRef("first-response"),
				expected: true,
			}),
			secondRead,
			conditionGuard({
				kind: "predicate",
				operator: "not_equals",
				actual: staleRef("second-response"),
				expected: true,
			}),
		]);

		expect(
			rules(
				lint(
					{ interval: "1h", cases: [{ name: "dense", input: {}, scenario: both }] },
					{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
				),
				UNGUARDED_STALE,
			),
		).toEqual([]);
	});

	it("is not blinded by a string literal that looks like a comment opener", () => {
		// `"*/*"` opens a block comment to a stripping regex, which would swallow
		// the cache call that follows it.
		expect(
			rules(
				lint(
					{
						interval: "1h",
						cases: [{ name: "dense", input: {}, scenario: scenario([READ_STEP]) }],
					},
					{
						providerSourceFiles: {
							"upstream/client.ts": `const headers = { Accept: "*/*" };\n${STALE_CLIENT}\n/* cache policy reviewed 2026-09 */`,
						},
					},
				),
				UNGUARDED_STALE,
			),
		).toHaveLength(1);
	});

	it("does not ask for a freshness guard when the provider declares no health check", () => {
		expect(
			rules(
				lint(undefined, { providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } }),
				UNGUARDED_STALE,
			),
		).toEqual([]);
	});

	it("keeps both rules warning-level so the migrating fleet does not go red", () => {
		const diagnostics = lint(
			{ interval: "1h", cases: [{ name: "dense", input: {}, assertions: () => {} }] },
			{ providerSourceFiles: { "upstream/client.ts": STALE_CLIENT } },
		);

		const health = diagnostics.filter((diagnostic) =>
			[UNMONITORED, UNGUARDED_STALE].includes(diagnostic.rule),
		);
		expect(health).toHaveLength(2);
		expect(health.every((diagnostic) => diagnostic.level === "warn")).toBe(true);
	});
});
