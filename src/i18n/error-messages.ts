import { sanitizeDiagnosticText } from "../fixture-sanitization.js";
import type { ProviderLocaleCatalogMap } from "./catalog.js";
import {
	getProviderLocaleSegments,
	isProviderLocaleKey,
	type ProviderLocale,
	type ProviderLocaleValue,
} from "./keys.js";

/**
 * Values interpolated into a localized provider error message or fix.
 *
 * Strings and finite numbers only. String values are treated as untrusted
 * (upstream bodies frequently end up here), so they are scrubbed and capped by
 * {@link interpolateProviderErrorText} before substitution.
 */
export type ProviderErrorMessageParams = Readonly<Record<string, string | number>>;

/** Locales the SDK negotiates for client-facing provider text. */
export const PROVIDER_ERROR_LOCALES = ["en", "ko", "ja"] as const;

/** Locale used when the caller asks for nothing the provider catalog covers. */
export const DEFAULT_PROVIDER_ERROR_LOCALE = "en";

/** Catalog namespace for derived `errors.<code>.message` / `errors.<code>.fix` lookups. */
export const PROVIDER_ERROR_CATALOG_NAMESPACE = "errors";

/** Per-value cap applied to every interpolated param, before substitution. */
export const MAX_INTERPOLATED_PARAM_LENGTH = 200;

/** Cap applied to a rendered localized message or fix. */
export const MAX_LOCALIZED_ERROR_TEXT_LENGTH = 2_000;

const TRUNCATION_SUFFIX = "…";

// One pass, three alternatives: `{{` and `}}` are the literal-brace escapes and
// `{name}` is a substitution. Named groups are deliberately not used so the
// callback can distinguish an escape from a substitution by the matched text.
const PLACEHOLDER_PATTERN = /\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Markup openers are removed outright rather than entity-escaped: the envelope
// is plain text, so an escaped `&lt;` would be as wrong for a terminal as a raw
// `<` is for an HTML surface. The `&` rule only fires in front of an
// entity-shaped run, so ordinary prose ("Tom & Jerry") survives while
// `&lt;script&gt;` cannot be revived by a consumer that decodes entities.
const MARKUP_OPENER_PATTERN = /[<>`]/g;
const HTML_ENTITY_AMPERSAND_PATTERN = /&(?=#?[0-9A-Za-z]{1,32};)/g;

function isProviderErrorLocale(value: string | undefined): value is ProviderLocale {
	return PROVIDER_ERROR_LOCALES.some((locale) => locale === value);
}

type RankedLanguageRange = {
	readonly primary: string;
	readonly quality: number;
	readonly position: number;
};

/**
 * Negotiates an `Accept-Language` header against {@link PROVIDER_ERROR_LOCALES}.
 *
 * Quality values are honoured (`ko;q=0.1, ja;q=0.9` selects `ja`) and `q=0`
 * means "not acceptable". Ranges are matched on the primary subtag, so `ko-KR`
 * selects `ko`. Returns `undefined` when the header is absent or names no
 * supported locale, so callers can consult a lower-precedence source before
 * defaulting.
 */
export function providerLocaleFromAcceptLanguage(
	header: string | null | undefined,
): ProviderLocale | undefined {
	if (typeof header !== "string" || header.length === 0) return undefined;
	const ranges: RankedLanguageRange[] = [];
	for (const [position, token] of header.split(",").entries()) {
		const [rangeText, ...parameters] = token.split(";");
		const primary = rangeText?.trim().split("-")[0]?.toLowerCase();
		if (!primary) continue;
		const quality = parseQualityValue(parameters);
		if (quality <= 0) continue;
		ranges.push({ primary, quality, position });
	}
	// Stable by construction: equal qualities keep header order.
	ranges.sort((left, right) =>
		left.quality === right.quality ? left.position - right.position : right.quality - left.quality,
	);
	for (const range of ranges) {
		if (isProviderErrorLocale(range.primary)) return range.primary;
	}
	return undefined;
}

function parseQualityValue(parameters: readonly string[]): number {
	for (const parameter of parameters) {
		const [name, value] = parameter.split("=");
		if (name?.trim().toLowerCase() !== "q") continue;
		const quality = Number.parseFloat(value?.trim() ?? "");
		// A malformed `q` is not a rejection; RFC 9110 treats the range as
		// fully acceptable when no usable quality is present.
		if (!Number.isFinite(quality)) return 1;
		return Math.min(Math.max(quality, 0), 1);
	}
	return 1;
}

/** Reads `accept-language` from a case-insensitive header record. */
export function acceptLanguageHeaderValue(
	headers: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
	if (!headers) return undefined;
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === "accept-language" && typeof value === "string") return value;
	}
	return undefined;
}

/**
 * Picks the first supported locale across header sources, in precedence order,
 * falling back to {@link DEFAULT_PROVIDER_ERROR_LOCALE}.
 */
export function resolveProviderErrorLocale(
	...headerValues: readonly (string | null | undefined)[]
): ProviderLocale {
	for (const value of headerValues) {
		const locale = providerLocaleFromAcceptLanguage(value);
		if (locale) return locale;
	}
	return DEFAULT_PROVIDER_ERROR_LOCALE;
}

function truncateText(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}${TRUNCATION_SUFFIX}`;
}

