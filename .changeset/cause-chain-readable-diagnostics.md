---
"@apifuse/provider-sdk": minor
---

Make `provider_request_failed` cause-chain diagnostics readable to operators without exposing them in the public error body. #187 shipped fingerprint-only cause frames, which preserved correlation but left the SDK's only internal diagnostic channel unable to explain an upstream failure.

Each cause frame now retains its existing class, optional code, original message length, and fingerprint while also carrying a redacted `message`. The shared diagnostic sanitizer removes personal and credential material, preserves correlation identifiers and useful URL provenance without allowing upstream text to forge or reorder URLs, encodes control characters, and visibly truncates hostile upstream text to the existing 300-character diagnostic bound. The public response remains unchanged.
