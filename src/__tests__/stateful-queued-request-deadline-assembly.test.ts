import { describe, expect, it } from "bun:test";
import { z } from "zod";

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
	HttpSessionOwnerRegistry,
	HttpStatefulOwnerForwarder,
	InMemorySessionOwnerRegistry,
	type SessionOwnerRecord,
	type StatefulProviderAdapter,
	type StatefulProviderMetricEmitter,
	StatefulProviderSessionManager,
	StatefulSessionRouter,
	statefulForwardingContextFromProviderRequest,
	withStatefulLocalProviderContext,
} from "../stateful/index.js";
import type { ProviderDefinition } from "../types.js";

// Requests that wait in the owner pod's session queue, assembled the way a
// provider's serving runtime composes the SDK. Each scenario starts its own
// world: an owner pod and a source pod, each the real provider app on a real
// loopback listener whose executors hand every operation to the pod's real
// StatefulSessionRouter over a real StatefulProviderSessionManager, with the
// SDK's signed HttpStatefulOwnerForwarder between the pods and the SDK's
// owner-fence validator on the owner's internal route. Every registry call
// goes through the SDK's HttpSessionOwnerRegistry over real HTTP to a loopback
// control plane that answers from an InMemorySessionOwnerRegistry, so an
// abort in flight goes through the real fetch and the registry's own error
// wrapping. Each pod component calls the control plane under its own path
// prefix, so a scenario can hold or follow one component's calls.
//
// The only piece that is not the SDK's is the adapter: a serialized session
// whose read for a request id waits until the scenario releases it, like a
// long transport read holding the session queue. It counts connects, reads
// and closes, and the reason of each close.
const PROVIDER_ID = "queued-request-deadline-assembly";
const FORWARDING_SECRET = "queued-request-deadline-assembly-forwarding-secret";
const CONTROL_PLANE_SECRET = "queued-request-deadline-assembly-control-plane-secret";
// The queued request's deadline. Routing it to the owner pod's queue takes a
// few milliseconds; the read ahead of it is held until the scenario lets go.
const DEADLINE_MS = 300;
// How long a scenario waits for an answer it expects. A queue wait that
// ignores the deadline answers only after the held read is released, which a
// scenario does only after this wait.
const ANSWER_WAIT_MS = 5_000;
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
		displayName: "Queued Request Deadline Assembly",
		descriptionKey: "queued-request-deadline-assembly.description",
		category: "test",
	},
	operations: { read: operation },
};

const sessionKey = buildSessionKey({
	providerId: PROVIDER_ID,
	serviceAccountId: "account-1",
	connectionId: "connection-1",
});

type Waiter = { readonly promise: Promise<void>; readonly resolve: () => void };

function waiter(): Waiter {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return Promise.race([promise, Bun.sleep(ms).then(() => undefined)]);
}

type ControlPlaneCall = {
	readonly caller: string;
	readonly operation: string;
	readonly body: Record<string, unknown>;
};

type ControlPlaneHook = (
	call: ControlPlaneCall,
	answer: () => Promise<Response>,
) => Promise<Response>;

type ControlPlane = {
	readonly url: string;
	readonly registry: InMemorySessionOwnerRegistry;
	readonly calls: ControlPlaneCall[];
	hook?: ControlPlaneHook;
	stop(): void;
};

function optionalDate(value: unknown): Date | undefined {
	return typeof value === "string" ? new Date(value) : undefined;
}

function readOwnerInput(body: Record<string, unknown>) {
	return z
		.object({
			sessionKey: z.string(),
			ownerPodId: z.string(),
			ownerEndpoint: z.string().optional(),
			generation: z.number().optional(),
			leaseDurationMs: z.number().optional(),
			status: z.enum(["acquiring", "connected", "draining"]).optional(),
		})
		.parse(body);
}

