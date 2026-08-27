import { z } from "zod";
import type { JsonPrimitive, JsonValue } from "./contract-json.js";
export type NonEmpty<T> = readonly [T, ...T[]];

const finiteInt = (min: number, max?: number) => {
	const schema = z.number().finite().int().min(min);
	return max === undefined ? schema : schema.max(max);
};

const nonEmptyArray = <T>(schema: z.ZodType<T>) =>
	z
		.array(schema)
		.min(1)
		.transform((value) => value as [T, ...T[]]);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		z.array(jsonValueSchema),
		z.record(z.string(), jsonValueSchema),
	]),
);

const pathPartSchema = z.union([z.string().min(1), finiteInt(0, 10_000)]);

const propertyNameSchema = z
	.string()
	.min(1)
	.superRefine((value, ctx) => {
		if (new TextEncoder().encode(value).byteLength > 128)
			ctx.addIssue({ code: "custom", message: "property name exceeds 128 UTF-8 bytes" });
	});

const pathSegmentSchema = z.union([
	z.object({ kind: z.literal("property"), name: propertyNameSchema }).strict(),
	z.object({ kind: z.literal("index"), index: finiteInt(0, 10_000) }).strict(),
]);

export const BoundedJsonPathSchema = z
	.object({ root: z.literal("$"), segments: z.array(pathSegmentSchema).max(12) })
	.strict();
export type BoundedJsonPath = z.infer<typeof BoundedJsonPathSchema>;

const valueTypeSchema = z.enum([
	"null",
	"boolean",
	"number",
	"string",
	"object",
	"array",
	"json",
	"established_connection",
]);
export const ValueTypeSchema = valueTypeSchema;
export type ValueType = z.infer<typeof valueTypeSchema>;

const stepReferenceSchema = z
	.object({
		namespace: z.literal("steps"),
		binding: z.string().min(1),
		path: z.array(pathPartSchema).min(1).max(12),
	})
	.strict();
export const StepReferenceSchema = stepReferenceSchema;
export type StepReference = z.infer<typeof stepReferenceSchema>;

const credentialReferenceSchema = z
	.object({
		namespace: z.literal("credentials"),
		alias: z.string().min(1),
		field: z.literal("connection"),
	})
	.strict();
const attemptReferenceSchema = z
	.object({
		namespace: z.literal("attempt"),
		field: z.enum([
			"id",
			"external_ref",
			"provider_id",
			"scenario_id",
			"started_at",
			"deadline_at",
		]),
	})
	.strict();
const candidateReferenceSchema = z
	.object({
		namespace: z.literal("candidate"),
		binding: z.string().min(1),
		path: z.union([
			z.tuple([z.literal("item")]).rest(pathPartSchema),
			z.tuple([z.literal("result")]).rest(pathPartSchema),
		]),
	})
	.strict();

export type CredentialReference = z.infer<typeof credentialReferenceSchema>;
export type EstablishedConnectionReference = CredentialReference & { field: "connection" };
export type AttemptReference = z.infer<typeof attemptReferenceSchema>;
export type CandidateReference = z.infer<typeof candidateReferenceSchema>;
export type Reference =
	| StepReference
	| CredentialReference
	| AttemptReference
	| CandidateReference;
const referenceSchema = z.discriminatedUnion("namespace", [
	stepReferenceSchema,
	credentialReferenceSchema,
	attemptReferenceSchema,
	candidateReferenceSchema,
]);
export const ReferenceSchema = referenceSchema;

const relativeDateNodeSchema = z
	.object({
		relativeDate: z
			.object({
				anchor: z.literal("operation_started_at"),
				offsetDays: finiteInt(1, 365),
				timeZone: z.literal("Asia/Seoul"),
				format: z.enum(["YYYY-MM-DD", "YYYYMMDD"]),
			})
			.strict(),
	})
	.strict();
export type RelativeDateNode = z.infer<typeof relativeDateNodeSchema>;
export const RelativeDateNodeSchema = relativeDateNodeSchema;
const referenceNodeSchema = z.object({ ref: referenceSchema }).strict();

export type ReferenceNode = { ref: Reference };
export type JsonTemplate =
	| JsonPrimitive
	| ReferenceNode
	| RelativeDateNode
	| JsonTemplate[]
	| { [key: string]: JsonTemplate };
