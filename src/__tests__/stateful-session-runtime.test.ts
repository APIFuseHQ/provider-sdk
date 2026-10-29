import { describe, expect, it } from "bun:test";

const builtStatefulSpecifier: string = "../../dist/stateful/index.js";
const builtStateful: Promise<typeof import("../stateful/index.js")> = import(
	builtStatefulSpecifier
);
const { buildSessionKey, InMemorySessionOwnerRegistry, PodLocalSessionPool } = await builtStateful;

function testSessionKey(connectionId: string) {
	return buildSessionKey({
		providerId: "test-provider",
		serviceAccountId: "test-service-account",
		connectionId,
	});
}

describe("InMemorySessionOwnerRegistry", () => {
	it("preserves lease generations and rejects stale renewals and releases", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		const sessionKey = testSessionKey("session-1");
		const startedAt = new Date("2026-01-01T00:00:00.000Z");
		const first = await registry.acquire({
			sessionKey,
			ownerPodId: "pod-a",
			ownerEndpoint: "http://pod-a",
			leaseDurationMs: 1_000,
			status: "connected",
			now: startedAt,
		});

		expect(first.acquired).toBe(true);
		expect(first.record.generation).toBe(1);
		expect(await registry.resolve(sessionKey, new Date(startedAt.getTime() + 500))).toEqual(
			first.record,
		);

		const conflict = await registry.acquire({
			sessionKey,
			ownerPodId: "pod-b",
			ownerEndpoint: "http://pod-b",
			leaseDurationMs: 1_000,
			now: new Date(startedAt.getTime() + 500),
		});
		expect(conflict).toEqual({ record: first.record, acquired: false });

		const renewed = await registry.renew({
			sessionKey,
			ownerPodId: "pod-a",
			generation: 1,
			leaseDurationMs: 2_000,
			now: new Date(startedAt.getTime() + 600),
		});
		expect(renewed?.generation).toBe(1);
		expect(renewed?.leaseExpiresAt).toBe("2026-01-01T00:00:02.600Z");

		expect(
			await registry.renew({
				sessionKey,
				ownerPodId: "pod-a",
				generation: 2,
				leaseDurationMs: 1_000,
				now: new Date(startedAt.getTime() + 700),
			}),
		).toBeNull();
		expect(
			await registry.release({
				sessionKey,
				ownerPodId: "pod-a",
				generation: 2,
			}),
		).toBe(false);
		expect(
			await registry.release({
				sessionKey,
				ownerPodId: "pod-a",
				generation: 1,
			}),
		).toBe(true);
		expect(await registry.resolve(sessionKey)).toBeNull();
	});

	it("increments generation after an expired owner is replaced", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		const sessionKey = testSessionKey("session-1");
		const startedAt = new Date("2026-01-01T00:00:00.000Z");
		await registry.acquire({
			sessionKey,
			ownerPodId: "pod-a",
			ownerEndpoint: "http://pod-a",
			leaseDurationMs: 100,
			now: startedAt,
		});

		const replacement = await registry.acquire({
			sessionKey,
			ownerPodId: "pod-b",
			ownerEndpoint: "http://pod-b",
			leaseDurationMs: 1_000,
			now: new Date(startedAt.getTime() + 100),
		});

		expect(replacement.acquired).toBe(true);
		expect(replacement.record.generation).toBe(2);
		expect(
			await registry.renew({
				sessionKey,
				ownerPodId: "pod-a",
				generation: 1,
				leaseDurationMs: 1_000,
			}),
		).toBeNull();
		expect(
			await registry.release({
				sessionKey,
				ownerPodId: "pod-a",
				generation: 1,
			}),
		).toBe(false);
	});

	it("increments generation after release and rejects the released generation", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		const sessionKey = testSessionKey("released-session");
		const first = await registry.acquire({
			sessionKey,
			ownerPodId: "pod-a",
			ownerEndpoint: "http://pod-a",
			leaseDurationMs: 60_000,
		});
		expect(first.record.generation).toBe(1);
		expect(
			await registry.release({
				sessionKey,
				ownerPodId: "pod-a",
				generation: 1,
			}),
		).toBe(true);

		const second = await registry.acquire({
			sessionKey,
			ownerPodId: "pod-a",
			ownerEndpoint: "http://pod-a",
			leaseDurationMs: 60_000,
		});
		expect(second.record.generation).toBe(2);
		expect(
			await registry.renew({
				sessionKey,
				ownerPodId: "pod-a",
				generation: 1,
				leaseDurationMs: 60_000,
			}),
		).toBeNull();
		expect(
			await registry.release({
				sessionKey,
				ownerPodId: "pod-a",
				generation: 1,
			}),
		).toBe(false);
	});

	it("rejects generation zero at runtime boundaries", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		const sessionKey = testSessionKey("invalid-generation");
		await expect(
			registry.renew({
				sessionKey,
				ownerPodId: "pod-a",
				generation: 0,
				leaseDurationMs: 60_000,
			}),
		).rejects.toThrow("positive integer");
		await expect(
			registry.release({
				sessionKey,
				ownerPodId: "pod-a",
				generation: 0,
			}),
		).rejects.toThrow("positive integer");
	});
});

