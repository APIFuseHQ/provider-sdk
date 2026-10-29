## Generator and runtime alignment

- Canonical scaffolding command: `apifuse create`
- External bounty workspaces are one-provider repositories initialized with the standalone create flow. `--preset monorepo` is an internal APIFuse maintainer path only and must reject outside the private monorepo detected by `packages/provider-sdk/package.json`.
- Standalone bounty contributors should use `bunx @apifuse/provider-sdk@beta create <name> --yes` until this release is promoted to `latest`
- Provider server contract is:
  - dev default `3900`
  - start/Docker/container `3000`
  - `GET /health`
  - `POST /v1/{operation}`
  - `POST /auth/start`
  - `POST /auth/continue`
  - `POST /auth/poll`
  - `POST /auth/disconnect`
- Generator v1 for this redesign scaffolds TypeScript providers only. Python generation is future work.

## Provider Authoring Guide

Provider code is the declaration input to the internal platform registry. The public SDK owns provider authoring/runtime ergonomics; internal docs, deploy, and discovery projections are built downstream from those declarations. `bun run lint:providers` enforces provider authoring standards.

### User-input round-trips: never dead-end (`needs_input`)

A mutation MUST NOT fail for a problem the end user can resolve by choosing among live options (a required menu/course selection, a form question, a stale-but-recoverable state token). Throwing an error there strands the consuming agent: consumer error-shaping layers routinely strip error metadata, and a model that only sees "error" narrates failure to the user instead of relaying the choice.

Return the official success-shaped contract from `src/user-input.ts` instead (`ProviderNeedsInputPayload`, guard `isProviderNeedsInputPayload`):

- `status: "needs_input"` plus `required_selections` — only the still-pending questions, with human-readable `label`s and `valid_options` the agent relays verbatim. The agent never chooses for the user; anything with no real choice (agreement checkboxes, single-option required groups) is the provider's job to auto-answer.
- `selected_options` — selections already settled, echoed so the retry keeps them (copy them back and add the user's new answers).
- a freshly minted provider state token in the same response, so the retry never races an expired token.

No retry templates, next-action routing, or other agent choreography: provider payloads carry upstream-backed data only, and the consumer owns how the ask is phrased and how the retry call is shaped.

Declare the union in the operation `output` schema (`z.union([CreatedSchema, NeedsInputSchema])`). Reserve hard errors for genuinely unrecoverable flows (payment-gated, unsupported input kinds) and state the concrete reason in the error `message` itself, not only in `details`. Reference implementation: `providers/catchtable` `reserve` in the platform monorepo.

### Attempt tokens: the server carries the decisions

When a mutation needs more than one user decision (or one decision plus a
final go/no-go), do not make the agent re-send accumulated state across
rounds — weak models drop or corrupt it. Split the operation into a
**prepare/confirm pair** driven by a server-held attempt record:

- The prepare operation is non-destructive. A start call takes only the
  scalar intent fields; every response returns a fresh `attempt_token`
  referencing a server-side record (a `ctx.handle` draft kind from
  `defineDraft`, declared on the schema with `kind.field()`) that stores
  every settled decision. Continue calls take `attempt_token` plus only the
  NEW answers.
- `needs_input` rounds list only the still-pending selections; settled
  decisions may ride along in a display-only field but are never re-sent.
- When nothing is pending, the prepare operation returns `status: "ready"`
  with a human-readable summary — the consumer's user-facing confirmation.
- The confirm operation is the only mutation and takes exactly
  `{attempt_token}`. It re-validates everything live before executing and
  returns `needs_input` (fresh token) instead of proceeding when upstream
  drift invalidates a stored decision — never substitute a different option
  for what the user picked.
- Expired or foreign tokens fail factually (nothing happened; start a new
  attempt with the scalar fields) — no answer salvage from a dead token.
- **Commit is one-shot with replay; providers no longer hand-roll dedup.**
  `ctx.handle.read` and `ctx.handle.update` never consume a draft, so a
  confirm handler must execute upstream work through `ctx.handle.commit`. It
  runs the work once, stores the result under the handle, and a repeated
  confirm returns `{ status: "replayed", result }` without touching upstream.
  A failing upstream call restores the draft to `active`, so an interrupted
  confirm stays retryable; later prepare rounds on a committed draft fail
  factually with `HANDLE_COMMITTED`.

The invariant behind all of it: complex flow state is the system's job, not
the model's. The model carries exactly one opaque key between calls.
Reference implementations: `providers/catchtable` `reserve`/`reserve-confirm`
(including the consume-on-success guard) and `providers/modu-parking`
payment state tokens in the platform monorepo.

### Description template

Every operation declares a `descriptionKey`. Its English locale value should
follow this structure:

```
<What the tool does in one sentence>. Use when <specific scenarios>. Do NOT use for <counter-scenarios; point to alternatives>. Returns <key output fields>. <Important caveats: rate limits, auth, freshness>.
```

Example declaration and locale entry:
```ts
descriptionKey: "operations.realtimeWeather.description",
```

```json
{
  "operations": {
    "realtimeWeather": {
      "description": "Retrieves KMA ultra-short-term weather observations for a South Korean grid coordinate. Use when the user asks about current or hourly weather. Do NOT use for forecasts beyond two days; use the mid-range forecast operation instead. Returns hourly KST data; null values mean unavailable data."
    }
  }
}
```

### Language policy

- **Structural text**: locale keys (`descriptionKey`, the other `*Key`/`*Keys`
  fields, schema `.describeKey()`, and `examples[].scenarioKey`/`rationaleKey`).
- **Values only**: native language (fixtures payloads and `examples[].input`
  values like "대방동", "KRW-BTC", entity catalog entries).

### Required per operation

- `riskClass` — authored as `read`, `write`, `destructive`, or `external-send`
- `descriptionKey` — backed by every required provider locale catalog
- `connectionMode` — explicit for `credentials`, `oauth2`, and `oauth2_proxied` providers
- Every Zod field in input AND output has `.describeKey()` including nested objects + array items (error-level rule)
- `fixtures.request` + `fixtures.response` both present (error-level rule)
- Exactly one of `healthCheck`, `healthCheckUnsupported`, or `healthJourneys[].coversOperations` coverage per operation. Prefer `healthCheck` for safe read-only upstream probes; use `healthCheckUnsupported` only with a specific reason for destructive, paid, credential-sensitive, flaky, or otherwise unsafe probes. Use a provider-level health journey when a destructive or credential-sensitive flow can be proven safely only as a multi-step boundary test, such as stopping at a payment WebView URL.

### Capability declarations

Declare each capability used by provider operations. Capabilities without
configuration use a bare object, for example `http: {}`, `state: {}`, or
`cache: {}`. `handle` is the exception: it takes an array of kinds
(`handle: [WaitingDraft]`) and requires `state: {}` alongside it. `trace` is
ambient and must not be declared: every operation
context receives it. `allowedHosts`, `proxy`, `sessionState`, `secrets`, and
`context` declare policy or metadata only; they do not create context members
and are not capability bindings.

Declare `runtimeTarget: "vanilla"` for portable provider business logic. Use
`runtimeTarget: "engine"` only for an approved session-bearing provider that
must remain engine-resident. A vanilla target cannot declare `native`.

Proxy vendor usernames, passwords, and application keys are engine-owned. Do
not list `APIFUSE__PROXY__SMARTPROXY_USERNAME`,
`APIFUSE__PROXY__SMARTPROXY_PASSWORD`, `APIFUSE__PROXY__SMARTPROXY_APP_KEY`,
`APIFUSE__PROXY__NODEMAVEN_USERNAME`, or
`APIFUSE__PROXY__NODEMAVEN_PASSWORD` in provider `secrets`; `proxy` contains
policy intent only.

`proxy.providers` is a preference order, not a fixed walk. A served process
keeps a circuit breaker per vendor: after 5 consecutive attempts that failed
because of the vendor (the tunnel never opened, the proxy refused, the
connection broke through the proxy, or no proxy could be synthesized) it skips
that vendor for 30 s, longer on each repeat up to 300 s, and one probe attempt
decides when the vendor returns. Within one request, the attempt after such a
failure moves to another vendor of the chain right away. Timeouts,
cancellation and every upstream status never count against a vendor, and when
every vendor is skipped the declared order is used as is. Nothing in the policy changes; an operator keeps
the fixed order with `APIFUSE__PROXY__VENDOR_SELECTION=ordered`. The request
log's `proxy.selection.reason` (`chain_order`, `vendor_open`,
`half_open_probe`, `all_open`, `retry_alternate`) and `proxy.vendorStates` say why an attempt went
where it did, and every state change logs one `proxy_vendor_state` line. See
`docs/adr/0016-adaptive-proxy-vendor-selection.md`.

When only some operations need proxy egress, scope the provider-level policy
with `proxy.operations`. Listed operations get the policy on `ctx.http`,
`ctx.stealth`, `ctx.native.network` and the resolver chain; every other
operation and every auth flow egresses directly, as if `proxy` were not
declared. Keep the policy on the provider rather than on an operation: the
deployment projects the vendor credentials from the provider-level
declaration. NodeMaven-only username tokens go in `proxy.nodemaven`:

```ts
proxy: {
  mode: "required",
  providers: ["nodemaven"],
  geo: { country: "KR" },
  nodemaven: { type: "mobile", isp: ["sk_telecom", "lg_uplus"] },
  operations: ["get-stay-detail", "list-room-rate-plans"],
},
```

Each attempt encodes one carrier, `isp[attempt % isp.length]`. When an
upstream's edge answers with a block page that issues a session cookie, do not
retry by hand: declare the cookie as session state (below). The SDK re-sends
the blocked request once carrying the cookie, on the next attempt (next
carrier, new session id), exactly as a caller retry with `proxyAttemptOffset: 1`
would, and later calls carry the pooled cookie from the start.

### Session state (`sessionState`)

