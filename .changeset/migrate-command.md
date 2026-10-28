---
"@apifuse/provider-sdk": minor
---

`apifuse migrate [path] [--dry-run] [--only <codemod>] [--json]`: one entry point for the
shipped ast-grep codemods (`scripts/codemods/*.yml`). It runs them against a provider checkout in
dependency order (`errors-factory`, `health-refs`, `handles`, `runtime-boundary-allow-comments`)
and prints one summary: files changed per codemod, rewrites, and the residues each codemod leaves
to the author with `file:line` and the rule's message. Exit 0 when nothing is left; 1 when
rewrites are pending (`--dry-run`) or residues remain. No environment detection and no default dry
run: `apifuse migrate --dry-run` is the CI gate. The ast-grep binary is resolved from the
provider's `node_modules/.bin` (`bun add -d @ast-grep/cli`), then the SDK checkout's, then
`PATH`; the error names that prerequisite. AUTHORING.md lists the old shape, the new shape and the
by-hand step per codemod. `@ast-grep/cli` is pinned as an SDK devDependency so the command's test
runs in CI.
