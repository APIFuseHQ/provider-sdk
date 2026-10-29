---
"@apifuse/provider-sdk": major
---

A stateful request that waits in the session manager's queue now leaves the queue when its signal aborts, and the request's own abort no longer closes the pooled session.

`StatefulProviderSessionManager` serializes a session's operations (`concurrency: { mode: "serialize" }`) or bounds them (`{ mode: "parallel", maxInFlight }`), but the wait did not look at the request's signal. A request queued behind a long read was answered only when that read finished, not at its own deadline: on the owner pod the router's deadline timer aborted the signal, and the request still waited for its turn. When the turn came, the session manager re-checked ownership with the aborted signal, the registry failed with the abort, and the manager treated that like a lost owner: it invalidated the pooled session (the adapter's `close` ran, so for KakaoTalk the LOCO socket was closed) and marked the error as an establishment failure, so the router released the owner lease. The next request had to connect and log in again.

- `PodLocalSessionPool.runExclusive(sessionKey, task, signal?)` takes the caller's signal. An already aborted signal is rejected with its reason without queueing; an abort while waiting rejects at once with the reason; a task whose signal is aborted by the time its turn comes never starts. A task that has started runs to its end. The tasks queued after an aborted one keep their order and still start only after the tasks before it have settled. The abort listener is removed when the turn comes. Without a signal nothing changes.
- The session manager passes the request's signal to that wait for `invoke`, `health` and `reconcileWrite`, and its `maxInFlight` wait follows the same rules. A finishing operation now hands its slot straight to the next waiter, so an operation arriving after a woken waiter started no longer runs next to it beyond `maxInFlight`.
- The ownership re-check of a pooled session rethrows a failure whose cause chain holds the request's own abort reason (both SDK registries fail an aborted call that way) without invalidating the session and without the establishment mark. A reason that is not an object (`abort(null)`) counts only when it is the thrown value itself. Any other re-check failure, including an ownership change that coincides with the abort, still closes the session and releases the lease.
- A JavaScript caller that leaves the signal out of `invoke`, `health` or `reconcileWrite` keeps the previous behaviour: the wait ignores it and a failed re-check closes the session.

On the owner pod a request whose deadline expires in the queue is answered at its deadline with the same `504 STATEFUL_FORWARDING_DEADLINE_EXPIRED` as before, with the abort reason as the logged cause, and the session and the lease stay. A caller of the session manager without the router now gets the signal's reason when its request is aborted in the queue, instead of whatever the adapter threw when the request reached it.

The API report changes on `runExclusive` (a new optional parameter, so existing calls compile unchanged) and adds the `@internal` test accessor `parallelLimiterCountForTesting`.
