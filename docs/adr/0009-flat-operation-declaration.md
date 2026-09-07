# ADR-0009 — Flatten the operation declaration into one namespace with one field per axis

**Status:** Accepted
**Type:** Contract / DX
**Date:** 2026-08-31
**Decision owner:** Taehoon Kim (repo owner), approved 2026-08-31 in the design review that produced D1-D8

## Context

`OperationDefinition` has grown to 24 top-level fields plus three nested containers
(`annotations`, `toolRouter`, `docs`). The containers do not partition the declaration by
concern — they split single concerns across multiple homes, and several fields inside them are
declared, copied into the projection, and never read by anything.

The trigger was a production incident. ZOZOTOWN's catalog operations are anonymous reads under a
provider whose `auth.mode` is `credentials` (its member/order operations need a shopper login).
The operations declared `annotations.openWorld: true`, whose SDK doc comment states:

> Provider-level `auth.mode` describes the **majority** auth model of a provider; individual
> operations can still opt out via `openWorld: true` when their handler does not consume
> `ctx.credential`. This is the canonical way to declare "this operation is public, even though
> the provider is `credentials`-mode" without splitting the provider into two.

The registry never reads that field. Measured: zero references in the connection-mode derivation.
The four catalog operations were therefore published as `connectionMode: required`, and a
downstream connector port stopped at its auth gate rather than making users run an
id/password + image-CAPTCHA ceremony to search a product. The intent was in the code the whole
time; the platform ignored it.

Owner directive, verbatim: **"readOnly, openWorld, connectionMode 이것들 지금 모두 너무 모호하지
않아? SoT가 안정해지고 다 애매하게 부분집합인 느낌이야 DX가 너무 별로임"** and, on scope,
**"전체 재설계"**.

### Measured consumer audit

Every field counted against its real consumers (registry projection builder, Go gateway, SDK
lint). Script: `~/tmp/audit-operation-fields.sh`.

| field | registry | gateway | verdict |
|---|---|---|---|
| `annotations.openWorld` | 0 | 1 | dead — doc calls it "canonical", nothing reads it |
| `derivations` | 3 | 0 | dead — copied through, zero documentation |
| `toolRouter.requiresConnection` | 8 | 44 | deprecated; registry throws when used |
| `inputExamples` | 0 | 0 | **worst class** — lint *requires* >=2 for complex schemas, nothing consumes them |
| `docs.requestExample` | 2 | 0 | dead — duplicate of `inputExamples`, also unread |
| `docs.responseExample` | 5 | 0 | duplicate of `fixtures.response` |
| `annotations.rateLimit` | 0 | 14* | dead — every gateway match is unrelated (OAuth limiter, error taxonomy) |
| `annotations.idempotent` | 0 | 1 | copied into projection JSON only |
| `toolRouter.approval` | 3 | 21 | **31 of 33 declarations are redundant restatements; 2 are real overrides** — see D5b |
| `toolRouter.name` | — | — | zero providers override; `providerId__operationId` already resolves |
| `retryOnAuthRefresh` | 0 | 0 | dead |

### Fleet scan — measured authoring surface

Counted 2026-08-31 across 84 cloned provider SoT repos, restricted to `operations/`
directories and excluding `node_modules`, `.git`, `dist`, `*.d.ts`, `__tests__`, and
`__fixtures__`. Cross-checked against `main` through the GitHub contents API for
`ekitan`, `baemin`, and `buyee`. Script: `~/tmp/adr9-fleet-scope.sh`.

| declaration site | sites | repos |
|---|---|---|
| `defineOperation(` | 845 | 67 |
| `inputExamples:` | 429 | 60 |
| `annotations: {` | 339 | 61 |
| `readOnly:` | 332 | 63 |
| `idempotent:` | 311 | 57 |
| `connectionMode:` (survives) | 297 | 30 |
| `toolRouter: {` | 251 | 30 |
| `docs: {` | 223 | 45 |
| `openWorld:` | 193 | 40 |
| `rateLimit:` | 175 | 35 |
| `requiresConnection:` | 84 | 14 |
| `riskClass:` (survives) | 33 | 4 |

