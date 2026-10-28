---
"@apifuse/provider-sdk": major
---

The provider declaration states its own requirements (DX program wave 2, lane E). Level is `major` by the repository's API-report rule (`ProviderDeclaration` lines change); a provider that passed `apifuse check` compiles and serves the same contract after the bump.

`defineProvider` now refuses at the call what ten lint rules used to report afterwards, and `validateProviderDeclaration` is the one runtime site for the same checks (values the type cannot see, plus wildcard host content):

- `allowedHosts: AllowedHostList` (`readonly [string, ...string[]]`) and `reviewed: "first-party" | "community"` are required fields. `ProviderDefinition.allowedHosts` stays `string[]`; `defineProvider` copies the list.
- `auth?: ProviderAuthDeclaration`, discriminated by `mode`: `credentials` and `oauth2` require `flow` (with `start` and `continue`), `oauth2_proxied` requires `proxied`, and `exchange?: never` in every mode (hover text points at `auth.flow.continue`). Omitting `auth` still means `{ mode: "none" }`.
- `AuthModeCredentialGuard<TConfig>`: `credentials` needs a non-empty `credential.keys`; `platform-managed` must not list keys. `CredentialSecretGuard<TConfig>`: a key that names a reusable secret (token, password, cookie, session, api key), or one `auth.flow.refresh` could log in with again (password, passcode, secret, cookie, session), needs `storesReusableSecret: true` and `justification`. Both guards decide from the literal keys at the call and name the fix in the compile error; keys typed `string[]` are left to the runtime.
- `DefinedCredentialsAuth` (returned by `defineCredentialsAuth`) is typed as the `credentials` arm, so `defineProvider({ ...credentialsAuth })` keeps compiling. An auth block annotated `: AuthConfig` widens `mode` and no longer reaches the call; write `satisfies AuthConfig` (codemod below).
- `ProviderContext<TConfig>` narrows on capability keys that are present with a value (`DeclaresCapability`), never on `meta`. A declaration whose capability keys are all optional (annotated `: ProviderDeclaration`, `Pick`/intersection of it, an explicit `defineProvider<ProviderDeclaration>()`) now yields the ambient context, so the provider's own `ctx.http` read fails to compile instead of every capability being typed as present. `meta` is plain data: `as const` on an extracted `meta` block is no longer needed for narrowing.

Retired lint rules, deleted with their tests:

- covered by the type and the one runtime validate: `allowed-hosts-required`, `allowed-hosts-non-empty`, `allowed-hosts-no-wildcards` (runtime only), `reviewed-required`, `auth-flow-continue-required`, `credential-keys-required-when-credentials-mode`, `credential-reusable-secret`, `auth-refresh-reusable-secret`, `platform-managed-no-credential-keys`;
- `stealth-config-required`: `ctx.stealth` is absent from `ProviderContextOf` unless `stealth` is declared, and the engine refuses an undeclared capability read at runtime (`PROVIDER_CAPABILITY_UNDECLARED`);
- `auth-mode-api-key-removed` (`"api-key"` is not an `AuthMode`), `auth-exchange-unsupported` (`exchange?: never`; the runtime refusal stays), `legacy-choice-usage` (`ctx.choice` and the `ProviderChoice*` exports no longer exist, so every use is a `tsc` error);
- `meta-requires-as-const`, with `src/__tests__/meta-narrowing-probe.test.ts`; `src/__tests__/declaration-types.test.ts` keeps the compile-time proof (rows A to E and the annotated shapes).

Kept, with the reason: `mixed-auth-connection-mode-required` (the operation literal does not carry `connectionMode` through `defineOperation`, and the SDK runtime never reads the field, so neither the type nor the runtime validate owns it), `redundant-approval` (a restated default still compiles; one more release), `context-keys-required` (`FlowContext.context` is typed for every flow, so a read without declared keys still compiles; one more release).

Codemod: `bunx ast-grep scan -r node_modules/@apifuse/provider-sdk/scripts/codemods/declaration.yml --update-all .` rewrites `const x: AuthConfig = {...}` to `satisfies AuthConfig` and reports `auth.exchange` and `reviewed: "staging"`.

New exports: `ProviderAuthDeclaration`, `AllowedHostList`, `AuthModeCredentialGuard`, `CredentialSecretGuard`.
