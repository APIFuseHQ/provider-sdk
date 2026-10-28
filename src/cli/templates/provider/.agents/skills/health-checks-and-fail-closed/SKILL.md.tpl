---
name: health-checks-and-fail-closed
description: Writing health checks the platform monitor actually executes, and fail-closed guards at envelope and row level. Load before writing healthCheck blocks or error handling.
---

# Health checks and fail-closed guards

## Only `scenario` is monitored in production

A `healthCheck` case takes one of two mutually exclusive shapes, and they do
not run in the same place:

| field | executed by | when |
|---|---|---|
| `scenario` | the platform health monitor | every suite interval, in production |
| `assertions` | the provider runtime's own self-test | only when that endpoint is called |

The monitor runs a case's SERIALIZED scenario and nothing else: a closure
cannot cross the registry's serialization boundary. A case that carries only
`assertions` is still published as a probe, but its outcome is permanently
`unknown` / `monitoring_unavailable` — the operation reads as monitored on the
status page while nothing is ever checked. `apifuse check` warns about this
(`health-check-assertions-not-monitored`).

Anything that must be caught in production belongs in `scenario`. Keep
`assertions` for a local self-test, or drop it.

## A scenario that can actually fail

`Array.isArray(data.items)` alone can never fail. Every list operation's probe
must be able to detect the zero-rows regression AND a mapper regression that
empties fields on a present row.

Step kinds: `operation` invokes, `assert` FAILS the probe (recorded `down`),
`guard` DEGRADES without failing it.

```ts
// health-scenarios.ts
import { type AssertionExpression, defineHealthScenario } from "@apifuse/provider-sdk/provider";

export const PROBE_INPUT = { district: "<a guaranteed-dense, stable id>" } as const;

const response = (path: readonly (string | number)[]) => ({
  ref: { namespace: "steps" as const, binding: "response", path: [...path] },
});

const evidence: AssertionExpression = {
  kind: "all",
  clauses: [
    { kind: "predicate", operator: "status_2xx", actual: response(["status_code"]) },
    // Dense query MUST return rows; zero rows = upstream contract drift.
    { kind: "predicate", operator: "array_length_gte", actual: response(["data", "items"]), expected: 1 },
    // A semantic field on a real row, so an emptying mapper regression fails too.
    { kind: "predicate", operator: "non_empty", actual: response(["data", "items", 0, "name"]) },
  ],
};

export const listItemsScenario = defineHealthScenario({
  scenarioVersion: 2,
  id: "list-items.dense-district",
  display: {
    titleKey: "health.operations.list-items.dense-district.title",
    descriptionKey: "health.operations.list-items.dense-district.description",
  },
  schedule: { kind: "interval", intervalMs: 60 * 60_000, jitterMs: 0 },
  timeoutMs: 15_000,
  coversOperations: ["list-items"],
  credentialRefs: [],
  steps: [
    { id: "read", result: "response", kind: "operation", operationId: "list-items", inputTemplate: { ...PROBE_INPUT } },
    { id: "verify", result: "verified", kind: "assert", coversOperations: ["list-items"], expression: evidence },
  ],
});
```

```ts
// operations/list-items.ts
healthCheck: {
  interval: "1h",
  timeoutMs: 15_000,
  cases: [{ name: "dense-district", input: { ...PROBE_INPUT }, scenario: listItemsScenario }],
}
```

- Choose probe inputs that are guaranteed-dense (major city district, a stable
  well-known entity id). Verify the id still exists when picking it.
- `scenario.coversOperations` may only name the operation that owns the case.

## Stale-if-error serves are guarded by default

An operation that serves stale declares its window once, on the operation:

```ts
defineOperation({
  // ...
  cache: { staleIfErrorMs: 300_000 },
  handler: async (ctx, input) =>
    (await ctx.cache.getOrSet(key, load, { ttlMs: 60_000 })).value,
})
```

The SDK applies the window to every `ctx.cache.getOrSet` / `ctx.cache.set`
the handler makes (the call carries `ttlMs` only; a per-call `staleIfErrorMs`
is deprecated, warns once, and is removed in the next minor). With the window
declared, an upstream outage is answered with HTTP 200 and a well-formed,
fully schema-valid body for the whole stale window. Every clause over
`status_code` and `data` still passes, so a probe would roll up `ok` while
the upstream is down.

