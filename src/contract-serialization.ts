import { createHash } from "node:crypto";
import { type ZodType, z } from "zod";
import {
	canonicalJson,
	compactObject,
	isRecord,
	type JsonValue,
	toJsonValue,
} from "./contract-json.js";
import { APIFUSE_TEXT_TRUST_META_KEY, resolveOutputTextTrust } from "./schema.js";
import type { SchemaLike } from "./types.js";

interface DescribeSchemaOptions {
	readonly outputTextTrust?: boolean;
}

export class OutputTextTrustProjectionError extends Error {
	readonly classification = "untrusted" as const;
	readonly code = "output_text_trust_projection_failed";

	constructor(
		public readonly schemaPath: string,
		cause: unknown,
	) {
		super(`Output text-trust projection failed at schema path ${schemaPath}.`);
		this.name = "OutputTextTrustProjectionError";
		this.cause = cause;
	}
}

export function describeSchema(schema: SchemaLike, options: DescribeSchemaOptions = {}): JsonValue {
	if (isZodSchema(schema)) {
		const jsonSchema = zodJsonSchema(schema, options);
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

function isZodSchema(schema: SchemaLike): schema is ZodType {
	return schema instanceof z.ZodType;
}

function zodJsonSchema(schema: ZodType, options: DescribeSchemaOptions): JsonValue | undefined {
	try {
		const jsonSchema = z.toJSONSchema(schema, {
			override: ({ zodSchema, jsonSchema: projectedSchema, path }) => {
				if (!options.outputTextTrust) {
					delete projectedSchema[APIFUSE_TEXT_TRUST_META_KEY];
					return;
				}
				try {
					const trust = resolveOutputTextTrust(zodSchema);
					if (trust === undefined) {
						delete projectedSchema[APIFUSE_TEXT_TRUST_META_KEY];
					} else {
						deleteNestedTextTrust(projectedSchema);
						projectedSchema[APIFUSE_TEXT_TRUST_META_KEY] = { v: 1, trust };
					}
				} catch (error) {
					projectedSchema[APIFUSE_TEXT_TRUST_META_KEY] = { v: 1, trust: "untrusted" };
					throw new OutputTextTrustProjectionError(jsonSchemaPath(path), error);
				}
			},
		});
		return toJsonValue(jsonSchema);
	} catch (error) {
		if (error instanceof OutputTextTrustProjectionError) throw error;
		if (!options.outputTextTrust && error instanceof Error) return undefined;
		throw new OutputTextTrustProjectionError("$", error);
	}
}

function deleteNestedTextTrust(value: Record<string, unknown>): void {
	for (const child of Object.values(value)) {
		if (Array.isArray(child)) {
			for (const item of child) {
				if (item && typeof item === "object") {
					deleteTextTrustTree(item as Record<string, unknown>);
				}
			}
		} else if (child && typeof child === "object") {
			deleteTextTrustTree(child as Record<string, unknown>);
		}
	}
}

function deleteTextTrustTree(value: Record<string, unknown>): void {
	delete value[APIFUSE_TEXT_TRUST_META_KEY];
	deleteNestedTextTrust(value);
}

function jsonSchemaPath(path: readonly (string | number)[]): string {
	if (path.length === 0) return "$";
	return `#/${path
		.map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1"))
		.join("/")}`;
}

function getSchemaTypeName(schema: SchemaLike): string | undefined {
	if (!isRecord(schema)) return undefined;
	const def = schema._def;
	if (!isRecord(def)) return undefined;
	const typeName = def.typeName ?? def.type;
	return typeof typeName === "string" ? typeName : undefined;
}
