---
"@apifuse/provider-sdk": major
---

Proxy vendor fallback learns from failures: a served process routes around a vendor that keeps failing instead of spending that vendor's share of every request's attempts on it.

`createAdaptiveProxyVendorSelector()` implements `ProxyVendorSelector` as a circuit breaker per vendor: the policy's `providers` order stays the preference order, a vendor whose attempts fail for reasons attributable to it (could not synthesize a proxy, tunnel never opened, proxy-level refusal, network error through the proxy) is skipped for a growing period after a run of consecutive failures, the next vendor serves meanwhile, and one probe attempt after the period decides whether the vendor returns. Within one request, the attempt after a failure of the vendor moves to another closed vendor (`retry_alternate`) on a session no earlier attempt of the request used. Cancellation, timeouts and delivered upstream statuses never count against a vendor (`classifyProxyVendorAttemptOutcome`). State is process-local and every threshold is an option with the cited library default.

`serve()` registers it for the process. `APIFUSE__PROXY__VENDOR_SELECTION=ordered` (`PROXY_VENDOR_SELECTION_ENV`) keeps the static declaration order, and a selector the host registered with `setProxyVendorSelector` is never replaced. Every state transition logs one `proxy_vendor_state` line (`warn` when a vendor is opened). The request's proxy telemetry, in the log and in the telemetry header (envelope version unchanged), gains `selection` (`{ kind, reason }`), `vendorStates` (`[{ v, s, e }]`) and the vendor `v` of every attempt sample. No provider policy changes.
