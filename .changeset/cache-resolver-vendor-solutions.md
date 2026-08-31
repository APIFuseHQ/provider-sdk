---
"@apifuse/provider-sdk": minor
---

Cache resolver-vendor cookie solutions with conservative SDK-estimated expiration and expose stale-cache recovery metadata.

- Cookie `ChallengeSolution` values gain an additive `sdkEstimatedExpires` field for expiration inferred by the SDK when a vendor omits the upstream cookie expiry; the existing `expires` field remains reserved for observed upstream expiry and always takes precedence.
- CapSolver AWS WAF cookie solutions now carry a conservative one-hour estimated expiry, allowing repeated operations for the same web ACL scope to reuse the minted `aws-waf-token` instead of solving the challenge on every request.
- Resolver solutions now expose whether their exact object came from a vendor solve or the cache, plus a cache-only invalidation helper that providers can call when an upstream repeats a challenge after a cached solution was applied; the following solve then mints a fresh solution.
- 2captcha AWS WAF solutions remain token-form and uncached, preserving their existing solution contract.
