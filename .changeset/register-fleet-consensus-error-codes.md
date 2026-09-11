---
"@apifuse/provider-sdk": minor
---

Register the three fleet-consensus provider error codes so throwing them no longer serves HTTP 500.

`UPSTREAM_AUTH_ERROR` → 400, `UPSTREAM_SCHEMA_ERROR` → 502, and `INVALID_REQUEST` → 400 join `SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES`, all non-retryable. Before this change a provider that threw one of them without declaring it in the owning operation's `errorCodes` was served as HTTP 500 with the `unregistered_provider_error_code` signal — so "the upstream changed its response shape" reached the caller as "APIFuse crashed", and the hub's default retry policy for undeclared 5xx made a deterministic failure look retryable. 74 provider repos throw at least one of the three; 37 of them declare none of the three anywhere, so 392 throw sites were serving 500.

`UPSTREAM_AUTH_ERROR` is 400 rather than 401 or 502 because it means the upstream refused a *platform-managed* service key. Under `auth.mode: "platform-managed"` the caller holds no credential, so 401 asks the caller to do something it cannot do, and 502 promises an upstream recovery that will never come. It is a deployment/config defect — the same class as `MISSING_SECRET`, which the SDK already maps to 400 for that reason. `UPSTREAM_SCHEMA_ERROR` is non-retryable because a retry returns the same payload the provider already could not normalize. The minority spellings `UPSTREAM_SCHEMA_CHANGED`, `INVALID_INPUT`, `VALIDATION_ERROR`, and `BAD_REQUEST` are deliberately **not** registered; registering them would freeze a divergence that the contract track is converging.

**No provider's served status changes.** These three codes are thrown by provider code, not by the SDK, so they are registered in the status map and not in `SDK_RUNTIME_OWNED_ERROR_CODES` — exactly like `UPSTREAM_ERROR` and `BLOCKED`. `toStatusCode` reads an operation declaration *before* the canonical map for codes the SDK does not runtime-own, so a provider that already declares one of these with a different status keeps serving that status. Silently rewriting it was the alternative, and it was rejected: a provider serving 502 for `UPSTREAM_AUTH_ERROR` would have flipped to 400 on an SDK bump with nothing in its own diff to explain it.

Instead the divergence is now reported at authoring time by two new lint rules, both warnings so they cannot fail `apifuse check` for the long tail:

- `error-code-status-conflicts-sdk` — an operation declares a `status` that differs from the registered status for that code.
- `error-code-retryable-conflicts-sdk` — an operation declares a `retryable` that differs from the registered retryability.

Each message names the declared value, the canonical value, states that the declaration still wins at runtime, and offers the two honest fixes: drop the field so the SDK supplies it, or throw a distinct code if this operation genuinely means something else. Codes the SDK runtime-owns are skipped, because `defineProvider` already warns there and for those the declaration really is ignored.

`AUTHORING.md`'s `errorCodes` example previously declared `UPSTREAM_SCHEMA_ERROR` with `status: 502, retryable: true`. That example is the traceable source of the `retryable: true` declarations now on 27 operations across six provider repos, and it contradicted the code's meaning; it is replaced with a provider-owned code (`ITEM_SOLD_OUT`) that is not SDK-registered, so the example teaches when to declare rather than modelling a redundant declaration.

API report: the only declaration change is additive — `lintProvider`'s `operations[].errorCodes` parameter type gains optional `status` and `retryable`, which the new rule reads. The accompanying `ae-forgotten-export` footer line-number shift is mechanical.
