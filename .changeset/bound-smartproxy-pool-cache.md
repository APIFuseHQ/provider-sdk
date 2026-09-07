---
"@apifuse/provider-sdk": patch
---

Bound the in-memory Smartproxy endpoint cache.

The per-affinity pool cache previously grew for as long as the process lived: every distinct `affinityKey` added an entry that was never removed once its 15 s extraction window passed. Expired pools are now reclaimed on read and on every insert, and the cache is capped at 10,000 entries with least-recently-used eviction. Invalidation tombstones (30 s) are swept on each invalidation instead of accumulating.

`resolveProxy()` results from the Smartproxy allocator now carry `diagnostics.poolCacheEvictions`, the process-lifetime count of pools removed because the cap was hit (expiry removals are not counted). A non-zero value means a still-fresh pool was dropped and that affinity re-allocated onto a different egress endpoint, so operators can see when the cap is undersized. No public types changed.
