---
"@apifuse/provider-sdk": minor
---

Accept `APIFUSE__TRACE__EXPORTER=otlp` for server trace output and resolve the OTLP/HTTP export target from the standard OpenTelemetry environment contract.

- The server exporter list is now `console`, `json`, `otlp`, and `none`; the three existing values behave exactly as before, and an unknown value still warns once and fails closed to `none`.
- The endpoint resolves from `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` used verbatim, else `OTEL_EXPORTER_OTLP_ENDPOINT` as a base URL with `/v1/traces` appended (trailing slashes and base paths are handled). An explicit `TraceConfig.otlp.endpoint` still wins when a caller supplies one; the served-provider path is environment-only. The winning candidate must be an absolute http(s) URL without embedded credentials; an invalid one fails closed rather than falling through to a lower-precedence destination.
- Headers resolve from `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, else `OTEL_EXPORTER_OTLP_HEADERS`, in the `key=value,key2=value2` format with percent-decoded values. A header name or value that cannot be sent disables export once instead of failing every batch. Header values are never written to logs; export failures are reported as `HTTP <status>`, `timeout`, or the error name and system error code only, never the message, endpoint, or headers.
- Resource attributes merge `OTEL_RESOURCE_ATTRIBUTES` under the SDK's per-request attributes, with `service.name` resolving from `OTEL_SERVICE_NAME`, else `OTEL_RESOURCE_ATTRIBUTES` (an explicit `service.name` passed by a caller wins over both).
- With the exporter set to `otlp` and no resolvable endpoint, the server warns once, names the offending variable without its value, and disables export; provider operations are unaffected either way, and export failures remain fire-and-forget with the existing bounded timeout.
- Spans exported by the server pass through the same sanitization as console output, so credentials recorded on spans are redacted before they leave the process. Per-request resource attributes get the same treatment; operator-configured attributes from the environment keep their values, with control characters neutralized and secret-named keys redacted. Export configuration is no longer reachable from the trace context handed to provider code.
- Each trace context now carries its own random trace id, so batches from one request share an id and separate processes can no longer collide.
- `CreateTraceContextOptions` gains an optional `sanitizeSpanForExport` hook that receives a detached copy of each span immediately before OTLP export; a hook that throws or returns nothing drops that batch. Programmatic trace contexts that do not set it are unchanged.
