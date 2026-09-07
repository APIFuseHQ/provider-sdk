---
"@apifuse/provider-sdk": minor
---

Add bounded resolver telemetry to the operator request log and gateway-ingestion header, and expose an optional `ResolverRuntimeOptions.telemetry` contributor seam.

Server-supplied SDK resolver chains are rebound to each request's collector, including explicit operation/auth calls, signed stateful execution, and automatic SBSD solves. The reusable chain keeps sink-free configuration; hosts do not need to supply telemetry. Opaque host resolver implementations are recorded as one `custom` invocation because their internal vendor work is not exposed.

`RESOLVER_CHAIN_EXHAUSTED` changes the public error contract: vendor identifiers and upstream diagnostics are removed from the tenant body. Operators receive up to 24 attempt samples, including log-only cause name/message, upstream host, missing-field names (up to 24), round, one-based attempt index, and the actual adapter phase. Descriptions, codes, and diagnostic text pass through the injected redactor before being copied into detached strings of at most 300 UTF-16 code units (lone surrogates are preserved); without a redactor they are bounded only. A throwing redactor emits a fixed failure sentinel.

The header keeps its closed-enum shape and excludes free-text diagnostics and vendor descriptions. Its typed phase column adds Hyper's `measure_ip`, `fetch_script`, `generate_payload`, and `post_payload` members alongside `create_task`, `poll_result`, and `cleanup`, under the existing `v: 1` envelope and taxonomy version. Arbitrary custom phases remain available in log diagnostics; the header uses the observed recognized phase, or the existing `create_task`/`poll_result` fallback on failure/success. SDK bypass caches report the existing `disabled` status and no cache write. A failed cache write no longer counts as a second vendor attempt, and missing-profile preflight failures report zero executed attempts in both the public body and operator log.

The log and header `resolver.outcome` describe the resolver call: `solved` means an adapter returned a solution. For Hyper SBSD, that includes `payload_accepted` with `verified: false`; it does not promise that the protected request succeeded. Read the subsequent stealth refetch HTTP status and challenge outcome to determine verification: `resolver.outcome: "solved"` can accompany HTTP 403 and `challenge_persisted`. This documents the existing adapter-result meaning without changing HTTP, retry, or verification behavior.
