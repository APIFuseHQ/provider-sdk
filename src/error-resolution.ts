import type { ProviderErrorCategory } from "./observability.js";
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

/** One registered upstream code: the status the SDK serves and who failed. */
export type SdkUpstreamErrorCodeRegistration = {
	readonly status: ProviderErrorStatus;
	readonly category: ProviderErrorCategory;
};

// Registered codes that name an upstream outcome. A row states the status the
// SDK serves and the observability category together, so an upstream code
// cannot be registered without saying who failed. Serve reads the category
// for a `ProviderError` that carries one of these codes and no explicit
// `category`, and the public `source` follows from it (`sourceForCategory`).
// Without a row the category defaults to `provider_error` → `source:
// "apifuse"`, and the health monitor cannot tie a real upstream failure to the
// upstream: it publishes `monitoring_unavailable` instead of `down`.
//
// The category is `categoryForStatus(status)` unless the code names a
// narrower class than its status can: a schema change, a bot wall, an
// upstream refusal of the platform-managed key (served 400, see below).
// Every row is a code the fleet throws for something the upstream did or
// said; caller-side and SDK-internal codes stay in the table below.
export const SDK_UPSTREAM_ERROR_CODE_REGISTRY: ReadonlyMap<
	string,
	SdkUpstreamErrorCodeRegistration
> = new Map<string, SdkUpstreamErrorCodeRegistration>([
	// The SDK's own unknown-operation and unknown-route throws reuse the
	// not-found spellings; they set an explicit category and stay APIFuse's.
	["NOT_FOUND", { status: 404, category: "upstream_http" }],
	["not_found", { status: 404, category: "upstream_http" }],
	["NO_DATA", { status: 404, category: "upstream_http" }],
	["RATE_LIMITED", { status: 429, category: "upstream_rate_limited" }],
	["UPSTREAM_RATE_LIMIT", { status: 429, category: "upstream_rate_limited" }],
	[
		"LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR",
		{ status: 429, category: "upstream_rate_limited" },
	],
	// Deterministic upstream business refusal (honest-provider-error-
	// contract): the upstream evaluated the request and said no under its
	// own rules — a conflict with upstream state, never a 5xx.
	["UPSTREAM_REJECTED", { status: 409, category: "upstream_rejected" }],
	["UPSTREAM_ERROR", { status: 502, category: "upstream_http" }],
	// The upstream's bot wall or request protection refused the request. The
	// status says only "upstream"; the code says which kind.
	["BLOCKED", { status: 502, category: "anti_bot_blocked" }],
	// Fleet-consensus provider codes. These are thrown by provider code, not
	// by the SDK, so they are registered here (status mapping) and not in
	// SDK_RUNTIME_OWNED_ERROR_CODES: an operation-declared status still wins,
	// exactly as it does for UPSTREAM_ERROR and BLOCKED above. Registering
	// them stops the fleet from re-declaring the same rows on every
	// operation, and stops an undeclared throw from being served as 500.
	//
	// A platform-managed upstream service key the upstream refuses. With
	// `auth.mode: "platform-managed"` the caller holds no credential, so 401
	// ("re-authenticate") tells the caller to do something it cannot do, and
	// 502 ("upstream is sick") promises a recovery that will never come. It is
	// a deployment/config defect — the same class as MISSING_SECRET below,
	// which is already an explicit 400 for that reason. The upstream is still
	// the one refusing, so the category is `upstream_auth`; the gateway
	// records it as `provider_error` for every non-`required` connection mode
	// so the refusal stays provider-alertable.
	["UPSTREAM_AUTH_ERROR", { status: 400, category: "upstream_auth" }],
	// The upstream changed its response shape and the provider cannot
	// normalize it. 502 because the fault is upstream of us, non-retryable
	// because a retry returns the same broken payload.
	["UPSTREAM_SCHEMA_ERROR", { status: 502, category: "upstream_schema_drift" }],
]);

/**
 * The category a registered upstream code carries when its `ProviderError`
 * sets none. `undefined` for every other code, which keeps its existing
 * default.
 */
export function registeredUpstreamErrorCategory(
	code: string | undefined,
): ProviderErrorCategory | undefined {
	return code === undefined ? undefined : SDK_UPSTREAM_ERROR_CODE_REGISTRY.get(code)?.category;
}

// Canonical SDK status mapping for recognized provider-thrown error codes.
// serve.ts toStatusCode consults this map (after operation-declared overrides
// for non-SDK-owned codes), and the authoring lint treats these codes as
// SDK-registered. Add new codes here instead of duplicating literals in
// either consumer — an upstream-attributed code goes in
// SDK_UPSTREAM_ERROR_CODE_REGISTRY above, which feeds this map.
export const SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES: ReadonlyMap<string, ProviderErrorStatus> =
	new Map<string, ProviderErrorStatus>([
		["AUTH_REQUIRED", 401],
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
		// Caller-side bad input rejected by the provider (fleet consensus, like
		// UPSTREAM_AUTH_ERROR and UPSTREAM_SCHEMA_ERROR above). The minority
		// spellings (INVALID_INPUT / VALIDATION_ERROR / BAD_REQUEST) are
		// deliberately not registered: they migrate to this spelling on the
		// contract track, and registering them here would freeze the divergence.
		["INVALID_REQUEST", 400],
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
			SDK_UPSTREAM_ERROR_CODE_REGISTRY,
			([code, registration]) => [code, registration.status] as const,
		),
	]);

// Canonical retryability for the fleet-consensus codes registered above.
//
// Runtime retryability still resolves as `instance option ?? declared ??
// false`, so this map changes no served response: an undeclared throw already
// defaults to false, which is what every entry here says. It exists so the
// authoring lint can tell a provider that its declared `retryable` contradicts
// the registered meaning of the code, instead of the fleet quietly shipping two
// answers for the same code. Only codes whose retryability was fixed as part of
// registration belong here — do not backfill opinions the SDK never made.
export const SDK_CANONICAL_ERROR_CODE_RETRYABILITY: ReadonlyMap<string, boolean> = new Map<
	string,
	boolean
>([
	["UPSTREAM_AUTH_ERROR", false],
	["UPSTREAM_SCHEMA_ERROR", false],
	["INVALID_REQUEST", false],
]);
