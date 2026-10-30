import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
	AGENT_CONTRACT_RULE_IDS,
	type AgentContractViolation,
	collectAgentContractViolations,
	collectAgentLocaleKeys,
	schemaHasPath,
	validateAgentLocaleKeys,
} from "../agent-contract.js";
import { extractProviderContract } from "../contract.js";
import {
	DECLARATION_INVALID_CODE,
	DECLARATION_RULE_IDS,
	validateFailClosedDeclaration,
} from "../declaration-validation.js";
import { defineErrors } from "../define-errors.js";
import { isProviderError } from "../errors.js";
import type {
	OperationAgentContract,
	OperationDefinition,
	OperationRiskClass,
	ProviderDefinition,
} from "../types.js";
import { defineTestProvider as defineProvider } from "./test-utils.js";

const errors = defineErrors({
	ATTEMPT_EXPIRED: { status: 410, category: "input_validation", description: "expired" },
	RESERVATION_REFUSED: { status: 409, category: "upstream_rejected", description: "refused" },
});

const reserveOutput = z.object({
	attempt_token: z.string(),
	status: z.enum(["needs_input", "ready"]),
	summary: z.object({ pay_now_krw: z.number(), confirmation_type: z.string() }).optional(),
});

const confirmInput = z.object({
	attempt_token: z.string(),
	payment_method: z.enum(["none", "catch_pay"]),
	payment: z.object({ pin: z.string() }).optional(),
});

const confirmOutput = z.object({
	reservation_ref: z.string(),
	status: z.string(),
	deposit_refund_policy: z.string().optional(),
	offers: z.array(z.object({ id: z.string(), name: z.string(), price_krw: z.number() })),
});

const RESERVE_CONFIRM_AGENT: OperationAgentContract = {
	annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
	serverOnly: ["payment", "attempt_token"],
	secureInput: { selector: { field: "payment_method", values: ["catch_pay"] } },
	handles: { consumes: [{ field: "attempt_token", kind: "attempt" }] },
	policy: { dedupe: { maxAgeMs: 60_000, nonTerminalStatuses: ["needs_input", "ready"] } },
	errors: {
		default: { outcome: "unknown", stateQuery: "reserve" },
		ATTEMPT_EXPIRED: {
			outcome: "not_sent",
			action: "restart_flow",
			fixKey: "operations.reserveConfirm.agent.errors.ATTEMPT_EXPIRED.fix",
		},
		RESERVATION_REFUSED: {
			outcome: { fromDetail: "dispatched", notSent: ["false"], refused: ["refused"] },
			detailFacts: [
				{ path: "upstream_message", textKey: "operations.reserveConfirm.agent.ownWords" },
			],
		},
	},
	projection: {
		items: "offers",
		limit: 5,
		keep: ["id", "name"],
		card: { id: "id", title: "name", price: "price_krw" },
		sort: { by: "price_krw", order: "asc" },
	},
	facts: [
		{
			when: { path: "status", equals: "AWAITING" },
			textKey: "operations.reserveConfirm.agent.awaiting",
		},
	],
	terms: {
		cancellation: [
			{
				field: "deposit_refund_policy",
				meaningKey: "operations.reserveConfirm.agent.terms.deposit",
			},
		],
	},
};

function operation(
	riskClass: OperationRiskClass,
	overrides: Partial<OperationDefinition> = {},
): OperationDefinition {
	return {
		riskClass,
		descriptionKey: "operations.op.description",
		healthCheckUnsupported: { reason: "Not exercised by this declaration fixture." },
		input: z.object({}),
		output: z.object({ ok: z.boolean() }),
		handler: async () => ({ ok: true }),
		...overrides,
	} as OperationDefinition;
}

function provider(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
	return {
		allowedHosts: ["example.com"],
		reviewed: "community",
		id: "agent-contract-test-provider",
		version: "1.0.0",
		runtime: "standard",
		meta: {
			displayName: "Agent Contract Test",
			descriptionKey: "meta.description",
			category: "test",
			agent: { descriptionKey: "meta.agent.description" },
		},
		operations: {
			reserve: operation("write", {
				output: reserveOutput,
				agent: {
					handles: { produces: [{ kind: "attempt", path: "attempt_token", ttlMs: 7_200_000 }] },
				},
			}),
			"reserve-confirm": operation("write", {
				input: confirmInput,
				output: confirmOutput,
				errors: [errors.ATTEMPT_EXPIRED, errors.RESERVATION_REFUSED],
				agent: RESERVE_CONFIRM_AGENT,
			}),
		},
		...overrides,
	};
}

