// Mirrors packages/provider-observability in the platform monorepo (SoT).
export const PROVIDER_OBSERVABILITY_TAXONOMY_VERSION = "2026-10-23";

export const PROVIDER_ERROR_CATEGORIES = [
	"ok",
	"timeout",
	// The stateful-forwarding deadline (the `deadlineAt` a source pod forwards
	// to the session owner pod) expired while the owner pod was running the
	// operation. An APIFuse-side routing budget, not an upstream latency
	// verdict: the provider SDK serves it as 504
	// STATEFUL_FORWARDING_DEADLINE_EXPIRED, source `apifuse`, retryable false.
	// Added in 2026-10-23; a 2026-08-07 fleet reports the same event as
	// `timeout` (provider-sdk #392) or, before that, `upstream_http`.
	"stateful_forwarding_deadline",
	"network",
	"upstream_http",
	"upstream_rate_limited",
	"upstream_auth",
	"upstream_rejected",
	"upstream_schema_drift",
	"proxy_pool",
	"anti_bot_blocked",
	"credential_expired",
	"credential_unavailable",
	"input_validation",
	"output_validation",
	"provider_error",
	"internal_error",
	"dependency_unavailable",
	"unsupported_transport",
	"client_cancelled",
	"unclassified",
] as const;

export type ProviderErrorCategory = (typeof PROVIDER_ERROR_CATEGORIES)[number];

export function categoryForStatus(status: number): ProviderErrorCategory {
	if (status >= 200 && status < 400) return "ok";
	if (status === 408 || status === 504) return "timeout";
	if (status === 429) return "upstream_rate_limited";
	if (status === 401 || status === 403) return "upstream_auth";
	// provider-error-contract: 409/410/422 are the deterministic
	// upstream-rejection status class — not a retryable upstream failure.
	if (status === 409 || status === 410 || status === 422) return "upstream_rejected";
	if (status >= 400) return "upstream_http";
	return "unclassified";
}

export function isRetryableCategory(category: ProviderErrorCategory): boolean {
	return (
		category === "timeout" ||
		category === "network" ||
		category === "upstream_rate_limited" ||
		category === "upstream_http" ||
		category === "proxy_pool"
	);
}

// Who stopped the request (honest-provider-error-contract). A deliberately
// small public projection of the internal taxonomy:
// - client: the request itself is fixable by the caller
// - upstream_rule: the upstream service refused it under its own business
//   rules (deterministic) or rate limits
// - upstream_failure: the upstream service malfunctioned — retryable
// - apifuse: an APIFuse-side fault (provider bug, platform dependency)
export const PROVIDER_ERROR_SOURCES = [
	"client",
	"upstream_rule",
	"upstream_failure",
	"apifuse",
] as const;

export type ProviderErrorSource = (typeof PROVIDER_ERROR_SOURCES)[number];

// The one category -> source mapping. `sourceForCategory` reads it at
// runtime and `ProviderErrorCategoryOfSource` reads it at the type level, so
// a declaration that names a category can be refused by the compiler on the
// source it would be served with.
export const PROVIDER_ERROR_CATEGORY_SOURCES = {
	// ok never reaches error serialization.
	ok: "apifuse",
	timeout: "upstream_failure",
	stateful_forwarding_deadline: "apifuse",
	network: "upstream_failure",
	upstream_http: "upstream_failure",
	upstream_rate_limited: "upstream_rule",
	upstream_auth: "upstream_failure",
	upstream_rejected: "upstream_rule",
	upstream_schema_drift: "upstream_failure",
	proxy_pool: "apifuse",
	anti_bot_blocked: "upstream_failure",
	credential_expired: "client",
	credential_unavailable: "client",
	input_validation: "client",
	output_validation: "apifuse",
	provider_error: "apifuse",
	internal_error: "apifuse",
	dependency_unavailable: "apifuse",
	unsupported_transport: "apifuse",
	client_cancelled: "client",
	unclassified: "apifuse",
} as const satisfies Record<ProviderErrorCategory, ProviderErrorSource>;

/** The categories served with `TSource`, read from {@link PROVIDER_ERROR_CATEGORY_SOURCES}. */
export type ProviderErrorCategoryOfSource<TSource extends ProviderErrorSource> = {
	[K in ProviderErrorCategory]: (typeof PROVIDER_ERROR_CATEGORY_SOURCES)[K] extends TSource
		? K
		: never;
}[ProviderErrorCategory];

export function sourceForCategory(category: ProviderErrorCategory): ProviderErrorSource {
	return PROVIDER_ERROR_CATEGORY_SOURCES[category];
}
