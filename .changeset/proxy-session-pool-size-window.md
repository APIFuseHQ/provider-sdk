---
"@apifuse/provider-sdk": minor
---

`proxy.session.poolSize` is accepted for one more release. The pool it sized is gone (every attempt mints its own vendor session and a vendor serves `PROXY_ATTEMPTS_PER_VENDOR` attempts before the chain moves on), so the field is `@deprecated` on `ProviderProxyPolicy.session` with hover text naming the removal, `defineProvider` accepts it and warns once per provider with the deletion step, and the runtime never reads it: the session id derivation and the per-vendor attempt budget are the same with and without the field, and a provider that still declares it serves the contract it served before the pool was retired. The next minor refuses the field at `defineProvider`.

Codemod: `apifuse migrate --only declaration` (`scripts/codemods/declaration.yml`, rules `provider-proxy-session-pool-size-last`, `provider-proxy-session-pool-size-middle` and `provider-proxy-session-pool-size-first-of-two`) deletes the field; a comment that explained the pool is left for the author.
