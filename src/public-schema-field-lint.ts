import type { LintDiagnostic } from "./lint.js";
import { type SchemaNode, isSchemaNode, schemaChildren } from "./schema-walk.js";

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
	seen = new Set<SchemaNode>(),
): LintDiagnostic[] {
	if (!isSchemaNode(schema) || seen.has(schema)) {
		return [];
	}

	seen.add(schema);
	const diagnostics: LintDiagnostic[] = [];
	for (const child of schemaChildren(schema)) {
		if (child.kind === "property" && child.key !== undefined) {
			const fieldPath = `${basePath}.${child.key}`;
			const replacement = ESTABLISHED_APIFUSE_PROTOCOL_FIELDS.has(child.key)
				? undefined
				: recommendedReplacement(child.key);
			if (replacement) {
				diagnostics.push({
					rule: "public-schema-upstream-field",
					level: "error",
					field: fieldPath,
					message: `Provider "${providerId}" operation "${operationId}" public schema field "${fieldPath}" uses upstream-shaped field "${child.key}"; use APIFuse field "${replacement}" instead.`,
				});
			}
			diagnostics.push(
				...collectPublicSchemaFieldDiagnostics(providerId, operationId, child.schema, fieldPath, seen),
			);
			continue;
		}
		const childPath = child.kind === "element" ? `${basePath}[]` : basePath;
		diagnostics.push(
			...collectPublicSchemaFieldDiagnostics(providerId, operationId, child.schema, childPath, seen),
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
		...collectPublicSchemaFieldDiagnostics(providerId, operationId, input, "input"),
		...collectPublicSchemaFieldDiagnostics(providerId, operationId, output, "output"),
	];
}
