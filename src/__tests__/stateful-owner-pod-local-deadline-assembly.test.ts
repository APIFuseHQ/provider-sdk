import { afterAll, describe, expect, it } from "bun:test";
import { z } from "zod";

import { TransportError } from "../errors.js";
import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";
import {
	createServerApp,
	ERROR_OBSERVABILITY_HEADER,
	type ProviderServerLogEvent,
	type ProviderServerOperationExecutor,
} from "../server/serve.js";
import {
	buildSessionKey,
	createStatefulOwnerFenceValidator,
	HttpStatefulOwnerForwarder,
	InMemorySessionOwnerRegistry,
	type StatefulProviderAdapter,
	type StatefulProviderMetricEmitter,
	StatefulProviderSessionManager,
	StatefulSessionRouter,
	statefulForwardingContextFromProviderRequest,
	withStatefulLocalProviderContext,
} from "../stateful/index.js";
import type { ProviderDefinition } from "../types.js";

// An owner pod and a source pod wired the way a provider's serving runtime
// composes the SDK: on each pod the real provider app on a real loopback
// listener, whose operation executor and internal executor both hand every
// operation to the pod's real StatefulSessionRouter over a real
// StatefulProviderSessionManager, with the SDK's signed HttpStatefulOwnerForwarder
// and owner-fence validator between the pods and one in-memory owner registry
// shared in place of the control plane. The only piece that is not the SDK's
// is the adapter's session read, which waits on the signal the session
// manager gives it, like a transport read the signal cancels.
//
// The owner pod's executor does not consume the signal serve hands it; the
// router arms its own deadline timer from the forwarded deadlineAt. This is
// how the README composition, StatefulProviderRuntimeExecutor and the
// KakaoTalk serving runtime are wired. The scenarios pin what the owner pod
// serves when that timer cancels the read.
const PROVIDER_ID = "owner-pod-deadline-assembly";
const FORWARDING_SECRET = "owner-pod-deadline-assembly-forwarding-secret";
// The forwarded deadline. Generous, so forwarding, the owner fence and the
// session connect always finish before it even on a loaded machine; each
// scenario also records whether the held read had started.
const DEADLINE_MS = 1_500;
// A provider's own per-read time limit, well inside the deadline.
const PROVIDER_TIMER_MS = 50;
const DEADLINE_METRIC = "apifuse_stateful_provider_routing_deadline_expired_total";

const operation = {
	riskClass: "read" as const,
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	handler: async () => {
		throw new Error("served by the stateful runtime, not the plain handler");
	},
};

const provider: ProviderDefinition = {
	allowedHosts: ["example.com"],
	reviewed: "community",
	id: PROVIDER_ID,
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Owner Pod Deadline Assembly",
		descriptionKey: "owner-pod-deadline-assembly.description",
		category: "test",
	},
	operations: {
		"read-until-cancelled": operation,
		"read-aborted-by-provider-timer": operation,
		"fails-after-deadline-without-cause": operation,
	},
};

const sessionKey = buildSessionKey({
	providerId: PROVIDER_ID,
	serviceAccountId: "account-1",
	connectionId: "connection-1",
});

type Waiter = { promise: Promise<void>; resolve: () => void };

