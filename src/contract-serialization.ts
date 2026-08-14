import { createHash, randomUUID } from "node:crypto";
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
	invalidatesDescendantOutputTextAutoTrust,
	resolveOutputTextTrustProjection,
	type TextTrust,
} from "./schema.js";
import type { SchemaLike } from "./types.js";

const OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY = "x-apifuse-internal-text-trust-projection";

type OutputTextTrustProjectionMarker =
	| {
			readonly kind: "container-untrusted";
	  }
	| {
			readonly kind: "container-unsafe";
	  }
	| {
			readonly inherited: TextTrust;
			readonly kind: "leaf";
			readonly local: TextTrust;
	  };

interface DescribeSchemaOptions {
	readonly eventName?: string;
	readonly operationId?: string;
	readonly outputTextTrust?: boolean;
}

interface ExpectedUnsafeContainerMarkers {
	readonly containerMarkerId: string;
	readonly rootTextCarrierMarkerId: string;
}

export class OutputTextTrustProjectionError extends Error {
	readonly classification = "untrusted" as const;
	readonly code = "output_text_trust_projection_failed";

	constructor(
		public readonly schemaPath: string,
		cause: unknown,
		public readonly operationId?: string,
		public readonly eventName?: string,
	) {
		const context = [
			operationId === undefined ? undefined : `operation "${operationId}"`,
			eventName === undefined ? undefined : `event "${eventName}"`,
		]
			.filter((value): value is string => value !== undefined)
			.join(", ");
		super(
			context.length === 0
				? `Output text-trust projection failed at schema path ${schemaPath}.`
				: `Output text-trust projection failed for ${context} at schema path ${schemaPath}.`,
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
		if (options.outputTextTrust) {
			throw new OutputTextTrustProjectionError(
				"$",
				new TypeError(
					"Standard Schema output cannot be projected to JSON Schema with text-trust classifications.",
				),
				options.operationId,
				options.eventName,
			);
		}
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

function zodJsonSchema(schema: ZodType, options: DescribeSchemaOptions): JsonValue {
	const projectionMarkers = new Map<string, OutputTextTrustProjectionMarker>();
	const expectedLeafMarkers = new Map<string, string>();
	const expectedUnsafeContainerMarkers = new Map<string, ExpectedUnsafeContainerMarkers>();
	try {
		const jsonSchema = z.toJSONSchema(schema, {
			unrepresentable: options.outputTextTrust ? "any" : "throw",
			override: ({ zodSchema, jsonSchema: projectedSchema, path }) => {
				if (!options.outputTextTrust) {
					delete projectedSchema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY];
					delete projectedSchema[APIFUSE_TEXT_TRUST_META_KEY];
					return;
				}
				try {
					const unrepresentable = unrepresentableZodOutputCause(zodSchema);
					if (unrepresentable) throw unrepresentable;
					const resolved = resolveOutputTextTrustProjection(zodSchema);
					delete projectedSchema[APIFUSE_TEXT_TRUST_META_KEY];
					if (resolved !== undefined) {
						const markerId = writeOutputTextTrustProjectionMarker(
							projectedSchema,
							projectionMarkers,
							{
								inherited: resolved.inherited,
								kind: "leaf",
								local: resolved.local,
							},
						);
						expectedLeafMarkers.set(projectedJsonSchemaPath(path), markerId);
					} else if (invalidatesDescendantOutputTextAutoTrust(zodSchema)) {
						if (
							projectedJsonSchemaIsProvablyNonText(projectedSchema) &&
							mutatorReturnIsProvablyNonText(zodSchema, projectedSchema)
						) {
							return;
						}
						if (
							projectedJsonSchemaAllowsArray(projectedSchema) &&
							mutatorUsesProjectedArrayCarrier(zodSchema, projectedSchema)
						) {
							writeOutputTextTrustProjectionMarker(projectedSchema, projectionMarkers, {
								kind: "container-untrusted",
							});
							return;
						}
						if (!projectedJsonSchemaAllowsObject(projectedSchema)) {
							throw new TypeError(
								"A type-mutating output schema cannot represent its possible text output in JSON Schema.",
							);
						}
						const { objectOutputSchema, rootTextCarrierMarkerId } = wrapUnsafeObjectTextOutput(
							projectedSchema,
							projectionMarkers,
							expectedLeafMarkers,
							path,
						);
						const containerMarkerId = writeOutputTextTrustProjectionMarker(
							projectedSchema,
							projectionMarkers,
							{ kind: "container-unsafe" },
						);
						expectedUnsafeContainerMarkers.set(projectedJsonSchemaPath(path), {
							containerMarkerId,
							rootTextCarrierMarkerId,
						});
						classifyUnsafeObjectShape(
							objectOutputSchema,
							projectionMarkers,
							expectedLeafMarkers,
							appendJsonSchemaPath(appendJsonSchemaPath(projectedJsonSchemaPath(path), "anyOf"), 0),
						);
					} else if (inheritsUntrustedOutputTextTrust(zodSchema)) {
						writeOutputTextTrustProjectionMarker(projectedSchema, projectionMarkers, {
							kind: "container-untrusted",
						});
					}
					if (hasOpenObjectCatchall(zodSchema)) {
						const propertyNames: Record<string, unknown> = {};
						const markerId = writeOutputTextTrustProjectionMarker(
							propertyNames,
							projectionMarkers,
							{
								inherited: "untrusted",
								kind: "leaf",
								local: "untrusted",
							},
						);
						projectedSchema.propertyNames = propertyNames;
						expectedLeafMarkers.set(
							appendJsonSchemaPath(projectedJsonSchemaPath(path), "propertyNames"),
							markerId,
						);
					}
				} catch (error) {
					throw new OutputTextTrustProjectionError(
						jsonSchemaPath(path),
						error,
						options.operationId,
						options.eventName,
					);
				}
			},
		});
		if (options.outputTextTrust) {
			finalizeProjectedTextTrust(
				jsonSchema,
				projectionMarkers,
				expectedLeafMarkers,
				expectedUnsafeContainerMarkers,
				options,
			);
		}
		const projected = toJsonValue(jsonSchema);
		if (projected === undefined) {
			throw new TypeError("z.toJSONSchema() returned a non-JSON value");
		}
		return projected;
	} catch (error) {
		if (error instanceof OutputTextTrustProjectionError) throw error;
		if (!options.outputTextTrust) throw error;
		throw new OutputTextTrustProjectionError("$", error, options.operationId, options.eventName);
	}
}

function wrapUnsafeObjectTextOutput(
	projectedSchema: Record<string, unknown>,
	projectionMarkers: Map<string, OutputTextTrustProjectionMarker>,
	expectedLeafMarkers: Map<string, string>,
	path: readonly (string | number)[],
): {
	readonly objectOutputSchema: Record<string, unknown>;
	readonly rootTextCarrierMarkerId: string;
} {
	const objectOutputSchema = { ...projectedSchema };
	for (const key of Object.keys(projectedSchema)) delete projectedSchema[key];
	const rootTextCarrier: Record<string, unknown> = { type: "string" };
	const rootTextCarrierMarkerId = writeOutputTextTrustProjectionMarker(
		rootTextCarrier,
		projectionMarkers,
		{
			inherited: "untrusted",
			kind: "leaf",
			local: "untrusted",
		},
	);
	projectedSchema.anyOf = [objectOutputSchema, rootTextCarrier];
	expectedLeafMarkers.set(
		appendJsonSchemaPath(appendJsonSchemaPath(projectedJsonSchemaPath(path), "anyOf"), 1),
		rootTextCarrierMarkerId,
	);
	return { objectOutputSchema, rootTextCarrierMarkerId };
}

function classifyUnsafeObjectShape(
	projectedSchema: Record<string, unknown>,
	projectionMarkers: Map<string, OutputTextTrustProjectionMarker>,
	expectedLeafMarkers: Map<string, string>,
	path: string,
): void {
	for (const keyword of ["additionalProperties", "propertyNames"] as const) {
		const unknownTextCarrier: Record<string, unknown> = {};
		const markerId = writeOutputTextTrustProjectionMarker(unknownTextCarrier, projectionMarkers, {
			inherited: "untrusted",
			kind: "leaf",
			local: "untrusted",
		});
		projectedSchema[keyword] = unknownTextCarrier;
		expectedLeafMarkers.set(appendJsonSchemaPath(path, keyword), markerId);
	}
}

function writeOutputTextTrustProjectionMarker(
	schema: Record<string, unknown>,
	markers: Map<string, OutputTextTrustProjectionMarker>,
	marker: OutputTextTrustProjectionMarker,
): string {
	const existingId = schema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY];
	if (typeof existingId === "string") {
		const existingMarker = markers.get(existingId);
		if (existingMarker) {
			markers.set(existingId, mergeOutputTextTrustProjectionMarkers(existingMarker, marker));
			return existingId;
		}
	}
	const id = randomUUID();
	markers.set(id, marker);
	schema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY] = id;
	return id;
}

