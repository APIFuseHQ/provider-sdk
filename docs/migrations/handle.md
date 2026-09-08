# Migration: `ctx.choice` → `ctx.handle`

Applies when bumping `@apifuse/provider-sdk` past the release that lands
ADR-0012 (`docs/adr/0012-llm-friendly-handles.md`). The change is breaking and
has no compatibility alias: `ctx.choice`, inline tokens, and every
`ProviderChoice*` export are gone. After the pin bump, the `tsc` error list is
your worklist, and the lint rule `legacy-choice-usage` catches the identifiers
`tsc` cannot see (string references in tests, comments that point contributors
at the old API).

Tokens minted by the previous version are invalid the moment the new version
serves. Consumers receive one uniform invalid result and restart the flow. Land
the bump outside the provider's peak window.

## 1. Mapping

| `ctx.choice` (≤ beta.59) | `ctx.handle` |
|---|---|
| `choice: true` in `defineProvider` | `handle: [WaitingDraft, PageCursor]` **and** `state: {}` (or `state: true`). `ctx.handle` exists only when `handle` is declared; lint `handle-requires-state` warns if `state` is missing. |
| `ctx.choice.issue({ prefix, purpose, payload, ttlMs, bind, storage, strength })` | `await ctx.handle.create(Kind, data)`. Everything that used to be a per-call option lives on the kind definition. |
| `prefix` / `purpose` (e.g. `ct_wait_choice_v1`) | kind `name` — `/^[a-z]{2,12}$/`, letters only, **no version suffix**. The handle string is `${name}_word-word`. Schema changes are a new kind name, not `_v2`. |
| `payload` | `data`, validated by the kind's zod `schema` on `create`/`update` |
| `ttlMs` | cursor: `ttl: "10m"` (`ProviderStateDurationString`); draft: `ttl: { idle: "30m", max: "2h" }` (sliding, touched on read/update) |
| `bind: { connection: true }` | bound kind — the default `access: "bound"` for cursors and drafts. Isolation is `state.forConnection(connectionId)`; no hash, no secret. `create` throws `HANDLE_CONNECTION_REQUIRED` without a connection. |
| no `bind` (anonymous cursor) | `defineCursor({ access: "public", maxEntries: /* required */ })` — 4 words, 5 when `ttl > 1h` or `strength: "high"`. A connectionless provider (`auth: none`) may also declare `defineDraft({ access: "public", maxEntries })`; see §4a. |
| `bind: { credentialKeys }` | no equivalent; scope is the connection. If a site needs credential-level fencing, store the discriminator in `data` and compare it in the handler. |
| `storage: { mode: "server", namespace, maxEntries, maxValueBytes }` | kind definition: `maxEntries` (bound default 200 per connection; public required), `maxValueBytes` (cursor default 16,000; draft default 64,000). Namespace is `handle.<name>`, not chosen by the provider. |
| `storage: { mode: "inline" }` / `mode: "auto"` / `maxInlineBytes` / `unavailable` | removed. There is no payload carrier. |
| `strength: "high"` | `defineCursor({ strength: "high" })` — public only; applied automatically when `ttl > 1h` |
| `ctx.choice.parse({ token, prefix, purpose, ttlMs, bind, storage })` | `await ctx.handle.read(Kind, handle)` → `HandleRecord` (`handle` canonical, `status`, `data`, `result?`, `createdAt`, `expiresAt`). Input is normalized (case, whitespace, quotes, separators, one typo per word). |
| hand-computed `expires_at` / `expires_in_min` next to an issued token | `const record = await ctx.handle.createRecord(Kind, data)` → the same `HandleRecord` as `read`; return `record.handle` and `record.expiresAt` instead of redoing ttl math. `create` is the string-returning shortcut. |
| `consume: "never"` | `read` |
| `consume: "explicit"` → `claim.consume()` after upstream success | `await ctx.handle.commit(Kind, handle, async (data) => upstreamWork(data))` → `{ status: "committed" \| "replayed", handle, result }` |
| `consume: "on-parse"` | `commit` — there is no consume-without-result. If the old site consumed on parse and did the work afterwards, move the work into `commit`'s callback. |
| `replayKey` + provider-owned result record + "check the record before treating consumed as failure" | built into `commit`: a second call returns `{ status: "replayed", result }` without running the callback; a failing callback restores `active` |
| re-issue a fresh token every round to carry new decisions | `await ctx.handle.update(Kind, handle, (data) => ({ ...data, ...answers }))` — same handle, CAS with 3 retries, sliding TTL |
| `ProviderChoiceTokenError` (`reason: invalid_shape \| invalid_signature \| invalid_payload \| invalid_binding \| stale`), `CHOICE_STATE_UNAVAILABLE`, `CHOICE_STATE_PAYLOAD_TOO_LARGE`, `CHOICE_CONTEXT_REQUIRED`, `CHOICE_TOKEN_MASTER_SECRET_NOT_CONFIGURED` | `HandleError extends ProviderError` with `error.code`: `HANDLE_INVALID` (public, collapsed), `HANDLE_NOT_FOUND`, `HANDLE_EXPIRED`, `HANDLE_KIND_MISMATCH`, `HANDLE_BUSY` (retryable), `HANDLE_COMMITTED`, `HANDLE_CONNECTION_REQUIRED`, `HANDLE_STORAGE_UNAVAILABLE`, `HANDLE_TOO_LARGE`; plus `PICK_NOT_OFFERED` from `pick()`. See §5. |
| hand-written "option must be one of …" validation | `pick(items, value, { field, by?, issuedBy? })` |
| `createTestProviderChoiceContext({ providerId, state, request, masterSecret })` | `createTestHandleContext({ providerId?, state? /* memory default */, request? })` |
| `APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET` | removed; nothing to configure |
| telemetry event `provider_choice_token` (`format`, `outcome`, consume flags) | `provider_handle` (`kind`, `type`, `operation`, `outcome`, `normalization`, `words`) |
| `choice-wordlist.ts` exports (`CHOICE_WORDLIST_SIZE`, …) | `handle-wordlist.ts` (`HANDLE_WORDLIST_SIZE`, `handleWordAt`, `isHandleWord`, `BOUND_HANDLE_WORD_COUNT`, `PUBLIC_HANDLE_WORD_COUNT`, …) |

