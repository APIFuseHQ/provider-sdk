import { type ZodString, type ZodType, z } from "zod";

import { ValidationError } from "./errors.js";
import { providerLocaleKey } from "./i18n/keys.js";
import type {
	InferSchemaOutput,
	ProviderLocaleKey,
	SchemaLike,
	StandardSchemaV1,
} from "./types.js";

export { z };

export type SchemaValidationResult<TSchema extends SchemaLike> =
	| { success: true; data: InferSchemaOutput<TSchema> }
	| { success: false; error: unknown };

type UnknownSchemaValidationResult =
	| { success: true; data: unknown }
	| { success: false; error: unknown };

function isFailureResult<Output>(
	result: StandardSchemaV1.Result<Output>,
): result is StandardSchemaV1.FailureResult {
	return "issues" in result;
}
function isPromiseResult<Output>(
	result: StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
): result is Promise<StandardSchemaV1.Result<Output>> {
	return result instanceof Promise;
}
function formatStandardSchemaIssues(issues: readonly StandardSchemaV1.Issue[]): string {
	return issues.map((issue) => issue.message).join("; ");
}
export function parseSchema<TSchema extends SchemaLike>(
	schema: TSchema,
	value: unknown,
	fieldPath: string,
): Promise<InferSchemaOutput<TSchema>>;
export async function parseSchema(
	schema: SchemaLike,
	value: unknown,
	fieldPath: string,
): Promise<unknown> {
	if ("parse" in schema && typeof schema.parse === "function") return schema.parse(value);
	const result = schema["~standard"].validate(value);
	const resolved = isPromiseResult(result) ? await result : result;
	if (isFailureResult(resolved))
		throw new ValidationError(
			`Schema validation failed for ${fieldPath}: ${formatStandardSchemaIssues(resolved.issues)}`,
			{ zodError: resolved.issues },
		);
	return resolved.value;
}
export function safeParseSchemaSync<TSchema extends SchemaLike>(
	schema: TSchema,
	value: unknown,
	fieldPath: string,
): SchemaValidationResult<TSchema>;
export function safeParseSchemaSync(
	schema: SchemaLike,
	value: unknown,
	fieldPath: string,
): UnknownSchemaValidationResult {
	if ("safeParse" in schema && typeof schema.safeParse === "function")
		return schema.safeParse(value);
	try {
		const result = schema["~standard"].validate(value);
		if (isPromiseResult(result))
			return {
				success: false,
				error: new ValidationError(
					`Schema validation for ${fieldPath} returned a Promise. defineProvider fixture validation requires synchronous Standard Schema validation.`,
				),
			};
		if (isFailureResult(result)) return { success: false, error: result.issues };
		return { success: true, data: result.value };
	} catch (error) {
		return { success: false, error };
	}
}

export const APIFUSE_SENSITIVE_META_KEY = "x-apifuse-sensitive";
export const APIFUSE_SENSITIVE_KIND_META_KEY = "x-apifuse-sensitive-kind";
export const APIFUSE_DESCRIPTION_KEY_META_KEY = "x-apifuse-description-key";
export const APIFUSE_TEXT_TRUST_META_KEY = "x-apifuse-text-trust";
export const APIFUSE_REDACTION_MARKER = "<redacted>";

export type TextTrust = "trusted" | "untrusted";

export interface TextTrustMetadata {
	readonly v: 1;
	readonly trust: TextTrust;
}

export type OutputTextTrustMap = Readonly<Record<string, TextTrust>>;

/**
 * Auto-trusted output leaves are string-valued `z.literal()` / `z.enum()`,
 * patterns whose every top-level alternative is anchored at both ends and
 * whose bodies use only finite quantifiers, positive whitespace-free character
 * classes, safe literals/escapes, and ordinary or non-capturing groups, plus
 * the formats listed here. A brand is trusted only when its underlying schema
 * meets one of those rules. Length-only strings and other formats (including
 * email, URL, base64, and JWT) are not trusted.
 */
export const AUTO_TRUSTED_ZOD_STRING_FORMATS = [
	"cidrv4",
	"cidrv6",
	"cuid",
	"cuid2",
	"date",
	"datetime",
	"duration",
	"e164",
	"guid",
	"ipv4",
	"ipv6",
	"ksuid",
	"nanoid",
	"time",
	"ulid",
	"uuid",
	"xid",
] as const;

export type SensitivePathSegment = string | "*";
export type SensitivePath = readonly SensitivePathSegment[];
export type SensitiveFieldKind =
	| "api_key"
	| "authorization"
	| "cookie"
	| "credential"
	| "otp"
	| "password"
	| "payment_url"
	| "personal_data"
	| "phone"
	| "secret"
	| "token";

export interface SensitiveFieldOptions {
	/**
	 * Mark this schema as sensitive. Defaults to true for the helper presets.
	 */
	sensitive?: boolean;
	/**
	 * Machine-readable sensitivity category propagated to JSON Schema.
	 */
	kind?: SensitiveFieldKind;
	/**
	 * Optional public description applied with Zod's `.describe()`.
	 */
	description?: string;
}

