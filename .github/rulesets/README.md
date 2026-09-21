# Repository rulesets (committed = live)

The JSON files here are the source of truth for the live GitHub rulesets of
`APIFuseHQ/provider-sdk`. This mirrors the monorepo convention
(`APIFuseHQ/apifuse` `.github/rulesets/`): policy is edited as a reviewable
file in a pull request, then applied, rather than clicked into the repository
settings UI where nothing records who changed what or why.

| File | Live ruleset | Protects | Enforcement |
|---|---|---|---|
| `main-protection.json` | `main-protection` | `refs/heads/main` | `active` since 2026-09-21 |

## Why this repository needs it

`main` had **no ruleset and no branch protection at all** until 2026-09-21
(`GET /repos/APIFuseHQ/provider-sdk/rulesets` returned `[]`;
`GET .../branches/main/protection` returned 404 "Branch not protected"). Every
write path was open: a direct push to `main` needed no pull request, no review
and no green CI, and `main` could be force-pushed or deleted outright. This was
not theoretical — `d3927d5` ("ci: read Doppler GitHub App credentials per key in
release workflows") landed on `main` with no pull request number.

That matters more here than in a normal repository. This package is the floor
the whole provider fleet pins: every `APIFuseHQ/apifuse-provider-*` repository
depends on `@apifuse/provider-sdk`, so anything that reaches `main` reaches a
published npm release and from there the entire fleet. `release.yml` publishes
on a merged `release/beta-*` / `release/v*` pull request, and while that job
does re-verify the candidate against release-guard evidence, nothing was
gating the merges that build the tree it publishes *from*.

## What the rules do

- **`deletion`, `non_fast_forward`** — `main` cannot be deleted or force-pushed.
- **`pull_request`** — writes to `main` go through a pull request. Review
  threads must be resolved. `required_approving_review_count` is **0**: this is
  a single-maintainer repository, and the monorepo made the same call for the
  same reason — a non-zero count no one can satisfy is a gate that gets
  bypassed, not a gate that holds.
- **`required_status_checks`** with `strict_required_status_checks_policy: true`
  — the head must be up to date with `main`, so the required checks have run on
  the tree that actually lands, not on a stale base.

### Required contexts, and why exactly these two

Both are GitHub Actions checks (`integration_id: 15368`). The rule for picking
them is that a required context must report on **every** pull request to `main`,
otherwise a pull request that never produces it blocks forever.

- **`SDK CI`** (`ci.yml`, job `test`) — the build/test/lint/API-surface/pack
  gate. `on: pull_request` with no path filter, so it always reports.
- **`guard`** (`release-guard.yml`, job `guard`) — release validation. The
  *workflow* triggers on every pull request to `main`; the *job* is skipped by a
  job-level `if` unless the head branch is `release/beta-*` or `release/v*`. A
  job skipped by a job-level `if` still posts a check run (conclusion
  `skipped`), and GitHub counts `skipped` as satisfying a required status check
   — so ordinary pull requests are unaffected while a release pull request
  cannot be merged with release validation red. Requiring it is what turns
  release-guard from a publish-time artifact lookup into a *merge* gate.

Deliberately **not** required:

- **`Publish package`** (`release.yml`) — triggers on `pull_request:
  types: [closed]`, so it never reports on an open pull request and would block
  every merge.
- **`[code]smith`** — third-party (Blacksmith), not a correctness gate.

## Bypass

`OrganizationAdmin` keeps `bypass_mode: always`, matching the monorepo. This is
the owner's out-of-band write to `main`; it means the ruleset binds every other
actor (including any app installation or compromised token) but not the owner.
Narrowing or removing it is an owner decision, not a side effect of another
change.

## Applying and checking

Committed JSON is only the source of truth if someone reconciles it with the
live ruleset. Both commands need a token with repository admin scope.

Apply (create the ruleset the first time):

```sh
gh api -X POST repos/APIFuseHQ/provider-sdk/rulesets \
  --input .github/rulesets/main-protection.json
```

Update an existing ruleset (look up the id first):

```sh
RULESET_ID=$(gh api repos/APIFuseHQ/provider-sdk/rulesets \
  --jq '.[] | select(.name == "main-protection") | .id')
gh api -X PUT "repos/APIFuseHQ/provider-sdk/rulesets/$RULESET_ID" \
  --input .github/rulesets/main-protection.json
```

Check for drift between this file and the live ruleset:

```sh
RULESET_ID=$(gh api repos/APIFuseHQ/provider-sdk/rulesets \
  --jq '.[] | select(.name == "main-protection") | .id')
diff <(jq -S '{name,target,enforcement,conditions,bypass_actors,rules}' \
        .github/rulesets/main-protection.json) \
     <(gh api "repos/APIFuseHQ/provider-sdk/rulesets/$RULESET_ID" \
        | jq -S '{name,target,enforcement,conditions,bypass_actors,rules}')
```

`conditions` is in the projection deliberately. Without it the comparison
cannot see *which* branches the live ruleset protects: retargeting the ruleset,
or adding `refs/heads/main` to `conditions.ref_name.exclude`, removes all
protection from `main` while leaving the rules identical — and a projection
that drops `conditions` reports that as no drift (reproduced against this file
on 2026-09-21: injecting that exclusion left the projected output byte-identical
and the `diff` exited 0).

Note that the live `bypass_actors[].actor_id` for `OrganizationAdmin` reads back
as `null` rather than the `1` that is sent on write; that one field is expected
to differ and is the only known benign diff.

Changing policy means editing the file first, merging it, then running the
update command above. A live-only edit shows up as drift in the next check.
