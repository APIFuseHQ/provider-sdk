# Stateful module compatibility note

The `@apifuse/provider-sdk/stateful` entry point is new and unreleased. Its initial contract includes
the following compatibility-sensitive behavior:

- Session identifiers use the branded `SessionKey` returned by `buildSessionKey`.
  `parseSessionKey` returns `SessionKeyParts`; validate and brand an external string with
  `buildSessionKey(parseSessionKey(value))`. Registry inputs, routing requests, event owner fences,
  and release APIs no longer accept arbitrary strings. A decoded `SessionOwnerRecord.sessionKey`
  remains a string and must be checked where external data enters trusted SDK code (a trust
  boundary).
- Adapters declare `policy.concurrency` (`serialize` or bounded/unbounded `parallel`) and
  `policy.reconnect` (`resume`, `recreate`, or `unsupported`). `restore`, `snapshot`, and `health`
  are optional; a declared `snapshot` must be paired with the manager's `checkpointStore`.
- Code in the process hosting the adapter (the provider pod) publishes through
  `ProviderEventPublisher`; persistent services that survive provider-pod restarts (durable
  platform code) implement `ProviderEventPipeline`. An adapter's
  `subscribe(ctx, session, publish)` callback accepts only an event. The session manager, not the
  adapter, binds the registry's current write authorization (the authoritative
  `{ sessionKey, generation, ownerPodId, ownerEndpoint }` fence) before calling the publisher.
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
- `serve()` also starts a metrics listener on a separate port, always on, serving only
  `GET /metrics` in the Prometheus text exposition format (`text/plain; version=0.0.4`). The port
  is `ServeOptions.metricsPort`, else `APIFUSE__PROVIDER_RUNTIME__METRICS_PORT`, else `9090`
  (`DEFAULT_PROVIDER_METRICS_PORT`); `0` binds an ephemeral port, and the handle's `metricsPort` is
  the bound one. Expose it to Prometheus as a Service port named `metrics`, so the primary port can
  keep admitting the gateway only. The listener renders one process-wide registry, which a
  `StatefulSessionRouter` built without a `metricEmitter` counts into, so the routing counters
  (`apifuse_stateful_provider_routing_*_total`) come out without wiring. A `serve()` given an
  `operationExecutor` or `internalOperationExecutor` starts the four routing counters of every
  declared operation at `0` before its listeners open, so the first scrape already has the series
  and Prometheus `rate()` counts the first routed operation; a server that runs its declared
  handlers itself declares none. A `StatefulProviderSessionManager` built without a
  `metricEmitter` counts into the same registry, so
  `apifuse_stateful_provider_session_operation_duration_ms` and
  `apifuse_stateful_provider_session_invalidations_total` (labelled `redactedErrorCode` with the
  adapter's `StatefulSessionInvalidatedError.reason`) come out without wiring too. Provider code
  that counts its own names from the closed set, such as a write ledger's
  `apifuse_stateful_provider_write_ledger_*_total`, passes the same registry,
  `statefulProviderMetricRegistry` from this entry point, as its components' `metricEmitter`. It is
  typed as a `StatefulProviderMetricEmitter` and exposes only `increment`, `gauge` and `observe`;
  it drops a call outside the closed set or the name's kind instead of throwing. Only the labels
  `providerId`, `operationId`, `redactedErrorCode`, `eventType`, `subjectKind`, `capacityClass`,
  `ledgerState` and `healthStatus` are exported; request, session, tenant, owner-pod and generation
  identifiers are dropped before storage, and Prometheus adds `pod` and `instance`. A process that
  calls `serve()` more than once (a test) gives each call its own `metricsPort`, such as `0`.
- `ProviderServerStatefulForwardEnvelope` is strict. Its owner fence is flattened into
  `sessionKey`, `ownerPodId`, and `generation`; a nested `owner` object is not accepted. The
  envelope also carries operation/session identity, `sourcePodId`, `forwardedAt`, optional
  `idempotencyKey`, optional ISO `deadlineAt`, and the nested `operationRequest`. Unknown or
  malformed fields fail closed, and the owner-side executor receives `deadlineAt` on its request.
  The nested `operationRequest.connection` is optional on both sides: a connectionless
  (`auth.mode: "none"`) operation is forwarded without one, never with a placeholder, and the owner
  keys its proxy affinity the way it keys a direct call without a connection (the provider id, or
  the provider and operation ids under operation affinity). The `operationRequest` itself is not
  optional: a forwarding context without one (`{ forwarding: {} }`) fails at the source with
  `STATEFUL_FORWARDING_CONTEXT_MISSING` instead of reaching the owner stripped of its connection,
  tenant scope, headers and trace.
- Stateful forwarding is configured as a pair: `internalOperationExecutor` requires
  `statefulForwarding`, and `statefulForwarding` requires an `internalOperationExecutor`.
  `statefulForwarding` supplies the signing secret and `validateOwnerFence`; it may also set
  `maxSkewMs` and `replayCacheMaxEntries`. Replay-cache capacity returns HTTP 503 with
  `Retry-After`; fail-closed nonce handling means invalid, replayed, or untrackable nonces are
  rejected instead of allowing an unverifiable request.
- Stateful signatures bind the method, route, timestamp, nonce, and exact body. Forwarding also
  rejects provider/source mismatches, stale owner fences, nonce replay, and request-scoped files.

## Minimal composition

Inside the module that defines your `provider`, the following wires an adapter, session manager,
router, signed owner forwarding, and graceful shutdown. Replace the environment variable names and
the service-account mapping with your deployment's values.

```ts
import {
	buildSessionKey,
	createStatefulOwnerFenceValidator,
	HttpSessionOwnerRegistry,
	HttpStatefulOwnerForwarder,
	parseSessionKey,
	statefulForwardingContextFromProviderRequest,
	StatefulProviderSessionManager,
	StatefulSessionRouter,
	type StatefulProviderAdapter,
	withStatefulLocalProviderContext,
} from "@apifuse/provider-sdk/stateful";
import { serve, type ProviderServerOperationExecutor } from "@apifuse/provider-sdk/server";

type Session = { closed: boolean };

const adapter = {
	providerId: provider.id,
	policy: { concurrency: { mode: "serialize" }, reconnect: "recreate" },
	connect: async () => ({ closed: false }),
	invoke: async (_ctx, _session, request) => ({ output: request.input }),
	close: async (_ctx, session) => {
		session.closed = true;
	},
} satisfies StatefulProviderAdapter<Session>;

const registry = new HttpSessionOwnerRegistry({
	baseUrl: process.env.STATEFUL_CONTROL_PLANE_URL as string,
	secret: process.env.STATEFUL_CONTROL_PLANE_SECRET as string,
});
const manager = new StatefulProviderSessionManager({
	adapter,
	poolPolicy: { maxSessions: 100, idleTimeoutMs: "unlimited", maxLifetimeMs: "unlimited" },
});
const currentPod = {
	podId: process.env.POD_ID as string,
	endpoint: process.env.POD_ENDPOINT as string,
};
const router = new StatefulSessionRouter({
	currentPod,
	registry,
	forwarder: new HttpStatefulOwnerForwarder({
		currentPodId: currentPod.podId,
		secret: process.env.STATEFUL_FORWARDING_SECRET as string,
	}),
	executor: manager,
	leaseDurationMs: 30_000,
});

const executeStateful: ProviderServerOperationExecutor = async ({
	ctx,
	request,
	operationId,
	internalStatefulForward,
}) => {
	const keyParts = internalStatefulForward
		? parseSessionKey(internalStatefulForward.sessionKey)
		: {
				providerId: provider.id,
				serviceAccountId: request.connection?.externalRef as string,
				connectionId: (request.connection?.id ?? request.connectionId) as string,
			};
	const result = await router.route({
		requestId: request.requestId,
		sessionKey: buildSessionKey(keyParts),
		providerId: provider.id,
		operationId,
		connectionId: keyParts.connectionId,
		serviceAccountId: keyParts.serviceAccountId,
		input: request.input,
		...(request.deadlineAt ? { deadlineAt: request.deadlineAt } : {}),
		runtimeContext: withStatefulLocalProviderContext(
			ctx,
			statefulForwardingContextFromProviderRequest(request),
		),
	});
	return result.output;
};

await serve(provider, {
	operationExecutor: executeStateful,
	internalOperationExecutor: executeStateful,
	statefulForwarding: {
		secret: process.env.STATEFUL_FORWARDING_SECRET as string,
		validateOwnerFence: createStatefulOwnerFenceValidator(registry),
	},
	shutdown: {
		hooks: [
			() => manager.closeAll("server-shutdown"),
			() => router.release(),
		],
	},
});
```
