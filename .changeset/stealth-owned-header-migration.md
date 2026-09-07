---
"@apifuse/provider-sdk": patch
---

Document the stealth header ownership introduced in 2.2.0-beta.49 (#239) and make the runtime rejection discoverable.

Since beta.49 the `ctx.stealth` transport owns `host`, `connection`, `user-agent`, `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`, `accept-encoding`, and every header whose name starts with `sec-fetch-`. A caller value for any of them is rejected at request time on both `stealth.fetch()` and `session.redirects.run()` with `SDKError` code `STEALTH_HEADER_OVERRIDE_UNSUPPORTED` (HTTP 500 through `serve`); `bun run check` and `apifuse submit-check` do not catch it. Migration: delete those headers and declare the request shape with `stealth: { requestClass: "navigation" | "xhr" | "post" }` (`POST` infers `post`, everything else `navigation`); `Accept`, `Accept-Language`, `Priority`, `Upgrade-Insecure-Requests`, `Referer`, `Origin`, and `Content-Type` remain caller-settable.

This release adds that note to the `StealthFetchOptions.headers` and `stealth.requestClass` JSDoc and the README, registers `STEALTH_HEADER_OVERRIDE_UNSUPPORTED` as an SDK-owned code so `serve` no longer logs it as an unregistered provider error code, and rewrites the `browser-version-literal` lint messages, which until now recommended passing `getStealthProfile(...).userAgent` as a header — the exact pattern that the stealth transport rejects. The lint now says to omit the header under `ctx.stealth` and use `userAgent` with `ctx.http` only.