Values an upstream hands a client and expects back on later requests
(an edge's bot-management cookie, a login session cookie, a token header) are
declared, not hand-managed. `defineProvider({ sessionState: { <name>: ... } })`
takes named `ProviderSessionState` declarations in four parts:

- `acquire`: where the state comes from. `from: "response"` captures it from
  the responses of in-scope requests themselves (a block page or any served
  response); `from: "request"` issues a declared request (or a provider
  function) first; `from: "credential"` reads it from the connection
  credential the auth flow completed with. `capture` names what must be
  present: `Set-Cookie` names (attributes kept), response headers, JSON dot
  paths, credential keys, and optionally an upstream expiry.
- `carry`: where the state goes: `{ as: "cookies" }` (the captured cookies),
  `{ as: "cookie", name, value }`, `{ as: "cookie-header", value }`,
  `{ as: "header", name, value, format: "Bearer {value}" }` or
  `{ as: "query", name, value }`. `value` names a captured value. A header,
  query parameter or `cookie` header the caller sets itself wins, and the
  declaration stays out of that request.
- `validity`: `ttl` from the first acquisition, `idleTtl` since the last use,
  `maxUses`, and `invalidWhen`: a declarative `ResponseMatcher` (status,
  headers, body substrings or pattern, JSON paths), an array of them, or a
  provider function. A response judged invalid retires the state; up to
  `reacquire` times per request the SDK acquires a fresh one and re-sends
  the request when its method is in `replayMethods` (default GET, HEAD,
  OPTIONS, the SDK safe set). `defineProvider` rejects a declaration with no
  bound at all. A captured cookie's own `Expires` and `Max-Age` never retire
  it: edges state expiries they do not enforce, so `validity` alone decides
  how long a stored value is carried.
- `distribute`: `hosts` (each in `allowedHosts`), `operations` (omitted:
  every operation; auth flows are never in scope), `scope` (`provider`: one
  pool for every caller, `connection`: a pool per connection), `qps`,
  `maxConcurrent` and `egress` (`independent`, or `pinned` to re-use the
  stealth exit the state was acquired on).

`qps` is the throughput assigned to one state, not a rate limit: a request
goes to the oldest state with room left in its share, and when every state
has used its share the SDK acquires another state instead of making the
request wait. The pool therefore grows to about `request rate / qps` states
and has no declared size; states that go unused retire on their own
lifetime. With `qps` omitted, one state carries every request and concurrent
callers wait only for an acquisition already in flight.

The SDK knows one edge by name: `sessionStatePresets.cloudflareBlockPage(...)`
returns a plain `ProviderSessionState` (passive acquisition of `__cf_bm`,
judged by the exported `CLOUDFLARE_BLOCK_PAGE` matcher, one re-acquisition).
Spread it to override any part; a declaration written by hand with the same
values behaves identically.

```ts
sessionState: {
  stayEdge: sessionStatePresets.cloudflareBlockPage({
    hosts: ["stays.example"],
    operations: ["get-stay-detail", "list-room-rate-plans"],
    ttl: "20m",
  }),
},
```

When the layer cannot absorb an invalid response it returns it with
`response.sessionState` (`name`, `outcome`, `attempts`, `carried`) whatever
`throwOnHttpError` says: `reacquire_exhausted`, `acquire_failed`,
`replay_required` (a fresh state was acquired but the method is not
re-sent automatically) or `credential_invalid`. Error codes stay the
provider's: map the classification to `BLOCKED` or `SessionExpiredError`
and report `attempts` in `details` if the operation contract carries a
count. A state from the credential is carried and judged only; renewing a
credential stays with the gateway's `auth.flow.refresh`. Captured values are
registered as diagnostic values and never reach logs, telemetry or errors;
the stealth and http telemetry of a request count `acquired`, `reused`,
`expired`, `invalidated`, `reacquired` and `waited`. On `ctx.http` the layer
judges the final response, so a request in scope is sent with
`throwOnHttpError: false` internally and explicit status-code retries do not
apply to it; transport retries do. `stream` and `sse` are not in scope.

Hosted runtime settings are engine-owned as well: every `APIFUSE__CDP_POOL__*`
variable, the Cloudflare OCR/STT tokens and account identifier,
`APIFUSE__OCR__API_KEY`, and `APIFUSE__CACHE__KEY_PEPPER`. `defineProvider`
rejects them in `secrets`; the engine reads them from its own environment.
Provider code must not probe those names either — to learn whether OCR is
configured, read `ctx.ocr.available` (see the OCR section below).

### Engine mode

Provider processes attach their capability bindings through an engine. Today the
default is the in-process engine; ADR-0011 replaces it with the authenticated
remote engine in a phased migration, and `serve` logs every boot as
`provider_engine_mode` (`deprecated: true` for in-process). You do not need to
change anything now.

A deployment names the mode with the engine-owned `APIFUSE__ENGINE__MODE`
variable (`in-process` or `remote`; trimmed and case-folded, blank means unset);
hosts may pass `engineMode` to `serve`/`createServerApp`/`startDevServer`
instead. The manifest wins when the two disagree, so provider code cannot
silently downgrade what the deployment asked for; the disagreement is reported in
the boot event's `warnings`. An unrecognized value is warned about and ignored —
it never crashes the process. `APIFUSE__ENGINE__MODE` cannot be declared in
`secrets` (`APIFUSE__ENGINE__*` is engine-owned).

`remote` has no client in this release: the server attaches an engine that fails
every request with `PROVIDER_ENGINE_MODE_UNSUPPORTED` and reports `503` on
`/readyz`. It never falls back to in-process. `apifuse dev` and `apifuse record`
refuse to start instead.

`GET /health` is liveness only and stays engine-blind; `GET /readyz` reports the
resolved engine attachment and is what readiness/startup probes should use — but
only for a provider already pinned to an SDK release that serves the route.
Earlier pins answer `404`, and a failing readiness/startup probe is not
self-healing, so manifests move to `/readyz` after the pin wave, never before.

`GET /__apifuse/diagnostics/runtime` is the internal runtime diagnostics route on
the same listener. It answers one JSON report (`schemaVersion: 1`) sampled over a
short window (`?windowMs=`, default 250, clamped to 50..5000): `cpu.window`
(`process.cpuUsage()` delta as cores, user/system split), `cpu.lifetime`,
`memory`, `eventLoop` (`performance.eventLoopUtilization`), `activeResources`
(`process.getActiveResourcesInfo()` counts by type) and, on Linux, `procfs`
with per-thread CPU ticks, context switches, wait channel and file-descriptor
counts by kind from `/proc/self`. Bun 1.2 and 1.3 stub the two Node APIs, so
their `reported` flag is `false` there; `cpu.window` and `procfs.threads`
(sorted hottest first, named `bun`, `HTTP Client`, `HeapHelper`, ...) are the
signals that tell an idle process that still burns CPU apart from a busy one.
The route is read-only and carries no secrets. It is internal by the same
boundary as `/health` and `/readyz`: the generated provider NetworkPolicy admits
only the gateway on this port and the gateway dials canonical operation paths
only, so operators reach it with `kubectl port-forward` and the tenant-facing
API never does.

### Deployment intent

Deployment intent (runtime profile, resources, HPA, Redis, extra TCP ports) has
exactly one authored home: the optional `deployment` key inside
`defineProvider({...})`. The SDK passes it through verbatim; the APIFuse
registry resolves omitted fields from the runtime profile and rejects anything
it cannot resolve.

- Declare only what differs from the profile. Profile defaults:
  `runtime: "shared"`, `language: "typescript"`, `replicas: 1`,
  `hpa: { enabled: true, minReplicas: 1, maxReplicas: 1, targetCPUUtilizationPercentage: 70 }`,
  resources `25m/128Mi` (shared) or `200m/256Mi` (browser), `buildContext: "."`.
  Most providers therefore declare no `deployment` key at all.
- The deployment `runtime` axis (`shared | dedicated | browser`) is distinct
  from the execution `runtime` (`standard | shared | browser`) declared next to
  it.
- Do not author a standalone `deploy.ts`, a `deployment` extra on a spread
  default export (`export default { ...provider, deployment }`), or a
  re-exported config module. A repository that still carries `deploy.ts`
  migrates with `apifuse migrate-deployment .`: it hoists the file's non-default
  values into the declaration, proves the result resolves identically, and
  deletes the file. The `/deploy.ts` CODEOWNERS entry stays until the platform
  stops honoring a re-added legacy file (`--drop-codeowners-lock` then). A
  refusal names the manual step.
- `apifuse check` warns during the migration window
  (`deployment/legacy-deploy-file`, `deployment/spread-export`,
  `deployment/redundant-default`); the rules become errors once no repository
  carries the legacy file.

```ts
const buildProvider = defineProvider({
  id: "example",
  version: "1.0.0",
  runtime: "standard",
  deployment: { cache: { redis: { enabled: true } } },
  // ...
});
```

### Factored operations

`defineProvider(declaration)` returns the builder that accepts `operations`, so
inline handlers are typed only after capability declarations are fixed. Export
one declaration-derived context alias from the provider entry point:

```ts
import {
  defineProvider,
  type ProviderContext,
  type ProviderDeclaration,
} from "@apifuse/provider-sdk/provider";

const declaration = {
  // ...id, version, runtime, meta
  http: {},
} as const satisfies ProviderDeclaration;

export type Ctx = ProviderContext<typeof declaration>;
const buildProvider = defineProvider(declaration);
```

Separate operation files need one provider-local type import and no generic
handler signature:

```ts
import { defineOperation } from "@apifuse/provider-sdk/provider";
import type { Ctx } from "../index.js";

export const search = defineOperation<Ctx>()({
  // ...input, output, fixtures, health check
  async handler(ctx, input) {
    return fetchSearch(ctx.http, input);
  },
});
```

`ProviderContextOf<typeof buildProvider>` remains an equivalent convenience
alias. Helpers should accept the one SDK client they use rather than the
provider context. Zod and Standard Schema v1 schemas retain input/output
inference. Invalid configs name the offending field, such as `auth.mode` or
`operations.<id>.fixtures.response`.

### Replay-safe fixtures

Keep public operation schemas strict: date fields should accept absolute dates,
not relative tokens. Inside `fixtures.request` only, the SDK resolves `+Nd`,
`-Nd`, and their `:YYYYMMDD` forms (sign required, -365 to 365 days; `+0d` is
today) before import-time schema validation and stores the resolved request in
provider metadata. Health-check case inputs use the same resolver when a probe
runs, so a window that ends today is `{ start_date: "-30d", end_date: "+0d" }`.
A declarative scenario writes the same window as two `relativeDate` nodes with
`offsetDays: -30` and `offsetDays: 0`; both are evaluated from one anchor
instant, so keep the start offset at or below the end offset. The default calendar is **KST**, including
the 15:00–23:59 UTC window when KST is already on the next day.

`fixtures.recordedAt` is the KST `YYYY-MM-DD` date when the response evidence
was captured. It must be a real, non-future calendar date. Response date fields
are expected to align with `recordedAt`, not with the newly resolved request;
this permits stable recorded evidence alongside a replay-safe request.

```ts
const FlightInput = z.object({
  departureDate: z.string().date(), // public calls remain absolute-date only
});

const searchFlights = {
  input: FlightInput,
  output: FlightOutput,
  async handler(ctx, input) {
    return fetchAndNormalizeFlights(ctx, input);
  },
  fixtures: {
    request: { departureDate: "+45d" },
    response: recordedFlightResponse, // dates reflect the capture below
    recordedAt: "2026-07-15",
  },
  healthCheckUnsupported: { reason: "Upstream search is cost-bearing." },
};
```

For code that explicitly calls the shared resolver, omit the third argument to
use KST or pass `"UTC"` deliberately:

```ts
import { resolveHealthCheckInputDateTokens } from "@apifuse/provider-sdk/server";

const kstInput = resolveHealthCheckInputDateTokens({ date: "+45d" });
const utcInput = resolveHealthCheckInputDateTokens({ date: "+45d" }, new Date(), "UTC");
```

Do not re-resolve a health assertion's dates in UTC when its case input used the
default KST calendar.

### Sensitive vs public fields

The platform fixture-privacy ratchet flags name-, phone-, and address-shaped keys
unless the schema at that path declares them one way or the other. Declare every hit:

- `sensitive(schema, kind)` / `fields.*()` — anything about a person: user, profile,
  passenger, driver, or member names, emails, member ids, personal phone numbers.
  Emits `x-apifuse-sensitive: true`; the value is redacted in published artifacts.
- `publicField(schema)` — reviewed public data: business, shop, product, artist, or
  facility names, hospital/hotel/station phones, timezone names. Emits
  `x-apifuse-sensitive: false`; nothing is redacted. It is a review verdict, not a mute.
  Credential-shaped keys (token, password, apiKey, …) cannot be declared public.

Apply either helper to the leaf, before `.optional()`/`.nullable()`/`.default()`;
`publicField()` over a wrapper that hides a `sensitive()` leaf throws at definition time.

### Images and item links

Public output names a picture or a page by declaring it, not by its field name.
New providers and new fields use the helpers now. Adopting a helper on an
existing field rotates the operation's compatibility hash (the annotation is
part of the contract) and, for a field that was not nullable, widens it to
admit `null`; existing providers move in the migration order of the openspec
change `add-output-url-kinds` (registry classification first, then the pilot
repositories, then the fleet wave), not ahead of it.

| What the value is | Schema | Mapper |
|---|---|---|
| The item's main picture | `image()` | `toImageUrl(raw, { base?, upgradeHttp?, field? })` |
| A smaller rendition of it | `image({ thumbnail: true })` | same |
| More pictures, upstream order | `imageList()` | `toImageUrls(raws, options)` (drops duplicates) |
| The item's own page | `itemPage()` | `toItemPageUrl(raw)` or `itemPageFrom(template, values)` |
| Any other URL (source, download, booking, map image) | `link()` | `toLinkUrl(raw)` |

- Keep existing field names (`image_url`, `detail_url`, ...); the annotation says
  what they are. New fields use the fleet names `image_url`, `image_urls`,
  `thumbnail_url`, `url`.
- A missing or left-out value is `null`, the fleet's "upstream did not
  provide it": the constructors return `null` and `image()`, `itemPage()` and
  `link()` admit it without `.nullable()`. Add `.optional()` only when the key
  itself may be absent. `imageList()` is empty instead.
- Adopting on an existing `.nullable()` field drops the wrapper:
  `z.string().nullable()` becomes `image()`, not `image().nullable()`. The
  contract is the same either way (the SDK emits a redundant `null` branch
  around a helper as the helper alone), but the helper already admits `null`,
  so the wrapper only adds noise.
- Pass `field: "items[].image_url"` so a dropped value is attributable in the
  request log. Keep it a static label, not a per-row path.
- `upgradeHttp` lists only host names you measured serving the same path over
  `https://`. An `http://` image on another host, or one naming a port, is
  dropped and reported.
- `itemPageFrom("https://www.example.com/items/{item_id}", { item_id })`
  percent-encodes each value as one component and yields `null` when a
  value is missing. Assemble a page only from a template you verified opens
  the item.
- Upstream values never throw. Arguments you write do, on every call whatever
  the value, so any mapper test catches them: a `base` that is not an
  absolute `http(s)` URL, an `upgradeHttp` entry that is not a host name, an
  `itemPageFrom` template that is not absolute `http(s)://`, a placeholder
  without a value entry.
- An item has one own page and one main picture: a second `itemPage()` or
  non-thumbnail `image()` in the same object is a declaration error. Declare
  other URLs with `link()`.
- `noMedia: noMedia("<upstream evidence>")` records that the operation's items
  have no picture and no page upstream. It cannot sit next to `image()`,
  `imageList()` or `itemPage()` fields.
- Values are plain URL strings at runtime. Do not invent width, height or alt
  text; the item's title is its caption.

#### Coverage warnings and the migration codemod

`apifuse check` prints two warnings under "Output URL coverage". They never
change the exit status and no count turns them into a failure:

| Warning | Evidence | Turned off by |
|---|---|---|
| `output-url-unclassified` | a recorded fixture output holds an absolute `http(s)` URL, or the schema declares `format: "uri"` (`z.string().url()`), at a string field no helper declares | declaring it `image()`, `itemPage()` or `link()` |
| `output-url-item-coverage` | the output has an object array, declares no `image()`, `imageList()` or `itemPage()` field anywhere, and the operation has no `noMedia` | adding the picture/page field, or `noMedia("<upstream evidence>")` |

