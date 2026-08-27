---
"@apifuse/provider-sdk": major
---

Close the native capability boundary.

**Breaking.** `ProviderContext.native` is no longer optional, and the `NativeProviderContext` alias is removed — use `NativeContext` directly.

Optionality made the consumer decide what absence meant, collapsing "the runtime cannot provide it", "the provider never declared it", and "the capability failed to load" into one `undefined`. With declaration-derived contexts a declared capability is always present and an undeclared one is absent from the type, so availability probes such as `ctx.native !== undefined` have nothing left to branch on and are removed.

`native` also moves out of the ambient set and is derived from the declaration like every other capability.

Declaration validation now rejects `native` on a runtime that cannot host it:

```
Provider "x" cannot declare capability "native" with runtime "browser"
```

`standard` and `shared` can host it (server-side `node:net` / `node:tls`); `browser` cannot. The error names both the capability and the runtime, and is raised at declaration time rather than surfacing later as a missing property.
