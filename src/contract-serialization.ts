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
	hasDynamicOutputFallback,
	inheritsUntrustedOutputTextTrust,
	invalidatesDescendantOutputTextAutoTrust,
	mutatorReturnIsProvablyNonText,
	mutatorUsesStaticArrayFallback,
	resolveOutputTextTrustProjection,
	suppressDynamicOutputFallbacksDuring,
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
	const expectedUnsafeContainerMarkers = new Map<string, string>();
	const expectedHonestTextContainerMarkers = new Map<string, string>();
	try {
		const jsonSchemaOptions: z.core.ToJSONSchemaParams = {
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
					if (hasDynamicOutputFallback(zodSchema)) delete projectedSchema.default;
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
							mutatorReturnIsProvablyNonText(zodSchema)
						) {
							return;
						}
						if (mutatorCanUseProjectedTextItems(zodSchema, projectedSchema)) {
							writeOutputTextTrustProjectionMarker(projectedSchema, projectionMarkers, {
								kind: "container-untrusted",
							});
							return;
						}
						admitPossibleRuntimeText(
							projectedSchema,
							projectionMarkers,
							expectedLeafMarkers,
							expectedUnsafeContainerMarkers,
							expectedHonestTextContainerMarkers,
							projectedJsonSchemaPath(path),
						);
						const containerMarkerId = writeOutputTextTrustProjectionMarker(
							projectedSchema,
							projectionMarkers,
							{ kind: "container-unsafe" },
						);
						expectedUnsafeContainerMarkers.set(projectedJsonSchemaPath(path), containerMarkerId);
						expectedHonestTextContainerMarkers.set(
							projectedJsonSchemaPath(path),
							containerMarkerId,
						);
					} else if (inheritsUntrustedOutputTextTrust(zodSchema)) {
						writeOutputTextTrustProjectionMarker(projectedSchema, projectionMarkers, {
							kind: "container-untrusted",
						});
					}
					if (hasOpenObjectCatchall(zodSchema)) {
						const containerMarkerId = writeOutputTextTrustProjectionMarker(
							projectedSchema,
							projectionMarkers,
							{ kind: "container-unsafe" },
						);
						expectedUnsafeContainerMarkers.set(projectedJsonSchemaPath(path), containerMarkerId);
					}
					if (
						zodSchema._zod.def.type === "record" &&
						projectedSchema.additionalProperties === false
					) {
						const projectedPath = projectedJsonSchemaPath(path);
						expectedLeafMarkers.delete(appendJsonSchemaPath(projectedPath, "additionalProperties"));
						const containerMarkerId = writeOutputTextTrustProjectionMarker(
							projectedSchema,
							projectionMarkers,
							{ kind: "container-unsafe" },
						);
						expectedUnsafeContainerMarkers.set(projectedPath, containerMarkerId);
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
		};
		const projectJsonSchema = () => z.toJSONSchema(schema, jsonSchemaOptions);
		const jsonSchema = options.outputTextTrust
			? suppressDynamicOutputFallbacksDuring(projectJsonSchema)
			: projectJsonSchema();
		if (options.outputTextTrust) {
			finalizeProjectedTextTrust(
				jsonSchema,
				projectionMarkers,
				expectedLeafMarkers,
				expectedUnsafeContainerMarkers,
				expectedHonestTextContainerMarkers,
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

function finalizeProjectedTextTrust(
	value: unknown,
	projectionMarkers: ReadonlyMap<string, OutputTextTrustProjectionMarker>,
	expectedLeafMarkers: ReadonlyMap<string, string>,
	expectedUnsafeContainerMarkers: ReadonlyMap<string, string>,
	expectedHonestTextContainerMarkers: ReadonlyMap<string, string>,
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
		const authenticatedLeaf = resolveExpectedProjectedSchema(
			root,
			expectedPath,
			expectedMarkerId,
			markers,
			options,
		);
		if (authenticatedLeaf === undefined || markers.get(authenticatedLeaf)?.kind !== "leaf") {
			throw new OutputTextTrustProjectionError(
				expectedPath,
				new TypeError("A projected output text leaf lost its authenticated trust marker."),
				options.operationId,
				options.eventName,
			);
		}
		if (!projectedJsonSchemaCanAllowString(authenticatedLeaf)) {
			throw new OutputTextTrustProjectionError(
				expectedPath,
				new TypeError("A projected output text leaf was mutated to a non-text type."),
				options.operationId,
				options.eventName,
			);
		}
	}
	for (const [expectedPath, expectedMarkerId] of expectedUnsafeContainerMarkers) {
		const authenticatedContainer = resolveExpectedProjectedSchema(
			root,
			expectedPath,
			expectedMarkerId,
			markers,
			options,
		);
		if (
			authenticatedContainer === undefined ||
			markers.get(authenticatedContainer)?.kind !== "container-unsafe"
		) {
			throw new OutputTextTrustProjectionError(
				expectedPath,
				new TypeError("A type-mutating output container lost its authenticated trust marker."),
				options.operationId,
				options.eventName,
			);
		}
	}
	for (const [expectedPath, expectedMarkerId] of expectedHonestTextContainerMarkers) {
		const authenticatedContainer = resolveExpectedProjectedSchema(
			root,
			expectedPath,
			expectedMarkerId,
			markers,
			options,
		);
		const branches = authenticatedContainer?.anyOf;
		if (
			!Array.isArray(branches) ||
			branches.length !== 2 ||
			!branches.every(
				(branch) => isJsonSchemaNode(branch) && markers.get(branch)?.kind === "container-unsafe",
			) ||
			!isJsonSchemaNode(branches[1]) ||
			!projectedJsonSchemaAllowsString(branches[1])
		) {
			throw new OutputTextTrustProjectionError(
				expectedPath,
				new TypeError(
					"A type-mutating output container lost its authenticated runtime text shape.",
				),
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
	const desiredContainerCarriers = new WeakSet<Record<string, unknown>>();
	const visitedStates = new WeakMap<Record<string, unknown>, number>();
	const project = (
		schema: Record<string, unknown>,
		inheritedUntrusted: boolean,
		autoTrustAllowed: boolean,
		runtimeMutationUntrusted: boolean,
	): void => {
		const state =
			1 <<
			((inheritedUntrusted ? 1 : 0) +
				(autoTrustAllowed ? 0 : 2) +
				(runtimeMutationUntrusted ? 4 : 0));
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
		if (runtimeMutationUntrusted) desiredTrust.set(schema, "untrusted");
		if (marker?.kind === "container-unsafe") {
			desiredTrust.set(schema, "untrusted");
			desiredContainerCarriers.add(schema);
		}
		const descendantUntrusted = inheritedUntrusted || marker?.kind === "container-untrusted";
		const descendantAutoTrustAllowed = autoTrustAllowed && marker?.kind !== "container-unsafe";
		const descendantRuntimeMutationUntrusted =
			runtimeMutationUntrusted || marker?.kind === "container-unsafe";
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
				descendantRuntimeMutationUntrusted,
			);
		}
		for (const child of projectedJsonSchemaChildren(schema, false)) {
			project(
				child,
				descendantUntrusted,
				descendantAutoTrustAllowed,
				descendantRuntimeMutationUntrusted,
			);
		}
	};
	project(root, false, true, false);

	for (const { schema } of nodes) {
		delete schema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY];
		delete schema[APIFUSE_TEXT_TRUST_META_KEY];
	}
	for (const { schema } of nodes) {
		const trust = desiredTrust.get(schema);
		if (trust !== undefined) {
			schema[APIFUSE_TEXT_TRUST_META_KEY] = desiredContainerCarriers.has(schema)
				? { v: 1, trust, carrier: "container" }
				: { v: 1, trust };
		}
	}
}

function projectedJsonSchemaAllowsString(schema: Record<string, unknown>): boolean {
	return schema.type === "string" || (Array.isArray(schema.type) && schema.type.includes("string"));
}

function admitPossibleRuntimeText(
	schema: Record<string, unknown>,
	projectionMarkers: Map<string, OutputTextTrustProjectionMarker>,
	expectedLeafMarkers: Map<string, string>,
	expectedUnsafeContainerMarkers: Map<string, string>,
	expectedHonestTextContainerMarkers: Map<string, string>,
	projectedPath: string,
): void {
	const existingMarkerId = schema[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY];
	if (
		typeof existingMarkerId === "string" &&
		projectionMarkers.get(existingMarkerId)?.kind === "container-unsafe"
	) {
		return;
	}
	const originalShape = { ...schema };
	for (const key of Object.keys(schema)) delete schema[key];
	const textShape: Record<string, unknown> = { type: "string" };
	schema.anyOf = [originalShape, textShape];

	const originalPath = appendJsonSchemaPath(appendJsonSchemaPath(projectedPath, "anyOf"), 0);
	rebaseExpectedProjectionPaths(expectedLeafMarkers, projectedPath, originalPath);
	expectedUnsafeContainerMarkers.delete(projectedPath);
	rebaseExpectedProjectionPaths(expectedUnsafeContainerMarkers, projectedPath, originalPath);
	expectedHonestTextContainerMarkers.delete(projectedPath);
	rebaseExpectedProjectionPaths(expectedHonestTextContainerMarkers, projectedPath, originalPath);
	writeOutputTextTrustProjectionMarker(originalShape, projectionMarkers, {
		kind: "container-unsafe",
	});
	writeOutputTextTrustProjectionMarker(textShape, projectionMarkers, {
		kind: "container-unsafe",
	});
}

function rebaseExpectedProjectionPaths(
	expectedMarkers: Map<string, string>,
	fromPath: string,
	toPath: string,
): void {
	for (const [path, markerId] of [...expectedMarkers]) {
		if (path !== fromPath && !path.startsWith(`${fromPath}/`)) continue;
		expectedMarkers.delete(path);
		expectedMarkers.set(`${toPath}${path.slice(fromPath.length)}`, markerId);
	}
}

function projectedJsonSchemaCanAllowString(schema: Record<string, unknown>): boolean {
	return schema.type === undefined || projectedJsonSchemaAllowsString(schema);
}

const PROVABLY_NON_TEXT_JSON_SCHEMA_TYPES = new Set(["boolean", "integer", "null", "number"]);

function mutatorCanUseProjectedTextItems(
	zodSchema: z.core.$ZodType,
	projectedSchema: Record<string, unknown>,
): boolean {
	return (
		projectedJsonSchemaAllowsArray(projectedSchema) &&
		mutatorUsesStaticArrayFallback(zodSchema) &&
		isJsonSchemaNode(projectedSchema.items) &&
		projectedJsonSchemaCanAllowString(projectedSchema.items)
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

function resolveExpectedProjectedSchema(
	root: Record<string, unknown>,
	expectedPath: string,
	expectedMarkerId: string,
	markers: WeakMap<Record<string, unknown>, OutputTextTrustProjectionMarker>,
	options: DescribeSchemaOptions,
): Record<string, unknown> | undefined {
	let target: unknown = root;
	let finalContainer: unknown;
	let finalSegment: string | undefined;
	let finalArrayKeyword: string | undefined;
	if (expectedPath !== "#") {
		if (!expectedPath.startsWith("#/")) {
			throw new OutputTextTrustProjectionError(
				expectedPath,
				new TypeError("Expected projection path is not a local JSON Pointer."),
				options.operationId,
				options.eventName,
			);
		}
		const encodedSegments = expectedPath.slice(2).split("/");
		const decodedSegments = encodedSegments.map((segment) =>
			segment.replaceAll("~1", "/").replaceAll("~0", "~"),
		);
		finalArrayKeyword = decodedSegments.at(-2);
		for (const segment of decodedSegments) {
			const visitedReferences = new WeakSet<Record<string, unknown>>();
			while (isJsonSchemaNode(target) && !Object.hasOwn(target, segment)) {
				if (visitedReferences.has(target) || typeof target.$ref !== "string") return undefined;
				visitedReferences.add(target);
				target = resolveLocalJsonSchemaReference(root, target.$ref, expectedPath, options);
			}
			if (!target || typeof target !== "object" || !Object.hasOwn(target, segment))
				return undefined;
			finalContainer = target;
			finalSegment = segment;
			target = Reflect.get(target, segment);
		}
	}
	if (!isJsonSchemaNode(target)) return undefined;

	const visited = new WeakSet<Record<string, unknown>>();
	const findMarker = (candidate: Record<string, unknown>): Record<string, unknown> | undefined => {
		if (visited.has(candidate)) return undefined;
		visited.add(candidate);
		const markerId = candidate[OUTPUT_TEXT_TRUST_PROJECTION_MARKER_KEY];
		if (markerId === expectedMarkerId && markers.has(candidate)) return candidate;
		if (typeof candidate.$ref === "string") {
			const referenced = findMarker(
				resolveLocalJsonSchemaReference(root, candidate.$ref, expectedPath, options),
			);
			if (referenced) return referenced;
		}
		return undefined;
	};
	const exact = findMarker(target);
	if (exact) return exact;
	if (
		finalSegment !== undefined &&
		/^[0-9]+$/.test(finalSegment) &&
		finalArrayKeyword !== undefined &&
		Array.isArray(finalContainer)
	) {
		const index = Number(finalSegment);
		const findNestedProjectedIndex = (
			candidate: Record<string, unknown>,
		): Record<string, unknown> | undefined => {
			const nestedBranches = candidate[finalArrayKeyword];
			if (Array.isArray(nestedBranches) && isJsonSchemaNode(nestedBranches[index])) {
				const nested = findMarker(nestedBranches[index]);
				if (nested) return nested;
			}
			for (const keyword of ARRAY_SCHEMA_KEYWORDS) {
				const wrappers = candidate[keyword];
				if (!Array.isArray(wrappers)) continue;
				for (const wrapper of wrappers) {
					if (!isJsonSchemaNode(wrapper)) continue;
					const nested = findNestedProjectedIndex(wrapper);
					if (nested) return nested;
				}
			}
			return undefined;
		};
		for (const wrapper of finalContainer) {
			if (!isJsonSchemaNode(wrapper)) continue;
			const nested = findNestedProjectedIndex(wrapper);
			if (nested) return nested;
		}
	}
	return undefined;
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
