import { describe, expect, it } from "bun:test";

import {
	buildSessionKey,
	parseSessionKey,
	type ProviderEventOwnerFence,
	RecordingStatefulProviderMetricEmitter,
	type SessionOwnerRecord,
	type SessionPoolPolicy,
	type StatefulOperationRequest,
	type StatefulProviderAdapter,
	type StatefulProviderEventPublish,
	type StatefulProviderSessionContext,
	StatefulProviderSessionManager,
	StatefulSessionInvalidatedError,
} from "../../dist/stateful/index.js";
import { assertIsError, capturedError } from "./test-utils.js";

type TestSession = { connected: boolean };
type TestState = Record<string, unknown>;
type TestEvent = { eventId: string };

function owner(sessionKey = "session-a", generation = 1): SessionOwnerRecord {
	return {
		sessionKey,
		ownerPodId: "pod-a",
		ownerEndpoint: "http://pod-a",
		generation,
		leaseExpiresAt: "2026-08-01T00:00:00.000Z",
		status: "connected",
		lastUsedAt: "2026-07-28T00:00:00.000Z",
	};
}

function request(sessionKey = "session-a", requestId = "request-a"): StatefulOperationRequest {
	const connectionId = `connection-${requestId}`;
	return {
		requestId,
		sessionKey: buildSessionKey({
			providerId: "test-provider",
			serviceAccountId: "account-a",
			connectionId,
			dimensions: { testSessionKey: sessionKey },
		}),
		providerId: "test-provider",
		operationId: "read",
		connectionId,
		serviceAccountId: "account-a",
		input: {},
	};
}

function adapter(
	overrides: Partial<StatefulProviderAdapter<TestSession, TestState, TestEvent>> = {},
): StatefulProviderAdapter<TestSession, TestState, TestEvent> {
	return {
		providerId: "test-provider",
		policy: { concurrency: { mode: "serialize" }, reconnect: "resume" },
		connect: async () => ({ connected: true }),
		invoke: async () => ({ output: "ok" }),
		close: async () => {},
		...overrides,
	};
}

const poolPolicy = {
	maxSessions: 2,
	idleTimeoutMs: "unlimited",
	maxLifetimeMs: "unlimited",
} satisfies SessionPoolPolicy;

