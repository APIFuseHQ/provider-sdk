# Stateful module compatibility note

The `@apifuse/provider-sdk/stateful` entry point is new and unreleased. Task C intentionally makes
the following breaking corrections before its first release:

- `StatefulProviderAdapter.capabilities` and `StatefulProviderCapability` were removed. Adapters now
  declare `policy.concurrency` (`serialize` or bounded/unbounded `parallel`) and `policy.reconnect`
  (`resume`, `recreate`, or `unsupported`).
- `restore`, `snapshot`, and `health` are optional. `connect` now receives
  `TSharedState | undefined`. A declared `snapshot` must be paired with the manager's
  `checkpointStore`; returned state is persisted instead of discarded.
- `handlePush` and `StatefulProviderPushEmit` were removed. `subscribe(ctx, session, publish)` now
  registers a connection-owned event source and must return a disposer; the manager requires a
  matching `eventPublisher` and runs the disposer during eviction/close.
- `reconcileWrite` is driven through the new public
  `StatefulProviderSessionManager.reconcileWrite(...)` runner. `health` is likewise caller-driven
  through `StatefulProviderSessionManager.health(...)`.
- `SessionPoolPolicy.absoluteMaxLifetimeMs` was renamed to `maxLifetimeMs`. Both `maxLifetimeMs` and
  `idleTimeoutMs` now accept `"unlimited"`.
- `StatefulProviderSessionContext.connectionId` and `serviceAccountId` are optional because direct
  pool sessions may not have either identity. Manager-created close/checkpoint contexts now carry
  their real connection, service-account, owner, and generation identity.
- `ProviderEvent.connectionId`, `serviceAccountId`, `subject`, and `occurredAt` are optional.
  `ProviderEventSubject.kind` is a documented provider-defined string rather than a fake literal
  union. Event redaction accepts provider-specific `redactionPatterns`; the default no longer
  destroys `device*` or `*uuid` fields.
- `StatefulSigningInput` now requires `method`, `path`, and `nonce`; signatures are bound to all
  three. `statefulSignedHeaders` requires `method` and `path`, generates a nonce when omitted, and
  emits `x-apifuse-stateful-nonce`.
- `ProviderServerStatefulForwardEnvelope` changed from `Record<string, unknown>` to a strict
  envelope containing operation/session identity, source pod, owner fence, forwarding timestamp,
  request/idempotency identity, and a nested operation request. Unknown or missing fields fail
  closed.
- `ProviderServerOptions.statefulForwarding` now requires `validateOwnerFence`; it also accepts a
  bounded `replayCacheMaxEntries`. Signed forwarding rejects provider/source mismatches, stale
  owner fences, nonce replay, and cross-route signatures before executing an operation.
