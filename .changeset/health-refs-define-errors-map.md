---
"@apifuse/provider-sdk": minor
---

`errorRefs` accepts the `defineErrors` map, so a factory-declared provider
writes the reference form in its health scenarios without a parallel
`errorCodes` table:

```ts
export const errors = defineErrors({ NO_DATA: sdkErrors.NO_DATA, ITEM_GONE: { status: 404, ... } });
const refs = errorRefs(errors);
expectedErrors: [{ error: refs.NO_DATA, attribute }]
```

Each reference carries the status and category the factory declared (an
`sdkErrors` entry carries the registry's). Only a code declared with status
400 or 404, not a credential or rate-limit refusal, and in a category the
monitor matches on (served as the upstream's own envelope, source
`upstream_failure`, in practice `upstream_http`) becomes a reference; a 404
declared `upstream_rejected` or `sdkErrors.INVALID_REQUEST` is a compile
error and absent from the object, because the monitor would never match it.
The legacy `errorCodes` table form is unchanged (a row has no category),
including the last-declaration rule for a duplicate code.

`ProviderErrorDeclaration` and `ProviderErrorFactory` take optional second
and third type parameters, the declared status and category literals
(defaults: the full unions, so every existing annotation still type-checks);
`DefinedErrors` fills them from the map. `sourceForCategory` now reads one
const table, `PROVIDER_ERROR_CATEGORY_SOURCES`, which
`ProviderErrorCategoryOfSource<Source>` reads at the type level. New exports:
`DefinedErrorsMap`, `ExpectedAbsenceCategory`, `PROVIDER_ERROR_CATEGORY_SOURCES`,
`ProviderErrorCategoryOfSource`.