function mergeOutputTextTrustProjectionMarkers(
	existing: OutputTextTrustProjectionMarker,
	next: OutputTextTrustProjectionMarker,
): OutputTextTrustProjectionMarker {
	if (existing.kind === "container-unsafe" && next.kind === "container-untrusted") {
		return existing;
	}
	return next;
}

function hasOpenObjectCatchall(schema: z.core.$ZodType): boolean {
	const def = schema._zod.def;
	if (def.type !== "object") return false;
	const catchall = Reflect.get(def, "catchall");
	if (!catchall || typeof catchall !== "object") return false;
	const internals = Reflect.get(catchall, "_zod");
	if (!internals || typeof internals !== "object") return false;
	const catchallDef = Reflect.get(internals, "def");
	return (
		!catchallDef || typeof catchallDef !== "object" || Reflect.get(catchallDef, "type") !== "never"
	);
}

function unrepresentableZodOutputCause(schema: z.core.$ZodType): Error | undefined {
	const def = schema._zod.def;
	switch (def.type) {
		case "bigint":
			return new Error("BigInt cannot be represented in JSON Schema");
		case "symbol":
			return new Error("Symbols cannot be represented in JSON Schema");
		case "undefined":
			return new Error("Undefined cannot be represented in JSON Schema");
		case "void":
			return new Error("Void cannot be represented in JSON Schema");
		case "date":
			return new Error("Date cannot be represented in JSON Schema");
		case "nan":
			return new Error("NaN cannot be represented in JSON Schema");
		case "custom":
			return new Error("Custom types cannot be represented in JSON Schema");
		case "function":
			return new Error("Function types cannot be represented in JSON Schema");
		case "transform":
			return new Error("Transforms cannot be represented in JSON Schema");
		case "map":
			return new Error("Map cannot be represented in JSON Schema");
		case "set":
			return new Error("Set cannot be represented in JSON Schema");
		case "literal": {
			const values = Reflect.get(def, "values");
			if (!Array.isArray(values)) return undefined;
			if (values.some((value: unknown) => value === undefined)) {
				return new Error("Literal `undefined` cannot be represented in JSON Schema");
			}
			if (values.some((value: unknown) => typeof value === "bigint")) {
				return new Error("BigInt literals cannot be represented in JSON Schema");
			}
			return undefined;
		}
		default:
			return undefined;
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

const UNSAFE_CONTAINER_ROOT_KEYWORDS = new Set([
	"$comment",
	"$id",
	"$schema",
	OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY,
	"anyOf",
	"default",
	"deprecated",
	"description",
	"examples",
	"readOnly",
	"title",
	"writeOnly",
]);

function isVerifiedUnsafeContainerUnion(schema: Record<string, unknown>): boolean {
	if (Object.keys(schema).some((key) => !UNSAFE_CONTAINER_ROOT_KEYWORDS.has(key))) return false;
	const branches = schema.anyOf;
	return (
		Array.isArray(branches) &&
		branches.length === 2 &&
		branches.some(
			(branch) => isJsonSchemaNode(branch) && projectedJsonSchemaAllowsObject(branch),
		) &&
		branches.some((branch) => isJsonSchemaNode(branch) && isUnconstrainedStringCarrier(branch))
	);
}

function isUnconstrainedStringCarrier(schema: Record<string, unknown>): boolean {
	return (
		schema.type === "string" &&
		Object.keys(schema).every(
			(key) => key === "type" || key === OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY,
		)
	);
}

function finalizeProjectedTextTrust(
	value: unknown,
	projectionMarkers: ReadonlyMap<string, OutputTextTrustProjectionMarker>,
	expectedLeafMarkers: ReadonlyMap<string, string>,
	expectedUnsafeContainerMarkers: ReadonlyMap<string, ExpectedUnsafeContainerMarkers>,
	options: DescribeSchemaOptions,
): void {
	if (!isJsonSchemaNode(value)) {
		throw new OutputTextTrustProjectionError(
			"#",
			new TypeError("Projected output schema is not a JSON Schema object."),
			options.operationId,
			options.eventName,
		);
	}
	const root = value;
	const nodes = collectProjectedJsonSchemaNodes(root);
	const markers = new WeakMap<Record<string, unknown>, OutputTextTrustProjectionMarker>();
	for (const { path, schema } of nodes) {
		const marker = readOutputTextTrustProjectionMarker(
			schema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY],
			projectionMarkers,
			path,
			options,
		);
		if (marker) markers.set(schema, marker);
	}
	for (const [expectedPath, expectedMarkerId] of expectedLeafMarkers) {
		const authenticatedLeaves = nodes.filter(
			({ schema }) =>
				schema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY] === expectedMarkerId &&
				markers.get(schema)?.kind === "leaf",
		);
		if (authenticatedLeaves.length === 0) {
			throw new OutputTextTrustProjectionError(
				expectedPath,
				new TypeError("A projected output text leaf lost its authenticated trust marker."),
				options.operationId,
				options.eventName,
			);
		}
		if (authenticatedLeaves.some(({ schema }) => !projectedJsonSchemaCanAllowString(schema))) {
			throw new OutputTextTrustProjectionError(
				expectedPath,
				new TypeError("A projected output text leaf was mutated to a non-text type."),
				options.operationId,
				options.eventName,
			);
		}
	}
	for (const [expectedPath, expectedMarkers] of expectedUnsafeContainerMarkers) {
		const authenticatedContainers = nodes.filter(
			({ schema }) =>
				schema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY] === expectedMarkers.containerMarkerId &&
				markers.get(schema)?.kind === "container-unsafe",
		);
		if (authenticatedContainers.length === 0) {
			throw new OutputTextTrustProjectionError(
				expectedPath,
				new TypeError("A type-mutating output container lost its authenticated trust marker."),
				options.operationId,
				options.eventName,
			);
		}
		if (authenticatedContainers.some(({ schema }) => !isVerifiedUnsafeContainerUnion(schema))) {
			throw new OutputTextTrustProjectionError(
				expectedPath,
				new TypeError(
					"A type-mutating output container no longer represents an isolated object-or-text union.",
				),
				options.operationId,
				options.eventName,
			);
		}
		if (
			authenticatedContainers.some(
				({ schema }) =>
					!(schema.anyOf as unknown[]).some(
						(branch) =>
							isJsonSchemaNode(branch) &&
							branch[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY] ===
								expectedMarkers.rootTextCarrierMarkerId &&
							markers.get(branch)?.kind === "leaf" &&
							isUnconstrainedStringCarrier(branch),
					),
			)
		) {
			throw new OutputTextTrustProjectionError(
				expectedPath,
				new TypeError("A type-mutating output container lost its authenticated root text carrier."),
				options.operationId,
				options.eventName,
			);
		}
	}
	for (const { schema } of nodes) {
		if (!markers.has(schema) && projectedJsonSchemaAllowsString(schema)) {
			markers.set(schema, { inherited: "untrusted", kind: "leaf", local: "untrusted" });
		}
	}

	const desiredTrust = new WeakMap<Record<string, unknown>, TextTrust>();
	const visitedStates = new WeakMap<Record<string, unknown>, number>();
	const project = (
		schema: Record<string, unknown>,
		inheritedUntrusted: boolean,
		autoTrustAllowed: boolean,
	): void => {
		const state = 1 << ((inheritedUntrusted ? 1 : 0) + (autoTrustAllowed ? 0 : 2));
		const visited = visitedStates.get(schema) ?? 0;
		if ((visited & state) !== 0) return;
		visitedStates.set(schema, visited | state);

		const marker = markers.get(schema);
		if (marker?.kind === "leaf") {
			const trust = autoTrustAllowed
				? inheritedUntrusted
					? marker.inherited
					: marker.local
				: "untrusted";
			if (desiredTrust.get(schema) !== "untrusted") desiredTrust.set(schema, trust);
			return;
		}
		if (marker?.kind === "container-unsafe") desiredTrust.set(schema, "untrusted");
		const descendantUntrusted = inheritedUntrusted || marker?.kind === "container-untrusted";
		const descendantAutoTrustAllowed = autoTrustAllowed && marker?.kind !== "container-unsafe";
		const reference = schema.$ref;
		if (reference !== undefined) {
			if (typeof reference !== "string") {
				throw new OutputTextTrustProjectionError(
					requireNodePath(nodes, schema, options),
					new TypeError("Projected JSON Schema $ref must be a string."),
					options.operationId,
					options.eventName,
				);
			}
			project(
				resolveLocalJsonSchemaReference(
					root,
					reference,
					requireNodePath(nodes, schema, options),
					options,
				),
				descendantUntrusted,
				descendantAutoTrustAllowed,
			);
		}
		for (const child of projectedJsonSchemaChildren(schema, false)) {
			project(child, descendantUntrusted, descendantAutoTrustAllowed);
		}
	};
	project(root, false, true);

	for (const { schema } of nodes) {
		delete schema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY];
		delete schema[APIFUSE_TEXT_TRUST_META_KEY];
	}
	for (const { schema } of nodes) {
		const trust = desiredTrust.get(schema);
		if (trust !== undefined) schema[APIFUSE_TEXT_TRUST_META_KEY] = { v: 1, trust };
	}
}

