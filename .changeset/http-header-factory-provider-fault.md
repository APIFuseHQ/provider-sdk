---
"@apifuse/provider-sdk": major
---

Classify a `ctx.http` request-header factory failure as a provider-side fault instead of an upstream failure.

`headers` factory throws (and non-record results) still fail the request with the non-retryable `TransportError` code `http_header_factory_failed` and HTTP 502, but the error now carries `category: "provider_error"`, so the served envelope reports `source: "apifuse"` and the `X-ApiFuse-Error-Observability` header reports `category: "provider_error"`. Before this change a deterministic, provider-local proof-minting bug fell through the observability ladder to `category: "upstream_http"` / `source: "upstream_failure"` (its `status` is 0, so no upstream status was available to classify), which attributed provider code defects to the upstream health signal. The public message is now `Request header preparation failed` instead of `Upstream request failed`, because no request was issued.

`http_header_factory_failed` is also registered in `SDK_OWNED_PROVIDER_ERROR_CODES`, like every sibling `ctx.http` transport code, so the authoring lint treats it as SDK-registered and a provider that documents it in `operation.errorCodes` with a status gets the "declared status is documentation-only" warning.

`HttpAttemptContext.method` is narrowed from `HttpMethod` (which includes lowercase members) to `Uppercase<HttpMethod>`. The value passed has always been the normalized upper-case method, so the previous type was wider than the contract; a factory comparing `method === "get"` was unreachable code that type-checked. Migration: compare against upper-case literals, which is what the runtime has always supplied.

Authoring guidance for the factory now says to strip query and fragment before binding a DPoP `htu` (RFC 9449 §4.2 defines it without them, and the attempt URL carries `params`/`sensitiveParams`), and to keep minting fast and local because the factory is awaited while an allocated egress endpoint and its lease are held.
