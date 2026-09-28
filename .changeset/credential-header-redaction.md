---
"@apifuse/provider-sdk": patch
---

Redact the whole credential of `Authorization` / `Proxy-Authorization` values and vendor-prefixed API key headers in diagnostic text and fixtures.

A credential header's value is now read as the RFC 9110 `credentials` production (`auth-scheme SP token68`), so `Authorization: Basic YWRtaW46YWRtaW4=` becomes `Authorization: [REDACTED]` instead of redacting only the scheme word and keeping the base64 payload. This applies to any key ending in `authorization`, in both `sanitizeDiagnosticText` and fixture strings. Keyless echoes also cover `Negotiate` and `NTLM` tokens (registered spelling only, so prose such as "failed to negotiate TLS" is kept) and `Basic` tokens that base64-decode to `user-id:password` (prose such as "Basic information" is kept). `Bearer` handling is unchanged.

Credential-key matching now also recognizes vendor-prefixed names: `x-api-key`, `x-access-key`, `X-RapidAPI-Key` and similar names ending in `api|client|service|access|consumer` + `key|secret|token`. This widens redaction in diagnostic text, trace attributes, recorded fixtures and stream evidence alike. `author`, `primary_key`, `x-request-id`, `x-correlation-id` and `trace_id` stay unredacted. Digest credentials (auth-param lists) are not covered by the scheme rule. No public types changed.
