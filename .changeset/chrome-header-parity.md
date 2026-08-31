---
"@apifuse/provider-sdk": major
---

Make the stealth transport's HTTP/2 header layer match captured Chrome ordering for navigation, fetch/XHR, and JSON POST requests on Windows, macOS, and Linux.

This is breaking: version-pinned browser profile names now throw in favor of intent profiles; Chrome adds the `chrome-windows`, `chrome-macos`, and `chrome-linux` intents; fingerprint headers are transport-owned and reject caller overrides; request profile overrides move from `profile` to `stealth.profile`; and client-wide browser, OS, and Accept-Language defaults live under the `stealth` options namespace. Provider-owned content headers remain ordinary fetch `headers`, with their values preserved and positions controlled by the SDK.
