---
"@apifuse/provider-sdk": minor
---

Add `untrustedContent(schema)` plus the `APIFUSE_CONTENT_TRUST_META_KEY` / `APIFUSE_CONTENT_PROVENANCE_META_KEY` constants. The helper marks an output field as externally authored text by setting `x-apifuse-content-trust: untrusted` and `x-apifuse-content-provenance: external` on its JSON Schema node, replacing per-provider copies of the same metadata. Validation and parsed values are unchanged.
