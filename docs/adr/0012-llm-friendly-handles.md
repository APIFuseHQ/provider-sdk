# ADR-0012 — LLM-friendly handles replace choice tokens

**Status:** Accepted (owner directive 2026-09-08: "no legacy left behind" — remove `ctx.choice` and inline tokens outright; no aliases, no envelope-parser horizon)
**Type:** Contract / Runtime primitive / DX
**Date:** 2026-09-08
**Decision owner:** Taehoon Kim (repo owner)
**Relationship:** Supersedes ADR-0006 (`0006-word-based-server-stored-choice-tokens.md`). Two parts of ADR-0006 remain normative and are inherited here unchanged: the choice of EFF Short Wordlist #2 as the word source (§1) and the online-guessing analysis for unbound lookup keys (§2), which now governs `public` cursors. Amends ADR-0011 D2 (`0011-remote-only-provider-engine.md`): the provider process keeps handle *field logic*, not an inline choice mode.

## Context

### The incident chain

- **2026-08-18.** A consumer session carried a 664-character server-stored `attempt_token` (the pre-ADR-0006 encrypted envelope) between prepare and confirm. The model dropped one character. The provider's parse path treated the damaged token as a structurally different format and the flow reported success for work that had not happened — a false success, the worst class of outcome a mutation can produce. ADR-0006 had already measured the underlying failure mode on 2026-08-10: ten of fifteen sends of 330–430-character tokens were corrupted in the middle, and one session expanded into 93 retrying tool calls.
- **2026-08-21.** catchtable `register-waiting` failed with `INVALID_WAITING_CHOICE` after a 10-minute gap between `waiting-prepare` and `register-waiting` — the gap was the user being asked how many people were in the party — against a 7-minute token TTL. The token was inline (the `storage` default), so expiry surfaced as a signature failure, not as "expired; call `waiting-prepare` again". The same trace showed the classes of damage the model applies to a token it is asked to copy: a trailing space, an inner space, a capitalized first letter, a trailing quote, a one-character typo. The word parser of the day matched `^[a-z]+(?:-[a-z]+){3,9}$` strictly (`choice.ts:790`), so every one of those variants fell through to the envelope parser and died as "signature invalid".
- **apifuse issue #2102** (owner re-scope 2026-09-08): "improve every choice token to an LLM-friendly structure, from the ground up" — the removal of the inline default is a means, not the goal.

### Measured shape of the fleet on beta.59

| Axis | Measurement | Source |
|---|---|---|
| Format | 49 `ctx.choice` call sites: 19 word-based, 30 inline (17 relying on the `storage` default across 8 repositories, 13 explicit `mode: "inline"`). An inline token for the catchtable waiting payload measures **369 characters** when issued with the local SDK. | fleet grep, local issuance |
| Shape | Word tokens are `prefix + words` with **no separator** (`choice.ts:576`). Of 75 fleet prefixes, **57 end in a digit** (`v1`, `v2`), so the prefix fuses with the first word: `ct_wait_choice_v1visor-abnormal-request-anagram`. Average prefix 20 characters, longest 27 (`kakaot.ride_request_results`). Word tokens measure 47–61 characters, half of it prefix. | fleet grep, local issuance |
| Tolerance | None. Case, whitespace, quoting, separator choice, and single-character typos all fail structurally. | `choice.ts:236-268, 785-799` |
| Failure UX | Unbound word tokens collapse to not-found; bound ones may disclose `stale`. Recovery wording is per provider. The 7-minute TTL convention does not survive a conversational turn. | ADR-0006 §2, incident timeline |
| Guessing defense | ADR-0006 §2 requirement 2 ("declare `annotations.rateLimit` on operations that parse") had no lint; 14 of the 20 repositories that parse tokens contained no `rateLimit` declaration. ADR-0009 D8 then deleted `rateLimit` altogether, because nothing consumed it. | `lint.ts`, ADR-0009 audit table |
| Copies per operation | catchtable `register-waiting` takes `waiting_choice` plus `person_option_choice` × N, `additional_option_choice` × M, and `menu_choice` × K — every one a 369-character inline token whose payload (`{shop_ref, table_id}` and the like) sits in plain text beside it. Request body measured at **1,063 bytes**. The reservation flow, which uses one `attempt_token` and plain `selection_key`/`selection_value` pairs, measures **143–159 bytes** for the equivalent answer. Seven waiting fields shared one description key (`d0017`). | gateway `originalBytes`, catchtable `index.ts`/`schemas.ts` |
| Local development | `apifuse dev` already builds a memory state backend (`bin/apifuse-dev.ts:94`); the test harness already injects memory state (`testing/run.ts:323`). The "no Redis locally" justification for inline had already expired. | code |
| Dead surface | `unavailable: "reject"` exists in the storage type and is read nowhere. | `types.ts:2038` |

