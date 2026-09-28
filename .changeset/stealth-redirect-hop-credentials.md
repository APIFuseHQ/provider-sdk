---
"@apifuse/provider-sdk": minor
---

The stealth redirect walkers no longer carry caller credentials to another origin or site, and `ctx.stealth.fetch` accepts the ctx.http same-origin `redirectPolicy`.

- Every followed hop, in `ctx.stealth.fetch` (default `redirect: "follow"`) and in `session.redirects.run`, now takes its caller headers from one function (`redirectHopHeaders`). A hop that leaves the current origin drops `Authorization` and `Proxy-Authorization`. A hop that leaves the current site (scheme plus registrable domain from the public suffix list) drops an explicit `Cookie`; the session cookie jar then supplies cookies for the new site, as a browser does. A method change drops the request-body headers (`Content-Type` and the other Fetch request-body header names), which `redirects.run` previously kept on a POST-to-GET hop. A header dropped on one hop stays dropped for the rest of the chain. Before, both walkers re-sent the caller's `Cookie` and `Authorization` to every hop regardless of origin, so a `302` to a foreign host received the session credentials.
- New opt-in `redirectPolicy: { mode: "same-origin", maxHops }` on `StealthFetchOptions`, validated and enforced by the same code as the ctx.http option: a redirect that leaves the initial origin, exceeds `maxHops` (0 to 10, the stealth redirect limit), loops, or has no usable `Location` throws `HttpRedirectError` (`http_redirect_stopped` / `_max_hops` / `_loop` / `_missing_location`) before any request goes to that target. It requires the default `redirect: "follow"`; combining it with `"manual"` or `"error"` throws `http_redirect_policy_invalid`. `StealthRedirectRunOptions` does not take it, since `redirects.run` already has `maxHops` and `stopWhen`.

Not in this change: enforcing `allowedHosts` on redirect hops. No SDK transport enforces `allowedHosts` today, and ADR-0011 D5 (#252) puts the egress allowlist in the engine.
