---
"@apifuse/provider-sdk": minor
---

Add explicit engine-mode selection ahead of the ADR-0011 remote-only engine
(phase (a1) of the #252 migration plan). Nothing changes for existing callers:
`serve`, `createServerApp*`, `startDevServer`, `apifuse dev` and `apifuse record`
still attach the in-process engine by default, and the default path gains no new
boot failure.

- `ProviderServerOptions.engineMode` / `DevServerOptions.engineMode`
  (`ProviderEngineMode`, an intentionally open union so further lanes can be
  named without a breaking change) and the engine-owned `APIFUSE__ENGINE__MODE`
  variable select the attachment. Values are trimmed and case-folded; blank means
  unset. The manifest (env) outranks the option, an explicit `engine` object is
  used as given, and every disagreement is reported rather than dropped. An
  unrecognized env value is reported and ignored — a rendered manifest must never
  be able to crash a pod. A malformed `engineMode` option throws, because only
  calling code can produce one. The resolver itself stays internal.
- Only the in-process lane is served in this release: any other mode (`remote`
  today, any later lane the open union names) attaches an engine that fails every
  request with `PROVIDER_ENGINE_MODE_UNSUPPORTED` (500, non-retryable) and reports
  503 on the new `GET /readyz`, instead of throwing at boot. In-process is never a
  fallback (ADR-0011 Pitfall 2). `apifuse dev|record` refuse to start for any
  unserved mode — they are developer tools, not pods.
- New `GET /readyz` reports the resolved attachment
  (`{status, provider, version, engine:{mode, attached}}`, 200/503).
  `GET /health` is unchanged and stays engine-blind: it is what liveness probes
  use, so engine reachability may never influence it.
- `serve` logs one `provider_engine_mode` event per boot with `mode`, `source`
  (`engine` | `env` | `option` | `default`), `deprecated` (true for every
  non-remote attachment, including an opaque host engine),
  `attached`, `sdkVersion`, `runtimeTarget` and non-fatal `warnings`.
  `createServerApp*` does not log it. `ProviderServerLogEvent` is an **open**
  union: consumers must tolerate an unknown `event` value, and a consumer that
  switches exhaustively with a `never` default must add this member. The release
  stays `minor`: the API reports gain only added lines, and the only modified
  lines are the trailing `ae-forgotten-export` comments whose `dist/...d.ts:LINE`
  references shifted because declarations moved down — no existing declaration
  changed.
- The four ADR-0011 engine error classes are exported
  (`ProviderEngineAuthenticationError`, `ProviderEngineProtocolVersionError`,
  `ProviderEngineUnavailableError`, `ProviderEgressDeniedError`) **and their codes
  are registered** in the SDK error taxonomy, so an engine failure is no longer
  served as an unregistered 500 with a false
  `unregistered_provider_error_code` signal. `PROVIDER_ENGINE_UNAVAILABLE` maps to
  503 and stays retryable (a gateway may retry it once the engine recovers);
  authentication, protocol mismatch, denied egress and an unsupported mode are
  non-retryable 500s, because no caller retry can clear a deployment fault.
- `ProviderEngine.kind?: ProviderEngineMode` lets a host engine describe itself so
  the boot event and `/readyz` can report a truthful mode; the value is trimmed
  and case-folded like the env and the option.
- `APIFUSE__ENGINE__API_KEY` (and any credential embedded in
  `APIFUSE__ENGINE__URL`) joins the diagnostic sensitive-value inventory, so the
  remote engine client credential is redacted from diagnostics the way the other
  engine-owned credentials already are.
- `ProviderSecretDeclaration.issuer?: "apifuse" | "contributor"` is accepted and
  validated when present. It is metadata only: secret projection is unchanged, and
  nothing warns about omitting it.
- `createInProcessProviderEngine` documents its scheduled removal and reports
  `kind: "in-process"`. It is deliberately **not** `@deprecated` yet: the
  replacement remote client ships in a later release.