Not carried: `futureToleranceMs`, `nowMs` on issue/parse (test contexts accept a
`nowMs` option instead), the `ttlMs` clamp on parse.

## 2. Declaration

```ts
// before
export default defineProvider({
  id: "catchtable",
  // ...
  choice: true,
  state: {},
});

// after
import { WaitingDraft, ReserveDraft } from "./handles";

export default defineProvider({
  id: "catchtable",
  // ...
  handle: [WaitingDraft, ReserveDraft],
  state: {},                       // required: handles are state records
});
```

Kinds are module-level constants so that schemas (`kind.field()`), handlers,
tests, and lint all reference the same object:

```ts
// handles.ts
import { defineDraft } from "@apifuse/provider-sdk";
import { z } from "zod";

export const WaitingDraftSchema = z.object({
  shop_ref: z.string(),
  tables: z.array(z.object({
    table: z.string(), label: z.string(),
    waiting_count: z.number().int(), estimated_wait_min: z.number().int(),
  })),
  person_options: z.array(z.object({
    option: z.string(), label: z.string(),
    additional_options: z.array(z.object({ option: z.string(), label: z.string() })),
  })),
  menus: z.array(z.object({ menu: z.string(), name: z.string(), unit_price: z.number().int() })),
});

export const WaitingResultSchema = z.object({
  waiting_number: z.number().int(),
  registered_at: z.string(),
});

export const WaitingDraft = defineDraft({
  name: "waiting",                 // handle looks like `waiting_visor-anagram`
  fieldName: "waiting_token",      // the schema key on both output and input
  schema: WaitingDraftSchema,
  result: WaitingResultSchema,
  ttl: { idle: "30m", max: "2h" }, // survives the "how many people?" turn
  resultTtl: "24h",
  issuedBy: "waiting-prepare",     // used in every error's recovery sentence
});
```

`issuedBy` may also be a list when several operations issue the same handle
(one `location_token` from both `search-address` and `reverse-geocode`):

```ts
export const LocationCursor = defineCursor({
  name: "location",
  fieldName: "location_token",
  schema: LocationSchema,
  ttl: "10m",
  access: "public",
  maxEntries: 10_000,
  issuedBy: ["search-address", "reverse-geocode"],
});
// field description: "Opaque handle issued by `search-address` or `reverse-geocode`. Copy it exactly…"
// recovery sentence: "Call `search-address` or `reverse-geocode` again and pass the new `location_token` exactly as returned."
```

