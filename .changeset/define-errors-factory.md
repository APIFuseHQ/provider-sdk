---
"@apifuse/provider-sdk": minor
---

`defineErrors`: declare every provider error code once and throw its factory.

```ts
import { defineErrors, sdkErrors } from "@apifuse/provider-sdk/provider";

export const errors = defineErrors({
  UPSTREAM_SCHEMA_ERROR: sdkErrors.UPSTREAM_SCHEMA_ERROR,
  ITEM_NOT_FOUND: {
    status: 404,
    category: "upstream_rejected",
    description: "The shop has no item with this id.",
    messageKey: "errors.itemNotFound.message",
  },
});

throw errors.ITEM_NOT_FOUND({ details: { itemId } });
defineOperation<Ctx>()({ errors: [errors.ITEM_NOT_FOUND, errors.UPSTREAM_SCHEMA_ERROR], ... });
```

**Public API added.** `defineErrors`, `sdkErrors`, and the types
`ProviderErrorDeclarationInput`, `ProviderErrorDeclaration`, `ProviderErrorInput`,
`ProviderErrorFactory`, `DefinedErrors`, `DefineErrorsInput`, `SdkErrorRef`, `SdkErrorCode`
(root and `/provider`). `OperationDefinition.errors` lists the factories an operation can
throw; the contract publishes them as the existing `errorCodes` rows. `ProviderError` gains a
`TCode` type parameter: `errors.X()` is a `ProviderError<"X">`, a hand-built one is
`ProviderError<string>`.

- A key naming an SDK-registered code must hold its `sdkErrors` reference; the status, category,
  retryability and description are the SDK's literal values, so restating or overriding them is a
  type error (and a `ValidationError` at runtime). A provider code states `status`, `category` and
  `description`; `retryable` defaults to the category's (`timeout`, `network`,
  `upstream_rate_limited`, `upstream_http`, `proxy_pool` retry; nothing else does). A map may spread
  another map's factories.
- **Registry changes, visible to every provider on bump.** The SDK registry (`sdkErrors`) now
  carries retryability and a contract description per code. `UPSTREAM_ERROR` is registered
  `retryable: true` (fleet consensus, 350 of 426 declarations); `NOT_FOUND`, `not_found`, `NO_DATA`,
  `UPSTREAM_REJECTED`, `BLOCKED`, `UPSTREAM_AUTH_ERROR`, `UPSTREAM_SCHEMA_ERROR`, `AUTH_REQUIRED`,
  `INVALID_REQUEST` are `retryable: false`; the rate-limit codes are `true`. `AUTH_REQUIRED` is now
  classified `credential_unavailable` (source `client`) and `INVALID_REQUEST` `input_validation`
  (source `client`), as the fleet throws them; both previously fell to `provider_error` (source
  `apifuse`). These registry rows answer only where neither a declaration nor a per-throw option
  does (see the precedence below), so an undeclared bare `throw new ProviderError(msg, { code:
  "UPSTREAM_ERROR" })` is served `retryable: true` and an undeclared bare `AUTH_REQUIRED` /
  `INVALID_REQUEST` changes source from `apifuse` to `client`.

**Runtime.** One function, `resolveProviderErrorContract`, now answers status, category and
retryability for every served provider error; it replaces the six `instance ?? declared ?? false`
merges in the server. Precedence, per field:

- `status`: the declaration (a factory's, or the operation's legacy `errorCodes` entry), then the
  SDK registry. Unchanged from before.
