---
"@apifuse/provider-sdk": minor
---

Add `RequestOptions.signal`, a request-scoped abort that cancels one HTTP request — through its retries, its backoff sleep and its response-body consumption — without cancelling the client's other in-flight requests. The client-level `signal` passed to `createHttpClient` keeps its fleet-wide meaning and is merged into every request, so existing callers see no behavior change; the per-attempt `timeout` still bounds the response-header phase only, on the buffered path as well as on streams. `StealthFetchOptions.signal` is typed `never`: the stealth transport observes only the client-level signal, so a per-request one fails to compile instead of being silently ignored.

Fix pooled browser policy teardown so a disposed CDP target is never reconnected: `close()` is memoized, its page bookkeeping runs even when the pool's release fails, and repeat calls stay idempotent instead of replaying the first failure.
