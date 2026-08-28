---
"@apifuse/provider-sdk": patch
---

Resolve same-file const bindings in submit-check source scanners.

Raw global fetch calls are now detected through const aliases, global object
members, computed access, comma-indirect calls, and globalThis destructuring
without flagging SDK HTTP paths or locally shadowed fetch bindings. Credential
persistence recognizes destructured and computed context access, public schema
computed keys and fixture timestamps resolve literal consts, and public-output
schema classification follows local output/response reachability. Secret-scan
remediation also derives environment names from assigned properties instead of
nearby type annotations.
