import { z } from "zod";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };
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

export const BoundedJsonPathV1Schema = z
	.object({ root: z.literal("$"), segments: z.array(pathSegmentSchema).max(12) })
	.strict();
export type BoundedJsonPathV1 = z.infer<typeof BoundedJsonPathV1Schema>;

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
export const ValueTypeV1Schema = valueTypeSchema;
export type ValueTypeV1 = z.infer<typeof valueTypeSchema>;

const stepReferenceSchema = z
	.object({
		namespace: z.literal("steps"),
		binding: z.string().min(1),
		path: z.array(pathPartSchema).min(1).max(12),
	})
	.strict();
export const StepReferenceV1Schema = stepReferenceSchema;
export type StepReferenceV1 = z.infer<typeof stepReferenceSchema>;

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

export type CredentialReferenceV1 = z.infer<typeof credentialReferenceSchema>;
export type EstablishedConnectionReferenceV1 = CredentialReferenceV1 & { field: "connection" };
export type AttemptReferenceV1 = z.infer<typeof attemptReferenceSchema>;
export type CandidateReferenceV1 = z.infer<typeof candidateReferenceSchema>;
export type ReferenceV1 =
	| StepReferenceV1
	| CredentialReferenceV1
	| AttemptReferenceV1
	| CandidateReferenceV1;
const referenceSchema = z.discriminatedUnion("namespace", [
	stepReferenceSchema,
	credentialReferenceSchema,
	attemptReferenceSchema,
	candidateReferenceSchema,
]);
export const ReferenceV1Schema = referenceSchema;

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
export type RelativeDateNodeV1 = z.infer<typeof relativeDateNodeSchema>;
export const RelativeDateNodeV1Schema = relativeDateNodeSchema;
const referenceNodeSchema = z.object({ ref: referenceSchema }).strict();

export type ReferenceNodeV1 = { ref: ReferenceV1 };
export type JsonTemplateV1 =
	| JsonPrimitive
	| ReferenceNodeV1
	| RelativeDateNodeV1
	| JsonTemplateV1[]
	| { [key: string]: JsonTemplateV1 };
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
const jsonTemplateSchema: z.ZodType<JsonTemplateV1> = z.lazy(() =>
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
export const JsonTemplateV1Schema = jsonTemplateSchema;

export type SafeRegexV1 = {
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
export const SafeRegexV1Schema = z
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
export const OperandV1Schema = operandSchema;
export type OperandV1 = JsonValue | ReferenceNodeV1;

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
			pattern: SafeRegexV1Schema,
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
export const AssertionPredicateV1Schema = predicateSchema;
export type AssertionPredicateV1 = z.infer<typeof predicateSchema>;
export type AssertionExpressionV1 =
	| { kind: "all" | "any"; clauses: NonEmpty<AssertionExpressionV1> }
	| { kind: "not"; clause: AssertionExpressionV1 }
	| AssertionPredicateV1;
const expressionSchema: z.ZodType<AssertionExpressionV1> = z.lazy(() =>
	z.union([
		z.object({ kind: z.literal("all"), clauses: nonEmptyArray(expressionSchema) }).strict(),
		z.object({ kind: z.literal("any"), clauses: nonEmptyArray(expressionSchema) }).strict(),
		z.object({ kind: z.literal("not"), clause: expressionSchema }).strict(),
		predicateSchema,
	]),
);
export const AssertionExpressionV1Schema = expressionSchema;

export type RetryPolicyV1 = {
	maxAttempts: number;
	retryOn: NonEmpty<"transport_error" | "timeout" | "http_429" | "http_5xx">;
	backoff:
		| { kind: "fixed"; delayMs: number }
		| { kind: "exponential"; initialDelayMs: number; maxDelayMs: number };
};
const retryPolicySchema: z.ZodType<RetryPolicyV1> = z
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
	})
	.strict();
export const RetryPolicyV1Schema = retryPolicySchema;