### The core insight

"Choice token" named two different things. **(a)** An encrypted, signed *carrier* that moves a payload through the client (inline mode). **(b)** A *handle* — a lookup key to a record the server already holds. An LLM-facing design needs only (b). Once the server holds the record, forgery is prevented by comparing a plain answer against the offered list, tampering is prevented because the client never holds the values, and context is fixed by storing the record under the connection. Nothing needs to be signed.

Within (b) there is a second choice that dominates length: **what gets a handle**. "One handle per offered option" makes the number of LLM copies equal to the number of options (1 + N + M + K in the waiting flow). "One handle per *offer* plus plain picks" makes it one: the model copies a single short handle and answers with the short human-readable keys it was shown (`table: "hall"`, `menu: "m_12"`), which the server validates against the list stored under that handle. catchtable's reservation flow already has this shape; its waiting flow has the other. The SDK should only be able to express the first.

Two further consequences fall out. A **bound** handle needs almost no key space: if another connection cannot address the record at all, the only requirement is uniqueness among that connection's live handles, and two words (1,296² = 1,679,616) suffice. Four or five words are needed only for **public** cursors, where a hit discloses another caller's state — exactly the case ADR-0006 §2 analysed. And the token grammar and parser belong to the SDK: a fixed `kind_` prefix, a mandatory separator, and a tolerant normalizer turn the 2026-08-21 damage classes into successes without changing the guessing arithmetic (D5).

## Decision

