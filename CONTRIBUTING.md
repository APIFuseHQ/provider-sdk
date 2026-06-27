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
