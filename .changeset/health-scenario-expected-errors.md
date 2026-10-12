---
"@apifuse/provider-sdk": minor
---

health scenarios: declare a non-2xx answer as an expected absence with `expectedErrors` on the operation step

Some upstreams answer "nothing to return" with an error envelope rather than an empty body — no weather alert issued today is HTTP 404 `NO_DATA`, not `items: []`. The platform monitor ends an attempt the moment an operation step answers non-2xx, before any `guard` runs, so a provider had no way to declare that answer and every quiet day was recorded `down`.

`OperationStep` gains an optional `expectedErrors: NonEmpty<ExpectedError>`:

```ts
{
  id: "read-weather-alerts",
  result: "response",
  kind: "operation",
  operationId: "weather-alerts",
  inputTemplate: {},
  expectedErrors: [
    {
      status: 404,
      code: "NO_DATA",
      attribute: [
        { operationId: "weather-alerts", status: "degraded", reasonCode: "expected_absence", reasonKey: "health.operations.weather-alerts.national.calm" },
      ],
    },
  ],
}
```

The monitor matches the provider's own error envelope (`source: "upstream_failure"`) on `status` and `code` together, completes the attempt with `attribute` as the guard attribution (published as the non-incident status `expected_absence`), and never retries it. Anything else stays the failure it is.

- `attribute` reuses the guard attribution narrowed to `reasonCode: "expected_absence"` (`ExpectedAbsenceAttribution`); `served_stale_cache` is a 2xx concern and is rejected here.
- `status` is a 4xx other than 401, 403 and 429: the retry classes and credential refusals are never an absence. Two entries for the same status and code on one step are rejected.
- Two new `apifuse check` errors: `health-check-expected-error-undeclared` (the code is neither declared in the step's operation `errorCodes` nor SDK-registered, or the runtime serves a different status for it, so the entry can never match) and `health-check-expected-error-not-an-absence` (a credential or rate-limit code, or a code served as 401/403/429).
- `ExpectedErrorSchema`, `ExpectedError` and `ExpectedAbsenceAttribution` are exported; the health-checks skill asset documents the clause.

Additive: no existing scenario validates differently. The clause is honoured once the platform health-monitor that reads it is deployed; until then a declared entry is accepted and ignored.
