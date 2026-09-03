---
"@apifuse/provider-sdk": minor
---

Add opt-in Akamai SBSD response classification and the SDK-owned safe-read
challenge transaction: the initiating stealth session now supplies its exact
proxy-bound transport, cookie jar, and profile headers to the resolver, then
refetches an eligible original GET or HEAD once after a successful solve.

This is a minor bump because every public change is additive: `ProviderStealthConfig`
gains an optional opt-in, `StealthResponse` gains an optional typed challenge
classification, and the new types are new exports. Classifications cover
`resolver_unavailable`, `replay_required`, and `challenge_persisted` outcomes.
Successful solves are represented only by the unclassified refetched response; unsafe
requests are never replayed automatically.

Custom hosts may add an `AutoSolveResolverFactory` to select the vendor chain used by
automatic solving from the initiating session's resolved profile. The SDK alone
constructs the resolver and injects its session-bound transport. This option is additive; existing provider-invoked
`ResolverContext` overrides remain supported outside automatic solving.
