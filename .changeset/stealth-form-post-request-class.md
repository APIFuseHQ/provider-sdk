---
"@apifuse/provider-sdk": minor
---

`ctx.stealth` gains a `form-post` request class for HTML form submissions.

A `<form method="post">` submission is a navigation in Chrome, and until now no request class produced it. The default `post` class sends fetch metadata (`Sec-Fetch-Mode: cors`, `Sec-Fetch-Dest: empty`, `Accept: */*`). `requestClass: "navigation"` sent navigation metadata but had no slot for `Content-Type` or `Origin`, so both were appended after `Cookie`/`Priority`, an order Chrome never sends. `stealth: { requestClass: "form-post" }` now sends what real Chrome 149 sends for a form submission. The source is `chrome-form-post-capture.json`: Google Chrome 149.0.7827.155 submitting a real form, recorded over HTTP/2 (tls.peet.ws, plus a local listener that received the same order) and over HTTP/1.1 (a local listener).

- Order: `content-length`, `cache-control`, `sec-ch-ua*`, `upgrade-insecure-requests`, `content-type`, `user-agent`, `origin`, `accept`, `sec-fetch-*`, `referer`, `accept-encoding`, `accept-language`, `cookie`, `priority`, with the HTTP/1.1 equivalent including casing.
- Values: `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`, `Sec-Fetch-User: ?1` (dropped with `userActivation: false`, for a script `form.submit()`), `Upgrade-Insecure-Requests: 1`, the profile's document `Accept` and `Priority`, `Cache-Control: max-age=0` (a caller value wins), and `Content-Length` from the body.

The request classes are now one descriptor table (fetch metadata, whether the class carries a body, whether it validates the cache), keyed by the public `requestClass` union, so a class without its row does not compile. A bare `POST` still infers `post`: the transport cannot tell a form submission from a script POST, so `form-post` is opt-in. The stealth telemetry `requestClass` gains `form_post`, and the owned-header lint message lists the new class.