describe("StatefulProviderSessionManager adapter contract", () => {
	it("writes returned snapshot state to the checkpoint sink with durable identity", async () => {
		const checkpoints: Array<{ ctx: StatefulProviderSessionContext; state: TestState }> = [];
		const manager = new StatefulProviderSessionManager({
			adapter: adapter({ snapshot: async () => ({ cursor: 42 }) }),
			poolPolicy,
			checkpointStore: async (ctx, state) => {
				checkpoints.push({ ctx, state });
			},
		});
		await manager.invoke(owner(), request(), new AbortController().signal);
		await manager.closeAll("test");

		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0].state).toEqual({ cursor: 42 });
		expect(checkpoints[0].ctx).toMatchObject({
			sessionKey: "session-a",
			connectionId: "connection-request-a",
			serviceAccountId: "account-a",
			ownerPodId: "pod-a",
			ownerEndpoint: "http://pod-a",
			generation: 1,
		});
	});

	it("exposes write reconciliation as an explicit callable runner", async () => {
		let received: unknown;
		const manager = new StatefulProviderSessionManager({
			adapter: adapter({
				restore: async () => ({ cursor: 9 }),
				reconcileWrite: async (ctx, ledgerEntry, sharedState) => {
					received = { ctx, ledgerEntry, sharedState };
					return { result: { output: "reconciled" }, sharedState: { cursor: 10 } };
				},
			}),
			poolPolicy,
		});
		const result = await manager.reconcileWrite(
			owner(),
			request(),
			{ writeId: "write-1" },
			new AbortController().signal,
		);

		expect(received).toMatchObject({
			ledgerEntry: { writeId: "write-1" },
			sharedState: { cursor: 9 },
		});
		expect(result).toEqual({
			result: { output: "reconciled" },
			sharedState: { cursor: 10 },
		});
	});

	it("runs an event-source disposer when capacity eviction closes the session", async () => {
		const disposed: string[] = [];
		const manager = new StatefulProviderSessionManager({
			adapter: adapter({
				subscribe: async (ctx) => () => {
					disposed.push(ctx.sessionKey);
				},
			}),
			poolPolicy: { ...poolPolicy, maxSessions: 1 },
			eventPublisher: { publish: () => {} },
		});
		await manager.invoke(owner("session-a"), request("session-a"), new AbortController().signal);
		await manager.invoke(owner("session-b"), request("session-b"), new AbortController().signal);

		expect(disposed).toEqual(["session-a"]);
		await manager.closeAll("test");
	});

	it('does not retry an invalidated session when reconnect is "unsupported"', async () => {
		let connects = 0;
		let invokes = 0;
		const manager = new StatefulProviderSessionManager({
			adapter: adapter({
				policy: { concurrency: { mode: "serialize" }, reconnect: "unsupported" },
				connect: async () => {
					connects += 1;
					return { connected: true };
				},
				invoke: async () => {
					invokes += 1;
					throw new StatefulSessionInvalidatedError("gone", {
						reason: "transport-closed",
						retryable: true,
					});
				},
			}),
			poolPolicy,
		});

		await expect(
			manager.invoke(owner(), request(), new AbortController().signal),
		).rejects.toBeInstanceOf(StatefulSessionInvalidatedError);
		expect(connects).toBe(1);
		expect(invokes).toBe(1);
	});

	it("rejects contradictory and invalid policies at construction", () => {
		expect(
			() =>
				new StatefulProviderSessionManager({
					adapter: adapter({
						policy: {
							concurrency: { mode: "parallel", maxInFlight: 0 },
							reconnect: "resume",
						},
					}),
					poolPolicy,
				}),
		).toThrow("maxInFlight must be a positive integer");
		expect(
			() =>
				new StatefulProviderSessionManager({
					adapter: adapter({
						policy: {
							// @ts-expect-error test-invalid: runtime validation must reject maxInFlight for serialized adapters.
							concurrency: { mode: "serialize", maxInFlight: 2 },
							reconnect: "resume",
						},
					}),
					poolPolicy,
				}),
		).toThrow("serialize concurrency must not declare maxInFlight");
		expect(
			() =>
				new StatefulProviderSessionManager({
					adapter: adapter({ snapshot: async () => ({}) }),
					poolPolicy,
				}),
		).toThrow("snapshot and session-manager checkpointStore");
		expect(
			() =>
				new StatefulProviderSessionManager({
					adapter: adapter({ subscribe: async () => () => {} }),
					poolPolicy,
				}),
		).toThrow("subscribe and session-manager eventPublisher");
	});

	it("records invalidations separately from LRU evictions", async () => {
		const metricEmitter = new RecordingStatefulProviderMetricEmitter();
		const manager = new StatefulProviderSessionManager({
			adapter: adapter({
				invoke: async () => {
					throw new StatefulSessionInvalidatedError("gone", {
						reason: "transport-closed",
					});
				},
			}),
			poolPolicy,
			metricEmitter,
		});
		await expect(
			manager.invoke(owner(), request(), new AbortController().signal),
		).rejects.toBeInstanceOf(StatefulSessionInvalidatedError);

		expect(metricEmitter.metrics.map((metric) => metric.name)).toContain(
			"apifuse_stateful_provider_session_invalidations_total",
		);
		expect(metricEmitter.metrics.map((metric) => metric.name)).not.toContain(
			"apifuse_stateful_provider_lru_evictions_total",
		);
	});

	it("always closes the connection when snapshot throws", async () => {
		let closed = false;
		const manager = new StatefulProviderSessionManager({
			adapter: adapter({
				snapshot: async () => {
					throw new Error("snapshot failed");
				},
				close: async () => {
					closed = true;
				},
			}),
			poolPolicy,
			checkpointStore: async () => {},
		});
		await manager.invoke(owner(), request(), new AbortController().signal);
		const closeError = await capturedError(manager.closeAll("test"));
		expect(closeError).toBeInstanceOf(AggregateError);
		if (!(closeError instanceof AggregateError)) throw closeError;
		const snapshotError = closeError.errors[0];
		assertIsError(snapshotError);
		expect(snapshotError.message).toBe("snapshot failed");
		expect(closed).toBe(true);
	});

	it("continues closeAll after one session close fails and aggregates failures", async () => {
		const closed: string[] = [];
		const manager = new StatefulProviderSessionManager({
			adapter: adapter({
				close: async (ctx) => {
					closed.push(ctx.sessionKey);
					if (ctx.sessionKey === "session-a") throw new Error("first close failed");
				},
			}),
			poolPolicy,
		});
		await manager.invoke(owner("session-a"), request("session-a"), new AbortController().signal);
		await manager.invoke(owner("session-b"), request("session-b"), new AbortController().signal);

		await expect(manager.closeAll("test")).rejects.toBeInstanceOf(AggregateError);
		expect(closed).toEqual(["session-a", "session-b"]);
	});

	it("waits for a slow subscription, disposes it, and suppresses events after closeAll", async () => {
		let releaseSubscribe: (() => void) | undefined;
		let markSubscribeStarted: (() => void) | undefined;
		const subscribeStarted = new Promise<void>((resolve) => {
			markSubscribeStarted = resolve;
		});
		const subscribeGate = new Promise<void>((resolve) => {
			releaseSubscribe = resolve;
		});
		let publishFromSubscription: StatefulProviderEventPublish<TestEvent> | undefined;
		let publishes = 0;
		let publishesAfterClose = 0;
		let closeResolved = false;
		let disposers = 0;
		let closes = 0;
		const manager = new StatefulProviderSessionManager({
			adapter: adapter({
				subscribe: async (_ctx, _session, publish) => {
					publishFromSubscription = publish;
					markSubscribeStarted?.();
					await subscribeGate;
					await publish({ eventId: "during-shutdown" });
					return () => {
						disposers += 1;
					};
				},
				close: async () => {
					closes += 1;
				},
			}),
			poolPolicy,
			eventPublisher: {
				publish: () => {
					publishes += 1;
					if (closeResolved) publishesAfterClose += 1;
				},
			},
		});
		const invoking = manager.invoke(owner(), request(), new AbortController().signal);
		await subscribeStarted;
		const closing = manager.closeAll("shutdown").then(() => {
			closeResolved = true;
		});

		await Bun.sleep(5);
		expect(closeResolved).toBe(false);
		releaseSubscribe?.();
		await expect(invoking).rejects.toThrow("pool is closed; cannot get or create session");
		await closing;
		await publishFromSubscription?.({ eventId: "after-shutdown" });

		expect({ closes, disposers, publishes, publishesAfterClose }).toEqual({
			closes: 1,
			disposers: 1,
			publishes: 1,
			publishesAfterClose: 0,
		});
		await expect(
			manager.invoke(owner(), request(), new AbortController().signal),
		).rejects.toThrow("pool is closed; cannot get or create session");
	});

	it("binds the authoritative owner fence to adapter events for each generation", async () => {
		const fences: ProviderEventOwnerFence[] = [];
		const manager = new StatefulProviderSessionManager({
			adapter: adapter({
				subscribe: async (ctx, _session, publish) => {
					await publish({ eventId: `event-${ctx.generation}` });
					return () => {};
				},
			}),
			poolPolicy,
			eventPublisher: {
				publish: (_event, options) => fences.push(options.ownerFence),
			},
		});

		await manager.invoke(owner("session-a", 1), request(), new AbortController().signal);
		await manager.invoke(owner("session-a", 2), request(), new AbortController().signal);

		expect(
			fences.map((fence) => ({
				...fence,
				sessionKey: parseSessionKey(fence.sessionKey).dimensions?.testSessionKey,
			})),
		).toEqual([
			{
				sessionKey: "session-a",
				generation: 1,
				ownerPodId: "pod-a",
				ownerEndpoint: "http://pod-a",
			},
			{
				sessionKey: "session-a",
				generation: 2,
				ownerPodId: "pod-a",
				ownerEndpoint: "http://pod-a",
			},
		]);
		await manager.closeAll("test");
	});

	it("serializes health checks behind invokes and applies ownership validation", async () => {
		let releaseInvoke: (() => void) | undefined;
		let markInvokeStarted: (() => void) | undefined;
		const invokeStarted = new Promise<void>((resolve) => {
			markInvokeStarted = resolve;
		});
		const invokeGate = new Promise<void>((resolve) => {
			releaseInvoke = resolve;
		});
		let healthCalls = 0;
		let validations = 0;
		const manager = new StatefulProviderSessionManager({
			adapter: adapter({
				invoke: async () => {
					markInvokeStarted?.();
					await invokeGate;
					return { output: "ok" };
				},
				health: async () => {
					healthCalls += 1;
					return { status: "ready" };
				},
			}),
			poolPolicy,
		});
		const invoking = manager.invoke(owner(), request(), new AbortController().signal);
		await invokeStarted;
		const checking = manager.health(
			owner(),
			request(),
			new AbortController().signal,
			async (expected) => {
				validations += 1;
				return expected;
			},
		);
		await Bun.sleep(5);
		expect(healthCalls).toBe(0);
		releaseInvoke?.();
		await invoking;
		expect(await checking).toEqual({ status: "ready" });
		expect(healthCalls).toBe(1);
		expect(validations).toBe(1);
		await manager.closeAll("test");
	});
});
