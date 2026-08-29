---
"@apifuse/provider-sdk": patch
---

Resolve same-file const bindings in submit-check source scanners.

Raw global fetch calls are now detected through const aliases, global object
members, computed access, comma-indirect calls, and globalThis destructuring
without flagging SDK HTTP paths or lexically shadowed fetch/global-object
bindings. The same lexical resolver detects eval/Function aliases, including
destructuring them from `globalThis`; this is an intentional tightening of the
dynamic-code blocker. Unreassigned `let`/`var` aliases resolve to protected
sinks, while any reassignment to that lexical binding leaves it unresolved.

Credential persistence recognizes destructured and computed context access,
public schema computed keys and fixture timestamps resolve literal consts, and
public-output schema classification follows local output/response reachability.
Export reachability follows const alias chains, while parse-only internal schemas
remain private and interpolated computed keys remain unresolved. Secret-scan
remediation also derives environment names from assigned properties instead of
nearby type annotations. Exported schema bindings in `index.ts` remain public
candidates even when locally inert, while non-exported internal const schemas can
be proven private.
