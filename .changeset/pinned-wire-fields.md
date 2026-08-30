---
"@apifuse/provider-sdk": minor
---

Add exact-path public-schema wire-field pins under `meta.contract.pinnedWireFieldPaths`.

Pins require a non-empty reason, suppress only an exactly matching
`public-schema-upstream-field` diagnostic, remain visible as informational
`apifuse check` output, and fail when their path becomes stale.