export function describeKey<TSchema extends ZodType>(
	schema: TSchema,
	key: ProviderLocaleKey | string,
): TSchema {
	const descriptionKey = providerLocaleKey(key);
	const metadata = schema.meta() ?? {};
	return schema.meta({
		...metadata,
		[APIFUSE_DESCRIPTION_KEY_META_KEY]: descriptionKey,
	});
}

/** Attach output text-trust authoring metadata without changing validation. */
export function textTrust<TSchema extends ZodType>(schema: TSchema, trust: TextTrust): TSchema {
	const metadata = schema.meta() ?? {};
	return schema.meta({
		...metadata,
		[APIFUSE_TEXT_TRUST_META_KEY]: { v: 1, trust } satisfies TextTrustMetadata,
	});
}

declare module "zod" {
	interface ZodType {
		describeKey(key: ProviderLocaleKey | string): this;
		textTrust(trust: TextTrust): this;
	}
}

const describeKeyMethod = function <TSchema extends ZodType>(
	this: TSchema,
	key: ProviderLocaleKey | string,
): TSchema {
	return describeKey(this, key);
};

const textTrustMethod = function <TSchema extends ZodType>(
	this: TSchema,
	trust: TextTrust,
): TSchema {
	return textTrust(this, trust);
};

function installSchemaMetadataMethodsOnPrototype(prototype: unknown): void {
	const target = prototype as Record<string, unknown> | null;
	if (!target) return;
	if (typeof target.describeKey !== "function") {
		Object.defineProperty(target, "describeKey", {
			configurable: true,
			value: describeKeyMethod,
			writable: true,
		});
	}
	if (typeof target.textTrust !== "function") {
		Object.defineProperty(target, "textTrust", {
			configurable: true,
			value: textTrustMethod,
			writable: true,
		});
	}
}

for (const [name, value] of Object.entries(z)) {
	if (!name.startsWith("Zod") || name.endsWith("Error")) {
		continue;
	}
	if (typeof value !== "function") {
		continue;
	}
	installSchemaMetadataMethodsOnPrototype(value.prototype);
}

const RESERVED_SENSITIVE_KEYS = new Set([
	"authorization",
	"cookie",
	"secret",
	"secrets",
	"token",
	"accesstoken",
	"refreshtoken",
	"apikey",
	"api_key",
	"password",
	"passwd",
	"otp",
	"otpcode",
	"phone",
	"phonenumber",
	"paymenturl",
	"payment_url",
]);

export function field<TSchema extends ZodType>(
	schema: TSchema,
	options: SensitiveFieldOptions = {},
): TSchema {
	const described =
		options.description && typeof schema.describe === "function"
			? schema.describe(options.description)
			: schema;
	const metadata = described.meta() ?? {};
	return described.meta({
		...metadata,
		...((options.sensitive ?? true) ? { [APIFUSE_SENSITIVE_META_KEY]: true } : {}),
		...(options.kind ? { [APIFUSE_SENSITIVE_KIND_META_KEY]: options.kind } : {}),
	});
}

export function sensitive<TSchema extends ZodType>(
	schema: TSchema,
	kind?: SensitiveFieldKind,
): TSchema {
	return field(schema, { sensitive: true, kind });
}

function sensitiveString(
	kind: SensitiveFieldKind,
	description: string,
	options: { description?: string; minLength?: number } = {},
): ZodString {
	const schema = options.minLength === undefined ? z.string() : z.string().min(options.minLength);
	return field(schema, {
		kind,
		description: options.description ?? description,
	});
}

export const fields = {
	apiKey: (options?: { description?: string }) =>
		sensitiveString("api_key", "Provider API key or credential secret.", options),
	authorization: (options?: { description?: string }) =>
		sensitiveString("authorization", "Authorization header value or bearer credential.", options),
	cookie: (options?: { description?: string }) =>
		sensitiveString("cookie", "Cookie header or browser session secret.", options),
	otp: (options?: { description?: string }) =>
		sensitiveString("otp", "One-time verification code.", options),
	password: (options?: { description?: string; minLength?: number }) =>
		sensitiveString("password", "Password credential.", options),
	paymentUrl: (options?: { description?: string }) =>
		sensitiveString("payment_url", "Sensitive payment or checkout URL.", options),
	phone: (options?: { description?: string }) =>
		sensitiveString("phone", "Phone number or phone-based identity.", options),
	secret: (options?: { description?: string }) =>
		sensitiveString("secret", "Provider secret material.", options),
	token: (options?: { description?: string }) =>
		sensitiveString("token", "Provider access or refresh token.", options),
} as const;

type TextTrustDeclaration = TextTrust | "absent" | "invalid";

type InternalZodSchema = z.core.$ZodTypes;
type InternalZodDef = InternalZodSchema["_zod"]["def"];