| # | Decision | Core reason |
|---|---|---|
| D1 | **A handle is a lookup key to server state, never a payload carrier. Two kinds: `cursor` (immutable) and `draft` (mutable with CAS, one-shot `commit` with result replay).** `defineCursor` / `defineDraft` produce kinds; `ctx.handle` offers `create`, `read`, `update`, `commit`, `discard`. There is no inline mode and no `storage` option: the kind definition *is* the storage policy (`ttl`, `maxEntries`, `maxValueBytes`, `access`). | The 369-character token exists only because a payload travelled client-side. No fleet site needs that (see Why-not §1). Naming the two lifetimes as kinds, not as options on one `issue` call, makes the mutable/immutable distinction and the commit point part of the type. |
| D2 | **Bound access (default for cursors, always for drafts) is connection-scope isolation: the record lives under `state.forConnection(connectionId)`. Two words. No HMAC, no binding hash, no master secret.** `create` on a bound kind without `request.connectionId` throws `HANDLE_CONNECTION_REQUIRED`. Bound kinds default to `maxEntries: 200` per connection. | Another connection cannot address the record, so guessing is moot; the only invariant is uniqueness among one connection's live handles in a 1.68M space, held by CAS-if-absent with 5 retries (`HANDLE_STORAGE_UNAVAILABLE` after that). ADR-0006 got the same isolation from binding hashes derived from a master secret — a secret whose only job was to reproduce what scope already provides. |
| D3 | **Public access (cursors only) is provider scope: four words, five when `ttl > 1h` or `strength: "high"`. `maxEntries` is required.** The guessing analysis is ADR-0006 §2, unchanged: 41.4 bits at four words, 51.7 at five; `E = N · K / keyspace` gives 0.15% at four words and 0.0001% at five under its 50 req/s × 24 h × 1,000-live-handles scenario; three words are rejected. | A public hit discloses another caller's stored search state, so the key must carry the defense. Operation-level `rateLimit` no longer exists (ADR-0009 D8), so ADR-0006 §2 requirement 2 cannot be met by declaration; the defense for public handles is word count, the collapsed `HANDLE_INVALID` error, and platform-side limiting at the gateway. The auto-escalation to five words on long TTL turns ADR-0006's "SHOULD" into a rule the SDK applies. `maxEntries` has no defensible default: measured fleet quotas differ 100× between anonymous cursors (nol 100,000) and bound tokens (kakaot 1,000). |
| D4 | **Canonical grammar `<kind>_<word>-<word>[-<word>-<word>[-<word>]]`. The `_` after the kind is mandatory. Kind names match `/^[a-z]{2,12}$/` — letters only, no version suffixes.** Words are EFF Short Wordlist #2 (ADR-0006 §1), module renamed `handle-wordlist.ts`. | The digit-terminated prefix (57 of 75) is what fused `v1visor`. Letters-only kind names cannot fuse with a word body, and the separator makes the boundary explicit for the model and the parser. Version suffixes carried compatibility information for a payload that travelled client-side; with the payload server-side, a schema change is a new kind name or namespace, not a token suffix. |
| D5 | **Tolerant normalization.** `read`/`update`/`commit`/`discard` normalize before lookup: trim; strip one layer of wrapping quotes/backticks/brackets and trailing `.,;:!?`; lowercase; require the kind name then one or more of `[_\-:\s]` (else `HANDLE_KIND_MISMATCH`); split the body on `[-_\s]+`; accept each segment if it is a wordlist entry or has a *unique* wordlist entry at edit distance ≤ 1; require the kind's word count (public accepts 4 or 5); canonical = `${kind}_${words.join("-")}`. Classes applied are reported to telemetry as `normalization: none\|case\|whitespace\|separator\|typo` (sorted, `+`-joined). Word fusion (`visorabnormal`) and missing-word recovery are **not** attempted. | Every 2026-08-21 damage class becomes a successful lookup. Security argument: normalization is a deterministic many-to-one map onto canonical keys, so one attempt still tests exactly one key and the ADR-0006 §2 expectation is unchanged. Uniqueness of the typo correction is guaranteed, not heuristic: the wordlist has pairwise edit distance ≥ 3, so at most one word lies within distance 1 of any string (triangle inequality). Missing-word recovery is forbidden because it would shrink the key space. |
| D6 | **One handle per offer, plain picks, one-shot commit with replay.** A draft record holds the offered lists; inputs carry plain keys validated with `pick(items, value, { field, by?, issuedBy? })` (exact match, else unique case-insensitive trimmed match, else `PICK_NOT_OFFERED` with `details.allowed`). `commit(kind, handle, work)` runs CAS `active → committing`, executes `work(data)`, CAS `committing → committed` storing `result` for `resultTtl` (default `"24h"`); a later commit returns `{ status: "replayed", result }` without running `work`; a throwing `work` restores `active` (retryable); a concurrent commit sees `HANDLE_BUSY`; `update` after commit is `HANDLE_COMMITTED`. Draft TTL is sliding `{ idle, max }`, touched on read and update. | Copies drop from 1 + N + M + K to 1, and the copied value is short. Made-up keys fail closed with the allowed list attached, which is a correctable error rather than a context mix-up. Replay removes both failure classes of the 2026-08-21 incident: the false "registered" and the 409 on retry. ADR-0006 §5 required providers to hand-roll this dedup from a `replayKey`; the primitive owns it. Sliding TTL matches the conversational gap (30 minutes idle, 2 hours max in the catchtable design) instead of a fixed 7 minutes. |
| D7 | **Schema fields are declared with `kind.field()`, which emits `z.string().min(1)`, SDK-owned description wording ("Opaque handle issued by `<issuedBy>`. Copy it exactly as returned; do not edit or shorten it."), and JSON Schema meta `x-apifuse-handle: { kind, type, fieldName, issuedBy }`** (`src/handle-meta.ts`). Lint (`src/lint.ts`): `handle-kind-undeclared` (error), `handle-field-name` (error), `handle-field-parity` (error — every kind has at least one output and one input carrying its field), `handle-issued-by` (error), `handle-requires-state` (warn), `legacy-choice-usage` (error, points at the migration guide); `description-key-required` / `schema-description-key-required` exempt fields carrying the meta. | The seven waiting fields sharing `d0017` show that hand-written descriptions for opaque fields degrade. The wording is the same everywhere, the meta lets the platform localize it, and "name is position" (output field = input field) is checkable. The registry and gateway can recognise handle fields without parsing prose. |
| D8 | **Remove `ctx.choice`, the inline envelope, `src/choice-token.ts`, `src/runtime/choice.ts`, all `ProviderChoice*` types, and `APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET` (engine, serve, error resolution, `apifuse dev`). Provider declaration `choice?: true` becomes `handle: readonly HandleKind[]`; `ctx.handle` exists only when declared and requires the `state` capability. No alias, no dual-read horizon. In-flight tokens are invalidated when each provider bumps its SDK pin.** | Owner directive. A deprecated alias would let a repository sit half-migrated, and at 49 sites in a fleet that migrates per repository that state becomes permanent (the ADR-0009 anti-goals argument). Invalidation is accepted on precedent: the ADR-0006 sunset of 2026-08-20 invalidated 29 daangn pagination cursors with ~29.99 days of TTL remaining; the consumer receives a uniform invalid result and restarts, never a false success. The master secret's remaining job was the binding hash D2 makes unnecessary. |

