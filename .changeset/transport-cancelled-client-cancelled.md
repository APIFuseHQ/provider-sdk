---
"@apifuse/provider-sdk": patch
---

Classify a `transport_cancelled` TransportError as `client_cancelled` (source `client`) instead of `upstream_http` (source `upstream_failure`). `ctx.http` and `ctx.stealth` throw it when the inbound request's signal aborts, typically because the caller closed the connection mid-operation, so these cancellations no longer count as upstream failures in error observability. The result now matches `native_connection_aborted`: the served status (502) and `retryable: false` are unchanged.
