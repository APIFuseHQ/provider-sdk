---
"@apifuse/provider-sdk": minor
---

Health scenarios reference declared error codes by value, and the SDK
attaches the stale-serve freshness guard from the operation's declared
stale window.

**Release order.** This release depends on the APIFuse platform change that
resolves SDK-owned guard reason keys from the SDK's own copy
(APIFuseHQ/apifuse#2747, `feat/health-guard-sdk-owned-reason-copy`,
APIFUSE-379) landing first; until it does, `apifuse provider
validate` reports `HEALTH_GUARD_REASON_KEY_UNRESOLVED` for a provider that
declares `cache.staleIfErrorMs` and does not carry `health.servedStaleCache`
in its own catalog.

**`expectedErrors` by reference.** `errorRefs(errorCodes)` returns one typed
reference per `errorCodes` entry an expected absence may name
(`errors.NO_DATA` carries the declared `code` and `status`); an operation step
declares `expectedErrors: [{ error: errors.NO_DATA, attribute }]`.
`errors.<X>` exists only for a code declared with status 400 or 404 and
outside the credential and rate-limit refusal class
(`EXPECTED_ERROR_REFUSAL_CODES`), so an undeclared code, a status the runtime
does not serve, 409/410/422 (upstream refusals), 401/403/429 and the auth and
rate-limit codes are compile errors instead of lint findings. Declare
`errorCodes` `as const`. The by-code form `{ status, code, attribute }` still
parses for one release, is `@deprecated` on `ExpectedErrorInput`, and warns
once per entry at definition time; `defineHealthScenario` tags such an entry
(non-enumerable, not serialized; `isExpectedErrorByCode`) so the old path's
two lint rules read only by-code entries. New exports: `errorRefs`,
`ErrorRefs`, `OperationErrorRef`, `OperationErrorCodeDeclaration`,
`ExpectedAbsenceStatus`, `ExpectedErrorInput`, `ExpectedErrorRefusalCode`,
`EXPECTED_ERROR_REFUSAL_CODES`, `OperationStepInput`, `HealthStepInput`,
`HealthScenarioInput`, `isExpectedErrorByCode`.

**Stale window declared on the operation.** `defineOperation({ cache: {
staleIfErrorMs } })` (`OperationCachePolicy`; requires the provider-level
`cache` capability) is the one place an operation's stale window lives. The
runtime applies it to every `ctx.cache.getOrSet` / `ctx.cache.set` the
operation makes, so the call carries `ttlMs` only. A per-call
`staleIfErrorMs` is `@deprecated` on `ProviderCacheGetOrSetOptions`, still
wins when present, warns once per operation at the first call, and is removed
in the next minor. `withOperationCachePolicy` (runtime) is the wrapper the
serve layer and `runStandardTests` apply.

**Freshness guard by default, for the operations that serve stale.**
`defineProvider` appends a guard on `served_stale_cache` after every
operation step of an operation that declares `cache.staleIfErrorMs`, in its
health-check case scenarios and in health journeys, when the author did not
already guard that step (`withFreshnessGuards(scenario,
staleServingOperations)`, exported; step id `<id>.freshness`, result
`<result>.freshness`, `FRESHNESS_GUARD_SUFFIX`). An operation without the
declaration never serves stale and gets no guard. A hand-written guard that
rejects the stale serve and attributes `served_stale_cache` before any other
guard, or an `assert` on the operand, is honoured as the author's verdict; a
guard that attributes `expected_absence` or follows another guard gets the
default in front of it. Guards for `step_block` members follow the block. The
64-step budget applies to the serialized result, attached guards included.
`defineHealthScenario` itself no longer attaches anything.

The attached guard attributes `reasonKey: "health.servedStaleCache"`
(`FRESHNESS_GUARD_REASON_KEY`). The key is SDK-owned: the SDK ships its copy
(`FRESHNESS_GUARD_REASON_COPY`, en/ko/ja; `SDK_OWNED_HEALTH_REASON_COPY` maps
every SDK-owned key to its copy) and the platform resolves the key to that
copy when the provider's catalogs lack it, so no provider has to add a locale
key to upgrade. Add the key to `locales/*.json` only to change the wording.
`apifuse create` no longer seeds it.

Migration: `sg scan --rule scripts/codemods/health-refs.yml --update-all .`
from the provider checkout rewrites by-code `expectedErrors` entries to
`errors.<CODE>` in any property order (declare `const errors =
errorRefs(<operation>ErrorCodes)` in the scenario module) and reports every
per-call `staleIfErrorMs` with the `cache: { staleIfErrorMs }` declaration
that replaces it (add the declaration, then delete the per-call option; the
codemod does not delete it, because the declaration lives in another file and
removing the value first would turn stale serving off).

Lint rules: 49 on main -> 47 (the two stale-serve rules dropped when the
guard moved to the declaration) + 2 restored for the per-call deprecation
window = 49 rule ids in `lint.ts` this release; 45 once the next minor
removes the four window rules with their forms. Nothing is deleted outright
in this release; each lane-C rule follows its old path out. Kept for the deprecated per-call
`staleIfErrorMs` only (an operation that declares `cache.staleIfErrorMs` has
the guard attached and is never linted; removed with the option in the next
minor): `health-check-stale-serve-unguarded`,
`health-check-stale-serve-reason`, both now naming the declaration as the fix.
Kept for the deprecated by-code `expectedErrors` form only (a reference entry
is never linted; removed with the form in the next minor):
`health-check-expected-error-not-an-absence`,
`health-check-expected-error-unmatchable`.
`health-check-assertions-not-monitored` stays: its structural replacement is
a required `scenario` on `HealthCheckCase`, which removes the self-test-only
`assertions` shape and so needs its own deprecation release first.

Known gap: a scenario written as a raw object literal straight into
`healthCheck.cases[].scenario` (never passed through `defineHealthScenario`)
is neither warned, tagged nor linted for a by-code `expectedErrors` entry,
and the reference type never applied to it; closing it means typing
`HealthCheckCase.scenario` as the authored input, a separate deprecation. No
fleet provider authors a scenario that way today (0 of 73 with scenarios).
