/**
 * The operation `agent` contract: its zod shape, the declaration rules
 * `defineProvider` holds it to, and the locale keys it references (checked
 * against `locales/en.json` by `apifuse check`).
 *
 * The contract is data a model path reads; nothing here runs at request time.
 * Paths are dot paths into the operation's own input or output schema, so a
 * declaration that names a field the schema does not have fails the build
 * instead of being silently ignored by every consumer.
 */
import { type ZodType, z } from "zod";

import { isProviderLocaleKey } from "./i18n/keys.js";
import { isSchemaNode, schemaChildren, schemaDef } from "./schema-walk.js";
import type {
	OperationAgentContract,
	OperationDefinition,
	ProviderLocaleKeyInput,
} from "./types.js";

const LocaleKeySchema = z
	.string()
	.min(1)
	.refine(isProviderLocaleKey, { message: "must be a provider locale key (camelCase dot path)" });

const DotPathSchema = z.string().min(1);

/** A reference to another operation: `{op:<operationId>}` inside a sentence, or a bare id in `stateQuery`. */
const OperationIdSchema = z.string().min(1);

export const OperationAnnotationsSchema = z
	.object({
		readOnly: z.boolean().optional(),
		destructive: z.boolean().optional(),
		idempotent: z.boolean().optional(),
		openWorld: z.boolean().optional(),
	})
	.strict();

export const OperationHandleProducedSchema = z
	.object({
		kind: z.string().min(1),
		path: DotPathSchema,
		ttlMs: z.number().int().positive(),
	})
	.strict();

export const OperationHandleConsumedSchema = z
	.object({ field: DotPathSchema, kind: z.string().min(1) })
	.strict();

export const OperationHandlesSchema = z
	.object({
		produces: z.array(OperationHandleProducedSchema).optional(),
		consumes: z.array(OperationHandleConsumedSchema).optional(),
	})
	.strict();

export const OperationDetailFactSchema = z
	.object({
		path: DotPathSchema,
		textKey: LocaleKeySchema.optional(),
		values: z.record(z.string(), LocaleKeySchema).optional(),
		otherwiseKey: LocaleKeySchema.optional(),
	})
	.strict()
	.refine((fact) => fact.textKey !== undefined || fact.values !== undefined, {
		message: "a detail fact names textKey or values",
	});

export const OperationErrorOutcomeSchema = z.union([
	z.literal("not_sent"),
	z.literal("refused"),
	z.literal("unknown"),
	z
		.object({
			fromDetail: DotPathSchema,
			notSent: z.array(z.string()),
			refused: z.array(z.string()),
		})
		.strict(),
]);

export const OperationErrorGuidanceSchema = z
	.object({
		fixKey: LocaleKeySchema.optional(),
		retryHintKey: LocaleKeySchema.optional(),
		action: z.enum(["connect", "restart_flow"]).optional(),
		outcome: OperationErrorOutcomeSchema.optional(),
		stateQuery: OperationIdSchema.optional(),
		detailFacts: z.array(OperationDetailFactSchema).optional(),
	})
	.strict();

export const OperationInputNormalizerSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("closed_set"),
			aliases: z.record(z.string(), z.array(z.string())).optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("line"),
			grammar: z.enum(["key_value", "key_count", "lat_lng", "number_range"]),
			into: DotPathSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("map"),
			values: z.record(z.string(), z.union([z.number(), z.string()])),
		})
		.strict(),
]);

export const OperationCardProjectionSchema = z
	.object({
		id: DotPathSchema,
		title: DotPathSchema,
		subtitle: DotPathSchema.optional(),
		price: DotPathSchema.optional(),
		photos: DotPathSchema.optional(),
		url: DotPathSchema.optional(),
		eta: DotPathSchema.optional(),
		rating: DotPathSchema.optional(),
	})
	.strict();

export const OperationResultProjectionSchema = z
	.object({
		items: DotPathSchema.optional(),
		limit: z.number().int().positive().optional(),
		keep: z.array(DotPathSchema).optional(),
		drop: z.array(DotPathSchema).optional(),
		textLimit: z.number().int().positive().optional(),
		card: OperationCardProjectionSchema.optional(),
		sort: z
			.object({ by: DotPathSchema, order: z.enum(["asc", "desc"]) })
			.strict()
			.optional(),
		links: z.record(z.string(), z.string()).optional(),
	})
	.strict();

export const OperationResultFactSchema = z
	.object({
		when: z
			.object({
				path: DotPathSchema,
				equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
			})
			.strict(),
		textKey: LocaleKeySchema,
	})
	.strict();

