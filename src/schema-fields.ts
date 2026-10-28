/**
 * Public schema field declarations. Every node of an operation's input and
 * output that the LLM sees (the root, object properties, union branches,
 * tuple items) describes itself through the SDK: `describeKey()` with a locale
 * key, a `kind.field()` handle, or a `fields.*()` preset. Raw `.describe()`
 * prose is the deprecated path: `defineProvider` warns once per provider now
 * and refuses it in the next release.
 */
import {
	APIFUSE_HANDLE_META_KEY,
	handleFieldDescription,
	isHandleFieldMeta,
} from "./handle-meta.js";
import { APIFUSE_DESCRIPTION_KEY_META_KEY, isSdkFieldDescription } from "./schema.js";
import { type SchemaNode, isSchemaNode, schemaChildren, schemaMeta } from "./schema-walk.js";

export type UndeclaredFieldReason = "raw-prose" | "missing-key";

export interface UndeclaredField {
	readonly path: string;
	readonly reason: UndeclaredFieldReason;
}

function descriptionKeyOf(schema: SchemaNode): string | undefined {
	const value = schemaMeta(schema)[APIFUSE_DESCRIPTION_KEY_META_KEY];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function descriptionOf(schema: SchemaNode): string | undefined {
	const value = schemaMeta(schema).description;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * True when `schema` is a handle field or a `fields.*()` preset (directly or
 * through wrappers) whose description is still the SDK-generated wording, with
 * no wrapper adding its own description. This declares the node itself; the
 * other stages of a pipe or intersection are still walked, so provider prose on
 * them is reported at the same path.
 */
function isSdkOwnedField(schema: SchemaNode, seen = new Set<SchemaNode>()): boolean {
	if (seen.has(schema)) return false;
	seen.add(schema);
	const description = descriptionOf(schema);
	const handle = schemaMeta(schema)[APIFUSE_HANDLE_META_KEY];
	if (isHandleFieldMeta(handle)) return description === handleFieldDescription(handle);
	if (description !== undefined) return isSdkFieldDescription(description);
	for (const child of schemaChildren(schema)) {
		if (child.kind === "wrapper" && isSdkOwnedField(child.schema, seen)) return true;
	}
	return false;
}

function collectInto(
	schema: unknown,
	path: string,
	required: boolean,
	seen: Set<SchemaNode>,
	out: UndeclaredField[],
): void {
	if (!isSchemaNode(schema) || seen.has(schema)) return;
	seen.add(schema);

	if (!isSdkOwnedField(schema) && descriptionKeyOf(schema) === undefined) {
		if (descriptionOf(schema) !== undefined) out.push({ path, reason: "raw-prose" });
		else if (required) out.push({ path, reason: "missing-key" });
	}

	for (const child of schemaChildren(schema)) {
		switch (child.kind) {
			case "property":
				collectInto(child.schema, `${path}.${child.key}`, true, seen, out);
				break;
			case "item":
			case "option":
				collectInto(child.schema, `${path}[${child.index}]`, true, seen, out);
				break;
			case "element":
				collectInto(child.schema, `${path}[]`, false, seen, out);
				break;
			case "wrapper":
			case "entry":
				collectInto(child.schema, path, false, seen, out);
				break;
		}
	}
}

/**
 * Every node of a public schema that neither carries a locale key nor
 * SDK-owned wording. `side` prefixes the paths (`input`, `output`).
 */
export function collectUndeclaredFields(schema: unknown, side: string): UndeclaredField[] {
	const out: UndeclaredField[] = [];
	collectInto(schema, side, true, new Set(), out);
	return out;
}

const warnedProviders = new Set<string>();

function describeReason(field: UndeclaredField): string {
	return field.reason === "raw-prose" ? "raw .describe() prose" : "no description";
}

/**
 * Warns once per provider about public schema nodes still on the deprecated
 * path, naming each with its reason. The served contract is unchanged; the
 * next release refuses these at this site.
 */
export function warnUndeclaredFields(
	providerId: string,
	operations: Record<string, { readonly input?: unknown; readonly output?: unknown }>,
): void {
	if (warnedProviders.has(providerId)) return;
	const listed: string[] = [];
	for (const [operationKey, operation] of Object.entries(operations)) {
		for (const field of [
			...collectUndeclaredFields(operation.input, "input"),
			...collectUndeclaredFields(operation.output, "output"),
		]) {
			listed.push(`operations.${operationKey}.${field.path} (${describeReason(field)})`);
		}
	}
	if (listed.length === 0) return;
	warnedProviders.add(providerId);
	console.warn(
		`[provider-sdk] Provider "${providerId}" has ${listed.length} public schema field${listed.length === 1 ? "" : "s"} without a locale key: ${listed.join(", ")}. Describe each with .describeKey("<locale key>") instead of .describe("prose") (codemod: scripts/codemods/schema.yml); the next release refuses them at defineProvider.`,
	);
}
