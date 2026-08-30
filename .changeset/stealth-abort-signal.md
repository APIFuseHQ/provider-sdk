---
"@apifuse/provider-sdk": patch
---

Propagate each gateway request's abort signal through `ctx.stealth`, cancelling in-flight native stealth requests and response-body reads while preventing transport retries after the caller disconnects or its deadline expires.
