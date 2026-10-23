---
"@apifuse/provider-sdk": patch
---

Classify a `transport_cancelled` TransportError as `client_cancelled` (source `client`) instead of `upstream_http` (source `upstream_failure`) when the served request's own signal has aborted, that is, when the caller closed the connection mid-operation. These cancellations no longer count as upstream failures in error observability. A `transport_cancelled` caused by anything else, such as a `signal` the provider passed to `ctx.http` or `ctx.stealth` itself or the stateful forwarding deadline, keeps its previous `upstream_http` classification and 502 status.

Non-streaming requests classified `client_cancelled` this way, including `native_connection_aborted`, are now served and logged with status 400, the status the streaming path already uses for a cancelled stream, instead of 502. `retryable: false`, the category and the source are unchanged.
