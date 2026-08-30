---
"@apifuse/provider-sdk": minor
---

Carry the declaration-derived operation context through the named public types, so a provider can pass the context it was handed to a sibling operation (#219).

- `ProviderDefinition<TContext = ProviderContext>` threads the context through its operations map instead of erasing it.
- New `OperationDefinitionFor<TBuilder>` / `ProviderDefinitionFor<TBuilder>` helpers annotate an operation or a built provider without discarding the declaration-derived context.
- The server surface (`createServerApp`, `createServerAppAsync`, `serve`, `ProviderServerOptions`, `ProviderServerOperationExecutor`) is generic over the same context, constrained to `Partial<ProviderContext>`, so a narrow-context provider can supply an `operationExecutor` without a cast while a context the runtime cannot build is rejected.

All defaults preserve today's spellings: bare `OperationDefinition` / `ProviderDefinition` annotations and existing server factory calls compile unchanged.
