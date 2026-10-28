/**
 * One zod walker for every SDK pass over a public operation schema (handle
 * contract resolution, public field-name lint, description checks). Each
 * consumer decides what an edge kind means for its own path and requirement
 * rules; the traversal shape is written here once.
 */
import type { ZodType } from "zod";

export type SchemaNode = ZodType & Record<string, unknown>;

/**
 * Where a child sits relative to its parent:
 * - `property`: an object shape entry, keyed by the provider-chosen name;
 * - `wrapper`: same value, same key (optional, nullable, default, catch,
 *   readonly, prefault, pipe stages, intersection branches, lazy target);
 * - `element`: array element, a list position;
 * - `entry`: record key or value, object catchall, tuple rest, a list position
 *   with no key of its own;
 * - `item`: tuple item at `index`;
 * - `option`: union branch at `index`.
 */
export type SchemaEdgeKind = "property" | "wrapper" | "element" | "entry" | "item" | "option";

export interface SchemaEdge {
	readonly schema: SchemaNode;
	readonly kind: SchemaEdgeKind;
	readonly key?: string;
	readonly index?: number;
}

export function isSchemaNode(value: unknown): value is SchemaNode {
	return (
		!!value &&
		typeof value === "object" &&
		"safeParse" in value &&
		typeof (value as { safeParse?: unknown }).safeParse === "function"
	);
}

function node(schema: ZodType): SchemaNode {
	return schema as SchemaNode;
}

export function schemaDef(schema: ZodType): Record<string, unknown> {
	const def: unknown = node(schema).def ?? node(schema)._def;
	return def && typeof def === "object" ? (def as Record<string, unknown>) : {};
}

export function schemaMeta(schema: ZodType): Record<string, unknown> {
	const meta: unknown = typeof schema.meta === "function" ? schema.meta() : undefined;
	return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
}

export function objectShape(schema: ZodType): Record<string, unknown> {
	const shape = node(schema).shape;
	const own = typeof shape === "function" ? shape() : shape;
	if (own && typeof own === "object") return own as Record<string, unknown>;
	const fromDef = schemaDef(schema).shape;
	const resolved = typeof fromDef === "function" ? fromDef() : fromDef;
	return resolved && typeof resolved === "object" ? (resolved as Record<string, unknown>) : {};
}

const WRAPPER_DEF_KEYS = ["innerType", "in", "out", "left", "right"] as const;
const ENTRY_DEF_KEYS = ["valueType", "keyType", "catchall", "rest"] as const;

function listed(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (value instanceof Set || value instanceof Map) return Array.from(value.values());
	return [];
}

export function* schemaChildren(schema: ZodType): Generator<SchemaEdge> {
	const def = schemaDef(schema);
	for (const [key, value] of Object.entries(objectShape(schema))) {
		if (isSchemaNode(value)) yield { schema: value, kind: "property", key };
	}
	for (const name of WRAPPER_DEF_KEYS) {
		const value = def[name];
		if (isSchemaNode(value)) yield { schema: value, kind: "wrapper" };
	}
	if (typeof def.getter === "function") {
		const value = (def.getter as () => unknown)();
		if (isSchemaNode(value)) yield { schema: value, kind: "wrapper" };
	}
	if (isSchemaNode(def.element)) yield { schema: def.element, kind: "element" };
	for (const name of ENTRY_DEF_KEYS) {
		const value = def[name];
		if (isSchemaNode(value)) yield { schema: value, kind: "entry" };
	}
	for (const [index, value] of listed(def.items).entries()) {
		if (isSchemaNode(value)) yield { schema: value, kind: "item", index };
	}
	for (const [index, value] of listed(def.options).entries()) {
		if (isSchemaNode(value)) yield { schema: value, kind: "option", index };
	}
}
