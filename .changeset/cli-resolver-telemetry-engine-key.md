---
"@apifuse/provider-sdk": patch
---

`apifuse record` and the `apifuse dev` helper context now build their resolver chain the way a server request scope does. The chain reads the engine-owned solver keys (`APIFUSE__RESOLVER__*__API_KEY`), `APIFUSE__CDP_POOL__URL`, and `APIFUSE__RESOLVER__TIMEOUT_MS` from the process environment; previously both helpers handed the chain a proxy-credential-only snapshot, so hosted vendors always failed with `missing_credentials` and the browser vendor never saw the CDP pool URL. Every solve now lands in a per-context `ResolverTelemetryCollector` redacted with the provider's static sensitive inventory, and `apifuse record` prints it once per recorded invocation as `[apifuse record] Resolver telemetry {"resolver":{...}}` — the same `resolver` sibling the server request log carries — so CAPTCHA spend during fixture recording is attributable. No public API changes.
