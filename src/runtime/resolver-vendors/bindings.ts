import type { ProviderChallenge, ProviderChallengeKind } from "../../types.js";
import type { ResolverIssuingIdentity } from "./types.js";

type ResolverChallengeBinding = {
	readonly cacheable: boolean;
	readonly identityBinding: "none" | "identity_scoped" | "portable";
	readonly directCacheable: boolean;
};

// An IP-bound artifact minted without any recorded egress identity is unsafe to
// share. The Akamai kinds therefore reject direct caching, while Cloudflare
// keeps its pre-existing direct-cache behavior pending measurement.
export const RESOLVER_CHALLENGE_BINDINGS = {
	turnstile: { cacheable: false, identityBinding: "none", directCacheable: false },
	recaptcha_v2: { cacheable: false, identityBinding: "none", directCacheable: false },
	recaptcha_v3: { cacheable: false, identityBinding: "none", directCacheable: false },
	hcaptcha: { cacheable: false, identityBinding: "none", directCacheable: false },
	cloudflare_interstitial: {
		cacheable: true,
		identityBinding: "identity_scoped",
		directCacheable: true,
	},
	aws_waf: { cacheable: true, identityBinding: "portable", directCacheable: true },
	akamai_sec_cpt: {
		cacheable: true,
		identityBinding: "identity_scoped",
		directCacheable: false,
	},
	akamai_sensor: {
		cacheable: true,
		identityBinding: "identity_scoped",
		directCacheable: false,
	},
} as const satisfies Readonly<Record<ProviderChallengeKind, ResolverChallengeBinding>>;

export function resolverChallengeIsCacheable(challenge: ProviderChallenge): boolean {
	return RESOLVER_CHALLENGE_BINDINGS[challenge.kind].cacheable;
}

export function resolverChallengeAllowsDirectCache(challenge: ProviderChallenge): boolean {
	return RESOLVER_CHALLENGE_BINDINGS[challenge.kind].directCacheable;
}

export function resolverChallengeIsIdentityScoped(challenge: ProviderChallenge): boolean {
	return RESOLVER_CHALLENGE_BINDINGS[challenge.kind].identityBinding === "identity_scoped";
}

export function resolverChallengeIssuingIdentity(
	challenge: ProviderChallenge,
	identity: ResolverIssuingIdentity,
): ResolverIssuingIdentity {
	if (RESOLVER_CHALLENGE_BINDINGS[challenge.kind].identityBinding === "portable") {
		return { userAgent: identity.userAgent };
	}
	return identity;
}
