---
"@apifuse/provider-sdk": minor
---

Proxy policy contract for operation-scoped NodeMaven mobile egress.

- `ProviderProxyPolicy.operations`: restrict a provider-level proxy policy to the listed operation ids. Unlisted operations and auth flows egress directly, as a provider without `proxy` does. The deployment side keeps projecting the vendor credentials from the single provider-level declaration. `defineProvider` rejects an id that is not a declared operation.
- `ProviderProxyPolicy.nodemaven` (`ProviderProxyNodemavenOptions`): NodeMaven-only username tokens `type: "mobile"` (`-type-mobile`), `isp` carrier slugs (`-isp-<slug>`, one per attempt by pool index) and `ttlSeconds` (`-ttl-XmYs`). `defineProvider` validates the shape and requires `nodemaven` in the vendor chain.
- `synthesizeNodemavenProxy` documents the documented NodeMaven token order (`country, region, city, isp, type-mobile, ipv4-true, sid, ttl, filter`) as the contract; `formatNodemavenTtl`, `NODEMAVEN_ISP_SLUG_PATTERN`, `NODEMAVEN_TTL_SECONDS_MIN/MAX` are exported.
- `resolveOperationProxyConfig(provider, operationId)` resolves the policy in force for one operation context.

Token emission and context wiring follow in the implementation change on the same branch.
