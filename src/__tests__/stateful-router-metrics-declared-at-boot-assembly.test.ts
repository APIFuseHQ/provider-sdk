import { afterAll, describe, expect, it } from "bun:test";
import { z } from "zod";

import { PROVIDER_METRICS_ROUTE } from "../server/provider-metrics.js";
import {
	type ProviderServerHandle,
	type ProviderServerOperationExecutor,
	serve,
} from "../server/serve.js";
import {
	buildSessionKey,
	createStatefulOwnerFenceValidator,
	HttpStatefulOwnerForwarder,
	InMemorySessionOwnerRegistry,
	type StatefulProviderAdapter,
	StatefulProviderSessionManager,
	StatefulSessionRouter,
	statefulForwardingContextFromProviderRequest,
	withStatefulLocalProviderContext,
} from "../stateful/index.js";
import { statefulProviderMetricRegistry } from "../stateful/stateful-provider-metric-registry.js";
import type { ProviderDefinition } from "../types.js";

// An owner pod and a source pod started with serve() the way a provider's
// serving runtime composes the SDK: each pod's operation executor (and the
// owner's internal executor) hands every operation to the pod's real
// StatefulSessionRouter over a real StatefulProviderSessionManager, with the
// SDK's signed HttpStatefulOwnerForwarder and owner-fence validator between
// the pods and one in-memory owner registry in place of the control plane.
// No router is given a metricEmitter, so they count into the process-wide
// registry both pods' metrics listeners render. The routing counters of the
// provider's declared operations must be on the listener at zero before any
// operation is routed, and the first routed operation must raise those same
// series instead of creating new ones: a series that first appears with its
// first increment hides that increment from Prometheus rate().
const PROVIDER_ID = "router-metrics-declared-at-boot";
const ROUTED_OPERATION = "send-message";
const IDLE_OPERATION = "read-messages";
const PLAIN_PROVIDER_ID = "router-metrics-plain-handlers";
const FORWARDING_SECRET = "router-metrics-declared-at-boot-forwarding-secret";

const FORWARD = "apifuse_stateful_provider_routing_forward_total";
const LOCAL = "apifuse_stateful_provider_routing_local_total";
const REACQUIRE = "apifuse_stateful_provider_routing_reacquire_total";
const DEADLINE = "apifuse_stateful_provider_routing_deadline_expired_total";
const ROUTING = [FORWARD, LOCAL, REACQUIRE, DEADLINE] as const;

function operation() {
	return {
		riskClass: "read" as const,
		input: z.object({}),
		output: z.object({ ok: z.boolean() }),
		handler: async () => ({ ok: true }),
	};
}

const provider: ProviderDefinition = {
	id: PROVIDER_ID,
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Router Metrics Declared At Boot",
		descriptionKey: "router-metrics-declared-at-boot.description",
		category: "test",
	},
	operations: { [ROUTED_OPERATION]: operation(), [IDLE_OPERATION]: operation() },
};

// A provider served without an executor: its declared handlers run in place
// and no router ever sees its operations.
const plainProvider: ProviderDefinition = {
	...provider,
	id: PLAIN_PROVIDER_ID,
	meta: { ...provider.meta, descriptionKey: "router-metrics-plain-handlers.description" },
};

const sessionKey = buildSessionKey({
	providerId: PROVIDER_ID,
	serviceAccountId: "account-1",
	connectionId: "connection-1",
});

type EchoSession = { readonly podId: string };

// The provider's session layer: one session per key whose operations answer
// at once.
function echoAdapter(podId: string): StatefulProviderAdapter<EchoSession> {
	return {
		providerId: PROVIDER_ID,
		policy: { concurrency: { mode: "serialize" }, reconnect: "recreate" },
		connect: async () => ({ podId }),
		invoke: async () => ({ output: { ok: true } }),
		close: async () => {},
	};
}

type Pod = {
	readonly podId: string;
	readonly endpoint: string;
	readonly metricsEndpoint: string;
	readonly handle: ProviderServerHandle;
	readonly router: StatefulSessionRouter;
	readonly manager: StatefulProviderSessionManager<EchoSession>;
};

const owners = new InMemorySessionOwnerRegistry();

