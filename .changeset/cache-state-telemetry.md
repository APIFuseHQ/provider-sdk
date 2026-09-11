---
"@apifuse/provider-sdk": minor
---

Add request-scoped cache and runtime-state capability telemetry contributors with bounded log and gateway-header projections.

Cache sinks use an internal construction binding; `ProviderCacheOptions` gains no options. Both contributors expose `redisMode` with `not_configured`, `configured`, and `degraded` values. Cache `redisRoundTrips` counts successful Redis commands; state counts successful operations that touch Redis, once per operation regardless of command count. Resolver cache use on auth routes is observed through the existing provider cache.