// The control plane's owner endpoints over an in-memory registry. Signed
// headers are not checked; the path prefix names the calling component.
function startControlPlane(): ControlPlane {
	const registry = new InMemorySessionOwnerRegistry();
	const calls: ControlPlaneCall[] = [];
	const plane: ControlPlane = {
		url: "",
		registry,
		calls,
		stop: () => server.stop(true),
	};
	const answerFor = async (call: ControlPlaneCall): Promise<Response> => {
		const key = buildSessionKeyFrom(call.body.sessionKey);
		const now = optionalDate(call.body.now);
		switch (call.operation) {
			case "resolve": {
				const record = await registry.resolve(key, now);
				return record ? Response.json(record) : new Response(null, { status: 404 });
			}
			case "acquire": {
				const input = readOwnerInput(call.body);
				return Response.json(
					await registry.acquire({
						sessionKey: key,
						ownerPodId: input.ownerPodId,
						ownerEndpoint: input.ownerEndpoint ?? "",
						leaseDurationMs: input.leaseDurationMs ?? 30_000,
						...(input.status ? { status: input.status } : {}),
						...(now ? { now } : {}),
					}),
				);
			}
			case "renew": {
				const input = readOwnerInput(call.body);
				return Response.json(
					await registry.renew({
						sessionKey: key,
						ownerPodId: input.ownerPodId,
						generation: input.generation ?? 0,
						leaseDurationMs: input.leaseDurationMs ?? 30_000,
						...(input.status ? { status: input.status } : {}),
						...(now ? { now } : {}),
					}),
				);
			}
			case "release": {
				const input = readOwnerInput(call.body);
				return Response.json(
					await registry.release({
						sessionKey: key,
						ownerPodId: input.ownerPodId,
						generation: input.generation ?? 0,
					}),
				);
			}
			default:
				return new Response(null, { status: 404 });
		}
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request): Promise<Response> {
			const path = new URL(request.url).pathname;
			const match = /^\/([^/]+)\/v1\/stateful\/sessions\/owners\/([a-z]+)$/.exec(path);
			if (!match) return new Response(null, { status: 404 });
			const body = z.record(z.string(), z.unknown()).parse(await request.json());
			const call: ControlPlaneCall = { caller: match[1], operation: match[2], body };
			calls.push(call);
			const answer = () => answerFor(call);
			return plane.hook ? plane.hook(call, answer) : answer();
		},
	});
	return Object.assign(plane, { url: `http://127.0.0.1:${server.port}` });
}

function buildSessionKeyFrom(value: unknown) {
	if (value !== sessionKey) throw new Error(`unexpected session key ${String(value)}`);
	return sessionKey;
}

type Served = { readonly status: number; readonly observability: unknown; readonly body: unknown };
type RecordedMetric = { readonly name: string; readonly labels: unknown };

type SessionCounts = {
	connects: number;
	readonly reads: string[];
	readonly closes: string[];
	readonly order: string[];
};

type Pod = {
	readonly podId: string;
	readonly endpoint: string;
	readonly router: StatefulSessionRouter;
	readonly manager: StatefulProviderSessionManager<{ readonly podId: string }>;
	readonly events: ProviderServerLogEvent[];
	readonly metrics: RecordedMetric[];
	readonly counts: SessionCounts;
	/** The answer this pod served for each request id. */
	readonly served: Map<string, Served>;
	readonly servedWaiters: Map<string, Waiter>;
	readonly readStarted: Map<string, Waiter>;
	stop(): Promise<void>;
};

function parseObservability(response: Response): unknown {
	return JSON.parse(response.headers.get(ERROR_OBSERVABILITY_HEADER) ?? "null");
}

function requestIdOf(body: unknown): string | undefined {
	const parsed = z.object({ requestId: z.string() }).safeParse(body);
	return parsed.success ? parsed.data.requestId : undefined;
}

