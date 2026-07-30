import type { JsonValue } from "./contract-json.js";

export const REDACTED_FIXTURE_VALUE = "[REDACTED]";

const SENSITIVE_FIXTURE_KEY =
	/authorization|auth(?:entication)?|bearer|cookie|credential|password|passwd|private[-_]?key|secret|session(?:[-_]?id)?|token|(?:api|client|service|access|consumer)[-_]?key/i;
const OPAQUE_TOKEN = /^[A-Za-z0-9_+/=.:~-]+$/;

export function isSensitiveFixtureKey(key: string): boolean {
	return SENSITIVE_FIXTURE_KEY.test(key);
}

/**
 * Returns JSON fixture data with values under common credential-bearing keys replaced.
 * The return type intentionally models JSON rather than promising the caller's input type.
 */
export function sanitizeFixture(value: JsonValue): JsonValue {
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeFixture(item));
	}

	if (value === null || typeof value !== "object") {
		return value;
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, entryValue]) => [
			key,
			isSensitiveFixtureKey(key) ? REDACTED_FIXTURE_VALUE : sanitizeFixture(entryValue),
		]),
	);
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
				isSensitiveFixtureKey(decoded) ||
				isSensitivePathKey(previous) ||
				isSensitiveFixtureValue(decoded)
			) {
				return REDACTED_FIXTURE_VALUE;
			}
			return segment;
		})
		.join("/");
}

function isSensitivePathKey(value: string): boolean {
	return /^(?:authorization|auth(?:entication)?|bearer|cookie|credential|password|passwd|private[-_]?key|secret|session(?:[-_]?id)?|token|(?:api|client|service|access|consumer)[-_]?key)$/i.test(
		value,
	);
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

/** Scrubs common secret forms from an error/cause message before it is printed. */
export function sanitizeDiagnosticText(value: string): string {
	return value
		.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrlForLogs(url))
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED_FIXTURE_VALUE}`)
		.replace(
			/((?:authorization|cookie|credential|password|passwd|secret|token|api[-_]?key|client[-_]?secret)\s*[:=]\s*)([^\s,;]+)/gi,
			`$1${REDACTED_FIXTURE_VALUE}`,
		)
		.replace(/[A-Za-z0-9_+/=.:~-]{24,}/g, (candidate) =>
			isSensitiveFixtureValue(candidate) ? REDACTED_FIXTURE_VALUE : candidate,
		);
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
