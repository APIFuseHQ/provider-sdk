---
"@apifuse/provider-sdk": major
---

Guard attributions gain the reason code `served_stale_cache` for a stale-if-error cache serve; `expected_absence` is now reserved for an absence the provider declares in advance, which the platform publishes as the non-incident `expected_absence` status (neither ok nor degraded, excluded from uptime and incidents). `GuardReasonCode` is derived from the exported `GUARD_REASON_CODES` tuple. The `health-check-stale-serve-unguarded` lint and the health-check skill template now recommend `served_stale_cache` for freshness guards; existing scenarios keep validating.