- `retryable` and `category`: the deprecated per-throw option first, then the declaration, then (for
  category) a declared 409/410/422 status (`upstream_rejected`), then the SDK registry. This is the
  `instance ?? declared` order the server always had, kept on purpose for the release the per-throw
  options survive, so that a provider that bumps the SDK without touching its throw sites serves
  the same `retryable` as before in **both** directions:
  - declared `retryable: true`, thrown `retryable: false` (a deterministic refusal under a table row
    or the `UPSTREAM_ERROR` registry row that says retryable): served `false`, as before. The
    gateway envelope and bori's retry decision keep reading `false`.
  - declared `retryable: false`, thrown `retryable: true`: served `true`, as before. The declaration
    becomes the only source once the per-throw option is removed; until then the server warns.
  A factory-made error (`errors.X(...)`) has no per-throw option, so the declaration is its whole
  contract. The buyee shape (an `errorCodes` row declaring `UPSTREAM_ERROR` non-retryable, thrown
  through a helper that passes `retryable: false`) keeps serving `false` on the legacy path; when
  it migrates, the registered key must hold `sdkErrors.UPSTREAM_ERROR` (retryable), so the
  non-retryable condition moves to a distinct code (`sdkErrors.UPSTREAM_REJECTED` or a provider
  code), which the codemod reports as a residue rather than flipping the row.

One served-contract change follows from the registry: a registered code thrown with no per-throw
`retryable` and either no declaration or a legacy `errorCodes` row that states no `retryable` is
served with the registry's retryability (previously always `false`), e.g. an undeclared
`RATE_LIMITED` or `UPSTREAM_ERROR` is now retryable. Across the 131 provider checkouts scanned,
that is 97 undeclared sites and 2 silent-row sites, all read paths; no site whose declaration or
throw states `retryable` changes its served value.

**Deprecated, kept for one release.** `OperationDefinition.errorCodes` and the per-throw
`ProviderErrorOptions.category` / `retryable` are `@deprecated`; the hover text names the
replacement. The server logs one `provider_error_options_deprecated` warning per code (and per
conflict shape) per process when a provider throw still sets them; when the per-throw value
differs from the declaration the warning carries `conflicts: [{ option, thrown, declared }]` and
its `fix` says to declare a distinct code for the other condition (an `UPSTREAM_REJECTED` for a
deterministic 4xx refusal, or a provider code) rather than override per throw. `apifuse check`
reports `legacy-error-options` (warn) on each remaining `errorCodes` table and each throw site that
sets `category` or `retryable`. The server's own stream-cancellation error (`client_cancelled`,
served 400, non-retryable) is now declared through `defineErrors` inside the server rather than
built with the deprecated per-throw options; it is not added to `sdkErrors` and its envelope is
unchanged.

**Lint rules retired** (deleted with their tests): `thrown-error-code-undeclared`,
`thrown-error-retryable-conflicts-declaration`, `error-code-status-conflicts-sdk`,
`error-code-retryable-conflicts-sdk`, `thrown-error-message-not-localized`,
`error-locale-key-malformed`, `error-locale-key-missing`. The last two became definition-time
checks: a malformed key fails `defineErrors`, and `apifuse check` verifies every declared
`messageKey` / `fixKey` against `locales/en.json` ("Declared error locale keys resolve in
locales/en.json"). `lintProvider` no longer takes `localeCatalogEn`. Rule count: 49 → 43.

**Codemod.** `scripts/codemods/errors-factory.yml` (ast-grep) rewrites `new ProviderError(msg, {
code: "X", ... })` to `errors.X({ message: msg, ... })`, `errorCodes: [...]` to `errors: [...]`, and
`const T = [{ code, status, description, retryable }, ...] as const` tables to `defineErrors({ ... })`
(an SDK code becomes `sdkErrors.X` only when the row's `status` and `retryable` equal the
registry's; a row that differs keeps its own values under that key, which `defineErrors` refuses,
and the `errors-factory-sdk-row-conflict` diagnostic names the row with the two choices: accept
the SDK value, or declare a distinct provider code such as `UPSTREAM_REJECTED` for that
condition; a 409/410/422 row gets `category: "upstream_rejected"`; other provider rows leave
`category` for the author, which `tsc` names). Run
`ast-grep scan --rule scripts/codemods/errors-factory.yml <provider-dir>` to preview.

**Lint.** `health-check-expected-error-unmatchable` and `-not-an-absence` read a listed
`defineErrors` factory's declaration (status and category) the way they read an `errorCodes` row,
so a migrated operation can name its own code in `expectedErrors`.

**Scaffold.** `apifuse create` now writes `domain/errors.ts` with a `defineErrors` map and the
ping operation lists and throws `errors.VALUE_EMPTY`.
