---
"@apifuse/provider-sdk": patch
---

`ctx.stealth` now sends redirected hops in the header order real Chrome 149 uses, and drops `Origin` when a redirect turns a POST into a GET.

- A redirected navigation or form submission (`requestClass: "navigation"` or `"form-post"`) sends `sec-ch-ua`, `sec-ch-ua-mobile` and `sec-ch-ua-platform` right after `Sec-Fetch-Dest` instead of first, over HTTP/2 and HTTP/1.1, after a 302/303 that rewrites to GET and after a 307 that keeps the POST. This holds on every followed hop of `ctx.stealth.fetch` (`redirect: "follow"`) and on every `session.redirects.run` hop after the first. Before, every hop reused the first request's order, which Chrome never sends after a redirect. A redirected `xhr`/`post` request keeps its first request's order, as Chrome's does. The `session.redirects.run` hop still picks its wreq session by the first-request order, so it stays on the same session and connections.
- A redirect that changes the method (301/302 POST to GET, 303 to GET) drops `Origin` along with the request-body headers, in both redirect walkers. Real Chrome sends no `Origin` on that GET, for a form submission and for a page `fetch()`; a 307 keeps it.
- A `navigation` request with a caller `Referer` now sends it after `Sec-Fetch-Dest`, where Chrome puts it, instead of last.

The source is `chrome-redirect-hop-capture.json`: Google Chrome 149.0.7827.155 (headed under Xvfb, driven by Playwright with no locale, user agent or extra headers) following a link, submitting a form, and calling `fetch()` against local `node:http2` and `node:net` listeners that answered 302, 303 or 307. `scripts/capture-chrome-redirect-hops.ts` re-records it. `stealth-redirect-wire.test.ts` checks the order the real wreq transport writes on the wire against the HTTP/1.1 capture.

Release level: `patch`. No `api-reports/` line changes.
