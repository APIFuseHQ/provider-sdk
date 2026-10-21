/**
 * Health-monitor upstream capture at the operation route (ADR-0013).
 *
 * The Gateway builds a capture directive only for an authenticated health-monitor
 * request that asked for capture, and carries it in the engine-owned envelope
 * field `engine.capture`. The server consumes the field before execution: it is
 * never projected into `ctx`, `ctx.env`, `ctx.request`, or `input`, so provider
 * code can neither read nor forge it. A directive that fails any acceptance rule
 * leaves the request exactly as if the field were absent.
 *
 * For an accepted directive the server records the last upstream exchange the
 * handler completed through `ctx.http` or `ctx.stealth`, and attaches
 * `engine: { capture }` to the JSON operation response on the success and the
 * error path alike. The outcome carries masked evidence (`buildCaptureEvidence`)
 * or a skip reason, never the raw body.
 */
import {
	buildCaptureEvidence,
	type CaptureEvidence,
	type UpstreamCaptureSource,
} from "../capture-evidence.js";
import type { JsonValue } from "../contract-json.js";
import type { DiagnosticRedactor } from "../runtime/diagnostic-redactor.js";
import {
	CAPTURE_UPSTREAM_BODY_MAX_BYTES,
	UpstreamCaptureRecorder,
} from "../runtime/upstream-capture-recorder.js";

export { CAPTURE_UPSTREAM_BODY_MAX_BYTES };

/** The only directive and outcome version this SDK understands. */
export const CAPTURE_DIRECTIVE_VERSION = 1 as const;
/** Largest `expiresAt - now` a directive may carry (the Gateway's operation deadline bound). */
export const CAPTURE_DIRECTIVE_MAX_TTL_MS = 120_000;
/** Clock skew between Gateway and provider pod tolerated on top of the TTL bound. */
export const CAPTURE_DIRECTIVE_CLOCK_SKEW_MS = 5_000;
/** Serialized evidence size, in UTF-8 bytes, above which the outcome is `evidence_too_large`. */
export const CAPTURE_EVIDENCE_MAX_BYTES = 524_288;

/** Why an accepted directive produced no evidence. */
export const CAPTURE_SKIP_REASONS = [
	"no_upstream_exchange",
	"upstream_sensitive_paths_undeclared",
	"upstream_body_too_large",
	"evidence_too_large",
] as const;
export type CaptureSkipReason = (typeof CAPTURE_SKIP_REASONS)[number];

/**
 * Why a present `engine.capture` left capture inactive. Operator log only: the
 * response is the one the request would get without the field. The last two
 * apply after acceptance: a raw `Response` result whose body is not a JSON
 * object, and an evidence build that threw.
 */
export const CAPTURE_DIRECTIVE_INACTIVE_REASONS = [
	"malformed",
	"unsupported_version",
	"provider_mismatch",
	"operation_mismatch",
	"request_id_mismatch",
	"nonce_malformed",
	"expires_at_malformed",
	"expired",
	"expires_too_far",
	"nonce_replayed",
	"nonce_ledger_full",
	"unknown_operation",
	"streaming_transport",
	"non_json_response",
	"evidence_build_failed",
] as const;
export type CaptureDirectiveInactiveReason = (typeof CAPTURE_DIRECTIVE_INACTIVE_REASONS)[number];

/** `engine.capture` on the operation request envelope, built only by the Gateway. */
export interface CaptureDirective {
	readonly version: typeof CAPTURE_DIRECTIVE_VERSION;
	/** 32 lowercase hex characters (128 random bits), fresh for every provider dispatch. */
	readonly nonce: string;
	readonly providerId: string;
	readonly operationId: string;
	/** Equals the envelope `requestId`. */
	readonly requestId: string;
	/** RFC 3339 UTC with milliseconds, for example `2026-10-21T09:00:00.000Z`. */
	readonly expiresAt: string;
}

/** `engine.capture` on the JSON operation response of an accepted directive. */
export type OperationCaptureOutcome =
	| {
			readonly version: typeof CAPTURE_DIRECTIVE_VERSION;
			readonly outcome: "captured";
			readonly evidence: CaptureEvidence;
	  }
	| {
			readonly version: typeof CAPTURE_DIRECTIVE_VERSION;
			readonly outcome: "skipped";
			readonly reason: CaptureSkipReason;
	  };

/** Top-level `engine` key of a JSON operation response (`{ data, meta?, engine }`, `{ error, engine }`). */
export interface OperationEngineResponse {
	readonly capture: OperationCaptureOutcome;
}

export type { CaptureEvidence } from "../capture-evidence.js";

const CAPTURE_NONCE = /^[0-9a-f]{32}$/;
const RFC3339_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Same bound as the stateful forwarding replay cache's default. */
const CAPTURE_NONCE_LEDGER_MAX_ENTRIES = 10_000;

/**
 * Nonces this process accepted, each kept until its directive's `expiresAt`.
 * A full ledger refuses new nonces instead of evicting live ones, so an accepted
 * nonce can never be accepted again while its directive is still valid.
 */
export class CaptureNonceLedger {
	readonly #entries = new Map<string, number>();
	readonly #maxEntries: number;