export const OperationTermsSchema = z
	.object({
		cancellation: z
			.array(z.object({ field: DotPathSchema, meaningKey: LocaleKeySchema }).strict())
			.optional(),
		prePayment: z.array(OperationResultFactSchema).optional(),
	})
	.strict();

export const OperationAgentPolicySchema = z
	.object({
		dedupe: z
			.object({
				maxAgeMs: z.number().int().positive(),
				nonTerminalStatuses: z.array(z.string()).optional(),
			})
			.strict()
			.optional(),
		singleTargetPerTurn: z
			.object({ field: DotPathSchema, textKey: LocaleKeySchema })
			.strict()
			.optional(),
	})
	.strict();

export const OperationSecureInputSchema = z
	.object({
		selector: z.object({ field: DotPathSchema, values: z.array(z.string()).min(1) }).strict(),
	})
	.strict();

export const OperationAgentContractSchema = z
	.object({
		annotations: OperationAnnotationsSchema.optional(),
		serverOnly: z.array(DotPathSchema).optional(),
		handles: OperationHandlesSchema.optional(),
		secureInput: OperationSecureInputSchema.optional(),
		errors: z.record(z.string(), OperationErrorGuidanceSchema).optional(),
		normalizers: z.record(z.string(), OperationInputNormalizerSchema).optional(),
		projection: OperationResultProjectionSchema.optional(),
		facts: z.array(OperationResultFactSchema).optional(),
		terms: OperationTermsSchema.optional(),
		policy: OperationAgentPolicySchema.optional(),
	})
	.strict();

export const ProviderAgentContractSchema = z.object({ descriptionKey: LocaleKeySchema }).strict();

/** The key under which `errors` guidance applies to every code the table does not name. */
export const AGENT_ERROR_DEFAULT_KEY = "default";

/** The placeholder a sentence uses for another operation of the same provider: `{op:reserve-confirm}`. */
export const AGENT_OP_PLACEHOLDER_RE = /\{op:([^}]*)\}/g;

export const AGENT_CONTRACT_RULE_IDS = {
	shape: "agent-contract-shape",
	inputPath: "agent-input-path-exists",
	outputPath: "agent-output-path-exists",
	handleProducer: "agent-handle-producer-unique",
	errorCode: "agent-error-code-declared",
	localeKey: "agent-locale-key-exists",
	riskClassConsistent: "agent-annotations-risk-class-consistent",
	descriptionRequired: "agent-description-required",
	opPlaceholder: "agent-op-placeholder-resolves",
} as const;

export type AgentContractRuleId =
	(typeof AGENT_CONTRACT_RULE_IDS)[keyof typeof AGENT_CONTRACT_RULE_IDS];

export interface AgentContractViolation {
	readonly ruleId: AgentContractRuleId;
	readonly path: string;
	readonly message: string;
	readonly fix: string;
}

export type AgentContractOperation = Pick<
	OperationDefinition,
	"agent" | "input" | "output" | "riskClass" | "errors"
>;

export type AgentContractProvider = {
	readonly meta?: { readonly agent?: unknown };
	readonly operations?: Readonly<Record<string, AgentContractOperation>>;
};

/**
 * Whether `path` names a field of `schema`. Object properties are the named
 * steps; optional, nullable, default, pipe, array element, record value, tuple
 * item and union branch wrappers are transparent, so `offers.price` resolves
 * through an array of objects and `a.b` through `z.object({ a: z.object({ b })
 * .optional() })`. A record value matches any key; the `z.never()` catchall a
 * strict object carries rejects every unknown key and so matches none.
 */
export function schemaHasPath(schema: unknown, path: string): boolean {
	if (!isSchemaNode(schema)) return false;
	const segments = path.split(".");
	let frontier: ZodType[] = [schema];
	for (const segment of segments) {
		const next: ZodType[] = [];
		const seen = new Set<unknown>();
		const visit = (node: ZodType): void => {
			if (seen.has(node)) return;
			seen.add(node);
			for (const edge of schemaChildren(node)) {
				if (edge.kind === "property") {
					if (edge.key === segment) next.push(edge.schema);
					continue;
				}
				if (edge.kind === "entry") {
					// A record value or catchall takes any key, unless the catchall is
					// the `never` a strict object uses to reject unknown keys.
					if (schemaDef(edge.schema).type !== "never") next.push(edge.schema);
					continue;
				}
				visit(edge.schema);
			}
		};
		for (const node of frontier) visit(node);
		if (next.length === 0) return false;
		frontier = next;
	}
	return true;
}

/**
 * The codes an operation declares through `errors: [errors.CODE, ...]`. The
 * `defineErrors` declaration is the one source of an operation's codes; the
 * agent contract never reads a legacy `errorCodes` row.
 */
