import { Buffer } from "node:buffer";

import type { JsonValue } from "./contract-json.js";

export const REDACTED_FIXTURE_VALUE = "[REDACTED]";

const OPAQUE_TOKEN = /^[A-Za-z0-9_+/=.:~-]+$/;
const OPAQUE_TOKEN_RUN = /[A-Za-z0-9_+/=.:~-]{24,}/g;
const URL_RUN = /https?:\/\/[^\s"'<>]+/gi;
const EMAIL_ADDRESS_RUN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const DIAGNOSTIC_URL_SENTINEL_DELIMITER = String.fromCodePoint(0);
const DIAGNOSTIC_URL_SENTINEL_RUN = new RegExp(
	`${DIAGNOSTIC_URL_SENTINEL_DELIMITER}APIFUSE_URL(\\d+)${DIAGNOSTIC_URL_SENTINEL_DELIMITER}`,
	"g",
);
const PEM_PRIVATE_KEY =
	/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
/** RFC 9110 §11.4 `token68`, the single credential token of Bearer, Basic, Negotiate and NTLM. */
const TOKEN68 = "[A-Za-z0-9._~+/-]+=*";
/**
 * A credential header's value is the whole RFC 9110 `credentials` production
 * (`auth-scheme SP token68`), so the scheme and its token are one value, not two words.
 * The key starts at a word boundary so a long word run is scanned once, not from every offset.
 */
const CREDENTIALS_HEADER_ASSIGNMENT = new RegExp(
	String.raw`(?<![\w-])((["']?)[\w-]*authorization\2\s*[:=]\s*)[A-Za-z][\w.+-]*[ \t]+${TOKEN68}(?![^\s,;&])`,
	"gi",
);
/**
 * Keyless echoes of the token68 schemes whose token is always a credential. Only the scheme and
 * its whitespace are matched, so matches never overlap a later scheme; the token is the whole
 * opaque run that follows, so no partial redaction leaves a remainder too short for the
 * opaque-token scan. Negotiate and NTLM match only their registered spelling so prose such as
 * "failed to negotiate TLS" is retained.
 */
const TOKEN68_SCHEMES = [/\bBearer\s+/gi, /\b(?:Negotiate|NTLM)\s+/g] as const;
/** A keyless `Basic` token is a credential only when it decodes to `user-id:password`. */
const BASIC_SCHEME = /\bBasic\s+/gi;
const OPAQUE_TOKEN_CHARACTER = /[A-Za-z0-9_+/=.:~-]/;
const BASE64_CHARACTER = /[A-Za-z0-9+/]/;
const ASSIGNMENT_VALUE_DELIMITER = /[\s,;&]/;
/**
 * A key and its `:`/`=`, starting at a word boundary so a word run is scanned once. Values are
 * never consumed, so an assignment inside another value is still found.
 */
const ASSIGNMENT_KEY = /(["']?)(?<![\w-])([\w-]+)\1\s*[:=]\s*/gi;

/** Matches credential field names without treating benign prefixes such as `author` as `auth`. */
export function isSensitiveFixtureKey(key: string): boolean {
	const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
	const candidates = [normalized, normalized.replace(/(?:value|payload|header)$/, "")];
	return candidates.some(
		(candidate) =>
			/^(?:authorization|authentication|auth|bearer|cookie|credential|password|passwd|privatekey|secret|session|sessionid|token)$/.test(
				candidate,
			) ||
			// Unanchored at the start so vendor-prefixed headers (`x-api-key`) match too.
			/(?:api|client|service|access|consumer)(?:key|secret|token)$/.test(candidate) ||
			/(?:authorization|credential|password|passwd|privatekey|secret|sessionid|token)$/.test(
				candidate,
			),
	);
}

/**
 * Returns JSON fixture data with credential-bearing keys and heuristic-confirmed string secrets
 * replaced. Ordinary short prose and identifiers are retained.
 */
export function sanitizeFixture(value: JsonValue): JsonValue {
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeFixture(item));
	}

	if (typeof value === "string") return sanitizeFixtureString(value);
	if (value === null || typeof value !== "object") return value;

	return Object.fromEntries(
		Object.entries(value).map(([key, entryValue]) => [
			key,
			isSensitiveFixtureKey(key) ? REDACTED_FIXTURE_VALUE : sanitizeFixture(entryValue),
		]),
	);
}

/** Applies the shared credential-key policy to ordinary JSON fixtures. */
export function sanitizeOrdinaryFixture(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map((item) => sanitizeOrdinaryFixture(item));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entryValue]) => [
			key,
			isSensitiveFixtureKey(key) ? REDACTED_FIXTURE_VALUE : sanitizeOrdinaryFixture(entryValue),
		]),
	);
}

