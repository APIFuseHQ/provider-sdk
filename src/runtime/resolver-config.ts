import type { ProviderChallengeKind } from "../types.js";

export const APIFUSE__RESOLVER__2CAPTCHA__API_KEY = "APIFUSE__RESOLVER__2CAPTCHA__API_KEY";
export const APIFUSE__RESOLVER__CAPSOLVER__API_KEY = "APIFUSE__RESOLVER__CAPSOLVER__API_KEY";
export const APIFUSE__RESOLVER__CAPMONSTER__API_KEY = "APIFUSE__RESOLVER__CAPMONSTER__API_KEY";
export const APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY =
	"APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY";
export const APIFUSE__RESOLVER__TIMEOUT_MS = "APIFUSE__RESOLVER__TIMEOUT_MS";
export const APIFUSE__CDP_POOL__URL = "APIFUSE__CDP_POOL__URL";
export const DEFAULT_RESOLVER_TIMEOUT_MS = 180_000;

/**
 * SBSD is solved on the provider's own admitted session, so the transport profile must be
 * declared up front. Other kinds, including `akamai_sensor`, keep the profile optional.
 */
export function kindRequiresClientProfile(kind: ProviderChallengeKind): boolean {
	return kind === "akamai_sbsd";
}
