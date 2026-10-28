import type { ProviderErrorCategory, ProviderFailureCategory } from "./observability.js";
import type { ProviderErrorStatus } from "./types.js";

// This set suppresses the unregistered-provider-error-code signal for codes
// intentionally emitted by SDK paths. It is not the complete authority for
// runtime error resolution: branded errors and additional canonical SDK codes
// must also remain immune to provider-declared status/retryability overrides.
export const SDK_OWNED_PROVIDER_ERROR_CODES = new Set([
	"MISSING_SECRET",
	"AUTH_PROMPT_UNAVAILABLE",
	"BROWSER_CDP_POOL_REQUIRED",
	"BROWSER_RUNTIME_UNSUPPORTED",
	"STEALTH_RUNTIME_UNSUPPORTED",
	"STEALTH_HEADER_OVERRIDE_UNSUPPORTED",
	"SSE_EVENT_UNDECLARED",
	"STREAM_EVENT_TOO_LARGE",
	"STREAM_CHUNK_TOO_LARGE",
	"SSE_RESULT_UNSUPPORTED",
	"STREAM_RESULT_UNSUPPORTED",
	"AUTH_FLOW_NOT_CONFIGURED",
	"refresh_not_supported",
	"RUNTIME_UNSUPPORTED",
	"PROVIDER_STATE_UNSUPPORTED",
	// Engine attachment (ADR-0011). Registered here so an engine failure is served
	// as a known SDK code instead of raising a false
	// `unregistered_provider_error_code` signal on a 500.
	"PROVIDER_ENGINE_AUTHENTICATION_FAILED",
	"PROVIDER_ENGINE_PROTOCOL_VERSION_MISMATCH",
	"PROVIDER_ENGINE_UNAVAILABLE",
	"PROVIDER_ENGINE_MODE_UNSUPPORTED",
	"PROVIDER_EGRESS_DENIED",
	"HANDLE_INVALID",
	"HANDLE_NOT_FOUND",
	"HANDLE_EXPIRED",
	"HANDLE_KIND_MISMATCH",
	"HANDLE_BUSY",
	"HANDLE_COMMITTED",
	"HANDLE_CONNECTION_REQUIRED",
	"HANDLE_STORAGE_UNAVAILABLE",
	"HANDLE_TOO_LARGE",
	"HANDLE_INVALID_DATA",
	"PICK_NOT_OFFERED",
	"unsupported_stealth_cookie_store_version",
	"provider_secret_error",
	"credential_key_error",
	"credential_mode_error",
	"flow_expired",
	"turn_validation_error",
	"context_access_error",
	"OCR_UPSTREAM_FAILED",
	"UNSUPPORTED_STT_OPTION",
	"INVALID_STT_AUDIO",
	"STT_AUDIO_TOO_LARGE",
	"STT_UPSTREAM_FAILED",
	"INVALID_STT_VERIFICATION_CODE_OPTIONS",
	"NO_CODE_FOUND",
	"AMBIGUOUS_CODE",
	"retry_invalid_policy",
	"retry_unsafe_method",
	"stealth_cookie_store_serialize_failed",
	"response_too_large",
	"transport_stream_unavailable",
	"transport_invalid_method",
	"http_transport_override_unsupported",
	"http_redirect_policy_invalid",
	"http_redirect_stopped",
	"http_redirect_max_hops",
	"http_redirect_missing_location",
	"http_redirect_loop",
	"transport_invalid_url",
	"http_header_factory_failed",
	"EGRESS_LEASE_INVALID",
	"EGRESS_LEASE_BINDING_INVALID",
	"EGRESS_LEASE_KEY_MISSING",
	"EGRESS_LEASE_KEY_WEAK",
	"STEALTH_BODY_UNSUPPORTED",
	"REPLAY_SESSION_MISMATCH",
	"REPLAY_ALREADY_ATTEMPTED",
	"retry_exhausted",
	"auth_abort_unsafe_data",
	"credentials_auth_missing_credential_keys",
	"credentials_auth_missing_credential",
	"credentials_auth_invalid_login_result",
	"credentials_auth_unknown_challenge",
	"credentials_auth_unknown_pending_challenge",
	"STATEFUL_FORWARDING_NOT_CONFIGURED",
	"STATEFUL_FORWARDING_SIGNATURE_MISSING",
	"STATEFUL_FORWARDING_NONCE_INVALID",
	"STATEFUL_FORWARDING_TIMESTAMP_INVALID",
	"STATEFUL_FORWARDING_SIGNATURE_INVALID",
	"STATEFUL_FORWARDING_REPLAY_DETECTED",
	"STATEFUL_FORWARDING_REPLAY_CACHE_FULL",
	"STATEFUL_FORWARDING_ENVELOPE_INVALID",
	"STATEFUL_FORWARDING_PROVIDER_MISMATCH",
	"STATEFUL_FORWARDING_SOURCE_POD_MISMATCH",
	"STATEFUL_FORWARDING_OWNER_FENCE_INVALID",
	"STATEFUL_FORWARDING_REQUEST_FAILED",
	"STATEFUL_FORWARDING_CONTEXT_MISSING",
	"STATEFUL_FORWARDING_CONTEXT_INVALID",
	"STATEFUL_FORWARDING_BAD_RESPONSE",
	"STATEFUL_INTERNAL_EXECUTOR_NOT_CONFIGURED",
	"STATEFUL_FILE_FORWARDING_UNSUPPORTED",
	"STATEFUL_CONTROL_PLANE_OPERATION_AMBIGUOUS",
	"STATEFUL_CONTROL_PLANE_REQUEST_FAILED",
	"STATEFUL_CONTROL_PLANE_HTTP_ERROR",
	"STATEFUL_CONTROL_PLANE_INVALID_RESPONSE",
]);

