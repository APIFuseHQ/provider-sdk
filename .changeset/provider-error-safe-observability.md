---
"@apifuse/provider-sdk": minor
---

Allow provider authors to attach bounded, typed `observability` metadata to `ProviderError` options. Valid `reason`, `fingerprint`, and `messageLength` values are emitted as `providerObservability` in provider failure logs and the error observability header, and on cause-chain frames when the inner cause is a branded `ProviderError`.

The SDK validates this closed schema at the emission boundary and drops invalid values and arbitrary keys. Public error response bodies remain unchanged.
