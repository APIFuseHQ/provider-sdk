---
"@apifuse/provider-sdk": minor
---

Use an SDK-owned `capsolver`-then-`2captcha` resolver policy when a provider omits `resolver.vendors`, while preserving explicit overrides and empty chains. Export `resolveProviderResolverVendors` from `@apifuse/provider-sdk/runtime/resolver` so deployment tooling can use the exact same chain calculation.

Follow-up required in the APIFuse monorepo: `scripts/generate-provider-manifests.ts` must call this exported function before deriving resolver secrets, egress FQDNs, and registry authorization. Deploying providers that omit `resolver.vendors` depends on that generator change.
