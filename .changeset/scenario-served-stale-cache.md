---
"@apifuse/provider-sdk": minor
---

health scenarios: expose `served_stale_cache` on the operation step result

An operation that reads its upstream through `ctx.cache.getOrSet(..., { staleIfErrorMs })` answers an upstream outage with HTTP 200 and a well-formed, fully schema-valid body for the whole stale window. Every scenario clause over `status_code` and `data` therefore passes, and the probe rolls up `ok` while the upstream is down.

`OperationResult` now carries `served_stale_cache: boolean` — the health-monitor's projection of the response envelope's `meta.stale`, already produced by the runtime — so a scenario can guard on it:

```ts
{
  id: "guard-freshness",
  result: "freshness-guarded",
  kind: "guard",
  condition: {
    kind: "predicate",
    operator: "not_equals",
    actual: { ref: { namespace: "steps", binding: "case", path: ["served_stale_cache"] } },
    expected: true,
  },
  onFail: {
    attribute: [{ operationId, status: "degraded", reasonCode: "expected_absence", reasonKey }],
    stop: "scenario",
  },
}
```

Additive and type-only: the reference path schema already accepted arbitrary strings, the field is always present so a reference resolves to `false` instead of raising `reference_unresolvable`, and no existing scenario validates differently. No migration is required; providers that serve stale-if-error should add the guard.

Also documents on `HealthCheckCase.assertions` that the platform health monitor cannot execute an imperative closure — a case that carries only `assertions` is published as a probe whose outcome is permanently `unknown` / `monitoring_unavailable`, and the hook runs only in the provider runtime's own self-test.
