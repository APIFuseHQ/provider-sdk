---
"@apifuse/provider-sdk": minor
---

Declare the six remaining provider capabilities on `ProviderConfig`.

`http`, `choice`, `env`, `state`, `cache`, and `files` had context members but no declaration field, so declaring a capability and omitting it produced the same context. Each is now an optional literal presence marker (`http?: true`), which leaves room to widen to `true | ProviderXConfig` later without a breaking change.

`trace` is deliberately excluded: observability is not a provider choice and stays ambient.

Purely additive — every existing provider definition compiles unchanged.
