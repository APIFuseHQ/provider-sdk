/**
 * Handle contract resolution (ADR-0012, amended 2026-10-28).
 *
 * The property key a handle travels under and the operation that issues it
 * are facts written exactly once: in the operation schemas, where
 * `kind.field()` is placed. `defineProvider` walks those schemas, binds the
 * resolved contract onto each kind (so runtime error text and the
 * `x-apifuse-handle` meta read the same names), and refreshes the SDK-owned
 * field description with the issuing operation(s). Nothing is declared twice,
 * so there is nothing for a lint rule to cross-check.
 */
import { z } from "zod";
import { ValidationError } from "../errors.js";
import {
	APIFUSE_HANDLE_META_KEY,
	type HandleFieldDirection,
	type HandleFieldMeta,
	type HandleIssuedBy,
	handleFieldDescription,
	isHandleFieldDescription,
	isHandleFieldMeta,
} from "../handle-meta.js";
import type { SchemaLike } from "../types.js";

/**
 * Well-known symbol under which a kind keeps its contract internals. A
 * `Symbol.for` key survives duplicate SDK module copies (the packaged CLI runs
 * `src/*` while the provider imports `dist/*`), where a module-private WeakMap
 * would not.
 */
export const HANDLE_KIND_INTERNALS = Symbol.for("apifuse.provider-sdk.handle.kind");

/** Same-symbol link from a `kind.field()` meta object back to its kind. */
export const HANDLE_META_KIND = Symbol.for("apifuse.provider-sdk.handle.meta-kind");

export type LegacyHandleOption = "fieldName" | "issuedBy";

/** Contract facts resolved from the operation schemas by `defineProvider`. */
export interface ResolvedHandleContract {
	readonly fieldName?: string;
	readonly outputFieldName?: string;
	/** One issuer stays a string so a migrated kind emits the meta shape it always did. */
	readonly issuedBy?: HandleIssuedBy;
}

/** Mutable copy of {@link HandleFieldMeta} that `bindHandleContract` keeps current. */
export type MutableHandleFieldMeta = {
	kind: string;
	type: HandleFieldMeta["type"];
	fieldName: string;
	outputFieldName?: string;
	issuedBy?: HandleFieldMeta["issuedBy"];
};

export interface HandleKindInternals {
	/** Options still passed to `defineCursor`/`defineDraft` on the deprecated path. */
	readonly declared: readonly LegacyHandleOption[];
	/** Facts bound by `defineProvider`; read by the kind's getters when nothing was declared. */
	resolved: ResolvedHandleContract;
	/** Every meta object this kind has emitted through `field()`, kept in sync on bind. */
	readonly metas: Set<MutableHandleFieldMeta>;
	/** Recomputes the plain meta fields from the kind's current (declared or resolved) names. */
	readonly refreshMeta: (meta: MutableHandleFieldMeta) => void;
}

export function getHandleKindInternals(kind: unknown): HandleKindInternals | undefined {
	if (typeof kind !== "object" || kind === null) return undefined;
	const value = Reflect.get(kind, HANDLE_KIND_INTERNALS);
	return value && typeof value === "object" ? (value as HandleKindInternals) : undefined;
}

/** Options a kind still declares on the deprecated path, or an empty list. */
export function legacyHandleOptionsOf(kind: unknown): readonly LegacyHandleOption[] {
	return getHandleKindInternals(kind)?.declared ?? [];
}

/**
 * Binds the contract `defineProvider` resolved from the schemas onto a kind.
 * Declared (deprecated) options keep precedence inside the kind's getters, so
 * a provider that has not run the codemod sees byte-identical text.
 */
export function bindHandleContract(kind: unknown, contract: ResolvedHandleContract): void {
	const internals = getHandleKindInternals(kind);
	if (!internals) return;
	internals.resolved = contract;
	for (const meta of internals.metas) internals.refreshMeta(meta);
}

// ---------------------------------------------------------------------------
// Schema walk
// ---------------------------------------------------------------------------

