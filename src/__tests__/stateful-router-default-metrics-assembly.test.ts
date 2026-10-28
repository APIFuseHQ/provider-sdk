import { afterAll, describe, expect, it } from "bun:test";
import { z } from "zod";

import { TransportError } from "../errors.js";
import {
	PROVIDER_METRICS_CONTENT_TYPE,
	PROVIDER_METRICS_ROUTE,
} from "../server/provider-metrics.js";
import {
	type ProviderServerHandle,
	type ProviderServerLogEvent,
	type ProviderServerOperationExecutor,
	serve,
} from "../server/serve.js";
import {
	buildSessionKey,
	createStatefulOwnerFenceValidator,
	HttpStatefulOwnerForwarder,
	InMemorySessionOwnerRegistry,
	RecordingStatefulProviderMetricEmitter,
	STATEFUL_PROVIDER_METRIC_NAMES,
	type StatefulProviderAdapter,
	StatefulProviderSessionManager,
	StatefulRoutingDeadlineError,
	StatefulSessionRouter,
	statefulForwardingContextFromProviderRequest,
	withStatefulLocalProviderContext,
} from "../stateful/index.js";
import {
	STATEFUL_PROVIDER_METRIC_KINDS,
	statefulProviderMetricRegistry,
} from "../stateful/stateful-provider-metric-registry.js";
import type { ProviderDefinition } from "../types.js";

// An owner pod and a source pod started with serve(), the way a provider's
// serving runtime composes the SDK: each pod's operation executor and
// internal executor hand every operation to the pod's real
// StatefulSessionRouter over a real StatefulProviderSessionManager, with the
// SDK's signed HttpStatefulOwnerForwarder and owner-fence validator between
// the pods and one in-memory owner registry shared in place of the control
// plane. Neither router is given a metricEmitter: this is the composition the
// README, StatefulProviderRuntimeExecutor and the KakaoTalk serving runtime
// use, and what they count must come out of the pod's metrics listener. The
// only piece that is not the SDK's is the adapter's session read, which waits
// on the signal the session manager gives it, like a transport read the
// signal cancels.
const PROVIDER_ID = "router-default-metrics-assembly";
const OPERATION_ID = "read-until-cancelled";
const FORWARDING_SECRET = "router-default-metrics-assembly-forwarding-secret";
// The forwarded deadline. Generous, so forwarding, the owner fence and the
// session connect always finish before it even on a loaded machine.
const DEADLINE_MS = 1_500;
const DEADLINE_METRIC = "apifuse_stateful_provider_routing_deadline_expired_total";

const provider: ProviderDefinition = {
	allowedHosts: ["example.com"],
	reviewed: "community",
	id: PROVIDER_ID,
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Router Default Metrics Assembly",
		descriptionKey: "router-default-metrics-assembly.description",
		category: "test",
	},
	operations: {
		[OPERATION_ID]: {
			riskClass: "read" as const,
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			handler: async () => {
				throw new Error("served by the stateful runtime, not the plain handler");
			},
		},
	},
};

const sessionKey = buildSessionKey({
	providerId: PROVIDER_ID,
	serviceAccountId: "account-1",
	connectionId: "connection-1",
});

