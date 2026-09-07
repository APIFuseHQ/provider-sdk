---
"@apifuse/provider-sdk": major
---

Akamai SBSD detection, bound resolver transport, and one safe refetch
(ADR-0008 v1.1 phase 2).

A stealth session whose provider declares `resolver.kinds: ["akamai_sbsd"]`
(or opts in with `stealth.challengeDetection.akamaiSbsd: true`) now classifies
SBSD responses: an interstitial that loads a same-origin script with a UUID
`v` (the script path itself is per-site obfuscated), or a later `cpr_chlge`
JSON token composed with the session's remembered script. When a resolver is declared, the SDK solves once per session and
challenge on the initiating request's own proxy lease, cookie jar, and profile
headers (`ResolverVendorTransport.sessionHeaders`/`getCookie` are supplied
here), then refetches the original request exactly once. Success is judged
only from that refetch. Only a plain GET (no body, no `Authorization`, caller
`Cookie`, or other credential header) is solved and refetched automatically;
everything else is classified and returned. The solve runs under the client's
ambient signal and the resolver's own timeouts, not the initiating fetch's
`timeout`. A provider that declares the resolver without a `stealth` block gets
the same detection on its default Chrome client (auth flows included).

Consumer-visible changes:

- `StealthResponse.challenge?: StealthChallengeClassification` with outcomes
  `resolver_unavailable`, `replay_required`, `solve_failed`,
  `challenge_persisted`. A successful solve is represented only by the
  unclassified refetched response.
- Documented exception to `StealthFetchOptions.throwOnHttpError`: a classified
  non-2xx response is returned with `challenge` set instead of being thrown, so
  the classification stays observable. Check `response.challenge` first when you
  relied on the throw.
- `ProviderDefinition.stealth` is now `ProviderStealthConfig`
  (`StealthProfileSelection & { challengeDetection? }`); the api-report line
  changes, hence major. Existing structural declarations keep compiling.
- New declaration rule `resolver-client-profile-family`: for `akamai_sbsd`,
  `resolver.clientProfile` must name the browser family of the declared
  `stealth.browser` (default chrome). `defineProvider` and `createServerApp`
  fail closed; a per-request `stealth.browser` override outside the family fails
  the fetch with `RESOLVER_CLIENT_PROFILE_MISMATCH`.
- `ctx.http` proxy resolution now forwards the engine-supplied proxy
  credentials like `ctx.stealth` already did.

Fleet notes: zozotown keeps its SDK pin until the gateway carries the Hyper
key; when it adopts this release it must declare `stealth.browser` matching
its `resolver.clientProfile`. Providers with structural `StealthSession`
test doubles are unaffected (no new required members).
