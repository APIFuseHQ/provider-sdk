---
"@apifuse/provider-sdk": major
---

Require `FlowContext.trace`, add one traced request scope across operation, auth-flow, and stateful routes, and include request correlation identifiers in provider completion and failure logs.

Auth-flow contexts now instrument their HTTP, stealth, state, and resolver capabilities under a request root span. Stateful forwarded operations retain proxy lease telemetry, and exported traces inherit an inbound W3C trace id or derive a stable trace id from the request id.

Streaming request roots now remain active through terminal success, failure, or cancellation before emitting one outcome log. Provider logs keep the served `providerId` authoritative and include `requestedProviderId` only for mismatched auth routing requests.