function waiter(): Waiter {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function aborted(signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

type HoldSession = { readonly podId: string };

let holdReached = false;

// The provider's session layer: one long-lived session per key, whose read
// is in flight until something cancels it.
function holdingAdapter(podId: string): StatefulProviderAdapter<HoldSession> {
	return {
		providerId: PROVIDER_ID,
		policy: { concurrency: { mode: "serialize" }, reconnect: "recreate" },
		connect: async () => ({ podId }),
		invoke: async (ctx, _session, request) => {
			holdReached = true;
			switch (request.operationId) {
				case "read-until-cancelled": {
					// A read the session's signal cancels. It keeps the abort
					// reason as its cause, as ctx.http and ctx.native do.
					await aborted(ctx.signal);
					throw new TransportError("Session read was cancelled.", {
						code: "transport_cancelled",
						cause: ctx.signal.reason,
					});
				}
				case "read-aborted-by-provider-timer": {
					// The provider bounds its own read: the same code, caused
					// by its own TimeoutError, not by the deadline.
					const own = AbortSignal.timeout(PROVIDER_TIMER_MS);
					await aborted(own);
					throw new TransportError("Session read timed out.", {
						code: "transport_cancelled",
						cause: own.reason,
					});
				}
				case "fails-after-deadline-without-cause": {
					// A failure after the deadline fired that does not carry the
					// deadline's reason: not something the deadline cancelled.
					await aborted(ctx.signal);
					throw new Error("Session read failed.");
				}
				default:
					throw new Error(`unexpected operation ${request.operationId}`);
			}
		},
		close: async () => {},
	};
}

type Served = { status: number; observability: unknown; body: unknown };
type RecordedMetric = { name: string; labels: unknown };

type Pod = {
	readonly podId: string;
	readonly endpoint: string;
	readonly server: ReturnType<typeof Bun.serve>;
	readonly router: StatefulSessionRouter;
	readonly manager: StatefulProviderSessionManager<HoldSession>;
	readonly events: ProviderServerLogEvent[];
	readonly metrics: RecordedMetric[];
	/** The error response each request id was answered with, whether or not its caller stayed. */
	readonly served: Map<string, Served>;
	readonly servedWaiters: Map<string, Waiter>;
};

const registry = new InMemorySessionOwnerRegistry();

function errorRequestId(body: unknown): string {
	return typeof body === "object" &&
		body !== null &&
		"error" in body &&
		typeof body.error === "object" &&
		body.error !== null &&
		"requestId" in body.error &&
		typeof body.error.requestId === "string"
		? body.error.requestId
		: "";
}

function parseObservability(response: Response): unknown {
	return JSON.parse(response.headers.get(ERROR_OBSERVABILITY_HEADER) ?? "null");
}

function startPod(podId: string, role: "owner" | "source"): Pod {
	const events: ProviderServerLogEvent[] = [];
	const metrics: RecordedMetric[] = [];
	const served = new Map<string, Served>();
	const servedWaiters = new Map<string, Waiter>();
	const metricEmitter: StatefulProviderMetricEmitter = {
		increment(name, labels) {
			metrics.push({ name, labels });
		},
		gauge() {},
		observe() {},
	};
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

	const app = createServerApp(provider, {
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
	});
	// Records the error response built for each request id even when the
	// caller has already gone, as the source pod's forwarder has at the deadline.
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request): Promise<Response> {
			const response = await app.fetch(request);
			const body: unknown = await response
				.clone()
				.json()
				.catch(() => null);
			const requestId = errorRequestId(body);
			if (requestId) {
				served.set(requestId, {
					status: response.status,
					observability: parseObservability(response),
					body,
				});
				servedWaiters.get(requestId)?.resolve();
			}
			return response;
		},
	});
	const endpoint = `http://127.0.0.1:${server.port}`;
	router = new StatefulSessionRouter({
		currentPod: { podId, endpoint },
		registry,
		forwarder: new HttpStatefulOwnerForwarder({ currentPodId: podId, secret: FORWARDING_SECRET }),
		executor: manager,
		leaseDurationMs: 30_000,
		metricEmitter,
	});
	return { podId, endpoint, server, router, manager, events, metrics, served, servedWaiters };
}

const owner = startPod("pod-owner", "owner");
const source = startPod("pod-source", "source");
await registry.acquire({
	sessionKey,
	ownerPodId: owner.podId,
	ownerEndpoint: owner.endpoint,
	leaseDurationMs: 60_000,
});

