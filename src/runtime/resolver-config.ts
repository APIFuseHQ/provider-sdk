import type { ProviderChallengeKind } from "../types.js";

export const APIFUSE__RESOLVER__2CAPTCHA__API_KEY = "APIFUSE__RESOLVER__2CAPTCHA__API_KEY";
export const APIFUSE__RESOLVER__CAPSOLVER__API_KEY = "APIFUSE__RESOLVER__CAPSOLVER__API_KEY";
export const APIFUSE__RESOLVER__CAPMONSTER__API_KEY = "APIFUSE__RESOLVER__CAPMONSTER__API_KEY";
export const APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY =
	"APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY";
export const APIFUSE__RESOLVER__TIMEOUT_MS = "APIFUSE__RESOLVER__TIMEOUT_MS";
export const APIFUSE__RESOLVER__VENDOR_COOLDOWN_MS = "APIFUSE__RESOLVER__VENDOR_COOLDOWN_MS";
export const APIFUSE__CDP_POOL__URL = "APIFUSE__CDP_POOL__URL";
/**
 * Per-vendor solve bound. Operations declare `timeoutMs` around 60 s and hub budgets sit
 * below that, so a vendor attempt that outlives 45 s was already cancelled by the caller;
 * a longer bound only kept paying for polls whose result nobody could receive.
 */
export const DEFAULT_RESOLVER_TIMEOUT_MS = 45_000;
/**
 * How long a vendor that reported an exhausted allocation (zero balance) is skipped without
 * a paid call. Ten minutes keeps a topped-up account out of the chain for at most one window.
 */
export const DEFAULT_RESOLVER_VENDOR_COOLDOWN_MS = 600_000;
/**
 * Headroom kept between the resolver's own deadline and the caller's operation deadline, so
 * the provider still has time to apply a solution and answer before the hub gives up.
 */
export const RESOLVER_BUDGET_MARGIN_MS = 5_000;

/**
 * Cache lifetime for token-form solutions of cacheable kinds when the vendor reports no
 * expiry. AWS WAF tokens were measured to live about four days; two hours is a conservative
 * SDK default that still turns repeated solves of one origin into cache hits.
 */
export const RESOLVER_TOKEN_SOLUTION_TTL_MS_BY_KIND = {
	aws_waf: 2 * 60 * 60 * 1_000,
} as const satisfies Partial<Record<ProviderChallengeKind, number>>;

export function resolverTokenSolutionTtlMs(kind: ProviderChallengeKind): number | undefined {
	return Object.hasOwn(RESOLVER_TOKEN_SOLUTION_TTL_MS_BY_KIND, kind)
		? RESOLVER_TOKEN_SOLUTION_TTL_MS_BY_KIND[
				kind as keyof typeof RESOLVER_TOKEN_SOLUTION_TTL_MS_BY_KIND
			]
		: undefined;
}

/**
 * SBSD is solved on the provider's own admitted session, so the transport profile must be
 * declared up front. Other kinds, including `akamai_sensor`, keep the profile optional.
 */
export function kindRequiresClientProfile(kind: ProviderChallengeKind): boolean {
	return kind === "akamai_sbsd";
}
