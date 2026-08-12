import type { ProviderChallenge, ProviderChallengeKind } from "../../types.js";
import type { ResolverIssuingIdentity } from "./types.js";

export const RESOLVER_CHALLENGE_BINDINGS = {
	aws_waf: "portable",
	cloudflare_interstitial: "identity_scoped",
} as const satisfies Partial<
	Readonly<Record<ProviderChallengeKind, "identity_scoped" | "portable">>
>;

export function resolverChallengeIssuingIdentity(
	challenge: ProviderChallenge,
	identity: ResolverIssuingIdentity,
): ResolverIssuingIdentity {
	const binding = (
		RESOLVER_CHALLENGE_BINDINGS as Partial<
			Readonly<Record<ProviderChallengeKind, "identity_scoped" | "portable">>
		>
	)[challenge.kind];
	if (binding === "portable") {
		return { userAgent: identity.userAgent };
	}
	return identity;
}
