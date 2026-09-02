---
"@apifuse/provider-sdk": major
---

Add the `akamai_sbsd` challenge kind and the engine-owned `hypersolutions`
resolver adapter, including its identity-bound transport protocol and
non-cacheable, opaque cookie-update outcome. SBSD cookie values now remain only
in the engine-owned bound jar.

Breaking surfaces: `ProviderChallengeKind` gains `akamai_sbsd` and
`ProviderResolverVendor` gains `hypersolutions`, so downstream `never`-exhaustive
switches must add cases. Cookie-form `ChallengeSolution` consumers must narrow
out the opaque SBSD outcome before reading portable cookie values. All hosted
resolver API keys are engine-owned credentials; provider declarations of
`APIFUSE__RESOLVER__*` or provider-scoped Hyper aliases are rejected and the
credentials are omitted from provider environment projections.