// Complete code authority for provider-declared runtime resolution. Keep this
// separate from signal suppression: declarations may document these codes, but
// their status and retryability can never override the SDK's canonical result.
export const SDK_RUNTIME_OWNED_ERROR_CODES = new Set([
	...SDK_OWNED_PROVIDER_ERROR_CODES,
	"reauth_required",
	"OCR_UNAVAILABLE",
	"UNSUPPORTED_OCR_BACKEND",
	"STT_UNAVAILABLE",
	"UNSUPPORTED_STT_BACKEND",
	"OUTPUT_VALIDATION_FAILED",
	"NOT_FOUND",
	"not_found",
]);

/**
 * One SDK-registered provider error code: the status the SDK serves, who
 * failed, whether a retry can help, and the prose the contract publishes. The
 * category is a provider failure: serve reads it for an error a provider
 * threw, in place of the `category` the provider did not set.
 */
export type SdkErrorRegistration = {
	readonly status: ProviderErrorStatus;
	readonly category: ProviderFailureCategory;
	readonly retryable: boolean;
	/** Developer-facing English prose published as the contract `errorCodes[].description`. */
	readonly description: string;
};

// The codes provider code throws that the SDK registers. A row is the whole
// contract for its code: status, category, retryability and description, so
// a provider references the row by value (`sdkErrors.UPSTREAM_ERROR` in
// `defineErrors`) instead of restating any of it. Serve reads the row for a
// `ProviderError` carrying the code, and the public `source` follows from the
// category (`sourceForCategory`). Without a row the category defaults to
// `provider_error` → `source: "apifuse"`, and the health monitor cannot tie a
// real upstream failure to the upstream: it publishes `monitoring_unavailable`
// instead of `down`.
//
// The category is `categoryForStatus(status)` unless the code names a
// narrower class than its status can: a schema change, a bot wall, an
// upstream refusal of the platform-managed key (served 400, see below).
// Retryability is the category's (`isRetryableCategory`) unless the row says
// why not. Codes the SDK runtime itself throws stay in the sets above.
export const SDK_ERROR_REGISTRY = {
	// The SDK's own unknown-operation and unknown-route throws reuse the
	// not-found spellings; they set an explicit category and stay APIFuse's.
	// A retry of the same lookup returns the same 404.
	NOT_FOUND: {
		status: 404,
		category: "upstream_http",
		retryable: false,
		description: "The upstream has no record for the requested identifier.",
	},
	not_found: {
		status: 404,
		category: "upstream_http",
		retryable: false,
		description: "The upstream has no record for the requested identifier.",
	},
	NO_DATA: {
		status: 404,
		category: "upstream_http",
		retryable: false,
		description: "The upstream returned no data for the request.",
	},
	RATE_LIMITED: {
		status: 429,
		category: "upstream_rate_limited",
		retryable: true,
		description: "The upstream rate-limited the request; retry after a delay.",
	},
	UPSTREAM_RATE_LIMIT: {
		status: 429,
		category: "upstream_rate_limited",
		retryable: true,
		description: "The upstream rate-limited the request; retry after a delay.",
	},
	LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR: {
		status: 429,
		category: "upstream_rate_limited",
		retryable: true,
		description: "The upstream's request quota for the service key is exhausted; retry later.",
	},
	// Deterministic upstream business refusal (honest-provider-error-
	// contract): the upstream evaluated the request and said no under its
	// own rules — a conflict with upstream state, never a 5xx.
	UPSTREAM_REJECTED: {
		status: 409,
		category: "upstream_rejected",
		retryable: false,
		description: "The upstream refused the request under its own rules.",
	},
	// An upstream HTTP failure the provider cannot classify further. The
	// fleet declares it retryable (upstream_http), so a deterministic
	// upstream failure needs its own non-retryable code.
	UPSTREAM_ERROR: {
		status: 502,
		category: "upstream_http",
		retryable: true,
		description: "The upstream returned an HTTP failure.",
	},
	// The upstream's bot wall or request protection refused the request. The
	// status says only "upstream"; the code says which kind.
	BLOCKED: {
		status: 502,
		category: "anti_bot_blocked",
		retryable: false,
		description: "The upstream blocked the request with bot or request protection.",
	},
	// A platform-managed upstream service key the upstream refuses. With
	// `auth.mode: "platform-managed"` the caller holds no credential, so 401
	// ("re-authenticate") tells the caller to do something it cannot do, and
	// 502 ("upstream is sick") promises a recovery that will never come. It is
	// a deployment/config defect — the same class as MISSING_SECRET, which is
	// already an explicit 400 for that reason. The upstream is still the one
	// refusing, so the category is `upstream_auth`; the gateway records it as
	// `provider_error` for every non-`required` connection mode so the
	// refusal stays provider-alertable.
	UPSTREAM_AUTH_ERROR: {
		status: 400,
		category: "upstream_auth",
		retryable: false,
		description: "The upstream refused the platform-managed credential.",
	},
	// The upstream changed its response shape and the provider cannot
	// normalize it. 502 because the fault is upstream of us, non-retryable
	// because a retry returns the same broken payload.
	UPSTREAM_SCHEMA_ERROR: {
		status: 502,
		category: "upstream_schema_drift",
		retryable: false,
		description: "The upstream response could not be normalized.",
	},
	// Caller-side codes, categorized as the fleet throws them (2026-10-28:
	// AUTH_REQUIRED credential_unavailable 28 of 38 sites, INVALID_REQUEST
	// input_validation 118 of 118). The minority spellings (INVALID_INPUT /
	// VALIDATION_ERROR / BAD_REQUEST) are deliberately not registered: they
	// migrate to INVALID_REQUEST on the contract track, and registering them
	// here would freeze the divergence.
	AUTH_REQUIRED: {
		status: 401,
		category: "credential_unavailable",
		retryable: false,
		description: "The request needs a connected account.",
	},
	INVALID_REQUEST: {
		status: 400,
		category: "input_validation",
		retryable: false,
		description: "The upstream rejected the request input.",
	},
} as const satisfies Record<string, SdkErrorRegistration>;

