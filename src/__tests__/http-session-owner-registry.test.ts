import { createHmac } from "node:crypto";

import { describe, expect, it } from "bun:test";

import { HttpSessionOwnerRegistry, StatefulControlPlaneError } from "../../dist/stateful/index.js";

const SECRET = "control-plane-test-secret";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const OWNER = {
	sessionKey: "session-1",
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
				const expected = `v1=${createHmac("sha256", SECRET)
					.update(`${timestamp}.${rawBody}`)
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

			expect(await registry.resolve("session-1", NOW)).toEqual(OWNER);
			expect(
				await registry.acquire({
					sessionKey: "session-1",
					ownerPodId: "pod-a",
					ownerEndpoint: "http://pod-a",
					leaseDurationMs: 60_000,
					now: NOW,
				}),
			).toEqual({ record: OWNER, acquired: true });
			expect(
				await registry.renew({
					sessionKey: "session-1",
					ownerPodId: "pod-a",
					generation: 7,
					leaseDurationMs: 60_000,
					now: NOW,
				}),
			).toEqual(OWNER);
			expect(
				await registry.release({
					sessionKey: "session-1",
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
			expect(await registry.resolve("missing")).toBeNull();
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
				const error = await registry.resolve("session-1").catch((caught) => caught);
				expect(error).toBeInstanceOf(StatefulControlPlaneError);
				expect(error.code).toMatch(/STATEFUL_CONTROL_PLANE_(?:HTTP_ERROR|INVALID_RESPONSE)/);
			} finally {
				server.stop(true);
			}
		}
	});
});