### Errors

`HandleError extends ProviderError`, discriminated by `error.code`. Every message ends with the recovery sentence derived from `kind.issuedBy` and `kind.fieldName`: "Call `waiting-prepare` again and pass the new `waiting_token` exactly as returned."

| code | when | category / retryable | disclosed for |
|---|---|---|---|
| `HANDLE_INVALID` | public kind: not found, expired, corrupt, wrong words (collapsed) | input_validation / false (HTTP 400) | public |
| `HANDLE_NOT_FOUND` | bound kind: no record (never issued, or past expiry + grace) | input_validation / false (HTTP 404) | bound |
| `HANDLE_EXPIRED` | bound kind: record past its logical expiry (idle or max for drafts, ttl for cursors, resultTtl for committed) but still inside the expiry grace window | input_validation / false (HTTP 410) | bound |
| `HANDLE_KIND_MISMATCH` | string does not start with the kind name (shape check, safe to disclose) | input_validation / false (HTTP 400) | all |
| `HANDLE_BUSY` | commit while another commit is in flight (the claim holds a 5-minute lease independent of the draft ttl) | internal_error / **true** (HTTP 409) | bound |
| `HANDLE_COMMITTED` | update after commit | input_validation / false (HTTP 409) | bound |
| `HANDLE_CONNECTION_REQUIRED` | create on a bound kind without `connectionId` | configuration / false | — |
| `HANDLE_STORAGE_UNAVAILABLE` | state unsupported, or 5 CAS collisions | internal_error / false | — |
| `HANDLE_TOO_LARGE` | record exceeds `maxValueBytes` | internal_error / false | — |
| `PICK_NOT_OFFERED` | `pick()` miss; `details: { field, allowed }` | input_validation / false (HTTP 400) | all |

The public collapse is ADR-0006 §2 requirement 1 carried forward. The bound-side disclosure (`NOT_FOUND` vs `EXPIRED` vs `COMMITTED`) is the 2026-08-20 amendment generalised: a caller inside the connection scope already possesses the record's context, so nothing is disclosed to a guesser.

### Storage and telemetry

Namespace per kind: `handle.<kind>` with `StateNamespaceOptions { scope: "connection" | "provider", defaultTtl, maxTtl, maxEntries, maxValueBytes }`. Record: `{ v: 1, kind, type, status, data, result?, created_at_ms, expires_at_ms, max_expires_at_ms, committed_at_ms? }`. `expires_at_ms` is the logical expiry the caller sees (cursor: `created + ttl`; draft: sliding `min(touch + idle, max)`; committed: `committed + resultTtl`). The physical storage ttl is the logical remaining lifetime **plus an expiry grace** of `min(lifetime, 1h)` — drafts are kept to `max + grace` — so a caller inside the grace window receives `HANDLE_EXPIRED` ("call `waiting-prepare` again") instead of `HANDLE_NOT_FOUND`. A `committing` claim holds a lease of at least 5 minutes so upstream work started near expiry can still persist and replay its result.

Telemetry is allowlisted and carries no values: `{ providerId, kind, type, operation, outcome, normalization, words }`, logged server-side as event `provider_handle` (replacing `provider_choice_token`). `outcome ∈ success | not_found | expired | invalid | kind_mismatch | busy | replayed | error`.

## Why not keep inline with a mandatory `reason` field?