function projectedJsonSchemaAllowsString(schema: Record<string, unknown>): boolean {
	return schema.type === "string" || (Array.isArray(schema.type) && schema.type.includes("string"));
}

function projectedJsonSchemaCanAllowString(schema: Record<string, unknown>): boolean {
	return schema.type === undefined || projectedJsonSchemaAllowsString(schema);
}

function projectedJsonSchemaAllowsObject(schema: Record<string, unknown>): boolean {
	return schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"));
}

const PROVABLY_NON_TEXT_JSON_SCHEMA_TYPES = new Set(["boolean", "integer", "null", "number"]);

function mutatorReturnIsProvablyNonText(
	zodSchema: z.core.$ZodType,
	projectedSchema: Record<string, unknown>,
): boolean {
	const def = zodSchema._zod.def;
	if (def.type === "default" || def.type === "catch") {
		return (
			Object.hasOwn(projectedSchema, "default") &&
			projectedJsonValueIsProvablyNonText(projectedSchema.default)
		);
	}
	if (def.type === "transform") return false;
	return !hasOutputOverwrite(def);
}

function mutatorUsesProjectedArrayCarrier(
	zodSchema: z.core.$ZodType,
	projectedSchema: Record<string, unknown>,
): boolean {
	const type = zodSchema._zod.def.type;
	return (
		(type === "default" || type === "catch") &&
		Object.hasOwn(projectedSchema, "default") &&
		Array.isArray(projectedSchema.default)
	);
}

