---
"@apifuse/provider-sdk": minor
---

Add `apifuse migrate-shape`, a codemod that migrates a provider `index.ts`
from the single-phase `defineProvider({ ...operations })` shape to the
two-phase declaration builder (`const buildProvider = defineProvider(...)`,
`export default buildProvider({ operations })`).

The transform covers the three measured fleet shapes (direct default export,
intermediate const export, and spread export carrying a `deployment` key),
adds the `ProviderContext` type alias and `ProviderContextOf` import when
missing, is idempotent, and refuses with a reasoned skip (exit 1) on any
shape it cannot fully account for — a skip means the provider needs a manual
migration and its SDK pin must not be bumped without one. Verified against
all 84 `apifuse-provider-*` default-branch sources: 84 migrated, 0 skipped,
84 idempotent on re-run.
