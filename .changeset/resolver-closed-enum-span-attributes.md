---
"@apifuse/provider-sdk": patch
---

Keep resolver closed-enum span attributes when diagnostic redaction has failed closed.

After the process fallback registry is exhausted, free-text diagnostics read `[REDACTION_FAILED]` while SDK-owned closed enums are meant to survive like typed numbers. The exemption was a hand-kept list of attribute keys (`outcome`, `code`, `errorClass`, `phase`, `cacheStatus`, `identitySource`, `taxonomy`, `taxonomyVersion`) that no span producer used except `outcome`. The closed-enum attributes the resolver actually emits (`vendor`, `challenge_kind`, `endpoint`, `billing`, `unavailability_reason`, `verdict_reason`, `transport_phase`, `resolver_identity_source`, `operation`) were therefore suppressed, including the `resolver.usage` metering span's vendor, endpoint and billing.

The exemption now comes from the resolver span producers' own declaration: each closed-enum attribute key with every literal it can carry, checked against the source union types at compile time. A span value is exempt only when it is one of the declared literals for its key; any other value under the same key stays free text, and registered credentials are matched either way. Resolver span attributes are built through a typed helper, so a new attribute typed as a finite string union that is not declared fails to compile. Keys no span producer declares (`code`, `errorClass`, `phase`, `cacheStatus`, `identitySource`, `taxonomy`, `taxonomyVersion`, including operator resource attributes with those names) are now treated as free text in fail-closed mode.

The provider telemetry header and operator log are unchanged: their closed-enum fields never passed through span attribute redaction, and whether `attemptSamples[].c` should survive fail-closed mode remains open (#291 item 1).