export type CandidatePolicyV1 = {
	items: StepReferenceV1;
	itemBinding: string;
	itemType: "string" | "number" | "object";
	maxAttempts: number;
	accept: AssertionExpressionV1;
};
const candidatePolicySchema: z.ZodType<CandidatePolicyV1> = z
	.object({
		items: stepReferenceSchema,
		itemBinding: z.string().min(1),
		itemType: z.enum(["string", "number", "object"]),
		maxAttempts: finiteInt(1, 10),
		accept: expressionSchema,
	})
	.strict();
export const CandidatePolicyV1Schema = candidatePolicySchema;

export type JournalPolicyV1 = {
	kind: "side_effect_barrier";
	version: 1;
	key: ReferenceV1;
	before: "required";
	after: "required";
	replay: "deny_after_started";
};
const journalPolicySchema: z.ZodType<JournalPolicyV1> = z
	.object({
		kind: z.literal("side_effect_barrier"),
		version: z.literal(1),
		key: referenceSchema,
		before: z.literal("required"),
		after: z.literal("required"),
		replay: z.literal("deny_after_started"),
	})
	.strict();
export const JournalPolicyV1Schema = journalPolicySchema;

export type StepBaseV1 = { id: string; result: string; timeoutMs?: number };
const stepBaseSchema = z
	.object({
		id: z.string().min(1),
		result: z.string().min(1),
		timeoutMs: finiteInt(1, 600_000).optional(),
	})
	.strict();
export type OperationStepV1 = StepBaseV1 & {
	kind: "operation";
	operationId: string;
	inputTemplate: JsonTemplateV1;
	connection?: CredentialReferenceV1;
	retry?: RetryPolicyV1;
	candidate?: CandidatePolicyV1;
	journal?: JournalPolicyV1;
};
export type ExtractStepV1 = StepBaseV1 & {
	kind: "extract";
	from: StepReferenceV1;
	selector: BoundedJsonPathV1;
	valueType: ValueTypeV1;
	required: boolean;
};
export type GuardReasonCodeV1 = "expected_absence";
export type GuardAttributionV1 = {
	operationId: string;
	status: "degraded";
	reasonCode: GuardReasonCodeV1;
	reasonKey: string;
};
export type AssertStepV1 = StepBaseV1 & {
	kind: "assert";
	coversOperations: NonEmpty<string>;
	expression: AssertionExpressionV1;
};
export type GuardStepV1 = StepBaseV1 & {
	kind: "guard";
	condition: AssertionExpressionV1;
	onFail: { attribute: NonEmpty<GuardAttributionV1>; stop: "scenario" };
};
export type HealthStepV1 = OperationStepV1 | ExtractStepV1 | AssertStepV1 | GuardStepV1;

export type OperationResultV1 = {
	kind: "operation_result";
	status_code: number;
	data: JsonValue;
	request_id: string;
	duration_ms: number;
	candidate?: { attempts: number; selected_index: number | null };
};
export type ExtractResultV1<T extends JsonValue = JsonValue> = {
	kind: "extract_result";
	found: boolean;
	value: T | null;
};
export type AssertResultV1 = {
	kind: "assert_result";
	passed: boolean;
	failed_clause_paths: string[];
};
export type GuardResultV1 = { kind: "guard_result"; passed: true };

const operationStepSchema = stepBaseSchema
	.extend({
		kind: z.literal("operation"),
		operationId: z.string().min(1),
		inputTemplate: jsonTemplateSchema,
		connection: credentialReferenceSchema.optional(),
		retry: retryPolicySchema.optional(),
		candidate: candidatePolicySchema.optional(),
		journal: journalPolicySchema.optional(),
	})
	.strict();
const extractStepSchema = stepBaseSchema
	.extend({
		kind: z.literal("extract"),
		from: stepReferenceSchema,
		selector: BoundedJsonPathV1Schema,
		valueType: valueTypeSchema,
		required: z.boolean(),
	})
	.strict();
