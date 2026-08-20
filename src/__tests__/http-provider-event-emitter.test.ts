import { describe, expect, it, spyOn } from "bun:test";

import type { ProviderEvent, ProviderEventMetricEmitter } from "../stateful/index.js";

const builtStatefulSpecifier: string = "../../dist/stateful/index.js";
const builtStateful: Promise<typeof import("../stateful/index.js")> = import(
	builtStatefulSpecifier
);
const {
	buildSessionKey,
	HttpProviderEventEmitter,
	RecordingProviderEventDeliveryFailureRecorder,
} = await builtStateful;

const SECRET = "event-emitter-test-secret";
const OWNER_FENCE = {
	sessionKey: buildSessionKey({
		providerId: "provider-1",
		serviceAccountId: "sa-1",
		connectionId: "connection-1",
		dimensions: {},
	}),
	generation: 9,
	ownerPodId: "pod-a",
	ownerEndpoint: "http://pod-a.internal",
};

function event(eventId: string): ProviderEvent {
	return {
		eventId,
		providerId: "provider-1",
		connectionId: "connection-1",
		serviceAccountId: "sa-1",
		eventType: "message.created",
		subject: { kind: "message", id: eventId },
		occurredAt: "2026-01-01T00:00:00.000Z",
		observedAt: "2026-01-01T00:00:00.000Z",
		payload: { text: "hello" },
		session: { sessionKey: "session-1", generation: 9 },
	};
}

describe("HttpProviderEventEmitter", () => {
	it("retries at least once with a stable idempotency key and body", async () => {
		const requests: Array<{ eventId: string | null; body: string }> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				requests.push({
					eventId: request.headers.get("x-apifuse-event-id"),
					body: await request.text(),
				});
				return new Response(null, { status: requests.length === 1 ? 500 : 204 });
			},
		});
		try {
			const emitter = new HttpProviderEventEmitter({
				baseUrl: server.url.origin,
				secret: SECRET,
				retryBaseMs: 1,
				retryMaxMs: 1,
				jitterRatio: 0,
			});
			const ack = emitter.publish(event("event-1"), {
				ownerFence: OWNER_FENCE,
				idempotencyKey: "custom-idempotency-key",
			});

			expect(ack).toEqual({ accepted: true, queued: 1 });
			expect(await emitter.flush(1_000)).toEqual({ delivered: 1, failed: 0, pending: 0 });
			expect(requests).toHaveLength(2);
			expect(requests[0]?.eventId).toBe("custom-idempotency-key");
			expect(requests[1]?.eventId).toBe("custom-idempotency-key");
			expect(requests[1]?.body).toBe(requests[0]?.body);
			expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
				eventId: "event-1",
				session: { generation: 9 },
				ownerFence: OWNER_FENCE,
			});
			expect(emitter.pendingCount()).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	it("drops the oldest buffered event and records failure metrics on overflow", async () => {
		const delivered: string[] = [];
		const failures = new RecordingProviderEventDeliveryFailureRecorder();
		const metricNames: string[] = [];
		const metrics: ProviderEventMetricEmitter = {
			increment(name) {
				metricNames.push(name);
			},
			observe() {},
		};
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				delivered.push(request.headers.get("x-apifuse-event-id") ?? "");
				return new Response(null, { status: 204 });
			},
		});
		try {
			const emitter = new HttpProviderEventEmitter({
				baseUrl: server.url.origin,
				secret: SECRET,
				maxBufferedEvents: 2,
				failureRecorder: failures,
				metricEmitter: metrics,
			});
			emitter.publish(event("oldest"), { ownerFence: OWNER_FENCE });
			emitter.publish(event("second"), { ownerFence: OWNER_FENCE });
			emitter.publish(event("third"), { ownerFence: OWNER_FENCE });

			expect(failures.failures).toEqual([
				expect.objectContaining({ eventId: "oldest", reason: "buffer_overflow" }),
			]);
			expect(metricNames).toContain("apifuse_stateful_provider_event_drop_total");
			expect(await emitter.flush(1_000)).toEqual({ delivered: 2, failed: 1, pending: 0 });
			expect(delivered).toEqual(["second", "third"]);
		} finally {
			server.stop(true);
		}
	});

	it("never throws from publish when the server is down and flush drains exhausted events", async () => {
		const failures = new RecordingProviderEventDeliveryFailureRecorder();
		const emitter = new HttpProviderEventEmitter({
			baseUrl: "http://127.0.0.1:1",
			secret: SECRET,
			fetch: async () => {
				throw new Error("server down");
			},
			maxAttempts: 2,
			retryBaseMs: 1,
			retryMaxMs: 1,
			jitterRatio: 0,
			failureRecorder: failures,
		});

		expect(() => emitter.publish(event("event-down"), { ownerFence: OWNER_FENCE })).not.toThrow();
		expect(await emitter.flush(1_000)).toEqual({ delivered: 0, failed: 1, pending: 0 });
		expect(emitter.pendingCount()).toBe(0);
		expect(failures.failures).toEqual([
			expect.objectContaining({
				eventId: "event-down",
				reason: "attempts_exhausted",
				attempts: 2,
			}),
		]);
	});

	it("reports events still pending when the flush budget expires", async () => {
		let finishRequest: (() => void) | undefined;
		const emitter = new HttpProviderEventEmitter({
			baseUrl: "http://platform.invalid",
			secret: SECRET,
			fetch: async () => {
				await new Promise<void>((resolve) => {
					finishRequest = resolve;
				});
				return new Response(null, { status: 204 });
			},
		});

		emitter.publish(event("pending"), { ownerFence: OWNER_FENCE });
		expect(await emitter.flush(1)).toEqual({ delivered: 0, failed: 0, pending: 1 });
		finishRequest?.();
		expect(await emitter.flush(1_000)).toEqual({ delivered: 1, failed: 0, pending: 0 });
	});

	it("logs structured loss details by default when publication is rejected", () => {
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			const emitter = new HttpProviderEventEmitter({
				baseUrl: "http://platform.invalid",
				secret: SECRET,
			});
			const cyclic: Record<string, unknown> = {};
			cyclic.self = cyclic;
			const rejected = emitter.publish(
				{ ...event("cyclic"), payload: cyclic },
				{
					ownerFence: OWNER_FENCE,
				},
			);

			expect(rejected).toEqual({ accepted: false, queued: 0 });
			expect(error).toHaveBeenCalledTimes(1);
			expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
				event: "provider_event_delivery_failed",
				eventId: "cyclic",
				reason: "attempts_exhausted",
				attempts: 0,
			});
		} finally {
			error.mockRestore();
		}
	});
});
