---
"@apifuse/provider-sdk": major
---

Make the stealth transport's HTTP/2 header layer match captured Chrome ordering for navigation, fetch/XHR, and JSON POST requests on Windows, macOS, and Linux.

This is breaking: browser profile strings are removed in favor of structured `stealth: { browser, os }` selection at provider, client, session, and request scope. `getStealthProfile` now accepts structured selection and `listStealthProfiles` returns supported browser/OS descriptors; omitted `os` explicitly defaults to `macos`. Version-pinned names still throw with structured replacement guidance. Fingerprint headers remain transport-owned and reject caller overrides; client-wide Accept-Language defaults live under `stealth`, while provider-owned content headers remain ordinary fetch `headers` with their values preserved and positions controlled by the SDK.