function startPod(
	podId: string,
	role: "owner" | "source",
	plane: ControlPlane,
	holds: Map<string, Waiter>,
): Pod {
	const events: ProviderServerLogEvent[] = [];
	const metrics: RecordedMetric[] = [];
	const served = new Map<string, Served>();
	const servedWaiters = new Map<string, Waiter>();
	const readStarted = new Map<string, Waiter>();
	const counts: SessionCounts = { connects: 0, reads: [], closes: [], order: [] };
	const metricEmitter: StatefulProviderMetricEmitter = {
		increment(name, labels) {
			metrics.push({ name, labels });
		},
		gauge() {},
		observe() {},
	};
	const adapter: StatefulProviderAdapter<{ readonly podId: string }> = {
		providerId: PROVIDER_ID,
		policy: { concurrency: { mode: "serialize" }, reconnect: "recreate" },
		connect: async () => {
			counts.connects += 1;
			return { podId };
		},
		invoke: async (_ctx, _session, request) => {
			counts.reads.push(request.requestId);
			counts.order.push(`start-${request.requestId}`);
			readStarted.get(request.requestId)?.resolve();
			await holds.get(request.requestId)?.promise;
			counts.order.push(`end-${request.requestId}`);
			return { output: { ok: true } };
		},
		close: async (_ctx, _session, reason) => {
			counts.closes.push(reason);
		},
	};
	const manager = new StatefulProviderSessionManager({
		adapter,
		poolPolicy: { maxSessions: 10, idleTimeoutMs: "unlimited", maxLifetimeMs: "unlimited" },
	});
	const registry = (component: string) =>
		new HttpSessionOwnerRegistry({
			baseUrl: `${plane.url}/${podId}-${component}`,
			secret: CONTROL_PLANE_SECRET,
		});
	let router: StatefulSessionRouter | undefined;
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
						validateOwnerFence: createStatefulOwnerFenceValidator(registry("fence")),
					},
				}
			: {}),
	});
	// Records the answer built for each request id even when the caller has
	// already gone, as the source pod's forwarder has at the deadline.
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request): Promise<Response> {
			const requestId = requestIdOf(
				await request
					.clone()
					.json()
					.catch(() => null),
			);
			const response = await app.fetch(request);
			const body: unknown = await response
				.clone()
				.json()
				.catch(() => null);
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
		registry: registry("router"),
		forwarder: new HttpStatefulOwnerForwarder({ currentPodId: podId, secret: FORWARDING_SECRET }),
		executor: manager,
		leaseDurationMs: 30_000,
		metricEmitter,
	});
	const wiredRouter = router;
	return {
		podId,
		endpoint,
		router: wiredRouter,
		manager,
		events,
		metrics,
		counts,
		served,
		servedWaiters,
		readStarted,
		async stop() {
			server.stop(true);
			await wiredRouter.release();
			await manager.closeAll("test-complete");
		},
	};
}

type World = {
	readonly plane: ControlPlane;
	readonly owner: Pod;
	readonly source: Pod;
	readonly ownerRecord: SessionOwnerRecord;
	/** Holds the owner's session read for `requestId` until `release(requestId)`. */
	hold(requestId: string): void;
	release(requestId: string): void;
	/** A gateway caller of the source pod, which forwards to the owner pod. */
	call(
		requestId: string,
		options?: { readonly deadlineMs?: number },
	): Promise<{ readonly status: number; readonly observability: unknown; readonly body: unknown }>;
	/** Resolves once the owner pod has served `requestId`; undefined if it has not within `ms`. */
	ownerServedWithin(requestId: string, ms: number): Promise<Served | undefined>;
	readStarted(requestId: string): Promise<void>;
	ownerRouterResolves(): number;
	stop(): Promise<void>;
};

async function startWorld(): Promise<World> {
	const plane = startControlPlane();
	const holds = new Map<string, Waiter>();
	const owner = startPod("pod-owner", "owner", plane, holds);
	const source = startPod("pod-source", "source", plane, holds);
	const { record: ownerRecord } = await plane.registry.acquire({
		sessionKey,
		ownerPodId: owner.podId,
		ownerEndpoint: owner.endpoint,
		leaseDurationMs: 60_000,
		status: "connected",
	});
	const ownerServed = (requestId: string) => {
		const done = owner.servedWaiters.get(requestId) ?? waiter();
		owner.servedWaiters.set(requestId, done);
		return done;
	};
	return {
		plane,
		owner,
		source,
		ownerRecord,
		hold(requestId) {
			holds.set(requestId, waiter());
		},
		release(requestId) {
			holds.get(requestId)?.resolve();
		},
		async call(requestId, options = {}) {
			ownerServed(requestId);
			const response = await fetch(`${source.endpoint}/v1/read`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId,
					input: {},
					headers:
						options.deadlineMs === undefined
							? {}
							: {
									"x-test-deadline-at": new Date(Date.now() + options.deadlineMs).toISOString(),
								},
				}),
			});
			return {
				status: response.status,
				observability: parseObservability(response),
				body: await response.json(),
			};
		},
		async ownerServedWithin(requestId, ms) {
			await within(ownerServed(requestId).promise, ms);
			return owner.served.get(requestId);
		},
		readStarted(requestId) {
			const started = owner.readStarted.get(requestId) ?? waiter();
			owner.readStarted.set(requestId, started);
			return started.promise;
		},
		ownerRouterResolves() {
			return plane.calls.filter(
				(call) => call.caller === "pod-owner-router" && call.operation === "resolve",
			).length;
		},
		async stop() {
			for (const held of holds.values()) held.resolve();
			plane.hook = undefined;
			await source.stop();
			await owner.stop();
			plane.stop();
		},
	};
}

