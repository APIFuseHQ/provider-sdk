---
"@apifuse/provider-sdk": major
---

Serve the error observability header tagged with its origin, and give a failure a platform outcome only for a fault the SDK observed itself.

`X-ApiFuse-Error-Observability` now carries `origin`. A platform fault (`origin: "platform"`) is a fault the SDK issued (output validation, the inbound cancellation, the required-secret gate, the handle runtime's faults, and the transports' proxy allocation and proxy endpoint failures), a transport cancellation after the caller closed the connection, or a throw serve cannot read, which it masks as `internal_error`. Its category, status, retryability and `source` come from the fault alone. Everything else is a provider failure (`origin: "provider"`) classified over the provider-failure categories, and the `provider_request_failed` log records the origin as `errorOrigin`.

A code, class or category a provider sets no longer produces a platform outcome:

- A `category` outside `ProviderFailureCategory` (a platform word through a cast or from JavaScript, an unknown word, a non-string) is read as unset; the failure is classified by the default rules and its log carries `signal: "unknown_provider_error_category"` (unless `unregistered_provider_error_code` applies).
- A provider that throws a `TransportError` with `PROXY_POOL_EXHAUSTED`, `PROXY_EDGE_AUTH_REJECTED`, `PROXY_ALLOCATION_FAILED`, `native_proxy_expired` or `native_proxy_invalid`, or constructs a `NativeProxyExpiredError`, gets the transport failure's provider category (`upstream_http` for most) instead of `proxy_pool`. The same failures raised by the SDK's transports stay `proxy_pool`.
- A provider that throws `STATEFUL_FORWARDING_DEADLINE_EXPIRED`, `OUTPUT_VALIDATION_FAILED` or another SDK code gets a provider failure. On a stateful source pod, the forwarding deadline relayed from the owner pod is recognized only from the owner's header reporting the platform fault `stateful_forwarding_deadline`; for an owner pod on an SDK that writes no `origin`, the relayed `STATEFUL_FORWARDING_DEADLINE_EXPIRED` code is still read.

The public response body is unchanged.
