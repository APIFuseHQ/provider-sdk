import { describe, expect, it } from "bun:test";

import { InMemorySessionOwnerRegistry, PodLocalSessionPool } from "../../dist/stateful/index.js";

describe("InMemorySessionOwnerRegistry", () => {
	it("preserves lease generations and rejects stale renewals and releases", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		const startedAt = new Date("2026-01-01T00:00:00.000Z");
		const first = await registry.acquire({
			sessionKey: "session-1",
			ownerPodId: "pod-a",
			ownerEndpoint: "http://pod-a",
			leaseDurationMs: 1_000,
			status: "connected",
			now: startedAt,
		});

		expect(first.acquired).toBe(true);
		expect(first.record.generation).toBe(1);
		expect(await registry.resolve("session-1", new Date(startedAt.getTime() + 500))).toEqual(
			first.record,
		);

		const conflict = await registry.acquire({
			sessionKey: "session-1",
			ownerPodId: "pod-b",
			ownerEndpoint: "http://pod-b",
			leaseDurationMs: 1_000,
			now: new Date(startedAt.getTime() + 500),
		});
		expect(conflict).toEqual({ record: first.record, acquired: false });

		const renewed = await registry.renew({
			sessionKey: "session-1",
			ownerPodId: "pod-a",
			generation: 1,
			leaseDurationMs: 2_000,
			now: new Date(startedAt.getTime() + 600),
		});
		expect(renewed?.generation).toBe(1);
		expect(renewed?.leaseExpiresAt).toBe("2026-01-01T00:00:02.600Z");

		expect(
			await registry.renew({
				sessionKey: "session-1",
				ownerPodId: "pod-a",
				generation: 2,
				leaseDurationMs: 1_000,
				now: new Date(startedAt.getTime() + 700),
			}),
		).toBeNull();
		expect(
			await registry.release({
				sessionKey: "session-1",
				ownerPodId: "pod-a",
				generation: 2,
			}),
		).toBe(false);
		expect(
			await registry.release({
				sessionKey: "session-1",
				ownerPodId: "pod-a",
				generation: 1,
			}),
		).toBe(true);
		expect(await registry.resolve("session-1")).toBeNull();
	});

	it("increments generation after an expired owner is replaced", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		const startedAt = new Date("2026-01-01T00:00:00.000Z");
		await registry.acquire({
			sessionKey: "session-1",
			ownerPodId: "pod-a",
			ownerEndpoint: "http://pod-a",
			leaseDurationMs: 100,
			now: startedAt,
		});

		const replacement = await registry.acquire({
			sessionKey: "session-1",
			ownerPodId: "pod-b",
			ownerEndpoint: "http://pod-b",
			leaseDurationMs: 1_000,
			now: new Date(startedAt.getTime() + 100),
		});

		expect(replacement.acquired).toBe(true);
		expect(replacement.record.generation).toBe(2);
		expect(
			await registry.renew({
				sessionKey: "session-1",
				ownerPodId: "pod-a",
				generation: 1,
				leaseDurationMs: 1_000,
			}),
		).toBeNull();
		expect(
			await registry.release({
				sessionKey: "session-1",
				ownerPodId: "pod-a",
				generation: 1,
			}),
		).toBe(false);
	});

	it("increments generation after release and rejects the released generation", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		const first = await registry.acquire({
			sessionKey: "released-session",
			ownerPodId: "pod-a",
			ownerEndpoint: "http://pod-a",
			leaseDurationMs: 60_000,
		});
		expect(first.record.generation).toBe(1);
		expect(
			await registry.release({
				sessionKey: "released-session",
				ownerPodId: "pod-a",
				generation: 1,
			}),
		).toBe(true);

		const second = await registry.acquire({
			sessionKey: "released-session",
			ownerPodId: "pod-a",
			ownerEndpoint: "http://pod-a",
			leaseDurationMs: 60_000,
		});
		expect(second.record.generation).toBe(2);
		expect(
			await registry.renew({
				sessionKey: "released-session",
				ownerPodId: "pod-a",
				generation: 1,
				leaseDurationMs: 60_000,
			}),
		).toBeNull();
		expect(
			await registry.release({
				sessionKey: "released-session",
				ownerPodId: "pod-a",
				generation: 1,
			}),
		).toBe(false);
	});

	it("rejects generation zero at runtime boundaries", async () => {
		const registry = new InMemorySessionOwnerRegistry();
		await expect(
			registry.renew({
				sessionKey: "invalid-generation",
				ownerPodId: "pod-a",
				generation: 0,
				leaseDurationMs: 60_000,
			}),
		).rejects.toThrow("positive integer");
		await expect(
			registry.release({
				sessionKey: "invalid-generation",
				ownerPodId: "pod-a",
				generation: 0,
			}),
		).rejects.toThrow("positive integer");
	});
});

describe("PodLocalSessionPool", () => {
	it("evicts the least recently used session at capacity", async () => {
		const closed: Array<{ key: string; reason: string }> = [];
		const pool = new PodLocalSessionPool<string>(
			{ maxSessions: 2, idleTimeoutMs: 60_000, maxLifetimeMs: 60_000 },
			(session, reason) => closed.push({ key: session.sessionKey, reason }),
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