interface OutputTextLeaf {
	readonly classification: TextTrust;
	readonly classified: boolean;
}

interface OutputTextTrustCollection {
	readonly leaves: Array<OutputTextLeaf & { readonly path: string }>;
	readonly debtPaths: Set<string>;
}

export class OutputTextTrustSchemaError extends TypeError {
	readonly code = "invalid_output_text_trust_schema";

	constructor(value: unknown) {
		const receivedType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
		super(`Output text-trust collection requires a Zod schema; received ${receivedType}.`);
		this.name = "OutputTextTrustSchemaError";
	}
}

export class OutputTextTrustCollectionError extends Error {
	readonly classification = "untrusted" as const;
	readonly code = "output_text_trust_collection_failed";

	constructor(
		public readonly schemaPath: string,
		cause: unknown,
	) {
		super(`Output text-trust collection failed at schema path ${schemaPath}.`);
		this.name = "OutputTextTrustCollectionError";
		this.cause = cause;
	}
}

/**
 * Collect every textual leaf in a Zod output schema as a deterministic
 * schema-path-to-classification object. The path grammar is rooted at `$`:
 * object keys are `["key"]`, arrays and record values are `[*]`, tuple slots
 * are `[n]`, union/intersection alternatives are `<union:n>` / `<intersection:n>`,
 * record keys are `<record-key>`, and one bounded cycle expansion is marked
 * `<recursive>`.
 */
