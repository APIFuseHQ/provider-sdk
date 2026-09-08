---
"@apifuse/provider-sdk": minor
---

Add request-scoped native transport telemetry with connection and tunnel timings, bounded attempt and vendor skip diagnostics, application byte counts, and drain, idle, and expiry counters. Native proxy leases now feed the existing proxy telemetry sibling, and proxy-required and native transport failures retain their error attribution. Operator diagnostics use the request redactor; gateway headers contain only closed fields and numeric or boolean observations.
