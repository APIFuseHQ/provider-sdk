---
"@apifuse/provider-sdk": patch
---

Add the internal capture-evidence masking core for health-monitor upstream
capture (ADR-0013, apifuse#2602): `buildCaptureEvidence` redacts declared output
sensitive paths (output coordinates only, so they do not match a vendor upstream
body), reserved secret-like and credential-named keys, the request's registered
secret values by exact value, and string secrets (including keyless
`Bearer`/`Negotiate`/`NTLM`/`Basic` echoes and URL query values), and keeps a
query-free request path and a bare media type. ADR-0013 lists what it cannot
see. Pure and not yet wired or exported; the directive verification, upstream
buffering, and response attachment land in a follow-up PR.