export function collectOutputTextTrust(schema: ZodType): OutputTextTrustMap {
	const { leaves } = collectOutputTextLeaves(requireOutputTextTrustSchema(schema));
	return Object.fromEntries(
		leaves
			.map(({ path, classification }) => [path, classification] as const)
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}

/** Report textual output paths that lack a valid explicit or auto-derived classification. */
export function findUnclassifiedOutputTextPaths(schema: ZodType): string[] {
	const { debtPaths, leaves } = collectOutputTextLeaves(requireOutputTextTrustSchema(schema));
	for (const { classified, path } of leaves) {
		if (!classified) debtPaths.add(path);
	}
	return [...debtPaths].sort((left, right) => left.localeCompare(right));
}

/** @internal Used by contract JSON Schema projection. */
export function resolveOutputTextTrust(
	schema: z.core.$ZodType,
	inheritedUntrusted = false,
): TextTrust | undefined {
	const resolved = resolveOutputTextTrustProjection(schema);
	return resolved?.[inheritedUntrusted ? "inherited" : "local"];
}

/** @internal Resolve both projection states from one stable schema traversal. */
export function resolveOutputTextTrustProjection(
	schema: z.core.$ZodType,
): { readonly inherited: TextTrust; readonly local: TextTrust } | undefined {
	const resolved = resolveOutputTextLeafPair(asInternalZodSchema(schema), [], true);
	return resolved
		? {
				inherited: resolved.inherited.classification,
				local: resolved.local.classification,
			}
		: undefined;
}

/** @internal Whether this node can bypass or mutate descendant validation guarantees. */
export function invalidatesDescendantOutputTextAutoTrust(schema: z.core.$ZodType): boolean {
	return invalidatesOutputTextAutoTrust(asInternalZodSchema(schema)._zod.def);
}

/** @internal Used by contract JSON Schema projection. */
export function inheritsUntrustedOutputTextTrust(schema: z.core.$ZodType): boolean {
	let current = asInternalZodSchema(schema);
	while (true) {
		if (readTextTrustDeclaration(current) === "untrusted") return true;
		const inner = flattenedOutputSchema(current._zod.def);
		if (!inner) return false;
		current = inner;
	}
}

function collectOutputTextLeaves(schema: InternalZodSchema): OutputTextTrustCollection {
	const leaves: Array<OutputTextLeaf & { readonly path: string }> = [];
	const debtPaths = new Set<string>();
	const emittedPaths = new Set<string>();
	walkOutputSchema(schema, "$", leaves, debtPaths, emittedPaths, new Set(), false, false, true);
	return { leaves, debtPaths };
}

function walkOutputSchema(
	schema: InternalZodSchema,
	path: string,
	out: Array<OutputTextLeaf & { readonly path: string }>,
	debtPaths: Set<string>,
	emittedPaths: Set<string>,
	activeSchemas: Set<InternalZodSchema>,
	expandingCycle: boolean,
	inheritedUntrusted: boolean,
	autoTrustAllowed: boolean,
): void {
	try {
		walkOutputSchemaUnchecked(
			schema,
			path,
			out,
			debtPaths,
			emittedPaths,
			activeSchemas,
			expandingCycle,
			inheritedUntrusted,
			autoTrustAllowed,
		);
	} catch (error) {
		if (error instanceof OutputTextTrustCollectionError) throw error;
		throw new OutputTextTrustCollectionError(path, error);
	}
}

function walkOutputSchemaUnchecked(
	schema: InternalZodSchema,
	path: string,
	out: Array<OutputTextLeaf & { readonly path: string }>,
	debtPaths: Set<string>,
	emittedPaths: Set<string>,
	activeSchemas: Set<InternalZodSchema>,
	expandingCycle: boolean,
	inheritedUntrusted: boolean,
	autoTrustAllowed: boolean,
): void {
	const alreadyActive = activeSchemas.has(schema);
	if (alreadyActive) {
		if (!expandingCycle) {
			walkOutputSchema(
				schema,
				`${path}<recursive>`,
				out,
				debtPaths,
				emittedPaths,
				new Set(),
				true,
				inheritedUntrusted,
				autoTrustAllowed,
			);
		}
		return;
	}

	const leaf = resolveOutputTextLeaf(schema, [], autoTrustAllowed, inheritedUntrusted);
	if (leaf) {
		if (!emittedPaths.has(path)) {
			emittedPaths.add(path);
			out.push({ path, ...leaf });
		}
		return;
	}

	const def = schema._zod.def;
	const declaration = readTextTrustDeclaration(schema);
	if (declaration === "trusted" || declaration === "invalid") debtPaths.add(path);
	const descendantUntrusted = inheritedUntrusted || declaration === "untrusted";
	const descendantAutoTrustAllowed = autoTrustAllowed && !invalidatesOutputTextAutoTrust(def);
	if (!alreadyActive) activeSchemas.add(schema);
	try {
		switch (def.type) {
			case "object": {
				for (const [key, child] of Object.entries(def.shape).sort(([left], [right]) =>
					left.localeCompare(right),
				)) {
					walkOutputSchema(
						asInternalZodSchema(child),
						`${path}[${JSON.stringify(key)}]`,
						out,
						debtPaths,
						emittedPaths,
						activeSchemas,
						expandingCycle,
						descendantUntrusted,
						descendantAutoTrustAllowed,
					);
				}
				if (def.catchall) {
					if (asInternalZodSchema(def.catchall)._zod.def.type !== "never") {
						const catchallKeyPath = `${path}<catchall-key>`;
						if (!emittedPaths.has(catchallKeyPath)) {
							emittedPaths.add(catchallKeyPath);
							out.push({
								classification: "untrusted",
								classified: descendantUntrusted,
								path: catchallKeyPath,
							});
						}
					}
					walkOutputSchema(
						asInternalZodSchema(def.catchall),
						`${path}[*]`,
						out,
						debtPaths,
						emittedPaths,
						activeSchemas,
						expandingCycle,
						descendantUntrusted,
						descendantAutoTrustAllowed,
					);
				}
				break;
			}
			case "array":
				walkOutputSchema(
					asInternalZodSchema(def.element),
					`${path}[*]`,
					out,
					debtPaths,
					emittedPaths,
					activeSchemas,
					expandingCycle,
					descendantUntrusted,
					descendantAutoTrustAllowed,
				);
				break;
			case "tuple": {
				def.items.forEach((child, index) => {
					walkOutputSchema(
						asInternalZodSchema(child),
						`${path}[${index}]`,
						out,
						debtPaths,
						emittedPaths,
						activeSchemas,
						expandingCycle,
						descendantUntrusted,
						descendantAutoTrustAllowed,
					);
				});
				if (def.rest) {
					walkOutputSchema(
						asInternalZodSchema(def.rest),
						`${path}[*]`,
						out,
						debtPaths,
						emittedPaths,
						activeSchemas,
						expandingCycle,
						descendantUntrusted,
						descendantAutoTrustAllowed,
					);
				}
				break;
			}
			case "record":
				walkOutputSchema(
					asInternalZodSchema(def.keyType),
					`${path}<record-key>`,
					out,
					debtPaths,
					emittedPaths,
					activeSchemas,
					expandingCycle,
					descendantUntrusted,
					descendantAutoTrustAllowed,
				);
				walkOutputSchema(
					asInternalZodSchema(def.valueType),
					`${path}[*]`,
					out,
					debtPaths,
					emittedPaths,
					activeSchemas,
					expandingCycle,
					descendantUntrusted,
					descendantAutoTrustAllowed,
				);
				break;
			case "union":
				def.options.forEach((child, index) => {
					walkOutputSchema(
						asInternalZodSchema(child),
						`${path}<union:${index}>`,
						out,
						debtPaths,
						emittedPaths,
						activeSchemas,
						expandingCycle,
						descendantUntrusted,
						descendantAutoTrustAllowed,
					);
				});
				break;
			case "intersection":
				for (const [index, side] of [def.left, def.right].entries()) {
					walkOutputSchema(
						asInternalZodSchema(side),
						`${path}<intersection:${index}>`,
						out,
						debtPaths,
						emittedPaths,
						activeSchemas,
						expandingCycle,
						descendantUntrusted,
						descendantAutoTrustAllowed,
					);
				}
				break;
			case "optional":
			case "nullable":
			case "default":
			case "prefault":
			case "catch":
			case "readonly":
			case "nonoptional":
			case "promise":
				walkOutputSchema(
					asInternalZodSchema(def.innerType),
					path,
					out,
					debtPaths,
					emittedPaths,
					activeSchemas,
					expandingCycle,
					descendantUntrusted,
					descendantAutoTrustAllowed,
				);
				break;
			case "pipe":
				walkOutputSchema(
					asInternalZodSchema(def.out),
					path,
					out,
					debtPaths,
					emittedPaths,
					activeSchemas,
					expandingCycle,
					descendantUntrusted,
					descendantAutoTrustAllowed,
				);
				break;
			case "lazy":
				walkOutputSchema(
					asInternalZodSchema(def.getter()),
					path,
					out,
					debtPaths,
					emittedPaths,
					activeSchemas,
					expandingCycle,
					descendantUntrusted,
					descendantAutoTrustAllowed,
				);
				break;
			case "string":
			case "template_literal":
			case "literal":
			case "enum":
			case "number":
			case "bigint":
			case "boolean":
			case "date":
			case "symbol":
			case "undefined":
			case "null":
			case "any":
			case "unknown":
			case "never":
			case "void":
			case "map":
			case "set":
			case "function":
			case "custom":
			case "transform":
			case "nan":
			case "success":
			case "file":
				break;
			default:
				assertNeverZodDef(def);
		}
	} finally {
		if (!alreadyActive) activeSchemas.delete(schema);
	}
}

function resolveOutputTextLeaf(
	schema: InternalZodSchema,
	outerDeclarations: readonly TextTrustDeclaration[],
	autoTrustAllowed: boolean,
	inheritedUntrusted: boolean,
): OutputTextLeaf | undefined {
	const resolved = resolveOutputTextLeafPair(schema, outerDeclarations, autoTrustAllowed);
	return resolved?.[inheritedUntrusted ? "inherited" : "local"];
}

function resolveOutputTextLeafPair(
	schema: InternalZodSchema,
	outerDeclarations: readonly TextTrustDeclaration[],
	autoTrustAllowed: boolean,
): { readonly inherited: OutputTextLeaf; readonly local: OutputTextLeaf } | undefined {
	const declarations = [...outerDeclarations, readTextTrustDeclaration(schema)];
	const def = schema._zod.def;
	if (!isOutputTextLeafDef(def)) {
		const inner = flattenedOutputSchema(def);
		return inner
			? resolveOutputTextLeafPair(
					inner,
					declarations,
					autoTrustAllowed && !invalidatesOutputTextAutoTrust(def),
				)
			: undefined;
	}

	const autoTrusted =
		autoTrustAllowed && !invalidatesOutputTextAutoTrust(def) && isAutoTrustedOutputTextLeaf(schema);
	return {
		inherited: classifyOutputTextLeaf(declarations, autoTrusted, true),
		local: classifyOutputTextLeaf(declarations, autoTrusted, false),
	};
}

function classifyOutputTextLeaf(
	declarations: readonly TextTrustDeclaration[],
	autoTrusted: boolean,
	inheritedUntrusted: boolean,
): OutputTextLeaf {
	if (declarations.includes("invalid")) {
		return { classification: "untrusted", classified: false };
	}
	if (declarations.includes("untrusted")) {
		return { classification: "untrusted", classified: true };
	}
	if (declarations.includes("trusted")) {
		return {
			classification: autoTrusted ? "trusted" : "untrusted",
			classified: autoTrusted,
		};
	}
	if (inheritedUntrusted) {
		return { classification: "untrusted", classified: true };
	}
	return autoTrusted
		? { classification: "trusted", classified: true }
		: { classification: "untrusted", classified: false };
}

function flattenedOutputSchema(def: InternalZodDef): InternalZodSchema | undefined {
	switch (def.type) {
		case "optional":
		case "nullable":
		case "default":
		case "prefault":
		case "catch":
		case "readonly":
		case "nonoptional":
		case "promise":
			return asInternalZodSchema(def.innerType);
		case "pipe":
			return asInternalZodSchema(def.out);
		case "lazy":
			return asInternalZodSchema(def.getter());
		case "string":
		case "template_literal":
		case "literal":
		case "enum":
		case "number":
		case "bigint":
		case "boolean":
		case "date":
		case "symbol":
		case "undefined":
		case "null":
		case "any":
		case "unknown":
		case "never":
		case "void":
		case "object":
		case "array":
		case "tuple":
		case "record":
		case "union":
		case "intersection":
		case "map":
		case "set":
		case "function":
		case "custom":
		case "transform":
		case "nan":
		case "success":
		case "file":
			return undefined;
		default:
			return assertNeverZodDef(def);
	}
}

function isOutputTextLeafDef(def: InternalZodDef): boolean {
	switch (def.type) {
		case "string":
		case "template_literal":
			return true;
		case "literal":
			return def.values.some((value) => typeof value === "string");
		case "enum":
			return Object.values(def.entries).some((value) => typeof value === "string");
		case "any":
		case "unknown":
		case "custom":
		case "transform":
			return true;
		default:
			return false;
	}
}

function isAutoTrustedOutputTextLeaf(schema: InternalZodSchema): boolean {
	const def = schema._zod.def;
	if (hasUnsafeOutputCheck(def)) return false;
	if (def.type === "literal" || def.type === "enum") return isOutputTextLeafDef(def);
	if (def.type !== "string" && def.type !== "template_literal") return false;

	const { bag, pattern } = schema._zod;
	if (hasSdkOwnedStringFormatValidator(schema)) {
		return true;
	}

	if (pattern instanceof RegExp && isRestrictiveAnchoredPattern(pattern)) return true;
	const patterns = bag.patterns;
	return (
		patterns instanceof Set &&
		patterns.size > 0 &&
		[...patterns].every(
			(candidate) => candidate instanceof RegExp && isRestrictiveAnchoredPattern(candidate),
		)
	);
}

function hasUnsafeOutputCheck(def: InternalZodDef): boolean {
	const checks = Reflect.get(def, "checks");
	return (
		Array.isArray(checks) &&
		checks.some((check) => {
			if (!check || typeof check !== "object") return false;
			const internals = Reflect.get(check, "_zod");
			if (!internals || typeof internals !== "object") return false;
			const checkDef = Reflect.get(internals, "def");
			if (!checkDef || typeof checkDef !== "object") return false;
			const kind = Reflect.get(checkDef, "check");
			return kind === "overwrite" || kind === "custom";
		})
	);
}

function invalidatesOutputTextAutoTrust(def: InternalZodDef): boolean {
	return (
		def.type === "default" ||
		def.type === "catch" ||
		def.type === "transform" ||
		hasUnsafeOutputCheck(def)
	);
}

interface OwnedStringFormatValidator {
	readonly constructor: unknown;
	readonly patternFlags: string;
	readonly patternSource: string;
}

const SDK_OWNED_STRING_FORMAT_VALIDATORS: readonly OwnedStringFormatValidator[] = [
	z.cidrv4(),
	z.cidrv6(),
	z.cuid(),
	z.cuid2(),
	z.iso.date(),
	z.iso.datetime(),
	z.iso.duration(),
	z.e164(),
	z.guid(),
	z.ipv4(),
	z.ipv6(),
	z.ksuid(),
	z.nanoid(),
	z.iso.time(),
	z.ulid(),
	z.uuid(),
	z.xid(),
].map((validator) => {
	const pattern = Reflect.get(validator._zod.def, "pattern");
	if (!(pattern instanceof RegExp)) {
		throw new TypeError("SDK-owned Zod string format validator is missing its pattern.");
	}
	return {
		constructor: validator.constructor,
		patternFlags: pattern.flags,
		patternSource: pattern.source,
	};
});

function hasSdkOwnedStringFormatValidator(schema: InternalZodSchema): boolean {
	const candidates: unknown[] = [schema];
	const checks = Reflect.get(schema._zod.def, "checks");
	if (Array.isArray(checks)) candidates.push(...checks);
	return candidates.some((candidate) => {
		if (!candidate || typeof candidate !== "object") return false;
		const internals = Reflect.get(candidate, "_zod");
		if (!internals || typeof internals !== "object") return false;
		const def = Reflect.get(internals, "def");
		if (!def || typeof def !== "object" || Reflect.has(def, "fn")) return false;
		const pattern = Reflect.get(def, "pattern");
		if (!(pattern instanceof RegExp)) return false;
		return SDK_OWNED_STRING_FORMAT_VALIDATORS.some(
			(owned) =>
				Reflect.get(candidate, "constructor") === owned.constructor &&
				pattern.source === owned.patternSource &&
				pattern.flags === owned.patternFlags,
		);
	});
}

function isRestrictiveAnchoredPattern(pattern: RegExp): boolean {
	if (pattern.multiline) return false;
	const alternatives = splitTopLevelRegexAlternatives(pattern.source);
	return (
		alternatives.length > 0 &&
		alternatives.every(
			(alternative) =>
				alternative.startsWith("^") &&
				alternative.endsWith("$") &&
				isProvablyRestrictedRegexBody(alternative.slice(1, -1)),
		)
	);
}

function splitTopLevelRegexAlternatives(source: string): string[] {
	const alternatives: string[] = [];
	let start = 0;
	let escaped = false;
	let inCharacterClass = false;
	let groupDepth = 0;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "[") {
			inCharacterClass = true;
			continue;
		}
		if (character === "]") {
			inCharacterClass = false;
			continue;
		}
		if (inCharacterClass) continue;
		if (character === "(") {
			groupDepth += 1;
			continue;
		}
		if (character === ")") {
			groupDepth -= 1;
			continue;
		}
		if (character === "|" && groupDepth === 0) {
			alternatives.push(source.slice(start, index));
			start = index + 1;
		}
	}
	alternatives.push(source.slice(start));
	return alternatives;
}