afterAll(async () => {
	for (const pod of [source, owner]) {
		pod.server.stop(true);
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

function deadlineMetrics(pod: Pod, requestId: string): RecordedMetric[] {
	return pod.metrics.filter(
		(metric) =>
			metric.name === DEADLINE_METRIC &&
			typeof metric.labels === "object" &&
			metric.labels !== null &&
			"requestId" in metric.labels &&
			metric.labels.requestId === requestId,
	);
}

// A gateway caller of the source pod, whose request the source pod forwards
// to the owner pod under the deadline.
async function callSourcePod(operationId: string, requestId: string) {
	holdReached = false;
	const ownerDone = waiter();
	owner.servedWaiters.set(requestId, ownerDone);
	const response = await fetch(`${source.endpoint}/v1/${operationId}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			requestId,
			input: {},
			headers: { "x-test-deadline-at": new Date(Date.now() + DEADLINE_MS).toISOString() },
		}),
	});
	const caller = {
		status: response.status,
		observability: parseObservability(response),
		body: await response.json(),
	};
	await ownerDone.promise;
	return {
		caller,
		holdReached,
		owner: owner.served.get(requestId),
		ownerLog: failureLog(owner, requestId),
		ownerDeadlineMetrics: deadlineMetrics(owner, requestId),
	};
}

// What the owner's internal route already serves for a forwarded deadline
// that expired before execution, and what the source pod's caller receives
// for one that expired while forwarding (serve-stateful-deadline-classification.test.ts).
const DEADLINE_EXPIRED_BODY = (requestId: string) => ({
	error: {
		code: "STATEFUL_FORWARDING_DEADLINE_EXPIRED",
		message: "Stateful forwarding deadline expired.",
		requestId,
		retryable: false,
		source: "apifuse",
	},
});
const DEADLINE_EXPIRED_OBSERVABILITY = {
	category: "stateful_forwarding_deadline",
	taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
	retryable: false,
};

describe("stateful forwarding deadline expiring during the owner pod's local execution", () => {
	it(
		"serves the read the router's deadline timer cancelled as the deadline, on both pods",
		async () => {
			const result = await callSourcePod("read-until-cancelled", "owner-deadline-cancels-read");
			// The deadline expired while the owner's session read was in flight.
			expect(result.holdReached).toBe(true);
			// The owner pod: the same 504 its route serves when the deadline
			// expires before execution, not a transport failure.
			expect(result.owner?.status).toBe(504);
			expect(result.owner?.observability).toEqual(DEADLINE_EXPIRED_OBSERVABILITY);
			expect(result.owner?.body).toEqual(DEADLINE_EXPIRED_BODY("owner-deadline-cancels-read"));
			expect(result.ownerLog?.status).toBe(504);
			expect(result.ownerLog?.code).toBe("STATEFUL_FORWARDING_DEADLINE_EXPIRED");
			expect(result.ownerLog?.errorClass).toBe("StatefulRoutingDeadlineError");
			expect(result.ownerLog?.errorCategory).toBe("stateful_forwarding_deadline");
			// The cancelled read stays visible as the cause: the transport's
			// transport_cancelled, caused by the router timer's own reason, whose
			// name stays AbortError.
			expect(result.ownerLog?.causeChain?.slice(0, 2)).toEqual([
				expect.objectContaining({ errorClass: "TransportError", code: "transport_cancelled" }),
				expect.objectContaining({ errorClass: "AbortError" }),
			]);
			// Counted like a deadline that expired before routing or while forwarding.
			expect(result.ownerDeadlineMetrics).toHaveLength(1);
			// The source pod's caller: the deadline, whether the source's own
			// timer aborted the forwarding request or the owner's 504 arrived first.
			expect(result.caller.status).toBe(504);
			expect(result.caller.observability).toEqual(DEADLINE_EXPIRED_OBSERVABILITY);
			expect(result.caller.body).toEqual(DEADLINE_EXPIRED_BODY("owner-deadline-cancels-read"));
		},
		{ timeout: 10_000 },
	);

	it(
		"keeps a read the provider's own AbortSignal.timeout aborted on the provider timeout branch",
		async () => {
			const result = await callSourcePod(
				"read-aborted-by-provider-timer",
				"owner-provider-timer-aborts-read",
			);
			expect(result.holdReached).toBe(true);
			// Served like transport_timeout, not like the deadline: the body keeps
			// transport_cancelled, the TimeoutError stays the logged cause.
			expect(result.owner?.status).toBe(504);
			expect(result.owner?.observability).toEqual({
				category: "timeout",
				taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
				retryable: true,
			});
			expect(result.owner?.body).toEqual({
				error: {
					code: "transport_cancelled",
					message: "Request timed out",
					requestId: "owner-provider-timer-aborts-read",
					retryable: true,
					source: "upstream_failure",
				},
			});
			expect(result.ownerLog?.errorClass).toBe("TransportError");
			expect(result.ownerLog?.causeChain?.[0]?.errorClass).toBe("TimeoutError");
			expect(result.ownerDeadlineMetrics).toEqual([]);
		},
		{ timeout: 10_000 },
	);

	it(
		"leaves a failure after the deadline that does not carry the deadline's reason as it is",
		async () => {
			const result = await callSourcePod(
				"fails-after-deadline-without-cause",
				"owner-fails-after-deadline",
			);
			expect(result.holdReached).toBe(true);
			// The deadline timer had fired, but it did not cancel this failure.
			expect(result.owner?.status).toBe(500);
			expect(result.owner?.observability).toEqual({
				category: "internal_error",
				taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
				retryable: false,
			});
			expect(result.ownerLog?.code).toBe("internal_error");
			expect(result.ownerLog?.errorClass).toBe("Error");
			expect(result.ownerDeadlineMetrics).toEqual([]);
		},
		{ timeout: 10_000 },
	);
});
