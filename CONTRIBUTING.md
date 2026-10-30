# Contributing to APIFuse Provider SDK

Thanks for contributing. This repository is the public source of truth for `@apifuse/provider-sdk`.

## Development

```bash
bun install --frozen-lockfile
bun test
bun run check
bun run pack:check
bun run pack:smoke
```

## Pull requests

- PRs from forks run without secrets
- Release publishing only happens from a release PR whose validation evidence the Release PR Guard produced for the exact candidate SHA; merging that PR publishes to npm right away, so the merge is the approval
- Do not include real credentials, cookies, HAR files, or private APIFuse infrastructure details in tests or fixtures

## Bump safety scan (required before a PR that changes a served contract or a public type)

A provider must keep loading, compiling and serving the same wire contract when it bumps the SDK without changing its own code. That is proven by a fleet scan, not claimed in the PR body:

```bash
bun scripts/bump-safety-scan.ts --base origin/main --head HEAD
bun scripts/bump-safety-scan.ts --base origin/main --head HEAD --json > scan.json
```

`--base` and `--head` take a git ref of this repository or a directory that holds a build. The default targets are every provider checkout this host knows (`~/projects/apifuse-provider-*`, the apifuse `.provider-workspace/providers/*` and `providers-staging/*` workspaces) plus the apifuse test files that author `defineProvider` fixtures inline, which run as tests in a staged copy of the monorepo with the SDK swapped. `--targets <glob,...>` narrows the provider set, `--apifuse <dir>` points at another monorepo checkout and `--no-fixture-tests` skips it.

Each target gets a shadow copy whose `node_modules/@apifuse/provider-sdk` and `zod` are symlinks to the build under test (a `--preload` resolve plugin does not fire for bare specifiers, so it would compare base to base). Per target and side the scan records module load, `tsc --noEmit` errors, the served contract digest (`digestProviderContract`), authoring lint diagnostics by rule and runtime warnings, then prints one diff table:

- `BREAK`: the provider loaded or compiled on base and fails on head, or its contract digest changed. The command exits 1. Either the change gets a one-release deprecation path (DX rule 4) or the PR body lists every affected provider with `file:line` and the migration.
- `WARN`: a new error-level lint rule or a new runtime warning on head. List them in the PR body.
- `NOT COVERED`: the target fails on both sides (a provider that does not load, or a fixture test file that fails on base as well), so the diff says nothing about it. The row carries the failure class, the JSON carries `covered: false`, and the `not covered` section lists them; say so in the PR body when one of them is deployed.

The second table counts the one-release window rules across the targets. Today those are the two public-schema description paths the next release refuses: `schema-describe-prose` (a public schema field described with raw `.describe()` prose) and `schema-missing-key` (a public schema field with no description at all). A target counts as a user when the BASE SDK itself says so: the `signal` column names the source per rule, a base lint rule id when the rule has one, else the once-per-provider `defineProvider` warning (the two schema rows read the `(raw .describe() prose)` and `(no description)` field tags of the locale-key warning); nothing is regex-matched over source text. The table inherits that signal's coverage: a use the base lint or warning does not see counts 0 there while the tsc set diff still marks the provider BREAK, so read `DELETABLE` together with a BREAK-free verdict table. A rule and the path it guards can be deleted only when that table shows 0 users on a default-target run; a PR that deletes one quotes the row, and once that PR merges the row is removed from the table (the last scan on the pre-deletion base is the deletion's evidence).

Several local directories can be checkouts of one provider repository (review worktrees, a clone made under a repository's old GitHub name). Checkouts that share a root commit or a normalized `origin` URL are one repository: at the same HEAD they are scanned once (`duplicate clones` section), at different HEADs only the newest commit gates and the others appear as `stale clone (<verdict>)`, outside the summary and the exit code.

Paste the summary line, the BREAK/WARN rows and the window-rule table into the PR body. The window-rule table is computed over the targets of that run, so read the deletion gate only from a default-target run. Scratch copies go under `/mnt/scratch/tmp/bump-safety-scan` (or `$TMPDIR`); the staged copies are removed unless `--keep` is passed, the SDK builds under `<scratch>/sdk/<sha>` stay as a cache.

## API reports and changesets

Every pull request that changes files under `src/` or `bin/`, changes `package.json`'s `exports` map, or changes `config/api-extractor/` must add a new Changeset file. Other `package.json` edits, such as version-only or dependency-only changes, do not trigger this requirement. Editing or deleting an existing Changeset does not satisfy the gate. Use `bunx changeset` to describe the release intent. For a genuinely no-release change, use `bunx changeset --empty`; an empty changeset is the sanctioned escape hatch and passes the CI gate.

Choose the Changeset level from the committed API report evidence:

- `patch`: no public API surface change.
- `minor`: additive public API surface change only; the `api-reports/` diff contains new lines and does not modify or remove existing report lines.
- `major`: any removed or modified existing line in `api-reports/`, including narrowing the type of an existing field.

Run `bun run api:update` when an exported declaration changes and commit the resulting `api-reports/*.api.md` diff. Reviewers use that committed report diff as the evidence for the semver level. CI runs `bun run api:check` to ensure the report is regenerated from the current declarations and has not been omitted from the pull request.

API reports include declarations reached through `ae-forgotten-export` references so changes inside those types remain visible. Existing intentional warnings are listed exactly, with a rationale, in `scripts/api-reports.ts`; any new warning or stale allowance fails the gate. `api:check` also rejects report files with no owning API Extractor config, while `api:update` deletes those orphaned reports so removed entry points appear in the pull request diff.

Every public entry in `package.json`'s `exports` map must be classified by the API report gate. Entries with a `types` condition are typed entry points and require a matching API Extractor config and committed report. Non-typed assets that API Extractor cannot model must have an exact target and rationale in `scripts/api-reports.ts`; any unclassified export fails the gate.