describe("PodLocalSessionPool", () => {
	it("drains an in-flight creation and rejects creation after closeAll starts", async () => {
		const closed: Array<{ key: string; reason: string }> = [];
		let releaseFactory: ((value: string) => void) | undefined;
		let markFactoryStarted: (() => void) | undefined;
		const factoryStarted = new Promise<void>((resolve) => {
			markFactoryStarted = resolve;
		});
		const factoryGate = new Promise<string>((resolve) => {
			releaseFactory = resolve;
		});
		const pool = new PodLocalSessionPool<string>(
			{ maxSessions: 2, idleTimeoutMs: 60_000, maxLifetimeMs: 60_000 },
			(session, reason) => {
				closed.push({ key: session.sessionKey, reason });
			},
		);
		const creating = pool.getOrCreate("slow", 1, async () => {
			markFactoryStarted?.();
			return factoryGate;
		});
		await factoryStarted;
		let closeResolved = false;
		const closing = pool.closeAll("shutdown").then(() => {
			closeResolved = true;
		});

		await Bun.sleep(5);
		expect(closeResolved).toBe(false);
		await expect(pool.getOrCreate("new", 1, () => "new")).rejects.toThrow(
			'pool is closed; cannot get or create session "new"',
		);
		releaseFactory?.("created");
		await expect(creating).rejects.toThrow('pool is closed; cannot get or create session "slow"');
		await closing;
		expect(closed).toEqual([{ key: "slow", reason: "shutdown" }]);
		await pool.invalidate("slow", "should-be-empty");
		expect(closed).toHaveLength(1);
	});

	it("evicts the least recently used session at capacity", async () => {
		const closed: Array<{ key: string; reason: string }> = [];
		const pool = new PodLocalSessionPool<string>(
			{ maxSessions: 2, idleTimeoutMs: 60_000, maxLifetimeMs: 60_000 },
			(session, reason) => {
				closed.push({ key: session.sessionKey, reason });
			},
		);
		const startedAt = new Date("2026-01-01T00:00:00.000Z");
		await pool.getOrCreate("a", 1, () => "a", startedAt);
		await pool.getOrCreate("b", 1, () => "b", new Date(startedAt.getTime() + 1));
		await pool.getOrCreate("a", 1, () => "unused", new Date(startedAt.getTime() + 2));
		await pool.getOrCreate("c", 1, () => "c", new Date(startedAt.getTime() + 3));

		expect(closed).toEqual([{ key: "b", reason: "capacity" }]);
		expect(
			(await pool.getOrCreate("a", 1, () => "unused", new Date(startedAt.getTime() + 4))).value,
		).toBe("a");
	});

	it("serializes work per session key", async () => {
		const pool = new PodLocalSessionPool<string>(
			{ maxSessions: 2, idleTimeoutMs: 60_000, maxLifetimeMs: 60_000 },
			() => {},
		);
		const order: string[] = [];
		let active = 0;
		let maxActive = 0;
		const task = (name: string) =>
			pool.runExclusive("same-session", async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				order.push(`start-${name}`);
				await new Promise((resolve) => setTimeout(resolve, 2));
				order.push(`end-${name}`);
				active -= 1;
			});

		await Promise.all([task("a"), task("b"), task("c")]);

		expect(maxActive).toBe(1);
		expect(order).toEqual(["start-a", "end-a", "start-b", "end-b", "start-c", "end-c"]);
	});
});

type Gate = { readonly promise: Promise<void>; readonly open: () => void };

