---
"@apifuse/provider-sdk": patch
---

`apifuse check` accepts the optional `i18n` locale-coverage block in
`provider.json`.

The APIFuse monorepo has accepted `i18n: { primaryMarket, locales? }` at
`schemaVersion: 1` since the declared-coverage rollout, and
`apifuse provider declare-locale-coverage` writes it — but this check closed
the declaration over four keys and rejected it with `unrecognized_keys`. The
two schemas disagreed, so the only documented way to clear the monorepo's
`LOCALE_COVERAGE_UNDECLARED` finding turned a provider repository's green
`bun run check` red, and the finding was unfixable from either side.

The block is mirrored, not merely tolerated: `primaryMarket` is closed over
`jp | kr | global`, `locales` over `en | ko | ja` with no repeats and a
mandatory `en` (the fallback every other locale resolves through), and the
block itself rejects unknown fields. A typo still fails at authoring time
instead of surfacing later in the monorepo's contract validator.
