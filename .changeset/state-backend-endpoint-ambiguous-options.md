---
"@apifuse/provider-sdk": patch
---

`provider_state_backend` no longer reports an endpoint it cannot stand behind.

`createProviderRedisClient` hands the raw URL to `new Redis(url, …)`, and
ioredis' `parseURL` ends with `defaults(result, queryOptions)`, so a query key
applies where the authority supplied nothing. `?path=/tmp/redis.sock` therefore
always applies — and `StandaloneConnector` connects to `options.path` instead of
host/port — while `?port=` applies only when the URL carries no explicit port.
The boot line read `hostname:port` straight off the URL, so for those URLs it
named a Redis the provider was not connected to, in the one diagnostic whose job
is to answer "which Redis is this provider's state actually on".

In those two cases the line now omits `endpoint`, keeps `scheme`, and raises
`state_redis_url_ambiguous_endpoint` / `cache_redis_url_ambiguous_endpoint`. The
query itself is never logged (it can carry a password). `?host=`, `?family=` and
`?port=` alongside an explicit port are ignored by ioredis and keep their
endpoint. No change for a plain `redis://host:port`, which is what the fleet
renders today.
