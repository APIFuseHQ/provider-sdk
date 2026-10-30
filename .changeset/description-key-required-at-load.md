---
"@apifuse/provider-sdk": minor
---

**Breaking.** `descriptionKey` is required on every operation. The one-release window that kept it optional on `OperationDefinition` (and so on `defineOperation` / `defineStreamOperation` input and every `operations` map entry) is deleted; the lint rule `description-key-required` goes with it, replaced by the type and one load-time refusal.

- Type level: `OperationDefinition.descriptionKey` is `ProviderLocaleKeyInput`, no longer optional. An operation literal without it fails `tsc` at `defineOperation(...)` and at `defineProvider(...)({ operations })`.
- Load time: `defineProvider` throws `ValidationError` `DESCRIPTION_KEY_REQUIRED` for an operation whose `descriptionKey` is missing or blank, naming the operation; the `fix` names the key to add (`operations.<id>.description`) and the `locales/en.json` entry it needs, and points a key still written under `docs.descriptionKey` to `apifuse migrate-operation-declaration .`, which hoists it. Untyped and JavaScript callers get the same refusal.
- `lintOperation` no longer takes `descriptionKey` and `apifuse check` no longer reports `description-key-required`; a provider missing the key stops `apifuse check` at import with the uncaught `ValidationError` (exit 1, the code and the fix printed), the same way the other load-time refusals do.

The fleet declares the key on every operation (the bump-safety scan of 136 targets recorded 0 `description-key-required` diagnostics), so provider code needed no change. Two provider repos had a test-only operation literal without the key and were fixed ahead of this release (apifuse-provider-hyundai-card #36, apifuse-provider-kakaotalk #56).

Retired lint rule id: `description-key-required`.