Fleet-wide, outside `operations/`: raw `title:` 509, raw `description:` 493,
`retryOnAuthRefresh` 140 sites across 5 repos.

`openWorld: true` appears 172 times across 33 repos (plus 35 explicit `false` across
11). The heaviest declarants are ekitan (28), baemin (26), and buyee (13). Buyee's are
pure decoration — its `authMode` is `none`, so the default already produced `none`.
So `openWorld` is either redundant or ignored: at 207 declarations it has never once
changed an outcome.

Two consequences follow from the real size. `riskClass` exists in only 4 repos, so the
migration does not *move* the safety axis — it **authors** it for roughly 800 operations
out of booleans, and `readOnly: false` cannot say whether an operation is a write or a
destructive one. That mapping needs an explicit rule and must refuse ambiguity rather
than default. And the fleet is 84 separate repositories, so it cannot land atomically;
the wave window in which `main` carries both shapes is a real operational state that the
registry has to survive.

### The structural defect

Each container splits an axis rather than owning one:

| axis | `annotations` | `toolRouter` | top level |
|---|---|---|---|
| safety | `readOnly`, `destructive`, `idempotent` | `riskClass`, `approval` | — |
| access | `openWorld` (dead) | `connectionMode`, `requiresConnection` | `connectionMode` (also read) |
| execution | `rateLimit`, `timeoutMs` | — | `transport`, `retryOnAuthRefresh` |
| docs | — | — | `title`, `description`, `descriptionKey`, `docs.*` |

`descriptionKey` exists at the top level *and* inside `docs`, under the same name. `titleKey`
likewise. `connectionMode` exists in two places and the registry runs a conflict check between
them. When a field's home is ambiguous, each contributor picks differently and the axis scatters
— which is exactly how `openWorld` came to exist alongside `connectionMode`.

A reader-based split (`agent:` / `runtime:` / `docs:` / `evidence:`) was considered and rejected
during design review: measured, one source field already feeds several readers
(`description` reaches the docs-site markdown at `index.ts:1401`, the model-facing JSON Schema at
`:886`, and the contract JSON at `contract.ts:188`). Splitting by reader would duplicate the same
prose across blocks and reproduce the ambiguity it was meant to cure.

## Decision

