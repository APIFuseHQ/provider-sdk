import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";

import {
	AmbiguousRegistryOperationError,
	buildSessionKey,
	HttpSessionOwnerRegistry,
	StatefulControlPlaneError,
} from "../../dist/stateful/index.js";

const SECRET = "control-plane-test-secret";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const SESSION_KEY = buildSessionKey({
	providerId: "provider-1",
	serviceAccountId: "sa-1",
	connectionId: "connection-1",
	dimensions: {},
});
const OWNER = {
	sessionKey: SESSION_KEY,
	ownerPodId: "pod-a",
	ownerEndpoint: "http://pod-a",
	generation: 7,
	leaseExpiresAt: "2026-01-01T00:01:00.000Z",
	status: "connected" as const,
	lastUsedAt: "2026-01-01T00:00:00.000Z",
};

describe("HttpSessionOwnerRegistry", () => {
	it("signs each operation over the exact request body and validates responses", async () => {
		const operations: string[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const rawBody = await request.text();
				const timestamp = request.headers.get("x-apifuse-stateful-timestamp") ?? "";
				const nonce = request.headers.get("x-apifuse-stateful-nonce") ?? "";
				const path = new URL(request.url).pathname;
				const expected = `v1=${createHmac("sha256", SECRET)
					.update(`v1:POST:${path}:${timestamp}:${nonce}.${rawBody}`)
					.digest("hex")}`;
				expect(request.headers.get("x-apifuse-stateful-signature")).toBe(expected);
				const operation = new URL(request.url).pathname.split("/").at(-1) ?? "";
				operations.push(operation);
				const body = JSON.parse(rawBody);
				expect(body.serviceAccountId).toBe("sa-1");
				expect(body.providerId).toBe("provider-1");
				if (operation === "resolve") return Response.json(OWNER);
				if (operation === "acquire") return Response.json({ record: OWNER, acquired: true });
				if (operation === "renew") return Response.json({ record: OWNER });
				return Response.json({ released: true });
			},
		});
		try {
			const registry = new HttpSessionOwnerRegistry({
				baseUrl: server.url.origin,
				secret: SECRET,
				scope: { serviceAccountId: "sa-1", providerId: "provider-1" },
				clock: () => NOW,
			});

			expect(await registry.resolve(SESSION_KEY, NOW)).toEqual(OWNER);
			expect(
				await registry.acquire({
					sessionKey: SESSION_KEY,
					ownerPodId: "pod-a",
					ownerEndpoint: "http://pod-a",
					leaseDurationMs: 60_000,
					now: NOW,
				}),
			).toEqual({ record: OWNER, acquired: true });
			expect(
				await registry.renew({
					sessionKey: SESSION_KEY,
					ownerPodId: "pod-a",
					generation: 7,
					leaseDurationMs: 60_000,
					now: NOW,
				}),
			).toEqual(OWNER);
			expect(
				await registry.release({
					sessionKey: SESSION_KEY,
					ownerPodId: "pod-a",
					generation: 7,
				}),
			).toBe(true);
			expect(operations).toEqual(["resolve", "acquire", "renew", "release"]);
		} finally {
			server.stop(true);
		}
	});

	it("maps resolve 404 to null", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) });
		try {
			const registry = new HttpSessionOwnerRegistry({
				baseUrl: server.url.origin,
				secret: SECRET,
			});
			expect(await registry.resolve(SESSION_KEY)).toBeNull();
		} finally {
			server.stop(true);
		}
	});

	it("fails closed on non-2xx and schema-invalid responses", async () => {
		for (const response of [
			new Response("unavailable", { status: 500 }),
			Response.json({ generation: "not-a-number" }),
		]) {
			const server = Bun.serve({ port: 0, fetch: () => response.clone() });
			try {
				const registry = new HttpSessionOwnerRegistry({
					baseUrl: server.url.origin,
					secret: SECRET,
				});
				const error = await registry.resolve(SESSION_KEY).catch((caught) => caught);
				expect(error).toBeInstanceOf(StatefulControlPlaneError);
				expect(error.code).toMatch(/STATEFUL_CONTROL_PLANE_(?:HTTP_ERROR|INVALID_RESPONSE)/);
			} finally {
				server.stop(true);
			}
		}
	});

	it("rejects generation zero and invalid owner-record session keys", async () => {
		for (const record of [
			{ ...OWNER, generation: 0 },
			{ ...OWNER, sessionKey: "not-a-canonical-session-key" },
		]) {
			const registry = new HttpSessionOwnerRegistry({
				baseUrl: "http://control-plane.invalid",
				secret: SECRET,
				fetch: async () => Response.json(record),
			});
			const error = await registry.resolve(SESSION_KEY).catch((caught) => caught);
			expect(error).toBeInstanceOf(StatefulControlPlaneError);
			expect(error.code).toBe("STATEFUL_CONTROL_PLANE_INVALID_RESPONSE");
		}
	});

	it("combines and forwards the caller abort signal", async () => {
		let fetchSignal: AbortSignal | undefined;
		const registry = new HttpSessionOwnerRegistry({
			baseUrl: "http://control-plane.invalid",
			secret: SECRET,
			fetch: async (_url, init) => {
				fetchSignal = init?.signal ?? undefined;
				return await rejectWhenAborted(fetchSignal);
			},
		});
		const controller = new AbortController();
		const resolving = registry.resolve(SESSION_KEY, undefined, controller.signal);
		controller.abort(new Error("caller cancelled"));

		const error = await resolving.catch((caught) => caught);
		expect(fetchSignal?.aborted).toBe(true);
		expect(error).toBeInstanceOf(StatefulControlPlaneError);
		expect(error.message).toContain("resolve request failed");
	});

	it("times out hung requests with an actionable structured error", async () => {
		const registry = new HttpSessionOwnerRegistry({
			baseUrl: "http://control-plane.invalid",
			secret: SECRET,
			requestTimeoutMs: 5,
			fetch: async (_url, init) => await rejectWhenAborted(init?.signal ?? undefined),
		});

		const error = await registry.resolve(SESSION_KEY).catch((caught) => caught);
		expect(error).toBeInstanceOf(StatefulControlPlaneError);
		expect(error.code).toBe("STATEFUL_CONTROL_PLANE_REQUEST_FAILED");
		expect(error.message).toContain("timed out after 5ms");
		expect(error.message).toContain("retry resolve");
	});

	it("marks mutation network failures and timeouts as ambiguous", async () => {
		for (const registry of [
			new HttpSessionOwnerRegistry({
				baseUrl: "http://control-plane.invalid",
				secret: SECRET,
				fetch: async () => {
					throw new Error("connection reset");
				},
			}),
			new HttpSessionOwnerRegistry({
				baseUrl: "http://control-plane.invalid",
				secret: SECRET,
				requestTimeoutMs: 5,
				fetch: async (_url, init) => await rejectWhenAborted(init?.signal ?? undefined),
			}),
		]) {
			const error = await registry
				.acquire({
					sessionKey: SESSION_KEY,
					ownerPodId: "pod-a",
					ownerEndpoint: "http://pod-a",
					leaseDurationMs: 60_000,
				})
				.catch((caught) => caught);
			expect(error).toBeInstanceOf(AmbiguousRegistryOperationError);
			expect(error.code).toBe("STATEFUL_CONTROL_PLANE_OPERATION_AMBIGUOUS");
			expect(error.ambiguous).toBe(true);
			expect(error.message).toContain("resolve the session owner and reconcile");
		}
	});

	it("keeps pre-dispatch caller aborts unambiguous but marks post-dispatch aborts ambiguous", async () => {
		let fetchCalls = 0;
		const registry = new HttpSessionOwnerRegistry({
			baseUrl: "http://control-plane.invalid",
			secret: SECRET,
			fetch: async (_url, init) => {
				fetchCalls += 1;
				return await rejectWhenAborted(init?.signal ?? undefined);
			},
		});
		const acquireInput = {
			sessionKey: SESSION_KEY,
			ownerPodId: "pod-a",
			ownerEndpoint: "http://pod-a",
			leaseDurationMs: 60_000,
		};

		const preDispatch = new AbortController();
		const preDispatchReason = new Error("cancelled before dispatch");
		preDispatch.abort(preDispatchReason);
		const preDispatchError = await registry
			.acquire(acquireInput, preDispatch.signal)
			.catch((caught) => caught);
		expect(preDispatchError).toBe(preDispatchReason);
		expect(preDispatchError).not.toBeInstanceOf(AmbiguousRegistryOperationError);
		expect(fetchCalls).toBe(0);

		const postDispatch = new AbortController();
		const acquiring = registry.acquire(acquireInput, postDispatch.signal);
		await Promise.resolve();
		expect(fetchCalls).toBe(1);
		postDispatch.abort(new Error("cancelled after dispatch"));
		await expect(acquiring).rejects.toBeInstanceOf(AmbiguousRegistryOperationError);
	});
});

function rejectWhenAborted(signal?: AbortSignal): Promise<Response> {
	return new Promise((_resolve, reject) => {
		if (!signal) return;
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}
