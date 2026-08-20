import { describe, expect, it } from "bun:test";

import type {
	SessionOwnerRegistry,
	StatefulOperationRequest,
	StatefulOwnerForwarder,
	StatefulProviderAdapter,
} from "../stateful/index.js";
import { capturedError } from "./test-utils.js";

const builtStatefulSpecifier: string = "../../dist/stateful/index.js";
const builtStateful: Promise<typeof import("../stateful/index.js")> = import(
	builtStatefulSpecifier
);
const {
	buildSessionKey,
	InMemorySessionOwnerRegistry,
	StatefulProviderSessionManager,
	StatefulRoutingOwnershipError,
	StatefulSessionInvalidatedError,
	StatefulSessionRouter,
} = await builtStateful;

const sessionKey = buildSessionKey({
	providerId: "test-provider",
	serviceAccountId: "account-1",
	connectionId: "connection-1",
	dimensions: {},
});

function request(overrides: Partial<StatefulOperationRequest> = {}): StatefulOperationRequest {
	return {
		requestId: "request-1",
		sessionKey,
		providerId: "test-provider",
		operationId: "read",
		connectionId: "connection-1",
		serviceAccountId: "account-1",
		input: {},
		...overrides,
	};
}

const currentPod = { podId: "pod-a", endpoint: "http://pod-a" };
const unusedForwarder: StatefulOwnerForwarder = {
	forward: async () => {
		throw new Error("unexpected forward");
	},
};

describe("StatefulSessionRouter deadlines", () => {
	it("keeps the deadline armed until a slow operation settles", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		let abortedAfterDeadline = false;
		const router = new StatefulSessionRouter({
			currentPod,
			registry,
			forwarder: unusedForwarder,
			executor: {
				executeLocal: async (_request, _owner, signal) => {
					await Bun.sleep(45);
					abortedAfterDeadline = signal.aborted;
					return { output: null };
				},
			},
			leaseDurationMs: 1_000,
		});

		await router.route(request({ deadlineAt: new Date(Date.now() + 15).toISOString() }));
		expect(abortedAfterDeadline).toBe(true);
		await router.release();
	});

	it("cleans up a fast operation deadline and passes its signal to registry calls", async () => {
		const backing = new InMemorySessionOwnerRegistry();
		const signals: Array<AbortSignal | undefined> = [];
		let operationSignal: AbortSignal | undefined;
		const registry: SessionOwnerRegistry = {
			resolve: (key, now, signal) => {
				signals.push(signal);
				return backing.resolve(key, now, signal);
			},
			acquire: (input, signal) => {
				signals.push(signal);
				return backing.acquire(input, signal);
			},
			renew: (input, signal) => backing.renew(input, signal),
			release: (input, signal) => backing.release(input, signal),
		};
		const router = new StatefulSessionRouter({
			currentPod,
			registry,
			forwarder: unusedForwarder,
			executor: {
				executeLocal: async (_request, _owner, signal) => {
					operationSignal = signal;
					return { output: "fast" };
				},
			},
			leaseDurationMs: 1_000,
		});

		await router.route(request({ deadlineAt: new Date(Date.now() + 25).toISOString() }));
		expect(signals).toHaveLength(3);
		expect(signals[0]).toBe(operationSignal);
		expect(signals[1]).toBe(operationSignal);
		expect(signals[2]).toBe(operationSignal);
		await Bun.sleep(35);
		expect(operationSignal?.aborted).toBe(false);
		await router.release();
	});
});