`served_stale_cache` on the operation step result is the only operand that
separates a stale serve from a live read. `defineProvider` attaches a guard
on it right after every operation step of an operation that declares
`cache.staleIfErrorMs` (an operation without the declaration never serves
stale and gets no guard):

```ts
{
  id: "read.freshness",
  result: "response.freshness",
  kind: "guard",
  condition: {
    kind: "predicate",
    operator: "not_equals",
    actual: { ref: { namespace: "steps" as const, binding: "response", path: ["served_stale_cache"] } },
    expected: true,
  },
  onFail: {
    attribute: [
      { operationId: "list-items", status: "degraded", reasonCode: "served_stale_cache", reasonKey: "health.servedStaleCache" },
    ],
    stop: "scenario",
  },
}
```

- Nothing to write in the scenario. The stale-serve policy is declared once,
  on the operation, and the guard follows the declaration.
- `health.servedStaleCache` is the one locale key the guard attributes. The
  SDK owns the key and ships its copy (`FRESHNESS_GUARD_REASON_COPY`, en/ko/
  ja), and the platform resolves the key to that copy when `locales/*.json`
  carry no value. Add the key to the catalogs only to change the wording.
- `degraded`, not `down`: the cache policy is behaving as promised and callers
  are still served; it is the upstream that is unavailable, and that has to be
  visible instead of green.
- `served_stale_cache`, not `expected_absence`: the platform publishes a
  stale serve as `degraded` (an upstream fault that opens incidents), while
  `expected_absence` is published as a non-incident status — neither ok nor
  degraded, excluded from uptime — for an absence the provider declares in
  advance (no alert today, a closed shelf, a feed outside its hours).
- To write the guard yourself (a different sentence, or a `down` verdict
  through an `assert` on the same operand), place it BEFORE any row or
  emptiness guard and attribute `served_stale_cache`; the SDK then leaves the
  step alone. A freshness guard after another guard, or one attributing
  `expected_absence`, is not a verdict and still gets the default in front.
- Do not change the handler for this. The envelope's `meta.stale` is written
  by the serve layer, so `return result.value` discarding `result.meta` does
  not suppress the signal.

## Declared absence served as an error: `expectedErrors`
Some upstreams answer "nothing to return" with an error, not an empty body: no
weather alert issued today is HTTP 404 `NO_DATA`, not `items: []`. A guard
cannot see that — the monitor ends the attempt the moment an operation step
answers non-2xx, before any guard runs — so without a declaration every quiet
day is recorded `down`.

Declare the answer on the operation step itself, by reference to the code the
operation declares. The monitor matches the provider's own error envelope
(`source: "upstream_failure"`) on `status` and `code` together, completes the
attempt with `attribute` as the guard attribution, and never retries it:

```ts
// operations/weather-alerts.ts
export const weatherAlertsErrorCodes = [
  { code: "NO_DATA", status: 404, description: "No alert is issued today." },
] as const satisfies readonly OperationErrorCode[];

// health-scenarios.ts
import { errorRefs } from "@apifuse/provider-sdk/provider";
const errors = errorRefs(weatherAlertsErrorCodes);

{
  id: "read-weather-alerts",
  result: "response",
  kind: "operation",
  operationId: "weather-alerts",
  inputTemplate: {},
  expectedErrors: [
    {
      error: errors.NO_DATA, // serialized as status: 404, code: "NO_DATA"
      attribute: [
        {
          operationId: "weather-alerts",
          status: "degraded",
          reasonCode: "expected_absence",
          reasonKey: "health.operations.weather-alerts.national.calm",
        },
      ],
    },
  ],
}
```

- Only `expected_absence` is admitted here. A stale-cache serve is a 2xx; a
  non-2xx is either the declared absence or a real failure.
- `errors.<CODE>` exists only for a code the operation declares in its
  `errorCodes` with status 400 or 404. An undeclared code, a code declared
  with another status (409/410/422 are upstream refusals; 401/403/429 and
  every 5xx are never an absence) and the auth and rate-limit codes are
  compile errors, so a typo cannot leave a quiet day recorded as `down`.
  Declare the codes `as const` so each one is a literal.
- Throw the code as the upstream's own envelope: a registered upstream code
  such as `NO_DATA`, or a provider code declared or thrown with `category:
  "upstream_http"`. An envelope attributed elsewhere never matches.