/** A code `SDK_ERROR_REGISTRY` registers. */
export type SdkErrorCode = keyof typeof SDK_ERROR_REGISTRY;

/** `SDK_ERROR_REGISTRY` as a map, for lookups by an untyped code. */
export const SDK_ERROR_REGISTRY_BY_CODE: ReadonlyMap<string, SdkErrorRegistration> = new Map(
	Object.entries(SDK_ERROR_REGISTRY),
);

/**
 * The registry row for a code, or `undefined` for a code the SDK does not
 * register (a provider-declared or SDK-runtime code).
 */
export function sdkErrorRegistration(code: string | undefined): SdkErrorRegistration | undefined {
	return code === undefined ? undefined : SDK_ERROR_REGISTRY_BY_CODE.get(code);
}

// Canonical SDK status mapping for recognized provider-thrown error codes.
// `resolveProviderErrorContract` reads it for every code the registry above
// does not cover (SDK-runtime codes whose status the SDK fixes). Add new
// codes here instead of duplicating literals in a consumer — a code provider
// code throws goes in SDK_ERROR_REGISTRY above, which feeds this map.
export const SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES: ReadonlyMap<string, ProviderErrorStatus> =
	new Map<string, ProviderErrorStatus>([
		["reauth_required", 401],
		// Unprovisioned declared secret: a deployment/config defect, never an
		// upstream failure — explicit 400.
		["MISSING_SECRET", 400],
		// Only an unverifiable or foreign handle is the caller's: key and binding
		// faults stay unmapped (500) because the engine host, not the caller, owns them.
		["EGRESS_LEASE_INVALID", 409],
		["REPLAY_SESSION_MISMATCH", 409],
		["REPLAY_ALREADY_ATTEMPTED", 409],
		// Handles (ADR-0012): only caller-side faults are mapped. Storage,
		// connection-scope, size, and schema faults stay 500 because the provider
		// or host owns them.
		["HANDLE_INVALID", 400],
		["HANDLE_KIND_MISMATCH", 400],
		["PICK_NOT_OFFERED", 400],
		["HANDLE_NOT_FOUND", 404],
		["HANDLE_EXPIRED", 410],
		["HANDLE_COMMITTED", 409],
		["HANDLE_BUSY", 409],
		["OCR_UNAVAILABLE", 503],
		["UNSUPPORTED_OCR_BACKEND", 503],
		["STT_UNAVAILABLE", 503],
		["UNSUPPORTED_STT_BACKEND", 503],
		["STATEFUL_FORWARDING_REPLAY_CACHE_FULL", 503],
		// The engine is reachable-in-principle but not now: retryable, so the
		// caller may retry once the engine recovers. Authentication, protocol
		// mismatch, an unsupported mode and denied egress stay unmapped (500) and
		// non-retryable: they are deployment or provider faults that no caller
		// retry can clear, and a retryable 5xx there would turn one bad rollout
		// into gateway-driven load.
		["PROVIDER_ENGINE_UNAVAILABLE", 503],
		...Array.from(
			SDK_ERROR_REGISTRY_BY_CODE,
			([code, registration]) => [code, registration.status] as const,
		),
	]);

