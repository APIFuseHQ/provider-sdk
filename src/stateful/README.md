# Stateful module compatibility note

The `@apifuse/provider-sdk/stateful` entry point is new and unreleased. Its initial contract includes
the following compatibility-sensitive behavior:

- Session identifiers use the branded `SessionKey` returned by `buildSessionKey` or
  `parseSessionKey`. Registry inputs, routing requests, event owner fences, and release APIs no
  longer accept arbitrary strings. A decoded `SessionOwnerRecord.sessionKey` remains a string and
  must be checked against the request's branded key at trust boundaries.
- Adapters declare `policy.concurrency` (`serialize` or bounded/unbounded `parallel`) and
  `policy.reconnect` (`resume`, `recreate`, or `unsupported`). `restore`, `snapshot`, and `health`
  are optional; a declared `snapshot` must be paired with the manager's `checkpointStore`.
- Provider-pod code publishes through `ProviderEventPublisher`; durable platform code implements
  `ProviderEventPipeline`. An adapter's `subscribe(ctx, session, publish)` callback accepts only an
  event. The session manager, not the adapter, binds the current authoritative
  `{ sessionKey, generation, ownerPodId, ownerEndpoint }` fence before calling the publisher.
  Adapters must not construct or cache owner fences themselves.
- `subscribe` must return a disposer. The manager runs it before checkpointing and closing a
  session. `health()` and `reconcileWrite()` use the same per-session concurrency scheduler and
  optional ownership validation semantics as invocation.
- `HttpProviderEventEmitter.flush(timeoutMs)` resolves to
  `{ delivered: number, failed: number, pending: number }`. Counts are cumulative for the emitter's
  lifetime; `pending` is the buffer remaining when the flush returns.
- `serve()` resolves to a `ProviderServerHandle` with `port` and idempotent `close({ timeoutMs? })`.
  Close stops listeners, runs shutdown hooks in declaration order, and enforces the configured
  timeout. Signal-enabled handles share one process handler per signal; a signal closes every
  registered server before it is re-raised. Closing the last handle removes the shared handlers.
- `ProviderServerStatefulForwardEnvelope` is strict. Its owner fence is flattened into
  `sessionKey`, `ownerPodId`, and `generation`; a nested `owner` object is not accepted. The
  envelope also carries operation/session identity, `sourcePodId`, `forwardedAt`, optional
  `idempotencyKey`, optional ISO `deadlineAt`, and the nested `operationRequest`. Unknown or
  malformed fields fail closed, and the owner-side executor receives `deadlineAt` on its request.
- Stateful forwarding is configured as a pair: `internalOperationExecutor` requires
  `statefulForwarding`, and `statefulForwarding` requires an `internalOperationExecutor`.
  `statefulForwarding` supplies the signing secret and `validateOwnerFence`; it may also set
  `maxSkewMs` and `replayCacheMaxEntries`. Replay-cache capacity returns HTTP 503 with
  `Retry-After` while retaining fail-closed nonce handling.
- Stateful signatures bind the method, route, timestamp, nonce, and exact body. Forwarding also
  rejects provider/source mismatches, stale owner fences, nonce replay, and request-scoped files.