function isProvablyRestrictedRegexBody(source: string): boolean {
	let groupDepth = 0;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === "\\") {
			const escapedLength = safeRegexEscapeLength(source.slice(index));
			if (escapedLength === 0) return false;
			index += escapedLength - 1;
			continue;
		}
		if (character === "[") {
			const classLength = safeRegexCharacterClassLength(source.slice(index));
			if (classLength === 0) return false;
			index += classLength - 1;
			continue;
		}
		if (character === "(") {
			if (source[index + 1] === "?") {
				if (source.slice(index, index + 3) !== "(?:") return false;
				index += 2;
			}
			groupDepth += 1;
			continue;
		}
		if (character === ")") {
			if (groupDepth === 0) return false;
			groupDepth -= 1;
			continue;
		}
		if (character === "{") {
			const match = /^\{(\d+)(?:,(\d+))?\}/.exec(source.slice(index));
			if (!match) return false;
			const minimum = Number(match[1]);
			const maximum = match[2] === undefined ? minimum : Number(match[2]);
			if (!Number.isSafeInteger(maximum) || maximum < minimum) return false;
			index += match[0].length - 1;
			continue;
		}
		if (
			character === "." ||
			character === "*" ||
			character === "+" ||
			character === "^" ||
			character === "$" ||
			character === "}" ||
			/\s/u.test(character)
		) {
			return false;
		}
		if (character === "|" && groupDepth === 0) return false;
	}
	return groupDepth === 0;
}

