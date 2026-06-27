export const PROVIDER_OBSERVABILITY_TAXONOMY_VERSION = "2026-05-26";

export const PROVIDER_ERROR_CATEGORIES = [
	"ok",
	"timeout",
	"network",
	"upstream_http",
	"upstream_rate_limited",
	"upstream_auth",
	"upstream_schema_drift",
	"proxy_pool",
	"anti_bot_blocked",
	"credential_expired",
	"credential_unavailable",
	"input_validation",
	"output_validation",
	"provider_error",
	"internal_error",
	"unclassified",
] as const;

export type ProviderErrorCategory = (typeof PROVIDER_ERROR_CATEGORIES)[number];

export function categoryForStatus(status: number): ProviderErrorCategory {
	if (status >= 200 && status < 400) return "ok";
	if (status === 408 || status === 504) return "timeout";
	if (status === 429) return "upstream_rate_limited";
	if (status === 401 || status === 403) return "upstream_auth";
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
