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
	type TextTrust,
} from "./schema.js";
import type { SchemaLike } from "./types.js";

const OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY = "x-apifuse-internal-text-trust-projection";

type OutputTextTrustProjectionMarker =
	| {
			readonly kind: "container-untrusted";
	  }
	| {
			readonly inherited: TextTrust;
			readonly kind: "leaf";
			readonly local: TextTrust;
	  };

interface DescribeSchemaOptions {
	readonly operationId?: string;
	readonly outputTextTrust?: boolean;
}

export class OutputTextTrustProjectionError extends Error {
	readonly classification = "untrusted" as const;
	readonly code = "output_text_trust_projection_failed";

	constructor(
		public readonly schemaPath: string,
		cause: unknown,
		public readonly operationId?: string,
	) {
		super(
			operationId === undefined
				? `Output text-trust projection failed at schema path ${schemaPath}.`
				: `Output text-trust projection failed for operation "${operationId}" at schema path ${schemaPath}.`,
		);
		this.name = "OutputTextTrustProjectionError";
		this.cause = cause;
	}
}

export class OutputTextTrustProjectionMarkerError extends TypeError {
	readonly code = "invalid_output_text_trust_projection_marker";

	constructor(public readonly schemaPath: string) {
		super(`Invalid internal output text-trust projection marker at schema path ${schemaPath}.`);
		this.name = "OutputTextTrustProjectionMarkerError";
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
					delete projectedSchema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY];
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
					}
				} catch (error) {
					throw new OutputTextTrustProjectionError(
						jsonSchemaPath(path),
						error,
						options.operationId,
					);
				}
			},
		});
		if (options.outputTextTrust) finalizeProjectedTextTrust(jsonSchema, options.operationId);
		return toJsonValue(jsonSchema);
	} catch (error) {
		if (error instanceof OutputTextTrustProjectionError) throw error;
		if (!options.outputTextTrust && error instanceof Error) return undefined;
		throw new OutputTextTrustProjectionError("$", error, options.operationId);
	}
}

const SINGLE_SCHEMA_KEYWORDS = [
	"additionalProperties",
	"contains",
	"contentSchema",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties",
] as const;

const ARRAY_SCHEMA_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const MAP_SCHEMA_KEYWORDS = [
	"$defs",
	"definitions",
	"dependentSchemas",
	"patternProperties",
	"properties",
] as const;

interface ProjectedJsonSchemaNode {
	readonly path: string;
	readonly schema: Record<string, unknown>;
}

function finalizeProjectedTextTrust(value: unknown, operationId?: string): void {
	if (!isJsonSchemaNode(value)) {
		throw new OutputTextTrustProjectionError(
			"#",
			new TypeError("Projected output schema is not a JSON Schema object."),
			operationId,
		);
	}
	const root = value;
	const nodes = collectProjectedJsonSchemaNodes(root);
	const markers = new WeakMap<Record<string, unknown>, OutputTextTrustProjectionMarker>();
	for (const { path, schema } of nodes) {
		const marker = readOutputTextTrustProjectionMarker(
			schema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY],
			path,
			operationId,
		);
		if (marker) markers.set(schema, marker);
	}

	const desiredTrust = new WeakMap<Record<string, unknown>, TextTrust>();
	const visitedStates = new WeakMap<Record<string, unknown>, number>();
	const project = (schema: Record<string, unknown>, inheritedUntrusted: boolean): void => {
		const state = inheritedUntrusted ? 2 : 1;
		const visited = visitedStates.get(schema) ?? 0;
		if ((visited & state) !== 0) return;
		visitedStates.set(schema, visited | state);

		const marker = markers.get(schema);
		if (marker?.kind === "leaf") {
			const trust = inheritedUntrusted ? marker.inherited : marker.local;
			if (desiredTrust.get(schema) !== "untrusted") desiredTrust.set(schema, trust);
			return;
		}
		const descendantUntrusted = inheritedUntrusted || marker?.kind === "container-untrusted";
		const reference = schema.$ref;
		if (reference !== undefined) {
			if (typeof reference !== "string") {
				throw new OutputTextTrustProjectionError(
					findNodePath(nodes, schema),
					new TypeError("Projected JSON Schema $ref must be a string."),
					operationId,
				);
			}
			project(
				resolveLocalJsonSchemaReference(root, reference, findNodePath(nodes, schema), operationId),
				descendantUntrusted,
			);
		}
		for (const child of projectedJsonSchemaChildren(schema, false)) {
			project(child, descendantUntrusted);
		}
	};
	project(root, false);

	for (const { schema } of nodes) {
		delete schema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY];
		delete schema[APIFUSE_TEXT_TRUST_META_KEY];
	}
	for (const { schema } of nodes) {
		const trust = desiredTrust.get(schema);
		if (trust !== undefined) schema[APIFUSE_TEXT_TRUST_META_KEY] = { v: 1, trust };
	}
}