| # | Decision | Rationale |
|---|---|---|
| D1 | **One flat namespace.** Delete `annotations`, `toolRouter`, `docs` as containers. | Nesting split axes instead of organising them. A flat space makes "one axis, one field" structurally checkable. |
| D2 | **Locale keys are first class.** Keep `titleKey` / `descriptionKey` / `summaryKey` / `markdownKey` / `whenToUseKeys` / `whenNotToUseKeys` / `normalizationNotesKeys`; delete the raw-prose `title` / `description`. | i18n was a founding constraint, and lint already rejects raw prose. The `Key` suffix states that the value is a key, and leaves the bare names free if raw prose is ever reintroduced. |
| D3 | **`fixtures` and `examples` are different things; keep both.** `fixtures` stays the single recorded live-evidence pair (schema-validated, `recordedAt`-checked). `examples` replaces `inputExamples` and absorbs `docs.requestExample`. | Evidence answers "is this contract real"; examples answer "how is this used". Conflating them is why three overlapping fields existed. |
| D4 | **`examples` must be wired to real consumers in this change** — docs-site request rendering and model-facing few-shot injection. Its `scenario` is a locale key. | A required-but-unread field is the worst DX defect found in the audit. Re-introducing one under a new name would repeat it. |
| D5 | **`riskClass` is the safety SoT.** Enum `read \| write \| destructive \| external-send`. Delete `readOnly`, `destructive`, `idempotent`. **`approval` survives** as a narrow override — see D5b. | The registry *already* derives risk from the booleans (`operation-risk.ts`); the enum is strictly more expressive (`readOnly: false` cannot distinguish write from destructive) and `external-send` has no boolean equivalent. Registry projection `annotations.readOnly` / `annotations.destructive` are re-derived from the enum. |
| D5b | **`approval` stays, and may only be declared when it differs from the derivation.** `defaultApprovalPolicy` (`index.ts:2048`) maps `read → never`, `write → risk-based`, everything else → `always`. An operation restating that mapping is a lint error; an operation departing from it must carry a justification. | An earlier draft deleted `approval` as "fully derived from `riskClass`, zero overrides". Measured across the fleet: of 33 declarations, 31 are redundant restatements — but **2 are real overrides**, both in tablecheck. `confirm-reservation` and `cancel-reservation` declare `riskClass: "write"` with `approval: "always"`; the derivation would give `risk-based`. The author wrote the reason inline: "This performs a real, binding restaurant reservation and always requires approval." Deleting the field silently downgrades an approval gate on operations that book and cancel real reservations. The 31 redundant declarations are the actual defect, and a lint removes those without removing the capability. |
| D6 | **`connectionMode` is the access SoT**, at the top level, keeping its name and `none \| optional \| required` values. Delete `openWorld` and `requiresConnection`. `connectionExternalRefParam` joins it at the top level. | `Connection` is a defined domain term (`AGENTS.md`: "the canonical tenant-scoped authorization record", `af_con_<22>`), used by ~50 platform sites. Renaming it at the operation layer alone would add vocabulary, not clarity. |
| D7 | **Mixed-auth providers must declare `connectionMode` explicitly** — lint error when `auth.mode` is credential-bearing and an operation omits it. Providers with `auth.mode: "none"` may still omit. | This is the exact silent-default that caused the incident. Fail-closed defaulting is correct; failing *silently* is not. |
| D8 | **Delete `derivations`, `rateLimit`, `retryOnAuthRefresh`, `toolRouter.name`.** | No consumer. `providerId__operationId` already resolves every MCP tool name, and a predictable naming rule is worth more than an override nobody uses. |

### Target shape

```ts
defineOperation<ProviderContext>()({
  input, output, handler,

  // access — one axis, one field
  connectionMode: "none",
  connectionExternalRefParam: "externalRef",   // optional

  // safety — one axis, one field
  riskClass: "read",
  approval: "always",                           // optional; only when it differs from the derivation (D5b)

  // execution
  timeoutMs: 30_000,                            // optional
  transport, upstream,

  // i18n-keyed prose
  titleKey, descriptionKey, summaryKey, markdownKey,
  whenToUseKeys, whenNotToUseKeys, normalizationNotesKeys,
  errorCodes,

  // examples vs evidence
  examples: [{ scenarioKey, input }],
  fixtures: { request, response, recordedAt },

  // health
  healthCheck | healthCheckUnsupported,

  // misc retained
  tags, relatedOperations, contract, observability, hints,
});
```

## Anti-goals

- **Not** a reader-based split (`agent:` / `runtime:` / …) — refuted by measurement above.
- **Not** renaming `connectionMode`. An earlier draft proposed `access: "public" | "user"`; it was
  withdrawn because it invents a second vocabulary for an already-defined domain term.
- **Not** keeping compatibility shims for `openWorld` / `requiresConnection` / `inputExamples`.
  The migration is roughly 2,500 authoring sites across 84 SoT repositories, not the handful
  an earlier draft assumed. That size does not change the verdict, because the cost a shim
  would avoid is not paid per site: each repo lands its pin bump and its codemod in one PR, so
  no repository ever sits in a mixed state, and the rewrite is mechanical. What a shim would
  buy is the right to leave a repo half-migrated, and at 84 repos that is precisely the state
  that would become permanent. The contract is early; a shim would make the misnomers
  permanent instead.