// Reserved template keys may only occur in their exact, single-key node forms.
const templateRecordSchema = z
	.record(
		z.string(),
		z.lazy(() => jsonTemplateSchema),
	)
	.superRefine((value, ctx) => {
		if (Object.hasOwn(value, "ref") || Object.hasOwn(value, "relativeDate"))
			ctx.addIssue({ code: "custom", message: "reserved template keys require a sole-key node" });
	});
const jsonTemplateSchema: z.ZodType<JsonTemplate> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string(),
		referenceNodeSchema,
		relativeDateNodeSchema,
		z.array(jsonTemplateSchema),
		templateRecordSchema,
	]),
);
export const JsonTemplateSchema = jsonTemplateSchema;

export type SafeRegex = {
	readonly engine: "re2";
	readonly pattern: string;
	readonly flags: "" | "i";
};
function containsNestedRegexQuantifier(pattern: string): boolean {
	const groups: boolean[] = [];
	let escaped = false;
	let inClass = false;
	let closedQuantified = false;
	for (let i = 0; i < pattern.length; i += 1) {
		const c = pattern[i];
		if (escaped) {
			escaped = false;
			closedQuantified = false;
			continue;
		}
		if (c === "\\") {
			escaped = true;
			closedQuantified = false;
			continue;
		}
		if (c === "[" && !inClass) {
			inClass = true;
			continue;
		}
		if (c === "]" && inClass) {
			inClass = false;
			continue;
		}
		if (inClass) continue;
		if (c === "(") {
			groups.push(false);
			closedQuantified = false;
			continue;
		}
		if (c === ")") {
			closedQuantified = groups.pop() ?? false;
			if (closedQuantified && groups.length > 0) groups[groups.length - 1] = true;
			continue;
		}
		const brace = c === "{" && /^\{\d+(?:,\d*)?\}/.test(pattern.slice(i));
		if (c === "*" || c === "+" || brace || (c === "?" && pattern[i - 1] !== "(")) {
			if (closedQuantified) return true;
			if (groups.length > 0) groups[groups.length - 1] = true;
		}
		closedQuantified = false;
	}
	return false;
}
export const SafeRegexSchema = z
	.object({ engine: z.literal("re2"), pattern: z.string().max(256), flags: z.enum(["", "i"]) })
	.strict()
	.superRefine((value, ctx) => {
		if (/\\[1-9kg]/.test(value.pattern))
			ctx.addIssue({ code: "custom", path: ["pattern"], message: "backreferences are not supported by RE2" });
		if (/\(\?/.test(value.pattern))
			ctx.addIssue({ code: "custom", path: ["pattern"], message: "extended groups are not supported by RE2" });
		if (containsNestedRegexQuantifier(value.pattern))
			ctx.addIssue({ code: "custom", path: ["pattern"], message: "nested regex quantifiers are not permitted" });
		try {
			new RegExp(value.pattern, value.flags);
		} catch {
			ctx.addIssue({ code: "custom", path: ["pattern"], message: "pattern must be valid regular-expression syntax" });
		}
	});

const operandLiteralSchema = jsonValueSchema.superRefine((value, ctx) => {
	if (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.hasOwn(value, "ref")
	)
		ctx.addIssue({
			code: "custom",
			message: 'the object key "ref" is reserved for a validated reference',
		});
});
const operandSchema = z.union([operandLiteralSchema, referenceNodeSchema]);
export const OperandSchema = operandSchema;
export type Operand = JsonValue | ReferenceNode;

const predicateSchema = z.union([
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.enum(["exists", "not_exists", "non_empty", "is_true"]),
			actual: operandSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.enum(["equals", "not_equals", "contains"]),
			actual: operandSchema,
			expected: operandSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.literal("matches"),
			actual: operandSchema,
			pattern: SafeRegexSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.enum(["number_gt", "number_gte", "number_lt", "number_lte"]),
			actual: operandSchema,
			expected: operandSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.enum(["array_length_eq", "array_length_gte", "array_length_lte"]),
			actual: operandSchema,
			expected: z.number().finite().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.literal("status_2xx"),
			actual: operandSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.literal("type_is"),
			actual: operandSchema,
			expected: z.enum(["null", "boolean", "number", "string", "object", "array"]),
		})
		.strict(),
]);
export const AssertionPredicateSchema = predicateSchema;
export type AssertionPredicate = z.infer<typeof predicateSchema>;

const scopedItemReferenceSchema = z
	.object({
		namespace: z.literal("item"),
		binding: z.string().min(1),
		path: z.array(pathPartSchema).max(12),
	})
	.strict();