- The by-code form `{ status, code, attribute }` still parses for one release
  and warns at definition time; `scripts/codemods/health-refs.yml` rewrites it.
  Until then `apifuse check` lints it: `code` must be a code the operation
  serves — listed in its `errors` (a `defineErrors` factory), declared in its
  `errorCodes`, or SDK-registered — with the same status and served as the
  upstream's own envelope; a mismatched entry never matches and the quiet day
  stays `down`, and the auth and rate-limit codes, 401/403/429, 409/410/422
  and every 5xx are rejected as never an absence.
- The upstream must answer that code for nothing else. If the same status and
  code also mean a real fault, split the codes in the handler first.
- Keep the row guard (`array_length_gte` on the 2xx body) as well: an
  `expectedErrors` entry answers the error envelope, the guard answers the
  empty success body.

## Announced upstream maintenance: `maintenanceWindows`
When the upstream publishes a maintenance notice (the service is unavailable
between two times), declare that window on `healthProbe` with the notice's
URL. Failing samples inside the window are published as an expected absence,
not an outage, and incidents whose failing samples all fall inside it are
retracted, also when the window is declared after it happened (up to 90 days
back).

```ts
healthProbe: {
  maintenanceWindows: [
    {
      // Notice: JST 2026-10-14 02:00-08:00
      startsAt: "2026-10-13T17:00:00Z",
      endsAt: "2026-10-13T23:00:00Z",
      sourceUrl: "https://buyee.jp/information/public/info_3077",
      declaredAt: "2026-10-14T09:00:00Z",
    },
  ],
},
```

- UTC only: convert the notice's local time (JST 02:00 is 17:00Z the day
  before). An offset or a time without `Z` is rejected.
- Declare only what the upstream announced, with the announcement's URL. The
  platform retracts incidents on the strength of it.
- `operations: ["search", ...]` narrows the window to the operations the
  notice covers; omit it when the whole upstream is unavailable.
- Probes keep running through the window. A failure that outlasts `endsAt` is
  an outage from `endsAt` on, so copy the announced times; do not pad them.
- `startsAt` may be at most 90 days before `declaredAt`; older samples are
  gone. There is no recurring form: declare each announced window.

## Fail-closed: envelope level
- Upstream error headers/codes → a declared error from `domain/errors.ts`
  (`errors.UPSTREAM_AUTH_ERROR()`, `errors.UPSTREAM_ERROR()`, `errors.NO_DATA()`, ...):
  the code's status, category and retryability live in that one declaration.
- Non-JSON body, unexpected content type → `UPSTREAM_SCHEMA_ERROR`.
- HTTP non-2xx → classified error; never a fake empty success envelope.
  Fixture-based tests cannot catch swallowed errors — write an explicit test:
  mock a non-ok response and assert the handler REJECTS.

## Fail-closed: row level
Envelope guards are not enough. The silent killer is: response is valid,
array is non-empty, but every row normalizes to nothing.
- If a non-empty upstream collection produces zero normalized rows, throw
  `UPSTREAM_SCHEMA_ERROR` instead of returning `items: []`.
- Identity fields (id, name) missing on a row → throw, don't skip the row
  silently.
- Regression-test both layers separately: a bad envelope AND a good envelope
  with unmappable rows.

## Self-test assertions (optional, not monitored)
A case without a `scenario` may carry an `assertions` lambda, executed only by
the provider runtime's own self-test. THROW to fail the case (recorded
`down`); return `{ status: "degraded", label }` to flag without failing;
return nothing for `ok`. There is no `"down"` return value. It MUST NOT touch
the scheduler, recorder, or any runtime type. Never use it as the only check
on an operation you need monitored.

## Error message hygiene
`ProviderError.message` reaches the tenant verbatim. Never interpolate
upstream free text that may contain personal data (names, phone numbers,
addresses); allowlist known code tokens and keep raw bodies in server-side
details/logs only.

## Checklist
- [ ] Every monitored operation's case carries `scenario` (not only `assertions`)
- [ ] Every list op probe fails on 0 rows for a dense query
- [ ] One semantic field asserted on a real row
- [ ] Every operation that reads through `ctx.cache` with a stale window declares `cache: { staleIfErrorMs }` (the SDK attaches the `served_stale_cache` guard from it)
- [ ] Each announced upstream maintenance is a `maintenanceWindows` entry (UTC, notice URL)
- [ ] Swallowed-error test exists (non-ok mock → handler rejects)
- [ ] Non-empty upstream → zero normalized rows throws
- [ ] No upstream free text in customer-facing error messages