function withConfirmAgent(agent: OperationAgentContract): ProviderDefinition {
	const base = provider();
	return {
		...base,
		operations: {
			...base.operations,
			"reserve-confirm": { ...(base.operations["reserve-confirm"] as OperationDefinition), agent },
		},
	};
}

function rulesOf(violations: readonly AgentContractViolation[]): string[] {
	return violations.map((violation) => `${violation.ruleId} @ ${violation.path}`);
}

describe("schemaHasPath", () => {
	const schema = z.object({
		offers: z.array(
			z.object({ price: z.number().optional(), tags: z.record(z.string(), z.string()) }),
		),
		summary: z.object({ total: z.number() }).nullable().optional(),
		either: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
	});

	it("resolves properties through arrays, wrappers, unions and records", () => {
		expect(schemaHasPath(schema, "offers")).toBe(true);
		expect(schemaHasPath(schema, "offers.price")).toBe(true);
		expect(schemaHasPath(schema, "offers.tags.anything")).toBe(true);
		expect(schemaHasPath(schema, "summary.total")).toBe(true);
		expect(schemaHasPath(schema, "either.a")).toBe(true);
		expect(schemaHasPath(schema, "either.b")).toBe(true);
	});

	it("rejects a path the schema does not have", () => {
		expect(schemaHasPath(schema, "offers.cost")).toBe(false);
		expect(schemaHasPath(schema, "summary.total.cents")).toBe(false);
		expect(schemaHasPath(schema, "missing")).toBe(false);
		expect(schemaHasPath(undefined, "offers")).toBe(false);
	});
});

