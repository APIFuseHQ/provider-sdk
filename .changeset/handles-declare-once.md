---
"@apifuse/provider-sdk": major
---

Handles declare each fact once (ADR-0012 amendment, 2026-10-28). Level is `major` by the repository's API-report rule (existing report lines change: `HandleContext` gains a type parameter, `CursorKind`/`DraftKind` gain a name parameter, `@deprecated` tags); the change is additive and source-compatible for providers.

The property key a handle travels under and the operation that issues it are read from the operation schemas where `kind.field()` is placed: `defineProvider` walks input/output schemas, binds the key (one per direction) and the issuing operations onto each kind, and refreshes the SDK-owned field description ("Opaque handle issued by `waiting-prepare`. Copy it exactly as returned; do not edit or shorten it.") on every placement, including `describeKey()` / `sensitive()` clones. One kind under two different keys on the same side throws at definition time, naming both positions.

- `fieldName` and `issuedBy` on `defineCursor` / `defineDraft` are **deprecated** and removed in the next release. While present they win over the bound contract (byte-identical text for an unmigrated provider) and log one warning per kind. Codemod: `bunx ast-grep scan -r node_modules/@apifuse/provider-sdk/scripts/codemods/handles.yml --update-all .`
- `ctx.handle` is typed to the kinds listed in `handle: [...]` (`HandleContext<DeclaredHandleKind<TConfig>>`); passing another kind is a compile error. `CursorKind` / `DraftKind` carry the kind name as a literal type (`defineCursor({ name: "page" })` is `CursorKind<Schema, "page">`), so two kinds with the same schema stay distinct. A list typed `readonly HandleKind[]` keeps every kind.
- `handle: [...]` without `state` is a compile error (`HandleRequiresStateGuard`).
- `kind.field()` returns `HandleField<Kind>` (a `ZodString` branded with its kind; `HandleKindOfField` recovers it). Parsing still yields `string`.
- New exports: `HandleField`, `HandleKindOfField`, `DeclaredHandleKind`, `HandleRequiresStateGuard`, `isHandleFieldDescription`.

Retired lint rules (deleted with their tests): `handle-kind-undeclared`, `handle-field-name`, `handle-field-parity`, `handle-issued-by`, `handle-requires-state`. Added: `legacy-handle-declaration` (warn) for kinds that still declare `fieldName` / `issuedBy`; it points at the codemod and goes away with the options.

Migration effect to expect: a kind that declared no `issuedBy` but is issued by an operation now names that operation in its description and recovery sentences; contract snapshots that pinned the old wording need a refresh. Standalone `createTestHandleContext` tests that assert recovery text must import the provider module (so `defineProvider` has bound the contract) or keep the deprecated options until then.
