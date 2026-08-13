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
 * bounded anchored patterns that exclude whitespace, wildcard, and negated
 * character classes, and the formats listed here. A brand is trusted only
 * when its underlying schema meets one of those rules. Length-only strings
 * and other formats (including email, URL, base64, and JWT) are not trusted.
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

const AUTO_TRUSTED_ZOD_STRING_FORMAT_SET = new Set<string>(AUTO_TRUSTED_ZOD_STRING_FORMATS);

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

interface OutputTextLeaf {
	readonly classification: TextTrust;
	readonly classified: boolean;
}

/**
 * Collect every textual leaf in a Zod output schema as a deterministic
 * schema-path-to-classification object. The path grammar is rooted at `$`:
 * object keys are `["key"]`, arrays and record values are `[*]`, tuple slots
 * are `[n]`, union/intersection alternatives are `<union:n>` / `<intersection:n>`,
 * record keys are `<record-key>`, and one bounded cycle expansion is marked
 * `<recursive>`.
 */
export function collectOutputTextTrust(schema: unknown): OutputTextTrustMap {
	return Object.fromEntries(
		collectOutputTextLeaves(schema)
			.map(({ path, classification }) => [path, classification] as const)
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}

/** Report textual output paths that lack a valid explicit or auto-derived classification. */
export function findUnclassifiedOutputTextPaths(schema: unknown): string[] {
	return collectOutputTextLeaves(schema)
		.filter(({ classified }) => !classified)
		.map(({ path }) => path)
		.sort((left, right) => left.localeCompare(right));
}

/** @internal Used by contract JSON Schema projection. */
export function resolveOutputTextTrust(schema: unknown): TextTrust | undefined {
	return resolveOutputTextLeaf(schema)?.classification;
}

/** @internal Resolves a text leaf flattened into the same JSON Schema node by a Zod wrapper. */
export function resolveFlattenedOutputTextTrust(schema: unknown): TextTrust | undefined {
	const def = readZodDef(schema);
	if (!def) return undefined;
	switch (Reflect.get(def, "type")) {
		case "optional":
		case "default":
		case "prefault":
		case "catch":
		case "readonly":
		case "nonoptional":
		case "promise":
			return (
				resolveOutputTextTrust(Reflect.get(def, "innerType")) ??
				resolveFlattenedOutputTextTrust(Reflect.get(def, "innerType"))
			);
		case "pipe":
			return (
				resolveOutputTextTrust(Reflect.get(def, "out")) ??
				resolveFlattenedOutputTextTrust(Reflect.get(def, "out"))
			);
		default:
			return undefined;
	}
}

/** @internal Distinguishes authored metadata from extension properties inherited through wrappers. */
export function hasOutputTextTrustMetadata(schema: unknown): boolean {
	const metadata = readZodMetadata(schema);
	return metadata !== undefined && Reflect.has(metadata, APIFUSE_TEXT_TRUST_META_KEY);
}

function collectOutputTextLeaves(
	schema: unknown,
): Array<OutputTextLeaf & { readonly path: string }> {
	const out: Array<OutputTextLeaf & { readonly path: string }> = [];
	const emittedPaths = new Set<string>();
	walkOutputSchema(schema, "$", out, emittedPaths, new Set(), false, false);
	return out;
}

function walkOutputSchema(
	schema: unknown,
	path: string,
	out: Array<OutputTextLeaf & { readonly path: string }>,
	emittedPaths: Set<string>,
	activeSchemas: Set<unknown>,
	expandingCycle: boolean,
	allowActiveSchema: boolean,
): void {
	if (!schema || typeof schema !== "object") return;
	const alreadyActive = activeSchemas.has(schema);
	if (alreadyActive && !allowActiveSchema) {
		if (!expandingCycle) {
			walkOutputSchema(schema, `${path}<recursive>`, out, emittedPaths, activeSchemas, true, true);
		}
		return;
	}

	const leaf = resolveOutputTextLeaf(schema);
	if (leaf) {
		if (!emittedPaths.has(path)) {
			emittedPaths.add(path);
			out.push({ path, ...leaf });
		}
		return;
	}

	const def = readZodDef(schema);
	if (!def) return;
	if (!alreadyActive) activeSchemas.add(schema);
	try {
		switch (Reflect.get(def, "type")) {
			case "object": {
				const shape = readObjectShape(def);
				for (const [key, child] of Object.entries(shape).sort(([left], [right]) =>
					left.localeCompare(right),
				)) {
					walkOutputSchema(
						child,
						`${path}[${JSON.stringify(key)}]`,
						out,
						emittedPaths,
						activeSchemas,
						expandingCycle,
						false,
					);
				}
				const catchall = Reflect.get(def, "catchall");
				if (catchall) {
					walkOutputSchema(
						catchall,
						`${path}[*]`,
						out,
						emittedPaths,
						activeSchemas,
						expandingCycle,
						false,
					);
				}
				break;
			}
			case "array":
				walkOutputSchema(
					Reflect.get(def, "element"),
					`${path}[*]`,
					out,
					emittedPaths,
					activeSchemas,
					expandingCycle,
					false,
				);
				break;
			case "tuple": {
				const items = Reflect.get(def, "items");
				if (Array.isArray(items)) {
					items.forEach((child, index) => {
						walkOutputSchema(
							child,
							`${path}[${index}]`,
							out,
							emittedPaths,
							activeSchemas,
							expandingCycle,
							false,
						);
					});
				}
				const rest = Reflect.get(def, "rest");
				if (rest) {
					walkOutputSchema(
						rest,
						`${path}[*]`,
						out,
						emittedPaths,
						activeSchemas,
						expandingCycle,
						false,
					);
				}
				break;
			}
			case "record":
				walkOutputSchema(
					Reflect.get(def, "keyType"),
					`${path}<record-key>`,
					out,
					emittedPaths,
					activeSchemas,
					expandingCycle,
					false,
				);
				walkOutputSchema(
					Reflect.get(def, "valueType"),
					`${path}[*]`,
					out,
					emittedPaths,
					activeSchemas,
					expandingCycle,
					false,
				);
				break;
			case "union": {
				const options = Reflect.get(def, "options");
				if (Array.isArray(options)) {
					options.forEach((child, index) => {
						walkOutputSchema(
							child,
							`${path}<union:${index}>`,
							out,
							emittedPaths,
							activeSchemas,
							expandingCycle,
							false,
						);
					});
				}
				break;
			}
			case "intersection":
				for (const [index, side] of ["left", "right"].entries()) {
					walkOutputSchema(
						Reflect.get(def, side),
						`${path}<intersection:${index}>`,
						out,
						emittedPaths,
						activeSchemas,
						expandingCycle,
						false,
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
					Reflect.get(def, "innerType"),
					path,
					out,
					emittedPaths,
					activeSchemas,
					expandingCycle,
					false,
				);
				break;
			case "pipe":
				walkOutputSchema(
					Reflect.get(def, "out"),
					path,
					out,
					emittedPaths,
					activeSchemas,
					expandingCycle,
					false,
				);
				break;
			case "lazy": {
				const getter = Reflect.get(def, "getter");
				if (typeof getter === "function") {
					walkOutputSchema(getter(), path, out, emittedPaths, activeSchemas, expandingCycle, false);
				}
				break;
			}
		}
	} finally {
		if (!alreadyActive) activeSchemas.delete(schema);
	}
}

function resolveOutputTextLeaf(schema: unknown): OutputTextLeaf | undefined {
	if (!isOutputTextLeafSchema(schema)) return undefined;
	const declaration = readTextTrustDeclaration(schema);
	const autoTrusted = isAutoTrustedOutputTextLeaf(schema);
	if (declaration === "untrusted") {
		return { classification: "untrusted", classified: true };
	}
	if (declaration === "trusted") {
		return {
			classification: autoTrusted ? "trusted" : "untrusted",
			classified: autoTrusted,
		};
	}
	if (declaration === "invalid") {
		return { classification: "untrusted", classified: false };
	}
	return autoTrusted
		? { classification: "trusted", classified: true }
		: { classification: "untrusted", classified: false };
}

function isOutputTextLeafSchema(schema: unknown): boolean {
	const def = readZodDef(schema);
	if (!def) return false;
	const type = Reflect.get(def, "type");
	if (type === "string" || type === "template_literal") return true;
	if (type === "literal") {
		const values = Reflect.get(def, "values");
		return Array.isArray(values) && values.some((value) => typeof value === "string");
	}
	if (type === "enum") {
		const entries = Reflect.get(def, "entries");
		return (
			entries !== null &&
			typeof entries === "object" &&
			Object.values(entries).some((value) => typeof value === "string")
		);
	}
	return false;
}

function isAutoTrustedOutputTextLeaf(schema: unknown): boolean {
	const def = readZodDef(schema);
	if (!def) return false;
	const type = Reflect.get(def, "type");
	if (type === "literal" || type === "enum") return isOutputTextLeafSchema(schema);
	if (type !== "string" && type !== "template_literal") return false;

	const internals = Reflect.get(schema as object, "_zod");
	const bag =
		internals && typeof internals === "object" ? Reflect.get(internals, "bag") : undefined;
	const format =
		typeof Reflect.get(def, "format") === "string"
			? Reflect.get(def, "format")
			: bag && typeof bag === "object"
				? Reflect.get(bag, "format")
				: undefined;
	if (typeof format === "string" && AUTO_TRUSTED_ZOD_STRING_FORMAT_SET.has(format)) {
		return true;
	}

	const pattern = Reflect.get(internals, "pattern");
	if (pattern instanceof RegExp && isRestrictiveAnchoredPattern(pattern)) return true;
	const patterns = bag && typeof bag === "object" ? Reflect.get(bag, "patterns") : undefined;
	return (
		patterns instanceof Set &&
		patterns.size > 0 &&
		[...patterns].every(
			(candidate) => candidate instanceof RegExp && isRestrictiveAnchoredPattern(candidate),
		)
	);
}

function isRestrictiveAnchoredPattern(pattern: RegExp): boolean {
	if (pattern.multiline) return false;
	const source = pattern.source;
	if (!source.startsWith("^") || !source.endsWith("$")) return false;
	if (/\[\^/.test(source)) return false;
	if (/\\[sS]|\\p\{(?:Z|Separator)/u.test(source)) return false;
	if (/(^|[^\\])\./.test(source)) return false;
	if (/[\t\n\r ]/.test(source)) return false;
	return !hasUnboundedRegexQuantifier(source);
}

function hasUnboundedRegexQuantifier(source: string): boolean {
	let escaped = false;
	let inCharacterClass = false;
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
		if (character === "+" || character === "*") return true;
		if (character === "{" && /^\{\d+,\}/.test(source.slice(index))) return true;
	}
	return false;
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
