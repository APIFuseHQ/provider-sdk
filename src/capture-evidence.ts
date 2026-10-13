/**
 * Health-monitor upstream capture evidence (apifuse#2602, ADR-0013).
 *
 * The capture-mode boundary hook buffers the upstream response a handler fetched
 * through SDK-owned clients and, for an authenticated single-use capture
 * directive only, attaches MASKED evidence of it to the operation response —
 * whether the handler returned or failed closed. This module is the pure,
 * boundary-owned masking and shaping core of that evidence; the directive
 * verification, upstream buffering, and response attachment wiring land in a
 * follow-up PR once apifuse#2602 is accepted and the deploy freeze lifts.
 *
 * Masking is defense-in-depth and runs entirely inside the provider process:
 *
 *   1. The operation's declared output sensitive paths are redacted first, so a
 *      value is removed even when a key name or entropy heuristic would miss it.
 *   2. `sanitizeFixture` then redacts credential-named keys and heuristic-
 *      confirmed string secrets everywhere else.
 *   3. Request provenance is reduced to a query-free, scrubbed path.
 *
 * Credentials, cookies, `Authorization`, tokens, and URL query values never
 * enter the evidence. Evidence is produced only here (the SDK boundary), never
 * by provider code, and it never carries the handler's auth or connection state.
 */
import type { JsonValue } from "./contract-json.js";
import {
	REDACTED_FIXTURE_VALUE,
	requestPathForFixture,
	sanitizeFixture,
} from "./fixture-sanitization.js";

/** Schema version of the emitted evidence; the health-monitor writer pins it. */
export const CAPTURE_EVIDENCE_VERSION = 1 as const;

/** The upstream exchange a handler performed, as seen at the SDK boundary. */
export interface UpstreamCaptureSource {
	/** Full upstream request URL; reduced to a query-free scrubbed path in evidence. */
	readonly url: string;
	/** Upstream HTTP status the handler received. */
	readonly status: number;
	/** Upstream `Content-Type` (a media type, retained; never a secret). */
	readonly contentType?: string;
	/** Parsed upstream response body. */
	readonly body: JsonValue;
}

export interface CaptureEvidenceOptions {
	/**
	 * Operation-declared output sensitive paths (`observability.sensitive.output`),
	 * dot-separated with `*` matching any array element or object key — e.g.
	 * `items.*.paymentUrl`. Each matching value is redacted before the heuristic
	 * sanitizer runs.
	 */
	readonly sensitiveOutputPaths?: readonly string[];
}

/** Masked, boundary-shaped evidence of one upstream exchange. */
export interface CaptureEvidence {
	readonly version: typeof CAPTURE_EVIDENCE_VERSION;
	readonly upstreamStatus: number;
	readonly upstreamContentType?: string;
	readonly requestPath: string;
	readonly body: JsonValue;
}

/**
 * Builds masked capture evidence for one upstream exchange. Pure: the same input
 * always yields the same evidence, and no credential, cookie, token,
 * `Authorization` value, or URL query survives.
 */
export function buildCaptureEvidence(
	source: UpstreamCaptureSource,
	options: CaptureEvidenceOptions = {},
): CaptureEvidence {
	const declaredMasked = maskSensitivePaths(source.body, options.sensitiveOutputPaths ?? []);
	const body = sanitizeFixture(declaredMasked);
	const evidence: CaptureEvidence = {
		version: CAPTURE_EVIDENCE_VERSION,
		upstreamStatus: source.status,
		requestPath: requestPathForFixture(source.url),
		body,
	};
	if (source.contentType === undefined) return evidence;
	return { ...evidence, upstreamContentType: source.contentType };
}

/** Redacts every value reachable by a declared sensitive path. */
export function maskSensitivePaths(value: JsonValue, paths: readonly string[]): JsonValue {
	return paths.reduce<JsonValue>(
		(current, path) => redactPath(current, splitPath(path)),
		value,
	);
}

function splitPath(path: string): readonly string[] {
	return path.split(".").filter((segment) => segment.length > 0);
}

function redactPath(value: JsonValue, segments: readonly string[]): JsonValue {
	if (segments.length === 0) return REDACTED_FIXTURE_VALUE;
	const [head, ...rest] = segments;

	if (Array.isArray(value)) {
		if (head === "*") return value.map((item) => redactPath(item, rest));
		if (/^\d+$/.test(head as string)) {
			const index = Number(head);
			return value.map((item, position) => (position === index ? redactPath(item, rest) : item));
		}
		return value;
	}

	if (value !== null && typeof value === "object") {
		if (head === "*") {
			return Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [key, redactPath(entry, rest)]),
			);
		}
		if (Object.hasOwn(value, head as string)) {
			return Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [
					key,
					key === head ? redactPath(entry, rest) : entry,
				]),
			);
		}
		return value;
	}

	return value;
}