Lint `handle-issued-by` checks that every listed operation exists and that at
least one of them outputs the field.

> **Two keys, two fields.** `Kind.field()` returns a schema instance; putting the
> *same instance* under two property keys (`{ waiting_token: f, token: f }`) is
> two handle fields to lint, and the second key fails `handle-field-name`. Call
> `Kind.field()` once per property (or accept that only `fieldName` is legal).

## 3. The pattern: one handle per offer, plain picks

The unit that gets a handle is the **offer** (the list the user chooses from),
not each option. Options are returned as short human-readable keys, and the
input takes those keys back in plain text. The server validates them against
the list stored under the handle with `pick`, so an invented key fails closed
with the allowed list attached.

### Before — catchtable waiting on `ctx.choice` (inline, one token per option)

`waiting-prepare` output carried `waiting_choice` plus a token per person
option, per additional option, and per menu — `person_option_choice` × N,
`additional_option_choice` × M, `menu_choice` × K — every one a 369-character
inline token whose payload duplicated the plain `shop_ref` / `table_id` beside
it. `register-waiting` took all of them back plus `shop_ref` for
cross-validation (1,063-byte request), had a 7-minute TTL, no idempotency
(retry → 409), and seven fields sharing one description key.

```ts
// register-waiting (before, abridged)
const waiting = ctx.choice.parse({
  token: input.waiting_choice, prefix: "ct_wait_choice_v1", purpose: "waiting",
  ttlMs: WAITING_TTL_MS, bind: { connection: true }, storage: PARSE_STORAGE,
});
if (waiting.shop_ref !== input.shop_ref) throw invalidWaitingChoice();
const options = input.person_option_choices.map((token) =>
  ctx.choice.parse({ token, prefix: "ct_wait_person_v1", purpose: "waiting-person", /* … */ }),
);
// … same for additional options and menus, then upstream register with no replay guard
```

### After — one draft, plain keys, commit

```ts
// waiting-prepare
export const waitingPrepare = defineOperation<ProviderContext>()({
  input: z.object({ shop_ref: z.string().describeKey("waiting_prepare.shop_ref") }),
  output: z.object({
    waiting_token: WaitingDraft.field(),           // SDK-owned description + x-apifuse-handle meta
    shop_ref: z.string().describeKey("waiting.shop_ref"),
    is_open: z.boolean().describeKey("waiting.is_open"),
    order_required: z.boolean().describeKey("waiting.order_required"),
    tables: z.array(/* table, label, waiting_count, estimated_wait_min */).describeKey("waiting.tables"),
    person_options: z.array(/* option, label, additional_options[] */).describeKey("waiting.person_options"),
    menus: z.array(/* menu, name, unit_price */).describeKey("waiting.menus"),
    expires_in_min: z.number().int().describeKey("waiting.expires_in_min"),
  }),
  riskClass: "read",
  connectionMode: "required",
  handler: async (input, ctx) => {
    const offer = await loadWaitingOffer(ctx, input.shop_ref);          // upstream info + menus
    const waiting_token = await ctx.handle.create(WaitingDraft, offer);  // validated against WaitingDraftSchema
    return { waiting_token, ...offer, expires_in_min: 30 };
    // To return the real deadline instead of a constant, use createRecord:
    //   const record = await ctx.handle.createRecord(WaitingDraft, offer);
    //   return { waiting_token: record.handle, ...offer, expires_at: record.expiresAt };
  },
});

// register-waiting
export const registerWaiting = defineOperation<ProviderContext>()({
  input: z.object({
    waiting_token: WaitingDraft.field(),           // same field name as the output — lint checks parity
    table: z.string().describeKey("register_waiting.table"),
    person: z.number().int().min(1).describeKey("register_waiting.person"),
    person_options: z.array(z.object({
      option: z.string().describeKey("register_waiting.person_options.option"),
      count: z.number().int().min(1).describeKey("register_waiting.person_options.count"),
      additional_options: z.array(z.object({
        option: z.string().describeKey("register_waiting.additional_options.option"),
        count: z.number().int().min(1).describeKey("register_waiting.additional_options.count"),
      })).default([]).describeKey("register_waiting.additional_options"),
    })).describeKey("register_waiting.person_options"),
    menus: z.array(z.object({
      menu: z.string().describeKey("register_waiting.menus.menu"),
      quantity: z.number().int().min(1).describeKey("register_waiting.menus.quantity"),
    })).default([]).describeKey("register_waiting.menus"),
    customer_name: z.string().describeKey("register_waiting.customer_name"),
    // no shop_ref: the draft already holds it
  }),
  output: WaitingResultSchema.extend({ status: z.enum(["committed", "replayed"]).describeKey("register_waiting.status") }),
  riskClass: "write",
  connectionMode: "required",
  handler: async (input, ctx) => {
    const draft = await ctx.handle.read(WaitingDraft, input.waiting_token);
    const at = { issuedBy: "waiting-prepare" } as const;

    // Plain keys are validated against the offer stored under the handle.
    const table = pick(draft.data.tables, input.table, { field: "table", ...at });
    const personOptions = input.person_options.map((p) => {
      const option = pick(draft.data.person_options, p.option, { field: "option", ...at });
      const additional = p.additional_options.map((a) => ({
        ...pick(option.additional_options, a.option, { field: "option", ...at }), count: a.count,
      }));
      return { ...option, count: p.count, additional_options: additional };
    });
    const menus = input.menus.map((m) => ({
      ...pick(draft.data.menus, m.menu, { field: "menu", ...at }), quantity: m.quantity,
    }));

    // One-shot: a retried call replays the stored result instead of registering twice.
    const outcome = await ctx.handle.commit(WaitingDraft, input.waiting_token, (data) =>
      upstreamRegisterWaiting(ctx, data.shop_ref, {
        table, person: input.person, personOptions, menus, customerName: input.customer_name,
      }),
    );
    return { ...outcome.result, status: outcome.status };
  },
});
```

