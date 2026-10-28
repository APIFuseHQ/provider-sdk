import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";

import type {
	OperationConnection,
	ProviderServerHandle,
	ProviderServerOperationExecutor,
	ProviderServerOperationExecutorInput,
} from "../server/index.js";
import type {
	SessionKeyParts,
	SessionOwnerRegistry,
	StatefulProviderAdapter,
	StatefulSessionRouter as StatefulSessionRouterType,
} from "../stateful/index.js";
import type { ProviderDefinition } from "../types.js";

// Two provider pods assembled from the built SDK artifact, the way a provider
// image consumes the package: serve() listeners on loopback, the documented
// stateful composition (session manager, router, signed HTTP owner forwarder)
// on each pod, and one owner registry shared between them in place of the
// control plane. Nothing on the forwarding path is replaced: the non-owner pod
// reaches the owner over real HTTP through the owner's signed internal route.
const builtServerSpecifier: string = "../../dist/server/serve.js";
const builtServer: Promise<typeof import("../server/serve.js")> = import(builtServerSpecifier);
const { resolveProviderProxyAffinityKey, serve } = await builtServer;

const builtStatefulSpecifier: string = "../../dist/stateful/index.js";
const builtStateful: Promise<typeof import("../stateful/index.js")> = import(
	builtStatefulSpecifier
);
const {
	buildSessionKey,
	createStatefulOwnerFenceValidator,
	HttpStatefulOwnerForwarder,
	InMemorySessionOwnerRegistry,
	parseSessionKey,
	StatefulOwnerForwardingError,
	StatefulProviderSessionManager,
	StatefulSessionRouter,
	statefulForwardingContextFromProviderRequest,
	withStatefulLocalProviderContext,
} = await builtStateful;

const PROVIDER_ID = "two-pod-watch-provider";
const OPERATION_ID = "watch";
const FORWARDING_SECRET = "two-pod-assembly-forwarding-secret";
const STATEFUL_ROUTE = "/__apifuse/stateful/operations";

const WatchInputSchema = z.object({ trackingNumber: z.string() });
const WatchOutputSchema = z.object({
	trackingNumber: z.string(),
	servedBy: z.string(),
	invocation: z.number(),
});

const provider: ProviderDefinition = {
	allowedHosts: ["example.com"],
	reviewed: "community",
	id: PROVIDER_ID,
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Two Pod Watch Provider",
		descriptionKey: "providers.twoPodWatch.description",
		category: "test",
	},
	operations: {
		[OPERATION_ID]: {
			riskClass: "read",
			input: WatchInputSchema,
			output: WatchOutputSchema,
			handler: async () => {
				throw new Error("watch is served by the stateful runtime, not the plain handler");
			},
		},
	},
};

type WatchSession = { readonly podId: string; invocations: number };

type ForwardedBody = { readonly url: string; readonly rawBody: string };

type Pod = {
	readonly podId: string;
	readonly endpoint: string;
	readonly router: StatefulSessionRouterType;
	/** Every operation this pod's serve() handed to its executors, in arrival order. */
	readonly executions: ProviderServerOperationExecutorInput[];
	/** Raw bodies this pod's owner forwarder put on the wire. */
	readonly forwardedBodies: ForwardedBody[];
	/** Sessions this pod's adapter connected. */
	readonly connectedSessionKeys: string[];
	readonly handle: ProviderServerHandle;
};

const startedPods: Pod[] = [];

afterEach(async () => {
	const pods = startedPods.splice(0);
	await Promise.all(pods.map((pod) => pod.handle.close({ timeoutMs: 5_000 })));
});

function watchAdapter(
	podId: string,
	connectedSessionKeys: string[],
): StatefulProviderAdapter<WatchSession> {
	return {
		providerId: PROVIDER_ID,
		policy: { concurrency: { mode: "serialize" }, reconnect: "recreate" },
		connect: async (ctx) => {
			connectedSessionKeys.push(ctx.sessionKey);
			return { podId, invocations: 0 };
		},
		invoke: async (_ctx, session, request) => {
			session.invocations += 1;
			const input = WatchInputSchema.parse(request.input);
			return {
				output: {
					trackingNumber: input.trackingNumber,
					servedBy: session.podId,
					invocation: session.invocations,
				},
			};
		},
		close: async () => {},
	};
}

/**
 * Session identity: a connection-bearing call keys its session by the
 * connection (the README composition); a connectionless call keys it by its
 * input, as a parcel-tracking watch does. A forwarded call reuses the
 * source's key from the signed envelope.
 */
