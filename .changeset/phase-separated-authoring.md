---
"@apifuse/provider-sdk": major
---

Phase-separate provider authoring so capability declarations shape the operation context.

**Breaking.** `defineProvider` no longer accepts a single object containing both the declaration and `operations`. It now takes the declaration and returns a builder:

```ts
const buildProvider = defineProvider({ id, version, runtime, http: true, meta });
export type ProviderContext = ProviderContextOf<typeof buildProvider>;
export default buildProvider({ operations });
```

The old shape could not carry the guarantee: TypeScript contextually types a nested `defineOperation()` call before the sibling declaration is settled, so `ctx` always resolved to the full context and a wider handler satisfied the narrower requirement contravariantly. Separating the phases establishes the declaration first, so an inline handler receives exactly the declared capabilities with no annotation, and reaching an undeclared capability is a compile error.

Operations in separate files bind the context through one type-only import and `defineOperation<ProviderContext>()({ ... })`. Helpers should take the capability (`fetchThing(http: HttpClient, ...)`) rather than the whole context, which keeps them free of declaration-derived generics.

`scripts/migrate-phase-separated-provider.ts` converts existing providers. It dry-runs by default, takes `--write`, and leaves a file unchanged rather than half-converting it when it meets a shape it does not recognize.