- **Not** a fleet-wide flag day either. The wave window — `main` carrying both shapes while
  the fleet migrates — is an ingestion concern for the registry, not an authoring shim, and it
  is scoped separately with its own removal gate.
- **Not** adding `rateLimit` / `idempotent` back "for completeness". They return when a consumer
  exists, with that consumer.
- **Not** deleting `approval`. An earlier draft did, on a "zero overrides" claim that measurement
  refuted; see D5b.

## Pitfalls

1. **`riskClass` re-derivation must preserve the registry safety projection.** A full-monorepo
   audit found zero occurrences of `readOnlyHint` / `destructiveHint`; the real safety carrier is
   `annotations.readOnly` / `annotations.destructive`. The D9 adapter derives those annotations
   from the flat `riskClass` enum in
   `packages/provider-registry/src/operation-declaration-ingestion.ts:708–717` and preserves them
   for legacy input at `:758–759`; the gateway reads them in
   `apps/gateway/internal/admission/projection.go:1034–1048`. Published annotation values must not
   change for any operation when the legacy inputs and adapter are removed.
2. **`examples` without consumers is `inputExamples` again.** D4 is a gate, not a nice-to-have:
   do not merge the schema change ahead of the docs/few-shot wiring. Note what that implies for
   sequencing — the schema lives in `provider-sdk` and the consumers live in the monorepo, so
   "one change" here spans two repositories. The SDK release carrying flat `examples` and the
   monorepo PR consuming it are planned and reviewed together; the SDK may be published first
   only because the monorepo must pin a real version, and the monorepo consumer PR follows
   immediately. What is forbidden is *shipping the fleet* onto a schema whose `examples` still has
   no reader — that is the state that recreates `inputExamples`. No provider repo migrates until
   the consumers are live.
3. **The lint in D7 needs a fleet sweep before it lands.** 84 SoT repos (92 on the org; recount
   before the sweep); any credential-mode provider that currently relies on the silent default
   will start failing its build.
4. **`descriptionKey` currently exists in two places.** Flattening must pick the surviving read
   path deliberately — `developer-artifacts.ts:697` reads the top-level one, other sites read
   `docs.*`.
5. **Buyee's 13 `openWorld` occurrences are no-ops, not bugs.** Removing them changes nothing at
   runtime; do not treat their removal as a behavioural fix or expect a metadata diff.
6. **Mixed-auth providers still need a product-surface decision, not just a lint.** D7 makes the
   declaration explicit; it does not decide which operations a downstream connector should expose.
   Credentialed operations stay metadata guardrails until that surface is chosen deliberately.
7. **`riskClass` is authored, not migrated — and the codemod must refuse most of it.** Measured
   across 857 operation declarations in the fleet (resolving hoisted `const annotations = {...}`
   blocks referenced by shorthand, which a naive block-local scan misses and which inflated an
   earlier count):

   | bucket | count | share |
   |---|---|---|
   | mechanical (`readOnly: true` → `read`, `destructive: true` → `destructive`) | 346 | 40.4% |
   | already declares `riskClass` | 32 | 3.7% |
   | conflict (enum and booleans disagree) | 1 | 0.1% |
   | **no safety declaration at all** | **478** | **55.8%** |

   Those 478 fall through `operationRiskClass`'s final `return "write"` today, so the platform
   already publishes `riskClass: "write"` for them. That value is a fallback, not a decision, and
   the codemod must **refuse** it rather than freeze it: writing `write` into 478 declarations
   would convert an unexamined default into an authored claim, permanently. Refusing means those
   operations are authored by hand before their repo can migrate, and that work is a prerequisite
   of the fleet wave, not a part of it. Heaviest: triple 154, baemin 52, ekitan 27.

   The one conflict is `tablecheck/cancel-reservation`, which declares `riskClass: "write"` *and*
   `destructive: true`. Today `toolRouter.riskClass` wins and it publishes `write`. The operation
   cancels a real reservation. Collapsing the two axes changes its published safety class either
   way, so it is authored by hand, not resolved by precedence.
