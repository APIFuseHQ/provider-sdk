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
- Release publishing only happens from protected release PRs after validation evidence is present
- Do not include real credentials, cookies, HAR files, or private APIFuse infrastructure details in tests or fixtures

## API reports and changesets

Every pull request that changes files under `src/` or `bin/` must add a new Changeset file. Editing or deleting an existing Changeset does not satisfy the gate. Use `bunx changeset` to describe the release intent. For a genuinely no-release change, use `bunx changeset --empty`; an empty changeset is the sanctioned escape hatch and passes the CI gate.

Choose the Changeset level from the committed API report evidence:

- `patch`: no public API surface change.
- `minor`: additive public API surface change only; the `api-reports/` diff contains new lines and does not modify or remove existing report lines.
- `major`: any removed or modified existing line in `api-reports/`, including narrowing the type of an existing field.

Run `bun run api:update` when an exported declaration changes and commit the resulting `api-reports/*.api.md` diff. Reviewers use that committed report diff as the evidence for the semver level. CI runs `bun run api:check` to ensure the report is regenerated from the current declarations and has not been omitted from the pull request.

Every public entry in `package.json`'s `exports` map must be classified by the API report gate. Entries with a `types` condition are typed entry points and require a matching API Extractor config and committed report. Non-typed assets that API Extractor cannot model must have an exact target and rationale in `scripts/api-reports.ts`; any unclassified export fails the gate.
