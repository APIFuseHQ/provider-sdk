---
"@apifuse/provider-sdk": major
---

Make the provider engine remote-only for `serve`, `dev`, and `record`, authenticated by the required workspace API key. Add the authenticated `provider-engine.v1` client and trace-stream contracts, typed protocol/authentication/egress errors, explicit provider-secret issuers, and the widened engine-owned credential boundary; remove the in-process engine constructor from the public API.