8. **The fleet cannot cut over atomically, and the registry fails silently at the seam.** 84
   repositories, each with its own SDK pin and its own PR, means `main` carries both shapes for
   the length of the wave. Measured against the real ingestion path (see D9 below), that seam is
   dangerous specifically because it is quiet: `defineOperation` is an identity function, so the
   provider's own pin decides the runtime object, the registry reads that object by property, and
   the readers default rather than throw. A flat operation ingested by today's registry publishes
   `riskClass: "write"` from `operationRiskClass`'s final fallback, loses
   `connectionExternalRefParam` to the `"externalRef"` default, and loses `timeoutMs` and the
   destructive annotation at the gateway boundary — with a green build.

## D9 — the wave window is an explicit ingestion mode, not a permissive fallback

Measured 2026-08-31 against the production ingestion path. The findings that decide this:

- Provider modules execute against **their own** installed pin.
  `bootstrap-materialized-provider-dependencies.mjs:114` runs `bun install` per materialized
  provider directory, and `provider-sdk-pin-resolution.test.ts` exists to prove a provider-local
  SDK resolves ahead of the platform copy. Mixed pins are supported by design, not tolerated by
  accident.
- The pin gate is a **floor**, not an equality check. `providerSdkPinMeetsFloor`
  (`scripts/lib/provider-sdk-pin.ts:620`) accepts any pin `>=` the floor, and
  `provider-sdk-floor.json` is deliberately decoupled from the monorepo pin so a routine bump
  cannot raise the fleet gate mid-flight. So there is no flag day available even if one were
  wanted, and none is needed.
- The registry reads operations **structurally**. `importOptionalModule`
  (`packages/provider-registry/src/index.ts:1701`) performs a real `import()` and takes the
  default export; `isProviderDefinition` only checks a shallow envelope. The
  `Partial<OperationDefinition>` annotation on `toOperationCatalog` is erased at runtime.
- The Go gateway is **insulated**. It never imports provider source or resolves a provider pin;
  it consumes the registry's projection wire shape (`apps/gateway/internal/admission/projection.go:133`).
  Flattening the authoring declaration does not require changing the registry-to-gateway wire
  contract. The wave-window problem is confined to registry ingestion.

Decision: the registry gains a temporary ingestion adapter at the operation boundary, before
`toOperationCatalog`, and that adapter **discriminates on shape rather than falling back field by
field**. An operation carrying any of `annotations`, `toolRouter`, or `docs` is legacy and takes
the existing derivation unchanged; an operation carrying none of them is flat and must satisfy the
flat contract — missing `riskClass`, or a missing `connectionMode` under a credential-bearing
provider, throws.

Field-by-field fallback was rejected: it cannot distinguish "flat provider that omitted
`riskClass`" from "legacy provider", so it would preserve exactly the silent-default class that
pitfall 8 describes. A shape discriminator makes the seam loud on both sides and makes the removal
mechanical — delete the legacy branch and the flat path becomes the only path.

This tolerance lives in the registry's ingestion boundary, never in the SDK. It is not the
compatibility shim the anti-goals reject: the SDK ships one shape, providers author one shape, and
no repository is ever half-migrated. Its removal gate is in Verification below.

**The existing legacy derivations move into the adapter; they are not deleted alongside the SDK
fields.** This is the same distinction stated above, and it is easy to get backwards: deleting the
SDK's `requiresConnection` field and deleting the registry's `requiresConnection` *reader* are two
different acts. The field goes away in the SDK immediately; the reader survives inside the adapter
for exactly as long as an unmigrated provider can still declare it. Measured: 20 repos declare
`requiresConnection` today (ekitan alone on 27 operations), so deleting the reader before the wave
completes would fail the projection build for every one of them — which is the outcome D9 exists to
prevent. The same applies to `annotations.destructive` / `readOnly` as risk inputs and to
`docs.*` as the locale-key source. Each dies with the adapter, in one removal, gated below.

