---
"@apifuse/provider-sdk": major
---

Guard attributions gain the reason code `served_stale_cache` for a stale-if-error cache serve; `expected_absence` is now reserved for an absence the provider declares in advance, which the platform publishes as the non-incident `expected_absence` status (neither ok nor degraded, excluded from uptime and incidents). The vocabulary is also exported as the `GUARD_REASON_CODES` tuple (from the root and `provider` entry points), pinned to `GuardReasonCode` in both directions at compile time. The `health-check-stale-serve-unguarded` lint and the health-check skill template now recommend `served_stale_cache` for freshness guards, and a new `health-check-stale-serve-reason` warning names the freshness guards that still attribute `expected_absence`; existing scenarios keep validating.
