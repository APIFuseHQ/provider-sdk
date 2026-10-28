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
	type HandleKindDeclaration,
	handleFieldDescription,
	handleIssuerList,
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

/**
 * How a child position affects whether a handle below it is required by the
 * schema as a whole: `always` keeps the parent's requirement (object
 * properties, pipes, intersections, tuple items, lazy), `list` drops it (an
 * empty array or record satisfies the schema), `branch` requires it only when
 * every branch of the union does.
 */
type ChildMode = "always" | "list" | "branch";

/** zod internals that are transparent for the property key (wrappers, pipes, branches). */
const STRUCTURAL_DEF_KEYS: readonly (readonly [key: string, mode: ChildMode])[] = [
	["innerType", "always"],
	["in", "always"],
	["out", "always"],
	["left", "always"],
	["right", "always"],
	["element", "list"],
	["valueType", "list"],
	["keyType", "list"],
	["catchall", "list"],
	["rest", "list"],
];

/** Wrappers whose value may be absent or null, so nothing below them is required. */
const OPTIONAL_DEF_TYPES = new Set(["optional", "nullable", "default", "prefault", "catch"]);

function* childSchemas(
	schema: SchemaRecord,
): Generator<{ readonly schema: SchemaRecord; readonly key?: string; readonly mode: ChildMode }> {
	const def = schemaDef(schema);
	for (const [key, value] of Object.entries(objectShape(schema))) {
		if (isSchema(value)) yield { schema: value, key, mode: "always" };
	}
	for (const [name, mode] of STRUCTURAL_DEF_KEYS) {
		const value = def[name];
		if (isSchema(value)) yield { schema: value, mode };
	}
	if (typeof def.getter === "function") {
		const value = (def.getter as () => unknown)();
		if (isSchema(value)) yield { schema: value, mode: "always" };
	}
	for (const [listKey, mode] of [
		["items", "always"],
		["options", "branch"],
	] as const) {
		const value = def[listKey];
		const entries = Array.isArray(value)
			? value
			: value instanceof Set || value instanceof Map
				? Array.from(value.values())
				: [];
		for (const entry of entries) if (isSchema(entry)) yield { schema: entry, mode };
	}
}

function kindOf(meta: HandleFieldMeta): object | undefined {
	return Reflect.get(meta, HANDLE_META_KIND) as object | undefined;
}

/**
 * Collects every handle field below `schema` into `out` and returns the kinds
 * the schema requires: those reachable through required object properties
 * only, with no optional wrapper, list, or partial union branch on the way.
 */
function collect(
	schema: unknown,
	side: HandleFieldDirection,
	path: string,
	key: string | undefined,
	ancestors: Set<SchemaRecord>,
	out: HandleFieldOccurrence[],
): Set<object> {
	if (!isSchema(schema)) return new Set();
	const type = schemaDef(schema).type;
	const required = collectBelow(schema, side, path, key, ancestors, out);
	return typeof type === "string" && OPTIONAL_DEF_TYPES.has(type) ? new Set() : required;
}

