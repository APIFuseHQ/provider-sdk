---
"@apifuse/provider-sdk": minor
---

Add the Phase 3 Akamai SBSD continuity contract: auth ceremonies carry an
engine-owned, HMAC-authenticated egress lease that rebinds the exact selected
proxy endpoint and invalidates remembered challenge state at expiry.

Emit allowlisted `resolver.usage` telemetry once for each paid solver task
creation, including billed failed creates, while excluding cache hits and
preflight failures that make no vendor call.

Add `StealthSession.replayChallenged(response)` so providers can explicitly
authorize one byte-exact replay of an unsafe request after the SDK solves its
challenge on the same bound session. A second replay, a different session, or
an unreadable body fails with a typed error. This is a minor additive API
change and does not widen a public exhaustive union.