// Waits until the owner pod's router has made `count` more owner resolves than
// `before`: for a request routed to a session the owner pod holds, the
// router's lookup and its local ownership check, after which the request
// goes to the session manager's queue.
async function ownerRouterResolvesReach(world: World, target: number): Promise<void> {
	for (let attempt = 0; attempt < 500 && world.ownerRouterResolves() < target; attempt++) {
		await Bun.sleep(5);
	}
	expect(world.ownerRouterResolves()).toBeGreaterThanOrEqual(target);
}

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

function releaseCalls(world: World): number {
	return world.plane.calls.filter(
		(call) => call.caller === "pod-owner-router" && call.operation === "release",
	).length;
}

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

describe("stateful requests waiting in the owner pod's session queue", () => {
	it(
		"runs a queued request without a deadline after the read ahead of it",
		async () => {
			const world = await startWorld();
			try {
				world.hold("first");
				const first = world.call("first");
				await world.readStarted("first");
				const resolvesBefore = world.ownerRouterResolves();
				const queued = world.call("queued-without-deadline");
				await ownerRouterResolvesReach(world, resolvesBefore + 2);
				await Bun.sleep(20);
				world.release("first");

				expect((await first).status).toBe(200);
				expect((await queued).status).toBe(200);
				expect(world.owner.counts.order).toEqual([
					"start-first",
					"end-first",
					"start-queued-without-deadline",
					"end-queued-without-deadline",
				]);
				expect(world.owner.counts.connects).toBe(1);
				expect(world.owner.counts.closes).toEqual([]);
			} finally {
				await world.stop();
			}
		},
		{ timeout: 15_000 },
	);

	it(
		"answers a queued request at its deadline while the read ahead of it still holds the session, and keeps the session and the lease",
		async () => {
			const world = await startWorld();
			try {
				world.hold("holds-session");
				const holding = world.call("holds-session");
				await world.readStarted("holds-session");
				const caller = await world.call("queued-past-deadline", { deadlineMs: DEADLINE_MS });
				// The owner pod answers the queued request before the held read is let go.
				const ownerAnswer = await world.ownerServedWithin("queued-past-deadline", ANSWER_WAIT_MS);
				const readsWhileHeld = [...world.owner.counts.reads];
				const closesWhileHeld = [...world.owner.counts.closes];
				world.release("holds-session");

				expect(caller.status).toBe(504);
				expect(caller.observability).toEqual(DEADLINE_EXPIRED_OBSERVABILITY);
				expect(caller.body).toEqual(DEADLINE_EXPIRED_BODY("queued-past-deadline"));
				expect(ownerAnswer?.status).toBe(504);
				expect(ownerAnswer?.observability).toEqual(DEADLINE_EXPIRED_OBSERVABILITY);
				expect(ownerAnswer?.body).toEqual(DEADLINE_EXPIRED_BODY("queued-past-deadline"));
				const log = failureLog(world.owner, "queued-past-deadline");
				expect(log?.errorClass).toBe("StatefulRoutingDeadlineError");
				expect(log?.causeChain?.[0]?.errorClass).toBe("AbortError");
				expect(deadlineMetrics(world.owner, "queued-past-deadline")).toHaveLength(1);
				// The queued request never reached the session, and nothing closed it.
				expect(readsWhileHeld).toEqual(["holds-session"]);
				expect(closesWhileHeld).toEqual([]);

				expect((await holding).status).toBe(200);
				expect((await world.call("after-deadline")).status).toBe(200);
				expect(world.owner.counts.reads).toEqual(["holds-session", "after-deadline"]);
				expect(world.owner.counts.connects).toBe(1);
				expect(world.owner.counts.closes).toEqual([]);
				// The owner pod still holds the same lease.
				const record = await world.plane.registry.resolve(sessionKey);
				expect(record?.ownerPodId).toBe(world.owner.podId);
				expect(record?.generation).toBe(world.ownerRecord.generation);
				const releasesBefore = releaseCalls(world);
				await world.owner.router.release();
				expect(releaseCalls(world)).toBe(releasesBefore + 1);
			} finally {
				await world.stop();
			}
		},
		{ timeout: 15_000 },
	);

	it(
		"keeps the session and the lease when the deadline aborts the owner re-check in flight",
		async () => {
			const world = await startWorld();
			const heldResolve = waiter();
			let resolveWasHeld = false;
			try {
				expect((await world.call("pools-the-session")).status).toBe(200);
				// The router's lookup and local ownership check pass; the session
				// manager's re-check of the pooled session is held at the
				// control plane until after the deadline.
				const resolvesBefore = world.ownerRouterResolves();
				world.plane.hook = async (call, answer) => {
					if (
						call.caller === "pod-owner-router" &&
						call.operation === "resolve" &&
						world.ownerRouterResolves() === resolvesBefore + 3
					) {
						resolveWasHeld = true;
						await heldResolve.promise;
					}
					return answer();
				};
				const caller = await world.call("recheck-past-deadline", { deadlineMs: DEADLINE_MS });
				const ownerAnswer = await world.ownerServedWithin("recheck-past-deadline", ANSWER_WAIT_MS);
				heldResolve.resolve();
				expect(resolveWasHeld).toBe(true);

				expect(caller.status).toBe(504);
				expect(caller.body).toEqual(DEADLINE_EXPIRED_BODY("recheck-past-deadline"));
				expect(ownerAnswer?.status).toBe(504);
				expect(ownerAnswer?.body).toEqual(DEADLINE_EXPIRED_BODY("recheck-past-deadline"));
				const log = failureLog(world.owner, "recheck-past-deadline");
				expect(log?.errorClass).toBe("StatefulRoutingDeadlineError");
				// The registry's request the deadline aborted, then the deadline's reason.
				expect(log?.causeChain?.slice(0, 2)).toEqual([
					expect.objectContaining({ errorClass: "StatefulControlPlaneError" }),
					expect.objectContaining({ errorClass: "AbortError" }),
				]);
				expect(deadlineMetrics(world.owner, "recheck-past-deadline")).toHaveLength(1);
				expect(world.owner.counts.closes).toEqual([]);
				const record = await world.plane.registry.resolve(sessionKey);
				expect(record?.ownerPodId).toBe(world.owner.podId);
				expect(record?.generation).toBe(world.ownerRecord.generation);

				world.plane.hook = undefined;
				expect((await world.call("after-recheck")).status).toBe(200);
				expect(world.owner.counts.reads).toEqual(["pools-the-session", "after-recheck"]);
				expect(world.owner.counts.connects).toBe(1);
				expect(world.owner.counts.closes).toEqual([]);
			} finally {
				heldResolve.resolve();
				await world.stop();
			}
		},
		{ timeout: 15_000 },
	);

	it(
		"still closes the session for a queued request whose owner changed before its turn",
		async () => {
			const world = await startWorld();
			try {
				world.hold("holds-session");
				const holding = world.call("holds-session");
				await world.readStarted("holds-session");
				// Once the queued request has passed the router's lookup and local
				// ownership check, another pod takes the session over.
				const resolvesBefore = world.ownerRouterResolves();
				const ownerMoved = waiter();
				world.plane.hook = async (call, answer) => {
					const index = world.ownerRouterResolves();
					const response = await answer();
					if (
						call.caller === "pod-owner-router" &&
						call.operation === "resolve" &&
						index === resolvesBefore + 2
					) {
						await world.plane.registry.release({
							sessionKey,
							ownerPodId: world.owner.podId,
							generation: world.ownerRecord.generation,
						});
						await world.plane.registry.acquire({
							sessionKey,
							ownerPodId: "pod-elsewhere",
							ownerEndpoint: "http://127.0.0.1:1",
							leaseDurationMs: 60_000,
							status: "connected",
						});
						ownerMoved.resolve();
					}
					return response;
				};
				const queued = world.call("queued-owner-moved");
				await ownerMoved.promise;
				await Bun.sleep(20);
				world.release("holds-session");

				expect((await holding).status).toBe(200);
				const ownerAnswer = await world.ownerServedWithin("queued-owner-moved", ANSWER_WAIT_MS);
				expect(ownerAnswer?.status).toBe(500);
				expect(ownerAnswer?.observability).toEqual({
					category: "internal_error",
					taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
					retryable: false,
				});
				expect(ownerAnswer?.body).toMatchObject({
					error: {
						code: "internal_error",
						details: { errorClass: "StatefulRoutingOwnershipError" },
					},
				});
				expect(failureLog(world.owner, "queued-owner-moved")?.errorClass).toBe(
					"StatefulRoutingOwnershipError",
				);
				expect(deadlineMetrics(world.owner, "queued-owner-moved")).toEqual([]);
				await queued;
				// Fail-closed: the session is closed and the owner pod stops managing the lease.
				expect(world.owner.counts.reads).toEqual(["holds-session"]);
				expect(world.owner.counts.closes).toEqual(["ownership-validation-failed"]);
				const releasesBefore = releaseCalls(world);
				await world.owner.router.release();
				expect(releaseCalls(world)).toBe(releasesBefore);
			} finally {
				await world.stop();
			}
		},
		{ timeout: 15_000 },
	);
});
