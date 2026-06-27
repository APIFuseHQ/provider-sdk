import { type ZodString, type ZodType, z } from "zod";

import { ValidationError } from "./errors";
import { providerLocaleKey } from "./i18n/keys";
import type {
	InferSchemaOutput,
	ProviderLocaleKey,
	SchemaLike,
	StandardSchemaV1,
} from "./types";

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
	result:
		| StandardSchemaV1.Result<Output>
		| Promise<StandardSchemaV1.Result<Output>>,
): result is Promise<StandardSchemaV1.Result<Output>> {
	return result instanceof Promise;
}
function formatStandardSchemaIssues(
	issues: readonly StandardSchemaV1.Issue[],
): string {
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
	if ("parse" in schema && typeof schema.parse === "function")
		return schema.parse(value);
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
		if (isFailureResult(result))
			return { success: false, error: result.issues };
		return { success: true, data: result.value };
	} catch (error) {
		return { success: false, error };
	}
}

export const APIFUSE_SENSITIVE_META_KEY = "x-apifuse-sensitive";
export const APIFUSE_SENSITIVE_KIND_META_KEY = "x-apifuse-sensitive-kind";
export const APIFUSE_DESCRIPTION_KEY_META_KEY = "x-apifuse-description-key";
export const APIFUSE_REDACTION_MARKER = "<redacted>";

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

declare module "zod" {
	interface ZodType {
		describeKey(key: ProviderLocaleKey | string): this;
	}
}

const describeKeyMethod = function <TSchema extends ZodType>(
	this: TSchema,
	key: ProviderLocaleKey | string,
): TSchema {
	return describeKey(this, key);
};

function installDescribeKeyOnPrototype(prototype: unknown): void {
	const target = prototype as
		| (Record<string, unknown> & { describeKey?: unknown })
		| null;
	if (!target || typeof target.describeKey === "function") {
		return;
	}
	Object.defineProperty(target, "describeKey", {
		configurable: true,
		value: describeKeyMethod,
		writable: true,
	});
}

for (const [name, value] of Object.entries(z)) {
	if (!name.startsWith("Zod") || name.endsWith("Error")) {
		continue;
	}
	if (typeof value !== "function") {
		continue;
	}
	installDescribeKeyOnPrototype(value.prototype);
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
		...((options.sensitive ?? true)
			? { [APIFUSE_SENSITIVE_META_KEY]: true }
			: {}),
		...(options.kind
			? { [APIFUSE_SENSITIVE_KIND_META_KEY]: options.kind }
			: {}),
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
	const schema =
		options.minLength === undefined
			? z.string()
			: z.string().min(options.minLength);
	return field(schema, {
		kind,
		description: options.description ?? description,
	});
}

export const fields = {
	apiKey: (options?: { description?: string }) =>
		sensitiveString(
			"api_key",
			"Provider API key or credential secret.",
			options,
		),
	authorization: (options?: { description?: string }) =>
		sensitiveString(
			"authorization",
			"Authorization header value or bearer credential.",
			options,
		),
	cookie: (options?: { description?: string }) =>
		sensitiveString(
			"cookie",
			"Cookie header or browser session secret.",
			options,
		),
	otp: (options?: { description?: string }) =>
		sensitiveString("otp", "One-time verification code.", options),
	password: (options?: { description?: string; minLength?: number }) =>
		sensitiveString("password", "Password credential.", options),
	paymentUrl: (options?: { description?: string }) =>
		sensitiveString(
			"payment_url",
			"Sensitive payment or checkout URL.",
			options,
		),
	phone: (options?: { description?: string }) =>
		sensitiveString("phone", "Phone number or phone-based identity.", options),
	secret: (options?: { description?: string }) =>
		sensitiveString("secret", "Provider secret material.", options),
	token: (options?: { description?: string }) =>
		sensitiveString("token", "Provider access or refresh token.", options),
} as const;

export function isSensitiveSchema(schema: unknown): boolean {
	const metadata = readZodMetadata(schema);
	return (
		metadata !== undefined &&
		Reflect.get(metadata, APIFUSE_SENSITIVE_META_KEY) === true
	);
}

export function collectSensitivePaths(schema: unknown): SensitivePath[] {
	const out: SensitivePath[] = [];
	collectSensitivePathsInto(schema, [], out, new Set(), new Set());
	return out;
}

export function redactPayload(
	value: unknown,
	paths: readonly SensitivePath[] = [],
): unknown {
	return redactValue(value, [], paths);
}

function collectSensitivePathsInto(
	schema: unknown,
	path: SensitivePathSegment[],
	out: SensitivePath[],
	activeSchemas: Set<unknown>,
	emittedPaths: Set<string>,
): void {
	if (!schema || typeof schema !== "object" || activeSchemas.has(schema))
		return;
	activeSchemas.add(schema);
	try {
		if (isSensitiveSchema(schema)) pushSensitivePath(out, emittedPaths, path);
		const def = readZodDef(schema);
		if (!def) return;
		switch (Reflect.get(def, "type")) {
			case "object": {
				const shape = readObjectShape(def);
				for (const [key, child] of Object.entries(shape)) {
					collectSensitivePathsInto(
						child,
						[...path, key],
						out,
						activeSchemas,
						emittedPaths,
					);
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
				collectSensitivePathsInto(
					Reflect.get(def, "in"),
					path,
					out,
					activeSchemas,
					emittedPaths,
				);
				collectSensitivePathsInto(
					Reflect.get(def, "out"),
					path,
					out,
					activeSchemas,
					emittedPaths,
				);
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
		return pattern.every(
			(segment, index) => segment === "*" || segment === path[index],
		);
	});
}

function isReservedSensitiveKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
	return (
		RESERVED_SENSITIVE_KEYS.has(normalized) ||
		RESERVED_SENSITIVE_KEYS.has(key.toLowerCase())
	);
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