The first draft (`DESIGN-v1-trap-removal.md`) made `storage` required and let `mode: "inline"` survive with a `reason` string, on the assumption that some payload genuinely must travel client-side (ADR-0006 §7). The fleet audit refuted the assumption: of the 13 explicit inline sites, the 6 that state a reason all say the same thing — "fall back when state is unsupported" (korea-camping, korea-welfare) — and that reason was already void because `apifuse dev` and the test harness run memory state. The other 7 give no reason. A carrier mode with zero legitimate users is an attractive nuisance: it would remain the shortest path for the next contributor, and it would keep the AES envelope, the keyring, `kid` rotation, and the master secret alive to serve nobody.

## Why not default `storage` to server and keep `ctx.choice`?

This was the issue's original P1. It trades the length trap for a quota trap: server storage needs `namespace`, `maxEntries`, and `maxValueBytes`, and the fleet's hand-tuned values differ by two orders of magnitude (kakaot 1,000/1,000; nol cursors 100,000/2,000; daangn 50,000/16,000; catchtable attempt 100/64,000). Any SDK default is wrong for one end — either an availability cliff for anonymous cursors or a Redis leak for bound tokens — and it is wrong silently. Kinds make the policy explicit per use, bound kinds get a per-connection default that no single conversation exceeds, and public kinds must state `maxEntries`.

## Why not one token per offered option?

It is the shape that produced the 1,063-byte request. Each option token re-encodes a value that is already visible in plain text next to it, multiplies the number of copies the model must make, and forces `shop_ref` to be taken twice (in the token and in the input) for cross-validation. With the list stored under the offer's handle, a plain key carries the same information, a forged key is caught by `pick`, and the cross-validation input disappears.

## Why not semantic, readable slugs?

