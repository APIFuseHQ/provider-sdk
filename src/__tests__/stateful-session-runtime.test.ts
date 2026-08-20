import { describe, expect, it } from "bun:test";

const builtStatefulSpecifier: string = "../../dist/stateful/index.js";
const builtStateful: Promise<typeof import("../stateful/index.js")> = import(
	builtStatefulSpecifier
);
const { buildSessionKey, InMemorySessionOwnerRegistry, PodLocalSessionPool } =
	await builtStateful;

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
		await expect(creating).rejects.toThrow(
			'pool is closed; cannot get or create session "slow"',
		);
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
