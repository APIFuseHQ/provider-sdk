---
"@apifuse/provider-sdk": minor
---

Add the optional `tenantId` field to the operation request envelope (`OperationRequestSchema`) and expose it as `ctx.request.tenantId`. The gateway asserts it from the verified principal: the organization id for customer subjects, the service-account id for platform service accounts. It is `undefined` on direct calls and self-test, an empty string is normalised to `undefined` like `connectionId`, and caller headers never populate it. The value is added to the operator request-log correlation (`tenantId`, redacted like `connectionId`) for operations and stateful-forwarded operations, and `statefulForwardingContextFromProviderRequest` / `HttpStatefulOwnerForwarder` carry it to the owner pod; it does not change `ctx.state` scoping. Providers can key per-principal policy (for example a soft cap on outstanding public cursors via `compareAndSet`) on it for connectionless operations. Existing envelopes without the field are unaffected.