A handle like `1800-4p` (six o'clock, four people) invites the model to *edit* it when the user changes their mind about the time. Meaningless-but-pronounceable dictionary words are the right texture: they are copyable without the model wanting to fix them, single-character damage never lands on another valid word (ADR-0006 §1), and a wrong word is detected by membership before it is detected by lookup. Mixed case, digits, and symbols are excluded for the same reason.

## Why not shorter public handles?

Three words give ~31 bits; ADR-0006 §2 computes about two expected hits per day in its scenario and rejects the tier. Nothing in this ADR changes that arithmetic — normalization is many-to-one onto the same key space (D5) — and with `rateLimit` gone (ADR-0009 D8) the word count carries more of the defense, not less. Bound handles are the place to be short (D2), and that is where almost every fleet site lives.

## Anti-goals

- **Not** a compatibility alias for `ctx.choice`, a dual-read parser for envelopes, or a `T_last_inline_mint` horizon. In-flight tokens die at the pin bump (D8).
- **Not** an `offer` kind separate from `draft`. An offer is a draft whose only mutation is commit; a third kind would add vocabulary without adding a lifetime.
- **Not** a monotonic counter (`waiting_12`) for bound handles. Counters are guessable inside the connection and reuse becomes a correctness hazard; two random words cost nothing over a counter and keep one grammar.
- **Not** fusion splitting or missing-word recovery in the normalizer. The first is a possible follow-up; the second shrinks the key space and is forbidden.
- **Not** a return of operation-level `rateLimit`. ADR-0009 D8 stands; if per-operation limiting becomes a platform feature it returns with its enforcement path.

## Consequences

1. **ADR-0006 is superseded.** Its wordlist choice (§1) and public-guessing analysis (§2) remain normative for `public` cursors; everything else — envelope, binding hashes, `consume` modes, `replayKey`, prefix-copying, the `format=word|legacy` telemetry label — is retired with the code.
2. **ADR-0011 D2 changes wording.** The provider process keeps "handle field logic (`kind.field()`, `pick`)"; handle storage is engine-owned `state`. The ADR-0011 D3 list of engine-owned runtime secrets loses the choice-token master secret because there is no such secret.
3. **`state` is required wherever `handle` is declared.** `serve` wires `requestState` into `createHandleContext`; the lint warns on `handle` without `state`. The `apifuse dev` server (`src/dev.ts`) serves with `allowMemoryStateFallback: true`, so local development runs handles on memory state when no Redis is configured; production `serve` remains fail-closed on missing Redis.
4. **Fleet migration is one PR per repository, pin bump plus source change.** 49 call sites are re-expressed as kinds: the 30 inline sites (17 default across 8 repositories, 13 explicit) and the 19 already-word sites (catchtable attempt, kakaot, nol, daangn realty, goodchoice, modu) — the latter to drop their fused prefixes and gain normalization. 74 fleet test files that import `createTestProviderChoiceContext` switch to `createTestHandleContext`. `tsc` after the pin bump is the worklist; `legacy-choice-usage` catches what `tsc` cannot see. Guide: `docs/migrations/handle.md`.
5. **catchtable waiting is the first case**, and its contract changes: `waiting-prepare` returns one `waiting_token` (draft) plus `tables[]`, `person_options[]`, `menus[]` with plain keys; `register-waiting` takes the token and plain keys and is a `commit`. `shop_ref` leaves the input. The seven `d0017` descriptions are replaced by `WaitingDraft.field()` and per-field keys. The reservation flow's hand-written attempt/result replay logic (`index.ts:3400-3900`) collapses into `commit`.
6. **In-flight tokens are invalidated at each provider's pin bump.** Accepted per D8. Operators should land the bump outside the provider's peak window; the consumer-visible effect is one uniform invalid result followed by a restart of the flow.
7. **Telemetry event rename.** `provider_choice_token` stops; `provider_handle` starts, with the new `normalization` dimension. Dashboards keyed on the old event go dark at the pin bump.
8. **Public API surface.** Exports added: `defineCursor`, `defineDraft`, `pick`, `HandleError`, `normalizeHandle`, `createTestHandleContext`, handle wordlist exports. Exports removed: every `ProviderChoice*` type, `createProviderChoiceToken`, `parseProviderChoiceToken`, `ProviderChoiceTokenError`, `createTestProviderChoiceContext`. `bun run api:update` refreshes the report.

## Pitfalls

1. **Bound kinds need a connection.** An operation with `connectionMode: "none"` has no `request.connectionId`, so `create` on a bound kind throws `HANDLE_CONNECTION_REQUIRED`. Anonymous search pagination must be a `public` cursor with an explicit `maxEntries`; do not "fix" the error by making a booking draft public.
2. **Do not preclassify handles in provider code.** ADR-0006 §4 already forbade `token.startsWith(prefix + ".")`; the equivalent here is checking the kind name or word count before calling `read`. The SDK normalizer is the single discriminator and `HANDLE_KIND_MISMATCH` is its answer.
3. **`replayed` is success, not an error.** A second `commit` on a committed draft returns the stored result. Providers that map every non-`committed` status to a failure recreate the 409 class the primitive removes.
4. **`HANDLE_EXPIRED` is reported for the grace window only.** Records outlive their logical expiry by `min(lifetime, 1h)` (drafts: until `max` + grace) precisely so expiry can be told apart from an unknown handle; after that the record is gone and the answer is `HANDLE_NOT_FOUND`. Both messages end with the same recovery sentence, so the distinction is diagnostic, not behavioural. The grace costs at most 2× the live footprint for short-lived cursors and counts against `maxEntries`.
5. **Reads touch draft TTL.** A polling consumer keeps a draft alive up to `max`. Set `max` for the longest conversation you will tolerate, not for the idle gap; `idle` covers the gap.
6. **Kind names are the schema version.** A breaking change to a draft's `schema` is a new kind name (or the same name with a different namespace), because old records under the old name will fail validation on read. Never append `v2` — the pattern rejects it.
7. **`kind.field()` is exempt from `description-key-required` only because the wording is SDK-owned.** Wrapping it in your own `.describe()` re-enters the rule and, worse, teaches the model a second phrasing.
8. **The `yo-yo` entry** is the wordlist's only punctuation and remains valid; the segmenter must not split it. Inherited from ADR-0006 §1 and pinned by the wordlist test.
9. **Test contexts are memory-backed but still scoped.** `createTestHandleContext` with a bound kind and no `request.connectionId` throws exactly as production does. Pass a connection in tests that exercise bound kinds; that failure is the point.
10. **The pin bump is the invalidation.** There is no version of the new SDK that reads an old token. A provider that must not invalidate anything at a given moment postpones the bump, not the removal.

## Verification

Hold when the implementing change lands (mirrors `SDK-SPEC.md` §11) and after the first fleet wave:

- `src/__tests__/handle.test.ts`: create/read round trip for both kinds; bound isolation across two connections; public visibility across connections; bound `create` without a connection throws `HANDLE_CONNECTION_REQUIRED`; word counts 2 / 4 / 5 (5 auto when `ttl > 1h` and on `strength: "high"`).
- Normalization fuzz: the 2026-08-21 classes (trailing space, inner space, capitalized, trailing quote, wrapped in backticks/brackets, `_`↔`-`↔space separators, uppercase kind) plus every single-character substitution, insertion, and deletion in each word all resolve to the canonical handle. Canonical-collision property: for a sample of 200 handles, no normalized input resolves to two distinct canonical handles. Kind mismatch reports `HANDLE_KIND_MISMATCH`.
- Draft lifecycle with a fake clock (`nowMs`, applied to the memory state backend too): CAS update; sliding TTL; idle expiry → `HANDLE_EXPIRED` for the grace window, then `HANDLE_NOT_FOUND`; commit → committed → replay; a commit whose upstream work outlives the idle ttl still persists and replays; failing `work` reverts to `active`; concurrent commit → `HANDLE_BUSY`; update after commit → `HANDLE_COMMITTED`; discard; `HANDLE_TOO_LARGE`; storage unavailable.
- `pick`: exact, case-insensitive, miss with `details.allowed`.
- Telemetry allowlist: no handle text or data value appears in any emitted event.
- `src/__tests__/lint-handle.test.ts`: one case per rule in D7, including the `description-key-required` exemption and `legacy-choice-usage`.
- Type tests: `handle: [..]` yields `ctx.handle`; omitting it yields no member.
- `rg 'ctx\.choice|choice-token|ProviderChoice|CHOICE_TOKEN_MASTER_SECRET' src bin` returns nothing; `src/runtime/choice.ts`, `src/choice-token.ts`, and the two choice test files are absent; the wordlist module and test are renamed. `bun run check`, `bun run api:check` after `bun run api:update`.
- Fleet, after each repository's pin bump: `legacy-choice-usage` error count 0; `tsc` clean.
- Fleet metrics, catchtable first: gateway `provider_invocation_diagnostics.request.originalBytes` for `register-waiting` falls from 1,063 B to under 200 B; `provider_handle` events show the `normalization ≠ none` ratio (the measured LLM-damage rate — a high ratio is a signal to improve descriptions, not to loosen the parser); over 30 days, production `provider_error_code` `INVALID_WAITING_CHOICE` and `INVALID_WAITING_PERSON_OPTION_CHOICE` are 0, and no `INVALID_*_CHOICE` code is emitted by any migrated provider.
- Static copy count: for every migrated operation, the number of handle fields in its input schema is ≤ 1.

## When this might break

- A payload appears that genuinely must travel client-side (no shared store reachable at parse time). Re-measure against the fleet audit above before adding a carrier; the bar is "a named site with a reason other than missing state".
- A model family emerges whose copy damage is dominated by word fusion rather than the measured classes; add fusion splitting to D5 with the same many-to-one argument, never missing-word recovery.
- The platform gains per-operation rate limiting with an enforcement path (ADR-0009 "When this might break"). D3's public defense then regains its declarative leg; the word counts do not change.
- Connection scope stops being the isolation unit (for example, handles that must survive re-authentication into a new connection). D2 would need an explicit scope option; today no fleet site asks for one.

## References

- apifuse issue #2102 — owner re-scope 2026-09-08
- Design record: `~/work/apifuse/choice-inline-default-2102/` — `SDK-SPEC.md` (authoritative API), `DESIGN.md`, `DESIGN-v2-llm-friendly.md` (§1 measurements, §8 principles), `DESIGN-v1-trap-removal.md` (§1 code audit)
- ADR-0006 `docs/adr/0006-word-based-server-stored-choice-tokens.md` — superseded; §1 wordlist and §2 guessing analysis inherited; 2026-08-20 sunset record is the invalidation precedent
- ADR-0009 `docs/adr/0009-flat-operation-declaration.md` — D8 removed `rateLimit`; anti-goals argument against shims
- ADR-0011 `docs/adr/0011-remote-only-provider-engine.md` — D2 wording amended by this ADR
- Shared meta: `src/handle-meta.ts` (`x-apifuse-handle`, `HANDLE_KIND_NAME_PATTERN`)
- Migration guide: `docs/migrations/handle.md`
- Local memory state: `bin/apifuse-dev.ts:94`; test harness `src/testing/run.ts:323`
- Reference implementation target: `apifuse-provider-catchtable` `waiting-prepare` / `register-waiting` (first case), `reserve` / `reserve-confirm` (attempt logic to collapse into `commit`)
