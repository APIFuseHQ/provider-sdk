---
"@apifuse/provider-sdk": minor
---

Allow browser resolver navigation to stop at DOM content readiness, classify blocked navigation, and report blocked request context.

- `BrowserPage.goto` gains an additive optional `options` overload (`timeout`, `waitUntil: "load" | "domcontentloaded"`); the existing `goto(url)` signature is preserved, and both the Playwright and CDP pool implementations honor the options (CDP maps `domcontentloaded` to `Page.domContentEventFired` + `readyState === "interactive"`, and surfaces `Page.navigate` `errorText` as a thrown error instead of waiting out the deadline).
- The browser resolver navigates with `waitUntil: "domcontentloaded"` and an explicit timeout: the success-cookie polling loop never needed the `load` event, and third-party subresources that stall the `load` event no longer hold the solve until the caller deadline.
- A main-frame navigation blocked by the resolver resource policy is now classified as `RESOLVER_BROWSER_NAVIGATION_BLOCKED` (wrapped in `ResolverVendorUnavailableError` `transport_failure`) instead of a generic navigation error, and both that error and the solve-timeout error carry a summary of the URLs the resource policy blocked (up to 5 shown), so a challenge that cannot complete because its subresources are blocked is diagnosable from the error message alone.
