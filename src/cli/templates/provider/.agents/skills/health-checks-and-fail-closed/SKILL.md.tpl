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

## Stale-if-error serves must be guarded, or an outage reads green

If the operation reads its upstream through `ctx.cache.getOrSet(..., {
staleIfErrorMs })`, an upstream outage is answered with HTTP 200 and a
well-formed, fully schema-valid body for the whole stale window. Every clause
over `status_code` and `data` still passes, so the probe rolls up `ok` while
the upstream is down, and only flips to `down` after the window expires — the
first minutes of every outage are reported as healthy.

`served_stale_cache` on the operation step result is the only operand that
separates a stale serve from a live read. It is always present, so the
reference resolves to `false` rather than raising `reference_unresolvable`.
Add ONE guard step per stale-if-error probe:

```ts
{
  id: "guard-list-items-freshness",
  result: "freshness-guarded",
  kind: "guard",
  condition: {
    kind: "predicate",
    operator: "not_equals",
    actual: { ref: { namespace: "steps" as const, binding: "response", path: ["served_stale_cache"] } },
    expected: true,
  },
  onFail: {
    attribute: [
      {
        operationId: "list-items",
        status: "degraded",
        reasonCode: "expected_absence",
        reasonKey: "health.operations.list-items.dense-district.servedStaleCache",
      },
    ],
    stop: "scenario",
  },
}
```

- `degraded`, not `down`: the cache policy is behaving as promised and callers
  are still served; it is the upstream that is unavailable, and that has to be
  visible instead of green.
- `expected_absence` is the only `reasonCode` the guard attribution schema
  admits today, and it reads correctly here — the FRESH read is what was
  absent. The tenant-facing wording lives in the localized `reasonKey`.
- Place the freshness guard BEFORE any row or emptiness guard. A stale serve
  that happens to be empty would otherwise be attributed to the emptiness
  reason, which is a confident answer to the wrong question.
- Do not change the handler for this. The envelope's `meta.stale` is written
  by the serve layer, so `return result.value` discarding `result.meta` does
  not suppress the signal.

## Fail-closed: envelope level
- Upstream error headers/codes → structured `ProviderError` with a stable
  `code` (`UPSTREAM_AUTH_ERROR`, `UPSTREAM_ERROR`, `NO_DATA`, ...).
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
- [ ] Every `staleIfErrorMs` read has a `served_stale_cache` guard, placed first
- [ ] Swallowed-error test exists (non-ok mock → handler rejects)
- [ ] Non-empty upstream → zero normalized rows throws
- [ ] No upstream free text in customer-facing error messages
