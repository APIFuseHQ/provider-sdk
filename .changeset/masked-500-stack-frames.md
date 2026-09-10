---
"@apifuse/provider-sdk": minor
---

Log bounded `stack` frames on 5xx `provider_request_failed` events so a masked crash can be located. A plain `throw new Error("boom")` in a handler previously produced a log record with `errorClass: "Error"`, `message: "boom"` and nothing pointing at the throw: the public body is deliberately masked to `internal_error`, trace spans carry no exception stack, and `causeChain`/`providerObservability` only describe wrapped causes.

The new optional `stack` field holds up to 5 frames re-emitted from a strict whitelist grammar as `[async |new ][fn ](basename:line:col)`. `native` and engine-internal `node:` module ids (`node:` plus `/`-separated identifier-shaped segments, e.g. `node:internal/process/task_queues`) are kept verbatim because they name no deployment path; anything else keeps only the file basename, so filesystem directories, drive-letter paths and `file://` URLs are reduced rather than passed through. Eval frames, frames without a location, frames whose basename leaves the whitelist charset, and oversized lines are dropped entirely, and for an engine-formatted stack the `name: message` header is stripped first so a provider-controlled *message* containing newlines cannot inject frame-shaped text. Frames are not routed through `sanitizeDiagnosticText`, which destroys path-like tokens; each frame still passes the request redactor, failing closed to `[REDACTION_FAILED]`. Only an own data `stack` property or the engine's own shared native accessor is read, so a provider-defined accessor never runs inside the logger.

The field is a diagnostic hint, not an attested location: a provider that overwrites `stack` or `name` outright can still emit grammar-shaped frames, bounded by the whitelist and the redactor.

The field is log-channel only and appears for every status >= 500 (masked 500s and declared 502/504); 4xx failures keep the lean record. The public error body and the error-observability header are unchanged.
