---
"@apifuse/provider-sdk": patch
---

Serve answers with the stateful forwarding deadline only for a deadline the SDK itself detected.

`StatefulRoutingDeadlineError` is exported from `@apifuse/provider-sdk/stateful`, and serve used to recognize it with `instanceof`. A provider that constructed one and threw it from an operation handler, or a provider-supplied `StatefulOwnerForwarder` that threw one to the session router, therefore got the APIFuse-owned deadline outcome: `504`, code `STATEFUL_FORWARDING_DEADLINE_EXPIRED`, category `timeout`, source `apifuse`, `retryable: false`. On the owner pod that answer was also relayed to the source pod, whose router turned it into the same outcome there.

Serve now gives that outcome only to an error the SDK raised itself: the session router's deadline check before routing, its forwarding-deadline conversion, and the owner route's deadline checks and mid-operation conversion. The SDK records each error it raises in a module-private registry that no entry point exports, and serve consults that registry instead of the error's class, so nothing a provider constructs or copies is recognized, whatever it carries. A `StatefulRoutingDeadlineError` a provider constructed is served like any other error the provider threw that serve does not recognize: `500 internal_error` with the masked body naming `errorClass: "StatefulRoutingDeadlineError"`, category `internal_error`, `retryable: false`.

A deadline the SDK detects is served exactly as before on both pods. No public API changes: `StatefulRoutingDeadlineError` keeps its constructor and stays exported.
