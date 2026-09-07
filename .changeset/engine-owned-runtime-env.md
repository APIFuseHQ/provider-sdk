---
"@apifuse/provider-sdk": minor
---

Treat hosted runtime settings as engine-owned environment names: every
`APIFUSE__CDP_POOL__*` variable, `APIFUSE__STT__CLOUDFLARE_API_TOKEN`,
`APIFUSE__OCR__CLOUDFLARE_API_TOKEN`, `APIFUSE__OCR__API_KEY`,
`APIFUSE__CLOUDFLARE__ACCOUNT_ID`, `APIFUSE__CACHE__KEY_PEPPER`, and
`APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET`. `defineProvider` now
rejects them in provider `secrets` (`cannot declare engine-owned runtime
variable`), and provider environment projections drop them, as they already do
for the proxy, resolver, and telemetry names. Adds
`ENGINE_OWNED_RUNTIME_ENV_NAMES` and `isEngineOwnedRuntimeEnvName`.

Providers that read these names through `process.env` or `ctx.env.get` with the
exact upper-case spelling are unaffected; only declaring them as provider
secrets changes, from accepted to rejected at definition time.
