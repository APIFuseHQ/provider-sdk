---
"@apifuse/provider-sdk": minor
---

`apifuse migrate [path] [--dry-run] [--only <codemod>] [--json]`: one entry point for the
shipped ast-grep codemods (`scripts/codemods/*.yml`). It runs them against a provider checkout in
dependency order (`errors-factory`, `health-refs`, `handles`, `runtime-boundary-allow-comments`, `schema`)
and prints one summary: files changed per codemod, rewrites, and the residues each codemod leaves
to the author with `file:line` and the rule's message, plus what each rewrite moved out of the file
when its rule says so (a `.describe()` prose to carry into the locale catalog). Exit 0 when nothing
is left; 1 when rewrites are pending (`--dry-run`) or residues remain; 2 on a usage error. No environment detection and no default dry
run: `apifuse migrate --dry-run` is the CI gate. The ast-grep binary is resolved from the
provider's `node_modules/.bin` (`bun add -d @ast-grep/cli`), then the SDK checkout's, then
`PATH`; the error names that prerequisite. AUTHORING.md lists the old shape, the new shape and the
by-hand step per codemod. `@ast-grep/cli` is pinned as an SDK devDependency so the command's test
runs in CI.

`scripts/codemods/errors-factory.yml`: an `errorCodes` row written inline with `status` or
`description` is no longer rewritten to a bare `errors.X` reference (which dropped the row's
contract); the list is left whole and the new `errors-factory-inline-row-hoist` diagnostic names
the row with the hoist step. A multi-line throw rest keeps its comma, a `{ code, name }` lookup
table is no longer mistaken for an error table, and a non-identifier code becomes `errors["429"]`.
The `legacy-handle-declaration` lint message now points at `apifuse migrate --only handles`.