const attributionSchema = z
	.object({
		operationId: z.string().min(1),
		status: z.literal("degraded"),
		reasonCode: z.literal("expected_absence"),
		reasonKey: z.string().min(1),
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
export const HealthStepV1Schema = z.discriminatedUnion("kind", [
	operationStepSchema,
	extractStepSchema,
	assertStepSchema,
	guardStepSchema,
]);
export const OperationStepV1Schema = operationStepSchema;
export const ExtractStepV1Schema = extractStepSchema;
export const AssertStepV1Schema = assertStepSchema;
export const GuardStepV1Schema = guardStepSchema;

export type ManualTriggerPolicyV1 =
	| { enabled: false; reasonKey: string }
	| {
			enabled: true;
			requiresAcknowledgement: boolean;
			risk: "read_only" | "writes_external_state";
			minManualIntervalMs: number;
			publicRationaleKey: string;
	  };
const manualTriggerSchema: z.ZodType<ManualTriggerPolicyV1> = z.union([
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
export const ManualTriggerPolicyV1Schema = manualTriggerSchema;

export type CredentialRefDeclarationV1 = { alias: string; kind: "connection" };
const credentialRefDeclarationSchema = z
	.object({ alias: z.string().min(1), kind: z.literal("connection") })
	.strict();
export const CredentialRefDeclarationV1Schema = credentialRefDeclarationSchema;

export type HealthScenarioV1 = {
	scenarioVersion: 1;
	id: string;
	display: { titleKey: string; descriptionKey?: string };
	schedule: { kind: "interval"; intervalMs: number; jitterMs: number };
	timeoutMs: number;
	cooldownMs?: number;
	manualTrigger?: ManualTriggerPolicyV1;
	coversOperations: NonEmpty<string>;
	credentialRefs: CredentialRefDeclarationV1[];
	steps: NonEmpty<HealthStepV1>;
};

export const HealthScenarioV1Schema: z.ZodType<HealthScenarioV1> = z
	.object({
		scenarioVersion: z.literal(1),
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
			.array(HealthStepV1Schema)
			.min(1)
			.max(64)
			.transform((value) => value as [HealthStepV1, ...HealthStepV1[]]),
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
		for (const step of value.steps) {
			const expressions: AssertionExpressionV1[] = [];
			if (step.kind === "assert") expressions.push(step.expression);
			if (step.kind === "guard") expressions.push(step.condition);
			if (step.kind === "operation" && step.candidate) expressions.push(step.candidate.accept);
			for (const expression of expressions) {
				const stats = expressionStats(expression);
				if (stats.depth > 8)
					ctx.addIssue({
						code: "custom",
						path: ["steps"],
						message: "assertion expression exceeds depth 8",
					});
				if (stats.leaves > 64)
					ctx.addIssue({
						code: "custom",
						path: ["steps"],
						message: "assertion expression exceeds 64 leaves",
					});
			}
		}
		try {
			const serialized = JSON.stringify(value);
			if (new TextEncoder().encode(serialized).byteLength > 128 * 1024)
				ctx.addIssue({ code: "custom", path: [], message: "serialized scenario exceeds 128 KiB" });
		} catch {
			ctx.addIssue({ code: "custom", path: [], message: "scenario must be JSON-serializable" });
		}
	});

function expressionStats(
	expression: AssertionExpressionV1,
	depth = 0,
): { depth: number; leaves: number } {
	if (expression.kind === "predicate") return { depth, leaves: 1 };
	if (expression.kind === "not") return expressionStats(expression.clause, depth + 1);
	return expression.clauses.reduce(
		(total, clause) => {
			const stats = expressionStats(clause, depth + 1);
			return { depth: Math.max(total.depth, stats.depth), leaves: total.leaves + stats.leaves };
		},
		{ depth, leaves: 0 },
	);
}

export function defineHealthScenario(input: unknown): HealthScenarioV1 {
	return HealthScenarioV1Schema.parse(input);
}
