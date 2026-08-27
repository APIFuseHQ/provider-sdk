---
"@apifuse/provider-sdk": minor
---

Log a redacted `causeChain` on `provider_request_failed` so the underlying reason for a wrapped provider failure survives the log boundary. Provider code frequently attaches the real error via `ProviderErrorOptions.cause`, but the server logger previously recorded only the outermost class, code, and message, leaving operators with a generic provider-authored string and no way to tell one failure from another.

Each frame carries `errorClass`, an optional `code`, `messageLength`, and a 12-hex-character sha256 `messageFingerprint`. Raw cause message text is never logged, because upstream messages can contain credentials, tokens, or personal data; the length and fingerprint are enough to distinguish a repeating failure from a new one without exposing content. The walk stops after 5 frames and on a repeated object reference, so a hostile or buggy upstream cannot drive an unbounded log line.

The public error body is unchanged: `causeChain` exists only on the server log, and the key is omitted entirely when an error has no cause.