/**
 * What a declaration says about a code: a `defineErrors` declaration (every
 * field present) or a legacy `errorCodes[]` entry (status and retryable
 * optional, no category).
 */
export type ProviderErrorDeclarationLike = {
	readonly status?: ProviderErrorStatus;
	readonly category?: ProviderErrorCategory;
	readonly retryable?: boolean;
};

/**
 * The deprecated per-throw options a legacy `new ProviderError(message, {
 * category, retryable })` site still carries, read safely by the caller.
 */
export type LegacyProviderErrorOptions = {
	readonly category?: ProviderErrorCategory;
	readonly retryable?: boolean;
};

/** The served status, category and retryability a provider error resolves to. */
export type ProviderErrorContract = {
	/** `undefined` when nothing declares one; the serving branch supplies its default. */
	readonly status: ProviderErrorStatus | undefined;
	/** `undefined` when nothing declares one; the serving branch supplies its default. */
	readonly category: ProviderErrorCategory | undefined;
	/** `undefined` when nothing declares one; the serving branch supplies its default. */
	readonly retryable: boolean | undefined;
};

function isRejectionStatus(status: ProviderErrorStatus | undefined): boolean {
	return status === 409 || status === 410 || status === 422;
}

/**
 * The one place a provider error's status, category and retryability are
 * resolved. Precedence, per field:
 *
 * - `status`: the declaration (a `defineErrors` declaration carried by the
 *   thrown error, or the operation's legacy `errorCodes[]` entry for the
 *   code), then the SDK registry row (`SDK_ERROR_REGISTRY`, then the
 *   status-only map for SDK-runtime codes). A throw site never set a status.
 * - `category` and `retryable`: the deprecated per-throw option first, then
 *   the declaration, then (category only) a declared rejection status
 *   (409/410/422) → `upstream_rejected`, then the SDK registry row.
 *
 * A field nothing answers is `undefined`, and the serving branch (transport,
 * validation, session expiry, plain provider error) applies its own default.
 *
 * The per-throw option keeps winning for the one release it is kept: that is
 * the order the server always had (`instance ?? declared ?? default`), so a
 * provider that bumps the SDK without touching its throw sites serves the
 * same `retryable` as before — a deterministic refusal thrown `retryable:
 * false` under a table row that says `true` stays non-retryable, and the
 * gateway and bori keep reading the verdict they read today. The server logs
 * one warning per code naming both values when they differ; the fix is a
 * distinct code for the other condition, not a per-throw override. A
 * factory-made error (`errors.X(...)`) carries no per-throw option, so for it
 * the declaration is the whole answer.
 */
export function resolveProviderErrorContract(input: {
	readonly code: string | undefined;
	readonly declaration: ProviderErrorDeclarationLike | undefined;
	readonly legacyOptions: LegacyProviderErrorOptions;
}): ProviderErrorContract {
	const { code, declaration, legacyOptions } = input;
	const registration = sdkErrorRegistration(code);
	const status =
		declaration?.status ??
		registration?.status ??
		(code === undefined ? undefined : SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.get(code));
	const category =
		legacyOptions.category ??
		declaration?.category ??
		(isRejectionStatus(declaration?.status) ? "upstream_rejected" : undefined) ??
		registration?.category;
	const retryable = legacyOptions.retryable ?? declaration?.retryable ?? registration?.retryable;
	return { status, category, retryable };
}
