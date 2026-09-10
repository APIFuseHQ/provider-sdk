---
"@apifuse/provider-sdk": major
---

`ctx.http` request headers can now be a per-attempt factory, so managed retry
re-mints request-bound single-use proofs (DPoP `jti`/`htu`/`htm`, HTTP message
signatures, HMAC nonces) instead of replaying attempt 1's header set.

`RequestOptions.headers` accepts `Record<string, string> | HttpHeadersFactory`,
where `HttpHeadersFactory = (attempt: HttpAttemptContext) => Record<string, string> | Promise<Record<string, string>>`
and `HttpAttemptContext = { attempt: number; url: string; method: HttpMethod }`
(1-based number of the request build — a failed proxy allocation builds no
request and is not numbered — the exact resolved URL including `baseUrl`,
`params` and `sensitiveParams`, and the normalized upper-case method). Both types are exported
from the package root and `@apifuse/provider-sdk/provider`.

- Record headers behave exactly as before; this is an input widening. The
  changeset is `major` only because the api-report line for `headers` changed.
- The factory runs once per issued attempt, after proxy resolution and after a
  policy-allocator duplicate offset is skipped, so a skipped offset never
  consumes a proof. Redirect hops reuse the attempt's headers. `stream()` and
  `sse()` resolve it once (attempt 1; `sse()` still adds `Accept: text/event-stream`
  unless the factory sets `Accept`). Client defaults (`User-Agent`, JSON
  `Content-Type` for bodies) are applied on top of the factory output.
- A factory that throws or returns a non-object fails the request with a new
  non-retryable `TransportError` code `http_header_factory_failed` (cause
  attached, `sensitiveParams` redacted); it is never retried.
- `ctx.stealth` is not covered: `StealthFetchOptions` declares its own
  `headers` option and stealth has its own attempt loop.

Migration for providers that disabled retry to avoid proof replay:

```ts
// Before: proof minted once, so the request had to stay single-attempt.
const dpop = await createDpopProof(url, "GET");
await ctx.http.get(url, { headers: { ...commonHeaders, dpop }, retry: false });

// After: a fresh proof per issued attempt, managed retry re-enabled.
await ctx.http.get(url, {
  headers: async ({ url, method }) => ({
    ...commonHeaders,
    dpop: await createDpopProof(url, method),
  }),
});
```

POST and other unsafe methods stay single-attempt under the default retry
policy regardless of the header form.
