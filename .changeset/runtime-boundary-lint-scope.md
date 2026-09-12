---
"@apifuse/provider-sdk": patch
---

Runtime boundary lint: parse each file with the script kind its extension implies, and resolve `fetch` shadowing per lexical scope.

- Provider source was parsed as TSX regardless of extension, so a generic arrow (`const identity = <T>(value: T): T => value`) or an angle-bracket assertion (`<number>value`) in an ordinary `.ts` file read as unterminated JSX and everything after it silently dropped out of the AST — `process-env-direct-read`, `node-runtime-module-import`, `direct-fetch-call`, and the `browser-version-literal` / `legacy-choice-usage` rules all went blind for the rest of that file. `.ts`/`.mts`/`.cts` now parse as TypeScript, `.js`/`.mjs`/`.cjs` as JavaScript, `.tsx`/`.jsx` with JSX.
- `direct-fetch-call` treated any `fetch` binding anywhere in the file as shadowing every bare `fetch()` in it, so a transport wrapper `withTransport(fetch)` silenced a raw global `fetch()` in an unrelated function. Shadowing is now resolved against the enclosing scopes of the call (parameters, `let`/`const` in the enclosing block, hoisted `var`, imports, catch variables, named function/class expressions).