function projectedJsonValueIsProvablyNonText(value: unknown): boolean {
	return (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		(Array.isArray(value) && value.every(projectedJsonValueIsProvablyNonText))
	);
}

function hasOutputOverwrite(def: z.core.$ZodTypeDef): boolean {
	const checks = Reflect.get(def, "checks");
	return (
		Array.isArray(checks) &&
		checks.some((check) => {
			if (!check || typeof check !== "object") return false;
			const internals = Reflect.get(check, "_zod");
			if (!internals || typeof internals !== "object") return false;
			const checkDef = Reflect.get(internals, "def");
			return (
				checkDef !== null &&
				typeof checkDef === "object" &&
				Reflect.get(checkDef, "check") === "overwrite"
			);
		})
	);
}

function projectedJsonSchemaIsProvablyNonText(
	schema: Record<string, unknown>,
	visited = new WeakSet<Record<string, unknown>>(),
): boolean {
	if (visited.has(schema)) return false;
	visited.add(schema);
	try {
		const types = typeof schema.type === "string" ? [schema.type] : schema.type;
		if (Array.isArray(types) && types.length > 0) {
			return types.every(
				(type) =>
					typeof type === "string" &&
					(PROVABLY_NON_TEXT_JSON_SCHEMA_TYPES.has(type) ||
						(type === "array" &&
							isJsonSchemaNode(schema.items) &&
							projectedJsonSchemaIsProvablyNonText(schema.items, visited))),
			);
		}
		for (const keyword of ["anyOf", "oneOf"] as const) {
			const branches = schema[keyword];
			if (!Array.isArray(branches) || branches.length === 0) continue;
			return branches.every(
				(branch) =>
					isJsonSchemaNode(branch) && projectedJsonSchemaIsProvablyNonText(branch, visited),
			);
		}
		return false;
	} finally {
		visited.delete(schema);
	}
}

