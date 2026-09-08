---
"@apifuse/provider-sdk": patch
---

Fail closed on the bound resolver transport's vendor host boundary (#285).

`ResolverVendorAdapter.transportAllowedHosts` is now validated against the
SDK-owned per-vendor table `RESOLVER_VENDOR_TRANSPORT_HOSTS`
(`src/runtime/resolver-vendors/hosts.ts`): today only `hypersolutions` owns a
host (`ip.hypersolutions.co`, its observed-IP reflector, per ADR-0008 v1.1);
every other vendor, including `custom`, owns none. A declaration outside its
vendor's entry throws `ProviderError` code `RESOLVER_VENDOR_HOST_NOT_ALLOWED`
from `createResolverClient` (supplied adapters) or from the first `solve`
(factory-built adapters), before any transport call. The restricted transport
handed to an adapter's `solve` is revoked when `solve` settles: a retained
reference fails `fetch` and `getCookie` with `RESOLVER_TRANSPORT_REVOKED`.

Behaviour change for callers of `createResolverClient` that supply adapters
declaring hosts outside the table: the adapter is no longer admitted. Route
such calls through the provider's declared `allowedHosts` (the only other
source of bound-transport hosts) or add the host to the SDK-owned table for that
vendor. Registry adapters are unaffected. No public type or signature changes.
