---
"@apifuse/provider-sdk": minor
---

Record bounded request-scoped stealth transport telemetry for operator logs and gateway headers, including attempts, redirects, pool refreshes, browser profiles, proxy use, request classes, SBSD outcomes, safe refetches, statuses, durations, and redacted log-only failure diagnostics. Cookie and Set-Cookie header-shaped diagnostics are stripped wholesale; bare cookie pairs are stripped when their names are known to the request jar, while foreign bare names remain indistinguishable from benign key=value prose and are covered only when layer 1 registered the value.