export const ScopedItemReferenceSchema = scopedItemReferenceSchema;
export type ScopedItemReference = z.infer<typeof scopedItemReferenceSchema>;

const scopedOperandSchema = z.union([
	operandLiteralSchema,
	z.object({ ref: scopedItemReferenceSchema }).strict(),
	referenceNodeSchema,
]);
export const ScopedOperandSchema = scopedOperandSchema;
export type ScopedOperand = z.infer<typeof scopedOperandSchema>;

const scopedPredicateSchema = z.union([
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.enum(["exists", "not_exists", "non_empty", "is_true"]),
			actual: scopedOperandSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.enum(["equals", "not_equals", "contains"]),
			actual: scopedOperandSchema,
			expected: scopedOperandSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.literal("matches"),
			actual: scopedOperandSchema,
			pattern: SafeRegexSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.enum(["number_gt", "number_gte", "number_lt", "number_lte"]),
			actual: scopedOperandSchema,
			expected: scopedOperandSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.enum(["array_length_eq", "array_length_gte", "array_length_lte"]),
			actual: scopedOperandSchema,
			expected: z.number().finite().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.literal("status_2xx"),
			actual: scopedOperandSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("predicate"),
			operator: z.literal("type_is"),
			actual: scopedOperandSchema,
			expected: z.enum(["null", "boolean", "number", "string", "object", "array"]),
		})
		.strict(),
]);
export const ScopedAssertionPredicateSchema = scopedPredicateSchema;
export type ScopedAssertionPredicate = z.infer<typeof scopedPredicateSchema>;

export type ScopedAssertionExpression =
	| { kind: "all" | "any"; clauses: NonEmpty<ScopedAssertionExpression> }
	| { kind: "not"; clause: ScopedAssertionExpression }
	| ScopedAssertionPredicate;
const scopedExpressionSchema: z.ZodType<ScopedAssertionExpression> = z.lazy(() =>
	z.union([
		z.object({ kind: z.literal("all"), clauses: nonEmptyArray(scopedExpressionSchema) }).strict(),
		z.object({ kind: z.literal("any"), clauses: nonEmptyArray(scopedExpressionSchema) }).strict(),
		z.object({ kind: z.literal("not"), clause: scopedExpressionSchema }).strict(),
		scopedPredicateSchema,
	]),
);
export const ScopedAssertionExpressionSchema = scopedExpressionSchema;

export type Quantifier = {
	kind: "quantifier";
	quantifier: "every" | "any";
	items: { ref: StepReference | CandidateReference };
	itemBinding: string;
	maxItems: number;
	clause: ScopedAssertionExpression;
};
const quantifierSchema: z.ZodType<Quantifier> = z
	.object({
		kind: z.literal("quantifier"),
		quantifier: z.enum(["every", "any"]),
		items: z.object({ ref: z.union([stepReferenceSchema, candidateReferenceSchema]) }).strict(),
		itemBinding: z.string().min(1),
		maxItems: finiteInt(1, 100),
		clause: scopedExpressionSchema,
	})
	.strict();
export const QuantifierSchema = quantifierSchema;

export type AssertionExpression =
	| { kind: "all" | "any"; clauses: NonEmpty<AssertionExpression> }
	| { kind: "not"; clause: AssertionExpression }
	| AssertionPredicate
	| Quantifier;
const expressionSchema: z.ZodType<AssertionExpression> = z.lazy(() =>
	z.union([
		z.object({ kind: z.literal("all"), clauses: nonEmptyArray(expressionSchema) }).strict(),
		z.object({ kind: z.literal("any"), clauses: nonEmptyArray(expressionSchema) }).strict(),
		z.object({ kind: z.literal("not"), clause: expressionSchema }).strict(),
		predicateSchema,
		quantifierSchema,
	]),
);
export const AssertionExpressionSchema = expressionSchema;

export type RetryPolicy = {
	maxAttempts: number;
	retryOn: NonEmpty<"transport_error" | "timeout" | "http_429" | "http_5xx">;
	backoff:
		| { kind: "fixed"; delayMs: number }
		| { kind: "exponential"; initialDelayMs: number; maxDelayMs: number };
	attemptTimeoutMs?: number;
};
const retryPolicySchema: z.ZodType<RetryPolicy> = z
	.object({
		maxAttempts: finiteInt(1, 3),
		retryOn: nonEmptyArray(z.enum(["transport_error", "timeout", "http_429", "http_5xx"])),
		backoff: z.union([
			z
				.object({ kind: z.literal("fixed"), delayMs: z.number().finite().int().nonnegative() })
				.strict(),
			z
				.object({
					kind: z.literal("exponential"),
					initialDelayMs: z.number().finite().int().nonnegative(),
					maxDelayMs: z.number().finite().int().nonnegative(),
				})
				.strict(),
		]),
		attemptTimeoutMs: finiteInt(1, 600_000).optional(),
	})
	.strict();
