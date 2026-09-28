import type { ProxyUserAgentSource } from "../config/loader.js";
import type { ProviderChallengeKind, ProviderResolverVendor } from "../types.js";
import type { ResolverTelemetryPhase } from "./resolver-telemetry.js";
import type {
	ResolverPaidUsageBilling,
	ResolverPaidUsageEndpoint,
	ResolverPaidUsageOutcome,
} from "./resolver-usage.js";
import type {
	ResolverChallengeVerdictReason,
	ResolverVendorUnavailableReason,
} from "./resolver-vendors/types.js";

// Type-only imports: the diagnostic redactor reads this table, so it must not pull the resolver
// runtime (or anything that imports the redactor) into module evaluation.

/** Every member of a closed string union, as runtime values; a missing or extra member fails tsc. */
function closedEnumValues<TUnion extends string>() {
	return <const TValues extends readonly TUnion[]>(
		values: TValues,
		..._missing: Exclude<TUnion, TValues[number]> extends never
			? []
			: ["Missing closed-enum values", Exclude<TUnion, TValues[number]>]
	): TValues => values;
}

const RESOLVER_PAID_USAGE_OUTCOMES = closedEnumValues<ResolverPaidUsageOutcome>()([
	"success",
	"vendor_error",
	"timeout",
	"abandoned",
]);
// `resolver.cache.invalidate` outcomes. The union stays private to resolver.ts; its producer's
// `resolverSpanAttributes` call fails to compile if it can emit an outcome missing here.
const RESOLVER_CACHE_INVALIDATION_OUTCOMES = [
	"cache_disabled",
	"entry_deleted",
	"index_entry_deleted",
	"not_cookie_solution",
	"solution_not_cached",
] as const;

/**
 * Closed-enum span attributes emitted by the resolver, by attribute key. A value listed here is an
 * SDK-declared literal, so fail-closed diagnostic redaction keeps it the way it keeps a typed
 * number; any other value under the same key is still free text. Registered credentials are
 * matched either way.
 */
export const RESOLVER_CLOSED_ENUM_SPAN_ATTRIBUTES = {
	vendor: closedEnumValues<ProviderResolverVendor>()([
		"browser",
		"capsolver",
		"capmonster",
		"2captcha",
		"hypersolutions",
		"custom",
	]),
	challenge_kind: closedEnumValues<ProviderChallengeKind>()([
		"turnstile",
		"recaptcha_v2",
		"recaptcha_v3",
		"hcaptcha",
		"cloudflare_interstitial",
		"aws_waf",
		"akamai_sec_cpt",
		"akamai_sensor",
		"akamai_sbsd",
	]),
	endpoint: closedEnumValues<ResolverPaidUsageEndpoint>()([
		"capsolver:create_task",
		"twocaptcha:create_task",
		"hyper:ip",
		"hyper:sbsd_create",
	]),
	billing: closedEnumValues<ResolverPaidUsageBilling>()(["metered", "unconfirmed"]),
	outcome: [...RESOLVER_PAID_USAGE_OUTCOMES, ...RESOLVER_CACHE_INVALIDATION_OUTCOMES],
	unavailability_reason: closedEnumValues<ResolverVendorUnavailableReason>()([
		"missing_credentials",
		"missing_proxy_identity",
		"missing_client_profile",
		"missing_challenge_input",
		"missing_transport",
		"allocation_exhausted",
		"transport_failure",
		"timeout",
		"not_implemented",
	]),
	verdict_reason: closedEnumValues<ResolverChallengeVerdictReason>()([
		"human_puzzle",
		"solve_failed",
	]),
	transport_phase: closedEnumValues<ResolverTelemetryPhase>()([
		"create_task",
		"poll_result",
		"cleanup",
		"measure_ip",
		"fetch_script",
		"generate_payload",
		"post_payload",
	]),
	resolver_identity_source: closedEnumValues<ProxyUserAgentSource>()(["declared", "defaulted"]),
	operation: closedEnumValues<"client.close" | "context.close">()([
		"client.close",
		"context.close",
	]),
} as const;

type ResolverClosedEnumSpanAttributes = typeof RESOLVER_CLOSED_ENUM_SPAN_ATTRIBUTES;
type Present<T> = Exclude<T, undefined>;
/** Properties typed as a finite union of string literals, never plain `string`. */
type FiniteStringKeys<T> = {
	[K in keyof T]-?: [Present<T[K]>] extends [never]
		? never
		: [Present<T[K]>] extends [string]
			? string extends Present<T[K]>
				? never
				: K
			: never;
}[keyof T];
type DeclaredClosedEnumAttributes<T> = {
	[K in keyof T]: K extends FiniteStringKeys<T>
		? K extends keyof ResolverClosedEnumSpanAttributes
			? [Present<T[K]>] extends [ResolverClosedEnumSpanAttributes[K][number]]
				? T[K]
				: never
			: never
		: T[K];
};

/**
 * Resolver span attributes. Every property typed as a finite string union must be declared in
 * `RESOLVER_CLOSED_ENUM_SPAN_ATTRIBUTES` with all of its members, so a new closed-enum attribute
 * cannot silently become free text that fail-closed redaction suppresses.
 */
export function resolverSpanAttributes<const T extends Record<string, unknown>>(
	attributes: T & DeclaredClosedEnumAttributes<T>,
): T {
	return attributes;
}