export interface HandleFieldOccurrence {
	/** Diagnostic path, e.g. `output.offers[].waiting_token`. */
	readonly path: string;
	/** Property key the field is declared under (inherited through arrays and wrappers). */
	readonly key: string;
	readonly side: HandleFieldDirection;
	readonly meta: HandleFieldMeta;
	/** The schema node that owns the meta (the `kind.field()` string or its registry clone). */
	readonly node: SchemaLike;
}

type SchemaRecord = Record<string, unknown> & SchemaLike;

function isSchema(value: unknown): value is SchemaRecord {
	return (
		!!value &&
		typeof value === "object" &&
		"safeParse" in value &&
		typeof (value as { safeParse?: unknown }).safeParse === "function"
	);
}

function schemaDef(schema: SchemaRecord): Record<string, unknown> {
	const def = schema.def ?? schema._def;
	return def && typeof def === "object" ? (def as Record<string, unknown>) : {};
}

function objectShape(schema: SchemaRecord): Record<string, unknown> {
	const own = typeof schema.shape === "function" ? schema.shape() : schema.shape;
	if (own && typeof own === "object") return own as Record<string, unknown>;
	const fromDef = schemaDef(schema).shape;
	const resolved = typeof fromDef === "function" ? fromDef() : fromDef;
	return resolved && typeof resolved === "object" ? (resolved as Record<string, unknown>) : {};
}

function ownHandleMeta(schema: SchemaRecord): HandleFieldMeta | undefined {
	const meta = z.globalRegistry.get(schema as never);
	const value = meta ? Reflect.get(meta, APIFUSE_HANDLE_META_KEY) : undefined;
	return isHandleFieldMeta(value) ? value : undefined;
}

/** zod internals that are transparent for the property key (wrappers, pipes, branches). */
const STRUCTURAL_DEF_KEYS = [
	"innerType",
	"in",
	"out",
	"left",
	"right",
	"element",
	"valueType",
	"keyType",
	"catchall",
	"rest",
] as const;

function* childSchemas(
	schema: SchemaRecord,
): Generator<{ readonly schema: SchemaRecord; readonly key?: string; readonly list?: boolean }> {
	const def = schemaDef(schema);
	for (const [key, value] of Object.entries(objectShape(schema))) {
		if (isSchema(value)) yield { schema: value, key };
	}
	for (const name of STRUCTURAL_DEF_KEYS) {
		const value = def[name];
		if (isSchema(value)) {
			yield { schema: value, list: name === "element" || name === "valueType" };
		}
	}
	if (typeof def.getter === "function") {
		const value = (def.getter as () => unknown)();
		if (isSchema(value)) yield { schema: value };
	}
	for (const listKey of ["items", "options"] as const) {
		const value = def[listKey];
		const entries = Array.isArray(value)
			? value
			: value instanceof Set || value instanceof Map
				? Array.from(value.values())
				: [];
		for (const entry of entries) if (isSchema(entry)) yield { schema: entry };
	}
}

function collect(
	schema: unknown,
	side: HandleFieldDirection,
	path: string,
	key: string | undefined,
	ancestors: Set<SchemaRecord>,
	out: HandleFieldOccurrence[],
): void {
	if (!isSchema(schema)) return;
	const meta = ownHandleMeta(schema);
	if (meta && key !== undefined) {
		out.push({ path, key, side, meta, node: schema });
		return;
	}
	// Ancestor-only cycle guard: one wrapped instance reused under two property
	// keys is two fields and must be visited at both positions.
	if (ancestors.has(schema)) return;
	ancestors.add(schema);
	try {
		for (const child of childSchemas(schema)) {
			if (child.key !== undefined) {
				collect(child.schema, side, `${path}.${child.key}`, child.key, ancestors, out);
			} else {
				collect(child.schema, side, child.list ? `${path}[]` : path, key, ancestors, out);
			}
		}
	} finally {
		ancestors.delete(schema);
	}
}