URLs inside a field the schema does not declare as a string (a passthrough
`z.unknown()` payload) are not warned: there is nothing to declare. An
auxiliary array (facets, filters) next to an annotated item array is not
warned either; the item warning is per operation.

An `http://` picture is not turned off by declaring `image()`: the helper
admits `https://` only, so the declaration check fails on the recorded value.
Make the mapper publish https first (`toImageUrl(raw, { upgradeHttp: ["host"] })`
once the host is measured to serve the same path over https, or an https value
from the upstream), re-record the fixture, then declare `image()`.

`apifuse migrate-url-kinds [path] [--check] [--json] [--no-typecheck]` moves an
existing provider to the helpers. It reads the source statically (nothing is
executed) and is a detector, not a gate: a second run changes nothing, and it
exits 0 whenever it ran. It exits 1 without writing on an unknown option, a
path without `index.ts`, an unreadable `tsconfig.json`, a repository without
operations, or an SDK that does not export the helpers (`bun install`, or bump
the pin first; `--check` still previews the edits and says the type check did
not run). `--help` prints the usage and writes nothing.

- A field reached from an operation's `output` whose name is a fleet name and
  whose recorded fixture values are absolute URLs is declared with the helper:
  `image_url` → `image()`, `thumbnail_url` → `image({ thumbnail: true })`,
  `image_urls` → `imageList()`, `thumbnail_urls` →
  `imageList({ thumbnail: true })`, `url` → `itemPage()`. The name alone
  does not make a `url` the item's own page: it becomes `itemPage()` only when
  the object holding it is not a links/related/seller/shop/store/nav/menu
  container, an id/name/title field beside it identifies the item, no other
  field beside it holds a page URL, and every fixture value is on a site the
  provider declares upstream (`allowedHosts`, `upstream.baseUrl`). Otherwise it
  gets a `TODO(url-kind)` marker naming the doubt; declare `itemPage()` if it
  is the item's page, otherwise `link()`. The field's own
  `.nullable()` is dropped and `.nullish()` becomes `.optional()` (the helpers
  admit `null`); `.optional()`, `.describe()`, `.describeKey()`, `.meta()` and
  a `describeKey(field, key)` wrapper are kept; `.url()`, `.min()`, `.trim()`
  are implied. A field counts as reached only where the output keeps it: not
  one `.pick()` leaves out or `.omit()` removes, nor one a later key,
  spread, `.extend()` or `.merge()` redeclares.
- The mapper assignments it can trace are wrapped in the constructor: object
  literals the handler returns (through local functions, `.map()`/`.flatMap()`,
  `push()` accumulators, spreads and conditionals) and object literals
  validated with `<schema>.parse()`. A label is added (`{ field: "items[].image_url" }`)
  when the field has one path.
- A picture declared on https evidence whose host serves `http://` in another
  recorded fixture is noted (`serves both schemes`): add the host to the
  constructor's `upgradeHttp` once measured, or those values become `null`.
- Other names whose fixture values are absolute URLs, or that are declared
  `.url()` (`detail_url`, `product_url`, `source_url`, ...), get a
  `// TODO(url-kind): ...` marker; decide `itemPage()`, `image()` or `link()`
  and remove it before landing.
- Left alone, each with its reason: no fixture value (`no_url_evidence`, record
  one first), a relative or non-URL fixture value (`non_url_fixture_value`,
  wrap with `{ base }` by hand), an `http://` picture (`insecure_image_fixture`,
  decide `upgradeHttp` first), a picture file under `url`
  (`kind_ambiguous`), a chain the helper cannot carry such as `.regex()`,
  `.transform()` or a list item's own `.describeKey()` (`unsupported_chain`),
  an object whose keys it cannot read such as a `.pick()`/`.omit()` mask that
  is not a literal or an `.extend()`/`.merge()`/spread of an open record type
  (`unsupported_chain`, the fields behind it are not reached),
  a field declared through a shared schema constant (`shared_schema`), a list
  name declared as one string or the reverse (`shape_mismatch`, fix the name
  or the shape), a fixture value the helper refuses such as a `localhost` or
  credentialed URL (`unpublishable_fixture_value`), a file that already
  declares the helper or constructor name (`name_collision`, rename the local
  one or edit by hand), and an edit inside text another edit replaces
  (`overlapping_edit`, rerun after reviewing the first).
- It then type-checks the result in memory and lists the type errors its edits
  introduce: those are mapper values it could not trace or hand-written types
  that still say `string`. Wrap each value in the constructor and update the
  type. Run the formatter afterwards; the rewritten chains are written on one
  line and new imports are appended.

### Real-handler E2E in standard tests

`runStandardTests(provider)` validates declarations and fixtures but reports a
per-operation warning because it has no handler E2E coverage. Opt in with an
`upstreamStub`: the runner calls each fixture-backed real handler with its
already-resolved fixture request, routes ProviderContext upstream transports to
the stub, and validates the result against the output schema. It never compares
the result to the recorded response because that evidence belongs to
`recordedAt`.

```ts
import { runStandardTests } from "@apifuse/provider-sdk/testing";
import provider from "../index.js";

runStandardTests(provider, {
  upstreamStub: ({ transport, method, url }) => {
    if (
      transport === "http" &&
      method === "GET" &&
      url === "https://api.example.test/flights"
    ) {
      return Response.json({ flights: [{ id: "fixture-flight" }] });
    }
    return undefined; // fails the test: live-network passthrough is forbidden
  },
});
```

The stub also identifies `stealth`, `browser`, and `native` interactions. Return
a Web `Response` or `{ status, headers, body }`; an unmatched call fails with
the operation, transport, and method named in the error. Browser handlers expose
method-level calls such as `goto`, `evaluate`, and `locator.click`, so provide a
canned result for each method the handler uses. Native connections similarly
identify `connectTcp`/`connectTls` and subsequent `write` calls. The offline
`ctx.stealth` rejects a stealth-owned request header (`User-Agent`,
`Sec-Fetch-*`, `sec-ch-ua*`, ...) with `STEALTH_HEADER_OVERRIDE_UNSUPPORTED`
before calling the stub, through the same check the production transport runs,
so a header spread from a shared constants module or read from a variable fails
the test instead of the first production request. Direct global
`fetch` or socket usage is outside this ProviderContext seam and should not be
used by provider handlers.

### Health assertion context

`healthCheck.cases[].assertions` receives a `HealthCheckAssertionContext` with
`data`, `status`, `durationMs`, and optional `meta`. `data` is typed from the
operation output schema, so assertions should inspect normalized output instead
of reaching into transport internals.

<!-- @magic-start:sample -->
```ts
healthCheck: {
  interval: "5m",
  cases: [{
    name: "lookup baseline",
    input: { q: "btc" },
    assertions: ({ data, status, durationMs }) => {
      if (status !== 200 || data.results.length === 0 || durationMs > 3000) {
        return { status: "degraded", label: "lookup baseline changed" };
      }
    },
  }],
}
```
<!-- @magic-end:sample -->

### Optional but valuable

- `examples`: usage examples with locale-keyed `scenarioKey`, an `input`, and optional `rationaleKey`
- `approval`: only when it deliberately differs from the `riskClass` default (`read → never`, `write → risk-based`, otherwise `always`)
- `titleKey`, `summaryKey`, `markdownKey`, `whenToUseKeys`, `whenNotToUseKeys`, and `normalizationNotesKeys`: locale-keyed operation prose
- `tags`: operation-level semantic tags for retrieval (e.g., `["weather", "korea", "realtime"]`)
- `relatedOperations`: `{ alternatives?: string[] }` — links to fallback/sibling operations

### STT runtime capability for audio OTP and short transcription

Providers that need speech-to-text should use the SDK runtime capability instead
of constructing a vendor client inside provider code. Declare STT at the provider
level, then call `ctx.stt` from operation handlers or auth-flow handlers.

<!-- @magic-start:sample -->
```ts
export default defineProvider({
  id: "example-provider",
  // ...metadata, auth, allowedHosts
  stt: { mode: "required" },
})({
  operations: {
    verifyAudioOtp: {
      riskClass: "read",
      input: z.object({
        audioBase64: z.string().describe("Base64-encoded short OTP audio"),
        mediaType: z.string().optional().describe("Audio MIME type"),
      }),
      output: z.object({ code: z.string().describe("Verification code") }),
      async handler(ctx, input) {
        const transcript = await ctx.stt.transcribe({
          audio: {
            kind: "base64",
            data: input.audioBase64,
            mediaType: input.mediaType,
          },
          language: "ko-KR",
          mode: "otp",
          verificationCode: { codeLengths: [4, 6] },
        });

        const code =
          transcript.verificationCode?.code ??
          ctx.stt.extractVerificationCode(transcript.text, {
            locale: "ko-KR",
            codeLengths: [4, 6],
          }).code;

        return { code };
      },
      healthCheckUnsupported: {
        reason: "Audio OTP transcription is cost-bearing and requires explicit smoke evidence.",
      },
    },
  },
});
```
<!-- @magic-end:sample -->

Best-practice rules:

- `stt: { mode: "required" }` is the production path for providers that depend
  on STT; APIFuse provider manifests project STT credentials, model config, and
  Cloudflare egress only for required STT. Use `mode: "optional"` only when STT
  is a host/test override or truly best-effort capability that can remain
  unavailable in production.
- Do not assume OTPs are always four digits. Configure accepted lengths, for
  example `[4, 6]`, and keep the returned code as a string to preserve leading
  zeros.
- Prompts are hints, not correctness guarantees. General transcription sends no
  prompt by default. OTP mode may send a default digit-preserving hint. Use a
  custom `initialPrompt` only with `promptPolicy: "custom-hint"`, and do not log
  prompts, transcripts, raw audio, or OTP values.
- STT v1 accepts JSON-safe base64 audio only. Do not fetch arbitrary audio URLs
  from provider code; URL input needs separate SSRF/private-network policy.
- Local and production wiring use the same env-backed runtime path. For the
  Cloudflare Workers AI backend, set `APIFUSE__STT__BACKEND=cloudflare-workers-ai`,
  `APIFUSE__STT__MODEL=@cf/openai/whisper-large-v3-turbo`,
  `APIFUSE__CLOUDFLARE__ACCOUNT_ID`, and `APIFUSE__STT__CLOUDFLARE_API_TOKEN` in `.env.local` or the
  provider workload environment. Do not deploy a Cloudflare Worker proxy for the
  MVP; the SDK runtime calls Workers AI REST directly.
- Submission checks and health checks must not invoke live STT by default.
  Provide explicit smoke evidence when a provider depends on audio OTP behavior.

### OCR runtime capability: availability is the SDK's verdict

Declare `ocr: { mode: "required" | "optional" }` and call `ctx.ocr` from
operation handlers or auth-flow handlers. Whether a working backend is wired
in is decided by the SDK, never by provider code: `ctx.ocr.available` is
`true` when `createOcrClientFromEnv` found a configured backend and `false`
for the unsupported/error client that undeclared or misconfigured providers
receive. Branch on that flag for behavior that depends on OCR being present
(for example, whether a CAPTCHA field is required from the user), and keep the
`OCR_UNAVAILABLE` / `UNSUPPORTED_OCR_BACKEND` error fallback for the call
itself: `available: true` promises a configured backend, not a successful
upstream call.

```ts
async start(ctx) {
  const image = await fetchCaptcha(ctx);
  return ctx.auth.nextForm({
    turnId: "credentials",
    fields: {
      captchaText: { type: "string", required: !ctx.ocr.available, /* ... */ },
    },
    data: { captchaImage: image, ocrConfigured: ctx.ocr.available },
  });
}
```

Do not re-implement the predicate by reading `APIFUSE__OCR__*` or
`APIFUSE__CLOUDFLARE__ACCOUNT_ID`: those names are engine-owned, the
runtime boundary check reports the read, and a drift between the copy and the
SDK's own selection logic downgrades every login to the manual path silently.

A custom `OcrContext` override (`serve({ ocr })`, `createFlowContext({ ocr })`,
or a hand-written test double) must set `available` explicitly as a plain data
property; the SDK's own clients do, and `bindOcrTelemetry` preserves it.

### Health journey DX for SMS/payment flows

Use `defineSmsOtpMatcher()` plus `defineHealthJourney()` when a real health signal requires an OTP ceremony and a safe handoff boundary. Keep matcher fields standards-backed: ISO 3166-1 alpha-2 `country`, BCP 47 `locale`, E.164 `phoneNumber` when present, ISO 8601 durations, and `nationalServiceCode` origins for local service senders. Do not add custom allowlist fields such as `senderAllowlist`; model the sender as an origin instead.

Every ISO 8601 duration must be longer than zero: `PT0S`, `P0D`, and other values whose every component is zero are rejected, so omit an optional duration such as `jitter` or `cooldown` instead of setting it to zero.

