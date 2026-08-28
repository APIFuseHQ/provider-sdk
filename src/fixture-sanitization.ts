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

/** Matches credential field names without treating benign prefixes such as `author` as `auth`. */
export function isSensitiveFixtureKey(key: string): boolean {
	const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
	const candidates = [normalized, normalized.replace(/(?:value|payload|header)$/, "")];
	return candidates.some(
		(candidate) =>
			/^(?:authorization|authentication|auth|bearer|cookie|credential|password|passwd|privatekey|secret|session|sessionid|token)$/.test(
				candidate,
			) ||
			/^(?:api|client|service|access|consumer)(?:key|secret|token)$/.test(candidate) ||
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
	sanitized = redactSensitiveAssignments(sanitized);
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
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED_FIXTURE_VALUE}`)
		.replace(EMAIL_ADDRESS_RUN, REDACTED_FIXTURE_VALUE);
	sanitized = redactSensitiveAssignments(sanitized);
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

function redactSensitiveAssignments(value: string): string {
	return value.replace(
		/((["']?)([\w-]+)\2\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi,
		(match, prefix: string, _quote: string, key: string, assignmentValue: string) => {
			if (!isSensitiveFixtureKey(key) && key.toLowerCase() !== "key") return match;
			const quote = assignmentValue.startsWith('"')
				? '"'
				: assignmentValue.startsWith("'")
					? "'"
					: "";
			return `${prefix}${quote}${REDACTED_FIXTURE_VALUE}${quote}`;
		},
	);
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
