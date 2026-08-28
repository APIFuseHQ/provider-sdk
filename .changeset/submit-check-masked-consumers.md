---
"@apifuse/provider-sdk": patch
---

Route the remaining submit-check line/expression scanners through the
trusted comment/string mask.

Measured before this change: `fetch(` inside a comment or documentation
string hard-blocked a submission (`no-raw-fetch` NOISE), `as`-assertion
examples in comments inflated the assertion count, a credential mention in
inert text counted as credential persistence (`credential-usage` BYPASS —
the warning could be suppressed without implementing persistence), a
compact date inside a fixture comment blocked `vendor-timestamp-leak`, and
a brace inside a string/template/comment/regex desynchronized the manual
depth counting that classifies `flat-operation-composition`, letting a
factory-composed operations map pass as static (BYPASS) or blocking a
static map (NOISE).

Depth/classification decisions now run on the masked text while identifier
and evidence extraction still reads raw source at the same offsets
(ExpressionSlice pairs the two); line scanners for raw-fetch, assertion
counting, and credential usage consume masked lines. Rules that
intentionally inspect string literals (vendor shims, describe keys) keep
reading raw source.
