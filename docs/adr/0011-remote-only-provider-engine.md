# ADR-0011 — Remote-only provider engine: local development attaches to the platform engine with a workspace-scoped API key

**Status:** Proposed (owner decisions D1–D5 confirmed in the 2026-09-02 design review; Accepted on merge of this ADR by the repo owner)
**Type:** Architecture / Platform boundary / DX
**Date:** 2026-09-02
**Decision owner:** Taehoon Kim (repo owner)
**Relationship:** Partially supersedes ADR-0010 (`0010-provider-engine-boundary.md`) — supersedes its local-transport clause ("The in-process implementation is the local-development transport") and its private-channel assumption; keeps its attachment contract, `provider-engine.v1` protocol shape, runtime targets, and credential-relocation direction intact. Extends ADR-0010 v1.1 (engine-owned solver credentials) to every runtime capability.

## Context

ADR-0010 moved runtime capabilities behind `ProviderEngine.attach` and named two transports: an in-process implementation for local development, and RPC bridges over "the platform's private provider-to-engine channel" for deployment. The SDK shipped the in-process default in v2.2.0-beta.49 (`serve`, `dev`, `record` attach the local engine).

That split leaves the contributor experience unchanged in the one place the engine was supposed to help. A bounty contributor cloning a provider workspace today must fill six vendor variables in `.env.local` before a CAPTCHA- or proxy-dependent operation runs locally (`.env.example:248-258` in the APIFuse monorepo: `APIFUSE__PROXY__SMARTPROXY_APP_KEY`, `APIFUSE__PROXY__NODEMAVEN_USERNAME`, `APIFUSE__PROXY__NODEMAVEN_PASSWORD`, `APIFUSE__RESOLVER__2CAPTCHA__API_KEY`, `APIFUSE__RESOLVER__CAPSOLVER__API_KEY`, plus the Smartproxy gateway CIDR). Each of those is a paid account the contributor has to open in their own name. The same variables are the credentials ADR-0010 v1.0 §7 already decided to withdraw from provider pods, so the in-process local engine is the last place they are still handed to third parties.

The in-process transport also ships the engine core itself. `@apifuse/provider-sdk` is public on npm, so the stealth transport, solver orchestration, proxy allocation, and vendor fallback logic are readable by anyone who installs the SDK. ADR-0010 accepted this because the boundary was about deployment topology, not confidentiality.

Owner directive, 2026-09-02, after the design meeting with ino (verbatim):

> 로컬 개발환경도 마찬가지로 엔진을 아예 우리 서버가 관리하고 접근을 위해 바운티별 또는 바운티 유저 apikey를 받는 구조, 어뷰징을 막기 위해. 이렇게 하면 유저가 직접 캡챠 솔버 같은 서비스 가입해서 직접 로컬 디버깅을 할 필요도 없고 apifuse가 모두 지원해줄수 있고, apifuse는 엔진 코어를 private하게 관리할수 있음

Before deciding what stays local, the review measured what each capability actually needs (all paths in this repo at `origin/main` 55540d7):

| Capability | Measured backing | Source |
|---|---|---|
| `http`, `stealth`, `browser`, `native` | Egress paths that consult the provider's `proxy` policy; proxy is an axis on every transport, not a separate binding | `src/types.ts:1608` (`NativeProxyEgressInfo`), `src/runtime/http.ts:55,70` (`proxyUsed`), `proxy-retry-policy.js` |
| `resolver`, `ocr`, `stt` | Paid vendor APIs | ADR-0006, ADR-0007, ADR-0010 v1.1 |
| `cache`, `state` | Redis clients from `providerCacheRedisUrlFromEnv` / `providerStateRedisUrlFromEnv` | `src/runtime/cache.ts:3-18`, `src/runtime/state.ts:2-17` |
| `choice` (`storage: "server"`) | Server-stored tokens; the only production mode for multi-step ceremonies (catchtable, tablecheck) | `src/runtime/choice.ts:63,71,115-125` |
| `choice` (`storage: "inline"`) | Payload carried in the token, no store | `src/runtime/choice.ts:115` |
| `files` | Resolves request-scoped `ProviderFileRef` uploads held by the gateway | `src/types.ts:1478-1481` |
| `env` | Process environment; mixes provider-owned upstream keys with platform vendor keys | `.env.example:248-258` |
| `trace` | Ambient, local observer | ADR-0010 |

Nothing in that table except `env`, `trace`, and inline `choice` is satisfiable on a contributor's laptop without either a paid account or an APIFuse-operated store. The earlier proposal to keep `http`/`cache`/`state`/`choice` local was a guess that the measurement refuted.

## Decision

