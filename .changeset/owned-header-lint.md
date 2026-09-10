---
"@apifuse/provider-sdk": patch
---

`apifuse check` now reports stealth-owned header names (#272 Part B).

Since 2.2.0-beta.49 `ctx.stealth` rejects a caller value for `sec-fetch-*`, `sec-ch-ua`, `sec-ch-ua-mobile`, and `sec-ch-ua-platform` at request time with `STEALTH_HEADER_OVERRIDE_UNSUPPORTED` (HTTP 500 through `serve`), but `apifuse check` passed such providers. The `browser-version-literal` lint now errors on those header names — as object keys, `headers.set(name, value)` calls, `[name, value]` tuples, or `headers[name] = value` assignments — in every source file that reaches the stealth client (`ctx.stealth`, `ctx["stealth"]`, or `const { stealth } = ctx`; comments do not count). A file that only uses `ctx.http` is not affected and may keep setting `Sec-Fetch-*`, but the scope is per file: a module that mixes `ctx.http` and `ctx.stealth` reports its `ctx.http` headers too, and the rule has no per-diagnostic suppression — split the two transports into separate files. Owned-name predicates (`name.startsWith("sec-fetch-")`), name lists, and non-setter calls are not header entries and are ignored, as is a statically `undefined` record entry (`{ name: undefined }`, `headers[name] = undefined`), which the runtime drops before the ownership check.

Migration: delete the header and declare the request shape with `stealth: { requestClass: "navigation" | "xhr" | "post" }` (`POST` infers `post`, everything else `navigation`; `Sec-Fetch-Site` is derived from `Referer`). Client hints follow `stealth: { browser, os }`.

Internally the owned-header set moved to `src/runtime/stealth-owned-headers.ts`, which the stealth transport and the lint both read; the runtime rejection is unchanged.
