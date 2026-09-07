---
"@apifuse/provider-sdk": patch
---

Classify an unparsable `ctx.stealth` request URL as `transport_invalid_url` instead of `transport_network_error`.

When the caller-supplied `baseUrl`/`url` pair cannot be parsed (for example an options object passed where `baseUrl: string` is expected), the error is a programming fault, not a transport condition. It now throws `TransportError` with the fixed message `Invalid request URL`, the runtime `TypeError` in `cause`, and `category: "provider_error"`, `retryable: false`, so it is neither retried by the stealth transport retry policy nor attributed to the upstream. Malformed upstream redirect targets are unaffected and still classify as `transport_network_error`. Providers that branch on `transport_network_error` for these calls will now see `transport_invalid_url`; the HTTP status mapping (502) is unchanged.