function projectedJsonSchemaAllowsArray(schema: Record<string, unknown>): boolean {
	return schema.type === "array" || (Array.isArray(schema.type) && schema.type.includes("array"));
}

function readOutputTextTrustProjectionMarker(
	value: unknown,
	projectionMarkers: ReadonlyMap<string, OutputTextTrustProjectionMarker>,
	schemaPath: string,
	options: DescribeSchemaOptions,
): OutputTextTrustProjectionMarker | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw invalidProjectionMarker(schemaPath, options);
	const marker = projectionMarkers.get(value);
	if (!marker) throw invalidProjectionMarker(schemaPath, options);
	return marker;
}

function invalidProjectionMarker(
	schemaPath: string,
	options: DescribeSchemaOptions,
): OutputTextTrustProjectionError {
	return new OutputTextTrustProjectionError(
		schemaPath,
		new OutputTextTrustProjectionMarkerError(schemaPath),
		options.operationId,
		options.eventName,
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
	options: DescribeSchemaOptions,
): Record<string, unknown> {
	let target: unknown = root;
	if (reference !== "#") {
		if (!reference.startsWith("#/")) {
			throw new OutputTextTrustProjectionError(
				schemaPath,
				new TypeError(`Unsupported non-local JSON Schema reference: ${reference}`),
				options.operationId,
				options.eventName,
			);
		}
		for (const encodedSegment of reference.slice(2).split("/")) {
			const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
			if (!target || typeof target !== "object" || !Object.hasOwn(target, segment)) {
				throw new OutputTextTrustProjectionError(
					schemaPath,
					new TypeError(`Unresolvable local JSON Schema reference: ${reference}`),
					options.operationId,
					options.eventName,
				);
			}
			target = Reflect.get(target, segment);
		}
	}
	if (!isJsonSchemaNode(target)) {
		throw new OutputTextTrustProjectionError(
			schemaPath,
			new TypeError(`JSON Schema reference does not resolve to a schema object: ${reference}`),
			options.operationId,
			options.eventName,
		);
	}
	return target;
}

function isJsonSchemaNode(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNodePath(
	nodes: readonly ProjectedJsonSchemaNode[],
	target: Record<string, unknown>,
	options: DescribeSchemaOptions,
): string {
	const path = nodes.find(({ schema }) => schema === target)?.path;
	if (path !== undefined) return path;
	throw new OutputTextTrustProjectionError(
		"#",
		new TypeError("Projected JSON Schema node is missing from the collected node index."),
		options.operationId,
		options.eventName,
	);
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

function projectedJsonSchemaPath(path: readonly (string | number)[]): string {
	return path.length === 0 ? "#" : jsonSchemaPath(path);
}

function getSchemaTypeName(schema: SchemaLike): string | undefined {
	if (!isRecord(schema)) return undefined;
	const def = schema._def;
	if (!isRecord(def)) return undefined;
	const typeName = def.typeName ?? def.type;
	return typeof typeName === "string" ? typeName : undefined;
}
