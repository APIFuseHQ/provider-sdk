---
"@apifuse/provider-sdk": major
---

The provider runtime boundary is enforced at build time instead of by source
grep. `bundleProvider(providerRoot, { mode })` bundles `index.ts` with Bun's
bundler: a resolve plugin judges every module the graph reaches against
`RUNTIME_MODULE_ALLOWLIST` (pure node built-ins), the browser driver packages
and the SDK's `runtime/browser` subpath; `define` rewrites the free globals
`process`, `Bun`, `globalThis`, `global`, `fetch`, `WebSocket`, `Worker`,
`import.meta.env` and `import.meta.require` so the bundler's scope analysis
decides what is a free reference, and the bundle is parsed and judged by
member path (`process.env.APIFUSE__RUNTIME__*`, a few read-only `process`
members and the `Bun` helpers in `BUN_MEMBER_ALLOWLIST` stay allowed). Every
finding names file, line and column from the bundle's source map; an
`import()` or `require()` with a non-literal specifier is a finding on its own.
`apifuse check` prints the result as "Runtime sources reach the outside world
through the SDK context only"; `apifuse submit-check` inherits it in
`standalone` mode, where browser-driver imports are warnings.

Retired rules, deleted with their tests: `process-env-direct-read`,
`node-runtime-module-import`, `direct-fetch-call` (the
`runtime-boundary-lint` module and its exports `lintRuntimeBoundarySources`,
`RUNTIME_BOUNDARY_RULES`, `RuntimeBoundaryRule`,
`LintRuntimeBoundarySourcesOptions`), `playwright-direct-import`,
`browser-self-hosted-launch`, `browser-self-hosted-child-process`,
`browser-self-hosted-remote-debugging-port`, `browser-direct-cdp-version-poll`,
`browser-provider-local-cdp-env`. The `// @apifuse-allow` acknowledgement
for the three boundary rules is gone with them (no fleet provider used it).
`lintProvider` no longer takes an options argument; `ProviderLintMode` is
now the `bundleProvider` mode. `browser-version-literal` and
`stealth-config-required` stay: neither is a reach outside the boundary.