function gate(): Gate {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

type Outcome = { readonly settled: "resolved" | "rejected"; readonly value: unknown } | "pending";

// How `promise` stands once the tasks queued so far have had their turn. A
// queue wait that ignores the signal stays "pending" here.
async function outcomeSoon(promise: Promise<unknown>): Promise<Outcome> {
	const pending = Bun.sleep(1_000).then((): Outcome => "pending");
	return Promise.race([
		promise.then(
			(value): Outcome => ({ settled: "resolved", value }),
			(value): Outcome => ({ settled: "rejected", value }),
		),
		pending,
	]);
}

function testPool() {
	return new PodLocalSessionPool<string>(
		{ maxSessions: 2, idleTimeoutMs: 60_000, maxLifetimeMs: 60_000 },
		() => {},
	);
}

describe("PodLocalSessionPool.runExclusive with the caller's signal", () => {
	it("lets a waiter whose signal aborts leave at once, without running it or reordering the rest", async () => {
		const pool = testPool();
		const order: string[] = [];
		const holdA = gate();
		const startedA = gate();
		const a = pool.runExclusive("same-session", async () => {
			order.push("start-a");
			startedA.open();
			await holdA.promise;
			order.push("end-a");
			return "a";
		});
		const controller = new AbortController();
		let bRuns = 0;
		const b = pool.runExclusive(
			"same-session",
			async () => {
				bRuns += 1;
				order.push("start-b");
			},
			controller.signal,
		);
		const c = pool.runExclusive("same-session", async () => {
			order.push("start-c");
			await Bun.sleep(1);
			order.push("end-c");
			return "c";
		});
		await startedA.promise;
		const reason = new Error("b's caller went away");
		controller.abort(reason);

		// b leaves while a still holds the session.
		expect(await outcomeSoon(b)).toEqual({ settled: "rejected", value: reason });
		expect(order).toEqual(["start-a"]);
		holdA.open();
		expect(await a).toBe("a");
		expect(await c).toBe("c");
		expect(bRuns).toBe(0);
		expect(order).toEqual(["start-a", "end-a", "start-c", "end-c"]);
	});

	it("removes its abort listener when its turn comes", async () => {
		const pool = testPool();
		const signal = new AbortController().signal;
		let added = 0;
		let removed = 0;
		const addEventListener = signal.addEventListener.bind(signal);
		const removeEventListener = signal.removeEventListener.bind(signal);
		signal.addEventListener = (...args: Parameters<AbortSignal["addEventListener"]>) => {
			added += 1;
			addEventListener(...args);
		};
		signal.removeEventListener = (...args: Parameters<AbortSignal["removeEventListener"]>) => {
			removed += 1;
			removeEventListener(...args);
		};
		// One long-lived signal, without a deadline, used by several queued tasks.
		for (const name of ["first", "second", "third"]) {
			const hold = gate();
			const holding = pool.runExclusive("same-session", () => hold.promise);
			const queued = pool.runExclusive("same-session", async () => name, signal);
			const listeningWhileQueued = added - removed;
			hold.open();
			await holding;
			expect(await queued).toBe(name);
			expect(listeningWhileQueued).toBe(1);
		}
		expect(added).toBe(3);
		expect(removed).toBe(added);
	});

	it("rejects an already aborted signal without queueing the task", async () => {
		const pool = testPool();
		const hold = gate();
		const holding = pool.runExclusive("same-session", () => hold.promise);
		const controller = new AbortController();
		const reason = new Error("aborted before queueing");
		controller.abort(reason);
		let runs = 0;
		const rejected = pool.runExclusive(
			"same-session",
			async () => {
				runs += 1;
			},
			controller.signal,
		);
		expect(await outcomeSoon(rejected)).toEqual({ settled: "rejected", value: reason });
		const next = pool.runExclusive("same-session", async () => "next");
		hold.open();
		await holding;
		expect(await next).toBe("next");
		expect(runs).toBe(0);
	});

	it("lets a task that has started run to its end when its signal aborts", async () => {
		const pool = testPool();
		const controller = new AbortController();
		const hold = gate();
		const started = gate();
		let settled = false;
		const running = pool.runExclusive(
			"same-session",
			async () => {
				started.open();
				await hold.promise;
				return "finished";
			},
			controller.signal,
		);
		void running.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await started.promise;
		controller.abort(new Error("aborted after the task started"));
		await Bun.sleep(5);
		expect(settled).toBe(false);
		hold.open();
		expect(await running).toBe("finished");
	});

	it("skips a task whose signal is aborted in the turn its predecessor finishes", async () => {
		const pool = testPool();
		const controller = new AbortController();
		const reason = new Error("aborted as the predecessor returned");
		const order: string[] = [];
		const a = pool.runExclusive("same-session", async () => {
			order.push("a");
			await Bun.sleep(1);
			controller.abort(reason);
			return "a";
		});
		let bRuns = 0;
		const b = pool.runExclusive(
			"same-session",
			async () => {
				bRuns += 1;
				order.push("b");
			},
			controller.signal,
		);
		const c = pool.runExclusive("same-session", async () => {
			order.push("c");
			return "c";
		});
		expect(await a).toBe("a");
		expect(await outcomeSoon(b)).toEqual({ settled: "rejected", value: reason });
		expect(await c).toBe("c");
		expect(bRuns).toBe(0);
		expect(order).toEqual(["a", "c"]);
	});
});
