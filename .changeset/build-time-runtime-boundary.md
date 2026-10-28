---
"@apifuse/provider-sdk": minor
---

The provider runtime boundary is enforced at build time instead of by source
grep. `bundleProvider(providerRoot, { mode })` bundles `index.ts` (the
provider definition) and `start.ts` (what the pod runs with `bun run start`,
when it exists) with Bun's bundler: a resolve plugin judges every module the
graph reaches against `RUNTIME_MODULE_ALLOWLIST` (pure node built-ins; any
`node:` specifier counts as a built-in whether or not this Bun ships it), the
browser driver packages and the SDK's `runtime/browser` subpath; `define`
rewrites the free globals `process`, `Bun`, `globalThis`, `global`, `self`,
`fetch`, `WebSocket`, `Worker`, `import.meta.env` and `import.meta.require` so
the bundler's scope analysis decides what is a free reference, and the bundle
is parsed and judged by member path through any chain of the three
global-object names (`globalThis.self.fetch` is `fetch`;
`process.env.APIFUSE__RUNTIME__*`, a few read-only `process` members and the
`Bun` helpers in `BUN_MEMBER_ALLOWLIST` stay allowed). `require` held as a
value (`const r = require`, `require.main.require(...)`) is a finding, as is an
`import()` or `require()` with a non-literal specifier. Every finding names
file, line and column from the bundle's source map. Findings inside the root
`dev.ts` / `start.ts` / `deploy.ts` files themselves are dropped, as the
source rules dropped them; a module only `start.ts` imports is judged.
`apifuse check` prints the result as "Runtime sources reach the outside world
through the SDK context only"; `apifuse submit-check` inherits it in
`standalone` mode, where browser-driver imports are warnings.

Retired rules, deleted with their tests: `process-env-direct-read`,
`node-runtime-module-import`, `direct-fetch-call`, `playwright-direct-import`,
`browser-self-hosted-launch`, `browser-self-hosted-child-process`,
`browser-self-hosted-remote-debugging-port`, `browser-direct-cdp-version-poll`,
`browser-provider-local-cdp-env`. The `// @apifuse-allow` acknowledgement
for the three boundary rules is gone with them (no fleet provider used it).
`browser-version-literal` and `stealth-config-required` stay: neither is a
reach outside the boundary.

Deprecated for one release, removed in the next major:
`lintRuntimeBoundarySources(files, options)`, `RUNTIME_BOUNDARY_RULES`,
`RuntimeBoundaryRule` and `LintRuntimeBoundarySourcesOptions` keep their
signatures; the function now writes `files` to a temporary directory, runs
`bundleProvider` on it and maps each violation to the old diagnostic shape
(`field: "sourceFiles.<file>"`, nearest old rule id, lines in the message),
with `options.typescript` ignored and one runtime warning. `lintProvider` and
`lintProviderWithInformation` keep accepting the `options` argument and ignore
it with one runtime warning; `ProviderLintMode` is now the `bundleProvider`
mode. Nothing public is removed in this release.
