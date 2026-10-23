---
"@apifuse/provider-sdk": patch
---

Serve `native_connection_timeout` like `transport_timeout`: status 504 and the public message "Request timed out", instead of 502 and "Upstream request failed". This is the error `ctx.native.network.connectTcp/connectTls` rejects with when its `timeoutMs` connect deadline expires, so a caller (including a stateful-forwarding source pod) now gets 504 for it, the same status ctx.http's request timeout already gets. The `timeout` category, `retryable: true`, the `upstream_failure` source and the error code in the body are unchanged. `native_connection_idle_timeout` keeps its 502.