describe("operation agent contract rules", () => {
	it("accepts the design's reserve-confirm declaration without a violation", () => {
		expect(collectAgentContractViolations(provider())).toEqual([]);
	});

	it("rule shape: an unknown key or a wrong value type is rejected under agent-contract-shape", () => {
		const violations = collectAgentContractViolations(
			withConfirmAgent({ ...RESERVE_CONFIRM_AGENT, annotations: { credentialed: true } } as never),
		);
		expect(rulesOf(violations)).toEqual([
			`${AGENT_CONTRACT_RULE_IDS.shape} @ operations.reserve-confirm.agent`,
		]);
	});

	it("rule 1: serverOnly, consumed handle fields, normalizer keys and selector fields must be input paths", () => {
		const violations = collectAgentContractViolations(
			withConfirmAgent({
				...RESERVE_CONFIRM_AGENT,
				serverOnly: ["payment", "nope"],
				handles: { consumes: [{ field: "ghost_token", kind: "attempt" }] },
				normalizers: { phantom: { kind: "closed_set" } },
				secureInput: { selector: { field: "method", values: ["catch_pay"] } },
			}),
		);
		expect(rulesOf(violations)).toEqual([
			`${AGENT_CONTRACT_RULE_IDS.inputPath} @ operations.reserve-confirm.agent.serverOnly.1`,
			`${AGENT_CONTRACT_RULE_IDS.inputPath} @ operations.reserve-confirm.agent.handles.consumes.0.field`,
			`${AGENT_CONTRACT_RULE_IDS.inputPath} @ operations.reserve-confirm.agent.normalizers.phantom`,
			`${AGENT_CONTRACT_RULE_IDS.inputPath} @ operations.reserve-confirm.agent.secureInput.selector.field`,
		]);
	});

	it("rule 2: produced handle paths, projection paths, facts and terms must be output paths", () => {
		const violations = collectAgentContractViolations(
			withConfirmAgent({
				...RESERVE_CONFIRM_AGENT,
				projection: { items: "offers", keep: ["id", "cost"], card: { id: "id", title: "label" } },
				facts: [{ when: { path: "state" }, textKey: "operations.reserveConfirm.agent.awaiting" }],
				terms: {
					cancellation: [
						{ field: "refund_policy", meaningKey: "operations.reserveConfirm.agent.terms.deposit" },
					],
				},
			}),
		);
		expect(rulesOf(violations)).toEqual([
			`${AGENT_CONTRACT_RULE_IDS.outputPath} @ operations.reserve-confirm.agent.projection.keep.1`,
			`${AGENT_CONTRACT_RULE_IDS.outputPath} @ operations.reserve-confirm.agent.projection.card.title`,
			`${AGENT_CONTRACT_RULE_IDS.outputPath} @ operations.reserve-confirm.agent.facts.0.when.path`,
			`${AGENT_CONTRACT_RULE_IDS.outputPath} @ operations.reserve-confirm.agent.terms.cancellation.0.field`,
		]);
		const produced = collectAgentContractViolations({
			...provider(),
			operations: {
				reserve: operation("write", {
					output: reserveOutput,
					agent: { handles: { produces: [{ kind: "attempt", path: "token", ttlMs: 1 }] } },
				}),
			},
		});
		expect(rulesOf(produced)).toEqual([
			`${AGENT_CONTRACT_RULE_IDS.outputPath} @ operations.reserve.agent.handles.produces.0.path`,
		]);
	});

	it("rule 3: a consumed handle kind has exactly one producer in the provider", () => {
		const base = provider();
		const noProducer = collectAgentContractViolations({
			...base,
			operations: { "reserve-confirm": base.operations["reserve-confirm"] as OperationDefinition },
		});
		expect(rulesOf(noProducer)).toContain(
			`${AGENT_CONTRACT_RULE_IDS.handleProducer} @ operations.reserve-confirm.agent.handles.consumes.0.kind`,
		);
		const twoProducers = collectAgentContractViolations({
			...base,
			operations: {
				...base.operations,
				"reserve-again": operation("write", {
					output: reserveOutput,
					agent: { handles: { produces: [{ kind: "attempt", path: "attempt_token", ttlMs: 1 }] } },
				}),
			},
		});
		expect(rulesOf(twoProducers)).toContain(
			`${AGENT_CONTRACT_RULE_IDS.handleProducer} @ operations.reserve-confirm.agent.handles.consumes.0.kind`,
		);
		expect(rulesOf(twoProducers)).toContain(
			`${AGENT_CONTRACT_RULE_IDS.handleProducer} @ operations.reserve.agent.handles.produces`,
		);
	});

	it("rule 4: errors keys are the operation's declared codes or default", () => {
		const violations = collectAgentContractViolations(
			withConfirmAgent({
				...RESERVE_CONFIRM_AGENT,
				errors: { ...RESERVE_CONFIRM_AGENT.errors, SLOT_UNAVAILABLE: { outcome: "not_sent" } },
			}),
		);
		expect(rulesOf(violations)).toEqual([
			`${AGENT_CONTRACT_RULE_IDS.errorCode} @ operations.reserve-confirm.agent.errors.SLOT_UNAVAILABLE`,
		]);
	});

	it("rule 4 also reads codes from the deprecated errorCodes table", () => {
		const base = provider();
		const confirm = base.operations["reserve-confirm"] as OperationDefinition;
		const violations = collectAgentContractViolations({
			...base,
			operations: {
				...base.operations,
				"reserve-confirm": {
					...confirm,
					errors: undefined,
					errorCodes: [
						{ code: "ATTEMPT_EXPIRED", description: "expired" },
						{ code: "RESERVATION_REFUSED", description: "refused" },
					],
				},
			},
		});
		expect(violations).toEqual([]);
	});

	it("rule 6: readOnly and destructive must agree with riskClass", () => {
		const violations = collectAgentContractViolations(
			withConfirmAgent({
				...RESERVE_CONFIRM_AGENT,
				annotations: { readOnly: true, destructive: true },
			}),
		);
		expect(rulesOf(violations)).toEqual([
			`${AGENT_CONTRACT_RULE_IDS.riskClassConsistent} @ operations.reserve-confirm.agent.annotations.readOnly`,
			`${AGENT_CONTRACT_RULE_IDS.riskClassConsistent} @ operations.reserve-confirm.agent.annotations.destructive`,
		]);
		const readOp = collectAgentContractViolations({
			...provider(),
			operations: {
				ping: operation("read", { agent: { annotations: { readOnly: true, destructive: false } } }),
			},
		});
		expect(readOp).toEqual([]);
	});

	it("a provider with any operation agent must declare meta.agent.descriptionKey", () => {
		const base = provider();
		const violations = collectAgentContractViolations({
			...base,
			meta: { ...base.meta, agent: undefined },
		});
		expect(rulesOf(violations)).toEqual([
			`${AGENT_CONTRACT_RULE_IDS.descriptionRequired} @ meta.agent.descriptionKey`,
		]);
		const none = collectAgentContractViolations({
			...base,
			meta: { ...base.meta, agent: undefined },
			operations: { ping: operation("read") },
		});
		expect(none).toEqual([]);
	});

	it("stateQuery must name an operation of the provider", () => {
		const violations = collectAgentContractViolations(
			withConfirmAgent({
				...RESERVE_CONFIRM_AGENT,
				errors: { default: { outcome: "unknown", stateQuery: "my-status" } },
			}),
		);
		expect(rulesOf(violations)).toEqual([
			`${AGENT_CONTRACT_RULE_IDS.opPlaceholder} @ operations.reserve-confirm.agent.errors.default.stateQuery`,
		]);
	});
});

