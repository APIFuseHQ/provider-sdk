---
"@apifuse/provider-sdk": minor
---

Add request-scoped HTTP transport telemetry to operation, auth, and signed stateful logs and gateway headers. Record bounded attempt samples, retries, timeouts, proxy usage, status, and duration, with redacted operator-only error diagnostics. Source tenant `meta.retry` from the same contributor while preserving its existing response shape. Streaming requests record telemetry when headers arrive.

Guard all observer hooks and property reads, including retry-summary callbacks and the failure reporter. Ignore invalid asynchronous results without awaiting them, including rejected Promise subclasses with throwing `Symbol.species` and hostile thenables. Observer failures never change fetches, retry backoff, return values, or request outcomes. The `telemetryFailed` marker reports these failures in logs only; neither it nor error diagnostics appear in gateway headers or tenant metadata.

Attach the request collector to supported host HTTP bindings after `ProviderEngine.attach`. The adapter preserves method arguments, direct calls, explicit `.call`/`.apply` receivers, unbound-call behavior, and promise, response, stream, and error identities without consuming stream or SSE bodies. SDK clients report every observed transport attempt while their configured observers continue receiving callbacks. Rebinding an existing adapter reuses its identity: the latest collector receives subsequent calls, earlier collectors receive no further calls, and in-flight calls retain their captured collector. This prevents pre-bound clients and nested binds from losing or duplicating attempts.

For opaque hosts, each method invocation is one observed attempt with zero observed `retries`; hidden retries or proxy settings are not inferred, and tenant `meta.retry` is omitted. Logs and telemetry headers still report the observed status, duration, and error class. Non-object bindings and objects with no callable `request`, `get`, `post`, `put`, `delete`, `stream`, or `sse` method are left untouched, preserving host behavior and omitting the `http` telemetry sibling. Emit exactly one process-wide warning for this reason, without the binding value: `[apifuse] http telemetry not attached; reason=unsupported_binding_shape`.

Document these contracts on `HttpClientOptions.httpTelemetry`; remove the standalone HTTP telemetry guide from the ADR-only `docs/` directory.
