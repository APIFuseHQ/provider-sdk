---
"@apifuse/provider-sdk": minor
---

New provider lint rule `meta-requires-as-const`: the declaration, and its
`meta` block, must reach `defineProvider` with its literal types intact.

`defineProvider` is `<const TConfig extends ProviderDeclaration>`, so an object
written at the call keeps its literal types — but a `const` type parameter
cannot re-narrow a binding that widened at its own declaration. The Wave 3
module-layout work moves `meta` out of `index.ts` across the whole fleet, which
is exactly the edit that drops `as const`, and `as const` has no runtime trace
at all: the loaded provider is byte-identical with and without it. Only the
source carries the narrowing, so the rule reads `providerSourceFiles`.

The rule reports the two shapes that were measured to matter, at the level each
one deserves. The measurement is committed alongside it as a compile-time probe
(`src/__tests__/meta-narrowing-probe.test.ts`): every provider in it declares
`http` and nothing else, so `ctx.files` is an error exactly when the context is
still narrow, and `tsc` is the assertion.

| how the value is declared | at the call | `ProviderContextOf` | rule |
|---|---|---|---|
| `meta` inline in `defineProvider({...})` | ok | narrowed | — |
| `meta = {...} as const` | ok | narrowed | — |
| `meta = {...} satisfies ProviderMeta` | ok | narrowed | — |
| `meta: ProviderMeta = {...}` | ok | narrowed | — |
| `meta = {...}`, no literal-typed field | ok | narrowed | **warn** |
| `meta = {...}` with a literal-typed field | TS2322 | degenerate | **warn** |
| `decl: ProviderDeclaration = {...}` | **ok** | **degenerate** | **error** |
| `decl = {...} satisfies ProviderDeclaration` | ok | narrowed | — |

**error** is reserved for the silent row. Annotating the whole declaration with
`ProviderDeclaration` is perfectly assignable, so the call compiles — but every
capability is an *optional* key of that interface, so `keyof TConfig` becomes
all of them at once. Every branch of `ProviderContext` is keyed on
`"<capability>" extends keyof TConfig`, so the context hands `ctx.files`,
`ctx.browser`, `ctx.state` and the rest to a provider that declared none of
them, and nothing reports it. `satisfies ProviderDeclaration` checks the same
shape and keeps the key set.

**warn** is for a widened `meta`. It is one property of the call literal, so it
cannot change `keyof TConfig` by itself; it turns into a failure only once one
of its widened values stops being assignable (`contract.publicSchemaFieldNames`
going from `"normalized"` to `string` is the one the fleet hits) — and when it
does, `tsc` rejects the call, so nothing ships silently. It warns because the
benign row is one added field away from the broken one.

A fleet sweep of all 98 provider repositories at the time of writing finds zero
repositories in the error bucket and three in the warn bucket (`kakaomap`,
`nol`, `swing-taxi` — each safe today because every literal-union field carries
its own `as const`).

The silent row is matched through the syntax it actually appears in: the
annotation, an `as ProviderDeclaration` assertion (on the binding or written at
the call), a renamed import, and a local `type Decl = ProviderDeclaration`
alias. The callee is resolved to the SDK's `defineProvider` binding, so an
unrelated local helper of the same name is not reported and an SDK import under
another name is. Test sources are skipped — they build throwaway declarations on
purpose, several of them with exactly this annotation.

An annotation that only names a member of the declaration type
(`ProviderDeclaration["meta"]`) is not key-erasing and is not reported, so the
`satisfies ProviderDeclaration["meta"]` convention already in the fleet keeps
working. Values that cannot be resolved inside the provider tree — a
bare-specifier import, a call, a computed expression — are left alone rather
than guessed at.