export const RetryPolicySchema = retryPolicySchema;

export type CandidatePolicy = {
	items: StepReference;
	itemBinding: string;
	itemType: "string" | "number" | "object";
	maxAttempts: number;
	accept: AssertionExpression;
};
const candidatePolicySchema: z.ZodType<CandidatePolicy> = z
	.object({
		items: stepReferenceSchema,
		itemBinding: z.string().min(1),
		itemType: z.enum(["string", "number", "object"]),
		maxAttempts: finiteInt(1, 10),
		accept: expressionSchema,
	})
	.strict();
export const CandidatePolicySchema = candidatePolicySchema;

export type CandidateBlock = {
	scope: "step_block";
	items: StepReference;
	itemBinding: string;
	itemType: "string" | "number" | "object";
	members: readonly [string, string, ...string[]];
	maxAttempts: number;
	accept: AssertionExpression;
};
const candidateBlockSchema: z.ZodType<CandidateBlock> = z
	.object({
		scope: z.literal("step_block"),
		items: stepReferenceSchema,
		itemBinding: z.string().min(1),
		itemType: z.enum(["string", "number", "object"]),
		members: z
			.array(z.string().min(1))
			.min(2)
			.max(16)
			.transform((value) => value as [string, string, ...string[]]),
		maxAttempts: finiteInt(1, 10),
		accept: expressionSchema,
	})
	.strict();
export const CandidateBlockSchema = candidateBlockSchema;

export type JournalPolicy = {
	kind: "side_effect_barrier";
	version: 1;
	key: Reference;
	before: "required";
	after: "required";
	replay: "deny_after_started";
};
const journalPolicySchema: z.ZodType<JournalPolicy> = z
	.object({
		kind: z.literal("side_effect_barrier"),
		version: z.literal(1),
		key: referenceSchema,
		before: z.literal("required"),
		after: z.literal("required"),
		replay: z.literal("deny_after_started"),
	})
	.strict();
export const JournalPolicySchema = journalPolicySchema;

export type StepBase = { id: string; result: string; timeoutMs?: number };
const stepBaseSchema = z
	.object({
		id: z.string().min(1),
		result: z.string().min(1),
		timeoutMs: finiteInt(1, 600_000).optional(),
	})
	.strict();
export type GuardReasonCode = "expected_absence";
export type GuardAttribution = {
	operationId: string;
	status: "degraded";
	reasonCode: GuardReasonCode;
	reasonKey: string;
};
export type OperationResult = {
	kind: "operation_result";
	status_code: number;
	data: JsonValue;
	request_id: string;
	duration_ms: number;
	candidate?: { attempts: number; selected_index: number | null };
};
export type ExtractResult<T extends JsonValue = JsonValue> = {
	kind: "extract_result";
	found: boolean;
	value: T | null;
};
export type AssertResult = {
	kind: "assert_result";
	passed: boolean;
	failed_clause_paths: string[];
};
export type GuardResult = { kind: "guard_result"; passed: true };

const attributionSchema = z
	.object({
		operationId: z.string().min(1),
		status: z.literal("degraded"),
		reasonCode: z.literal("expected_absence"),
		reasonKey: z.string().min(1),
	})
	.strict();

export type FindFirst = {
	kind: "find_first";
	itemBinding: string;
	predicate: ScopedAssertionExpression;
	maxScan: number;
};
const findFirstSchema: z.ZodType<FindFirst> = z
	.object({
		kind: z.literal("find_first"),
		itemBinding: z.string().min(1),
		predicate: scopedExpressionSchema,
		maxScan: finiteInt(1, 100),
	})
	.strict();
export const FindFirstSchema = findFirstSchema;