`pick` compares as strings: `item[by]` is stringified before the exact and
case-insensitive match. Numeric keys work (`pick(items, input.lot, { field: "lot" })`
finds `{ lot: 7 }` for `"7"`), but when *your* value is a number, pass
`String(id)` — the `value` parameter is a string.

What changed for the model: it copies one 20-odd-character handle instead of
1 + N + M + K 369-character tokens, and everything else it sends is a key it
was shown by name. Request body drops from 1,063 bytes to the reserve flow's
order of magnitude (143–159 bytes measured for the equivalent answer). Expiry
after the user's confirmation turn is covered by `idle: "30m"`, and an expired
handle says so: "expired after 30 minutes; call `waiting-prepare` again and
pass the new `waiting_token` exactly as returned."

If a multi-turn form needs to persist answers between rounds (the reservation
`needs_input` loop), use `update` between rounds and `commit` at the end:

```ts
await ctx.handle.update(ReserveDraft, input.attempt_token, (data) => ({
  ...data,
  selections: { ...data.selections, [answer.selection_key]: answer.selection_value },
}));
```

## 4. Cursor example (public search pagination)

```ts
// before
const cursor = await ctx.choice.issue({
  prefix: "nol_search_v1", purpose: "search-cursor",
  payload: { query, offset: offset + PAGE_SIZE, filters },
  ttlMs: 10 * 60_000,
  storage: { mode: "server", namespace: "nol.search_cursors", maxEntries: 100_000, maxValueBytes: 2_000 },
});
// … and on the way in
const page = await ctx.choice.parse({ token: input.cursor, prefix: "nol_search_v1", purpose: "search-cursor", storage: SEARCH_STORAGE });

// after
export const SearchPage = defineCursor({
  name: "page",                     // handle looks like `page_visor-abnormal-request-anagram`
  fieldName: "cursor",
  schema: z.object({ query: z.string(), offset: z.number().int().min(0), filters: FiltersSchema }),
  ttl: "10m",
  access: "public",                 // anonymous operation: no connection to bind to
  maxEntries: 100_000,              // required for public kinds
  maxValueBytes: 2_000,
  issuedBy: "search",
});

// schema: same helper on both sides; optional because the first page has none
input:  z.object({ query: z.string().describeKey("search.query"), cursor: SearchPage.field().optional() }),
output: z.object({ items: /* … */, cursor: SearchPage.field().optional() }),

// handler
const page = input.cursor
  ? (await ctx.handle.read(SearchPage, input.cursor)).data
  : { query: input.query, offset: 0, filters: defaultFilters };
const { items, hasMore } = await upstreamSearch(ctx, page);
const cursor = hasMore
  ? await ctx.handle.create(SearchPage, { ...page, offset: page.offset + PAGE_SIZE })
  : undefined;
return { items, cursor };
```