function safeRegexCharacterClassLength(source: string): number {
	if (!source.startsWith("[") || source[1] === "^") return 0;
	for (let index = 1; index < source.length; index += 1) {
		const character = source[index];
		if (character === "]") return index + 1;
		if (character === "-") {
			if (index === 1 || source[index + 1] === "]") continue;
			return 0;
		}

		const atomLength = regexCharacterClassAtomLength(source.slice(index));
		if (atomLength === 0) return 0;
		const rangeSeparator = index + atomLength;
		if (source[rangeSeparator] === "-" && source[rangeSeparator + 1] !== "]") {
			const endIndex = rangeSeparator + 1;
			const endLength = regexCharacterClassAtomLength(source.slice(endIndex));
			if (endLength === 0 || !isSafeRegexCharacterRange(source, index, endIndex)) return 0;
			index = endIndex + endLength - 1;
			continue;
		}
		index += atomLength - 1;
	}
	return 0;
}

function regexCharacterClassAtomLength(source: string): number {
	const character = source[0];
	if (character === undefined) return 0;
	if (/^[A-Za-z0-9]$/.test(character)) return 1;
	return character === "\\" && SAFE_REGEX_ESCAPED_PUNCTUATION.includes(source[1] ?? "") ? 2 : 0;
}

function isSafeRegexCharacterRange(source: string, startIndex: number, endIndex: number): boolean {
	const start = regexCharacterClassLiteralCodePoint(source, startIndex);
	const end = regexCharacterClassLiteralCodePoint(source, endIndex);
	if (start === undefined || end === undefined || start > end) return false;
	return [
		["0".codePointAt(0), "9".codePointAt(0)],
		["A".codePointAt(0), "Z".codePointAt(0)],
		["a".codePointAt(0), "z".codePointAt(0)],
	].some(
		([minimum, maximum]) =>
			minimum !== undefined && maximum !== undefined && start >= minimum && end <= maximum,
	);
}