| # | Decision | Core reason |
|---|---|---|
| D1 | **The engine owns every runtime capability: `http`, `stealth`, `browser`, `native` (all egress including proxy), `resolver`, `ocr`, `stt`, `cache`, `state`, server-mode `choice`, and `files`.** | Each one is measured to need a paid vendor, our IP pool, or an APIFuse-operated store. There is no capability left whose local implementation would not either leak a credential or diverge from production. |
| D2 | **A provider process keeps only: the declaration, operation handler logic, ambient `trace`, and inline-mode `choice`.** | This is the "contract and mapping only" provider ADR-0010 described; the measurement shows nothing else belongs there. |
| D3 | **`env` splits by owner.** Provider-owned upstream credentials (for example a public-data portal key) stay with the contributor and are read locally. Platform vendor credentials (`APIFUSE__PROXY__*`, `APIFUSE__RESOLVER__*`, CDP pool, and any future vendor) **and the runtime secrets of every engine-owned capability** (cache key pepper, server-mode choice token master secret, STT backend tokens) are engine-owned and never reach the provider process. **Each provider declaration names the issuer of each provider-owned secret: `apifuse` or `contributor`.** | Upstream keys are not the abuse target and are frequently free; APIFuse operating 92 upstream accounts scales linearly in support cost. Paid upstreams still exist, so the issuer must be explicit rather than assumed. D1 moves cache/state/choice into the engine, so their signing and hashing material follows; leaving it in the provider process would let one workspace forge another's tokens. (Owner confirmation 2026-09-02.) |
| D4 | **Local development attaches to the remote platform engine. There is no in-process engine default.** Access requires an APIFuse API key; `serve`, `dev`, and `record` fail closed without one. | The owner directive: contributors sign up for nothing, APIFuse supports every capability, and the engine core stays private. An in-process fallback would keep shipping the core and the credentials. |
| D5 | **API keys are scoped to one bounty workspace: (provider, contributor) pair, one key.** The key's egress allowlist is the provider's declared `allowedHosts`; usage and abuse attribution resolve to that pair; the key is revoked with the workspace. | The bounty system already has (provider, user) as its unit (`add-provider-bounty-automation` D1: provider-and-user private workspace repo). A bounty-wide shared key loses attribution; a user-wide key has no provider to bind an allowlist to. |

## Why remote-only over in-process-with-remote-option?

The runner-up was to keep ADR-0010's in-process transport and add a remote one, letting contributors choose. It was rejected because the two goals in the directive are both defeated by the option existing: the in-process engine must contain the core (so it is not private), and it must accept vendor credentials from the environment (so contributors still need accounts to use it). A local option that works only with paid keys is the status quo with an extra flag. Remote-only also collapses ADR-0010's §6.2 requirement (local capability set equals deployed set) from a gate the SDK must enforce into a property that holds by construction, because local and deployed providers attach to the same engine.

## Why egress-all over "proxy: false stays local"?

An alternative kept requests that declare no proxy policy on the laptop, since they never touch our IP pool. It was rejected on two grounds: it reintroduces two execution paths whose observability, retry policy, and TLS behavior can drift (the exact divergence ADR-0010 §6.2 exists to prevent), and it moves the local/remote split from a stable declaration-level fact to a per-request property that contributors would have to reason about while debugging. Debuggability is addressed by the engine streaming request and response traces back to the session owner (see Consequences), not by running the request on the laptop.

## Why (provider, contributor) keys over the two alternatives the directive named?

The directive left "바운티별 또는 바운티 유저 apikey" open.

- **Per-bounty shared key**: several contributors on one bounty would share credentials; abuse cannot be attributed, and revoking one contributor revokes all.
- **Per-user key**: the key has no provider binding, so the engine cannot derive an egress allowlist from `allowedHosts`, and a contributor could route arbitrary traffic through our proxies under their own name.
- **Per-(provider, contributor) key (chosen)**: inherits the workspace lifecycle the bounty system already manages, gives the allowlist for free, and makes quota and attribution per pair.

## Anti-goals

- APIFuse does not become the issuer of every provider's upstream credentials. D3 keeps contributor-owned upstream keys contributor-owned; `apifuse`-issued upstream keys are a per-provider declaration, not a default.
- No offline or air-gapped development mode. A contributor without network access to the platform engine cannot run capability-bearing operations. Pure handler logic remains unit-testable with engine mocks.
- No public, unauthenticated engine endpoint. Every engine call carries a platform-issued principal: a workspace key for contributor sessions (D5), or a deployed-provider principal for pods running in APIFuse infrastructure. The two classes share one validation path and one key table (`principal_class`) but have different lifecycles: workspace keys are quota-bound and die with the workspace; deployed-provider principals are issued by the manifest generator per provider, are not quota-bound, and are revoked when the provider is retired. (Owner decision 2026-09-02; closes tasks.md 5.13.)
- The `provider-engine.v1` protocol shape from ADR-0010 is not redesigned here. This ADR changes who the clients are, not the envelope.
- Runtime target semantics (`vanilla` / `engine`) from ADR-0010 are unchanged. kakaotalk remains the engine-resident provider.

## Consequences

