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
 * Keyless echoes of the token68 schemes whose token is always a credential. Negotiate and NTLM
 * match only their registered spelling so prose such as "failed to negotiate TLS" is retained.
 */
const TOKEN68_SCHEME_CREDENTIALS = [
	/\bBearer\s+([A-Za-z0-9._~+/=-]+)/gi,
	/\b(?:Negotiate|NTLM)\s+([A-Za-z0-9._~+/=-]+)/g,
] as const;
/** A keyless `Basic` token is a credential only when it decodes to `user-id:password`. */
const BASIC_SCHEME_CREDENTIAL = /\bBasic\s+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9._~+/=-])/gi;
const SENSITIVE_ASSIGNMENT =
	/((["']?)([\w-]+)\2\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi;

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
	for (const pattern of TOKEN68_SCHEME_CREDENTIALS) {
		for (const match of value.matchAll(pattern)) yield tokenSpan(match);
	}
	for (const match of value.matchAll(BASIC_SCHEME_CREDENTIAL)) {
		if (Buffer.from(match[1] as string, "base64").includes(0x3a)) yield tokenSpan(match);
	}
}

function tokenSpan(match: RegExpExecArray): CredentialSpan {
	const end = match.index + match[0].length;
	return [end - (match[1] as string).length, end];
}

/** Values of credential-named keys; quotes around a quoted value are kept. */
function* sensitiveAssignmentSpans(value: string): Iterable<CredentialSpan> {
	for (const match of value.matchAll(SENSITIVE_ASSIGNMENT)) {
		const key = match[3] as string;
		if (!isSensitiveFixtureKey(key) && key.toLowerCase() !== "key") continue;
		const assignmentValue = match[4] as string;
		const quote = assignmentValue[0];
		const quoted =
			(quote === '"' || quote === "'") &&
			assignmentValue.length > 1 &&
			assignmentValue.endsWith(quote)
				? 1
				: 0;
		const start = match.index + (match[1] as string).length + quoted;
		yield [start, start + assignmentValue.length - 2 * quoted];
	}
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
