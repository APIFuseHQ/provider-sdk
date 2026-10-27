---
"@apifuse/provider-sdk": major
---

Split the error category taxonomy into two sets and narrow the authoring type to one of them.

`src/observability.ts` now mirrors the platform's two primary sets, `PLATFORM_FAULT_CATEGORIES` (what the SDK runtime and the Gateway report for faults of their own) and `PROVIDER_FAILURE_CATEGORIES` (what provider code reports for the way an upstream call failed), with `PROVIDER_ERROR_CATEGORIES` kept as their union in the same 21 words and order. `credential_unavailable` is in both.

`ProviderErrorOptions.category`, and so the options of every `ProviderError` subclass, accepts `ProviderFailureCategory`. A platform word such as `internal_error`, `client_cancelled`, `proxy_pool` or `output_validation` no longer typechecks there; it is reported by the SDK for events the SDK observed, not set by a throw site. A `HandleError` a provider constructs with `HANDLE_BUSY`, `HANDLE_CONNECTION_REQUIRED`, `HANDLE_STORAGE_UNAVAILABLE`, `HANDLE_TOO_LARGE` or `HANDLE_INVALID_DATA` no longer carries `category: "internal_error"` in its options; the same errors raised by the handle runtime are reported as platform faults as before.

`ErrorObservabilityDetails` is a union tagged by `origin: "platform" | "provider"`, each side typed over its own set, with `LegacyErrorObservabilityDetails` naming the shape an SDK before this release writes. The `provider_request_failed` log event gains `errorOrigin` and the signal `unknown_provider_error_category`. New exports: `PlatformFaultCategory`, `ProviderFailureCategory`, `ProviderErrorCategoryOrigin`, `isPlatformFaultCategory`, `isProviderFailureCategory`, `sourceForPlatformFault`, `PROVIDER_ERROR_CATEGORIES_LIST_BOTH_SETS`.

The served header is unchanged in this release step: the serializers that write `origin` follow in the same release line.