function declaredErrorCodes(operation: AgentContractOperation): Set<string> {
	const codes = new Set<string>();
	for (const factory of operation.errors ?? []) codes.add(factory.declaration.code);
	return codes;
}

function describeIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) =>
			issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
		)
		.join("; ");
}

/**
 * Every rule an operation `agent` block must hold, as violations. The locale
 * rule is not here: it needs the catalog files, which `defineProvider` does
 * not read; `validateAgentLocaleKeys` runs it from `apifuse check`.
 */
export function collectAgentContractViolations(
	provider: AgentContractProvider,
): AgentContractViolation[] {
	const violations: AgentContractViolation[] = [];
	const operations = provider.operations ?? {};
	const producers = new Map<string, string[]>();
	const parsed = new Map<string, OperationAgentContract>();
	let anyAgent = false;

	for (const [operationId, operation] of Object.entries(operations)) {
		if (operation.agent === undefined) continue;
		anyAgent = true;
		const base = `operations.${operationId}.agent`;
		const result = OperationAgentContractSchema.safeParse(operation.agent);
		if (!result.success) {
			violations.push({
				ruleId: AGENT_CONTRACT_RULE_IDS.shape,
				path: base,
				message: `agent contract is malformed: ${describeIssues(result.error)}`,
				fix: `Make ${base} match OperationAgentContract (unknown keys and wrong value types are rejected).`,
			});
			continue;
		}
		const agent = result.data as OperationAgentContract;
		parsed.set(operationId, agent);
		for (const handle of agent.handles?.produces ?? []) {
			producers.set(handle.kind, [...(producers.get(handle.kind) ?? []), operationId]);
		}
	}

	if (anyAgent) {
		const meta = provider.meta?.agent;
		const metaResult = ProviderAgentContractSchema.safeParse(meta);
		if (!metaResult.success) {
			violations.push({
				ruleId: AGENT_CONTRACT_RULE_IDS.descriptionRequired,
				path: "meta.agent.descriptionKey",
				message:
					meta === undefined
						? "an operation declares agent, so the provider must declare meta.agent.descriptionKey (the one-line factual description a model reads in a connector index)."
						: `meta.agent is malformed: ${describeIssues(metaResult.error)}`,
				fix: 'Add meta.agent: { descriptionKey: "meta.agent.description" } and the English sentence under that key in locales/en.json.',
			});
		}
	}

	for (const [operationId, agent] of parsed) {
		const operation = operations[operationId] as AgentContractOperation;
		const base = `operations.${operationId}.agent`;
		const inputPath = (path: string, where: string): void => {
			if (schemaHasPath(operation.input, path)) return;
			violations.push({
				ruleId: AGENT_CONTRACT_RULE_IDS.inputPath,
				path: `${base}.${where}`,
				message: `input path "${path}" does not exist in operations.${operationId}.input.`,
				fix: `Name a field of the input schema at ${base}.${where}, or add "${path}" to the input schema.`,
			});
		};
		const outputPath = (path: string, where: string): void => {
			if (schemaHasPath(operation.output, path)) return;
			violations.push({
				ruleId: AGENT_CONTRACT_RULE_IDS.outputPath,
				path: `${base}.${where}`,
				message: `output path "${path}" does not exist in operations.${operationId}.output.`,
				fix: `Name a field of the output schema at ${base}.${where}, or add "${path}" to the output schema.`,
			});
		};

		// Rule 1: input paths.
		for (const [index, field] of (agent.serverOnly ?? []).entries())
			inputPath(field, `serverOnly.${index}`);
		for (const [index, handle] of (agent.handles?.consumes ?? []).entries())
			inputPath(handle.field, `handles.consumes.${index}.field`);
		for (const [field, normalizer] of Object.entries(agent.normalizers ?? {})) {
			inputPath(field, `normalizers.${field}`);
			if (normalizer.kind === "line") inputPath(normalizer.into, `normalizers.${field}.into`);
		}
		if (agent.secureInput)
			inputPath(agent.secureInput.selector.field, "secureInput.selector.field");
		if (agent.policy?.singleTargetPerTurn)
			inputPath(agent.policy.singleTargetPerTurn.field, "policy.singleTargetPerTurn.field");

		// Rule 2: output paths.
		for (const [index, handle] of (agent.handles?.produces ?? []).entries())
			outputPath(handle.path, `handles.produces.${index}.path`);
		const projection = agent.projection;
		if (projection) {
			const itemBase = projection.items;
			if (itemBase !== undefined) outputPath(itemBase, "projection.items");
			const itemPath = (path: string): string =>
				itemBase === undefined ? path : `${itemBase}.${path}`;
			for (const [index, path] of (projection.keep ?? []).entries())
				outputPath(itemPath(path), `projection.keep.${index}`);
			for (const [index, path] of (projection.drop ?? []).entries())
				outputPath(itemPath(path), `projection.drop.${index}`);
			if (projection.sort) outputPath(itemPath(projection.sort.by), "projection.sort.by");
			for (const [field, path] of Object.entries(projection.card ?? {}))
				outputPath(itemPath(path), `projection.card.${field}`);
		}
		for (const [index, fact] of (agent.facts ?? []).entries())
			outputPath(fact.when.path, `facts.${index}.when.path`);
		for (const [index, term] of (agent.terms?.cancellation ?? []).entries())
			outputPath(term.field, `terms.cancellation.${index}.field`);
		for (const [index, fact] of (agent.terms?.prePayment ?? []).entries())
			outputPath(fact.when.path, `terms.prePayment.${index}.when.path`);

		// Rule 3: every consumed handle kind has exactly one producer in this provider.
		for (const [index, handle] of (agent.handles?.consumes ?? []).entries()) {
			const owners = producers.get(handle.kind) ?? [];
			if (owners.length === 1) continue;
			violations.push({
				ruleId: AGENT_CONTRACT_RULE_IDS.handleProducer,
				path: `${base}.handles.consumes.${index}.kind`,
				message:
					owners.length === 0
						? `no operation of this provider produces handle kind "${handle.kind}".`
						: `handle kind "${handle.kind}" is produced by ${owners.join(", ")}; one producer per kind.`,
				fix: `Declare handles.produces: [{ kind: "${handle.kind}", path, ttlMs }] on exactly one operation.`,
			});
		}
		for (const [kind, owners] of producers) {
			if (owners.length <= 1 || owners[0] !== operationId) continue;
			violations.push({
				ruleId: AGENT_CONTRACT_RULE_IDS.handleProducer,
				path: `${base}.handles.produces`,
				message: `handle kind "${kind}" is produced by ${owners.join(", ")}; one producer per kind.`,
				fix: `Keep handles.produces for kind "${kind}" on one operation and let the others consume it.`,
			});
		}

		// Rule 4: errors keys are declared error codes or "default".
		const codes = declaredErrorCodes(operation);
		for (const code of Object.keys(agent.errors ?? {})) {
			if (code === AGENT_ERROR_DEFAULT_KEY || codes.has(code)) continue;
			violations.push({
				ruleId: AGENT_CONTRACT_RULE_IDS.errorCode,
				path: `${base}.errors.${code}`,
				message: `"${code}" is not one of operations.${operationId}'s declared error codes.`,
				fix: `Declare ${code} in the operation's errors (defineErrors) or remove ${base}.errors.${code}; "default" covers undeclared codes.`,
			});
		}
		for (const [code, guidance] of Object.entries(agent.errors ?? {})) {
			if (guidance.stateQuery === undefined || Object.hasOwn(operations, guidance.stateQuery))
				continue;
			violations.push({
				ruleId: AGENT_CONTRACT_RULE_IDS.opPlaceholder,
				path: `${base}.errors.${code}.stateQuery`,
				message: `stateQuery names "${guidance.stateQuery}", which is not an operation of this provider.`,
				fix: `Name one of ${Object.keys(operations).join(", ")} at ${base}.errors.${code}.stateQuery.`,
			});
		}

		// Rule 6: annotations agree with riskClass (one fact, one home).
		const annotations = agent.annotations;
		if (
			annotations?.readOnly !== undefined &&
			annotations.readOnly !== (operation.riskClass === "read")
		) {
			violations.push({
				ruleId: AGENT_CONTRACT_RULE_IDS.riskClassConsistent,
				path: `${base}.annotations.readOnly`,
				message: `readOnly: ${annotations.readOnly} contradicts riskClass "${operation.riskClass}".`,
				fix: `Set annotations.readOnly to ${operation.riskClass === "read"} or drop it; riskClass is the source of truth.`,
			});
		}
		if (
			annotations?.destructive !== undefined &&
			annotations.destructive !== (operation.riskClass === "destructive")
		) {
			violations.push({
				ruleId: AGENT_CONTRACT_RULE_IDS.riskClassConsistent,
				path: `${base}.annotations.destructive`,
				message: `destructive: ${annotations.destructive} contradicts riskClass "${operation.riskClass}".`,
				fix: `Set annotations.destructive to ${operation.riskClass === "destructive"} or drop it; riskClass is the source of truth.`,
			});
		}
	}

	return violations;
}

