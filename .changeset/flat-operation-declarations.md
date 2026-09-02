---
"@apifuse/provider-sdk": major
---

Flatten operation declarations per ADR-0009. Operations now require `riskClass`,
declare access, approval, execution, localized prose, examples, and error codes
at the top level, and no longer support the legacy `annotations`, `toolRouter`,
`docs`, derivation, or input-example containers.
