# @apifuse/provider-sdk Changelog

## 2.2.0-beta.4

- Release candidate for main commit 73f2c6ec429c2fbce8ac458a67111e4844b99178.

## 2.2.0-beta.3

- Release candidate for main commit 74e8e18b502dd9b02dbf0d3e702f917570312fc0.

## 2.2.0-beta.2

- Release candidate for main commit ceefad020a1038eade542fd3b128667b39625f6f.

## 2.2.0-beta.1

- Release candidate for main commit 5056b8c89fe0fa8f10bafcd30f83bcc421d4b5c5.

## 2.1.0-beta.22

- Release candidate for main commit af84b1e91c408b69773468fdaef80a01a36707cf.

## 2.1.0-beta.21

- Release candidate for main commit 8124b3eb150cc7a73a86a95266b3747763a494ae.

## 2.1.0-beta.20

- Release candidate for main commit 2a07cc5aef0d517c3b01d20445105f1669446bd3.

## 2.1.0-beta.19

- Release candidate for main commit 71d76385f722b1202880f26b14ea3916a07852eb.

## 2.1.0-beta.18

- Release candidate for main commit 46f93ecf8c2c8aab1afd0f23f5f62a87cbb45f6d.

## 2.1.0-beta.17

- Release candidate for main commit c4466ffc8a30cb99740b50687a62b92cec9ba10e.

## 2.1.0-beta.16

- Release candidate for main commit c0d8a1c4be519e1c1abc59e0304efc64f371634d.

## Unreleased

- Add `arrayBuffer()` and `bytes()` to `HttpResponse` so `ctx.http` consumers can read binary-safe upstream bodies; internal response handling is now byte-first.
- Preserve identity-only operation `connectionId` values in `ProviderContext` without requiring credential material.

## 2.1.0-beta.15

- Release candidate for main commit 4f51232d87828082f117dcc9f0c257a46f37c040.

## 2.1.0-beta.14

- Release candidate for main commit 6eb132be6abf34ad9a70bfe28c6d26b36348ff4a.

## 2.1.0-beta.13

- Release candidate for main commit d7b12716f54781df3e40206144c167844a485f8f.

## 2.1.0-beta.12

- Release candidate for main commit 2bc1061c6a68facaa2efde08bee31bf5cd96945e.

## 2.1.0-beta.11

- Release candidate for main commit b98ddc5024698f8c79e05e3295f7c8c8e8fe5a8a.

## 2.1.0-beta.9

- Preserve raw stealth response bytes through the public SDK response wrapper.
- Add `arrayBuffer()` and `bytes()` to `StealthResponse` so consumers can inspect binary-safe upstream bodies.

## 2.1.0-beta.8

- Fix release automation for compiled `dist` package exports by building before package self-tests.
- Provide `GH_TOKEN` to the GitHub release creation step.

## 2.1.0-beta.7

- Publish compiled `dist` exports for npm consumers so Next.js/Vercel builds do not parse TypeScript from `node_modules`.
- Keep public CLI/template source files in the package while routing library exports through generated JavaScript and declarations.

## 2.1.0-beta.6

- Public repository clean-import release for `APIFuseHQ/provider-sdk`.
- Preserves the monorepo SDK exports required by ApiFuse provider registry cutover, including `./contract` and provider i18n helpers.


## 2.1.0-beta.5

- Republish the bounty workspace DX hardening that accepts generated readonly metadata and factored `defineOperation()` maps during standalone TypeScript checks.
- Ensure new bounty workspaces can install the public SDK version that matches their generated scaffold and pass `bun run check` immediately after bootstrap.

## 2.1.0-beta.4

- Align `apifuse create` with the bounty program topology: external contributors use the standalone one-provider-repository scaffold even when their assigned repo contains workspace-like files.
- Stop auto-detecting `providers/` directories as public monorepo scaffolds. `--preset monorepo` is now reserved for the private APIFuse monorepo where `packages/provider-sdk` is actually present.
- Remove public CLI/docs examples that present monorepo placement as a contributor workflow.

## 2.1.0-beta.3

- Replace the legacy TypeScript request transport with `ctx.stealth`, backed by `impit` browser-grade TLS/HTTP2 impersonation without Python runtime dependencies.
- Add the public `apifuse submit-check` / `apifuse bounty-check` CLI for score-based pre-submission provider quality checks.
- Ship `SUBMISSION.md` in the npm package so bounty contributors can follow the checklist without access to the private monorepo.
- Include submit-check in generated provider validation scripts and packed-artifact smoke coverage.
- Warn, instead of hard-block, generated OAuth starters that have not yet declared persisted credential keys.

## 2.1.0-beta.2

- Harden public bounty contributor DX with server-contract accurate README and generated Provider smoke examples.
- Add packed-artifact regression checks so stale `connection: null` or missing `requestId` examples cannot ship again.
- Extend clean-room packed SDK smoke coverage to boot the generated dev server and call `/health` plus `POST /v1/ping`.
- Document credential, auth-flow, stealth, browser, and Bun trusted-dependency troubleshooting for SDK-only local development.

## 2.1.0-beta.1

- Fix public `apifuse create` runtime packaging by publishing `@clack/prompts` as a production dependency.
- Update generated Provider starter templates so the sample operation declares a local-only `healthCheckUnsupported` and passes the current health coverage contract.
- Add packed-artifact smoke coverage for the public create/check/test flow before npm release publishing.
- Document the public SDK-only bounty contributor path and maintainer-owned monorepo import boundary.

## 2.1.0-beta.0

- BREAKING: collapse the Chrome desktop stealth catalog to `chrome-146` plus the `chrome-desktop` alias. Removed/blocked `chrome-120`, `chrome-124`, `chrome-129`, `chrome-130`, `chrome-131`, `chrome-133`, `chrome-144`, `chrome-146-psk`, `chrome-131-psk`, `chrome-130-psk`, and `edge-131`; migrate callers to `chrome-146`.
- Make removed Chrome/Edge stealth profile names fail loudly with `SDKError("Unknown stealth profile: <name>")` instead of falling through to a raw TLS identifier.

## 2.0.0-beta.2

- Improve `defineProvider()` operation handler inference from Zod and Standard Schema inputs.
- Add `defineOperation()` for factored, composable operation declarations.
- Add descriptive `defineProvider()` validation errors for missing fields, invalid runtime/auth modes, and path-conflicting operation ids.
- Improve `runStandardTests()` fixture failures with current/expected JSON diffs.
- Document provider authoring ergonomics and public schema-related types.
