---
"@apifuse/provider-sdk": patch
---

Export the stateful session manager's metrics by default. A `StatefulProviderSessionManager` built without a `metricEmitter` now counts into the same process-wide registry the stateful router counts into, instead of the no-op emitter, so `apifuse_stateful_provider_session_operation_duration_ms` and `apifuse_stateful_provider_session_invalidations_total` reach the `serve()` metrics listener (`GET /metrics`) without any wiring. A session manager given an explicit `metricEmitter` keeps using it alone; metric names, labels and the event emitter's default are unchanged.
