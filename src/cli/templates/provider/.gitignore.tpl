node_modules/

# Environment and local secrets
.env
.env.*
!.env.example

# Build, coverage, cache, and local runtime artifacts
coverage/
dist/
.cache/
.turbo/
.bun/
*.tsbuildinfo

# Bounty submission output
submission-report.md

# OS/editor junk
.DS_Store
Thumbs.db
*.swp

# SDK-managed agent prompt assets. `apifuse sync-assets .` regenerates them
# from the installed @apifuse/provider-sdk on every install (postinstall), so
# they are never committed; contributor-owned notes under
# .agents/skills/upstream-notes/ stay tracked.
AGENTS.md
CLAUDE.md
.claude
.codex
.apifuse/prompt-assets.json
.agents/skills/*/SKILL.md
.agents/skills/upstream-notes/README.md