export type OperationStep = StepBase & {
	kind: "operation";
	operationId: string;
	inputTemplate: JsonTemplate;
	connection?: CredentialReference;
	retry?: RetryPolicy;
	candidate?: CandidatePolicy | CandidateBlock;
	journal?: JournalPolicy;
};
export type ExtractStep = StepBase & {
	kind: "extract";
	from: StepReference;
	selector: BoundedJsonPath | FindFirst;
	valueType: ValueType;
	required: boolean;
};
export type AssertStep = StepBase & {
	kind: "assert";
	coversOperations: NonEmpty<string>;
	expression: AssertionExpression;
};
export type GuardStep = StepBase & {
	kind: "guard";
	condition: AssertionExpression;
	onFail: { attribute: NonEmpty<GuardAttribution>; stop: "scenario" };
};
export type HealthStep = OperationStep | ExtractStep | AssertStep | GuardStep;

const operationStepSchema = stepBaseSchema
	.extend({
		kind: z.literal("operation"),
		operationId: z.string().min(1),
		inputTemplate: jsonTemplateSchema,
		connection: credentialReferenceSchema.optional(),
		retry: retryPolicySchema.optional(),
		candidate: z.union([candidatePolicySchema, candidateBlockSchema]).optional(),
		journal: journalPolicySchema.optional(),
	})
	.strict();
const extractStepSchema = stepBaseSchema
	.extend({
		kind: z.literal("extract"),
		from: stepReferenceSchema,
		selector: z.union([BoundedJsonPathSchema, findFirstSchema]),
		valueType: valueTypeSchema,
		required: z.boolean(),
	})
	.strict();
const assertStepSchema = stepBaseSchema
	.extend({
		kind: z.literal("assert"),
		coversOperations: nonEmptyArray(z.string().min(1)),
		expression: expressionSchema,
	})
	.strict();
const guardStepSchema = stepBaseSchema
	.extend({
		kind: z.literal("guard"),
		condition: expressionSchema,
		onFail: z
			.object({ attribute: nonEmptyArray(attributionSchema), stop: z.literal("scenario") })
			.strict(),
	})
	.strict();
export const HealthStepSchema = z.discriminatedUnion("kind", [
	operationStepSchema,
	extractStepSchema,
	assertStepSchema,
	guardStepSchema,
]);
export const OperationStepSchema = operationStepSchema;
export const ExtractStepSchema = extractStepSchema;
export const AssertStepSchema = assertStepSchema;
export const GuardStepSchema = guardStepSchema;

export type ManualTriggerPolicy =
	| { enabled: false; reasonKey: string }
	| {
			enabled: true;
			requiresAcknowledgement: boolean;
			risk: "read_only" | "writes_external_state";
			minManualIntervalMs: number;
			publicRationaleKey: string;
	  };
const manualTriggerSchema: z.ZodType<ManualTriggerPolicy> = z.union([
	z.object({ enabled: z.literal(false), reasonKey: z.string().min(1) }).strict(),
	z
		.object({
			enabled: z.literal(true),
			requiresAcknowledgement: z.boolean(),
			risk: z.enum(["read_only", "writes_external_state"]),
			minManualIntervalMs: finiteInt(1000, 86_400_000),
			publicRationaleKey: z.string().min(1),
		})
		.strict(),
]);
export const ManualTriggerPolicySchema = manualTriggerSchema;

export type CredentialRefDeclaration = { alias: string; kind: "connection" };
const credentialRefDeclarationSchema = z
	.object({ alias: z.string().min(1), kind: z.literal("connection") })
	.strict();
export const CredentialRefDeclarationSchema = credentialRefDeclarationSchema;

export type HealthScenario = {
	scenarioVersion: 2;
	id: string;
	display: { titleKey: string; descriptionKey?: string };
	schedule: { kind: "interval"; intervalMs: number; jitterMs: number };
	timeoutMs: number;
	cooldownMs?: number;
	manualTrigger?: ManualTriggerPolicy;
	coversOperations: NonEmpty<string>;
	credentialRefs: CredentialRefDeclaration[];
	steps: NonEmpty<HealthStep>;
};