function readOutputTextTrustProjectionMarker(
	value: unknown,
	schemaPath: string,
	operationId?: string,
): OutputTextTrustProjectionMarker | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object") {
		throw invalidProjectionMarker(schemaPath, operationId);
	}
	const kind = Reflect.get(value, "kind");
	if (kind === "container-untrusted") return { kind };
	if (kind !== "leaf") throw invalidProjectionMarker(schemaPath, operationId);
	const inherited = Reflect.get(value, "inherited");
	const local = Reflect.get(value, "local");
	if (
		(inherited !== "trusted" && inherited !== "untrusted") ||
		(local !== "trusted" && local !== "untrusted")
	) {
		throw invalidProjectionMarker(schemaPath, operationId);
	}
	return { inherited, kind, local };
}

function invalidProjectionMarker(
	schemaPath: string,
	operationId: string | undefined,
): OutputTextTrustProjectionError {
	return new OutputTextTrustProjectionError(
		schemaPath,
		new OutputTextTrustProjectionMarkerError(schemaPath),
		operationId,
	);
}

function collectProjectedJsonSchemaNodes(root: Record<string, unknown>): ProjectedJsonSchemaNode[] {
	const nodes: ProjectedJsonSchemaNode[] = [];
	const visited = new WeakSet<Record<string, unknown>>();
	const collect = (schema: Record<string, unknown>, path: string): void => {
		if (visited.has(schema)) return;
		visited.add(schema);
		nodes.push({ path, schema });
		for (const [childPath, child] of projectedJsonSchemaChildEntries(schema, path, true)) {
			collect(child, childPath);
		}
	};
	collect(root, "#");
	return nodes;
}

function projectedJsonSchemaChildren(
	schema: Record<string, unknown>,
	includeDefinitions: boolean,
): Record<string, unknown>[] {
	return [...projectedJsonSchemaChildEntries(schema, "#", includeDefinitions)].map(
		([, child]) => child,
	);
}

function* projectedJsonSchemaChildEntries(
	schema: Record<string, unknown>,
	path: string,
	includeDefinitions: boolean,
): Generator<readonly [string, Record<string, unknown>]> {
	for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
		const child = schema[keyword];
		if (isJsonSchemaNode(child)) yield [appendJsonSchemaPath(path, keyword), child];
		if (keyword === "items" && Array.isArray(child)) {
			for (const [index, item] of child.entries()) {
				if (isJsonSchemaNode(item)) {
					yield [appendJsonSchemaPath(appendJsonSchemaPath(path, keyword), index), item];
				}
			}
		}
	}
	for (const keyword of ARRAY_SCHEMA_KEYWORDS) {
		const children = schema[keyword];
		if (!Array.isArray(children)) continue;
		for (const [index, child] of children.entries()) {
			if (isJsonSchemaNode(child)) {
				yield [appendJsonSchemaPath(appendJsonSchemaPath(path, keyword), index), child];
			}
		}
	}
	for (const keyword of MAP_SCHEMA_KEYWORDS) {
		if (!includeDefinitions && (keyword === "$defs" || keyword === "definitions")) continue;
		const children = schema[keyword];
		if (!isJsonSchemaNode(children)) continue;
		for (const [key, child] of Object.entries(children)) {
			if (isJsonSchemaNode(child)) {
				yield [appendJsonSchemaPath(appendJsonSchemaPath(path, keyword), key), child];
			}
		}
	}
}

function resolveLocalJsonSchemaReference(
	root: Record<string, unknown>,
	reference: string,
	schemaPath: string,
	operationId: string | undefined,
): Record<string, unknown> {
	let target: unknown = root;
	if (reference !== "#") {
		if (!reference.startsWith("#/")) {
			throw new OutputTextTrustProjectionError(
				schemaPath,
				new TypeError(`Unsupported non-local JSON Schema reference: ${reference}`),
				operationId,
			);
		}
		for (const encodedSegment of reference.slice(2).split("/")) {
			const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
			if (!target || typeof target !== "object" || !Object.hasOwn(target, segment)) {
				throw new OutputTextTrustProjectionError(
					schemaPath,
					new TypeError(`Unresolvable local JSON Schema reference: ${reference}`),
					operationId,
				);
			}
			target = Reflect.get(target, segment);
		}
	}
	if (!isJsonSchemaNode(target)) {
		throw new OutputTextTrustProjectionError(
			schemaPath,
			new TypeError(`JSON Schema reference does not resolve to a schema object: ${reference}`),
			operationId,
		);
	}
	return target;
}

function isJsonSchemaNode(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findNodePath(
	nodes: readonly ProjectedJsonSchemaNode[],
	target: Record<string, unknown>,
): string {
	return nodes.find(({ schema }) => schema === target)?.path ?? "#";
}

function appendJsonSchemaPath(path: string, segment: string | number): string {
	return `${path}/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;
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