	constructor(maxEntries: number = CAPTURE_NONCE_LEDGER_MAX_ENTRIES) {
		if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
			throw new RangeError("maxEntries must be a positive integer");
		}
		this.#maxEntries = maxEntries;
	}

	get size(): number {
		return this.#entries.size;
	}

	claim(nonce: string, expiresAtMs: number, nowMs: number): "accepted" | "replayed" | "full" {
		for (const [entry, expiry] of this.#entries) {
			if (expiry <= nowMs) this.#entries.delete(entry);
		}
		if (this.#entries.has(nonce)) return "replayed";
		if (this.#entries.size >= this.#maxEntries) return "full";
		this.#entries.set(nonce, expiresAtMs);
		return "accepted";
	}
}

const processNonceLedger = new CaptureNonceLedger();

export type CaptureDirectiveDecision =
	| { readonly active: true }
	| { readonly active: false; readonly reason: CaptureDirectiveInactiveReason };

/**
 * Applies the acceptance rules in order; only a directive that passes every rule
 * claims its nonce, so a rejected directive never consumes one.
 */
export function evaluateCaptureDirective(input: {
	readonly directive: unknown;
	readonly providerId: string;
	readonly operationId: string;
	readonly requestId: string;
	readonly nowMs: number;
	readonly ledger?: CaptureNonceLedger;
}): CaptureDirectiveDecision {
	const inactive = (reason: CaptureDirectiveInactiveReason): CaptureDirectiveDecision => ({
		active: false,
		reason,
	});
	const directive = readDirective(input.directive);
	if (directive === undefined) return inactive("malformed");
	if (directive.version !== CAPTURE_DIRECTIVE_VERSION) return inactive("unsupported_version");
	if (directive.providerId !== input.providerId) return inactive("provider_mismatch");
	if (directive.operationId !== input.operationId) return inactive("operation_mismatch");
	if (directive.requestId !== input.requestId) return inactive("request_id_mismatch");
	if (!CAPTURE_NONCE.test(directive.nonce)) return inactive("nonce_malformed");
	const expiresAtMs = RFC3339_UTC_MILLIS.test(directive.expiresAt)
		? Date.parse(directive.expiresAt)
		: Number.NaN;
	if (!Number.isFinite(expiresAtMs)) return inactive("expires_at_malformed");
	if (expiresAtMs <= input.nowMs) return inactive("expired");
	if (expiresAtMs > input.nowMs + CAPTURE_DIRECTIVE_MAX_TTL_MS + CAPTURE_DIRECTIVE_CLOCK_SKEW_MS) {
		return inactive("expires_too_far");
	}
	const claim = (input.ledger ?? processNonceLedger).claim(
		directive.nonce,
		expiresAtMs,
		input.nowMs,
	);
	if (claim === "replayed") return inactive("nonce_replayed");
	if (claim === "full") return inactive("nonce_ledger_full");
	return { active: true };
}

type DirectiveFields = {
	readonly version: unknown;
	readonly nonce: string;
	readonly providerId: string;
	readonly operationId: string;
	readonly requestId: string;
	readonly expiresAt: string;
};

function readDirective(value: unknown): DirectiveFields | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const field = (key: string): unknown =>
		Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
	const strings = ["nonce", "providerId", "operationId", "requestId", "expiresAt"].map(field);
	if (!strings.every((entry): entry is string => typeof entry === "string")) return undefined;
	const [nonce, providerId, operationId, requestId, expiresAt] = strings as string[];
	return {
		version: field("version"),
		nonce: nonce as string,
		providerId: providerId as string,
		operationId: operationId as string,
		requestId: requestId as string,
		expiresAt: expiresAt as string,
	};
}

/**
 * State of one capture-active request. `recorder` is absent when the operation
 * does not declare upstream sensitive paths: nothing is buffered for it.
 */
export interface OperationCaptureSession {
	readonly recorder?: UpstreamCaptureRecorder;
	/** Built once, on first use, after the handler settled. */
	outcome(): OperationCaptureOutcome;
}

export function openOperationCaptureSession(input: {
	readonly sensitiveUpstreamPaths: readonly string[] | undefined;
	readonly sensitiveOutputPaths: readonly string[] | undefined;
	readonly redact: DiagnosticRedactor;
}): OperationCaptureSession {
	const upstreamPaths = input.sensitiveUpstreamPaths;
	const recorder = upstreamPaths === undefined ? undefined : new UpstreamCaptureRecorder();
	let built: OperationCaptureOutcome | undefined;
	return {
		...(recorder ? { recorder } : {}),
		outcome() {
			built ??=
				recorder === undefined || upstreamPaths === undefined
					? skipped("upstream_sensitive_paths_undeclared")
					: captureOutcome(recorder, upstreamPaths, input.sensitiveOutputPaths, input.redact);
			return built;
		},
	};
}

function captureOutcome(
	recorder: UpstreamCaptureRecorder,
	upstreamPaths: readonly string[],
	outputPaths: readonly string[] | undefined,
	redact: DiagnosticRedactor,
): OperationCaptureOutcome {
	const exchange = recorder.last;
	if (exchange === undefined) return skipped("no_upstream_exchange");
	if (exchange.kind === "too_large") return skipped("upstream_body_too_large");
	const source: UpstreamCaptureSource = {
		url: exchange.path,
		status: exchange.status,
		...(exchange.contentType === undefined ? {} : { contentType: exchange.contentType }),
		body: parsedBody(exchange.bodyText),
	};
	const evidence = buildCaptureEvidence(source, {
		sensitiveUpstreamPaths: upstreamPaths,
		...(outputPaths === undefined ? {} : { sensitiveOutputPaths: outputPaths }),
		redactKnownSecrets: redact,
	});
	if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > CAPTURE_EVIDENCE_MAX_BYTES) {
		return skipped("evidence_too_large");
	}
	return { version: CAPTURE_DIRECTIVE_VERSION, outcome: "captured", evidence };
}

function skipped(reason: CaptureSkipReason): OperationCaptureOutcome {
	return { version: CAPTURE_DIRECTIVE_VERSION, outcome: "skipped", reason };
}

/** The raw body parsed as JSON when it parses, else the string itself. */
function parsedBody(text: string): JsonValue {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		return text;
	}
}

/** `JSON.parse` output is a JSON object exactly when it is a non-null, non-array object. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