export interface AgentLocaleKeyRef {
	/** Declaration path of the key (`operations.reserve.agent.errors.ATTEMPT_EXPIRED.fixKey`). */
	readonly path: string;
	readonly key: ProviderLocaleKeyInput;
}

/** Every locale key the provider's agent contracts reference, with where each is declared. */
export function collectAgentLocaleKeys(provider: AgentContractProvider): AgentLocaleKeyRef[] {
	const refs: AgentLocaleKeyRef[] = [];
	const meta = provider.meta?.agent;
	if (
		meta &&
		typeof meta === "object" &&
		typeof (meta as { descriptionKey?: unknown }).descriptionKey === "string"
	) {
		refs.push({
			path: "meta.agent.descriptionKey",
			key: (meta as { descriptionKey: string }).descriptionKey,
		});
	}
	for (const [operationId, operation] of Object.entries(provider.operations ?? {})) {
		const agent = operation.agent;
		if (agent === undefined) continue;
		const base = `operations.${operationId}.agent`;
		const push = (path: string, key: ProviderLocaleKeyInput | undefined): void => {
			if (key !== undefined) refs.push({ path, key });
		};
		for (const [code, guidance] of Object.entries(agent.errors ?? {})) {
			push(`${base}.errors.${code}.fixKey`, guidance.fixKey);
			push(`${base}.errors.${code}.retryHintKey`, guidance.retryHintKey);
			for (const [index, fact] of (guidance.detailFacts ?? []).entries()) {
				push(`${base}.errors.${code}.detailFacts.${index}.textKey`, fact.textKey);
				push(`${base}.errors.${code}.detailFacts.${index}.otherwiseKey`, fact.otherwiseKey);
				for (const [value, key] of Object.entries(fact.values ?? {}))
					push(`${base}.errors.${code}.detailFacts.${index}.values.${value}`, key);
			}
		}
		for (const [index, fact] of (agent.facts ?? []).entries())
			push(`${base}.facts.${index}.textKey`, fact.textKey);
		for (const [index, term] of (agent.terms?.cancellation ?? []).entries())
			push(`${base}.terms.cancellation.${index}.meaningKey`, term.meaningKey);
		for (const [index, fact] of (agent.terms?.prePayment ?? []).entries())
			push(`${base}.terms.prePayment.${index}.textKey`, fact.textKey);
		push(`${base}.policy.singleTargetPerTurn.textKey`, agent.policy?.singleTargetPerTurn?.textKey);
	}
	return refs;
}