function sessionKeyParts(
	request: ProviderServerOperationExecutorInput["request"],
): SessionKeyParts {
	const connection = request.connection;
	if (connection) {
		return {
			providerId: PROVIDER_ID,
			serviceAccountId: connection.externalRef,
			connectionId: connection.id,
		};
	}
	const { trackingNumber } = WatchInputSchema.parse(request.input);
	return {
		providerId: PROVIDER_ID,
		serviceAccountId: "connectionless",
		connectionId: `watch-${trackingNumber}`,
	};
}

async function startPod(
	podId: string,
	registry: SessionOwnerRegistry,
	options: { readonly forwarderClock?: () => Date } = {},
): Promise<Pod> {
	const executions: ProviderServerOperationExecutorInput[] = [];
	const forwardedBodies: ForwardedBody[] = [];
	const connectedSessionKeys: string[] = [];
	const manager = new StatefulProviderSessionManager({
		adapter: watchAdapter(podId, connectedSessionKeys),
		poolPolicy: { maxSessions: 10, idleTimeoutMs: "unlimited", maxLifetimeMs: "unlimited" },
	});
	let router: StatefulSessionRouterType | undefined;

	const execute: ProviderServerOperationExecutor = async (input) => {
		executions.push(input);
		const { ctx, request, operationId, internalStatefulForward } = input;
		if (!router) throw new Error(`${podId} received an operation before its router was wired`);
		const keyParts = internalStatefulForward
			? parseSessionKey(internalStatefulForward.sessionKey)
			: sessionKeyParts(request);
		const result = await router.route({
			requestId: request.requestId,
			sessionKey: buildSessionKey(keyParts),
			providerId: PROVIDER_ID,
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

	const handle = await serve(provider, {
		host: "127.0.0.1",
		port: 0,
		metricsPort: 0,
		logger: () => {},
		operationExecutor: execute,
		internalOperationExecutor: execute,
		statefulForwarding: {
			secret: FORWARDING_SECRET,
			validateOwnerFence: createStatefulOwnerFenceValidator(registry),
		},
		shutdown: {
			signals: false,
			hooks: [
				() => manager.closeAll("server-shutdown"),
				async () => {
					await router?.release();
				},
			],
		},
	});
	const endpoint = `http://127.0.0.1:${handle.port}`;
	router = new StatefulSessionRouter({
		currentPod: { podId, endpoint },
		registry,
		forwarder: new HttpStatefulOwnerForwarder({
			currentPodId: podId,
			secret: FORWARDING_SECRET,
			// A tap, not a double: it records the bytes and sends them through
			// the real fetch to the owner pod's listener.
			fetch: async (url, init) => {
				forwardedBodies.push({ url: String(url), rawBody: String(init?.body) });
				return fetch(url, init);
			},
			...(options.forwarderClock ? { clock: options.forwarderClock } : {}),
		}),
		executor: manager,
		leaseDurationMs: 30_000,
	});
	const pod: Pod = {
		podId,
		endpoint,
		router,
		executions,
		forwardedBodies,
		connectedSessionKeys,
		handle,
	};
	startedPods.push(pod);
	return pod;
}

async function callWatch(
	pod: Pod,
	body: {
		readonly requestId: string;
		readonly trackingNumber: string;
		readonly connection?: OperationConnection;
	},
): Promise<{ readonly status: number; readonly body: unknown }> {
	const response = await fetch(`${pod.endpoint}/v1/${OPERATION_ID}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			requestId: body.requestId,
			input: { trackingNumber: body.trackingNumber },
			...(body.connection ? { connection: body.connection } : {}),
		}),
	});
	return { status: response.status, body: await response.json() };
}

function forwardedExecutions(pod: Pod): ProviderServerOperationExecutorInput[] {
	return pod.executions.filter((execution) => execution.internalStatefulForward !== undefined);
}

function onlyItem<T>(items: readonly T[], label: string): T {
	expect(items).toHaveLength(1);
	const [item] = items;
	if (item === undefined) throw new Error(`Expected exactly one ${label}`);
	return item;
}

const credentialConnection: OperationConnection = {
	id: "connection-1",
	mode: "credentials",
	secrets: { token: "two-pod-secret-token" },
	scopes: ["parcel:read"],
	metadata: { plan: "standard" },
	externalRef: "account-1",
};

describe("stateful forwarding across two served pods", () => {
	it("forwards a connectionless operation from a non-owner pod to the owner and answers 200", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		const owner = await startPod("pod-a", registry);
		const nonOwner = await startPod("pod-b", registry);

		const first = await callWatch(owner, { requestId: "req-owner", trackingNumber: "T-100" });
		expect(first).toEqual({
			status: 200,
			body: { data: { trackingNumber: "T-100", servedBy: "pod-a", invocation: 1 } },
		});

		const forwarded = await callWatch(nonOwner, {
			requestId: "req-non-owner",
			trackingNumber: "T-100",
		});
		expect(forwarded).toEqual({
			status: 200,
			body: { data: { trackingNumber: "T-100", servedBy: "pod-a", invocation: 2 } },
		});

		// The non-owner never opened the session; it put one envelope on the
		// wire, to the owner's internal route, and that envelope has no
		// connection at all rather than a synthesized placeholder.
		expect(nonOwner.connectedSessionKeys).toEqual([]);
		expect(owner.connectedSessionKeys).toHaveLength(1);
		const wire = onlyItem(nonOwner.forwardedBodies, "forwarded body");
		expect(wire.url).toBe(`${owner.endpoint}${STATEFUL_ROUTE}`);
		const envelope = z
			.object({
				sourcePodId: z.string(),
				ownerPodId: z.string(),
				operationRequest: z.record(z.string(), z.unknown()),
			})
			.parse(JSON.parse(wire.rawBody));
		expect(envelope.sourcePodId).toBe("pod-b");
		expect(envelope.ownerPodId).toBe("pod-a");
		expect(Object.hasOwn(envelope.operationRequest, "connection")).toBe(false);
		expect(Object.hasOwn(envelope.operationRequest, "connectionId")).toBe(false);

		// The owner executed the forwarded call without a connection, so its
		// proxy affinity falls back to the provider id: the same key the owner's
		// own connectionless call got, never "".
		const local = onlyItem(
			owner.executions.filter((execution) => execution.internalStatefulForward === undefined),
			"local owner execution",
		);
		const remote = onlyItem(forwardedExecutions(owner), "forwarded owner execution");
		expect(remote.internalStatefulForward?.sourcePodId).toBe("pod-b");
		expect(Object.hasOwn(remote.request, "connection")).toBe(false);
		expect(remote.ctx.request?.connectionId).toBeUndefined();
		expect(resolveProviderProxyAffinityKey(provider, remote.request, OPERATION_ID)).toBe(
			PROVIDER_ID,
		);
		expect(resolveProviderProxyAffinityKey(provider, local.request, OPERATION_ID)).toBe(
			PROVIDER_ID,
		);
	});

	it("forwards a connection-bearing operation with the same envelope bytes and affinity key as before", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		const forwardedAt = new Date();
		const owner = await startPod("pod-a", registry);
		const nonOwner = await startPod("pod-b", registry, { forwarderClock: () => forwardedAt });

		const first = await callWatch(owner, {
			requestId: "req-owner",
			trackingNumber: "T-200",
			connection: credentialConnection,
		});
		expect(first.status).toBe(200);

		// Over HTTP ingress: the owner receives the connection unchanged and
		// keys affinity by its id, exactly like its own local call.
		const viaIngress = await callWatch(nonOwner, {
			requestId: "req-non-owner",
			trackingNumber: "T-200",
			connection: credentialConnection,
		});
		expect(viaIngress).toEqual({
			status: 200,
			body: { data: { trackingNumber: "T-200", servedBy: "pod-a", invocation: 2 } },
		});
		const local = onlyItem(
			owner.executions.filter((execution) => execution.internalStatefulForward === undefined),
			"local owner execution",
		);
		const remote = onlyItem(forwardedExecutions(owner), "forwarded owner execution");
		expect(remote.request.connection).toEqual(credentialConnection);
		expect(remote.ctx.request?.connectionId).toBe("connection-1");
		expect(resolveProviderProxyAffinityKey(provider, remote.request, OPERATION_ID)).toBe(
			"connection-1",
		);
		expect(resolveProviderProxyAffinityKey(provider, local.request, OPERATION_ID)).toBe(
			"connection-1",
		);

		// Through the non-owner's router with fixed metadata, the bytes on the
		// wire are pinned literally: same keys, same order, connection in its
		// historical position between input and headers.
		const sessionKey = buildSessionKey({
			providerId: PROVIDER_ID,
			serviceAccountId: "account-1",
			connectionId: "connection-1",
		});
		const ownerRecord = await registry.resolve(sessionKey);
		if (!ownerRecord) throw new Error("Expected pod-a to own the connection session");
		const pinned = await nonOwner.router.route({
			requestId: "req-pinned",
			sessionKey,
			providerId: PROVIDER_ID,
			operationId: OPERATION_ID,
			connectionId: "connection-1",
			serviceAccountId: "account-1",
			input: { trackingNumber: "T-200" },
			runtimeContext: withStatefulLocalProviderContext(
				undefined,
				statefulForwardingContextFromProviderRequest({
					requestId: "req-pinned",
					connection: credentialConnection,
					headers: { "x-request-source": "two-pod-assembly" },
				}),
			),
		});
		expect(pinned).toEqual({
			output: { trackingNumber: "T-200", servedBy: "pod-a", invocation: 3 },
		});
		const wire = nonOwner.forwardedBodies.at(-1);
		expect(wire?.rawBody).toBe(
			`{"requestId":"req-pinned","providerId":"${PROVIDER_ID}","operationId":"watch",` +
				`"sessionKey":"${sessionKey}","connectionId":"connection-1","serviceAccountId":"account-1",` +
				`"sourcePodId":"pod-b","forwardedAt":"${forwardedAt.toISOString()}",` +
				`"ownerPodId":"pod-a","generation":${ownerRecord.generation},` +
				`"operationRequest":{"requestId":"req-pinned","input":{"trackingNumber":"T-200"},` +
				`"connection":{"id":"connection-1","mode":"credentials","secrets":{"token":"two-pod-secret-token"},` +
				`"scopes":["parcel:read"],"metadata":{"plan":"standard"},"externalRef":"account-1"},` +
				`"headers":{"x-request-source":"two-pod-assembly"}}}`,
		);
	});

	it("rejects a forwarding context without its operationRequest at the source and keeps forwarding well-formed calls", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		const owner = await startPod("pod-a", registry);
		const nonOwner = await startPod("pod-b", registry);

		const first = await callWatch(owner, { requestId: "req-owner", trackingNumber: "T-300" });
		expect(first.status).toBe(200);
		const keyParts = {
			providerId: PROVIDER_ID,
			serviceAccountId: "connectionless",
			connectionId: "watch-T-300",
		};
		const sessionKey = buildSessionKey(keyParts);
		const ownerRecord = await registry.resolve(sessionKey);
		expect(ownerRecord?.ownerPodId).toBe("pod-a");

		// Each context is type-valid or reachable from an untyped consumer, and
		// each lacks the request context that the connection, tenant scope,
		// headers and trace come from. None may reach the owner as a
		// connectionless call.
		const contextsWithoutOperationRequest: ReadonlyArray<readonly [string, unknown]> = [
			["forwarding: {}", { forwarding: {} }],
			["local context with empty forwarding", withStatefulLocalProviderContext(undefined, {})],
			["forwarding.operationRequest: null", { forwarding: { operationRequest: null } }],
		];
		for (const [label, runtimeContext] of contextsWithoutOperationRequest) {
			const error = await nonOwner.router
				.route({
					requestId: `req-missing-${label}`,
					sessionKey,
					providerId: PROVIDER_ID,
					operationId: OPERATION_ID,
					connectionId: keyParts.connectionId,
					serviceAccountId: keyParts.serviceAccountId,
					input: { trackingNumber: "T-300" },
					runtimeContext,
				})
				.then(
					() => undefined,
					(cause: unknown) => cause,
				);
			if (!(error instanceof StatefulOwnerForwardingError)) {
				throw new Error(`${label}: expected StatefulOwnerForwardingError, got ${String(error)}`);
			}
			expect(error.code).toBe("STATEFUL_FORWARDING_CONTEXT_MISSING");
			expect(error.message).toContain("operationRequest");
		}

		// Rejected at the source: nothing went on the wire and the owner's
		// internal route never ran.
		expect(nonOwner.forwardedBodies).toEqual([]);
		expect(forwardedExecutions(owner)).toEqual([]);
		expect(nonOwner.connectedSessionKeys).toEqual([]);

		// The same session still forwards a well-formed connectionless call.
		const forwarded = await callWatch(nonOwner, {
			requestId: "req-non-owner",
			trackingNumber: "T-300",
		});
		expect(forwarded).toEqual({
			status: 200,
			body: { data: { trackingNumber: "T-300", servedBy: "pod-a", invocation: 2 } },
		});
		expect(nonOwner.forwardedBodies).toHaveLength(1);
		const remote = onlyItem(forwardedExecutions(owner), "forwarded owner execution");
		expect(Object.hasOwn(remote.request, "connection")).toBe(false);
	});
});