/** Every handle field in one operation side, with the property key it sits under. */
export function collectHandleFields(
	schema: unknown,
	side: HandleFieldDirection,
): HandleFieldOccurrence[] {
	const out: HandleFieldOccurrence[] = [];
	collect(schema, side, side, undefined, new Set(), out);
	return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface KindUsage {
	kind: object;
	readonly name: string;
	readonly keys: { input: Map<string, string>; output: Map<string, string> };
	readonly issuers: string[];
}

/**
 * Resolves and binds the handle contract for every kind used by `operations`,
 * then refreshes the SDK-owned description on every handle field so it names
 * the issuing operation(s). Throws when one kind travels under two different
 * keys on the same side: the LLM must see exactly one name per direction.
 */
export function bindHandleContracts(
	providerId: string,
	operations: Record<string, { readonly input?: unknown; readonly output?: unknown }>,
): void {
	const usages = new Map<object, KindUsage>();
	const occurrences: HandleFieldOccurrence[] = [];

	for (const [operationKey, operation] of Object.entries(operations)) {
		for (const side of ["input", "output"] as const) {
			for (const occurrence of collectHandleFields(operation[side], side)) {
				occurrences.push(occurrence);
				const kind = Reflect.get(occurrence.meta, HANDLE_META_KIND) as object | undefined;
				if (!kind) continue;
				let usage = usages.get(kind);
				if (!usage) {
					usage = {
						kind,
						name: occurrence.meta.kind,
						keys: { input: new Map(), output: new Map() },
						issuers: [],
					};
					usages.set(kind, usage);
				}
				const keys = usage.keys[side];
				if (!keys.has(occurrence.key)) {
					keys.set(occurrence.key, `operations.${operationKey}.${occurrence.path}`);
				}
				if (side === "output" && !usage.issuers.includes(operationKey)) {
					usage.issuers.push(operationKey);
				}
			}
		}
	}

	for (const usage of usages.values()) {
		for (const side of ["input", "output"] as const) {
			const keys = usage.keys[side];
			if (keys.size <= 1) continue;
			const listed = Array.from(keys.entries())
				.map(([key, at]) => `"${key}" at ${at}`)
				.join(", ");
			throw new ValidationError(
				`Provider "${providerId}" handle kind "${usage.name}" is placed under ${keys.size} different ${side} keys: ${listed}.`,
				{
					fix: `Use one property key per direction for ${usage.name}.field() so the LLM sees one name; a kind that needs a different key on input and output may use one key per side.`,
				},
			);
		}
		const inputKey = first(usage.keys.input);
		const outputKey = first(usage.keys.output);
		const fieldName = inputKey ?? outputKey;
		bindHandleContract(usage.kind, {
			...(fieldName !== undefined ? { fieldName } : {}),
			...(outputKey !== undefined && inputKey !== undefined && outputKey !== inputKey
				? { outputFieldName: outputKey }
				: {}),
			...(usage.issuers.length === 1
				? { issuedBy: usage.issuers[0] }
				: usage.issuers.length > 1
					? { issuedBy: Object.freeze([...usage.issuers]) }
					: {}),
		});
	}

	for (const occurrence of occurrences) refreshFieldDescription(occurrence.node, occurrence.meta);
}

function first(keys: Map<string, string>): string | undefined {
	return keys.keys().next().value;
}

/**
 * `describeKey()`/`sensitive()` clone the field and copy the description
 * string into the clone's own registry entry, so a description computed before
 * the contract was bound stays stale on that clone. Rewrite it only while it is
 * still SDK-owned wording; a provider's own description is never touched.
 */
function refreshFieldDescription(node: SchemaLike, meta: HandleFieldMeta): void {
	const entry = z.globalRegistry.get(node as never);
	const current = entry?.description;
	const expected = handleFieldDescription(meta);
	if (current === expected || typeof current !== "string" || !isHandleFieldDescription(current)) {
		return;
	}
	z.globalRegistry.add(node as never, { ...entry, description: expected });
}
