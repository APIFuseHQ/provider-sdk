# @apifuse/provider-sdk Changelog

## 2.2.0-beta.36

- Release candidate for main commit c6858f8b87d78b3b755adeb28982e875434be406.

## 2.2.0-beta.35

- Release candidate for main commit 027fa0087b883a6281bc6d8bdaaf6d0be382000f.

## 2.2.0-beta.34

- Release candidate for main commit 383a97e7d0ce995d098d5f95c9ffdcbeed13de31.

## 2.2.0-beta.33

- Release candidate for main commit e7d854ec3e859702b22e2b37eaa2ae6bd4545c80.

## 2.2.0-beta.32

- Release candidate for main commit 82f1c0c1de916a40c8c74b1d6470a493b134c0ed.

## 2.2.0-beta.31

- Release candidate for main commit 94006be0852918867d254dc23d0fa8420a07be9c.

## 2.2.0-beta.30

- Release candidate for main commit ccf3d56bfcbe9683c6e7ad45dde8e6703467f9e7.

## 2.2.0-beta.29

- Release candidate for main commit b7243459ab12403e11d7b5b93292f09b734b0a96.

## 2.2.0-beta.28

- Release candidate for main commit 2936f1891d4e2326502f0585081f8a58060d6dd7.

## 2.2.0-beta.27

- Release candidate for main commit 579d9e7fd22d8414b151be2b71a43a0990456911.

## 2.2.0-beta.26

- Release candidate for main commit 924fe13d1101e7840d799a562a7a70174355185d.

## 2.2.0-beta.25

- Release candidate for main commit e6df658b95c0728b671fd221919ec2f85f82b0b7.

## 2.2.0-beta.24

- Release candidate for main commit 0f21a2959dcbb9b96fe426259259d0870cfc537f.

## 2.2.0-beta.23

- Release candidate for main commit 36b3bedc9c14913c4152c4631cc87de71062f21f.

## 2.2.0-beta.22

- Release candidate for main commit b8bf920b5ca053d1bf43018167fd4eedff01700d.

## Unreleased

- Server-stored provider choices now issue word-format tokens unconditionally. The runtime issuance setting and legacy issuance path were removed.
- **Breaking:** Legacy encrypted server-handle choice tokens are no longer parsed. They are rejected with the uniform choice-not-found error; server-stored choices are now word-only. Encrypted inline choice tokens remain supported.
- Added the `thrown-error-code-undeclared` authoring lint (warning level): `apifuse check` now statically flags literal `ProviderError`/`ValidationError` codes that are neither SDK-registered nor declared in any operation's `docs.errorCodes`, surfacing the runtime `unregistered_provider_error_code` signal at check time. The canonical SDK code→status mapping moved to `SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES` in `error-resolution.ts`, shared by the runtime status resolver and the lint.

## 2.2.0-beta.21

- Release candidate for main commit 00f61024fb18db39711dc5076c4621508baa49f5.

## 2.2.0-beta.20

- Release candidate for main commit 8043d2ef0047e431aace750d8abca2e1149ec1d6.

## 2.2.0-beta.19

- Release candidate for main commit fd93ae68d0472fae68d908312249163373ec5d22.

## 2.2.0-beta.18

- Release candidate for main commit cebaf4b994918d2641c0fe6681fbffd3a3284c5d.

## 2.2.0-beta.17

- Release candidate for main commit 5a0f9127a5861992d5c144b07ad379a085756544.

## 2.2.0-beta.16

- Release candidate for main commit c5deb2bc31a4a4a236d27a2ce3d214b533ed358f.

## 2.2.0-beta.15

- Release candidate for main commit b5ebd25e48f6502e4ddb775d4e0a25f5c8276712.

## 2.2.0-beta.14

- Release candidate for main commit 3491acd253ca17b517985e8a618f1c2904a664a9.

## 2.2.0-beta.13

- Release candidate for main commit 75e840d0614aea3b99a1e5cef4f93f8cdccf0507.

## 2.2.0-beta.12

- Release candidate for main commit c66789c4745c72fc94ad3c10b3e0d7e5ed83fd25.

## 2.2.0-beta.11

- Release candidate for main commit f6f739bd5265afe714bbace9900edc2695fcf826.

## 2.2.0-beta.10

- Release candidate for main commit c41bd919739e0293ae8fa4d72a8a32f034cef4b8.

## 2.2.0-beta.9

