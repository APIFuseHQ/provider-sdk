---
"@apifuse/provider-sdk": minor
---

Add `apifuse migrate-operation-declaration [path] [--check] [--json]` for the
ADR-0009 provider-fleet migration. The repository-atomic codemod flattens
legacy operation metadata, harvests raw example prose into a locale todo
sidecar, verifies rewritten TypeScript immediately, and exits 2 without
writing when safety, locale keys, composed maps, or non-literal values cannot
be proven.
