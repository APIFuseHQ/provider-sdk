/**
 * Health-monitor upstream capture evidence (apifuse#2602, ADR-0013).
 *
 * The capture-mode boundary hook buffers the upstream response a handler fetched
 * through SDK-owned clients and, for an authenticated single-use capture
 * directive only, attaches MASKED evidence of it to the operation response —
 * whether the handler returned or failed closed. This module is the pure,
 * boundary-owned masking and shaping core of that evidence; the directive
 * verification and response attachment live in `server/upstream-capture.ts`,
 * the buffering in `runtime/upstream-capture-recorder.ts`.
 *
 * Masking is defense-in-depth, runs entirely inside the provider process, and
 * redacts this set:
 *
 *   0. Declared `observability.sensitive.upstream` paths, in the raw upstream
 *      body coordinates (catchtable my-profile: `data.displayName`). Applied
 *      first. The server emits evidence only for an operation that declares them.
 *   1. Declared `observability.sensitive.output` paths. They are OUTPUT
 *      coordinates: they match only a body shaped like the operation's output,
 *      not a vendor upstream body (catchtable my-profile declares `email` while
 *      the upstream carries `data.email`); the upstream paths above cover that.
 *   2. Reserved secret-like keys (`isReservedSensitiveKey`: phone, otp,
 *      payment_url, token, ...) and credential-named keys
 *      (`isSensitiveFixtureKey`) at any depth, as whole values.
 *   3. The request's registered secret values (request credentials, connection
 *      secrets, runtime-registered values) by exact value, through the request's
 *      `DiagnosticRedactor`, in every string, object key, and number.
 *   4. String heuristics (`sanitizeCaptureEvidenceString`): PEM private keys,
 *      credential header and credential-named assignments, keyless
 *      `Bearer`/`Negotiate`/`NTLM` tokens of any length, keyless `Basic` tokens
 *      that decode to `user-id:password`, known token shapes, opaque runs of 24+
 *      characters that are hex or high-entropy, and URL query values and
 *      fragments (absolute, other-scheme, protocol-relative, and relative).
 *   5. Request provenance reduced to a query-free scrubbed path, and the media
 *      type reduced to a bare `type/subtype`.
 *
 * It CANNOT see, and the evidence may therefore carry:
 *
 *   - short tokens under non-credential key names (`sessionKey`, `sid`,
 *     `PHPSESSID`, `authKey`, `loginKey`) unless the value is a registered
 *     request secret;
 *   - opaque tokens under 24 characters in prose (outside an auth-scheme echo);
 *   - personal data under keys that neither the upstream nor the output paths
 *     declare (see 0 and 1);
 *   - an unregistered secret used as an object key: keys get only registered-value
 *     redaction, because the entropy heuristic would rewrite long field names;
 *   - structure inside non-JSON bodies (HTML, form-encoded, XML): such a body is
 *     one string, so only the string heuristics and registered values apply.
 *
 * Evidence is produced only here (the SDK boundary), never by provider code, and
 * it never carries the handler's auth or connection state.
 */
import type { JsonValue } from "./contract-json.js";
import {
	isSensitiveFixtureKey,
	REDACTED_FIXTURE_VALUE,
	requestPathForFixture,
	sanitizeCaptureEvidenceString,
} from "./fixture-sanitization.js";
import { type DiagnosticRedactor, redactDiagnosticText } from "./runtime/diagnostic-redactor.js";
import { isReservedSensitiveKey } from "./schema.js";

/** Schema version of the emitted evidence; the health-monitor writer pins it. */
export const CAPTURE_EVIDENCE_VERSION = 1 as const;

/** RFC 9110 §8.3.1 `type "/" subtype`, each a `token` (§5.6.2); parameters are never kept. */
const BARE_MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/;

/** The upstream exchange a handler performed, as seen at the SDK boundary. */
export interface UpstreamCaptureSource {
	/** Full upstream request URL; reduced to a query-free scrubbed path in evidence. */
	readonly url: string;
	/** Upstream HTTP status the handler received. */
	readonly status: number;
	/**
	 * Upstream `Content-Type`. Media-type parameters (`charset`, `profile`, `boundary`, ...)
	 * are vendor-controlled and may carry a URL or a token, so evidence keeps only the bare
	 * lowercased `type/subtype` and omits a value that is not one.
	 */
	readonly contentType?: string;
	/** Parsed upstream response body. */
	readonly body: JsonValue;
}

