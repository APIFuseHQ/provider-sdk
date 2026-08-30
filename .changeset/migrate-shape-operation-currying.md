---
"@apifuse/provider-sdk": minor
---

Extend `apifuse migrate-shape` to also curry legacy operation helpers.

`defineOperation` / `defineStreamOperation` became curried, context-typed
factories in the phase-separated SDK. A legacy `defineOperation(config)` call
still type-checks against an older pin, but under the current SDK it returns
the inner factory with the config swallowed, so every operation in the map
becomes a function and `finalizeProvider` rejects the provider with a
misleading "declares neither healthCheck nor healthCheckUnsupported" error.

The command now runs two coordinated passes: the existing two-phase provider
shape migration on `index.ts`, then operation currying across the provider's
source tree (`defineOperation(config)` to
`defineOperation<ProviderContext>()(config)`, adding the
`import type { ProviderContext } from "../index"` when the module lacks it).
Files mixing legacy and curried forms are a reasoned skip, and any skip exits
1 — never pair a pin bump with a skipped migration.

Measured against all 84 `apifuse-provider-*` repositories with the pin moved
to 2.2.0-beta.41: 83 of 84 load successfully end to end (450 legacy call
sites across 53 repositories curried); the one remainder builds its provider
inside a factory function and is a documented manual migration.
