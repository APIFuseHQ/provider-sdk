import { describe, expect, it } from "bun:test";

import {
	HttpProviderEventEmitter,
	RecordingProviderEventDeliveryFailureRecorder,
	type ProviderEvent,
	type ProviderEventMetricEmitter,
} from "../../dist/stateful/index.js";

const SECRET = "event-emitter-test-secret";

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
			emitter.publish(event("event-1"));

			expect(await emitter.flush(1_000)).toBe(true);
			expect(requests).toHaveLength(2);
			expect(requests[0]?.eventId).toBe("event-1");
			expect(requests[1]?.eventId).toBe("event-1");
			expect(requests[1]?.body).toBe(requests[0]?.body);
			expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
				eventId: "event-1",
				session: { generation: 9 },
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
			emitter.publish(event("oldest"));
			emitter.publish(event("second"));
			emitter.publish(event("third"));

			expect(failures.failures).toEqual([
				expect.objectContaining({ eventId: "oldest", reason: "buffer_overflow" }),
			]);
			expect(metricNames).toContain("apifuse_stateful_provider_event_drop_total");
			expect(await emitter.flush(1_000)).toBe(true);
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

		expect(() => emitter.publish(event("event-down"))).not.toThrow();
		expect(await emitter.flush(1_000)).toBe(true);
		expect(emitter.pendingCount()).toBe(0);
		expect(failures.failures).toEqual([
			expect.objectContaining({
				eventId: "event-down",
				reason: "attempts_exhausted",
				attempts: 2,
			}),
		]);
	});
});
