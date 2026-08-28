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

Report behavior for a syntactically broken `index.ts`: the check still
resolves to a structured 0/100 blocked report instead of rejecting — the
source-scanning checks are skipped for that run and the report carries the
existing `provider-load` blocker plus a new `provider-load-parse` blocker
whose evidence names the parse failure. A broken sibling `.ts` file fails
closed with an error naming that file; filenames rendered into that
diagnostic have control/formatting characters escaped.

`typescript` becomes a runtime dependency of the published package because the
CLI now imports it at check time.
