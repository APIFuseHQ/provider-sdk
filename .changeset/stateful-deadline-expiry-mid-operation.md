---
"@apifuse/provider-sdk": patch
---

Report a stateful forwarding deadline that expires mid-operation as the deadline, on both pods.

Owner pod: the owner route runs a forwarded operation under one signal that merges its inbound request with the forwarded `deadlineAt`, so when the deadline expired while `ctx.http` or `ctx.stealth` was reading upstream, the cancelled read surfaced as `transport_cancelled` and was served as `502` with category `upstream_http` and source `upstream_failure`. The owner route now serves that failure as `StatefulRoutingDeadlineError`, exactly what it already serves for a deadline that expires before execution: `504`, code `STATEFUL_FORWARDING_DEADLINE_EXPIRED`, category `timeout`, source `apifuse`, `retryable: false`, with the cancelled read kept as the logged cause. Only a failure whose cause chain carries the owner deadline's own abort reason is reclassified, so a source that disconnected first, a provider's own per-request `signal`, and upstream HTTP failures keep their classification.

Source pod: `StatefulSessionRouter` aborts the forwarding request at the same `deadlineAt`, so the owner's answer usually never arrived and the caller of the source pod received `500 internal_error` for a `StatefulOwnerForwardingError` (`STATEFUL_FORWARDING_REQUEST_FAILED`). The router's deadline timer now aborts with its own `AbortError` reason, and the router rethrows a forwarding failure as `StatefulRoutingDeadlineError` when that reason is in its cause chain, or when the owner's relayed code is `STATEFUL_FORWARDING_DEADLINE_EXPIRED` (the owner's 504 arrived first). The source pod then serves the same `504 STATEFUL_FORWARDING_DEADLINE_EXPIRED` (`timeout`, `apifuse`, `retryable: false`) as the owner, with the forwarding failure kept as the logged cause. Other forwarding failures, such as an unreachable owner or a reset connection, are unchanged.

No public API, category, source or status value changes. The abort reason keeps the `AbortError` name, so code that inspects the reason's name behaves as before.