<!-- @magic-start:sample -->
```ts
import {
	defineHealthJourney,
	defineProvider,
	defineSmsOtpMatcher,
	every,
} from "@apifuse/provider-sdk";

const phoneOtp = defineSmsOtpMatcher({
	id: "phone-otp",
	country: "KR",
	locale: "ko-KR",
	origins: [
		{
			kind: "nationalServiceCode",
			country: "KR",
			value: "16615270",
			display: "1661-5270",
		},
	],
	code: { pattern: /인증번호는\s*\[([0-9]{4})\]/, capture: 1 },
	maxAge: "PT5M",
	waitTimeout: "PT2M30S",
	clockSkew: "PT10S",
});

const paymentWebviewJourney = defineHealthJourney({
	id: "sms-payment-webview",
	schedule: every("8h", { jitter: "PT20M" }),
	timeout: "PT5M",
	cooldown: "PT8H",
	requiredSecrets: [
		"APIFUSE__HEALTH_MONITOR__PROVIDER_PHONE",
		"APIFUSE__HEALTH_MONITOR__PROVIDER_PASSWORD",
		"APIFUSE__HEALTH_MONITOR__PROVIDER_CANARY_ORDER_JSON",
	],
	coversOperations: ["verify-phone", "confirm-phone", "place-order"],
	smsMatchers: [phoneOtp],
	steps: [
		{ id: "send-phone-otp", kind: "operation", operationId: "verify-phone" },
		{ id: "wait-phone-otp", kind: "smsOtp", usesSmsMatcher: "phone-otp" },
		{ id: "confirm-phone-otp", kind: "operation", operationId: "confirm-phone" },
		{
			id: "create-payment-webview",
			kind: "operation",
			operationId: "place-order",
			safeBoundary: "paymentWebviewUrl",
		},
	],
});

const buildProvider = defineProvider({
	id: "example-provider",
	// ...metadata, auth, allowedHosts
	healthJourneys: [paymentWebviewJourney],
});

export default buildProvider({ operations });
```
<!-- @magic-end:sample -->

The journey runner supplies `ctx.gateway`, `ctx.sms.waitForOtp()`, `ctx.journal.sideEffect()`, `ctx.state`, and `ctx.event.operation()` to the required journey `run` function. Provider authors should keep `run` small: call the covered operations in step order, stop at the declared safe boundary, and let the generated health metadata carry schedule, timeout, required secret, and SMS matcher information to the health monitor.

For authenticated journeys, open a fresh connection inside `run` with `ctx.gateway.connect({ input: { ... } })`, execute covered operations with the returned `connectionId`, and disconnect in a `finally` block. Do not require or store long-lived `HEALTH_MONITOR_*_CONNECTION_ID` secrets; those stale connection IDs can hide broken login ceremonies.

Use the runtime capabilities narrowly:

- `ctx.gateway.execute()` is the default path for operation health evidence; the runner records operation success/failure automatically.
- `ctx.journal.sideEffect()` wraps non-replayable provider mutations such as create/cancel/send operations.
- `ctx.state.namespace(name, policy)` stores bounded lifecycle memory and recovery cursors with TTL/quota/value-size policy. It is not a replacement for the side-effect journal.
- `ctx.event.operation()` records only synthetic operation outcomes proven by the journey, such as recovery/manual-review checks that are not direct gateway calls. The runtime rejects events for operations outside `coversOperations`.

Do not import `apps/health-monitor`, generated health artifacts, database repositories, schedulers, or recorders from provider code. If a journey needs provider-specific helper code, place it under the provider package (for example `providers/<id>/health-journeys/*`) and keep the SDK boundary generic.

### Health accounts and OTP receipts (`healthAccounts`)

Use `defineHealthAccount()` to declare the health-monitor account a provider signs in with and the OTPs that account receives while signing in. The APIFuse registry converts each declaration into health projection entries. `defineHealthAccount()` only types the object; `defineProvider()` validates it when the provider is defined. The example uses placeholder values.

```ts
import { defineHealthAccount, defineProvider } from "@apifuse/provider-sdk";

const buildProvider = defineProvider({
	id: "weverse",
	// ...metadata, auth, allowedHosts
	healthAccounts: [
		defineHealthAccount({
			persona: "default",
			destinations: { email: "email" },
			wait: {
				timeout: "PT3M",
				rationale: { measuredOtpValidity: "PT5M", source: "task 1.3 측정" },
			},
			otp: [
				{
					medium: "email",
					id: "account-otp",
					sender: { domains: ["weverse.io"] },
					subject: { includesAny: ["verification code", "인증번호"] },
					code: {
						kind: "regex",
						pattern: { engine: "re2", pattern: "\\b([0-9]{6})\\b", flags: "" },
						capture: 1,
					},
					maxAge: "PT10M",
				},
			],
		}),
	],
});

export default buildProvider({ operations });
```

- `persona` names the health-monitor account.
- `destinations.<medium>` is the name of the seed field that holds the account's address for that medium. Above, the seed field `email` holds the address the OTP email is sent to.
- `wait.timeout` is how long to wait for the OTP. `wait.rationale` records where that number comes from: `measuredOtpValidity` is the measured OTP validity, and `source` names the measurement.
- `otp` lists one or more OTP receipts. `medium` is `"email"` today; the union widens as more media land. An email receipt names its `sender.domains` and, optionally, subject keywords in `subject.includesAny`.
- `otp[].id` is the receipt id. The registry prefixes it with `<providerId>/` and uses the result as the matcher id (`weverse/account-otp` above).
- `otp[].code.pattern` is an RE2 `SafeRegex` written as a string, not a `RegExp` literal: `engine: "re2"`, `flags` `""` or `"i"`, at most 256 characters, no backreferences, no `(?` groups, no nested quantifiers, and valid regular-expression syntax. `otp[].code.capture` is the index of the capture group that holds the code.
- `otp[].maxAge` is the oldest message age still accepted as this OTP, at most `PT15M`. Durations are ISO 8601, as in the other health declarations.

### External bounty submission evidence

External contributors are expected to submit standalone Provider source plus:

- SDK version/tag and create command used.
- Provider id, version, runtime, auth mode, and Operation list.
- Health coverage table for every Operation.
- `bun run check` output.
- `bun run test` output.
- `bun run submit-check` score/verdict and generated `submission-report.md`.
- Fixture evidence and known upstream constraints.

Maintainers own monorepo import under `providers/<id>/`, registry generation,
deployment projection checks, and release workflows.

### Error responses

Provider-server failures use a stable public envelope:

```json
{
  "error": {
    "code": "UPSTREAM_ERROR",
    "message": "The upstream service failed",
    "requestId": "req_123",
    "retryable": true,
    "details": { "providerReason": "temporarily_unavailable" }
  }
}
```

`retryable` is always present on responses emitted by the current SDK. Set
`retryable` in the `ProviderError` options when the provider knows the answer;
an explicit `true` or `false` wins over the matching operation declaration and
SDK derivation. When it is omitted, `operations.<id>.errorCodes[].retryable`
is used for a matching provider-owned code, followed by SDK derivation (which
defaults ordinary `ProviderError` values to `false`). During stateful rolling
upgrades, the forwarding client also accepts an older owner response that omits
`retryable` and treats it as `false` without loosening the emitted response
contract. Existing optional `fix` guidance is also preserved when a
`ProviderError` supplies it.

`details` belongs exclusively to the provider. The server passes
`ProviderError.options.details` through verbatim, including strings and arrays,
and never merges, overwrites, or wraps it. Do not put SDK taxonomy fields there.
SDK-owned validation and masked-internal-error paths retain their own diagnostic
details.

SDK observability is emitted separately in the
`X-ApiFuse-Error-Observability` response header as compact, single-line JSON:

```json
{"origin":"provider","category":"upstream_http","taxonomyVersion":"2026-10-23","retryable":true,"upstreamStatus":502}
```

`origin` says who reported the category, and with it which set the category
comes from:

- `provider`: how the provider's upstream call failed, whether your throw site
  set the `category` or the SDK derived it (the rules below, a `ctx.http`
  transport failure). The category is a `ProviderFailureCategory`.
- `platform`: a fault the SDK observed and reports itself, such as an expired
  stateful-forwarding deadline, a caller that disconnected, output that failed
  validation, a masked internal error, the required-secret gate, or proxy
  egress the SDK could not provide. The category is a `PlatformFaultCategory`.

Treat this header as telemetry, not as provider-controlled public error detail.
It is SDK-owned even when a handler returns a raw `Response`: a caller-set
header is dropped, and a raw status of 400 or above gets a status-derived one
(retryable only for 408, 429, and 5xx) while the body is left untouched.
Its origin, category, taxonomy version, retryability, and optional upstream
status match the structured `provider_request_failed` log event.

Declare every error code once with `defineErrors`, throw its factory, and list
the factories on the operations that can throw them. The declaration is the
only place the status, the category and the retryability live; a throw site
adds `details`, a `cause`, `params`, or a `message` override and nothing else:

```ts
// domain/errors.ts
import { defineErrors, sdkErrors } from "@apifuse/provider-sdk/provider";

export const errors = defineErrors({
  UPSTREAM_SCHEMA_ERROR: sdkErrors.UPSTREAM_SCHEMA_ERROR, // registered: the SDK supplies 502, upstream_schema_drift, non-retryable
  ITEM_SOLD_OUT: {
    status: 409,
    category: "upstream_rejected",
    description: "The upstream sold the item before checkout completed.",
    messageKey: "errors.itemSoldOut.message",
  },
});

// operations/checkout.ts
errors: [errors.ITEM_SOLD_OUT, errors.UPSTREAM_SCHEMA_ERROR],
handler: async () => {
  throw errors.ITEM_SOLD_OUT({ details: { itemId } });
},
```

A key that names an SDK-registered code must hold that `sdkErrors` reference;
writing a status or retryability for it is a type error, so one code never has
two answers across the fleet. A provider code states `status`, `category` and
`description`; `category` is a `ProviderFailureCategory` (see below), and
`retryable` defaults to the category's answer (`timeout`, `network`,
`upstream_rate_limited` and `upstream_http` retry, nothing else does).
`errors.X()` returns a `ProviderError<"X">`, so a helper that throws several
codes is typed by the union of their names. One map can
spread another (`defineErrors({ ...commonErrors, ... })`), and
`Object.values(commonErrors)` lists a whole map on an operation.

The legacy shape, `errorCodes: [{ code, status, retryable, description }]` plus
`new ProviderError("...", { code, category, retryable })`, still serves for one
more release. `errorCodes` and the per-throw `category` / `retryable` options
are `@deprecated` (the hover text names the replacement), the server logs one
`provider_error_options_deprecated` warning per code per process, and
`apifuse check` reports `legacy-error-options` (warn) on each site.
`scripts/codemods/errors-factory.yml` (ast-grep) rewrites both shapes.

`defineErrors` and `defineProvider` accept only statuses the server can emit:
400, 401, 404, 409, 410, 422, 429, 500, 502, 503, and 504. An invalid status,
category or locale key fails at definition, not on a live request. One function,
`resolveProviderErrorContract`, answers status, category and retryability for
every served provider error, per field, in this order:

1. SDK-owned errors retain SDK semantics. A declaration cannot override
   SDK-owned codes, stateful-forwarding failures, Zod/deadline errors, or
   `TransportError` values.
2. The deprecated per-throw `category` / `retryable` options (status has no
   per-throw form). While they exist they are served over the declaration, the
   order the server always had, so bumping the SDK changes no served verdict.
3. The declaration: the `defineErrors` declaration a factory-made error
   carries, or the operation's legacy `errorCodes` entry for the code. This
   slot applies to `ValidationError` as well as ordinary `ProviderError`, and
   it answers status first (ahead of the registry).
4. A declared rejection status (409/410/422) classes the category as
   `upstream_rejected`.
5. The registered mappings below (status, category and retryability).
6. Existing fallbacks: `TransportError` 502/504, unregistered input
   `ValidationError` 400 (output validation 500), other unregistered
   `ProviderError` values 500 and non-retryable.

A factory-made error carries no per-throw option, so its declaration is its
whole contract: a code declared `retryable: false` and thrown as
`errors.CODE(...)` is served non-retryable. A legacy throw that still sets
`retryable` is served that value and the server warns, naming both values when
they differ; the fix is a distinct code for the other condition, not a
per-throw override.

The registered mappings are:

| Error code or fallback | HTTP status |
| --- | ---: |
| `AUTH_REQUIRED`, `reauth_required` | 401 |
| `MISSING_SECRET`, `UPSTREAM_AUTH_ERROR`, `INVALID_REQUEST` | 400 |
| `NOT_FOUND`, `not_found`, `NO_DATA` | 404 |
| `RATE_LIMITED`, `UPSTREAM_RATE_LIMIT`, `LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR` | 429 |
| `UPSTREAM_ERROR`, `BLOCKED`, `UPSTREAM_SCHEMA_ERROR` | 502 |
| `STT_UNAVAILABLE`, `UNSUPPORTED_STT_BACKEND`, `STATEFUL_FORWARDING_REPLAY_CACHE_FULL` | 503 |
| Unregistered input `ValidationError` code | 400 |
| Other unregistered `ProviderError` code | 500 |