/**
 * Renders one param value as substitution text, or `undefined` when the value
 * cannot be substituted (absent, non-finite, or not a string/number).
 */
export function interpolatedParamText(value: unknown): string | undefined {
	if (typeof value === "number") {
		return Number.isFinite(value) ? String(value) : undefined;
	}
	if (typeof value !== "string") return undefined;
	// sanitizeDiagnosticText scrubs credentials and encodes control, bidi and
	// line-separator characters; the markup pass closes the HTML/markdown hole
	// it deliberately leaves open for log text.
	const scrubbed = sanitizeDiagnosticText(value)
		.replace(MARKUP_OPENER_PATTERN, "")
		.replace(HTML_ENTITY_AMPERSAND_PATTERN, "")
		.replace(/\s+/g, " ")
		.trim();
	return truncateText(scrubbed, MAX_INTERPOLATED_PARAM_LENGTH);
}

/**
 * Substitutes `{name}` placeholders in a catalog template.
 *
 * - `{{` and `}}` are the literal `{` and `}` escapes.
 * - A placeholder with no usable param is left verbatim, so an authoring gap is
 *   visible in the response instead of silently deleting text.
 * - Substituted text is never rescanned, so a param value containing `{other}`
 *   cannot trigger a second round of interpolation.
 */
export function interpolateProviderErrorText(
	template: string,
	params?: ProviderErrorMessageParams,
): string {
	const rendered = template.replace(PLACEHOLDER_PATTERN, (match, name?: string) => {
		if (match === "{{") return "{";
		if (match === "}}") return "}";
		if (name === undefined) return match;
		const substitution = interpolatedParamText(
			params && Object.hasOwn(params, name) ? params[name] : undefined,
		);
		return substitution ?? match;
	});
	return truncateText(rendered, MAX_LOCALIZED_ERROR_TEXT_LENGTH);
}

function asCatalogText(value: ProviderLocaleValue | undefined): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readCatalogSegments(
	catalogs: ProviderLocaleCatalogMap,
	segments: readonly string[],
	locale: ProviderLocale,
	fallbackLocale: ProviderLocale,
): string | undefined {
	return (
		asCatalogText(getProviderLocaleSegments(catalogs[locale] ?? {}, segments)) ??
		asCatalogText(getProviderLocaleSegments(catalogs[fallbackLocale] ?? {}, segments))
	);
}

/** A key candidate considered by {@link localizeProviderErrorText}, in priority order. */
export type ProviderErrorTextCandidate =
	/** An explicit dot-path key from a throw site or an `errorCodes[]` declaration. */
	| { readonly kind: "key"; readonly key: string | undefined }
	/** The `errors.<code>.<field>` convention; `code` is used verbatim as a segment. */
	| { readonly kind: "derived"; readonly code: string | undefined; readonly field: string };

export interface LocalizeProviderErrorTextOptions {
	readonly catalogs?: ProviderLocaleCatalogMap;
	readonly locale: ProviderLocale;
	readonly fallbackLocale?: ProviderLocale;
	readonly candidates: readonly ProviderErrorTextCandidate[];
	readonly params?: ProviderErrorMessageParams;
	/** Literal text returned when no candidate resolves. May be `undefined` for `fix`. */
	readonly fallback: string | undefined;
}

/**
 * Resolves client-facing error text against the provider locale catalogs.
 *
 * Candidates are tried in order and each one is resolved in the caller's locale
 * before the `en` catalog, so a more specific key always beats a more specific
 * locale. Nothing here throws: a malformed key, an absent catalog, a
 * non-string catalog value and a missing key all fall through to the next
 * candidate and ultimately to `fallback`.
 */
export function localizeProviderErrorText(
	options: LocalizeProviderErrorTextOptions,
): string | undefined {
	const { catalogs } = options;
	if (!catalogs) return options.fallback;
	const fallbackLocale = options.fallbackLocale ?? DEFAULT_PROVIDER_ERROR_LOCALE;
	for (const candidate of options.candidates) {
		const segments = candidateSegments(candidate);
		if (!segments) continue;
		try {
			const template = readCatalogSegments(catalogs, segments, options.locale, fallbackLocale);
			if (template === undefined) continue;
			return interpolateProviderErrorText(template, options.params);
		} catch {
			// A hostile catalog or params object (throwing getters, exotic proxies)
			// must not turn a provider error into a masked 500. Fall through to the
			// next candidate and ultimately to the English literal.
		}
	}
	return options.fallback;
}

function candidateSegments(candidate: ProviderErrorTextCandidate): readonly string[] | undefined {
	if (candidate.kind === "key") {
		// Explicit keys must satisfy the dot-path grammar; a malformed key is a
		// miss, never a throw at envelope time.
		return isProviderLocaleKey(candidate.key) ? candidate.key.split(".") : undefined;
	}
	if (typeof candidate.code !== "string" || candidate.code.length === 0) return undefined;
	return [PROVIDER_ERROR_CATALOG_NAMESPACE, candidate.code, candidate.field];
}

/** The `errors.<code>.<field>` dot path this SDK derives for an undeclared key. */
export function derivedProviderErrorCatalogPath(code: string, field: "message" | "fix"): string {
	return `${PROVIDER_ERROR_CATALOG_NAMESPACE}.${code}.${field}`;
}
