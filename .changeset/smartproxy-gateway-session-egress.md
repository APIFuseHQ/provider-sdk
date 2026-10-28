---
"@apifuse/provider-sdk": minor
---

smartproxy egress moves from the IP-extraction allocator to the vendor's gateway with a per-attempt session id, and the proxy pool is gone.

- `smartproxy` is now synthesized locally like NodeMaven: `<user>_area-<CC>_life-<minutes>_session-<id>` against `proxy.smartproxy.net:3120`, authenticated with the sub-account credentials `APIFUSE__PROXY__SMARTPROXY_USERNAME` and `APIFUSE__PROXY__SMARTPROXY_PASSWORD`. The extraction API, `APIFUSE__PROXY__SMARTPROXY_APP_KEY`, the 15 s extraction cache, the Redis singleflight lock and the stale-pool refresh are removed.
- A rotating policy mints a random session id per attempt; a sticky policy derives `sid(affinityKey, lifetime window, attempt)`, so every process serving one connection shares one egress IP without shared storage, and a transport retry moves to the next session id instead of the next pool slot. The sticky window is wall-clock aligned for both vendors on every transport.
- **Breaking:** `ProviderProxyPolicy.session.poolSize` is removed; `defineProvider` rejects it as an unknown field. The vendor fallback chain no longer depends on a pool size: a request's attempt budget is split evenly across the declared vendors in order (`mapAttemptToVendor`), and an implicit safe-method request is entitled to `PROXY_ATTEMPTS_PER_VENDOR` (3) attempts per vendor.
- New vendor selector seam (`ProxyVendorSelector`, `getProxyVendorSelector`, `setProxyVendorSelector`, `staticOrderProxyVendorSelector`): the resolver asks the selector which vendor and session serve an attempt and the transports report every attempt's outcome back to it.
- **Breaking for telemetry consumers:** `ProxyResolutionSource` `"smartproxy-allocator"` becomes `"smartproxy-gateway"`; `ProxyCacheStatus` keeps only `"disabled"`; `SmartproxyAllocatorBodyClass`, the allocator timing fields and the per-attempt `poolIndex` (`i`) are no longer emitted. `ResolvedProxyConfig` gains `sticky`, `sessionId`, `expiresAt` and `lifetimeMinutes`.
- Ceremony egress lease handles are minted as `v2` (no `poolIndex` / `refreshEpoch`, optional `sessionId`); `v1` handles still verify and bind.