describe("StatefulSessionRouter lease lifecycle", () => {
	it("skips a failed-establishment release after a newer local attempt succeeds", async () => {
		const backing = new InMemorySessionOwnerRegistry();
		let releaseCalls = 0;
		const registry: SessionOwnerRegistry = {
			resolve: (...args) => backing.resolve(...args),
			acquire: (...args) => backing.acquire(...args),
			renew: (...args) => backing.renew(...args),
			release: (...args) => {
				releaseCalls += 1;
				return backing.release(...args);
			},
		};
		let releaseFirstAttempt: (() => void) | undefined;
		let markFirstAttemptStarted: (() => void) | undefined;
		const firstAttemptStarted = new Promise<void>((resolve) => {
			markFirstAttemptStarted = resolve;
		});
		const firstAttemptGate = new Promise<void>((resolve) => {
			releaseFirstAttempt = resolve;
		});
		const establishmentFailure = new Error("first establishment failed");
		Object.defineProperty(
			establishmentFailure,
			Symbol.for("@apifuse/provider-sdk/stateful/session-establishment-failure@1"),
			{ value: true },
		);
		const router = new StatefulSessionRouter({
			currentPod,
			registry,
			forwarder: unusedForwarder,
			executor: {
				executeLocal: async (operationRequest, owner, signal, validateOwnership) => {
					if (operationRequest.requestId === "request-a") {
						markFirstAttemptStarted?.();
						await firstAttemptGate;
						throw establishmentFailure;
					}
					await validateOwnership?.(owner, signal);
					return { output: "connected" };
				},
			},
			leaseDurationMs: 1_000,
		});

		const firstRoute = capturedError(router.route(request({ requestId: "request-a" })));
		await firstAttemptStarted;
		await expect(router.route(request({ requestId: "request-b" }))).resolves.toEqual({
			output: "connected",
		});
		releaseFirstAttempt?.();
		expect(await firstRoute).toBe(establishmentFailure);
		expect(releaseCalls).toBe(0);
		expect(await backing.resolve(sessionKey)).toMatchObject({
			ownerPodId: currentPod.podId,
			generation: 1,
			status: "connected",
		});

		await router.release();
	});

	it("serializes a suspended failed-establishment release before a newer local attempt", async () => {
		const backing = new InMemorySessionOwnerRegistry();
		let resolveCalls = 0;
		let markReleaseStarted: (() => void) | undefined;
		let resumeRelease: (() => void) | undefined;
		const releaseStarted = new Promise<void>((resolve) => {
			markReleaseStarted = resolve;
		});
		const releaseGate = new Promise<void>((resolve) => {
			resumeRelease = resolve;
		});
		const registry: SessionOwnerRegistry = {
			resolve: (...args) => {
				resolveCalls += 1;
				return backing.resolve(...args);
			},
			acquire: (...args) => backing.acquire(...args),
			renew: (...args) => backing.renew(...args),
			release: async (...args) => {
				markReleaseStarted?.();
				await releaseGate;
				return backing.release(...args);
			},
		};
		let releaseFirstAttempt: (() => void) | undefined;
		let markFirstAttemptStarted: (() => void) | undefined;
		const firstAttemptStarted = new Promise<void>((resolve) => {
			markFirstAttemptStarted = resolve;
		});
		const firstAttemptGate = new Promise<void>((resolve) => {
			releaseFirstAttempt = resolve;
		});
		const establishmentFailure = new Error("first establishment failed");
		Object.defineProperty(
			establishmentFailure,
			Symbol.for("@apifuse/provider-sdk/stateful/session-establishment-failure@1"),
			{ value: true },
		);
		const router = new StatefulSessionRouter({
			currentPod,
			registry,
			forwarder: unusedForwarder,
			executor: {
				executeLocal: async (operationRequest, owner, signal, validateOwnership) => {
					if (operationRequest.requestId === "request-a") {
						markFirstAttemptStarted?.();
						await firstAttemptGate;
						throw establishmentFailure;
					}
					await validateOwnership?.(owner, signal);
					return { output: "connected" };
				},
			},
			leaseDurationMs: 1_000,
		});

		const firstRoute = capturedError(router.route(request({ requestId: "request-a" })));
		await firstAttemptStarted;
		releaseFirstAttempt?.();
		await releaseStarted;
		const resolvesBeforeNewAttempt = resolveCalls;
		const secondRoute = router.route(request({ requestId: "request-b" }));
		await Bun.sleep(0);
		expect(resolveCalls).toBe(resolvesBeforeNewAttempt);
		resumeRelease?.();
		expect(await firstRoute).toBe(establishmentFailure);
		await expect(secondRoute).resolves.toEqual({
			output: "connected",
		});
		expect(await backing.resolve(sessionKey)).toMatchObject({
			ownerPodId: currentPod.podId,
			generation: 2,
			status: "connected",
		});

		await router.release();
	});

	it("releases a failed establishment lease, stops renewal, and permits generation+1 takeover", async () => {
		const backing = new InMemorySessionOwnerRegistry();
		let renewCalls = 0;
		let releaseCalls = 0;
		const registry: SessionOwnerRegistry = {
			resolve: (...args) => backing.resolve(...args),
			acquire: (...args) => backing.acquire(...args),
			renew: (...args) => {
				renewCalls += 1;
				return backing.renew(...args);
			},
			release: (...args) => {
				releaseCalls += 1;
				return backing.release(...args);
			},
		};
		const failedManager = new StatefulProviderSessionManager({
			adapter: makeAdapter({
				connect: async () => {
					throw new Error("connect failed");
				},
			}),
			poolPolicy: { maxSessions: 2, idleTimeoutMs: 60_000, maxLifetimeMs: 60_000 },
		});
		const failedRouter = new StatefulSessionRouter({
			currentPod,
			registry,
			forwarder: unusedForwarder,
			executor: failedManager,
			leaseDurationMs: 60,
			leaseRenewalFraction: 0.25,
		});

		await expect(failedRouter.route(request())).rejects.toThrow("connect failed");
		expect(releaseCalls).toBe(1);
		expect(failedRouter.latestLocalAttemptCountForTesting).toBe(0);
		expect(await backing.resolve(sessionKey)).toBeNull();
		const renewsAfterFailure = renewCalls;
		await Bun.sleep(40);
		expect(renewCalls).toBe(renewsAfterFailure);

		let acquiredGeneration = 0;
		const nextRouter = new StatefulSessionRouter({
			currentPod: { podId: "pod-b", endpoint: "http://pod-b" },
			registry,
			forwarder: unusedForwarder,
			executor: {
				executeLocal: async (_request, owner) => {
					acquiredGeneration = owner.generation;
					return { output: "ok" };
				},
			},
			leaseDurationMs: 1_000,
		});
		await nextRouter.route(request());
		expect(acquiredGeneration).toBe(2);
		await nextRouter.release();
	});

	it("cleans the latest local attempt after releaseSession completes", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		const router = new StatefulSessionRouter({
			currentPod,
			registry,
			forwarder: unusedForwarder,
			executor: {
				executeLocal: async () => ({ output: "ok" }),
			},
			leaseDurationMs: 1_000,
		});

		await router.route(request());
		expect(router.latestLocalAttemptCountForTesting).toBe(1);
		await expect(router.releaseSession(sessionKey)).resolves.toBe(true);
		expect(router.latestLocalAttemptCountForTesting).toBe(0);
	});

	it("renews held sessions, connects before marking connected, and stops on release", async () => {
		const backing = new InMemorySessionOwnerRegistry();
		let renewCalls = 0;
		const registry: SessionOwnerRegistry = {
			resolve: (...args) => backing.resolve(...args),
			acquire: (...args) => backing.acquire(...args),
			renew: (...args) => {
				renewCalls += 1;
				return backing.renew(...args);
			},
			release: (...args) => backing.release(...args),
		};
		let statusDuringConnect: string | undefined;
		const adapter = makeAdapter({
			connect: async () => {
				statusDuringConnect = (await backing.resolve(sessionKey))?.status;
				return { connected: true };
			},
		});
		const manager = new StatefulProviderSessionManager({
			adapter,
			poolPolicy: { maxSessions: 2, idleTimeoutMs: 60_000, maxLifetimeMs: 60_000 },
		});
		const router = new StatefulSessionRouter({
			currentPod,
			registry,
			forwarder: unusedForwarder,
			executor: manager,
			leaseDurationMs: 60,
			leaseRenewalFraction: 0.25,
		});

		await router.route(request());
		expect(statusDuringConnect).toBe("acquiring");
		expect((await backing.resolve(sessionKey))?.status).toBe("connected");
		const renewsAfterInvoke = renewCalls;
		await Bun.sleep(40);
		expect(renewCalls).toBeGreaterThan(renewsAfterInvoke);

		await router.release();
		const renewsAfterRelease = renewCalls;
		await Bun.sleep(40);
		expect(renewCalls).toBe(renewsAfterRelease);
		expect(await backing.resolve(sessionKey)).toBeNull();
		await manager.closeAll("test-complete");
	});

	it("rejects ownership loss after connect without invoking the adapter", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		let invokeCalls = 0;
		let closeCalls = 0;
		let subscribeCalls = 0;
		let published = 0;
		const adapter = makeAdapter({
			connect: async () => {
				await replaceOwner(registry, 1);
				return { connected: true };
			},
			invoke: async () => {
				invokeCalls += 1;
				return { output: "unexpected" };
			},
			subscribe: async (_ctx, _session, publish) => {
				subscribeCalls += 1;
				await publish({ eventId: "event-stale" });
				return () => {};
			},
			close: async () => {
				closeCalls += 1;
			},
		});
		const manager = new StatefulProviderSessionManager({
			adapter,
			poolPolicy: { maxSessions: 2, idleTimeoutMs: 60_000, maxLifetimeMs: 60_000 },
			eventPublisher: {
				publish: () => {
					published += 1;
				},
			},
		});
		const router = new StatefulSessionRouter({
			currentPod,
			registry,
			forwarder: unusedForwarder,
			executor: manager,
			leaseDurationMs: 1_000,
		});

		await expect(router.route(request())).rejects.toBeInstanceOf(StatefulRoutingOwnershipError);
		expect(invokeCalls).toBe(0);
		expect(subscribeCalls).toBe(0);
		expect(published).toBe(0);
		expect(closeCalls).toBe(1);
		await manager.closeAll("test-complete");
		expect(closeCalls).toBe(1);
	});

	it("revalidates after reconnect and does not double-execute after ownership loss", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		let connectCalls = 0;
		let invokeCalls = 0;
		const adapter = makeAdapter({
			connect: async () => {
				connectCalls += 1;
				if (connectCalls === 2) await replaceOwner(registry, 1);
				return { connection: connectCalls };
			},
			invoke: async () => {
				invokeCalls += 1;
				throw new StatefulSessionInvalidatedError("reconnect", {
					reason: "connection-lost",
					retryable: true,
				});
			},
		});
		const manager = new StatefulProviderSessionManager({
			adapter,
			poolPolicy: { maxSessions: 2, idleTimeoutMs: 60_000, maxLifetimeMs: 60_000 },
		});
		const router = new StatefulSessionRouter({
			currentPod,
			registry,
			forwarder: unusedForwarder,
			executor: manager,
			leaseDurationMs: 1_000,
		});

		await expect(router.route(request())).rejects.toBeInstanceOf(StatefulRoutingOwnershipError);
		expect(connectCalls).toBe(2);
		expect(invokeCalls).toBe(1);
		await manager.closeAll("test-complete");
	});
});

type TestProviderEvent = { readonly eventId: string };

function makeAdapter(
	overrides: Partial<StatefulProviderAdapter<unknown, unknown, TestProviderEvent>> = {},
): StatefulProviderAdapter<unknown, unknown, TestProviderEvent> {
	return {
		providerId: "test-provider",
		policy: { concurrency: { mode: "serialize" }, reconnect: "resume" },
		connect: async () => ({}),
		invoke: async () => ({ output: "ok" }),
		close: async () => {},
		...overrides,
	};
}

async function replaceOwner(registry: SessionOwnerRegistry, generation: number): Promise<void> {
	expect(
		await registry.release({
			sessionKey,
			ownerPodId: "pod-a",
			generation,
		}),
	).toBe(true);
	const replacement = await registry.acquire({
		sessionKey,
		ownerPodId: "pod-b",
		ownerEndpoint: "http://pod-b",
		leaseDurationMs: 60_000,
	});
	expect(replacement.record.generation).toBe(generation + 1);
}
