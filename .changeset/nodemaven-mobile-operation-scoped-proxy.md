---
"@apifuse/provider-sdk": minor
---

Operation-scoped proxy policies and NodeMaven mobile egress.

- `ProviderProxyPolicy.operations` restricts a provider-level proxy policy to the listed operation ids. Listed operations receive the policy on `ctx.http`, `ctx.stealth`, `ctx.native.network` and the resolver chain. Every other operation and every auth flow egresses directly, exactly as a provider without `proxy` does: no proxy resolution, no proxy telemetry and no vendor credential requirement. The deployment side keeps projecting the vendor credentials from the single provider-level declaration. `defineProvider` rejects an id that is not a declared operation.
- `ProviderProxyPolicy.nodemaven` (`ProviderProxyNodemavenOptions`) adds NodeMaven username tokens: `type: "mobile"` (`-type-mobile`), `isp` carrier slugs (`-isp-<slug>`) and `ttlSeconds` (`-ttl-XmYs`, 500 encodes as `8m20s`). One carrier is encoded per attempt, `isp[poolIndex % isp.length]`, so a caller-managed retry with `proxyAttemptOffset: 1` moves to the next carrier with a new sid. `defineProvider` validates the shape and requires `nodemaven` in the vendor chain.
- NodeMaven usernames follow the documented token order `country, region, city, isp, type, ipv4, sid, ttl, filter`. Existing residential policies keep the same tokens and values, the same sid and the same gateway port; only `-ipv4-true` moves ahead of `-sid-`. Mobile usernames carry `-filter-` only when `APIFUSE__PROXY__NODEMAVEN_FILTER` is set.
- NodeMaven proxy diagnostics carry the connection `type` and, when one is encoded, the `isp` slug. The username is still never exposed.