A public cursor with `ttl` above one hour, or declared `strength: "high"`,
gets five words. Everything an operation with a connection paginates should
stay bound (the default) and two words.

> **Expired vs unknown.** A handle past its logical expiry answers `HANDLE_EXPIRED` (HTTP 410) for a grace window of `min(lifetime, 1h)` — drafts until `max` + grace — and `HANDLE_NOT_FOUND` (HTTP 404) after that. Both carry the same recovery sentence; map both to your provider's "start the flow again" code. Public cursors always collapse to `HANDLE_INVALID` (HTTP 400).

### Leaving a commit without committing

`commit` has two exits: return a result (committed, replayable) or throw
(the draft is restored to `active` with a refreshed idle deadline and the
error propagates). When the confirm step discovers it still needs input —
the `needs_input` doctrine — throw a private signal from the callback, catch
it in the handler, `update` the draft with what you learned, and return the
`needs_input` payload:

```ts
class NeedsInputSignal { constructor(readonly pending: ReservationRequiredSelection[]) {} }

try {
  const { result } = await ctx.handle.commit(ReserveDraft, token, async (draft) => {
    const round = await runReserveRound(ctx, draft);
    if (round.status === "needs_input") throw new NeedsInputSignal(round.required_selections);
    return round.created;
  });
  return result;
} catch (error) {
  if (error instanceof NeedsInputSignal) {
    await ctx.handle.update(ReserveDraft, token, (d) => ({ ...d, pending: error.pending }));
    return { status: "needs_input", attempt_token: token, required_selections: error.pending };
  }
  throw error;
}
```

### Commits with real-money upstream calls: the side effect must never re-run

`commit` guarantees the callback runs at most once *per successful commit*. A
callback that throws restores the draft to `active` so the caller can retry —
which is right when the upstream call itself failed, and wrong when the upstream
call succeeded and something *after* it threw (a parse error on the receipt, a
logging bug). A retry would then charge the customer twice. Two rules:

1. **Persist a `dispatch_attempted`-style marker with `update` before the
   upstream call.** If the process dies mid-call, the next attempt sees the
   marker and reconciles (query the upstream for the order) instead of
   dispatching again.
2. **After the upstream call has returned, never throw out of the callback.**
   Treat a failure at that point as "outcome unknown": return a result that
   records the failure so it is committed and replayed, and let the operation
   report it.

```ts
const PaymentResult = z.object({
  status: z.enum(["paid", "unknown"]),
  receipt: z.string().optional(),
  failure: z.string().optional(),
});

// Pay flow: mark, dispatch, commit whatever happened.
const draft = await ctx.handle.read(PayDraft, input.pay_token);
if (draft.data.dispatch_attempted) {
  // A previous attempt reached the upstream. Reconcile instead of paying again.
  const existing = await upstreamFindPayment(ctx, draft.data.quote_id);
  if (existing) {
    const { result } = await ctx.handle.commit(PayDraft, input.pay_token, async () => ({
      status: "paid", receipt: existing.receipt,
    }));
    return result;
  }
}
await ctx.handle.update(PayDraft, input.pay_token, (d) => ({ ...d, dispatch_attempted: true }));

const { result } = await ctx.handle.commit(PayDraft, input.pay_token, async (data) => {
  const response = await upstreamPay(ctx, data);            // may throw: nothing charged, retry is safe
  try {
    return { status: "paid", receipt: parseReceipt(response) };
  } catch (error) {
    // Money moved (or may have); do NOT throw — commit the unknown outcome so a
    // retry replays it instead of paying twice.
    return { status: "unknown", failure: error instanceof Error ? error.message : String(error) };
  }
});
if (result.status === "unknown") {
  throw new ProviderError("Payment outcome unknown; check the receipt list before retrying.", {
    code: "PAYMENT_OUTCOME_UNKNOWN", category: "provider_error", retryable: false, details: result,
  });
}
return result;
```