function localeValueAt(catalog: Record<string, unknown>, key: string): unknown {
	let current: unknown = catalog;
	for (const segment of key.split(".")) {
		if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/** The operation ids a sentence names through `{op:<id>}`. */
export function agentOperationPlaceholders(text: string): string[] {
	return Array.from(text.matchAll(AGENT_OP_PLACEHOLDER_RE), (match) => match[1] ?? "");
}

/**
 * Rule 5 and the placeholder rule, against the English catalog: every key the
 * agent contracts reference resolves to non-empty text, and every
 * `{op:<id>}` inside that text names an operation of this provider. Run by
 * `apifuse check`; one violation per missing key or unknown placeholder.
 */
export function validateAgentLocaleKeys(input: {
	readonly provider: AgentContractProvider;
	readonly catalog: Record<string, unknown>;
}): AgentContractViolation[] {
	const violations: AgentContractViolation[] = [];
	const operationIds = new Set(Object.keys(input.provider.operations ?? {}));
	for (const ref of collectAgentLocaleKeys(input.provider)) {
		const value = localeValueAt(input.catalog, ref.key);
		if (typeof value !== "string" || value.trim().length === 0) {
			violations.push({
				ruleId: AGENT_CONTRACT_RULE_IDS.localeKey,
				path: ref.path,
				message: `locale key "${ref.key}" is missing from locales/en.json (or is not a non-empty string).`,
				fix: `Add "${ref.key}" to locales/en.json; other locales are optional and fall back to English.`,
			});
			continue;
		}
		for (const operationId of agentOperationPlaceholders(value)) {
			if (operationIds.has(operationId)) continue;
			violations.push({
				ruleId: AGENT_CONTRACT_RULE_IDS.opPlaceholder,
				path: ref.path,
				message: `locale key "${ref.key}" names {op:${operationId}}, which is not an operation of this provider.`,
				fix: `Use {op:<operationId>} with one of ${Array.from(operationIds).join(", ")}; a sentence never names a host tool by its own name.`,
			});
		}
	}
	return violations;
}
