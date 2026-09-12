---
"@apifuse/provider-sdk": patch
---

`apifuse check` now reports provider runtime code that bypasses the SDK context — three new authoring lint rules, all **warn** level in this release.

`providers/AGENTS.md` in the platform monorepo has long said "no `node:fs`/`node:net`/`child_process`, no direct `fetch()`, no `process.env` — use `ctx.http` / `ctx.stealth` / `ctx.env` / `ctx.credential`", but nothing enforced it: the SDK lint had no such rule and the fleet accumulated 66 `process.env` reads across 14 providers, raw `fetch()` in an auth flow, and `node:fs` / `Bun.spawn` in request-path modules. The rule now exists in the SDK where the other authoring rules live.

- `process-env-direct-read` — `process.env.X`, `process.env["X"]`, a bare `process.env` object use (spread, pass-through, dynamic key), and the `Bun.env` / `globalThis.process.env` forms. The `APIFUSE__RUNTIME__*` bootstrap family (`APIFUSE__RUNTIME__PORT`, `APIFUSE__RUNTIME__POD_ID`, `APIFUSE__RUNTIME__POD_ENDPOINT`, …) is exempt everywhere because `serve()` callers read it before a context exists. Everything else belongs in `defineProvider({ secrets: [{ name, required }] })` / `env: true` and is read with `ctx.env.get(name)` so the presence gate, redaction, and Doppler projection see it.
- `node-runtime-module-import` — value imports of `fs`, `fs/promises`, `net`, `tls`, `dgram`, `http`, `https`, `http2`, `child_process` (with or without `node:`) through `import`/`export … from`, `import =`, `require()`, or dynamic `import()`, plus `Bun.spawn`, `Bun.spawnSync`, ``Bun.$` ` ``, `Bun.file`, `Bun.write`. Clause-level `import type` is erased and ignored; `node:path`, `node:crypto`, `node:url`, `node:buffer` are not in the set.
- `direct-fetch-call` — a call to the global `fetch` (bare identifier or `globalThis`/`window`/`self`/`global` member). `ctx.stealth.fetch()` is a member call and never matches; a file that declares its own `fetch` binding (parameter, variable, import, function) is calling that binding, not the global, and is left alone.

**Scope** is the provider *runtime* source: JavaScript/TypeScript files minus tests, recorded fixtures, `.d.ts`, the root bootstrap entrypoints (`dev.ts`, `start.ts`, `deploy.ts`), and the operator tooling directories at the provider root (`scripts/`, `tools/`, `bin/`). Tooling legitimately reads the ambient environment and the filesystem when a human runs it; the rule is about code the pod executes on behalf of a request. Nested directories with those names (`upstream/scripts/`) stay in scope.

One diagnostic is emitted per file and rule, listing every subject with its line (`process.env.APIFUSE__E2E__FAKE_KMA (line 2341, 2556)`), so a file with thirty reads is one line in the check output, not thirty.

**Escape hatch.** `// @apifuse-allow <rule>: <reason>` on the finding line or the line directly above it — the same syntax the submit check uses — moves that finding out of the diagnostics and into the `INFO` audit lines of `apifuse check`, with the reason. The rule id must match; an acknowledgement for a different rule does not silence the line.

Warn level does not fail `apifuse check`; it is the migration window. The fleet worklist and per-provider guidance are tracked in the platform monorepo; the level is raised to error once the request-path hits are gone. Nothing changes at runtime.
