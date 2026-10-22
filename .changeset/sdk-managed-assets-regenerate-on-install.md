---
"@apifuse/provider-sdk": patch
---

`apifuse sync-assets` gains `--if-provider-root`: exit 0 without writing when no provider
root (`index.ts`) exists at or above the path, so the command can run as an install hook
inside a Dockerfile's install layer (package.json and lockfile only, before `COPY . .`).

`apifuse create` now scaffolds `postinstall: apifuse sync-assets . --if-provider-root` and
git-ignores the SDK-managed prompt assets (`AGENTS.md`, `CLAUDE.md`, `.claude`, `.codex`,
`.agents/skills/*/SKILL.md`, `.agents/skills/upstream-notes/README.md`,
`.apifuse/prompt-assets.json`). The assets are a pure function of the installed SDK
version, so regenerating them on every `bun install` keeps the `apifuse check` freshness
gate green by construction: an SDK bump that changes only `package.json` and the lockfile
no longer needs a hand-run `sync-assets` commit. Contributor-owned notes under
`.agents/skills/upstream-notes/` stay tracked. Existing providers opt in by adding the same
script and ignore block and untracking the committed copies.
