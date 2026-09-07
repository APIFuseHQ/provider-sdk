---
"@apifuse/provider-sdk": patch
---

Apply the error envelope contract to raw `Response` results: the server now strips any provider-set `X-ApiFuse-Error-Observability` header and, for raw responses with status 400 or above (including streaming transports), emits the SDK-derived header (category from status; retryable only for 408, 429, and 5xx). Raw bodies and successful raw responses are unchanged.