export interface CaptureEvidenceOptions {
	/**
	 * Operation-declared upstream sensitive paths (`observability.sensitive.upstream`),
	 * in the raw upstream body coordinates, with the same grammar as the output paths.
	 * Applied before the output paths and the heuristics.
	 */
	readonly sensitiveUpstreamPaths?: readonly string[];
	/**
	 * Operation-declared output sensitive paths (`observability.sensitive.output`),
	 * dot-separated with `*` matching any array element or object key — e.g.
	 * `items.*.paymentUrl`. Each matching value is redacted before the other masks
	 * run. These are output coordinates and match only a body shaped like the
	 * operation's output, not a vendor upstream body.
	 */
	readonly sensitiveOutputPaths?: readonly string[];
	/**
	 * Exact-value redaction of the request's known secrets: the request's
	 * `DiagnosticRedactor` (static, request credential, connection secret, and
	 * runtime-registered values). Applied to every string, object key, and number
	 * of the evidence. Required so the boundary wiring cannot omit it.
	 */
	readonly redactKnownSecrets: DiagnosticRedactor;
}

/** Masked, boundary-shaped evidence of one upstream exchange. */
export interface CaptureEvidence {
	readonly version: typeof CAPTURE_EVIDENCE_VERSION;
	readonly upstreamStatus: number;
	/** Bare lowercased `type/subtype`; absent when the upstream sent none or an invalid one. */
	readonly upstreamContentType?: string;
	readonly requestPath: string;
	readonly body: JsonValue;
}

/**
 * Builds masked capture evidence for one upstream exchange. Pure for a given
 * redactor: the same input always yields the same evidence. It redacts the set
 * listed in the module doc and does not claim more; the module doc also lists
 * what it cannot see.
 */
export function buildCaptureEvidence(
	source: UpstreamCaptureSource,
	options: CaptureEvidenceOptions,
): CaptureEvidence {
	const redactKnown = (text: string) => redactDiagnosticText(text, options.redactKnownSecrets);
	const declaredMasked = maskSensitivePaths(
		maskSensitivePaths(source.body, options.sensitiveUpstreamPaths ?? []),
		options.sensitiveOutputPaths ?? [],
	);
	const evidence: CaptureEvidence = {
		version: CAPTURE_EVIDENCE_VERSION,
		upstreamStatus: source.status,
		requestPath: redactKnown(requestPathForFixture(source.url)),
		body: maskEvidenceBody(declaredMasked, redactKnown),
	};
	const contentType = bareMediaType(source.contentType);
	if (contentType === undefined || redactKnown(contentType) !== contentType) return evidence;
	return { ...evidence, upstreamContentType: contentType };
}

/** Redacts every value reachable by a declared sensitive path. */
export function maskSensitivePaths(value: JsonValue, paths: readonly string[]): JsonValue {
	return paths.reduce<JsonValue>((current, path) => redactPath(current, splitPath(path)), value);
}

/**
 * Reserved and credential-named keys lose their whole value; every other string
 * is redacted by registered value and then by the capture string heuristics.
 * Keys are redacted by registered value only, so the entropy heuristic never
 * rewrites a long field name.
 */
function maskEvidenceBody(value: JsonValue, redactKnown: (text: string) => string): JsonValue {
	if (typeof value === "string") return sanitizeCaptureEvidenceString(redactKnown(value));
	if (typeof value === "number") {
		const text = String(value);
		return redactKnown(text) === text ? value : REDACTED_FIXTURE_VALUE;
	}
	if (Array.isArray(value)) return value.map((item) => maskEvidenceBody(item, redactKnown));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			redactKnown(key),
			isSensitiveFixtureKey(key) || isReservedSensitiveKey(key)
				? REDACTED_FIXTURE_VALUE
				: maskEvidenceBody(entry, redactKnown),
		]),
	);
}

function bareMediaType(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const bare = (value.split(";", 1)[0] ?? "").replace(/^[ \t]+|[ \t]+$/g, "").toLowerCase();
	return BARE_MEDIA_TYPE.test(bare) ? bare : undefined;
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