- Release candidate for main commit 5c78c8b (bundles #67 nodemaven required-secret + #68 transport vendor-advance).

## 2.2.0-beta.8

- Release candidate for main commit 9e8a3f028ee78b9cab29d4aa3f5494ac9cffa65f.

## 2.2.0-beta.7

- Release candidate for main commit 2ce4ea4bd36ce333eba8b3b474bf6e82b5e9216c.

## 2.2.0-beta.6

- Release candidate for main commit 17f4e41d44efe7c148ef875b950be4f2c7df1294.

## 2.2.0-beta.5

- Release candidate for main commit 82fa14e99a9af7edd44e3196aa3f4e87b4699edf.

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

- Upstream the platform monorepo's beta.16 dist patch: OAuth2-proxied auth ceremony (`createOAuth2ProxiedStart`, `OAUTH2_PROXIED_PKCE_VERIFIER_KEY`, `APIFUSE__AUTH_PROXY__URL` origin key, proxied redirect/callback turns) and the provider runtime state upgrades it depends on (in-memory compareAndSet with quota-aware write policy, Redis CAS/set Lua scripts with entry quotas and legacy index migration). The monorepo drops `patchedDependencies` once it pins this release.
- **honest-provider-error-contract (phase 2):** `UPSTREAM_REJECTED` is a registered code family serving HTTP 409 with `retryable: false` — deterministic upstream business refusals are no longer 502s. Operation-declared `docs.errorCodes` may now use 409/410/422. Public error envelopes carry a `source` field (`client` | `upstream_rule` | `upstream_failure` | `apifuse`) derived from the observability category. Taxonomy version bumps to `2026-08-07` with the `upstream_rejected`, `dependency_unavailable`, `unsupported_transport`, and `client_cancelled` categories (409/410/422 map to `upstream_rejected`), matching the platform monorepo SoT. The `unregistered_provider_error_code` signal now carries a `signalFix` pointing at `docs.errorCodes` declaration.
- **Breaking for custom native gateway adapters:** `NativeGatewayProxySynthesisInput` now includes an injected `credentials` resolver and selected `protocol`; synthesizers may return promises and structured skip reasons, and `resolveNativeGatewayProxy` is async. Default callers retain env-backed behavior. Native transport now supports both HTTP CONNECT and SOCKS5, defaults per vendor with an explicit runtime override, registers smartproxy allocation ahead of nodemaven when declared in that order, and reports every exhausted vendor reason without exposing proxy credentials.
- Honor operation `docs.errorCodes` at runtime: declared provider-owned statuses and retryability now drive the HTTP envelope, observability header, and structured log; invalid statuses fail `defineProvider`, declared codes no longer emit the unregistered-code signal, and `TransportError` status-preservation workarounds are obsolete.
- Add an opt-in same-origin redirect hop policy to `ctx.http`, with bounded manual following and typed failures before a refused target is requested.
- Enforce provider-declared native TCP/TLS egress before proxy or socket setup, with revocable and expiring dynamic grants plus typed authorization failures; providers without a native egress declaration retain legacy behavior.
- **Breaking:** Provider error `details` is now passed through verbatim; SDK observability fields (`category`, `taxonomyVersion`, `upstreamStatus`, and derived `retryable`) are no longer merged into the public body. Emitted error envelopes now require top-level `retryable`, while inbound stateful forwarding tolerates an older owner response that omits it and defaults it to `false`. The removed observability metadata is available in the new `X-ApiFuse-Error-Observability` response header.
- Unregistered `ProviderError` codes now default to HTTP 500 instead of 400 and emit an `unregistered_provider_error_code` structured-log signal; registered mappings remain unchanged and take precedence over the HTTP 400 fallback for unregistered input `ValidationError` codes.
- Add an opt-in native connection idle read timeout with a typed error, independently from TCP/SOCKS/TLS establishment deadlines.
- Add opt-in `maxBodyBytes` enforcement to stealth fetches and redirect hops, aborting oversized decoded response streams with `response_too_large`.
- Resolve relative date tokens in fixture requests before input-schema validation, add KST capture-date `fixtures.recordedAt` metadata, and support explicit KST/UTC calendars in the shared health-input resolver.
- Add opt-in `runStandardTests(provider, { upstreamStub })` real-handler E2E coverage with strict offline transport stubs, output-schema validation, and per-operation warnings when handler E2E is not enabled.
- Export native-network and request-file TypeScript contracts from the package root and `./provider`, including typed native provider declarations and optional runtime capabilities on provider/auth contexts.
- Add `arrayBuffer()` and `bytes()` to `HttpResponse` so `ctx.http` consumers can read binary-safe upstream bodies; internal response handling is now byte-first.
- Preserve identity-only operation `connectionId` values in `ProviderContext` without requiring credential material.
- Accept and validate `proxy.session.drainLeadSeconds` in `defineProvider`, so providers can actually declare the native sticky-expiry drain lead time the type surface already exposed; a non-positive value, or one that meets or exceeds the sticky lifetime, is rejected at define time.

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

- Replace the legacy TypeScript request transport with `ctx.stealth`, backed by browser-grade TLS/HTTP2 impersonation without Python runtime dependencies.
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