Every code provider code throws that the SDK registers (`sdkErrors`) carries
its category and retryability with its status. When a `ProviderError` (or any
subclass, `ValidationError` included) with one of these codes is thrown with
no declaration and no per-throw option, the server reports the registry's
category, with origin `provider`, in `X-ApiFuse-Error-Observability`, serves its
retryability, and the public `source` follows from the category:

| Error code | Category | `source` | `retryable` |
| --- | --- | --- | --- |
| `NOT_FOUND`, `not_found`, `NO_DATA` | `upstream_http` | `upstream_failure` | `false` |
| `RATE_LIMITED`, `UPSTREAM_RATE_LIMIT`, `LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR` | `upstream_rate_limited` | `upstream_rule` | `true` |
| `UPSTREAM_REJECTED` | `upstream_rejected` | `upstream_rule` | `false` |
| `UPSTREAM_ERROR` | `upstream_http` | `upstream_failure` | `true` |
| `BLOCKED` | `anti_bot_blocked` | `upstream_failure` | `false` |
| `UPSTREAM_AUTH_ERROR` | `upstream_auth` | `upstream_failure` | `false` |
| `UPSTREAM_SCHEMA_ERROR` | `upstream_schema_drift` | `upstream_failure` | `false` |
| `AUTH_REQUIRED` | `credential_unavailable` | `client` | `false` |
| `INVALID_REQUEST` | `input_validation` | `client` | `false` |

So `throw errors.UPSTREAM_SCHEMA_ERROR()` (or the legacy
`new ProviderError("…", { code: "UPSTREAM_SCHEMA_ERROR" })`) is enough for the
health monitor to grade a drifted upstream `down`; served as `source:
"apifuse"` it would be graded unknown. `UPSTREAM_ERROR` is retryable because
the fleet declares it so (350 of 426 declarations on 2026-10-28); a
deterministic upstream failure needs its own non-retryable code. Your own codes
are classified by their `defineErrors` declaration, and a legacy code with no
category anywhere stays `provider_error`.

The `category` option is typed `ProviderFailureCategory`, the twelve words for
how an upstream call failed: `timeout`, `network`, `upstream_http`,
`upstream_rate_limited`, `upstream_auth`, `upstream_rejected`,
`upstream_schema_drift`, `anti_bot_blocked`, `credential_expired`,
`credential_unavailable`, `input_validation`, and `provider_error`. The
platform-fault words (`stateful_forwarding_deadline`, `proxy_pool`,
`output_validation`, `internal_error`, `dependency_unavailable`,
`unsupported_transport`, `client_cancelled`, `unclassified`, and the success
stamp `ok`) are not in that type, so a TypeScript provider that sets one does
not compile. They are not a throw site's to set because the SDK reports each
platform fault itself, from the event it observed, with origin `platform`.
Imitating one does not produce it: an SDK code string such as
`OUTPUT_VALIDATION_FAILED`, an instance of a public SDK error class, or a
category cast past the type, on an error your code throws, does not make that
error the platform fault it imitates. A category outside
`ProviderFailureCategory` that reaches the server at runtime (plain JavaScript
or a cast) is read as no category, so the rules above classify the error, and
the `provider_request_failed` log carries the `unknown_provider_error_category`
signal. A `defineErrors` declaration's `category` has the same type, and
`defineErrors` rejects a platform-fault word at definition, so plain JavaScript
or a cast cannot declare one either. A declaration that still carries one,
made by an SDK copy whose `defineErrors` took every category (a provider
bundled with an earlier release), is read at serve the same way: as no
category, with the same signal.

An unregistered non-validation `ProviderError` code returns HTTP 500 and emits
the greppable `unregistered_provider_error_code` signal with the code in the
structured failure log. A matching operation declaration, including one that
omits `status`, makes the code registered for this signal and may independently
supply `retryable`. The HTTP 400 `ValidationError` behavior is only the fallback
when neither an operation status nor a registered mapping applies.

Throw the domain `ProviderError` directly. Subclassing or wrapping it as a
`TransportError` solely to preserve a 5xx response is obsolete; declare the
domain code's `status` instead. Genuine `TransportError` values remain
SDK-owned and keep their 502/504 mapping.

#### Cancelled `ctx.http` requests

A `ctx.http` request whose signal aborts rejects with the `TransportError` code
`transport_cancelled`. That signal merges the served request's own signal with
any `signal` you pass in `RequestOptions`, so the server classifies the
cancellation by what aborted it. The response body keeps the code
`transport_cancelled` in every row:

| What aborted the request | Category | `origin` | HTTP status | `source` | `retryable` |
| --- | --- | --- | ---: | --- | --- |
| The caller closed the connection before the server answered | `client_cancelled` | `platform` | 400 | `client` | `false` |
| Your own `signal` with a `TimeoutError` reason, such as `AbortSignal.timeout(ms)` | `timeout` | `provider` | 504 | `upstream_failure` | `true` |
| Your own `signal` with any other reason, such as `abort()` or `abort(reason)` | `upstream_http` | `provider` | 502 | `upstream_failure` | `false` |

A `TimeoutError` abort is reported like the `timeout` request option's
`transport_timeout`, including the public message `Request timed out`, whether
it fires during a request, a retry backoff, or the consumption of a streamed
body. A caller that disconnects before the server answers takes the first row
even when your own signal fired first. On the stateful owner route, a forwarded
deadline that expires mid-request is served as
`STATEFUL_FORWARDING_DEADLINE_EXPIRED` (category
`stateful_forwarding_deadline`, origin `platform`, 504, `source` `apifuse`,
`retryable: false`) instead. The same holds when the owner pod runs
the forwarded operation through its own `StatefulSessionRouter` and the
router's deadline timer cancels the read. The SDK reports this deadline
itself; throwing that code or a `StatefulRoutingDeadlineError` from provider
code does not produce it.

#### Three fleet-consensus codes are registered

`UPSTREAM_AUTH_ERROR` (400), `UPSTREAM_SCHEMA_ERROR` (502), and
`INVALID_REQUEST` (400) are registered mappings. All three are non-retryable.

- `UPSTREAM_AUTH_ERROR` is 400, not 401 or 502, because it means the upstream
  refused a *platform-managed* service key. The caller holds no credential, so
  401 ("re-authenticate") asks for something the caller cannot do, and 502
  ("the upstream is sick") promises a recovery that will never arrive. It is a
  deployment/config defect, exactly like `MISSING_SECRET`. The status is about
  what the caller can do; the attribution is still the upstream's, since the
  upstream is what refused the key, so the category is `upstream_auth` and the
  origin is `provider`: your throw site reports the refusal, while the SDK's
  secret gate reports `MISSING_SECRET` as a platform fault.
- `UPSTREAM_SCHEMA_ERROR` is non-retryable: a retry returns the same payload
  the provider already could not normalize.
- `INVALID_REQUEST` is the spelling for caller-side bad input. `INVALID_INPUT`,
  `VALIDATION_ERROR`, and `BAD_REQUEST` are not registered.

Like `UPSTREAM_ERROR` and `BLOCKED`, these are thrown by provider code rather
than by the SDK, so they are registered mappings and not SDK-owned codes: a
legacy operation declaration still wins at runtime (step 2 above), so
registering them never rewrites a status you already declared. With
`defineErrors` the question does not arise: a registered code is referenced as
`sdkErrors.X`, and restating or overriding its status or retryability is a type
error. If your operation genuinely means something else, declare a distinct
code that says so.

### Localized error messages (`messageKey` / `fixKey`)

The positional `ProviderError` message stays **English**. It is what
`error.message`, cause frames, the `provider_request_failed` log, OTLP
attributes and tests see. Only two fields of the response body are localized:
`error.message` and `error.fix`. Nothing else — not `code`, not `details`, not
`errorCodes[].description`, not the `X-ApiFuse-Error-Observability` header.

Attach locale keys instead of parsing `Accept-Language` yourself:

```ts
// locales/en.json
{ "errors": { "upstreamSchema": {
    "message": "{provider} returned an unexpected response.",
    "fix": "Retry in a few minutes."
} } }
```

```ts
export const errors = defineErrors({
  SCHEDULE_UNAVAILABLE: {
    status: 502,
    category: "upstream_schema_drift",
    description: "The culture data service returned an unexpected response.",
    messageKey: "errors.upstreamSchema.message",
    fixKey: "errors.upstreamSchema.fix",
  },
});

throw errors.SCHEDULE_UNAVAILABLE({ params: { provider: "Culture Data" } });
```

The keys live on the declaration, so every site that throws the code is
localized. A registered code (`sdkErrors.UPSTREAM_SCHEMA_ERROR`) takes the
derived `errors.UPSTREAM_SCHEMA_ERROR.message` / `.fix` keys: add those entries
to the catalogs and nothing else is needed. The legacy `errorCodes[]` keys keep
working for one more release.

A site that says something more specific than the code's one sentence passes
its own key per throw: `errors.INVALID_REQUEST({ message, messageKey:
"errors.invalidRequest.roundNotFound.message" })`. The per-throw `messageKey`
/ `fixKey` wins over the declaration's, the declaration's over the derived key,
and the contract (status, category, retryable) is the declaration's either
way; a registered code (`sdkErrors.NO_DATA`), whose row cannot declare a key,
takes one this way too. `apifuse migrate` carries a legacy site's key into the
factory call as written (a literal or a variable).

Resolution order per field, evaluated at serve time:

1. the throw's `messageKey` / `fixKey` (the factory input, or the legacy
   `new ProviderError(msg, { code, messageKey })` option);
2. the declaration's `messageKey` / `fixKey` (`defineErrors`, or a legacy
   `errorCodes[]` entry);
3. the derived `errors.<code>.message` / `errors.<code>.fix` (the code is used
   verbatim as a catalog segment, so `errors.UPSTREAM_SCHEMA_ERROR.message`
   works with no declaration at all);
4. the English literal passed to the constructor.

Each candidate is resolved in the caller's locale first and then in `en`, so a
more specific key always beats a more specific locale. A missing key, a
malformed key, a non-string catalog value or an absent catalog is a miss, never
a throw: the caller always gets text. Steps 2 and 3 do not apply to SDK-owned
failures (transport, Zod, stateful deadline, SDK runtime codes) — a provider
catalog must not be able to relabel `Request timed out`.

**Key grammar.** A locale key is dot-separated segments. Every segment is
camelCase (`upstreamSchema`, `whenToUse`) or an array index (`0`), and the
first segment is always a camelCase namespace. The one exception is the segment
directly under `errors`, which may also be the error code spelled the way it is
thrown — `errors.UPSTREAM_SCHEMA_ERROR.message`, `errors.BLOCKED.fix`,
`errors.reauth_required.message`. Both spellings work, so
`errors.upstreamSchema.message` and `errors.UPSTREAM_SCHEMA_ERROR.message` are
equally legal keys; write the code form when you want the key to match the
derived path in step 3. Nothing else loosens: a space, a dot inside a segment,
an empty segment, a mixed-case or hyphenated code, and a leading digit are all
still malformed.

