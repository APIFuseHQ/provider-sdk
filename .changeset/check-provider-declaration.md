---
"@apifuse/provider-sdk": minor
---

`apifuse check` now validates the root `provider.json` lifecycle declaration (closed schema, lifecycle enum, providerId cross-check against the package name when derivable), catching a broken or missing declaration in the provider's own CI before central discovery reads it. The provider scaffold template emits the file for new repositories.
