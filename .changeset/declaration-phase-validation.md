---
"@apifuse/provider-sdk": patch
---

Validate provider declarations when they are declared

`defineProvider` is two-phase, but every validator ran in the second phase.
A declaration that is invalid on its own — a missing `auth.proxied` block, a
reserved OAuth parameter override, a capability that conflicts with the
declared runtime — was accepted by `defineProvider(...)` and only rejected
once the builder was called. Code that exports a declaration without calling
the builder was never validated at all.

Validation is now split by what each check needs: declaration-only checks run
inside `defineProvider(declaration)` before the builder is returned, and the
operation validators continue to run inside the builder call. Each check runs
in exactly one phase and error messages are unchanged.