export const HealthScenarioSchema: z.ZodType<HealthScenario> = z
	.object({
		scenarioVersion: z.literal(2),
		id: z.string().min(1),
		display: z
			.object({ titleKey: z.string().min(1), descriptionKey: z.string().min(1).optional() })
			.strict(),
		schedule: z
			.object({
				kind: z.literal("interval"),
				intervalMs: finiteInt(30_000, 604_800_000),
				jitterMs: finiteInt(0),
			})
			.strict(),
		timeoutMs: finiteInt(1000, 600_000),
		cooldownMs: finiteInt(0, 86_400_000).optional(),
		manualTrigger: manualTriggerSchema.optional(),
		coversOperations: nonEmptyArray(z.string().min(1)),
		credentialRefs: z.array(credentialRefDeclarationSchema),
		steps: z
			.array(HealthStepSchema)
			.min(1)
			.max(64)
			.transform((value) => value as [HealthStep, ...HealthStep[]]),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.schedule.jitterMs > value.schedule.intervalMs)
			ctx.addIssue({
				code: "custom",
				path: ["schedule", "jitterMs"],
				message: "jitterMs must not exceed intervalMs",
			});
		if (value.timeoutMs > value.schedule.intervalMs)
			ctx.addIssue({
				code: "custom",
				path: ["timeoutMs"],
				message: "timeoutMs must not exceed intervalMs",
			});
		const ids = new Set<string>();
		const bindings = new Set<string>();
		for (const [index, step] of value.steps.entries()) {
			if (ids.has(step.id))
				ctx.addIssue({
					code: "custom",
					path: ["steps", index, "id"],
					message: `duplicate step ${step.id}`,
				});
			ids.add(step.id);
			if (bindings.has(step.result))
				ctx.addIssue({
					code: "custom",
					path: ["steps", index, "result"],
					message: `duplicate result binding ${step.result}`,
				});
			bindings.add(step.result);
			if (step.timeoutMs !== undefined && step.timeoutMs > value.timeoutMs)
				ctx.addIssue({
					code: "custom",
					path: ["steps", index, "timeoutMs"],
					message: "step timeout must not exceed the scenario timeout",
				});
			if (
				step.kind === "operation" &&
				step.retry?.retryOn.includes("timeout") &&
				step.retry.attemptTimeoutMs === undefined
			)
				ctx.addIssue({
					code: "custom",
					path: ["steps", index, "retry", "attemptTimeoutMs"],
					message: "timeout retry requires attemptTimeoutMs",
				});

			const expression =
				step.kind === "assert"
					? step.expression
					: step.kind === "guard"
						? step.condition
						: step.kind === "operation" && step.candidate
							? step.candidate.accept
							: undefined;
			if (expression) walkExpression(expression, ctx, ["steps", index], 0, { count: 0 }, true);
			if (step.kind === "extract" && "kind" in step.selector && step.selector.kind === "find_first")
				walkExpression(
					step.selector.predicate,
					ctx,
					["steps", index, "selector", "predicate"],
					0,
					{ count: 0 },
					false,
					step.selector.itemBinding,
				);
		}
		try {
			const serialized = JSON.stringify(value);
			if (new TextEncoder().encode(serialized).byteLength > 128 * 1024)
				ctx.addIssue({ code: "custom", path: [], message: "serialized scenario exceeds 128 KiB" });
		} catch {
			ctx.addIssue({ code: "custom", path: [], message: "scenario must be JSON-serializable" });
		}
	});

function walkExpression(
	expression: AssertionExpression | ScopedAssertionExpression,
	ctx: z.RefinementCtx,
	path: PropertyKey[],
	depth: number,
	leaves: { count: number },
	allowQuantifier: boolean,
	scopedBinding?: string,
): void {
	if (depth > 8) {
		ctx.addIssue({ code: "custom", path, message: "expression depth exceeds 8" });
		return;
	}
	if (expression.kind === "quantifier") {
		if (!allowQuantifier) {
			ctx.addIssue({ code: "custom", path, message: "quantifiers may not be nested" });
			return;
		}
		if (expression.itemBinding === scopedBinding) {
			ctx.addIssue({
				code: "custom",
				path: [...path, "itemBinding"],
				message: "item binding is invalid or shadows an enclosing binding",
			});
			return;
		}
		walkExpression(
			expression.clause,
			ctx,
			[...path, "clause"],
			depth + 1,
			leaves,
			false,
			expression.itemBinding,
		);
		return;
	}
	if (expression.kind === "all" || expression.kind === "any") {
		for (const [index, clause] of expression.clauses.entries())
			walkExpression(
				clause,
				ctx,
				[...path, "clauses", index],
				depth + 1,
				leaves,
				allowQuantifier,
				scopedBinding,
			);
		return;
	}
	if (expression.kind === "not") {
		walkExpression(
			expression.clause,
			ctx,
			[...path, "clause"],
			depth + 1,
			leaves,
			allowQuantifier,
			scopedBinding,
		);
		return;
	}
	leaves.count += 1;
	if (leaves.count > 64)
		ctx.addIssue({ code: "custom", path, message: "expression contains more than 64 leaves" });
}

export function defineHealthScenario(input: unknown): HealthScenario {
	return HealthScenarioSchema.parse(input);
}
