---
"@apifuse/provider-sdk": patch
---

Classify a `transport_cancelled` TransportError as `client_cancelled` (source `client`) instead of `upstream_http` (source `upstream_failure`) when the served request's own signal has aborted, that is, when the caller closed the connection mid-operation. These cancellations no longer count as upstream failures in error observability. A `transport_cancelled` caused by anything else, such as a `signal` the provider passed to `ctx.http` or `ctx.stealth` itself or the stateful forwarding deadline, keeps its previous `upstream_http` classification. The served status (502) and `retryable: false` are unchanged, matching `native_connection_aborted`.