/** Sanitizes a primitive fixture string only when textual-secret heuristics match. */
export function sanitizeFixtureString(value: string): string {
	let sanitized = value.replace(PEM_PRIVATE_KEY, REDACTED_FIXTURE_VALUE);
	const retainedUrls: string[] = [];
	sanitized = sanitized.replace(URL_RUN, (url) => {
		const index =
			retainedUrls.push(isCredentialBearingUrl(url) ? sanitizeUrlForLogs(url) : url) - 1;
		return `APIFUSEURL${index}X`;
	});
	sanitized = redactCredentialSpans(sanitized, [credentialHeaderSpans, sensitiveAssignmentSpans]);
	sanitized = sanitized.replace(OPAQUE_TOKEN_RUN, (candidate) =>
		isSensitiveFixtureValue(candidate) ? REDACTED_FIXTURE_VALUE : candidate,
	);
	sanitized = sanitized.replace(
		/APIFUSEURL(\d+)X/g,
		(_match, index: string) => retainedUrls[Number(index)] ?? REDACTED_FIXTURE_VALUE,
	);
	return sanitized;
}

/** True for opaque values that are unsafe to retain in paths or unstructured text. */
export function isSensitiveFixtureValue(value: string): boolean {
	const candidate = decodePathSegment(value);
	if (/^bot(?:\d{6,}:)?[A-Za-z0-9_-]{16,}$/i.test(candidate)) return true;
	if (/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(candidate)) return true;
	if (/^(?:gh[opusr]_|sk[-_]|xox[baprs]-)[A-Za-z0-9_-]{16,}$/i.test(candidate)) return true;
	if (!OPAQUE_TOKEN.test(candidate) || candidate.length < 24) return false;
	if (/^[a-f0-9]{32,}$/i.test(candidate)) return true;
	return shannonEntropy(candidate) >= 3.5;
}

/** Sanitizes every path segment and values following a credential-like segment name. */
export function sanitizePathname(pathname: string): string {
	const segments = pathname.split("/");
	return segments
		.map((segment, index) => {
			if (!segment) return segment;
			const decoded = decodePathSegment(segment);
			const previous = index > 0 ? decodePathSegment(segments[index - 1] as string) : "";
			if (
				isSensitivePathSegment(decoded) ||
				isCredentialPathKey(previous) ||
				isSensitiveFixtureValue(decoded)
			) {
				return REDACTED_FIXTURE_VALUE;
			}
			return segment;
		})
		.join("/");
}

function isCredentialPathKey(key: string): boolean {
	const finalPathPart = key.split("/").at(-1) ?? "";
	const baseSegment = finalPathPart.split(";", 1)[0] ?? "";
	return isSensitiveFixtureKey(baseSegment.split(/[=:]/, 1)[0] ?? "");
}

function isSensitivePathSegment(segment: string): boolean {
	return segment
		.split(/[;/]/)
		.some((part) => isSensitiveFixtureKey(part.split(/[=:]/, 1)[0] ?? ""));
}

