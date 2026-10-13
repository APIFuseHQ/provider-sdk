---
"@apifuse/provider-sdk": patch
---

Add the internal capture-evidence masking core for health-monitor upstream
capture (ADR-0013, apifuse#2602): `buildCaptureEvidence` composes declared
output sensitive-path redaction, `sanitizeFixture`, and query-free request
provenance into masked evidence of an upstream exchange. Pure and not yet wired
or exported; the directive verification, upstream buffering, and response
attachment land in a follow-up after the deploy freeze.