`upstreamPay` throwing *before* it sends anything is the case `commit` already
handles (draft restored, retry safe). Everything after the request left the
process belongs to the "outcome unknown" branch.

## 4a. Connectionless providers (`auth: none`)

A provider with no connections has no `request.connectionId`, so a bound draft
throws `HANDLE_CONNECTION_REQUIRED` on `create`. If such a provider still needs
a multi-turn form with a one-shot commit — modu-parking's quote → pay flow was
the motivating case; without a draft its payment had no replay guard — declare
the draft public:

```ts
export const PayDraft = defineDraft({
  name: "pay",
  fieldName: "pay_token",
  schema: PaySchema,
  result: PaymentResult,
  ttl: { idle: "5m", max: "30m" },
  access: "public",                 // provider scope; 4 words (5 when ttl.max > 1h or strength: "high")
  maxEntries: 10_000,               // required, provider-wide live-entry quota
  issuedBy: "parking-quote",
});
```

What changes versus a bound draft:

- Word count follows the public rules (ADR-0012 D3): 4 words, 5 when
  `ttl.max > 1h` or `strength: "high"` (`strength` is public-only).
- `maxEntries` is required and is provider-wide, not per connection.
- Every lookup failure collapses to `HANDLE_INVALID` — not found, idle expiry,
  max expiry, malformed — exactly like a public cursor. Map it to your
  "start the flow again" code. `HANDLE_BUSY` and `HANDLE_COMMITTED` are still
  reported (they need the exact live key).
- `update`, `commit`, replay, and `discard` behave the same as for bound drafts.

Do not make a draft public on a provider that *has* connections; that trades
connection isolation for a guessable key (ADR-0012 Pitfall 1).

## 5. Error handling

`HandleError` is already a `ProviderError` with `category`, `retryable`, and a
message that ends in the recovery sentence, so the simplest correct handler
lets it propagate. Wrap only when the operation's `errorCodes` contract needs a
provider-specific code, and keep `cause`, `details`, and `fix`:

```ts
import { HandleError, ProviderError } from "@apifuse/provider-sdk";

function mapWaitingHandleError(error: unknown): never {
  if (!(error instanceof HandleError)) throw error;
  const base = { cause: error, fix: error.fix, details: error.details, retryable: false } as const;
  switch (error.code) {
    case "HANDLE_EXPIRED":                // bound draft past `max`
    case "HANDLE_NOT_FOUND":              // bound record gone (idle TTL elapsed, discarded, other connection)
    case "HANDLE_KIND_MISMATCH":          // not a `waiting_…` handle at all
      throw new ProviderError(error.message, { ...base, code: "STALE_WAITING_TOKEN", category: "input_validation" });
    case "HANDLE_COMMITTED":              // update after register
      throw new ProviderError(error.message, { ...base, code: "WAITING_ALREADY_REGISTERED", category: "input_validation" });
    case "PICK_NOT_OFFERED":              // details.allowed lists the valid keys
      throw new ProviderError(error.message, { ...base, code: "INVALID_WAITING_SELECTION", category: "input_validation" });
    case "HANDLE_BUSY":                   // concurrent commit; retryable
      throw error;
    default:                              // HANDLE_STORAGE_UNAVAILABLE, HANDLE_TOO_LARGE, HANDLE_CONNECTION_REQUIRED, HANDLE_INVALID
      throw error;
  }
}
```

Rules that follow from the security model (ADR-0012 D2/D3):

- Public kinds only ever raise `HANDLE_INVALID` for a bad handle. Do not try to
  distinguish expired from missing for a public cursor; the SDK will not tell you.
- Bound kinds raise `HANDLE_NOT_FOUND` / `HANDLE_EXPIRED` / `HANDLE_COMMITTED`
  because the caller is already inside the connection scope.
- Never inspect the handle string before `read`. `HANDLE_KIND_MISMATCH` is the
  SDK's shape check; provider-side `startsWith` checks defeat normalization.

## 6. Tests

