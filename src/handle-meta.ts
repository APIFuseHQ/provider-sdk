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

/** Value stored under {@link APIFUSE_HANDLE_META_KEY} on a handle field. */
export interface HandleFieldMeta {
	readonly kind: string;
	readonly type: HandleKindType;
	readonly fieldName: string;
	readonly issuedBy?: string;
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
	readonly issuedBy?: string;
}

/** Kind names are lowercase letters only so they never fuse with the word body. */
export const HANDLE_KIND_NAME_PATTERN = /^[a-z]{2,12}$/;

export function isHandleFieldMeta(value: unknown): value is HandleFieldMeta {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.kind === "string" &&
		(record.type === "cursor" || record.type === "draft") &&
		typeof record.fieldName === "string" &&
		(record.issuedBy === undefined || typeof record.issuedBy === "string")
	);
}

/**
 * The SDK-owned description `kind.field()` emits. Lint exempts a handle field
 * from `describeKey` only while its description is exactly this text; a
 * provider override re-enters the localization rules.
 */
export function handleFieldDescription(meta: Pick<HandleFieldMeta, "issuedBy">): string {
	const origin = meta.issuedBy ? ` issued by \`${meta.issuedBy}\`` : "";
	return `Opaque handle${origin}. Copy it exactly as returned; do not edit or shorten it.`;
}
