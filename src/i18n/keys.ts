import type { ProviderLocaleKey } from "../types.js";

export type { ProviderLocale, ProviderLocaleKey } from "../types.js";

/**
 * An ordinary catalog name segment: camelCase, ASCII only.
 *
 * `[A-Z][a-z0-9]+` forces at least one character after each hump, so a
 * screaming acronym (`errorsURL`) is not silently read as camelCase.
 */
const NAME_SEGMENT_RE = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)*$/;

/** An array-index segment, e.g. the `0` in `meta.tags.0`. */
const INDEX_SEGMENT_RE = /^[0-9]+$/;

/**
 * An error-code segment: the thrown `code` used verbatim as a catalog key.
 *
 * Single-case underscore words only — `UPSTREAM_SCHEMA_ERROR`, `BLOCKED`,
 * `reauth_required` — matching the shape the SDK registers and the fleet
 * throws (a census of 91 provider repos found 224 distinct codes: 213
 * SCREAMING_SNAKE, 11 lower_snake, none mixed-case, none with a leading digit).
 * A leading letter is mandatory, so no error code can be spelled like the
 * numeric array-index form and the two segment kinds stay disjoint.
 * The lower_snake arm requires an underscore because a bare lowercase word is
 * already a {@link NAME_SEGMENT_RE} segment.
 */
const ERROR_CODE_SEGMENT_RE = /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)$/;

/**
 * The only parent under which an error-code segment is legal.
 *
 * Must stay equal to `PROVIDER_ERROR_CATALOG_NAMESPACE` in `error-messages.ts`
 * (the derived-path test in `keys.test.ts` fails if they drift). Anchoring the
 * code vocabulary to this one parent is what keeps the grammar from degrading
 * into "any identifier anywhere": everywhere else a segment is still camelCase
 * or an array index.
 */
const ERROR_CODE_PARENT_SEGMENT = "errors";

/**
 * Validates one segment in position.
 *
 * `parent` is the preceding segment, or `undefined` for the first segment. The
 * first segment is always a plain name: catalogs are rooted in SDK-owned
 * namespaces (`meta`, `operations`, `auth`, `errors`), never in an index or a
 * code.
 */
function isValidProviderLocaleSegment(segment: string, parent: string | undefined): boolean {
	if (parent === undefined) return NAME_SEGMENT_RE.test(segment);
	if (NAME_SEGMENT_RE.test(segment) || INDEX_SEGMENT_RE.test(segment)) return true;
	return parent === ERROR_CODE_PARENT_SEGMENT && ERROR_CODE_SEGMENT_RE.test(segment);
}

export function providerLocaleKey(key: string): ProviderLocaleKey {
	assertProviderLocaleKey(key);
	return key;
}

export function isProviderLocaleKey(value: unknown): value is ProviderLocaleKey {
	if (typeof value !== "string" || value.length === 0) return false;
	const segments = value.split(".");
	for (const [index, segment] of segments.entries()) {
		// `split(".")` yields "" for an empty segment ("a..b", ".a", "a."), which
		// no segment pattern matches, so those stay rejected.
		if (!isValidProviderLocaleSegment(segment, index === 0 ? undefined : segments[index - 1]))
			return false;
	}
	return true;
}

export function assertProviderLocaleKey(value: unknown): asserts value is ProviderLocaleKey {
	if (!isProviderLocaleKey(value)) {
		throw new Error(
			`Provider locale key must be a camelCase dot path such as "meta.description" or "operations.search.description", optionally naming an error code under "${ERROR_CODE_PARENT_SEGMENT}." as in "errors.UPSTREAM_SCHEMA_ERROR.message"; received ${JSON.stringify(value)}`,
		);
	}
}

export function qualifyProviderLocaleKey(
	providerId: string,
	key: ProviderLocaleKey | string,
): string {
	assertProviderLocaleKey(key);
	return `providers.${providerId}.${key}`;
}

export function getProviderLocalePath(
	catalog: ProviderLocaleCatalog,
	key: ProviderLocaleKey | string,
): ProviderLocaleValue | undefined {
	assertProviderLocaleKey(key);
	return getProviderLocaleSegments(catalog, key.split("."));
}

/**
 * Reads a catalog path from raw segments, bypassing the dot-path grammar.
 *
 * Derived error-message lookups address the catalog by the thrown error code
 * (`errors.<code>.message`). The grammar now accepts the code shapes the SDK
 * registers and the fleet throws, but `code` is provider data: a provider may
 * throw anything, and an unusual code must still resolve its catalog entry
 * rather than be dropped as malformed. Own properties only: a
 * `__proto__`/`constructor` segment must read as a miss, not as the prototype
 * chain.
 */
export function getProviderLocaleSegments(
	catalog: ProviderLocaleCatalog,
	segments: readonly string[],
): ProviderLocaleValue | undefined {
	if (segments.length === 0) return undefined;
	let cursor: unknown = catalog;
	for (const segment of segments) {
		if (!isRecord(cursor) || !Object.hasOwn(cursor, segment)) return undefined;
		cursor = cursor[segment];
	}
	return isProviderLocaleValue(cursor) ? cursor : undefined;
}

export type ProviderLocaleValue = string | readonly string[];
export type ProviderLocaleCatalog = Record<string, unknown>;

export function isProviderLocaleValue(value: unknown): value is ProviderLocaleValue {
	return (
		typeof value === "string" ||
		(Array.isArray(value) && value.every((entry) => typeof entry === "string"))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
