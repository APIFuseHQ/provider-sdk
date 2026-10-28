---
"@apifuse/provider-sdk": patch
---

Add an adaptive proxy vendor selector behind the vendor selector seam.

`createAdaptiveProxyVendorSelector()` implements `ProxyVendorSelector` as a circuit breaker per vendor: the policy's `providers` order stays the preference order, a vendor whose attempts fail for reasons attributable to it (could not synthesize a proxy, tunnel never opened, proxy-level refusal, network error through the proxy) is skipped for a growing period after a run of consecutive failures, the next vendor serves meanwhile, and one probe attempt after the period decides whether the vendor returns. Cancellation, timeouts and delivered upstream statuses never count against a vendor (`classifyProxyVendorAttemptOutcome`). State is process-local and every threshold is an option with the cited library default. Nothing registers the selector yet: the process keeps the static order until `setProxyVendorSelector` is called, and `PROXY_VENDOR_SELECTION_ENV` with `resolveProxyVendorSelectionMode` name the switch for that step.
