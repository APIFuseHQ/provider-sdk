---
"@apifuse/provider-sdk": major
---

Add the `akamai_sbsd` challenge kind and the engine-owned `hypersolutions`
resolver adapter, including its identity-bound transport protocol and
non-cacheable cookie-update outcome. Treat all hosted resolver API keys as
engine-owned credentials, reject provider-scoped Hyper aliases, and keep these
credentials out of provider environment projections.
