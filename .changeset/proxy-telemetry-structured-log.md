---
"@apifuse/provider-sdk": minor
---

Emit proxy telemetry to structured logs, and collect it on the auth routes.

`ProxyTelemetryCollector` previously had a single exit, `toHeaderValue()`, which serialized the aggregate into the `X-ApiFuse-Provider-Telemetry` response header. When a gateway consumed that header the data was gone: pod logs contained nothing, so an operator investigating a past incident had no proxy signal at all.

`toLogPayload()` now returns the same aggregate as a plain object, and `toHeaderValue()` is built on top of it, so the header and the log can never drift. The per-request server log events (`provider_request_completed` and `provider_request_failed`) carry it as an optional `proxy` field, omitted entirely when a request resolved without a proxy.

The five auth routes — `/auth/start`, `/auth/continue`, `/auth/poll`, `/auth/refresh`, `/auth/disconnect` — never constructed a collector, so proxy telemetry for an authentication ceremony was emitted nowhere, not even as a header. Each route now creates one, threads it through `handleAuthFlow` into the auth proxy and stealth client options, sets the response header, and passes it to both the success and the error log.

Purely additive for existing consumers: the log field is optional and the header wire format is unchanged.
