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
export type Reference = StepReference | CredentialReference | AttemptReference | CandidateReference;
const referenceSchema = z.discriminatedUnion("namespace", [
	stepReferenceSchema,
	credentialReferenceSchema,
	attemptReferenceSchema,
	candidateReferenceSchema,
]);
export const ReferenceSchema = referenceSchema;

/**
 * Inclusive calendar-day bounds of `relativeDate.offsetDays`. A negative offset
 * reaches back from the anchor's Asia/Seoul date (a "last N days" window), `0`
 * is the anchor date itself, a positive offset reaches forward. Every node of
 * one operation is evaluated from the same anchor instant, so a window written
 * as two nodes is well-formed (start <= end) exactly when the start offset is
 * <= the end offset. The self-test date token shares these bounds.
 */
export const RELATIVE_DATE_OFFSET_DAYS = { min: -365, max: 365 } as const;

const relativeDateNodeSchema = z
	.object({
		relativeDate: z
			.object({
				anchor: z.literal("operation_started_at"),
				offsetDays: finiteInt(RELATIVE_DATE_OFFSET_DAYS.min, RELATIVE_DATE_OFFSET_DAYS.max),
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
			ctx.addIssue({
				code: "custom",
				path: ["pattern"],
				message: "backreferences are not supported by RE2",
			});
		if (/\(\?/.test(value.pattern))
			ctx.addIssue({
				code: "custom",
				path: ["pattern"],
				message: "extended groups are not supported by RE2",
			});
		if (containsNestedRegexQuantifier(value.pattern))
			ctx.addIssue({
				code: "custom",
				path: ["pattern"],
				message: "nested regex quantifiers are not permitted",
			});
		try {
			new RegExp(value.pattern, value.flags);
		} catch {
			ctx.addIssue({
				code: "custom",
				path: ["pattern"],
				message: "pattern must be valid regular-expression syntax",
			});
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
/**
 * Why a guard stopped the scenario. The platform decides what each reason
 * publishes; the attribution's `status` is only the scenario rollup.
 *
 * - `expected_absence`: the upstream answered exactly as this provider says it
 *   does when there is nothing to return — no weather alert today, an empty
 *   shelf, a transit feed outside its operating hours. Published as the
 *   non-incident status `expected_absence`: neither ok nor degraded, excluded
 *   from uptime, never an incident. Use it only for an absence the provider
 *   can declare in advance. Data that must be there (a product that must have
 *   options) is a failing assertion, not an expected absence.
 * - `served_stale_cache`: the operation step was answered from the
 *   stale-if-error window (`served_stale_cache` on the step result) instead
 *   of a live read. A measured upstream verdict: published `degraded`, opens
 *   incidents.
 */
export type GuardReasonCode = "expected_absence" | "served_stale_cache";
/**
 * Every member of the union, pinned in both directions: a code missing here
 * fails `satisfies Record<GuardReasonCode, true>`, a code added here without
 * the union fails the excess-property check. The union itself stays a
 * literal so the type-only entry points (contract, server, testing) do not
 * have to re-export the runtime tuple.
 */
const GUARD_REASON_CODE_SET = {
	expected_absence: true,
	served_stale_cache: true,
} as const satisfies Record<GuardReasonCode, true>;
/** The closed vocabulary as a non-empty tuple, for schema and lint consumers. */
export const GUARD_REASON_CODES = Object.keys(GUARD_REASON_CODE_SET) as [
	GuardReasonCode,
	...GuardReasonCode[],
];
export type GuardAttribution = {
	operationId: string;
	status: "degraded";
	reasonCode: GuardReasonCode;
	reasonKey: string;
};
/**
 * A guard attribution that can only declare an absence. `expectedErrors`
 * reuses the guard vocabulary but admits `expected_absence` alone: a non-2xx
 * answer the provider names in advance is "nothing to return", never a
 * measured upstream verdict, so `served_stale_cache` has no meaning here.
 */
export type ExpectedAbsenceAttribution = Omit<GuardAttribution, "reasonCode"> & {
	reasonCode: "expected_absence";
};
/**
 * A non-2xx answer an operation step declares as an expected absence: the
 * upstream's "no data" that the provider serves as an error envelope (HTTP
 * 404 `NO_DATA` on a day with no weather alert) rather than as an empty 2xx
 * body a `guard` could read.
 *
 * The platform monitor ends an attempt before any guard runs when an
 * operation step answers non-2xx, so a guard cannot see this case. A matching
 * entry — the provider's own error envelope (`source: "upstream_failure"`)
 * with exactly this `status` and `code` — completes the attempt with
 * `attribute` as the guard attribution instead of recording a transport
 * failure, and is never retried. Anything else (another code, another status,
 * an envelope the SDK did not tie to the upstream) stays the failure it is.
 *
 * This is the serialized shape the monitor matches on. Author it as
 * `{ error: errorRefs(errorCodes).<CODE>, attribute }`: the reference carries
 * the declared `code` and `status` by value, so the step cannot name a code
 * the operation does not declare, a status the runtime does not serve for it,
 * or a credential or rate-limit refusal ({@link errorRefs}).
 */
export type ExpectedError = {
	status: number;
	code: string;
	attribute: NonEmpty<ExpectedAbsenceAttribution>;
};

/**
 * The served statuses an expected absence can carry. The schema admitted any
 * 4xx but 401/403/429; the serve layer classes a declared 409/410/422 as an
 * upstream refusal (`upstream_rejected`, source `upstream_rule`), which the
 * monitor never matches as an absence, so those are not offered either.
 */
export type ExpectedAbsenceStatus = 400 | 404;

/**
 * Codes an expected absence can never reference, whatever status they are
 * declared with: the upstream refusing the platform-managed key, the caller
 * needing to re-authenticate, an unprovisioned secret, and every registered
 * rate-limit code. Each is a measured fault the platform publishes as such.
 *
 * Mirrors `SDK_UPSTREAM_ERROR_CODE_REGISTRY` (categories `upstream_auth` and
 * `upstream_rate_limited`) and the 401-mapped and MISSING_SECRET rows of
 * `SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES` as a literal tuple, because a
 * `Map<string, ...>` cannot feed a type; `health-scenario.test.ts` pins the
 * two against each other.
 */
export const EXPECTED_ERROR_REFUSAL_CODES = [
	"AUTH_REQUIRED",
	"reauth_required",
	"MISSING_SECRET",
	"UPSTREAM_AUTH_ERROR",
	"RATE_LIMITED",
	"UPSTREAM_RATE_LIMIT",
	"LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR",
] as const;
export type ExpectedErrorRefusalCode = (typeof EXPECTED_ERROR_REFUSAL_CODES)[number];
const EXPECTED_ERROR_REFUSAL_CODE_SET: ReadonlySet<string> = new Set(EXPECTED_ERROR_REFUSAL_CODES);

/**
 * A reference to one declared operation error, by value: the `code` and the
 * `status` the runtime serves for it, read from the operation's `errorCodes`
 * declaration through {@link errorRefs}.
 *
 * Structural on purpose. TODO(lane A `defineErrors`): the factory's entries
 * (`errors.NO_DATA`) plug in here by exposing the same two fields; once the
 * declaration carries `category`, narrow this type to the upstream-envelope
 * categories (`sourceForCategory(category) === "upstream_failure"`) so the
 * monitor's source match is refused by the type as well.
 */
export type OperationErrorRef<
	TCode extends string = string,
	TStatus extends ExpectedAbsenceStatus = ExpectedAbsenceStatus,
> = {
	readonly code: TCode;
	readonly status: TStatus;
};

/** The slice of an `errorCodes` entry {@link errorRefs} reads. */
export type OperationErrorCodeDeclaration = {
	readonly code: string;
	readonly status?: number;
};

/** The {@link OperationErrorRef} one `errorCodes` entry yields, or `never` when it may not be an absence. */
export type AbsenceErrorRef<T> = T extends {
	readonly code: infer TCode extends string;
	readonly status: infer TStatus extends ExpectedAbsenceStatus;
}
	? TCode extends ExpectedErrorRefusalCode
		? never
		: OperationErrorRef<TCode, TStatus>
	: never;

/**
 * One {@link OperationErrorRef} per `errorCodes` entry an expected absence
 * may name, keyed by code. An entry without a status, with a status outside
 * {@link ExpectedAbsenceStatus}, or whose code is a refusal
 * ({@link EXPECTED_ERROR_REFUSAL_CODES}) has no key, so referencing it is a
 * compile error. A widened declaration (`status: number`) yields no keys at
 * all: declare `errorCodes` as a literal (`as const`) so each code is one.
 */
export type ErrorRefs<T extends readonly OperationErrorCodeDeclaration[]> = {
	readonly [TRef in AbsenceErrorRef<T[number]> as TRef["code"]]: TRef;
};

/**
 * Typed references to the error codes an operation declares, for
 * `expectedErrors`. Declare the codes once, reference them by value:
 *
 * ```ts
 * export const weatherAlertsErrorCodes = [
 *   { code: "NO_DATA", status: 404, description: "No alert is issued today." },
 * ] as const satisfies readonly OperationErrorCode[];
 * const errors = errorRefs(weatherAlertsErrorCodes);
 *
 * // in the scenario's operation step
 * expectedErrors: [{ error: errors.NO_DATA, attribute: [...] }]
 * ```
 *
 * `errors.TYPO` and `errors.RATE_LIMITED` do not exist on the returned type.
 * The runtime object carries exactly the keys the type does, so a reference
 * built from a widened declaration fails at `defineHealthScenario` instead of
 * silently never matching.
 */
export function errorRefs<const T extends readonly OperationErrorCodeDeclaration[]>(
	errorCodes: T,
): ErrorRefs<T> {
	// `buildOperationErrorCodeLookup` resolves a duplicate code to its LAST
	// declaration, so the reference follows the same reading: resolve first,
	// then decide whether the resolved declaration names an absence. Filtering
	// per row would keep an earlier absence row that the server never serves.
	const resolved = new Map<string, OperationErrorCodeDeclaration>();
	for (const declaration of errorCodes) resolved.set(declaration.code, declaration);
	const refs: Record<string, OperationErrorRef> = {};
	for (const { code, status } of resolved.values()) {
		if (!isExpectedAbsenceStatus(status) || EXPECTED_ERROR_REFUSAL_CODE_SET.has(code)) continue;
		refs[code] = Object.freeze({ code, status });
	}
	return Object.freeze(refs) as ErrorRefs<T>;
}

function isExpectedAbsenceStatus(status: number | undefined): status is ExpectedAbsenceStatus {
	return status === 400 || status === 404;
}

/**
 * What an operation step's `expectedErrors` entry looks like when authored.
 * The reference form is the one to write; the by-code form is accepted one
 * more release and warns at definition time.
 */
export type ExpectedErrorInput =
	| {
			readonly error: OperationErrorRef;
			readonly attribute: NonEmpty<ExpectedAbsenceAttribution>;
	  }
	| {
			/**
			 * @deprecated Reference the declared code instead:
			 * `{ error: errorRefs(errorCodes).<CODE>, attribute }`. The by-code
			 * form is removed in the next minor.
			 */
			readonly status: number;
			/**
			 * @deprecated Reference the declared code instead:
			 * `{ error: errorRefs(errorCodes).<CODE>, attribute }`. The by-code
			 * form is removed in the next minor.
			 */
			readonly code: string;
			readonly attribute: NonEmpty<ExpectedAbsenceAttribution>;
	  };
export type OperationResult = {
	kind: "operation_result";
	status_code: number;
	data: JsonValue;
	request_id: string;
	duration_ms: number;
	/**
	 * Whether the monitor's operation step was answered from a stale-if-error
	 * cache serve — the runtime's projection of the response envelope's
	 * `meta.stale`.
	 *
	 * An operation that declares `cache: { staleIfErrorMs }` answers an
	 * upstream outage with HTTP 200 and a well-formed, fully schema-valid body
	 * for the whole stale window. Every assertion over `status_code` and `data`
	 * therefore passes, and the probe rolls up `ok` while the upstream is down.
	 * This boolean is the only thing in the step result that separates that
	 * from a live read.
	 *
	 * Always present, so a reference to it resolves to `false` rather than
	 * raising `reference_unresolvable`; a response whose `meta` is malformed
	 * fails the step rather than projecting as fresh.
	 *
	 * `defineProvider` guards on it for every operation that declares the
	 * stale window, so an outage the cache is absorbing stops reading as green.
	 * A hand-written guard attributes it `served_stale_cache`, not
	 * `expected_absence`: a stale serve is an upstream fault the platform
	 * publishes as `degraded`, while an expected absence is published as a
	 * non-incident status.
	 *
	 * ```ts
	 * {
	 *   id: "guard-freshness",
	 *   result: "freshness-guarded",
	 *   kind: "guard",
	 *   condition: {
	 *     kind: "predicate",
	 *     operator: "not_equals",
	 *     actual: { ref: { namespace: "steps", binding: "case", path: ["served_stale_cache"] } },
	 *     expected: true,
	 *   },
	 *   onFail: {
	 *     attribute: [{ operationId, status: "degraded", reasonCode: "served_stale_cache", reasonKey }],
	 *     stop: "scenario",
	 *   },
	 * }
	 * ```
	 */
	served_stale_cache: boolean;
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
		reasonCode: z.enum(GUARD_REASON_CODES),
		reasonKey: z.string().min(1),
	})
	.strict();
const expectedAbsenceAttributionSchema = attributionSchema
	.extend({ reasonCode: z.literal("expected_absence") })
	.strict();
/**
 * Statuses an expected error never names: the retry class 429 and the
 * credential refusals 401/403. Not a tunable — the clause has no meaning for
 * them, so the schema does not admit them.
 */
const EXPECTED_ERROR_EXCLUDED_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);
const expectedErrorByCodeSchema = z
	.object({
		status: finiteInt(400, 499).refine(
			(status) => !EXPECTED_ERROR_EXCLUDED_STATUSES.has(status),
			"expected error status must be a 4xx other than 401, 403 and 429",
		),
		code: z.string().min(1),
		attribute: nonEmptyArray(expectedAbsenceAttributionSchema),
	})
	.strict();
/**
 * The reference form normalizes to the serialized `{ status, code, attribute }`
 * the monitor matches on; a reference to a code the accessor did not offer
 * (a refusal, a status outside the absence class) is refused here as well, so
 * a hand-built reference cannot widen what the type refuses.
 */
const expectedErrorByRefSchema = z
	.object({
		error: z
			.object({
				code: z
					.string()
					.min(1)
					.refine((code) => !EXPECTED_ERROR_REFUSAL_CODE_SET.has(code), {
						message:
							"expected error references a credential or rate-limit refusal, never an absence",
					}),
				status: z.union([z.literal(400), z.literal(404)]),
			})
			.strict(),
		attribute: nonEmptyArray(expectedAbsenceAttributionSchema),
	})
	.strict()
	.transform(
		({ error, attribute }): ExpectedError => ({
			status: error.status,
			code: error.code,
			attribute,
		}),
	);
const expectedErrorSchema: z.ZodType<ExpectedError> = z.union([
	expectedErrorByRefSchema,
	expectedErrorByCodeSchema,
]);
export const ExpectedErrorSchema = expectedErrorSchema;

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
	/** Non-2xx answers this step declares as an expected absence; see {@link ExpectedError}. */
	expectedErrors?: NonEmpty<ExpectedError>;
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
/** {@link OperationStep} as authored: `expectedErrors` takes {@link ExpectedErrorInput}. */
export type OperationStepInput = Omit<OperationStep, "expectedErrors"> & {
	expectedErrors?: NonEmpty<ExpectedErrorInput>;
};
export type HealthStepInput = OperationStepInput | ExtractStep | AssertStep | GuardStep;
/** {@link HealthScenario} as authored; `defineHealthScenario` returns the serialized form. */
export type HealthScenarioInput = Omit<HealthScenario, "steps"> & {
	steps: NonEmpty<HealthStepInput>;
};

const operationStepSchema = stepBaseSchema
	.extend({
		kind: z.literal("operation"),
		operationId: z.string().min(1),
		inputTemplate: jsonTemplateSchema,
		connection: credentialReferenceSchema.optional(),
		retry: retryPolicySchema.optional(),
		candidate: z.union([candidatePolicySchema, candidateBlockSchema]).optional(),
		journal: journalPolicySchema.optional(),
		expectedErrors: nonEmptyArray(expectedErrorSchema).optional(),
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
			if (step.kind === "operation" && step.expectedErrors) {
				// The monitor takes the first entry whose status and code match, so
				// two entries for one answer would make the attribution depend on
				// declaration order.
				const seen = new Set<string>();
				for (const [errorIndex, expected] of step.expectedErrors.entries()) {
					const key = `${expected.status} ${expected.code}`;
					if (seen.has(key))
						ctx.addIssue({
							code: "custom",
							path: ["steps", index, "expectedErrors", errorIndex],
							message: `duplicate expected error ${key}`,
						});
					seen.add(key);
				}
			}

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

/** The step id and result-binding suffix of a freshness guard the SDK attaches. */
export const FRESHNESS_GUARD_SUFFIX = ".freshness";
/** The locales SDK-owned copy is shipped in: the ones the SDK negotiates for client-facing provider text (`PROVIDER_ERROR_LOCALES`). */
export type SdkCopyLocale = "en" | "ko" | "ja";
/**
 * The locale key every SDK-attached freshness guard attributes. SDK-owned:
 * the sentence is the same for every operation of every provider ("answered
 * from the cache while the upstream was unavailable"), so the SDK ships the
 * copy ({@link FRESHNESS_GUARD_REASON_COPY}) and the platform resolves the
 * key to it when the provider's own `locales/*.json` carry no value. A
 * provider that wants other wording adds the key to its catalogs; that value
 * wins.
 */
export const FRESHNESS_GUARD_REASON_KEY = "health.servedStaleCache";
/**
 * The built-in copy for {@link FRESHNESS_GUARD_REASON_KEY}, one sentence per
 * locale the SDK negotiates for client-facing provider text (`en`, `ko`,
 * `ja`, the `PROVIDER_ERROR_LOCALES`). The platform's contract check and
 * registry projection fall back to it for a provider catalog that lacks the
 * key.
 */
export const FRESHNESS_GUARD_REASON_COPY: Readonly<Record<SdkCopyLocale, string>> = Object.freeze({
	en: "Answered from the cache while the upstream was unavailable.",
	ko: "업스트림에 연결할 수 없어 캐시된 응답으로 답했습니다.",
	ja: "アップストリームに接続できなかったため、キャッシュされた応答で回答しました。",
});
/** Locale keys the SDK owns the copy of, with that copy; reason keys only, so far. */
export const SDK_OWNED_HEALTH_REASON_COPY: Readonly<
	Record<string, typeof FRESHNESS_GUARD_REASON_COPY>
> = Object.freeze({ [FRESHNESS_GUARD_REASON_KEY]: FRESHNESS_GUARD_REASON_COPY });

const SERVED_STALE_CACHE_FIELD: keyof OperationResult = "served_stale_cache";

/** Whether an operand is `served_stale_cache` on the step result bound to `binding`. */
function isStaleServeOperand(operand: unknown, binding: string): boolean {
	if (operand === null || typeof operand !== "object" || !("ref" in operand)) return false;
	const reference = (operand as { ref: Reference }).ref;
	return (
		reference.namespace === "steps" &&
		reference.binding === binding &&
		reference.path.length === 1 &&
		reference.path[0] === SERVED_STALE_CACHE_FIELD
	);
}

/**
 * Whether a predicate over `binding`'s `served_stale_cache` is FALSE for a
 * stale serve, under `negated` negation depth. The field is always present
 * and always a boolean, so `exists` and `type_is` hold for a stale serve too:
 * reading the operand is not rejecting it.
 */
function predicateRejectsStaleServe(
	predicate: AssertionPredicate,
	binding: string,
	negated: boolean,
): boolean {
	const onActual = isStaleServeOperand(predicate.actual, binding);
	const onExpected = "expected" in predicate && isStaleServeOperand(predicate.expected, binding);
	if (!onActual && !onExpected) return false;
	const literal = onActual
		? "expected" in predicate
			? predicate.expected
			: undefined
		: predicate.actual;
	const { operator } = predicate;
	const failsWhenStale =
		(operator === "not_equals" && literal === true) || (operator === "equals" && literal === false);
	const holdsWhenStale =
		(operator === "is_true" && onActual) ||
		(operator === "equals" && literal === true) ||
		(operator === "not_equals" && literal === false);
	return negated ? holdsWhenStale : failsWhenStale;
}

/**
 * Whether an expression evaluates FALSE when the step bound to `binding` was
 * answered from a stale cache. A clause under `any` counts only if every
 * sibling branch rejects the stale serve too, because `any` is satisfied by
 * the branch that still passes (`status_2xx` on a stale 200).
 */
function rejectsStaleServe(
	expression: AssertionExpression,
	binding: string,
	negated = false,
): boolean {
	if (expression.kind === "not") return rejectsStaleServe(expression.clause, binding, !negated);
	if (expression.kind === "all" || expression.kind === "any") {
		const conjunctive = negated ? expression.kind === "any" : expression.kind === "all";
		return conjunctive
			? expression.clauses.some((clause) => rejectsStaleServe(clause, binding, negated))
			: expression.clauses.every((clause) => rejectsStaleServe(clause, binding, negated));
	}
	if (expression.kind === "predicate")
		return predicateRejectsStaleServe(expression, binding, negated);
	return false;
}

/** Whether a guard degrades `operationId` as a stale serve, not as an absence. */
function attributesStaleServe(step: GuardStep, operationId: string): boolean {
	return step.onFail.attribute.some(
		(entry) => entry.operationId === operationId && entry.reasonCode === "served_stale_cache",
	);
}

/**
 * Whether the author already reaches a freshness verdict on the operation
 * step at `index`: an `assert` covering the operation that rejects the stale
 * serve (a `down` verdict, harsher than the default and honoured as the
 * author's choice), or a `guard` that rejects it and attributes
 * `served_stale_cache` to the operation, BEFORE any other guard. Every guard
 * stops the scenario, so a row or emptiness guard placed first would answer a
 * stale, empty serve with its own reason and the freshness guard would never
 * run; a guard that attributes `expected_absence` is not a verdict either,
 * because the platform publishes that as a non-incident status.
 */
function authorsFreshnessVerdict(steps: readonly HealthStep[], index: number): boolean {
	const operation = steps[index];
	if (operation?.kind !== "operation") return false;
	const { result: binding, operationId } = operation;
	for (const step of steps.slice(index + 1)) {
		if (
			step.kind === "assert" &&
			step.coversOperations.includes(operationId) &&
			rejectsStaleServe(step.expression, binding)
		)
			return true;
		if (step.kind !== "guard") continue;
		if (rejectsStaleServe(step.condition, binding)) return attributesStaleServe(step, operationId);
		// A freshness guard for ANOTHER read of the same operation degrades on
		// exactly this concern, so `read A, read B, guard A, guard B` covers both.
		const siblingFreshnessGuard = steps.some(
			(sibling) =>
				sibling.kind === "operation" &&
				sibling.result !== binding &&
				rejectsStaleServe(step.condition, sibling.result) &&
				attributesStaleServe(step, sibling.operationId),
		);
		if (!siblingFreshnessGuard) return false;
	}
	return false;
}

/** The freshness guard the SDK attaches right after an operation step. */
function freshnessGuard(operation: OperationStep): GuardStep {
	return {
		id: `${operation.id}${FRESHNESS_GUARD_SUFFIX}`,
		result: `${operation.result}${FRESHNESS_GUARD_SUFFIX}`,
		kind: "guard",
		condition: {
			kind: "predicate",
			operator: "not_equals",
			actual: {
				ref: { namespace: "steps", binding: operation.result, path: [SERVED_STALE_CACHE_FIELD] },
			},
			expected: true,
		},
		onFail: {
			attribute: [
				{
					operationId: operation.operationId,
					status: "degraded",
					reasonCode: "served_stale_cache",
					reasonKey: FRESHNESS_GUARD_REASON_KEY,
				},
			],
			stop: "scenario",
		},
	};
}

/**
 * The scenario with a freshness guard after every operation step the
 * scenario covers, for an operation in `staleServingOperations`, that the
 * author left unguarded. Idempotent: a guard this function attached is an
 * authored verdict on the next pass.
 *
 * An operation that declares `cache: { staleIfErrorMs }` answers an upstream
 * outage with HTTP 200 and a schema-valid body for the whole stale window, so
 * every clause over `status_code` and `data` passes and the probe would roll
 * up `ok` through the outage; `served_stale_cache` on the step result is the
 * only operand that tells the two apart. The stale-serve policy stays
 * declared once, on the operation, and `defineProvider` calls this with the
 * operations that declare it. Steps for an operation outside
 * `coversOperations` (a preparatory read for another operation) are not this
 * probe's verdict and are left alone, as are steps for an operation that
 * never serves stale.
 *
 * A `step_block` candidate's members must stay contiguous and may not contain
 * a guard, so the guards for its member steps follow the block's last member.
 */
export function withFreshnessGuards(
	scenario: HealthScenario,
	staleServingOperations: ReadonlySet<string>,
): HealthScenario {
	const blockEndByMember = new Map<string, string>();
	for (const step of scenario.steps) {
		if (step.kind !== "operation" || step.candidate === undefined || !("scope" in step.candidate))
			continue;
		const last = step.candidate.members[step.candidate.members.length - 1];
		if (last !== undefined)
			for (const member of step.candidate.members) blockEndByMember.set(member, last);
	}
	const deferred = new Map<string, GuardStep[]>();
	const steps: HealthStep[] = [];
	for (const [index, step] of scenario.steps.entries()) {
		steps.push(step);
		if (
			step.kind === "operation" &&
			staleServingOperations.has(step.operationId) &&
			scenario.coversOperations.includes(step.operationId) &&
			!authorsFreshnessVerdict(scenario.steps, index)
		) {
			const blockEnd = blockEndByMember.get(step.id);
			if (blockEnd === undefined || blockEnd === step.id) steps.push(freshnessGuard(step));
			else deferred.set(blockEnd, [...(deferred.get(blockEnd) ?? []), freshnessGuard(step)]);
		}
		steps.push(...(deferred.get(step.id) ?? []));
	}
	return { ...scenario, steps: steps as [HealthStep, ...HealthStep[]] };
}

/**
 * Marks a serialized `expectedErrors` entry that was authored by code string
 * (`{ status, code, attribute }`) rather than by reference. Non-enumerable and
 * symbol-keyed, so the wire shape, JSON serialization and equality are
 * unchanged; registered globally so a provider built with one copy of the SDK
 * is read correctly by the lint in another (`apifuse check` lints the
 * provider's definition object in-process). The by-code form is the
 * deprecated authoring shape, and this is what lets its lint rules
 * (`health-check-expected-error-not-an-absence`, `-unmatchable`) skip every
 * reference entry: a reference is declared, status-bound and refusal-free by
 * construction, so there is nothing for them to check.
 */
const EXPECTED_ERROR_BY_CODE = Symbol.for("@apifuse/provider-sdk/health/expectedErrorByCode");

/** Whether a serialized `expectedErrors` entry was authored by code string. */
export function isExpectedErrorByCode(entry: unknown): boolean {
	return (
		entry !== null &&
		typeof entry === "object" &&
		(entry as { [EXPECTED_ERROR_BY_CODE]?: unknown })[EXPECTED_ERROR_BY_CODE] === true
	);
}

/**
 * Tags the serialized entries that were authored by code and warns once per
 * entry. `HealthScenarioSchema` keeps array order, so the authored entry at
 * `[stepIndex][entryIndex]` is the serialized one at the same position.
 */
function markExpectedErrorsByCode(input: unknown, scenario: HealthScenario): void {
	if (
		input === null ||
		typeof input !== "object" ||
		!Array.isArray((input as { steps?: unknown }).steps)
	)
		return;
	const { id, steps } = input as { id?: unknown; steps: unknown[] };
	for (const [stepIndex, step] of steps.entries()) {
		if (step === null || typeof step !== "object") continue;
		const { expectedErrors, id: stepId } = step as { expectedErrors?: unknown; id?: unknown };
		if (!Array.isArray(expectedErrors)) continue;
		const serialized = scenario.steps[stepIndex];
		if (serialized?.kind !== "operation") continue;
		for (const [entryIndex, entry] of expectedErrors.entries()) {
			if (
				entry === null ||
				typeof entry !== "object" ||
				typeof (entry as { code?: unknown }).code !== "string"
			)
				continue;
			const target = serialized.expectedErrors?.[entryIndex];
			if (target !== undefined)
				Object.defineProperty(target, EXPECTED_ERROR_BY_CODE, { value: true, enumerable: false });
			console.warn(
				`[provider-sdk] Health scenario ${JSON.stringify(id)} step ${JSON.stringify(stepId)} declares expectedErrors by code string ${JSON.stringify((entry as { code: string }).code)}; reference the declared code instead ({ error: errorRefs(errorCodes).${(entry as { code: string }).code}, attribute }). The by-code form is removed in the next minor.`,
			);
		}
	}
}

/**
 * Validates an authored scenario and returns its serialized form: expected
 * errors normalized to `{ status, code, attribute }`. The freshness guard is
 * not attached here, because whether an operation serves stale is declared on
 * the operation (`cache: { staleIfErrorMs }`), which `defineProvider` reads
 * when it attaches the guard ({@link withFreshnessGuards}); the step budget
 * (64) and the id and binding uniqueness are re-checked there for what the
 * monitor receives, attached guards included.
 */
export function defineHealthScenario(input: unknown): HealthScenario {
	const scenario = HealthScenarioSchema.parse(input);
	markExpectedErrorsByCode(input, scenario);
	return scenario;
}
