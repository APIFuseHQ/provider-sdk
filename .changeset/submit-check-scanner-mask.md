---
"@apifuse/provider-sdk": patch
---

Parse submit-check comment/string masking with the TypeScript scanner.

The mask feeding six submit-check source scanners hand-walked characters and
had no concept of regex literals or template interpolation. A regex such as
`/https?:\/\//` blanked the rest of its line and `/["']/` opened a phantom
string, so real vendor-key leaks could pass and documentation text could
hard-block a submission. The mask is now token-accurate (regex bodies blanked,
`${...}` interpolation kept as code, quoted property keys preserved),
offset-preserving, memoized, and fail-closed: a provider source file that does
not parse aborts the check instead of being scanned desynchronized.

`typescript` becomes a runtime dependency of the published package because the
CLI now imports it at check time.
