import { createHash } from "node:crypto";
import { type ZodType, z } from "zod";
import {
	canonicalJson,
	compactObject,
	isRecord,
	type JsonValue,
	toJsonValue,
} from "./contract-json.js";
import {
	APIFUSE_TEXT_TRUST_META_KEY,
	inheritsUntrustedOutputTextTrust,
	resolveOutputTextTrust,
} from "./schema.js";
import type { SchemaLike } from "./types.js";

const OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY = "x-apifuse-internal-text-trust-projection";

type OutputTextTrustProjectionMarker =
	| {
			readonly kind: "container-untrusted";
	  }
	| {
			readonly inherited: "trusted" | "untrusted";
			readonly kind: "leaf";
			readonly local: "trusted" | "untrusted";
	  };

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
				delete projectedSchema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY];
				if (!options.outputTextTrust) {
					delete projectedSchema[APIFUSE_TEXT_TRUST_META_KEY];
					return;
				}
				try {
					const local = resolveOutputTextTrust(zodSchema);
					delete projectedSchema[APIFUSE_TEXT_TRUST_META_KEY];
					if (local !== undefined) {
						projectedSchema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY] = {
							inherited: resolveOutputTextTrust(zodSchema, true) ?? local,
							kind: "leaf",
							local,
						} satisfies OutputTextTrustProjectionMarker;
					} else if (inheritsUntrustedOutputTextTrust(zodSchema)) {
						projectedSchema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY] = {
							kind: "container-untrusted",
						} satisfies OutputTextTrustProjectionMarker;
					} else {
						delete projectedSchema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY];
					}
				} catch (error) {
					projectedSchema[APIFUSE_TEXT_TRUST_META_KEY] = { v: 1, trust: "untrusted" };
					throw new OutputTextTrustProjectionError(jsonSchemaPath(path), error);
				}
			},
		});
		if (options.outputTextTrust) finalizeProjectedTextTrust(jsonSchema, false);
		return toJsonValue(jsonSchema);
	} catch (error) {
		if (error instanceof OutputTextTrustProjectionError) throw error;
		if (!options.outputTextTrust && error instanceof Error) return undefined;
		throw new OutputTextTrustProjectionError("$", error);
	}
}

function finalizeProjectedTextTrust(value: unknown, inheritedUntrusted: boolean): void {
	if (Array.isArray(value)) {
		for (const child of value) finalizeProjectedTextTrust(child, inheritedUntrusted);
		return;
	}
	if (!value || typeof value !== "object") return;
	const projectedSchema = value as Record<string, unknown>;
	const marker = readOutputTextTrustProjectionMarker(
		projectedSchema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY],
	);
	const descendantUntrusted = inheritedUntrusted || marker?.kind === "container-untrusted";
	for (const [key, child] of Object.entries(projectedSchema)) {
		if (key !== APIFUSE_TEXT_TRUST_META_KEY && key !== OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY) {
			finalizeProjectedTextTrust(child, descendantUntrusted);
		}
	}
	delete projectedSchema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY];
	delete projectedSchema[APIFUSE_TEXT_TRUST_META_KEY];
	if (marker?.kind === "leaf") {
		deleteNestedTextTrust(projectedSchema);
		projectedSchema[APIFUSE_TEXT_TRUST_META_KEY] = {
			v: 1,
			trust: inheritedUntrusted ? marker.inherited : marker.local,
		};
	}
}

function readOutputTextTrustProjectionMarker(
	value: unknown,
): OutputTextTrustProjectionMarker | undefined {
	if (!value || typeof value !== "object") return undefined;
	const kind = Reflect.get(value, "kind");
	if (kind === "container-untrusted") return { kind };
	if (kind !== "leaf") return undefined;
	const inherited = Reflect.get(value, "inherited");
	const local = Reflect.get(value, "local");
	if (
		(inherited !== "trusted" && inherited !== "untrusted") ||
		(local !== "trusted" && local !== "untrusted")
	) {
		return undefined;
	}
	return { inherited, kind, local };
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