describe("agent contract in defineProvider", () => {
	it("fails the build with the rule name", () => {
		let caught: unknown;
		try {
			validateFailClosedDeclaration(
				withConfirmAgent({ ...RESERVE_CONFIRM_AGENT, serverOnly: ["nope"] }),
			);
		} catch (error) {
			caught = error;
		}
		expect(isProviderError(caught)).toBe(true);
		if (!isProviderError(caught)) throw caught;
		expect(caught.code).toBe(DECLARATION_INVALID_CODE);
		expect(caught.message).toContain(`[${DECLARATION_RULE_IDS.agentInputPath}]`);
	});

	it("defineProvider rejects a broken declaration and accepts the design example", () => {
		const base = provider();
		expect(() =>
			defineProvider({
				...base,
				operations: {
					...base.operations,
					"reserve-confirm": {
						...(base.operations["reserve-confirm"] as OperationDefinition),
						agent: { ...RESERVE_CONFIRM_AGENT, annotations: { destructive: true } },
					},
				},
			}),
		).toThrow(expect.objectContaining({ code: DECLARATION_INVALID_CODE }));
		const built = defineProvider(base);
		expect(built.operations["reserve-confirm"]?.agent).toEqual(RESERVE_CONFIRM_AGENT);
		expect(built.meta.agent).toEqual({ descriptionKey: "meta.agent.description" });
	});

	it("the contract snapshot carries agent verbatim and omits it when absent", () => {
		const snapshot = extractProviderContract(provider());
		const confirm = snapshot.operations.find((entry) => entry.id === "reserve-confirm");
		expect(confirm?.agent).toEqual(JSON.parse(JSON.stringify(RESERVE_CONFIRM_AGENT)));
		const reserve = snapshot.operations.find((entry) => entry.id === "reserve");
		expect(reserve?.agent).toEqual({
			handles: { produces: [{ kind: "attempt", path: "attempt_token", ttlMs: 7_200_000 }] },
		});
		expect((snapshot.meta as { agent?: unknown }).agent).toEqual({
			descriptionKey: "meta.agent.description",
		});
		const plain = extractProviderContract({
			...provider(),
			operations: { ping: operation("read") },
		});
		expect("agent" in (plain.operations[0] ?? {})).toBe(false);
	});
});

describe("rule 5: agent locale keys", () => {
	const catalog = {
		meta: { agent: { description: "Test reservations: reserve, confirm" } },
		operations: {
			reserveConfirm: {
				agent: {
					errors: { ATTEMPT_EXPIRED: { fix: "Start again with {op:reserve}." } },
					ownWords: "CatchTable said: {value}",
					awaiting: "The shop confirms later.",
					terms: { deposit: "How the deposit is refunded." },
				},
			},
		},
	};

	it("lists every referenced key with its declaration path", () => {
		expect(collectAgentLocaleKeys(provider()).map((ref) => ref.key)).toEqual([
			"meta.agent.description",
			"operations.reserveConfirm.agent.errors.ATTEMPT_EXPIRED.fix",
			"operations.reserveConfirm.agent.ownWords",
			"operations.reserveConfirm.agent.awaiting",
			"operations.reserveConfirm.agent.terms.deposit",
		]);
	});

	it("passes when every key resolves and every {op:} names an operation", () => {
		expect(validateAgentLocaleKeys({ provider: provider(), catalog })).toEqual([]);
	});

	it("reports a missing key under agent-locale-key-exists", () => {
		const violations = validateAgentLocaleKeys({
			provider: provider(),
			catalog: { ...catalog, meta: {} },
		});
		expect(rulesOf(violations)).toEqual([
			`${AGENT_CONTRACT_RULE_IDS.localeKey} @ meta.agent.descriptionKey`,
		]);
	});

	it("reports an {op:} placeholder that names no operation", () => {
		const violations = validateAgentLocaleKeys({
			provider: provider(),
			catalog: {
				...catalog,
				operations: {
					reserveConfirm: {
						agent: {
							...catalog.operations.reserveConfirm.agent,
							errors: { ATTEMPT_EXPIRED: { fix: "Call catchtable_reserve, then {op:my-status}." } },
						},
					},
				},
			},
		});
		expect(rulesOf(violations)).toEqual([
			`${AGENT_CONTRACT_RULE_IDS.opPlaceholder} @ operations.reserve-confirm.agent.errors.ATTEMPT_EXPIRED.fixKey`,
		]);
	});
});
