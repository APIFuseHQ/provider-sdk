---
"@apifuse/provider-sdk": major
---

Add the `akamai_sbsd` challenge kind, the engine-owned `hypersolutions` resolver
vendor, and `APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY` (ADR-0008 v1.1 phase 1).

The Hyper adapter runs the measured SBSD envelope: observed-IP lookup, script
GET, and payload POST on the identity-bound `ResolverVendorTransport` (which now
exposes `sessionHeaders`, `getCookie`, and `maxBodyBytes`), and the Hyper
`/sbsd` payload-generation POST directly. It returns a value-free
`{ form: "cookie_state", kind: "akamai_sbsd", outcome: "payload_accepted", verified: false }`
solution; the state cookie stays in the bound jar and the solve is only verified
by the next protected GET (phase 2).

Nothing constructs that bound transport yet: until phase 2 wires it from the
initiating stealth session, every `akamai_sbsd` solve fails typed with
`RESOLVER_CHAIN_EXHAUSTED` / `missing_transport`. Providers that solve SBSD
themselves today (zozotown) must keep their current SDK pin until phase 2 lands
and the engine carries the Hyper key.

Breaking changes:

- `ChallengeSolution` gains the `cookie_state` member. Code that narrows with
  `form === "token"` and then reads `solution.cookies` no longer type-checks
  (buyee `upstream/waf.ts` `cookieHeader`); narrow on `form === "cookies"`.
- `ProviderChallengeKind` gains `akamai_sbsd` and `ProviderResolverVendor` gains
  `hypersolutions`; `never`-exhaustive switches must add cases.
- `ProviderResolverConfig` is now a union: declaring `akamai_sbsd` in
  `resolver.kinds` requires `resolver.clientProfile` (type and `defineProvider`).
- Provider secrets may not declare `APIFUSE__RESOLVER__{2CAPTCHA,CAPSOLVER,CAPMONSTER,HYPERSOLUTIONS}__API_KEY`
  or a provider-scoped `APIFUSE__PROVIDER__<ID>__HYPER_API_KEY` alias;
  `defineProvider` rejects them and names the engine variable. These names are
  filtered from provider environment projections.