Locale negotiation reads `Accept-Language` from the request envelope's
`headers` map first (the gateway stamps the flow's locale there) and then from
the HTTP header, honours quality values, matches on the primary subtag, and
supports `en`, `ko`, `ja` with `en` as the default. A request with no
`Accept-Language` therefore keeps serving the `en` catalog value, so existing
contract fixtures do not churn.

**Interpolation.** `{name}` placeholders, `{{` and `}}` for literal braces.
`params` accepts strings and finite numbers only. A placeholder with no usable
param is left verbatim so the authoring gap is visible rather than silently
deleting text.

**Params are untrusted.** Upstream error text routinely ends up in `params`, so
every string value is scrubbed before substitution: secrets and e-mail
addresses redacted, control/bidi/newline characters encoded or collapsed,
`<`, `>` and backticks removed, HTML-entity ampersands (`&lt;`) neutralized
while ordinary ampersands survive, and the value capped at 200 characters.
Substituted text is never rescanned, so a value containing `{other}` cannot
trigger a second interpolation round. Prefer `details` when you need to relay
an upstream body verbatim; `params` is for short, bounded values.

**Catalog loading.** Catalogs are read once when the server is built (from the
provider directory's `locales/{en,ko,ja}.json`, loading only the locales that
exist). Pass `serve(provider, { localeCatalogs })` to bundle them instead. A
catalog that exists but cannot be parsed logs one
`provider_locale_catalogs_unavailable` warn at boot and every field falls back
to its English literal.

**Checks.** A malformed key fails `defineErrors` itself (see **Key grammar**
above). `apifuse check` then verifies, as a build-time check of the
declarations (not a source scan), that every `messageKey` / `fixKey` on the
operations' `errors` resolves to non-empty text in `locales/en.json`
("Declared error locale keys resolve in locales/en.json").

`ko`/`ja` coverage needs no new rule: `en` is the baseline, so the existing
catalog parity and placeholder checks already fail an `errors.*` key that is
missing or untranslated in `ko`/`ja`.

### Declared secrets are SDK-enforced

Environment/secret presence validation is single-sourced in the SDK. Declare
every env secret the provider needs in `defineProvider`:

```ts
secrets: [
  {
    name: "APIFUSE__PROVIDER__MY_PROVIDER__API_KEY",
    required: true,
    description: "Upstream API key from the vendor portal",
  },
],
```

The runtime validates every `required: true` declaration before any operation
handler or auth-flow handler (except `abort`) runs. When a required secret is
unset or whitespace-only, the invocation fails with the canonical structured
error — code `MISSING_SECRET`, HTTP 400, top-level `retryable: false`, and a
`fix` naming every missing secret — across `/v1/{operation}`, self-test probes,
`apifuse perf`, and `apifuse record`. Its error-observability header carries the
`credential_unavailable` category with origin `platform`, because the SDK's gate
reported it. `credential_unavailable` is also a provider failure: a throw site
of yours that sets it, for a credential check of its own beyond declared-secret
presence, is reported with origin `provider`, and so is a hand-rolled
`MISSING_SECRET`, so the origin tells the gate and your code apart. The server
also emits a
`provider_secrets_missing` warn log at boot so unprovisioned deployments are
visible immediately without crashing the pod.

Provider-local presence re-validation is **deprecated**: do not write
`requireServiceKey`/`requireApiKey`-style guards that re-check `ctx.env.get()`
and throw a hand-rolled `CONFIGURATION_ERROR`/`MISSING_SECRET`. Those guards
are dead weight (the SDK gate runs first) and historically diverged into
inconsistent error shapes. The `sdk-owned-secret-presence` submit-check rule
flags them at warn level; acknowledge a deliberate exception with
`// @apifuse-allow sdk-owned-secret-presence: <reason>`.

```ts
// Before (deprecated): provider-local double validation
function requireServiceKey(ctx: ProviderContext): string {
  const value = ctx.env.get(SERVICE_KEY_ENV);
  if (!value?.trim()) {
    throw new ProviderError(`Missing required provider secret: ${SERVICE_KEY_ENV}`, {
      code: "CONFIGURATION_ERROR",
    });
  }
  return value;
}

// After: declare { name: SERVICE_KEY_ENV, required: true } and read directly.
const serviceKey = ctx.env.get(SERVICE_KEY_ENV);
```

Note the asymmetry: the gate treats whitespace-only values as missing, but
`ctx.env.get()` still returns the raw value to handlers — trim at the point of
use if the upstream is whitespace-sensitive.

### Runtime boundary: no `process.env`, `node:fs`, `child_process`, or raw `fetch()`

Provider runtime code reaches the outside world through the context only:
`ctx.http` / `ctx.stealth` for HTTP, `ctx.browser` for browser work,
`ctx.env.get()` / `ctx.credential` for configuration and secrets, `ctx.files` /
`ctx.cache` / `ctx.state` for data that must outlive a request. Ambient Node
and Bun globals bypass `allowedHosts`, proxy policy, retries, redaction, the
secret presence gate, and telemetry.

The boundary is enforced at build time, not by grepping source. `apifuse check`
bundles `index.ts` and `start.ts` (what the pod runs) with Bun's bundler and
judges what the bundles reach
(`bundleProvider` in the SDK, exported for the central contract check to call
at the `ready` level). A finding is an error that fails `apifuse check`
and `apifuse submit-check` alike and names the file, line and column:

```
✗ Runtime sources reach the outside world through the SDK context only
  - ERROR global upstream/session.ts:2:22: process.env.EXAMPLE_SESSION_TOKEN — process.env.EXAMPLE_SESSION_TOKEN is read outside the provider runtime boundary. Declare the name under secrets: [{ name, required }] in defineProvider and read it with ctx.env.get(name); …
  - ERROR module upstream/tap.ts:1:1: node:fs/promises — "node:fs/promises" is outside the provider runtime boundary. Use the SDK context instead: … Allowed node built-ins: assert, …, zlib.
```

What is judged:

- **Modules.** Every import the module graph resolves: static `import`,
  `export … from`, `require()`, and `import()` with a literal specifier, through
  re-exports and tsconfig `paths` aliases. Node built-ins are an allowlist of
  pure helpers (`node:crypto`, `node:path`, `node:url`, `node:util`,
  `node:buffer`, `node:events`, `node:stream`, `node:zlib`, `node:timers`,
  `node:string_decoder`, `node:querystring`, `node:assert`, `node:perf_hooks`,
  `node:async_hooks`, `node:diagnostics_channel`, `node:punycode`; see
  `RUNTIME_MODULE_ALLOWLIST`). Everything else under `node:` and all of
  `bun` / `bun:*` is outside the boundary, with or without the prefix. The
  browser drivers (`playwright`, `playwright-core`, `playwright-extra`,
  `puppeteer`, `puppeteer-core`, `puppeteer-extra`) and the SDK's own
  `@apifuse/provider-sdk/runtime/browser` subpath (which can open a CDP
  connection to any endpoint) are outside it too: use `ctx.browser`. Those two
  are warnings in the bounty `standalone` mode and errors otherwise. Type-only
  imports are erased before resolution and never count. An `import()` or
  `require()` whose specifier is not a literal cannot be resolved at build
  time and is a finding on its own, and so is `require` held as a value
  (`const r = require`, `require.main.require(...)`).
- **Globals.** `process`, `Bun`, `globalThis`, `global`, `self`, `fetch`,
  `WebSocket`, `Worker`, `import.meta.env` and `import.meta.require` are
  rewritten by the bundler, so the bundler's own scope analysis decides what is
  a free reference: a parameter or local named `fetch` is left alone, and
  `const p = process; p.env.X`, `globalThis.process.env.X` or
  `self.fetch(...)` are caught the same as `process.env.X` and `fetch(...)`,
  through any chain of the three global-object names (`globalThis.self.fetch`).
  Allowed by member: `process.env.APIFUSE__RUNTIME__*`
  (the bootstrap family read before a context exists), `process.platform` /
  `arch` / `version` / `versions` / `hrtime` / `nextTick`, `typeof process`,
  `Bun` helpers that touch neither the filesystem, the network nor processes
  (`Bun.CryptoHasher`, `Bun.hash`, `Bun.sleep`, `Bun.gzipSync`, …; see
  `BUN_MEMBER_ALLOWLIST`), and `globalThis.<name>` for any name not on the
  list above (`globalThis.crypto` is fine). A computed global lookup
  (`globalThis[name]`) is a finding.

Every other value a provider needs is declared in `defineProvider` under
`secrets: [{ name, required }]` and read with `ctx.env.get(name)`. The names
visible to `ctx.env.get` are exactly the declared `secrets[].name` (minus
engine-owned names; an `oauth2_proxied` auth flow additionally sees
`APIFUSE__AUTH_PROXY__URL`). `env: true` (or `env: {}`) is the capability
declaration that turns the `ctx.env` binding on — a type *and* runtime gate,
since touching `ctx.env` without it throws `PROVIDER_CAPABILITY_UNDECLARED`
— and does not widen the readable names. Test/E2E toggles are not secrets
and cannot move to `ctx.env`: replace them with test doubles (inject
`ctx.env` / `ctx.http`) or recorded fixtures.

Scope is what the pod executes: the module graph reachable from `index.ts`
(the provider definition) and from `start.ts` (`bun run start`, the pod's
entry) when it exists, with bindings the bundler keeps. A module only
`start.ts` imports is judged like any other source. Findings inside the root
`dev.ts` / `start.ts` / `deploy.ts` files themselves are dropped: they read
the port and pod identity before a context exists. Tests, recorded fixtures,
`.d.ts` files and the `scripts/`, `tools/`, `bin/` directories are outside
the graph by construction unless a request-path module imports them, in which
case they are judged like any other source. A file nobody imports, an import
nobody uses, and a nested git checkout are not runtime code and are not
reported.

There is no in-code escape hatch: a `// @apifuse-allow` comment does not
acknowledge a boundary finding (the former `process-env-direct-read`,
`node-runtime-module-import` and `direct-fetch-call` rules accepted one; no
fleet provider used it). A capability the context does not offer is an SDK
change, not a provider-local exception.

```ts
// Before: request-path module reads the ambient environment and the disk
import { mkdir, writeFile } from "node:fs/promises";
const serviceKey = process.env.EXAMPLE_SERVICE_KEY;
if (process.env.EXAMPLE_DIAG_TAP_DIR) {
  await writeFile(`${process.env.EXAMPLE_DIAG_TAP_DIR}/booking.json`, JSON.stringify(response));
}

// After: the credential is a declared secret read through the context —
// defineProvider({
//   env: true, // turns the ctx.env capability on (type + runtime gate)
//   secrets: [{ name: "APIFUSE__PROVIDER__EXAMPLE__SERVICE_KEY", required: true }], // the readable names
// })
// — and the ad-hoc diagnostic tap is deleted: a toggle that is not a secret has
// no place in ctx.env; observability goes through ctx.trace instead.
const serviceKey = ctx.env.get("APIFUSE__PROVIDER__EXAMPLE__SERVICE_KEY");
const response = await ctx.trace.span("booking.confirm", () => confirmBooking(ctx, serviceKey));
```

### Credentials forced into query parameters

Prefer an authorization header or request body whenever the upstream supports
one. When the upstream requires a credential in the URL query (for example
`serviceKey`, `confmKey`, or `crtfc_key`), use `sensitiveParams`:

```ts
const response = await ctx.http.get("/openapi/lookup", {
	params: { pageNo: 1, numOfRows: 100 },
	sensitiveParams: {
		serviceKey: ctx.env.get("APIFUSE__PROVIDER__EXAMPLE__SERVICE_KEY")!,
	},
});
```

`sensitiveParams` is merged into the outgoing query like `params`, while its
values are redacted from SDK transport errors, traces, and `apifuse record`
fixtures. Do not put query credentials in `params`, and do not hand-build a URL
containing a key; those paths cannot declare which query values are secret.

#### Residual risks

Redaction is unconditional in structural positions (declared query keys and
exact scalar fixture/error fields) for values of every length. In unstructured
free text, values of four or more characters are replaced as substrings; shorter
values are replaced only at token boundaries to avoid corrupting unrelated text
(for example, a secret `api` must not rewrite `rapid`). The residual risk is that
a sub-four-character secret embedded directly inside a larger alphanumeric token
can remain in free text. Prefer a higher-entropy credential, or a header/body
credential channel, whenever the upstream permits it. An empty
`sensitiveParams: {}` is treated exactly as if the option were omitted.

For `session.redirects.run()`, returned hop URLs are diagnostic metadata and
therefore keep declared query values and common response-only credential keys
redacted. If a login flow must consume a rotated credential from `Location`,
inspect it inside `stopWhen`; that callback receives the real hop while callback
failures are sanitized before propagation.

### Request-bound proof headers

When an upstream requires a single-use, request-bound header (DPoP proofs,
HTTP message signatures, HMAC nonces), pass `headers` as a factory instead of a
record. `ctx.http` calls it once per issued attempt with the resolved URL and
method, so a managed retry sends a fresh proof rather than replaying the first
one, and the request keeps proxy failover and the transient retry taxonomy:

```ts
const response = await ctx.http.get(requestUrl, {
	headers: async ({ url, method }) => {
		// RFC 9449 §4.2: `htu` is the target URI without query and fragment.
		const htu = new URL(url);
		htu.search = "";
		htu.hash = "";
		return {
			...commonHeaders,
			dpop: await createDpopProof(htu.toString(), method),
		};
	},
});
```

`url` is the exact URL the attempt is issued against, including `params` and
`sensitiveParams`. Bind to it instead of a URL you rebuild, but strip the query
and fragment for fields that are defined without them (DPoP `htu`), and never
log it or copy it verbatim into a signed field a verifier logs.

Keep the factory fast and local. It runs after proxy resolution, so an already
allocated egress endpoint and its lease are held while it is awaited; a remote
signing round trip there can outlive the lease TTL. Mint locally, and set
`timeout` on the call so a hung signer cannot hold the endpoint indefinitely.

The factory is not invoked for redirect hops (they reuse the attempt's
headers), for skipped duplicate proxy offsets, or for an attempt whose proxy
allocation failed — those build no request, so `attempt` counts only the
requests that are actually issued. A factory that throws fails the request with
the non-retryable `TransportError` code `http_header_factory_failed`, which is
classified as a provider-side fault (`provider_error`), not an upstream
failure. `ctx.stealth` has its own `headers` option and does not accept a
factory.

### Public local debugging checklist

- Operation smoke requests use the provider server envelope:
  `{"requestId":"req_local_<operation>","input":{...},"headers":{}}`.
  Omit `connection` for public/no-auth operations; do not send `connection: null`.
- Credential-backed smoke requests pass local-only credential material in
  `connection.secrets`. Keep real values in shell env or `.env`, never in source
  or fixtures.
- Hand-written auth flows should use `ctx.auth` helpers and return exactly one
  terminal/next turn from each handler: `ctx.auth.nextForm(...)` or
  `ctx.auth.nextPoll(...)` to ask Gateway for the next user/system step,
  `ctx.auth.complete(...)` to finish with `data.credential`, or
  `ctx.auth.abort(...)` to stop safely. Keep abort `data` and `actionHint`
  JSON-safe and secret-free; never include raw cookies, credentials, headers,
  HTML, or upstream `Error` objects.

```ts
const buildProvider = defineProvider({
  id: "example-provider",
  version: "1.0.0",
  runtime: "standard",
  auth: {
    mode: "credentials",
    flow: {
      async start(ctx) {
        return ctx.auth.nextForm({
          fields: {
            email: { type: "email", labelKey: "auth.email.label" },
            password: { type: "password", labelKey: "auth.password.label" },
          },
          hintKey: "auth.signIn",
        });
      },
      async continue(ctx, input) {
        const result = await loginWithSubmittedFields(ctx, input);
        if (result.blocked) {
          return ctx.auth.abort({
            code: "account_action_required",
            retry: "after_user_action",
            actionHint: { kind: "open_provider_app" },
            message: "Approve the login in the provider app.",
          });
        }
        return ctx.auth.complete({
          credential: { cookie: result.cookie },
          metadata: { accountId: result.accountId },
        });
      },
    },
  },
  credential: { keys: ["cookie"] },
  // ...metadata
});

export default buildProvider({ operations });
```

- Credentials auth providers should use `defineCredentialsAuth()` instead of
  hand-writing `auth.flow.start/continue`. The helper exposes one happy path:
  declare form `fields`, declare `credentialKeys`, and put upstream login/session
  creation in `login(ctx, input)`. It returns both `auth` and `credential` for
  `defineProvider()` and builds the complete turn as `data.credential`, which is
  the only value Gateway persists onto the connection.

```ts
import { defineCredentialsAuth, defineProvider } from "@apifuse/provider-sdk";

const credentialsAuth = defineCredentialsAuth({
  fields: {
    email: { type: "email", labelKey: "auth.email.label" },
    password: { type: "password", labelKey: "auth.password.label" },
  },
  credentialKeys: ["cookie"] as const,
  storesReusableSecret: true,
  justification: "Session cookie is required for authenticated operations.",
  async login(ctx, input) {
    const cookie = await loginAndBuildSessionCookie(ctx, input);
    return { credential: { cookie } };
  },
});

const buildProvider = defineProvider({
  id: "example-provider",
  version: "1.0.0",
  runtime: "standard",
  auth: credentialsAuth.auth,
  credential: credentialsAuth.credential,
  context: credentialsAuth.context,
	// ...metadata
});

export default buildProvider({ operations });
```

For OTP, MFA, CAPTCHA handoff, or user-approved login, return a challenge from
`login()` instead of hand-writing `contextPatch`, `poll`, and final credential
turns. SDK stores the pending challenge in auth-flow context, returns the next
form/pending turn, and still persists only the final `data.credential`.

```ts
import {
  credentialsAuthChallenge,
  defineCredentialsAuth,
} from "@apifuse/provider-sdk";

const credentialsAuth = defineCredentialsAuth({
  fields: {
    email: { type: "email" },
    password: { type: "password" },
  },
  credentialKeys: ["cookie"] as const,
  async login(ctx, input) {
    const result = await passwordLogin(ctx, input);
    if (result.otpRequired) {
      return credentialsAuthChallenge("otp", {
        state: { transactionId: result.transactionId },
        hintKey: "auth.otp.prompt",
      });
    }
    if (result.manualApprovalRequired) {
      return credentialsAuthChallenge("manualApproval", {
        state: { transactionId: result.transactionId },
        hintKey: "auth.manualApproval.openApp",
        timing: { suggestedPollIntervalMs: 3000, maxWaitMs: 120000 },
      });
    }
    return { credential: { cookie: result.cookie } };
  },
  challenges: {
    otp: {
      fields: { otp: { type: "otp", labelKey: "auth.otp.label" } },
      async verify(ctx, input, state) {
        const result = await verifyOtp(ctx, state.transactionId, input.otp);
        return { credential: { cookie: result.cookie } };
      },
    },
    manualApproval: {
      async poll(ctx, state) {
        const result = await checkApproval(ctx, state.transactionId);
        if (!result.approved) return null;
        return { credential: { cookie: result.cookie } };
      },
    },
  },
});
```
- Auth-flow debugging starts with `/auth/start`, continues with
  `/auth/continue`, and carries returned `contextPatch` values into the next
  request's `context`.
- Stealth/browser providers may require local runtime setup outside Provider code:
  keep access-sensitive operations on `ctx.stealth.fetch()` with an SDK stealth
  `profile`; the TypeScript runtime uses `wreq-js` behind that interface, so do
  not add per-operation JA3, HTTP/2 SETTINGS, or pseudo-header tuning. `ctx.stealth`
  supports Chrome, Firefox, and Safari profiles; use `ctx.browser` when a
  Provider needs real browser execution. TypeScript browser Providers use
  `browser.engine: "playwright-stealth"` (`nodriver` is Python-runtime only);
  install local browser assets with
  `bunx playwright install chromium`, or set
  `APIFUSE__CDP_POOL__URL` for remote browser debugging.

### Native gateway adapter migration

Native proxy resolution supports both HTTP CONNECT and SOCKS5 without
terminating origin TLS. The built-in vendor order follows `proxy.providers`
exactly: `smartproxy` means the `api.smartproxy.org` allocation vendor (raw
`ip:port` endpoints), while `nodemaven` is the credentialed gateway. It is not
the company formerly called Smartproxy; that separate company is represented
by the deprecated `decodo` name.

Custom `gatewaySynthesizers` must now accept the selected `protocol` and the
injected `credentials` resolver on `NativeGatewayProxySynthesisInput`.
Synthesizers may be async because allocation vendors perform network I/O. They
may return a proxy, `undefined` when they do not implement the offered vendor,
or `{ kind: "skipped", reason }` so an exhausted required chain can explain an
absent credential, unsupported protocol, or allocation failure. Accordingly,
`resolveNativeGatewayProxy(...)` must now be awaited.

Callers that do not supply custom synthesizers or credentials keep env-backed
behavior. Hosts that already have an allowlisted `EnvContext` can inject it
explicitly, and vault-backed or per-tenant hosts can supply their own resolver:

```ts
import {
  createEnvVendorCredentialResolver,
  createNativeNetworkClient,
} from "@apifuse/provider-sdk";

const network = createNativeNetworkClient({
  proxyPolicy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
  credentials: createEnvVendorCredentialResolver(ctx.env),
  // Optional advanced override; omit for each vendor's default.
  proxyProtocol: "socks5",
});
```

Never include credential values in adapter skip messages or thrown errors. The
SDK redacts built-in proxy URL userinfo, CONNECT authentication, and vendor
resolution causes, but a custom adapter remains responsible for not publishing secrets in
its own diagnostics.

### Limiting stealth response bodies

Set `maxBodyBytes` on `ctx.stealth.fetch()` or `session.redirects.run()` when an
upstream response has a known safe maximum. The limit is opt-in and counts
decoded bytes as `wreq-js` streams them. It applies to every redirect hop, uses a
parseable `Content-Length` for an early rejection, and still enforces the limit
incrementally when the header is absent or inaccurate. Exceeding the limit
aborts the response and throws a non-retryable `TransportError` with code
`response_too_large`.

Pass the limit to the transport instead of checking `Content-Length` in provider
code:

```ts
const response = await ctx.stealth.fetch("/api/search", {
  params: { query: input.query },
  maxBodyBytes: 2 * 1024 * 1024,
})
```

### Persisting stealth session cookies

Persist `session.cookies.serialize()` as JSON when an authenticated session must
survive a restart or move to another replica. The returned
`StealthCookieStoreV1` has an explicit version and retains every cookie together
with its Domain, Path, Secure, expiry, host-only, and other cookie attributes.
Restore it with `session.cookies.deserialize()`. Unsupported future versions
fail explicitly instead of being accepted as a partial cookie jar.

Credential values are strings, so stringify the store at the credential
boundary and parse it when rebuilding the session:

```ts
// After login (including any redirects across sibling hosts):
const result = await session.redirects.run({ url: loginUrl });
return {
  credential: {
    cookieStore: JSON.stringify(result.cookieStore),
  },
};

// In a later operation or replica:
const persisted = ctx.credential.get("cookieStore");
if (persisted) {
  session.cookies.deserialize(JSON.parse(persisted));
}
```

`snapshot()` and `restore()` remain only for backward compatibility with flat
`Record<string, string>` credentials. `snapshot()` enumerates cookies across all
hosts and paths, but the flat shape is inherently lossy: duplicate names
collapse and Domain, Path, Secure, expiry, and host-only attributes cannot be
represented. `restore()` therefore recreates host-only `Path=/` cookies on the
session base origin. Do not use the flat form for new persistence code. Cookie
headers remain origin-filtered: use `toHeader(url)` for a particular request and
never build a request header from serialized or snapshotted persistence data.

### Recording and replaying streaming responses

`apifuse record` passes responses returned by `ctx.http.stream()` directly to the operation
handler while incrementally capturing a bounded preview. If the handler returns or cancels its
reader before EOF, the recorder drains the retained upstream reader before writing a JSON evidence
record to `__fixtures__/raw.json`. The record contains the status, success
flag, `content-type`/`content-length`/`content-disposition` headers when present, the
full body SHA-256 and byte count, and a base64 preview up to the configured stream preview limit.
Textual previews are decoded and passed through the fixture sanitizer before base64 encoding.
Classification uses both the declared content type and the preview bytes, so missing or incorrect
content-type headers do not bypass sanitization. PEM private-key blocks and long high-entropy
tokens in otherwise unstructured text are redacted as well. If the full preview is not valid UTF-8,
the entire lossy-decoded preview is scanned and matching decodable byte windows are sanitized. Only a
magic-number-confirmed binary preview with no textual-secret pattern anywhere in the preview bypasses
sanitization; other undecodable data fails closed.
Sanitized previews carry `preview_sanitized: true`, plus a
`preview_redaction_reason` when capture had to fail closed. The original hash and byte count always
describe upstream bytes, not a sanitized preview.

Each record includes query-free request provenance (`method`, `path`, and a one-based stream call
ordinal). Provenance never stores the origin, URL userinfo, query, or fragment. Every retained path
segment is scrubbed before persistence: credential-key segments, values following those keys,
known token shapes, and long high-entropy opaque segments become `[REDACTED]`. If an operation
opens multiple streams, the recorder finalizes every retained reader and
writes all evidence records in stream call order. Stream invocations use a tagged capture envelope
whose items distinguish stream evidence from ordinary JSON responses. Evidence-only snapshot replay
consumes that exact call order and fails immediately when evidence is exhausted or a call kind is
reordered. When request provenance is present, replay also rejects method or path changes (relative
URLs are resolved against the recorded path prefix); ordinals remain diagnostic and are not matched.
Appended fixtures replay a stream envelope only when it is the latest invocation. SSE
recording remains unsupported and fails explicitly instead of retaining an unrelated earlier
response.

#### Residual risks

- Credential-path sanitization decodes each URL path segment once. Double-encoded separators or
  values such as `%252F` are not decoded recursively, so they can conceal a credential-shaped
  segment from the recorder. This single-pass policy keeps path handling deterministic and avoids
  interpreting ambiguous or intentionally layered encodings differently from the upstream. Never
  place credentials in URL paths, and review recorded provenance before committing fixtures.
- Primitive strings embedded in prose are redacted only when they match the current PEM,
  credential-assignment, known-token, or entropy heuristics. Other secret formats can remain because
  blanket redaction of ordinary strings would destroy useful fixture content and create broad false
  positives. Keep secrets under credential-named structured fields where possible and manually
  inspect sanitized fixture text before committing it.

Stream fixture replay in `runStandardTests(..., { snapshot: true })` is evidence-only:
`ctx.http.stream()` returns a usable stream containing exactly the recorded preview,
not a fabricated full body. The replay response also carries runtime metadata
`evidence_only: true`, `body_sha256`, `body_bytes`, and the optional preview sanitization fields
for assertions about the original capture. Do not assert that the replay body hashes to
`body_sha256` when `body_bytes`
exceeds the decoded preview length or `preview_sanitized` is present; use the metadata for
full-body integrity and limit body-content assertions to the preview.

Golden snapshot suites can set `requireSnapshot: true` so a missing committed snapshot fails instead
of being created implicitly. Regenerate intentional changes with
`bun test --update-snapshots`; review and commit the resulting `transform.snap.json` file.

### Migrating after an SDK bump: `apifuse migrate`

```bash
apifuse migrate . --dry-run      # report what would change and what stays for you; writes nothing
apifuse migrate .                # apply every codemod in dependency order
apifuse migrate . --only handles # one codemod (errors-factory and errors-hoist always run together)
```

One command runs every shipped codemod (`scripts/codemods/*.yml`, ast-grep) against the
provider and prints one table: files changed per codemod, rewrites, and the residues the
codemod leaves to you, each with `file:line` and the step it names. Under each codemod the rewrites
whose rule carries a message are listed too: that is what the rewrite moved out of the file (the
prose a `.describe()` held, a dropped option). Exit 0 when nothing is left; exit 1 when rewrites are
pending (`--dry-run`) or residues remain, so `apifuse migrate --dry-run` is the CI gate; exit 2 on a
usage error (unknown option or codemod, missing path, no ast-grep). Nothing is dry by default and
nothing reads the environment: the command does what its flags say wherever it runs. It needs the
ast-grep binary: `bun add -d @ast-grep/cli` in the provider (resolved from `node_modules/.bin`) or
`ast-grep` on `PATH`.

In order, old shape to new shape, and the one step each codemod cannot do:

| codemod | old shape | new shape | by hand |
|---|---|---|---|
| `errors-factory` | `const T = [{ code: "X", status, description, retryable }] as const`; `errorCodes: [...T]`; `new ProviderError(msg, { code: "X", retryable, details })` | `const T = defineErrors({ X: sdkErrors.X \| { status, description, retryable, category? } })`; `errors: [errors.X]` for a list of bare `{ code }` rows (a list with a spread or an inline row is `errors-hoist`'s); a throw site is `errors-hoist`'s alone (reported standalone as `errors-factory-throw-site-option`): it becomes `errors.X({ message: msg, details })` once every row and declaration of X has been read (a non-identifier code such as `"429"` is reached as `errors["429"]`) | nothing for a converted table's rows: `errors-hoist` fills the `category` each provider row lacks (the one its throw sites served) and `retryable: false` where the category's default would flip the legacy default. The imports are `errors-hoist`'s: it adds `import { defineErrors, sdkErrors }` where a table became a map, imports the provider map where `errors.X` names one of its codes, retargets `errors.X` to the map in the file's scope that declares X (its own converted table, or one it imports), and reports a code no map declares (`errors-hoist-reference-undeclared`). A throw site of a registered code whose per-throw `retryable` or `category` contradicts the registry is left as `new ProviderError(...)` and reported (`errors-factory-throw-site-registry-conflict`): accept the registry value or throw a distinct provider code. A list with an element that is not a row literal (a spread, a row constant referenced by name) is left whole (`errors-factory-entry-not-a-row`); `errors-hoist` resolves the name, also across files, and spreads a table only when it is (or the table rule makes it) a `defineErrors` map, so a table whose rows state no status is never spread from an array. Tests (`__tests__/**`, `*.test.ts`, `*.spec.ts`) are never scanned, and only a direct array element whose own keys include `code` and `status` is a table row. A registered code whose row differs from the SDK registry is a residue (`errors-factory-sdk-row-conflict`): accept `sdkErrors.X` or declare a distinct code. An `errorCodes` row written inline with `status` or `description` is a residue (`errors-factory-inline-row-hoist`) and its list is left whole: hoist the row into a table, spread the table in the list, re-run. Tests that pinned the legacy instance shape (`error.options.category`, `error.options.retryable`) fail after the change: a factory error carries only `options.code`; assert the served contract (`status`, `retryable`, `category` on the envelope) instead. |
| `errors-hoist` | `errorCodes: [{ code: "X", status, description, retryable }, ...]` written inline in an operation (also the pre-#238 `docs: { errorCodes }` block and a meta object spread into the operation) | one `defineErrors` map for the provider: the existing `export const errors = defineErrors({` if there is one, else `domain/errors.ts` (created or appended to); `errors: [errors.X, ...Object.values(T), ...]` in the list's order with `import { errors } from "<path>/domain/errors"`; a code several operations list gets one entry; a registry-equal row becomes `X: sdkErrors.X` | nothing for a row it moved. A row it leaves in `errorCodes` names its reason: `errors-hoist-sdk-row-conflict` (a registered code whose status or retryable differs from the SDK registry: accept the SDK value or declare a distinct code), `errors-hoist-code-conflict` (one code declared with different status, retryable or locale keys across operations: give each contract its own code), `errors-hoist-row-not-literal`, `errors-hoist-row-without-status`, `errors-hoist-spread-not-a-table` (a spread that is not a map or a table `errors-factory` converts leaves the whole list), `errors-hoist-outside-operation`. The entry serves what the legacy path served: the row's status, its retryable (else `false`), and the category every throw site of the code served (a literal per-throw `category`, or for a site without one the serve default: `upstream_rejected` for 409/410/422, `input_validation` for a 4xx `ValidationError`, else `provider_error`) when all served one value (`errors-hoist-category-from-sites` notes it), else the serve default. Every `new ProviderError` site is rewritten to `errors.X({...})` only when the provider declares X with one contract (status, category, retryable, across operations' rows, tables and maps) and that contract serves what the site served (its literal per-throw values, or the serve default); otherwise the site stays as written and is a residue naming why: `errors-hoist-throw-site-conflict` (a per-throw value the declaration does not serve: accept the declared value, or declare a distinct code), `errors-hoist-throw-site-code-conflict` (X declared with two contracts, listed; a factory would carry one of them to every operation that reaches the site: give each contract its own code), `errors-hoist-throw-site-row-conflict` (a registered code whose provider row departs from the registry), `errors-hoist-throw-site-undeclared` (no map declares X), `errors-hoist-throw-site-shadowed` (a local `errors` shadows the import). An `AuthError` / `ValidationError` site is never rewritten to a factory; its per-throw `category` / `retryable` are deleted when they equal what the declaration serves (so the `legacy-error-options` lint has no user left and nothing served changes), and the site is reported when they differ (`errors-hoist-throw-site-conflict`) or cannot be checked (`errors-hoist-throw-site-dynamic-option`). A site of a code the SDK runtime owns (`MISSING_SECRET`, `reauth_required`, `HANDLE_*`, ...), or a subclass site of a registered code, loses its per-throw options the same way when they equal the SDK's own value for the code (the serve branch's default for `MISSING_SECRET` is `credential_unavailable`), else it stays and is named `errors-hoist-throw-site-sdk-conflict`. A subclass site keeps its options while a legacy `errorCodes` row of its code may stay in an operation (a row this run refused, or any code when a list is left whole behind a spread it cannot read; the server would read that row, which states no category): `errors-hoist-throw-site-code-conflict` names it. It also keeps them when the serving branch's no-declaration default differs (a site reached from an auth flow or a health scenario reads no declaration): `errors-hoist-throw-site-conflict` names it with that default. A file whose own table is named `errors` rewrites its sites to that map where it declares the code and names the rest (the provider map cannot be imported under the taken name); only an exported `errors` map is taken for the provider's. A `TransportError` / `SessionExpiredError` site is resolved by the server without the declaration, so it is neither. A registered-code row whose description differs from the registry's is noted (`errors-hoist-description-registry`). A `--dry-run` decides every site and declaration as the apply does. When rows of one code differ only in description the first (by file path) wins and each dropped wording is a note (`errors-hoist-description-dropped`). A `ValidationError` or `AuthError` site that states no category served its constructor's default under a legacy row; when the declaration this run writes states another category, the site serves it from then on and is named `errors-hoist-throw-site-conflict` (nothing at the site keeps the default). Only a table errors-factory rule 3 converts (`const T = [...]`, `[...] as const`, `const T: X = [...]` with `{ code, status }` rows) stands for a map in a dry run; in the apply an array is never one, so a `[...] satisfies X[]` table's sites are left and named `throw-site-undeclared`. An `errorCodes` whose rows the step cannot read (a call, a property access: `errors-hoist-list-not-readable`; a name that is not a map: `errors-hoist-spread-not-a-table`) counts as a row of any code left, so no subclass site is stripped while it stands. A `...MAP` of a defineErrors map (one rule 3 just made, or an existing one) inside a plain array literal throws at import; `errors-hoist-map-spread-in-array` names each with the `Object.values(MAP)` fix. A map another file imports must be exported: the step adds `export` to a plain top-level `const` map (once, dry run and apply alike) and otherwise writes no import, naming the site (`throw-site-undeclared`, "declares it but is not exported"). Reachability is decided against the imports the run itself adds, so one run is its own fixed point. Every `{ code, status }` row literal in the sources is read for a registered code that departs from the registry (`throw-site-row-conflict`), whatever table holds it; while a list's rows cannot be read at all (a call, a property access, a name bound to a non-literal; a `defineErrors` map and an array literal are readable), a registered code's `ProviderError` site is not rewritten to the registry factory (`errors-hoist-throw-site-row-unknown`). A `new ProviderError/AuthError/ValidationError` whose code is not a literal and that sets `category`/`retryable` (literally, or in a spread naming them) is `errors-hoist-throw-site-dynamic-code`; a literal-code site whose option sits in such a spread is `throw-site-dynamic-option`. No import is written when the map's module already reaches the site's file through value imports (the import would close a cycle and module evaluation would read a half-initialised module): `throw-site-undeclared` names the path. A `...NAME` inside the map errors-factory makes of a table where NAME is not a map, and a table spreading a property access or a call (which rule 3 leaves an array), are `errors-hoist-array-spread-in-map`; a map entry under a registered key whose values depart from the registry is `errors-hoist-sdk-entry-conflict` on every run (defineErrors refuses it at import). |
| `health-refs` | `expectedErrors: [{ code: "X", status, attribute }]` | `expectedErrors: [{ error: errors.X, attribute }]` | declare `errors` once in the scenario module. |
| `health-stale-window` | `ctx.cache.getOrSet(key, fn, { ttlMs, staleIfErrorMs: N })` / `ctx.cache.set(key, value, { staleIfErrorMs: N })` inside an operation handler or a helper it reaches | `defineOperation({ cache: { staleIfErrorMs: N } })` on every operation whose handler reaches the call (by name, through imports), the per-call option deleted, `N` imported (and exported) when it is a constant of another file, and `cache: true` added to the provider declaration when it lacks the capability | nothing for a call it moved. A call it leaves names its reason: `health-stale-window-two-values` (one operation reaches two different windows: declare the one it wants and give the other its own operation or cache key), `health-stale-window-unreachable` (no handler reaches the call by name), `health-stale-window-declared-differently`, `health-stale-window-value-not-portable` (name the window as a top-level constant), `health-stale-window-no-cache-capability`. |
| `handles` | `defineCursor({ fieldName, issuedBy, ... })` / `defineDraft({ ... })` | the same call without the two options: the key and the issuer are read from the operation schemas where `kind.field()` is placed | refresh contract snapshots that pinned the old issuer wording; `legacy-handle-declaration` must be 0 in `apifuse check`. |
| `runtime-boundary-allow-comments` | `// @apifuse-allow process-env-direct-read \| node-runtime-module-import \| direct-fetch-call: reason` | no comment: the build-time boundary has no escape hatch | fix what the comment acknowledged; `apifuse check` names the `file:line`. |
| `schema` | `name: z.string().describe("prose")`; `fields.<preset>({ description: "prose" })` | `name: z.string().describeKey("schema.name")`; `fields.<preset>()` | add `"schema.<name>": "prose"` to `locales/en.json` (and the other catalogs); the report quotes the prose per rewrite. A `.describe()` that is not a property value (an input root, a union branch, a shared constant) is a residue (`schema-describe-prose-without-property`): wrap it as `describeKey(<schema>, "<key>")`. |
| `declaration` | `const x: AuthConfig = { ... }`; `session: { ..., poolSize: 6 }` | `const x = { ... } satisfies AuthConfig` (the annotated form compiles one more release through a `@deprecated` `defineProvider` overload); `session: { ... }` without `poolSize` (the field is accepted and ignored one more release, `defineProvider` warns once per provider; the next minor refuses it) | add a missing `allowedHosts` / `reviewed`; give `auth` the shape its `mode` requires; replace a reported `auth.exchange` or `reviewed: "staging"`; delete the comment that explained the pool size |

`errors-factory` runs first: it turns every table into a map, rewrites throw sites to `errors.X`, and
leaves a list with inline rows whole. `health-refs` next rewrites scenarios to `errors.X`. `errors-hoist`
after both moves the inline rows into the provider's one map, spreads a table only once it is a map, and
resolves every `errors.X` the two left (the import, or the file's own map). `health-stale-window` after
`health-refs` moves the per-call window `health-refs` only knew how to report; the rest touch disjoint
syntax. Run `biome format`
afterwards: ast-grep writes the rewritten node on one line.

The old shapes stay accepted for one release. SDK contributors prove that with
`bun scripts/bump-safety-scan.ts` before a PR that changes a served contract or a public type, and
the same command's window-rule table is the gate for deleting an old shape: see CONTRIBUTING.md.

### Running the pre-submission report

```bash
bun run submit-check
```

The report scores review readiness across definition metadata, operation/schema quality, fixtures/tests, health coverage, local smoke evidence, auth safety, secret hygiene, and submission docs. It is not a payout guarantee; any blocker must be fixed before review. For the complete public-only submission checklist, see `SUBMISSION.md` in the SDK package.

### Running the lint locally

```bash
bun run lint:providers
```

- Exit 0: all providers pass error-level rules (warnings may still appear)
- Exit 1: at least one error-level violation; CI will block merge

### CI enforcement

`bun run lint:providers` runs in the `lint-and-typecheck` job on every pull request. Error-level violations block merges.
