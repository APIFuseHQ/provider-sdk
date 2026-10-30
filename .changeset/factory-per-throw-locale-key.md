---
"@apifuse/provider-sdk": minor
---

A `defineErrors` factory call carries a per-throw `messageKey` / `fixKey`,
and the codemods keep them.

`ProviderErrorInput` gains optional `messageKey` and `fixKey`
(`ProviderLocaleKeyInput`). `errors.CODE({ message, messageKey })` resolves the
localized envelope text the way the legacy
`new ProviderError(msg, { code, messageKey })` path did: the throw's key wins
over the declaration's, which wins over the derived `errors.<code>.message`.
The contract (status, category, retryable) is still the declaration's, so a
site that says something more specific than the code's one sentence (the
fleet's `INVALID_REQUEST` with six per-site keys, `NO_DATA` with a
"bid notice not found" key) no longer has to stay on the hand-constructed
path. An `sdkErrors` reference, whose row cannot declare a key, takes one per
throw too.

`apifuse migrate` (`errors-hoist`) now rewrites a throw site that states a
`messageKey` / `fixKey` like any other site, copying the key into the
factory input as written (a string literal, a variable, a shorthand). Before,
a site with a property-assigned key was left in place with the
`errors-factory-throw-site-locale-key` residue, and a site with a shorthand
key (`{ code, messageKey }`) was rewritten into a factory call the input type
refused, a `tsc` error on the codemod output. That residue rule is gone:
there is no key the rewrite cannot carry. The sites a rewrite still leaves (a
registry or declaration conflict, a non-literal `category` / `retryable`, a
shadowed `errors` binding, an undeclared code) are named by their own
residues as before.
