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

Each reference carries the status the factory declared (an `sdkErrors` entry
carries the registry's). As with the table form, only a code declared with
status 400 or 404 that is not a credential or rate-limit refusal becomes a
reference; the rest are compile errors. The legacy `errorCodes` table form is
unchanged, including the last-declaration rule for a duplicate code.

`ProviderErrorDeclaration` and `ProviderErrorFactory` take an optional second
type parameter, the declared status literal (default: the full
`ProviderErrorStatus` union, so every existing annotation still type-checks);
`DefinedErrors` fills it from the map. New export: `DefinedErrorsMap`.
