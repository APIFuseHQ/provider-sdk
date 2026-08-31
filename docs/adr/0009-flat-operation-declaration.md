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
| `toolRouter.approval` | 3 | 21 | fully derived from `riskClass`; zero providers override |
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
| D5 | **`riskClass` is the safety SoT.** Enum `read \| write \| destructive \| external-send`. Delete `readOnly`, `destructive`, `idempotent`, `approval`. | The registry *already* derives risk from the booleans (`operation-risk.ts`); the enum is strictly more expressive (`readOnly: false` cannot distinguish write from destructive) and `external-send` has no boolean equivalent. MCP `readOnlyHint` / `destructiveHint` are re-derived in the projection. |
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

## Pitfalls

1. **`riskClass` re-derivation must preserve MCP hints.** `operation-risk.ts` currently reads the
   booleans; after D5 the projection must emit `readOnlyHint`/`destructiveHint` *from* the enum,
   or MCP clients silently lose safety metadata.
2. **`examples` without consumers is `inputExamples` again.** D4 is a gate, not a nice-to-have:
   do not merge the schema change ahead of the docs/few-shot wiring.
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
7. **`riskClass` is authored, not migrated.** It exists in 4 repos today and must be written for
   roughly 800 operations. The boolean triple maps cleanly only at its edges: `readOnly: true` is
   `read`, and `destructive: true` is `destructive`. Everything else — `readOnly: false` with no
   `destructive` flag — is genuinely ambiguous between `write` and `destructive`, and no
   operation can be inferred as `external-send` from booleans at all. The codemod must refuse
   the ambiguous branch and surface it for authoring rather than defaulting to `write`.
8. **The fleet cannot cut over atomically.** 84 repositories, each with its own SDK pin and its
   own PR, means `main` carries both shapes for the length of the wave. Decide the registry's
   ingestion tolerance for that window *before* the schema lands, and give whatever tolerance is
   added an explicit deletion gate and an absence test — otherwise the window becomes the shim
   this ADR refuses.

## Verification

- `openWorld`, `derivations`, `requiresConnection`, `inputExamples`, `rateLimit`, `idempotent`,
  `approval`, `toolRouter.name`, `retryOnAuthRefresh` return zero hits across every provider SoT
  repo and the SDK. Baseline to drive to zero, measured 2026-08-31: 193 `openWorld`, 429
  `inputExamples`, 339 `annotations: {`, 332 `readOnly:`, 311 `idempotent:`, 251 `toolRouter: {`,
  223 `docs: {`, 175 `rateLimit:`, 84 `requiresConnection:`.
- For every provider whose `auth.mode` is credential-bearing, every operation declares
  `connectionMode`; lint fails when one does not.
- `zozotown` catalog operations publish `connectionMode: "none"`; member/order operations publish
  `"required"`.
- MCP tool names are unchanged for all providers (`providerId__operationId`).
- Published `readOnlyHint`/`destructiveHint` match the pre-migration values for every operation.

## When this might break

- If a provider ever needs a genuinely custom MCP tool name (a client with a name-length or
  charset limit), D8 must be revisited — but with that client named.
- If per-operation rate limiting becomes a real platform feature, `rateLimit` returns with its
  enforcement path, not as declaration-only metadata.

## References

- Incident: `apifuse-provider-zozotown` PR #13 (catalog published as login-required)
- Derivation sites: `packages/provider-registry/src/operation-risk.ts`,
  `packages/provider-registry/src/index.ts:2063-2120` (connection mode), `:2384-2397` (default)
- Audit script: `~/tmp/audit-operation-fields.sh`
- Domain term: monorepo `AGENTS.md` §Terminology — Connection
