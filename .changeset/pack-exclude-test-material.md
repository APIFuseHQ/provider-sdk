---
"@apifuse/provider-sdk": patch
---

Stop publishing test material in the npm tarball. `files` only negated the top-level `src/__tests__`, so `src/cli/__tests__/fixtures/**` (180 codemod fixtures describing internal provider deployment intent) and any `bin/__tests__/**` file were packed. The tarball drops from 761 to 598 files; no public entry point, template or type changes, and no consumer ever imported these paths. `bun run pack:check` now fails on any packed path under a `__tests__` directory or ending in `.test.ts`/`.spec.ts`, so a new test directory cannot silently escape the `files` negations again.
