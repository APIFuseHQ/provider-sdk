---
"@apifuse/provider-sdk": patch
---

`runStandardTests` now rejects stealth-owned request headers the way production does, and the owned-header lint stops reading a bound two-name list as a header tuple.

- The offline `ctx.stealth` (`fetch`, `createSession().fetch`, `createSession().redirects.run`) calls the stealth runtime's own `assertCallerHeadersSupported`, now exported from `src/runtime/stealth-owned-headers.ts`, before it reaches `upstreamStub`. A `User-Agent`, `Sec-Fetch-*`, `sec-ch-ua*`, `host`, `connection` or `accept-encoding` caller header throws `SDKError` `STEALTH_HEADER_OVERRIDE_UNSUPPORTED` in the test, wherever it came from: a header-constants module in another file, a variable, or `getStealthProfile(...).userAgent`. Before, the fake accepted it and only production failed. A provider test that now fails here was sending a request production rejects.
- `browser-version-literal` counts a two-element array as a `[name, value]` header entry only where it is consumed as one: inside an entries list (`new Headers([[name, value]])`, `Object.fromEntries([...])`), as a call argument (`tuples.push([...])`), or under a tuple type. `const STRIP = ["sec-fetch-dest", "referer"]`, `for (const name of [...])` and `["sec-ch-ua-mobile", "accept"].includes(x)` no longer report. The file scope is unchanged and no suppression comment is added.
