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
- Two new `apifuse check` errors: `health-check-expected-error-unmatchable` (the entry can never match: the code is neither declared in the step's operation `errorCodes` nor SDK-registered, the runtime serves a different status for it, or the serve layer attributes its envelope elsewhere — `upstream_rule` for a registered refusal or a declared 409/410/422, `apifuse` for a provider code thrown without an upstream `category`; a duplicate `errorCodes` entry resolves to its last declaration, as at runtime) and `health-check-expected-error-not-an-absence` (a credential or rate-limit code, or a code served as 401/403/429).
- `ExpectedErrorSchema`, `ExpectedError` and `ExpectedAbsenceAttribution` are exported; the health-checks skill asset documents the clause.

Additive in the SDK: no existing scenario validates differently. The platform does not ignore the field before it supports it, it refuses it:

- A provider registry built without apifuse #2592 rejects a scenario that carries `expectedErrors` at catalog admission, as a build error. Declare the field only after #2592 is in every ref that builds the registry for prd, including any hotfix branch cut from the live ref.
- A health-monitor older than apifuse 6c8d705b99 (#2592) parses the plan with the strict scenario schema and rejects any scenario that carries `expectedErrors`: every plan reload is refused fleet-wide, and a boot that has to parse that plan exits 1. Declare the field only after that image is confirmed running, and once any provider declares it, do not roll health-monitor back below it.
