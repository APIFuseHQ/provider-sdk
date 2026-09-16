---
"@apifuse/provider-sdk": minor
---

Name the state and cache backends a provider resolved, once per boot.

`serve` now emits one structured `provider_state_backend` line before the
listener binds, alongside the existing `provider_engine_mode` line: which
backend each store resolved to (`redis` / `memory` / `unsupported` /
`injected`), which env name supplied the Redis URL, and that URL's `host:port`
and scheme. Credentials, path and query are never included — a URL that has no
parseable authority contributes no endpoint at all rather than a fragment of
itself — and a URL that cannot be attributed is reported as a warning instead
of being echoed.

Until now nothing said which store a provider was on. `APIFUSE__PROVIDER__STATE_REDIS_URL`
falls back to `APIFUSE__PROVIDER__CACHE_REDIS_URL` and then `APIFUSE__REDIS__URL`,
so a provider silently keeping its runtime state on a cache instance that runs
with persistence off looked identical — from outside the pod and from the pod's
own logs — to one on a durable instance (apifuse#2144 could only be verified by
inference from the Deployment spec; apifuse#2302). That fallback is now called
out explicitly: the event carries `fallback: true`, the warning
`state_redis_url_fallback`, and `level: "warn"`.

Additive for callers. `ProviderServerLogEvent` gains one variant
(`ProviderStateBackendLogEvent`, exported from `@apifuse/provider-sdk/server`
with `ProviderStoreBackendReport`); a logger that switches exhaustively over
the union needs a branch for it. The env precedence itself is unchanged, and is
now declared in one place (`providerStateRedisResolutionFromEnv` /
`providerCacheRedisResolutionFromEnv`) so the reported backend cannot drift
from the resolved one.
