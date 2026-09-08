/**
 * Shared, dependency-free definitions for LLM-friendly handles (ADR-0012).
 *
 * Kept separate from the runtime so schema helpers, lint, and the runtime can
 * agree on the JSON Schema meta key and the declaration shape without importing
 * each other.
 */

/** JSON Schema meta key placed on every schema field created by `kind.field()`. */
export const APIFUSE_HANDLE_META_KEY = "x-apifuse-handle" as const;

export type HandleKindType = "cursor" | "draft";
export type HandleAccess = "bound" | "public";

/**
 * Operation key(s) that issue a handle. A single string is the common case; a
 * list names every operation whose output carries the field (for example
 * `search-address` and `reverse-geocode` both issuing `location_token`).
 */
export type HandleIssuedBy = string | readonly string[];

/** Value stored under {@link APIFUSE_HANDLE_META_KEY} on a handle field. */
export interface HandleFieldMeta {
	readonly kind: string;
	readonly type: HandleKindType;
	readonly fieldName: string;
	readonly issuedBy?: HandleIssuedBy;
}

/**
 * Structural view of a handle kind as seen by the provider declaration
 * (`handle: [WaitingDraft, PageCursor]`), lint, and the registry. The runtime
 * kinds returned by `defineCursor` / `defineDraft` satisfy this shape.
 */
export interface HandleKindDeclaration {
	readonly name: string;
	readonly type: HandleKindType;
	readonly fieldName: string;
	readonly access: HandleAccess;
	readonly issuedBy?: HandleIssuedBy;
}

/** Kind names are lowercase letters only so they never fuse with the word body. */
export const HANDLE_KIND_NAME_PATTERN = /^[a-z]{2,12}$/;

/** True for a single operation key or a non-empty list of operation keys. */
export function isHandleIssuedBy(value: unknown): value is HandleIssuedBy {
	if (typeof value === "string") return true;
	return (
		Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string")
	);
}

/** Normalizes `issuedBy` to a list of operation keys (empty when undefined). */
export function handleIssuerList(issuedBy: HandleIssuedBy | undefined): readonly string[] {
	if (issuedBy === undefined) return [];
	return typeof issuedBy === "string" ? [issuedBy] : issuedBy;
}

/**
 * Renders the issuing operation(s) as inline code for error and description
 * text: `` `a` ``, `` `a` or `b` ``, `` `a`, `b`, or `c` ``. Undefined when no
 * issuer is declared.
 */
export function formatHandleIssuers(issuedBy: HandleIssuedBy | undefined): string | undefined {
	const issuers = handleIssuerList(issuedBy).map((operation) => `\`${operation}\``);
	if (issuers.length === 0) return undefined;
	if (issuers.length === 1) return issuers[0];
	if (issuers.length === 2) return `${issuers[0]} or ${issuers[1]}`;
	return `${issuers.slice(0, -1).join(", ")}, or ${issuers[issuers.length - 1]}`;
}

export function isHandleFieldMeta(value: unknown): value is HandleFieldMeta {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.kind === "string" &&
		(record.type === "cursor" || record.type === "draft") &&
		typeof record.fieldName === "string" &&
		(record.issuedBy === undefined || isHandleIssuedBy(record.issuedBy))
	);
}

/**
 * The SDK-owned description `kind.field()` emits. Lint exempts a handle field
 * from `describeKey` only while its description is exactly this text; a
 * provider override re-enters the localization rules.
 */
export function handleFieldDescription(meta: Pick<HandleFieldMeta, "issuedBy">): string {
	const issuers = formatHandleIssuers(meta.issuedBy);
	const origin = issuers ? ` issued by ${issuers}` : "";
	return `Opaque handle${origin}. Copy it exactly as returned; do not edit or shorten it.`;
}
