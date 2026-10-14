---
"@apifuse/provider-sdk": minor
---

health: declare an upstream's announced maintenance with `healthProbe.maintenanceWindows`

An upstream that announces maintenance ahead of time (Buyee: "JST 2026-10-14 02:00–08:00, every function unavailable") still showed as an outage: every probe in the window failed, eighteen incidents opened per occurrence, and uptime absorbed the hours. The notices fall on irregular dates, so no recurring schedule can describe them; the provider has to state each announced window.

`healthProbe` (and its `healthMonitor` alias) gains an optional `maintenanceWindows: NonEmpty<UpstreamMaintenanceWindow>`:

```ts
healthProbe: {
  maintenanceWindows: [
    {
      startsAt: "2026-10-13T17:00:00Z",
      endsAt: "2026-10-13T23:00:00Z",
      sourceUrl: "https://buyee.jp/information/public/info_3077",
      declaredAt: "2026-10-14T09:00:00Z",
      // operations: ["search"],  // optional; omitted = every operation
    },
  ],
},
```

- `startsAt`, `endsAt` and `declaredAt` are ISO 8601 instants in UTC ending in `Z`; an offset, a missing zone or a calendar date is rejected.
- `endsAt` must be later than `startsAt`.
- `startsAt` may be at most 90 days (`UPSTREAM_MAINTENANCE_LOOKBACK_DAYS`) before `declaredAt`, the retention of the platform's health samples. The bound is relative to the declaration, not to the clock, so a valid declaration never starts failing as time passes.
- `sourceUrl` is an absolute http(s) URL of the upstream's announcement.
- `operations`, when present, is a non-empty list of distinct operation ids this provider defines; `defineProvider()` rejects an unknown one.

`UpstreamMaintenanceWindowSchema`, `UpstreamMaintenanceWindowsSchema`, `UpstreamMaintenanceWindow` and `UPSTREAM_MAINTENANCE_LOOKBACK_DAYS` are exported from the root and `./provider`. The windows travel in the provider contract under `healthMonitor`, so they are covered by `digestProviderContract`. The health-checks skill asset documents the declaration.

The platform reads the field once the APIFuse change `declare-upstream-maintenance-windows` is deployed: until then a declared window changes nothing on the status page. An SDK older than this release rejects `maintenanceWindows` as an unknown `healthProbe` field at `defineProvider()`, so a provider declares windows only after it and the platform's SDK pin are on this release.