async function startPod(podId: string, role: "owner" | "source"): Promise<Pod> {
	const manager = new StatefulProviderSessionManager({
		adapter: echoAdapter(podId),
		poolPolicy: { maxSessions: 10, idleTimeoutMs: "unlimited", maxLifetimeMs: "unlimited" },
	});
	let router: StatefulSessionRouter | undefined;
	const execute: ProviderServerOperationExecutor = async ({ ctx, request, operationId }) => {
		if (!router) throw new Error(`${podId} received an operation before its router was wired`);
		const result = await router.route({
			requestId: request.requestId,
			sessionKey,
			providerId: PROVIDER_ID,
			operationId,
			connectionId: "connection-1",
			serviceAccountId: "account-1",
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
		...(role === "owner"
			? {
					internalOperationExecutor: execute,
					statefulForwarding: {
						secret: FORWARDING_SECRET,
						validateOwnerFence: createStatefulOwnerFenceValidator(owners),
					},
				}
			: {}),
		shutdown: { signals: false },
	});
	const endpoint = `http://127.0.0.1:${handle.port}`;
	router = new StatefulSessionRouter({
		currentPod: { podId, endpoint },
		registry: owners,
		forwarder: new HttpStatefulOwnerForwarder({ currentPodId: podId, secret: FORWARDING_SECRET }),
		executor: manager,
		leaseDurationMs: 30_000,
	});
	return {
		podId,
		endpoint,
		metricsEndpoint: `http://127.0.0.1:${handle.metricsPort}`,
		handle,
		router,
		manager,
	};
}

const owner = await startPod("pod-owner", "owner");
const source = await startPod("pod-source", "source");
const plain = await serve(plainProvider, {
	host: "127.0.0.1",
	port: 0,
	metricsPort: 0,
	logger: () => {},
	shutdown: { signals: false },
});
await owners.acquire({
	sessionKey,
	ownerPodId: owner.podId,
	ownerEndpoint: owner.endpoint,
	leaseDurationMs: 60_000,
});

afterAll(async () => {
	await plain.close({ timeoutMs: 5_000 });
	for (const pod of [source, owner]) {
		await pod.handle.close({ timeoutMs: 5_000 });
		await pod.router.release();
		await pod.manager.closeAll("test-complete");
	}
});

async function scrape(metricsEndpoint: string): Promise<string> {
	const response = await fetch(`${metricsEndpoint}${PROVIDER_METRICS_ROUTE}`);
	expect(response.status).toBe(200);
	return response.text();
}

// Every routing counter sample line of one provider, in render order.
function routingSamples(body: string, providerId: string): string[] {
	return body
		.split("\n")
		.filter(
			(line) =>
				ROUTING.some((name) => line.startsWith(`${name}{`)) &&
				line.includes(`providerId="${providerId}"`),
		);
}

function series(name: string, operationId: string, value: number): string {
	const errorCode = name === DEADLINE ? ',redactedErrorCode="deadline_expired"' : "";
	return `${name}{providerId="${PROVIDER_ID}",operationId="${operationId}"${errorCode}} ${value}`;
}

describe("routing counters declared at zero when serve() starts", () => {
	it("exports every declared operation's routing counters at zero before any operation is routed", async () => {
		const body = await scrape(owner.metricsEndpoint);
		expect(routingSamples(body, PROVIDER_ID)).toEqual([
			series(FORWARD, IDLE_OPERATION, 0),
			series(FORWARD, ROUTED_OPERATION, 0),
			series(LOCAL, IDLE_OPERATION, 0),
			series(LOCAL, ROUTED_OPERATION, 0),
			series(REACQUIRE, IDLE_OPERATION, 0),
			series(REACQUIRE, ROUTED_OPERATION, 0),
			series(DEADLINE, IDLE_OPERATION, 0),
			series(DEADLINE, ROUTED_OPERATION, 0),
		]);
		// Both pods declared the same operations into the one process registry:
		// the second declaration added nothing, and both listeners agree.
		expect(await scrape(source.metricsEndpoint)).toBe(body);
	});

	it("raises the declared series on the first routed operation without adding a series", async () => {
		// Back to the boot state: the declared series stay, at zero.
		statefulProviderMetricRegistry.reset();
		expect(routingSamples(await scrape(owner.metricsEndpoint), PROVIDER_ID)).toHaveLength(8);

		// A gateway caller of the source pod: its router forwards to the owner
		// pod, whose router runs the operation locally.
		const response = await fetch(`${source.endpoint}/v1/${ROUTED_OPERATION}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "first-routed-operation", input: {} }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ data: { ok: true } });

		expect(routingSamples(await scrape(owner.metricsEndpoint), PROVIDER_ID)).toEqual([
			series(FORWARD, IDLE_OPERATION, 0),
			series(FORWARD, ROUTED_OPERATION, 1),
			series(LOCAL, IDLE_OPERATION, 0),
			series(LOCAL, ROUTED_OPERATION, 1),
			series(REACQUIRE, IDLE_OPERATION, 0),
			series(REACQUIRE, ROUTED_OPERATION, 0),
			series(DEADLINE, IDLE_OPERATION, 0),
			series(DEADLINE, ROUTED_OPERATION, 0),
		]);
	});

	it("declares nothing for a server that runs its declared handlers itself", async () => {
		const response = await fetch(`http://127.0.0.1:${plain.port}/v1/${ROUTED_OPERATION}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "plain-handler-operation", input: {} }),
		});
		expect(response.status).toBe(200);
		const body = await scrape(`http://127.0.0.1:${plain.metricsPort}`);
		expect(body).not.toContain(`providerId="${PLAIN_PROVIDER_ID}"`);
		expect(routingSamples(body, PROVIDER_ID)).toHaveLength(8);
	});
});
