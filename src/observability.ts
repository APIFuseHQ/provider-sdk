// Mirrors packages/provider-observability in the platform monorepo (SoT).
export const PROVIDER_OBSERVABILITY_TAXONOMY_VERSION = "2026-08-07";

export const PROVIDER_ERROR_CATEGORIES = [
	"ok",
	"timeout",
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

export function sourceForCategory(category: ProviderErrorCategory): ProviderErrorSource {
	switch (category) {
		case "input_validation":
		case "credential_expired":
		case "credential_unavailable":
		case "client_cancelled":
			return "client";
		case "upstream_rejected":
		case "upstream_rate_limited":
			return "upstream_rule";
		case "timeout":
		case "network":
		case "upstream_http":
		case "upstream_auth":
		case "upstream_schema_drift":
		case "anti_bot_blocked":
			return "upstream_failure";
		default:
			// ok never reaches error serialization; provider_error,
			// internal_error, output_validation, proxy_pool,
			// dependency_unavailable, unsupported_transport, unclassified are
			// APIFuse-side faults.
			return "apifuse";
	}
}