/** Removes userinfo, query values, fragments, and credential-like path segments from log URLs. */
export function sanitizeUrlForLogs(value: string): string {
	try {
		const parsed = new URL(value, "https://fixture.invalid");
		const queryMarker = parsed.search ? `?${REDACTED_FIXTURE_VALUE}` : "";
		const path = sanitizePathname(parsed.pathname);
		if (parsed.origin === "https://fixture.invalid" && !hasExplicitOrigin(value)) {
			return `${path}${queryMarker}`;
		}
		return `${parsed.origin}${path}${queryMarker}`;
	} catch {
		return sanitizePathname(value.split(/[?#]/, 1)[0]);
	}
}

/**
 * Returns query-free request provenance with each path segment scrubbed for credential-like values.
 * Origins, URL userinfo, query values, and fragments are never persisted in request provenance.
 */
export function requestPathForFixture(value: string): string {
	try {
		return sanitizePathname(new URL(value, "https://fixture.invalid").pathname);
	} catch {
		const path = value.split(/[?#]/, 1)[0];
		return sanitizePathname(path.startsWith("/") ? path : `/${path}`);
	}
}

/** Scrubs secrets and terminal/log control characters before diagnostic text is emitted. */
export function sanitizeDiagnosticText(value: string): string {
	const retainedUrls: string[] = [];
	// Remove attacker-controlled NUL delimiters before introducing internal URL sentinels.
	let sanitized = encodeDiagnosticControls(value)
		.replace(URL_RUN, (url) => {
			const index = retainedUrls.push(sanitizeUrlForLogs(url)) - 1;
			return `${DIAGNOSTIC_URL_SENTINEL_DELIMITER}APIFUSE_URL${index}${DIAGNOSTIC_URL_SENTINEL_DELIMITER}`;
		})
		.replace(EMAIL_ADDRESS_RUN, REDACTED_FIXTURE_VALUE);
	sanitized = redactCredentialSpans(sanitized, [
		credentialHeaderSpans,
		keylessCredentialSpans,
		sensitiveAssignmentSpans,
	]);
	sanitized = sanitized.replace(OPAQUE_TOKEN_RUN, (candidate, offset: number, source: string) => {
		if (/^(?:request|trace|correlation)[-_]?id[:=]/i.test(candidate)) return candidate;
		const prefix = source.slice(Math.max(0, offset - 32), offset);
		if (/(?:request|trace|correlation)[-_]?id\s*[:=]\s*$/i.test(prefix)) return candidate;
		return isSensitiveFixtureValue(candidate) ? REDACTED_FIXTURE_VALUE : candidate;
	});
	sanitized = sanitized.replace(
		DIAGNOSTIC_URL_SENTINEL_RUN,
		(_match, index: string) => retainedUrls[Number(index)] ?? REDACTED_FIXTURE_VALUE,
	);
	return encodeDiagnosticControls(sanitized);
}

type CredentialSpan = readonly [start: number, end: number];

/**
 * Every credential rule scans the same unmodified text and reports spans; the output redacts
 * their union. No rule's rewrite can hide a key or a scheme word from another rule, so adding a
 * rule can only redact more.
 */
function redactCredentialSpans(
	value: string,
	rules: readonly ((value: string) => Iterable<CredentialSpan>)[],
): string {
	const spans = rules
		.flatMap((rule) => [...rule(value)])
		.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	let output = "";
	let cursor = 0;
	let open: [number, number] | undefined;
	const close = (span: [number, number]) => {
		output += value.slice(cursor, span[0]) + REDACTED_FIXTURE_VALUE;
		cursor = span[1];
	};
	for (const [start, end] of spans) {
		if (open && start <= open[1]) {
			open[1] = Math.max(open[1], end);
			continue;
		}
		if (open) close(open);
		open = [start, end];
	}
	if (open) close(open);
	return output + value.slice(cursor);
}

/** The scheme and token of a credential header value, as one span. */
function* credentialHeaderSpans(value: string): Iterable<CredentialSpan> {
	for (const match of value.matchAll(CREDENTIALS_HEADER_ASSIGNMENT)) {
		yield [match.index + (match[1] as string).length, match.index + match[0].length];
	}
}

/** Tokens after keyless `Bearer`/`Negotiate`/`NTLM`, and `Basic` tokens that decode to `user-id:password`. */
function* keylessCredentialSpans(value: string): Iterable<CredentialSpan> {
	const opaqueEnds = runEnds(value, OPAQUE_TOKEN_CHARACTER);
	for (const scheme of TOKEN68_SCHEMES) {
		for (const match of value.matchAll(scheme)) {
			const start = match.index + match[0].length;
			if (opaqueEnds[start] > start) yield [start, opaqueEnds[start]];
		}
	}
	const base64Ends = runEnds(value, BASE64_CHARACTER);
	for (const match of value.matchAll(BASIC_SCHEME)) {
		const start = match.index + match[0].length;
		const payloadEnd = base64Ends[start];
		let end = payloadEnd;
		while (end < payloadEnd + 2 && value[end] === "=") end++;
		// The base64 token must be the whole opaque run, not the prefix of a longer token.
		if (payloadEnd === start || end !== opaqueEnds[start]) continue;
		if (Buffer.from(value.slice(start, end), "base64").includes(0x3a)) yield [start, end];
	}
}

/**
 * Values of credential-named keys; quotes around a quoted value are kept. Every key is visited,
 * including keys inside another key's value (`auth: {"password": "x"}`), and each value's extent
 * is read from precomputed tables, so the scan stays linear in the text length.
 */
function* sensitiveAssignmentSpans(value: string): Iterable<CredentialSpan> {
	let extents: AssignmentValueExtents | undefined;
	for (const key of value.matchAll(ASSIGNMENT_KEY)) {
		const name = key[2] as string;
		if (!isSensitiveFixtureKey(name) && name.toLowerCase() !== "key") continue;
		extents ??= assignmentValueExtents(value);
		const start = key.index + key[0].length;
		const quote = value[start];
		const closing =
			quote === '"'
				? extents.doubleQuoteClose[start + 1]
				: quote === "'"
					? extents.singleQuoteClose[start + 1]
					: -1;
		if (closing !== -1) {
			yield [start + 1, closing];
		} else if (extents.unquotedEnds[start] > start) {
			yield [start, extents.unquotedEnds[start]];
		}
	}
}

type AssignmentValueExtents = {
	/** End of the unquoted value (`[^\s,;&]+`) starting at each index. */
	readonly unquotedEnds: Int32Array;
	/** Index of the closing `"` when a `"(?:\\.|[^"\\])*"` body is read from each index, or -1. */
	readonly doubleQuoteClose: Int32Array;
	readonly singleQuoteClose: Int32Array;
};

function assignmentValueExtents(value: string): AssignmentValueExtents {
	const unquotedEnds = new Int32Array(value.length + 1);
	unquotedEnds[value.length] = value.length;
	for (let index = value.length - 1; index >= 0; index--) {
		unquotedEnds[index] = ASSIGNMENT_VALUE_DELIMITER.test(value[index] as string)
			? index
			: unquotedEnds[index + 1];
	}
	return {
		unquotedEnds,
		doubleQuoteClose: closingQuotes(value, '"'),
		singleQuoteClose: closingQuotes(value, "'"),
	};
}

/** Right-to-left: reading a quoted body from index i either closes at a quote or skips an escape pair. */
function closingQuotes(value: string, quote: string): Int32Array {
	const closing = new Int32Array(value.length + 2).fill(-1);
	for (let index = value.length - 1; index >= 0; index--) {
		const character = value[index];
		closing[index] =
			character === quote
				? index
				: character === "\\"
					? /[^\n\r\u2028\u2029]/.test(value[index + 1] ?? "\n")
						? (closing[index + 2] as number)
						: -1
					: (closing[index + 1] as number);
	}
	return closing;
}

/** For each index, the end of the run of `character` starting there, in one right-to-left pass. */
function runEnds(value: string, character: RegExp): Int32Array {
	const ends = new Int32Array(value.length + 1);
	ends[value.length] = value.length;
	for (let index = value.length - 1; index >= 0; index--) {
		ends[index] = character.test(value[index] as string) ? (ends[index + 1] as number) : index;
	}
	return ends;
}

function isCredentialBearingUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return (
			parsed.username !== "" ||
			parsed.password !== "" ||
			parsed.hash !== "" ||
			parsed.search !== "" ||
			parsed.pathname.split("/").some((segment, index, segments) => {
				const decoded = decodePathSegment(segment);
				const previous = decodePathSegment(segments[index - 1] ?? "");
				return (
					isSensitiveFixtureKey(decoded) ||
					isCredentialPathKey(previous) ||
					isSensitiveFixtureValue(decoded)
				);
			})
		);
	} catch {
		return false;
	}
}

/** Encodes terminal/log control characters without applying value-level secret heuristics. */
export function encodeDiagnosticControls(value: string): string {
	let result = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) {
			result += " ";
		} else if (
			(code >= 0 && code <= 0x1f) ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x061c ||
			code === 0x200e ||
			code === 0x200f ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		) {
			result += `\\u${code.toString(16).padStart(4, "0")}`;
		} else {
			result += character;
		}
	}
	return result;
}

function decodePathSegment(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function hasExplicitOrigin(value: string): boolean {
	return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

function shannonEntropy(value: string): number {
	const counts = new Map<string, number>();
	for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
	let entropy = 0;
	for (const count of counts.values()) {
		const probability = count / value.length;
		entropy -= probability * Math.log2(probability);
	}
	return entropy;
}
