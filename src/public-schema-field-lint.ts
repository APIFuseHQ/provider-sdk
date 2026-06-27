import type { ZodType } from "zod";

import type { LintDiagnostic } from "./lint";

type SchemaLike = ZodType & {
	def?: Record<string, unknown>;
	_def?: Record<string, unknown>;
	shape?: Record<string, SchemaLike> | (() => Record<string, SchemaLike>);
	element?: SchemaLike;
	items?: SchemaLike[];
	options?: SchemaLike[] | Set<SchemaLike> | Map<string, SchemaLike>;
	innerType?: SchemaLike;
	sourceType?: () => SchemaLike;
	unwrap?: () => SchemaLike;
	in?: SchemaLike;
	out?: SchemaLike;
	left?: SchemaLike;
	right?: SchemaLike;
};

const ESTABLISHED_APIFUSE_PROTOCOL_FIELDS = new Set(["externalRef"]);

const UPSTREAM_FIELD_REPLACEMENTS = new Map<string, string>([
	["display", "limit"],
	["start", "offset"],
	["sort", "sort_by"],
	["lprice", "lowest_price"],
	["hprice", "highest_price"],
	["mallName", "mall_name"],
	["productId", "product_id"],
	["productType", "product_type_code"],
	["lastBuildDate", "upstream_generated_at"],
	["meta", "summary"],
]);

function isSchema(value: unknown): value is SchemaLike {
	return (
		!!value &&
		typeof value === "object" &&
		"safeParse" in value &&
		typeof value.safeParse === "function"
	);
}

function getSchemaDef(schema: SchemaLike): Record<string, unknown> {
	const def = schema.def ?? schema._def;
	return def && typeof def === "object" ? def : {};
}

function isSchemaRecord(value: unknown): value is Record<string, SchemaLike> {
	if (!value || typeof value !== "object") {
		return false;
	}
	return Object.values(value).every(isSchema);
}

function getObjectShape(schema: SchemaLike): Record<string, SchemaLike> {
	const rawShape =
		typeof schema.shape === "function" ? schema.shape() : schema.shape;
	if (isSchemaRecord(rawShape)) {
		return rawShape;
	}

	const defShape = getSchemaDef(schema).shape;
	if (typeof defShape === "function") {
		const resolved = defShape();
		return isSchemaRecord(resolved) ? resolved : {};
	}
	return isSchemaRecord(defShape) ? defShape : {};
}

function appendSchemaChildren(
	children: SchemaLike[],
	value: unknown,
): SchemaLike[] {
	if (isSchema(value)) {
		children.push(value);
		return children;
	}
	if (Array.isArray(value)) {
		children.push(...value.filter(isSchema));
		return children;
	}
	if (value instanceof Set) {
		children.push(...Array.from(value).filter(isSchema));
		return children;
	}
	if (value instanceof Map) {
		children.push(...Array.from(value.values()).filter(isSchema));
		return children;
	}
	return children;
}

function safeSourceType(schema: SchemaLike): SchemaLike | undefined {
	try {
		return schema.sourceType?.();
	} catch {
		return undefined;
	}
}

function safeUnwrap(schema: SchemaLike): SchemaLike | undefined {
	try {
		return schema.unwrap?.();
	} catch {
		return undefined;
	}
}

function getTransparentChildSchemas(schema: SchemaLike): SchemaLike[] {
	const def = getSchemaDef(schema);
	const children: SchemaLike[] = [];
	for (const value of [
		schema.element,
		schema.items,
		schema.options,
		schema.innerType,
		safeSourceType(schema),
		safeUnwrap(schema),
		schema.in,
		schema.out,
		schema.left,
		schema.right,
		def.schema,
		def.innerType,
		def.type,
		def.valueType,
		def.item,
		def.items,
		def.rest,
		def.catchall,
		def.option,
		def.options,
		def.pipe,
		def.payload,
		def.sourceType,
		def.left,
		def.right,
	]) {
		appendSchemaChildren(children, value);
	}
	return children;
}

function recommendedReplacement(fieldName: string): string | undefined {
	if (/^category\d+$/.test(fieldName)) {
		return "category_path";
	}
	if (UPSTREAM_FIELD_REPLACEMENTS.has(fieldName)) {
		return UPSTREAM_FIELD_REPLACEMENTS.get(fieldName);
	}
	if (/[a-z][A-Z]/.test(fieldName)) {
		return fieldName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
	}
	return undefined;
}

function collectPublicSchemaFieldDiagnostics(
	providerId: string,
	operationId: string,
	schema: unknown,
	basePath: string,
	seen = new Set<SchemaLike>(),
): LintDiagnostic[] {
	if (!isSchema(schema) || seen.has(schema)) {
		return [];
	}

	seen.add(schema);
	const diagnostics: LintDiagnostic[] = [];
	for (const [fieldName, child] of Object.entries(getObjectShape(schema))) {
		const fieldPath = `${basePath}.${fieldName}`;
		const replacement = ESTABLISHED_APIFUSE_PROTOCOL_FIELDS.has(fieldName)
			? undefined
			: recommendedReplacement(fieldName);
		if (replacement) {
			diagnostics.push({
				rule: "public-schema-upstream-field",
				level: "error",
				field: fieldPath,
				message: `Provider "${providerId}" operation "${operationId}" public schema field "${fieldPath}" uses upstream-shaped field "${fieldName}"; use APIFuse field "${replacement}" instead.`,
			});
		}
		diagnostics.push(
			...collectPublicSchemaFieldDiagnostics(
				providerId,
				operationId,
				child,
				fieldPath,
				seen,
			),
		);
	}

	for (const child of getTransparentChildSchemas(schema)) {
		const childPath = schema.element === child ? `${basePath}[]` : basePath;
		diagnostics.push(
			...collectPublicSchemaFieldDiagnostics(
				providerId,
				operationId,
				child,
				childPath,
				seen,
			),
		);
	}

	return diagnostics;
}

export function lintPublicSchemaFieldNames(
	providerId: string | undefined,
	operationId: string,
	input: unknown,
	output: unknown,
	enforce: boolean,
): LintDiagnostic[] {
	if (!providerId || !enforce) {
		return [];
	}

	return [
		...collectPublicSchemaFieldDiagnostics(
			providerId,
			operationId,
			input,
			"input",
		),
		...collectPublicSchemaFieldDiagnostics(
			providerId,
			operationId,
			output,
			"output",
		),
	];
}
