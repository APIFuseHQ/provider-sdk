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

The default key-preserving mask now neutralizes structural and delimiter
characters inside quoted property keys so key text cannot alter depth or
delimiter scanning. Key text remains matchable for range scanners, while the
fully blanked `blankPropertyKeys` variant is available to line scanners.

The flat-operation `operations` property is now located via the TypeScript
AST, so quoted keys, decoy key text, comments, and strings can no longer shadow
or hide it.

The AST locator unwraps `satisfies`/`as` wrappers and resolves the curried
`defineProvider(meta)(impl)` form to the implementation call. A new
`no-dynamic-code` blocker rejects `eval`/`Function` in provider source,
replacing the incidental coverage the masked text scan removed.

Computed keys and non-enumerable spreads in the implementation object now fail
closed even when a literal `operations` property is present, and
`no-dynamic-code` now resolves sinks on the TypeScript AST so member and
indirect `eval`/`Function` calls are rejected.

Default-export type assertions are unwrapped before the builder call is resolved; accessor/method `operations` members and element-access `eval`/`Function` sinks fail closed; locally shadowed `eval`/`Function` identifiers are not flagged.
