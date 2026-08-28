---
"@apifuse/provider-sdk": minor
---

Allow provider authors to attach bounded, typed `observability` metadata to `ProviderError` options. Valid `reason`, `fingerprint`, and `messageLength` values are emitted as `providerObservability` in provider failure logs and the error observability header, and on cause-chain frames when the inner cause is a branded `ProviderError`.

Only own data properties are read at every level, including `ProviderError.options` and `options.observability`; inherited values and accessors are rejected without invoking getters.

The SDK validates this closed schema at the emission boundary and drops invalid values and arbitrary keys. Public error response bodies remain unchanged.

Failure logs receive an independent metadata snapshot, so mutations by an injected logger cannot alter the observability header serialized in the response.

At the server error boundary, provider-controlled accessor failures are absorbed into canonical error classification rather than propagated. The accessor exception text and stack are intentionally discarded instead of logged because they are provider-controlled disclosure channels.
