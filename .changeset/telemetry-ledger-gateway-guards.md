---
"@apifuse/provider-sdk": minor
---

Add a request-scoped telemetry ledger with typed contributors and gateway-ingestible and tenant-neutral type guards. The telemetry envelope remains `v: 1` and gains the additive `taxonomy` key; the proxy contributor payload and its `proxy` header sibling bytes are unchanged. Header serialization enforces the 4096-byte budget with deterministic sibling dropping and runtime structural validation.
