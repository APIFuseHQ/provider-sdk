---
"@apifuse/provider-sdk": minor
---

Session-state layer: the SDK acquires, keeps, carries and renews upstream session state (cookies, header tokens, query tokens) that a provider declares, so provider code keeps only its business logic.

- `defineProvider({ sessionState: { <name>: ProviderSessionState } })` declares named session state in four parts: `acquire` (from the responses of in-scope requests, from a declared acquisition request or handler, or from the connection credential), `carry` (cookies with their attributes, a named cookie, a cookie header, a header with an optional `{value}` template, a query parameter), `validity` (`ttl`, `idleTtl`, `maxUses`, an upstream expiry, an `invalidWhen` judge that is a declarative `ResponseMatcher` or a provider function, `reacquire`, `replayMethods`) and `distribute` (`hosts`, `operations`, `scope`, `qps`, `maxConcurrent`, `egress`).
- `sessionStatePresets.cloudflareBlockPage(options)` returns a plain `ProviderSessionState` for an edge's anonymous bot-management cookie, judged by the exported `CLOUDFLARE_BLOCK_PAGE` matcher. A declaration written by hand with the same values behaves identically.
- Requests select declarations with the new `sessionState` request option (a name, a list of names, or `false`). A response the layer returns after judging it invalid carries `response.sessionState` (`SessionStateClassification`: `name`, `outcome`, `attempts`, `carried`) on `ctx.stealth` and `ctx.http`, whatever `throwOnHttpError` says.
- The provider contract snapshot lists `sessionState`, with provider functions recorded as `true`.
