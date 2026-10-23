---
"@apifuse/provider-sdk": patch
---

Report a stateful forwarding deadline that expires mid-operation as the deadline. The owner pod runs a forwarded operation under one signal that merges its inbound request with the forwarded `deadlineAt`, so when the deadline expired while `ctx.http` or `ctx.stealth` was reading upstream, the cancelled read surfaced as `transport_cancelled` and was served as `502` with category `upstream_http` and source `upstream_failure`, counting the deadline as an upstream failure. The owner route now serves that failure as `StatefulRoutingDeadlineError`, exactly what it already serves for a deadline that expires before execution: `504`, code `STATEFUL_FORWARDING_DEADLINE_EXPIRED`, category `timeout`, source `apifuse`, `retryable: false`, with the cancelled read kept as the logged cause. The source pod's `HttpStatefulOwnerForwarder` therefore receives `STATEFUL_FORWARDING_DEADLINE_EXPIRED` with status 504 instead of `transport_cancelled` with 502.

Only a failure whose cause chain carries the deadline's own abort reason is reclassified, which means the deadline aborted the merged signal before anything else did. A source that disconnected first, a provider's own per-request `signal`, and upstream HTTP failures keep their existing classification. No public API, category, source or status value changes.