function regexCharacterClassLiteralCodePoint(source: string, index: number): number | undefined {
	const character = source[index];
	if (character !== "\\") return character?.codePointAt(0);
	const escaped = source[index + 1];
	if (escaped === undefined || escaped === "d" || escaped === "w") return undefined;
	return escaped.codePointAt(0);
}

function safeRegexEscapeLength(source: string): number {
	const escaped = source[1];
	if (escaped === "d" || escaped === "w") return 2;
	return escaped !== undefined && SAFE_REGEX_ESCAPED_PUNCTUATION.includes(escaped) ? 2 : 0;
}

const SAFE_REGEX_ESCAPED_PUNCTUATION = "\\/.-^$*+?()[]{}|";

function requireOutputTextTrustSchema(schema: unknown): InternalZodSchema {
	if (!(schema instanceof z.ZodType)) throw new OutputTextTrustSchemaError(schema);
	return asInternalZodSchema(schema);
}

function asInternalZodSchema(schema: z.core.$ZodType): InternalZodSchema {
	// Zod's child-definition fields use the base type and erase the concrete
	// union member. This is the only cast boundary; all callers immediately
	// narrow the returned discriminated definition by `def.type`.
	return schema as InternalZodSchema;
}

function assertNeverZodDef(def: never): never {
	throw new Error(`Unsupported Zod definition: ${String((def as { type?: unknown }).type)}`);
}