## Verification

- `openWorld`, `derivations`, `requiresConnection`, `inputExamples`, `rateLimit`, `idempotent`,
  `toolRouter.name`, `retryOnAuthRefresh` return zero hits across every provider SoT repo and the
  SDK. Baseline to drive to zero, measured 2026-08-31: 193 `openWorld`, 429 `inputExamples`,
  339 `annotations: {`, 332 `readOnly:`, 311 `idempotent:`, 251 `toolRouter: {`, 223 `docs: {`,
  175 `rateLimit:`, 84 `requiresConnection:`. (`approval` is not on this list — it survives per
  D5b, and its own criterion is below.)
- For every provider whose `auth.mode` is credential-bearing, every operation declares
  `connectionMode`; lint fails when one does not.
- Every operation declares `riskClass` explicitly. Zero operations reach a derived default —
  the 478 measured undeclared operations are authored, not defaulted (pitfall 7).
- `approval` appears only where it departs from `defaultApprovalPolicy`; lint rejects a
  redundant restatement. `tablecheck/confirm-reservation` and `cancel-reservation` still publish
  `approval: "always"` after the migration (D5b).
- `zozotown` catalog operations publish `connectionMode: "none"`; member/order operations publish
  `"required"`.
- MCP tool names are unchanged for all providers (`providerId__operationId`).
- Published `annotations.readOnly` / `annotations.destructive` match the pre-migration values for
  every operation.
- 2026-09-03 full-fleet snapshot: 610/610 published operations carry `riskClass` +
  `connectionMode`; 190 flat-shaped / 420 legacy-shaped inputs at pinned SHAs; D9 adapter still
  required.
- The D9 ingestion adapter is gone. Removal sequence: every provider has landed the flat pin and
  flat declarations, then `provider-sdk-floor.json` rises to that SDK, then a complete materialized
  projection build passes. Only then does the legacy branch come out.
- Absence test, two parts, because a fleet grep proves only that nobody *authors* the old shape —
  not that the registry stopped *accepting* it. (1) The complete materialized build asserts every
  imported operation carries the flat fields and no `annotations` / `toolRouter` / `docs`
  container. (2) A registry unit test feeds a legacy-shaped operation and requires a loud
  rejection, while a flat one succeeds. The adapter's module and its legacy-success fixtures must
  be absent from the tree.

## When this might break

- If a provider ever needs a genuinely custom MCP tool name (a client with a name-length or
  charset limit), D8 must be revisited — but with that client named.
- If per-operation rate limiting becomes a real platform feature, `rateLimit` returns with its
  enforcement path, not as declaration-only metadata.

## References

- Incident: `apifuse-provider-zozotown` PR #13 (catalog published as login-required)
- Derivation sites: `packages/provider-registry/src/operation-risk.ts`,
  `packages/provider-registry/src/index.ts:2063-2120` (connection mode), `:2384-2397` (default)
- Ingestion path (D9): `scripts/provider-deploy/bootstrap-materialized-provider-dependencies.mjs:114`,
  `packages/provider-registry/src/index.ts:1701` (`importOptionalModule`),
  `scripts/lib/provider-sdk-pin.ts:620` (`providerSdkPinMeetsFloor`), `provider-sdk-floor.json`,
  `apps/gateway/internal/admission/projection.go:133`
- Audit script: `~/tmp/audit-operation-fields.sh`; fleet scan: `~/tmp/adr9-fleet-scope.sh`;
  riskClass buckets: `~/tmp/adr9-riskclass-map-v2.py`; approval overrides:
  `~/tmp/adr9-approval-override-audit.py`
- Approval derivation: `packages/provider-registry/src/index.ts:2048` (`defaultApprovalPolicy`)
- Domain term: monorepo `AGENTS.md` §Terminology — Connection
