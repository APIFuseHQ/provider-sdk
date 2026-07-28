import { describe, expect, it } from "bun:test";

import {
	RecordingStatefulProviderMetricEmitter,
	StatefulProviderSessionManager,
	StatefulSessionInvalidatedError,
} from "../../dist/stateful/index.js";

function owner(sessionKey = "session-a", generation = 1) {
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

function request(sessionKey = "session-a", requestId = "request-a") {
	return {
		requestId,
		sessionKey,
		providerId: "test-provider",
		operationId: "read",
		connectionId: `connection-${requestId}`,
		serviceAccountId: "account-a",
		input: {},
	};
}

function adapter(overrides = {}) {
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
};

describe("StatefulProviderSessionManager adapter contract", () => {
	it("writes returned snapshot state to the checkpoint sink with durable identity", async () => {
		const checkpoints = [];
		const manager = new StatefulProviderSessionManager({
			adapter: adapter({ snapshot: async () => ({ cursor: 42 }) }),
			poolPolicy,
			checkpointStore: async (ctx, state) => checkpoints.push({ ctx, state }),
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
		const disposed = [];
		const manager = new StatefulProviderSessionManager({
			adapter: adapter({
				subscribe: async (ctx) => () => disposed.push(ctx.sessionKey),
			}),
			poolPolicy: { ...poolPolicy, maxSessions: 1 },
			eventPublisher: async () => {},
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
					return {};
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
		const closeError = await manager.closeAll("test").catch((error) => error);
		expect(closeError).toBeInstanceOf(AggregateError);
		expect(closeError.errors[0].message).toBe("snapshot failed");
		expect(closed).toBe(true);
	});

	it("continues closeAll after one session close fails and aggregates failures", async () => {
		const closed = [];
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
});