function aborted(signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

type HoldSession = { readonly podId: string };

// The provider's session layer: one long-lived session per key, whose read
// is in flight until the session's signal cancels it. The read keeps the
// abort reason as its cause, as ctx.http and ctx.native do.
function holdingAdapter(podId: string): StatefulProviderAdapter<HoldSession> {
	return {
		providerId: PROVIDER_ID,
		policy: { concurrency: { mode: "serialize" }, reconnect: "recreate" },
		connect: async () => ({ podId }),
		invoke: async (ctx) => {
			await aborted(ctx.signal);
			throw new TransportError("Session read was cancelled.", {
				code: "transport_cancelled",
				cause: ctx.signal.reason,
			});
		},
		close: async () => {},
	};
}

type Pod = {
	readonly podId: string;
	readonly endpoint: string;
	readonly metricsEndpoint: string;
	readonly handle: ProviderServerHandle;
	readonly router: StatefulSessionRouter;
	readonly manager: StatefulProviderSessionManager<HoldSession>;
	readonly events: ProviderServerLogEvent[];
};

const registry = new InMemorySessionOwnerRegistry();

async function startPod(podId: string, role: "owner" | "source"): Promise<Pod> {
	const events: ProviderServerLogEvent[] = [];
	const manager = new StatefulProviderSessionManager({
		adapter: holdingAdapter(podId),
		poolPolicy: { maxSessions: 10, idleTimeoutMs: "unlimited", maxLifetimeMs: "unlimited" },
	});
	let router: StatefulSessionRouter | undefined;

	// The documented composition: every operation this pod serves, received
	// directly or as a forwarded envelope, goes through the pod's router with
	// the request's deadlineAt. The ordinary route carries no deadlineAt, so
	// the source pod reads it from a test header; the owner's internal route
	// carries the envelope's.
	const execute: ProviderServerOperationExecutor = async ({ ctx, request, operationId }) => {
		if (!router) throw new Error(`${podId} received an operation before its router was wired`);
		const deadlineAt = request.deadlineAt ?? request.headers?.["x-test-deadline-at"];
		const result = await router.route({
			requestId: request.requestId,
			sessionKey,
			providerId: PROVIDER_ID,
			operationId,
			connectionId: "connection-1",
			serviceAccountId: "account-1",
			input: request.input,
			...(deadlineAt ? { deadlineAt } : {}),
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
		logger: (event) => events.push(event),
		operationExecutor: execute,
		...(role === "owner"
			? {
					internalOperationExecutor: execute,
					statefulForwarding: {
						secret: FORWARDING_SECRET,
						validateOwnerFence: createStatefulOwnerFenceValidator(registry),
					},
				}
			: {}),
		shutdown: { signals: false },
	});
	const endpoint = `http://127.0.0.1:${handle.port}`;
	// No metricEmitter: the router's default is the pod's channel.
	router = new StatefulSessionRouter({
		currentPod: { podId, endpoint },
		registry,
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
		events,
	};
}

const owner = await startPod("pod-owner", "owner");
const source = await startPod("pod-source", "source");
await registry.acquire({
	sessionKey,
	ownerPodId: owner.podId,
	ownerEndpoint: owner.endpoint,
	leaseDurationMs: 60_000,
});

afterAll(async () => {
	for (const pod of [source, owner]) {
		await pod.handle.close({ timeoutMs: 5_000 });
		await pod.router.release();
		await pod.manager.closeAll("test-complete");
	}
});

type FailureLog = Extract<ProviderServerLogEvent, { event: "provider_request_failed" }>;

function failureLog(pod: Pod, requestId: string): FailureLog | undefined {
	return pod.events.find(
		(event): event is FailureLog =>
			event.event === "provider_request_failed" && event.requestId === requestId,
	);
}

// The owner pod logs the failure after its router counted the deadline, so
// the log is the signal that the count is in.
async function waitForFailureLog(pod: Pod, requestId: string): Promise<FailureLog> {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		const found = failureLog(pod, requestId);
		if (found) return found;
		await Bun.sleep(10);
	}
	throw new Error(`${pod.podId} never logged the failure of ${requestId}`);
}

type Scrape = {
	readonly status: number;
	readonly contentType: string | null;
	readonly body: string;
};

async function scrape(pod: Pod): Promise<Scrape> {
	const response = await fetch(`${pod.metricsEndpoint}${PROVIDER_METRICS_ROUTE}`);
	return {
		status: response.status,
		contentType: response.headers.get("content-type"),
		body: await response.text(),
	};
}

// The value of the one series of `name` whose label set is exactly `labels`.
function sampleValue(
	body: string,
	name: string,
	labels: Readonly<Record<string, string>>,
): number | undefined {
	const wanted = Object.entries(labels);
	for (const line of body.split("\n")) {
		if (!line.startsWith(`${name}{`)) continue;
		const match = /^[^{]+\{(.*)\} (\S+)$/.exec(line);
		if (!match) continue;
		const found = new Map<string, string>();
		for (const [, key, value] of match[1].matchAll(
			/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g,
		)) {
			found.set(key, value);
		}
		if (found.size === wanted.length && wanted.every(([key, value]) => found.get(key) === value)) {
			return Number(match[2]);
		}
	}
	return undefined;
}

// A gateway caller of the source pod, whose request the source pod forwards
// to the owner pod under the deadline.
async function callSourcePod(requestId: string): Promise<number> {
	const response = await fetch(`${source.endpoint}/v1/${OPERATION_ID}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			requestId,
			input: {},
			headers: { "x-test-deadline-at": new Date(Date.now() + DEADLINE_MS).toISOString() },
		}),
	});
	await response.text();
	return response.status;
}

describe("stateful router metrics exported by default on the pod's metrics listener", () => {
	it(
		"exports the deadline the owner pod's router counted, from the registry both pods share",
		async () => {
			statefulProviderMetricRegistry.reset();
			const requestId = "owner-deadline-cancels-read";
			// The source pod's caller receives the deadline (serve classifies it,
			// stateful-owner-pod-local-deadline-assembly.test.ts).
			expect(await callSourcePod(requestId)).toBe(504);
			const ownerLog = await waitForFailureLog(owner, requestId);
			expect(ownerLog.errorClass).toBe("StatefulRoutingDeadlineError");

			const scraped = await scrape(owner);
			expect(scraped.status).toBe(200);
			expect(scraped.contentType).toBe(PROVIDER_METRICS_CONTENT_TYPE);
			// The owner pod's router counted the deadline it cancelled, without
			// any emitter wired, under the exported labels only.
			const counted = sampleValue(scraped.body, DEADLINE_METRIC, {
				providerId: PROVIDER_ID,
				operationId: OPERATION_ID,
				redactedErrorCode: "deadline_expired",
			});
			expect(counted ?? 0).toBeGreaterThanOrEqual(1);
			// No per-request, per-session or per-tenant value reaches a series.
			expect(scraped.body).not.toContain(requestId);
			expect(scraped.body).not.toContain("connection-1");
			expect(scraped.body).not.toContain("account-1");
			expect(scraped.body).not.toContain("sessionKey");
			expect(scraped.body).not.toContain("pod-owner");
			// One registry per process: the source pod's listener renders the
			// same registry, so both scrapes agree once both pods have answered.
			expect((await scrape(source)).body).toBe(scraped.body);
		},
		{ timeout: 10_000 },
	);

	it("keeps a router given an explicit emitter out of the process registry", async () => {
		const before = statefulProviderMetricRegistry.render();
		const recording = new RecordingStatefulProviderMetricEmitter();
		const router = new StatefulSessionRouter({
			currentPod: { podId: "pod-explicit", endpoint: "http://127.0.0.1:1" },
			registry,
			forwarder: new HttpStatefulOwnerForwarder({
				currentPodId: "pod-explicit",
				secret: FORWARDING_SECRET,
			}),
			executor: owner.manager,
			leaseDurationMs: 30_000,
			metricEmitter: recording,
		});
		try {
			await expect(
				router.route({
					requestId: "explicit-emitter-expired-before-routing",
					sessionKey,
					providerId: PROVIDER_ID,
					operationId: OPERATION_ID,
					connectionId: "connection-1",
					serviceAccountId: "account-1",
					input: {},
					deadlineAt: new Date(Date.now() - 1).toISOString(),
				}),
			).rejects.toBeInstanceOf(StatefulRoutingDeadlineError);
		} finally {
			await router.release();
		}
		expect(recording.metrics).toEqual([expect.objectContaining({ name: DEADLINE_METRIC })]);
		expect(statefulProviderMetricRegistry.render()).toBe(before);
	});

	it("serves /metrics on the metrics listener only, declaring every name in the closed set", async () => {
		// The primary listener keeps its routes and gains none.
		expect((await fetch(`${owner.endpoint}/health`)).status).toBe(200);
		expect((await fetch(`${owner.endpoint}${PROVIDER_METRICS_ROUTE}`)).status).toBe(404);
		// The metrics listener serves nothing but /metrics.
		expect((await fetch(`${owner.metricsEndpoint}/health`)).status).toBe(404);
		expect(
			(
				await fetch(`${owner.metricsEndpoint}/v1/${OPERATION_ID}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ requestId: "metrics-listener-operation", input: {} }),
				})
			).status,
		).toBe(404);
		expect(owner.handle.metricsPort).not.toBe(owner.handle.port);
		expect(owner.events).toContainEqual({
			level: "info",
			event: "provider_metrics_listener",
			providerId: PROVIDER_ID,
			port: owner.handle.metricsPort,
		});

		const scraped = await scrape(owner);
		expect(scraped.status).toBe(200);
		expect(scraped.contentType).toBe(PROVIDER_METRICS_CONTENT_TYPE);
		for (const name of STATEFUL_PROVIDER_METRIC_NAMES) {
			expect(scraped.body).toContain(`# TYPE ${name} ${STATEFUL_PROVIDER_METRIC_KINDS[name]}\n`);
		}
	});
});
