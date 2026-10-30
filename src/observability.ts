// Mirrors packages/provider-observability in the platform monorepo (SoT).
import type { ProviderErrorObservability } from "./errors.js";

export const PROVIDER_OBSERVABILITY_TAXONOMY_VERSION = "2026-10-23";

// Who reported an error category: the platform (this SDK's runtime and the
// Gateway, for faults of their own) or provider code (at a throw site, for the
// way an upstream call failed). The `X-ApiFuse-Error-Observability` header
// carries it as `origin`, so a category word is always read together with who
// reported it.
export type ProviderErrorCategoryOrigin = "platform" | "provider";

// Categories the platform reports for faults of its own. `ok` is the stamp a
// success gets. `credential_unavailable` is also a provider failure (next
// list): the SDK's required-secret gate reports it as a platform fault and a
// provider's own credential check reports it as a provider failure, and the
// origin tells the two apart. Listed in wire order.
export const PLATFORM_FAULT_CATEGORIES = [
	"ok",
	"stateful_forwarding_deadline",
	"proxy_pool",
	"credential_unavailable",
	"output_validation",
	"internal_error",
	"dependency_unavailable",
	"unsupported_transport",
	"client_cancelled",
	"unclassified",
] as const;

// Categories provider code reports for the way an upstream call failed: the
// words `ProviderErrorOptions.category` accepts. Listed in wire order.
export const PROVIDER_FAILURE_CATEGORIES = [
	"timeout",
	"network",
	"upstream_http",
	"upstream_rate_limited",
	"upstream_auth",
	"upstream_rejected",
	"upstream_schema_drift",
	"anti_bot_blocked",
	"credential_expired",
	"credential_unavailable",
	"input_validation",
	"provider_error",
] as const;

export type PlatformFaultCategory = (typeof PLATFORM_FAULT_CATEGORIES)[number];

export type ProviderFailureCategory = (typeof PROVIDER_FAILURE_CATEGORIES)[number];

export type ProviderErrorCategory = PlatformFaultCategory | ProviderFailureCategory;

// Every category of both sets, once, in wire order: the order the SoT, the
// Gateway's Go mirror and the provider_invocation_events CHECK list them.
// Membership is the two sets' (a word in neither does not typecheck here, and
// a word in a set but not here fails the declaration after this list); only
// the order is this list's own.
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
] as const satisfies readonly ProviderErrorCategory[];

// `true` while PROVIDER_ERROR_CATEGORIES lists every member of both sets;
// otherwise the missing word's literal type, which `true` is not.
export const PROVIDER_ERROR_CATEGORIES_LIST_BOTH_SETS: [
	Exclude<ProviderErrorCategory, (typeof PROVIDER_ERROR_CATEGORIES)[number]>,
] extends [never]
	? true
	: Exclude<ProviderErrorCategory, (typeof PROVIDER_ERROR_CATEGORIES)[number]> = true;

const PLATFORM_FAULT_CATEGORY_SET: ReadonlySet<string> = new Set(PLATFORM_FAULT_CATEGORIES);

const PROVIDER_FAILURE_CATEGORY_SET: ReadonlySet<string> = new Set(PROVIDER_FAILURE_CATEGORIES);

export function isPlatformFaultCategory(category: string): category is PlatformFaultCategory {
	return PLATFORM_FAULT_CATEGORY_SET.has(category);
}

export function isProviderFailureCategory(category: string): category is ProviderFailureCategory {
	return PROVIDER_FAILURE_CATEGORY_SET.has(category);
}

/**
 * The `X-ApiFuse-Error-Observability` JSON the server writes beside an error
 * response. The `origin` tag says who reported the category and fixes which
 * set the category comes from: a platform fault the SDK observed itself, or a
 * provider failure the provider's throw site reported. The Gateway removes
 * the header from tenant responses.
 */
export type PlatformFaultObservabilityDetails = {
	origin: "platform";
	category: PlatformFaultCategory;
	taxonomyVersion: string;
	retryable: boolean;
	upstreamStatus?: number;
};

export type ProviderFailureObservabilityDetails = {
	origin: "provider";
	category: ProviderFailureCategory;
	taxonomyVersion: string;
	retryable: boolean;
	upstreamStatus?: number;
	providerObservability?: ProviderErrorObservability;
};

export type ErrorObservabilityDetails =
	| PlatformFaultObservabilityDetails
	| ProviderFailureObservabilityDetails;

/**
 * The header JSON an SDK released before `origin` existed writes: no origin,
 * and a category from the union. A reader of another pod's header (the
 * stateful source pod reading the owner pod's response) accepts this shape
 * beside {@link ErrorObservabilityDetails} while the fleet still runs such
 * SDKs, and stops on the rule the SoT's supported taxonomy versions follow:
 * after the fleet is redeployed past them.
 */
export type LegacyErrorObservabilityDetails = {
	origin?: undefined;
	category: ProviderErrorCategory;
	taxonomyVersion: string;
	retryable: boolean;
	upstreamStatus?: number;
	providerObservability?: ProviderErrorObservability;
};

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

/**
 * The public source of a platform fault. The platform stopped the request,
 * so the source is `apifuse`, except an inbound cancellation, which the
 * caller caused.
 */
export function sourceForPlatformFault(category: PlatformFaultCategory): ProviderErrorSource {
	return category === "client_cancelled" ? "client" : "apifuse";
}

/** The public source of a category a provider reported. */
export function sourceForCategory(category: ProviderErrorCategory): ProviderErrorSource {
	return PROVIDER_ERROR_CATEGORY_SOURCES[category];
}
