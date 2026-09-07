---
"@apifuse/provider-sdk": minor
---

Add `stealth.userActivation?: boolean` to `StealthFetchOptions` (default `true`). Set it to `false` on a `requestClass: "navigation"` request to emit a script-driven navigation — `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document` without `Sec-Fetch-User: ?1` — the shape Chrome sends for `location.replace`/`location.assign` and meta-refresh hops. The flag is ignored for the `xhr` and `post` classes, is carried across every hop of the followed redirect chain, and is the only sanctioned way to omit the header: `sec-fetch-*` names remain transport-owned and caller overrides still throw `STEALTH_HEADER_OVERRIDE_UNSUPPORTED`.

Because the default-header order is part of the underlying transport session cache key, navigations with `userActivation: false` use a separate wreq session from user-activated navigations on the same profile/proxy. Cookies are unaffected (the SDK cookie jar is shared); only connection reuse between the two shapes is split.
