import { createHash } from "node:crypto";
import { type ZodType, z } from "zod";
import {
	canonicalJson,
	compactObject,
	isRecord,
	type JsonValue,
	toJsonValue,
} from "./contract-json.js";
import { APIFUSE_URL_KIND_META_KEY } from "./output-url.js";
import type { SchemaLike } from "./types.js";

export function describeSchema(schema: SchemaLike): JsonValue {
	if (isZodSchema(schema)) {
		const jsonSchema = zodJsonSchema(schema);
		return compactObject({
			kind: "schema",
			vendor: "zod",
			typeName: getSchemaTypeName(schema),
			jsonSchema,
			jsonSchemaHash: jsonSchema === undefined ? undefined : digest(canonicalJson(jsonSchema)),
		});
	}
	const standard = isRecord(schema) ? schema["~standard"] : undefined;
	if (isRecord(standard)) {
		return compactObject({
			kind: "schema",
			standard: "standard-schema-v1",
			vendor: typeof standard.vendor === "string" ? standard.vendor : "unknown",
			version:
				typeof standard.version === "number" || typeof standard.version === "string"
					? standard.version
					: undefined,
		});
	}
	return compactObject({
		kind: "schema",
		vendor: "zod",
		typeName: getSchemaTypeName(schema),
	});
}

export function serializeSmsMatcher(value: Record<string, unknown>): Record<string, unknown> {
	const code = value.code;
	if (!isRecord(code)) return value;
	const pattern = code.pattern;
	if (!(pattern instanceof RegExp)) return value;
	return {
		...value,
		code: {
			...code,
			pattern: {
				source: pattern.source,
				flags: pattern.flags,
			},
		},
	};
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isZodSchema(schema: unknown): schema is ZodType {
	return schema instanceof z.ZodType;
}

/**
 * The JSON Schema of a zod schema as contract extraction emits it, or
 * `undefined` for any other schema. Throws when the conversion fails.
 */
export function zodSchemaToJson(schema: unknown): JsonValue | undefined {
	return isZodSchema(schema) ? zodJsonSchema(schema) : undefined;
}

function zodJsonSchema(schema: ZodType): JsonValue {
	const jsonSchema = toJsonValue(z.toJSONSchema(schema));
	if (jsonSchema === undefined) {
		throw new TypeError("z.toJSONSchema() returned a non-JSON value");
	}
	return foldUrlKindNullBranches(jsonSchema);
}

type JsonObject = { readonly [key: string]: JsonValue };

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return isRecord(value);
}

function isNullBranch(value: JsonValue | undefined): boolean {
	return isJsonObject(value) && Object.keys(value).length === 1 && value.type === "null";
}

/** The non-null branch of a two-branch `{ anyOf: [X, { type: "null" }] }`, in either order. */
function nullableBranch(node: JsonObject): JsonObject | undefined {
	const variants = node.anyOf;
	if (!Array.isArray(variants) || variants.length !== 2) return undefined;
	const [first, second]: readonly JsonValue[] = variants;
	const branch = isNullBranch(second) ? first : isNullBranch(first) ? second : undefined;
	return isJsonObject(branch) && !isNullBranch(branch) ? branch : undefined;
}

/**
 * The output URL helpers already admit `null`, so `image().nullable()` (or
 * `.nullish()`) wraps a second `null` branch around one: `{ anyOf: [{ anyOf:
 * [X, null] }, null] }`. Both spellings mean the same contract, so they are
 * emitted as the helper alone, with the inner node's other keys moved up when
 * they do not collide. Only nodes around an annotated URL are folded, so no
 * contract written without the helpers changes.
 */
export function foldUrlKindNullBranches(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map((item: JsonValue) => foldUrlKindNullBranches(item));
	if (!isJsonObject(value)) return value;
	let node: JsonObject = Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, foldUrlKindNullBranches(entry)]),
	);
	for (;;) {
		// node = { anyOf: [inner, null] } and inner = { anyOf: [X, null] } with X annotated.
		const inner = nullableBranch(node);
		const annotated = inner === undefined ? undefined : nullableBranch(inner);
		if (!inner || typeof annotated?.[APIFUSE_URL_KIND_META_KEY] !== "string") return node;
		const outerKeys = Object.entries(node).filter(([key]) => key !== "anyOf");
		const innerKeys = Object.entries(inner).filter(([key]) => key !== "anyOf");
		if (innerKeys.some(([key]) => Object.hasOwn(node, key))) return node;
		node = Object.fromEntries([...innerKeys, ...outerKeys, ["anyOf", inner.anyOf ?? null]]);
	}
}

function getSchemaTypeName(schema: SchemaLike): string | undefined {
	if (!isRecord(schema)) return undefined;
	const def = schema._def;
	if (!isRecord(def)) return undefined;
	const typeName = def.typeName ?? def.type;
	return typeof typeName === "string" ? typeName : undefined;
}