function readTextTrustDeclaration(schema: unknown): TextTrustDeclaration {
	const metadata = readZodMetadata(schema);
	if (!metadata || !Reflect.has(metadata, APIFUSE_TEXT_TRUST_META_KEY)) return "absent";
	const value = Reflect.get(metadata, APIFUSE_TEXT_TRUST_META_KEY);
	if (!value || typeof value !== "object") return "invalid";
	if (Reflect.get(value, "v") !== 1) return "invalid";
	const trust = Reflect.get(value, "trust");
	return trust === "trusted" || trust === "untrusted" ? trust : "invalid";
}

export function isSensitiveSchema(schema: unknown): boolean {
	const metadata = readZodMetadata(schema);
	return metadata !== undefined && Reflect.get(metadata, APIFUSE_SENSITIVE_META_KEY) === true;
}

export function collectSensitivePaths(schema: unknown): SensitivePath[] {
	const out: SensitivePath[] = [];
	collectSensitivePathsInto(schema, [], out, new Set(), new Set());
	return out;
}

export function redactPayload(value: unknown, paths: readonly SensitivePath[] = []): unknown {
	return redactValue(value, [], paths);
}

function collectSensitivePathsInto(
	schema: unknown,
	path: SensitivePathSegment[],
	out: SensitivePath[],
	activeSchemas: Set<unknown>,
	emittedPaths: Set<string>,
): void {
	if (!schema || typeof schema !== "object" || activeSchemas.has(schema)) return;
	activeSchemas.add(schema);
	try {
		if (isSensitiveSchema(schema)) pushSensitivePath(out, emittedPaths, path);
		const def = readZodDef(schema);
		if (!def) return;
		switch (Reflect.get(def, "type")) {
			case "object": {
				const shape = readObjectShape(def);
				for (const [key, child] of Object.entries(shape)) {
					collectSensitivePathsInto(child, [...path, key], out, activeSchemas, emittedPaths);
				}
				break;
			}
			case "array":
				collectSensitivePathsInto(
					Reflect.get(def, "element"),
					[...path, "*"],
					out,
					activeSchemas,
					emittedPaths,
				);
				break;
			case "optional":
			case "nullable":
			case "default":
			case "catch":
			case "readonly":
				collectSensitivePathsInto(
					Reflect.get(def, "innerType"),
					path,
					out,
					activeSchemas,
					emittedPaths,
				);
				break;
			case "pipe":
				collectSensitivePathsInto(Reflect.get(def, "in"), path, out, activeSchemas, emittedPaths);
				collectSensitivePathsInto(Reflect.get(def, "out"), path, out, activeSchemas, emittedPaths);
				break;
		}
	} finally {
		activeSchemas.delete(schema);
	}
}

function pushSensitivePath(
	out: SensitivePath[],
	emittedPaths: Set<string>,
	path: SensitivePathSegment[],
): void {
	const key = JSON.stringify(path);
	if (emittedPaths.has(key)) return;
	emittedPaths.add(key);
	out.push([...path]);
}

function redactValue(
	value: unknown,
	path: SensitivePathSegment[],
	paths: readonly SensitivePath[],
): unknown {
	if (pathMatches(path, paths)) return APIFUSE_REDACTION_MARKER;
	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item, [...path, "*"], paths));
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			if (isReservedSensitiveKey(key)) {
				out[key] = APIFUSE_REDACTION_MARKER;
			} else {
				out[key] = redactValue(child, [...path, key], paths);
			}
		}
		return out;
	}
	return value;
}

function pathMatches(
	path: readonly SensitivePathSegment[],
	patterns: readonly SensitivePath[],
): boolean {
	return patterns.some((pattern) => {
		if (pattern.length !== path.length) return false;
		return pattern.every((segment, index) => segment === "*" || segment === path[index]);
	});
}

function isReservedSensitiveKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
	return RESERVED_SENSITIVE_KEYS.has(normalized) || RESERVED_SENSITIVE_KEYS.has(key.toLowerCase());
}

function readZodMetadata(schema: unknown): object | undefined {
	if (!schema || typeof schema !== "object" || !("meta" in schema)) {
		return undefined;
	}
	const maybeMeta = schema.meta;
	if (typeof maybeMeta !== "function") return undefined;
	const metadata = maybeMeta.call(schema);
	return metadata && typeof metadata === "object" ? metadata : undefined;
}

function readZodDef(schema: unknown): object | undefined {
	if (!schema || typeof schema !== "object") return undefined;
	const def = Reflect.get(schema, "def") ?? Reflect.get(schema, "_def");
	return def && typeof def === "object" ? def : undefined;
}

function readObjectShape(def: object): object {
	const shape = Reflect.get(def, "shape");
	const value = typeof shape === "function" ? shape() : shape;
	return value && typeof value === "object" ? value : {};
}