1. **ADR-0010 §"Decision" second sentence is superseded.** "The in-process implementation is the local-development transport" no longer holds. The in-process attachment shipped in v2.2.0-beta.49 becomes an internal test seam for the SDK's own suite and is not exported as a supported runtime.
2. **The engine becomes an externally reachable, authenticated, rate-limited service**, not an internal sidecar over mTLS/UDS. Its deployment (APIFuse monorepo, the H2 handoff from the `provider-engine-architecture` change) must include key validation, per-key quota, per-key `allowedHosts` enforcement, and abuse telemetry before any contributor is pointed at it.
3. **Debugging moves to trace streaming.** Because no request leaves the laptop, the engine must stream request/response metadata (and, for the session's own traffic, bodies within a size cap) to the attached session so `apifuse dev` can show them. This is a protocol addition on the existing stream lane, tracked in the follow-up plan.
4. **`.env.example` in the monorepo loses the six vendor variables** for provider development and gains one: the workspace API key. The monorepo `provider-engine-architecture` change (§6, §7) is re-planned against D1–D5; §6.1 is deleted, §6.2 is satisfied by construction, §7 widens from three proxy names to all vendor credentials.
5. **Provider declarations gain an issuer per provider-owned secret** (D3). This is a declaration-schema change and needs its own SDK release and fleet codemod; it rides the same wave as the ADR-0009 flat-declaration migration rather than a separate one.
6. **Quota and rate-limit basis is not decided here.** D5 fixes the unit (per workspace key); whether the limit counts requests, vendor cost, or both is the next decision and is recorded when measured against real contributor sessions.

## Pitfalls

1. **Shipping the remote engine without the trace stream** turns every contributor debugging session into a black box. The stream lane is part of the minimum, not a follow-up.
2. **Treating the beta.49 in-process engine as the fallback when the remote engine is down.** It is not a fallback; it ships the core and needs vendor keys. Outage handling is an engine SLO problem.
3. **Deriving the egress allowlist from anything other than the provider's declared `allowedHosts`.** A key bound to a user or a bounty cannot enforce it; a key bound to a provider whose declaration is stale enforces the wrong thing. The allowlist must be read from the provider declaration at the SoT pin the workspace is on.
4. **Letting `apifuse`-issued upstream credentials become the default issuer.** Every provider declaration must name the issuer explicitly; a missing issuer is a validation error, not `contributor` by default and not `apifuse` by default.
5. **Confusing this ADR's key with the tenant API key** that calls the APIFuse gateway. They are different principals with different lifecycles: one is a contributor developing a provider, the other is a customer invoking one.

## Verification

Hold when the implementing changes land:

- `apifuse dev` in a provider workspace with no `APIFUSE__ENGINE__API_KEY` exits non-zero with an actionable message before any handler runs.
- `rg 'APIFUSE__(PROXY|RESOLVER)__' .env.example` in the monorepo returns only engine-deployment entries, none under the provider-development section.
- A vanilla provider declaring `allowedHosts: ["example.com"]` attached with its workspace key is refused by the engine for an `http` request to any other host, with a `PROVIDER_EGRESS_DENIED` (name to be fixed in the protocol change) error that names the host.
- Revoking a workspace key makes the next engine call from that session fail authentication within the key cache TTL.
- The SDK public API report (`bun run api:check`) shows no exported in-process engine constructor.
- `openspec validate provider-engine-architecture --strict` passes after §6/§7 are re-planned.

## When this might break

- A capability appears that is genuinely local-only (no vendor, no shared store, no egress) and latency-sensitive. Re-measure against the table above before adding a local path; the bar is the same one `cache`/`state` failed.
- Contributor volume makes per-workspace quota administration heavier than the vendor-account support cost it replaced.
- The bounty system stops modeling (provider, contributor) as a unit; D5's key scope must be re-derived from whatever replaces it.
- A partner or self-hosted deployment requires running the engine outside APIFuse infrastructure. That is a distribution decision for the engine, not a reason to reopen the in-process SDK path.

## References

- ADR-0010 `docs/adr/0010-provider-engine-boundary.md` — partially superseded (local transport, private channel); v1.1 amendment extended
- ADR-0009 `docs/adr/0009-flat-operation-declaration.md` — the declaration migration wave the D3 issuer field rides on
- ADR-0006 `0006-challenge-resolver-context.md`, ADR-0007 `0007-image-to-text-context.md` — vendor-backed capabilities now engine-owned end to end
- APIFuse monorepo: `openspec/changes/provider-engine-architecture/` (proposal, design, tasks §5–§7) — to be re-planned against this ADR
- APIFuse monorepo: `openspec/changes/add-provider-bounty-automation/design.md` D1 — the (provider, user) workspace unit D5 reuses
- APIFuse monorepo: `.env.example:242-262` — the six vendor variables contributors fill today
- SDK release carrying the in-process default this ADR retires: v2.2.0-beta.49 (`chore: release @apifuse/provider-sdk v2.2.0-beta.49`, PR #241; engine boundary PR #240)