function collectBelow(
	schema: SchemaRecord,
	side: HandleFieldDirection,
	path: string,
	key: string | undefined,
	ancestors: Set<SchemaRecord>,
	out: HandleFieldOccurrence[],
): Set<object> {
	const required = new Set<object>();
	const meta = ownHandleMeta(schema);
	if (meta && key !== undefined) {
		out.push({ path, key, side, meta, node: schema });
		const kind = kindOf(meta);
		if (kind) required.add(kind);
		return required;
	}
	// Ancestor-only cycle guard: one wrapped instance reused under two property
	// keys is two fields and must be visited at both positions.
	if (ancestors.has(schema)) return required;
	ancestors.add(schema);
	try {
		const branches: Set<object>[] = [];
		for (const child of childSchemas(schema)) {
			const below =
				child.key !== undefined
					? collect(child.schema, side, `${path}.${child.key}`, child.key, ancestors, out)
					: collect(
							child.schema,
							side,
							child.mode === "list" ? `${path}[]` : path,
							key,
							ancestors,
							out,
						);
			if (child.mode === "always") for (const kind of below) required.add(kind);
			else if (child.mode === "branch") branches.push(below);
		}
		if (branches.length > 0) {
			for (const kind of branches[0]!) {
				if (branches.every((branch) => branch.has(kind))) required.add(kind);
			}
		}
	} finally {
		ancestors.delete(schema);
	}
	return required;
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

/** Handle fields on one side plus the kinds that side requires (input only matters). */
function walkSide(
	schema: unknown,
	side: HandleFieldDirection,
): { readonly fields: HandleFieldOccurrence[]; readonly required: Set<object> } {
	const fields: HandleFieldOccurrence[] = [];
	const required = collect(schema, side, side, undefined, new Set(), fields);
	return { fields, required };
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

const warnedIssuerDisagreements = new Set<string>();

/**
 * Resolves and binds the handle contract for every kind used by `operations`,
 * then refreshes the SDK-owned description on every handle field so it names
 * the issuing operation(s).
 *
 * An operation issues a kind when its output places the field and its input
 * does not require it; an operation that requires the handle on input and
 * returns it is a continuation (a round of the same attempt), never an issuer.
 * A pagination operation with an optional cursor on input is the issuer of its
 * own first page.
 *
 * Throws when one kind travels under two different keys on the same side (the
 * LLM must see exactly one name per direction) and when a kind listed in
 * `handle: [...]` is never issued or never accepted by any operation.
 */
export function bindHandleContracts(
	providerId: string,
	operations: Record<string, { readonly input?: unknown; readonly output?: unknown }>,
	declared: readonly HandleKindDeclaration[] = [],
): void {
	const usages = new Map<object, KindUsage>();
	const occurrences: HandleFieldOccurrence[] = [];

	for (const [operationKey, operation] of Object.entries(operations)) {
		const input = walkSide(operation.input, "input");
		const output = walkSide(operation.output, "output");
		for (const occurrence of [...input.fields, ...output.fields]) {
			occurrences.push(occurrence);
			const kind = kindOf(occurrence.meta);
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
			const keys = usage.keys[occurrence.side];
			if (!keys.has(occurrence.key)) {
				keys.set(occurrence.key, `operations.${operationKey}.${occurrence.path}`);
			}
			if (
				occurrence.side === "output" &&
				!input.required.has(kind) &&
				!usage.issuers.includes(operationKey)
			) {
				usage.issuers.push(operationKey);
			}
		}
	}

	for (const kind of declared) {
		const usage = usages.get(kind);
		const missing =
			usage === undefined || usage.keys.output.size === 0
				? "output"
				: usage.keys.input.size === 0
					? "input"
					: undefined;
		if (missing === undefined) continue;
		const verb = missing === "output" ? "issued" : "accepted";
		const role = missing === "output" ? "issuing" : "consuming";
		throw new ValidationError(
			`Provider "${providerId}" handle kind "${kind.name}" is listed in handle: [...] but never ${verb}: no operation ${missing} places ${kind.name}.field().`,
			{
				fix: `Add ${kind.name}.field() to the ${missing} of the ${role} operation, or remove ${kind.name} from handle: [...].`,
			},
		);
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
			// One issuer stays a string: the apifuse registry reads `issuedBy` as a
			// string, and a list is emitted only when several operations issue.
			...(usage.issuers.length === 1
				? { issuedBy: usage.issuers[0] }
				: usage.issuers.length > 1
					? { issuedBy: Object.freeze([...usage.issuers]) }
					: {}),
		});
		warnIssuerDisagreement(providerId, usage);
	}

	for (const occurrence of occurrences) refreshFieldDescription(occurrence.node, occurrence.meta);
}

function first(keys: Map<string, string>): string | undefined {
	return keys.keys().next().value;
}

/**
 * During the deprecation window a declared `issuedBy` keeps precedence; when
 * the schemas derive a different issuer set, say so once so the disagreement
 * is fixed before the option goes away.
 */
function warnIssuerDisagreement(providerId: string, usage: KindUsage): void {
	const internals = getHandleKindInternals(usage.kind);
	if (!internals?.declared.includes("issuedBy")) return;
	const declared = handleIssuerList((usage.kind as Partial<HandleKindDeclaration>).issuedBy);
	const derived = usage.issuers;
	if (declared.length === derived.length && declared.every((op, i) => op === derived[i])) return;
	const token = `${providerId}:${usage.name}`;
	if (warnedIssuerDisagreements.has(token)) return;
	warnedIssuerDisagreements.add(token);
	console.warn(
		`[provider-sdk] Provider "${providerId}" handle kind "${usage.name}" declares issuedBy ${JSON.stringify(declared)} but its schemas derive ${JSON.stringify(derived)}; the declared value stays in effect until the option is removed. An operation issues a kind when its output places ${usage.name}.field() and its input does not require it. Fix the placements or the declaration so they agree.`,
	);
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