```ts
// before
import { createTestProviderChoiceContext, createMemoryProviderRuntimeState } from "@apifuse/provider-sdk";
const state = createMemoryProviderRuntimeState();
const choice = createTestProviderChoiceContext({ providerId: "catchtable", state, request });
const token = await choice.issue({
  prefix: "ct_wait_choice_v1", purpose: "waiting", payload, ttlMs: 7 * 60_000,
  bind: { connection: true }, storage: WAITING_STORAGE,
});

// after — everything comes from the package root
import {
  createMemoryProviderRuntimeState,
  createTestHandleContext,
  normalizeHandle,
} from "@apifuse/provider-sdk";
import { WaitingDraft } from "../handles";

const state = createMemoryProviderRuntimeState();                    // share it to test isolation
const request = { connectionId: "af_con_test0000000000000000" };   // bound kinds need one
const handle = createTestHandleContext({ providerId: "catchtable", state, request });

const token = await handle.create(WaitingDraft, offer);
expect(token).toMatch(/^waiting_[a-z]+-[a-z]+$/);

// createRecord returns what read returns, including the deadline
const issued = await handle.createRecord(WaitingDraft, offer);
expect(issued.expiresAt).toBe(new Date(Date.now() + 30 * 60_000).toISOString()); // with a fake clock

// tolerant read: the 2026-08-21 damage classes resolve to the same record
const record = await handle.read(WaitingDraft, ` "${token.toUpperCase()}". `);
expect(record.handle).toBe(token);
// normalizeHandle returns { canonical, words, normalization }
expect(normalizeHandle(WaitingDraft, token.replace("-", " "))).toEqual({
  canonical: token,
  words: token.slice("waiting_".length).split("-"),
  normalization: ["separator", "whitespace"],
});

// commit once, replay after
const first = await handle.commit(WaitingDraft, token, async () => ({ waiting_number: 7, registered_at: now }));
const again = await handle.commit(WaitingDraft, token, async () => { throw new Error("must not run"); });
expect(first.status).toBe("committed");
expect(again).toMatchObject({ status: "replayed", result: first.result });

// isolation: another connection on the same state cannot see it
const other = createTestHandleContext({
  providerId: "catchtable", state, request: { connectionId: "af_con_other000000000000000" },
});
await expect(other.read(WaitingDraft, token)).rejects.toMatchObject({ code: "HANDLE_NOT_FOUND" });
```

Operation-level tests through the SDK harness (`runProviderOperation` in
`testing/run.ts`) need no change beyond the declaration: the harness wires
`ctx.handle` from its memory state exactly as it wired `ctx.choice`. Tests that
asserted a synchronous `string` return from inline `issue` become `await`.

## 7. Checklist

1. Bump the SDK pin. Run `tsc`; every error is a site to migrate. Do not add
   `// @ts-expect-error` — there is no shim to wait for.
2. For each `issue`/`parse` pair, decide the kind: read-only continuation →
   `defineCursor`; anything mutated across turns or committed once →
   `defineDraft`. Pick a letters-only `name`; drop the old prefix and its
   version suffix.
3. If the old site had no `bind` and the operation has `connectionMode: "none"`,
   the kind is `access: "public"` and needs `maxEntries`. Otherwise keep it bound.
   A draft may be public only on a connectionless provider (§4a).
4. Replace per-option tokens with plain keys stored in the draft and validated
   with `pick`. Remove inputs that only existed for cross-validation (`shop_ref`).
5. Replace `consume: "explicit"` + replay-record code with `commit`. Delete the
   provider-owned dedup namespace once nothing reads it.
6. Put `Kind.field()` on both the output and the input; make sure the property
   key equals `fieldName` (lint `handle-field-name`, `handle-field-parity`).
   Remove hand-written `.describeKey()` on those fields and the now-unused
   locale keys.
7. Add `handle: [...]` and `state: {}` to `defineProvider`; delete `choice: true`.
8. Map `HandleError` codes in the operation's `errorCodes` contract where a
   provider-specific code is required (§5); otherwise let them propagate.
9. Rename test helpers (`createTestHandleContext`); give bound-kind tests a
   `request.connectionId`.
10. Remove `APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET` from every
    env file, compose file, and deployment manifest the repository owns.
11. Run the provider lint. `legacy-choice-usage` must be 0; `handle-*` rules
    must be clean; `handle-requires-state` must not warn.
12. Update the consumer-facing contract docs for changed operations (field
    names, removed inputs) in the same PR, and note that in-flight tokens are
    invalidated at deploy.
