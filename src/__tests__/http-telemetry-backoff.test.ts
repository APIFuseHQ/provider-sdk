import { afterEach, describe, expect, it } from "bun:test";
import { TransportError } from "../errors.js";
import { HttpRetryAfterPolicy, HttpRetryJitter, HttpRetryPreset } from "../types.js";
import { createHttpClient } from "../runtime/http.js";

import type { HttpTelemetrySink } from "../runtime/http-telemetry.js";
import { closedEnum } from "../runtime/request-telemetry.js";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

function fetchDouble(
	implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return Object.assign(implementation, { preconnect: () => {} });
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.setTimeout = originalSetTimeout;
});

async function timedRun(httpTelemetry?: HttpTelemetrySink) {
	const delays: number[] = [];
	globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number) => {
		delays.push(Number(timeout ?? 0));
		if (typeof handler === "function") queueMicrotask(handler as () => void);
		return originalSetTimeout(() => undefined, 0);
	}) as typeof setTimeout;
	let count = 0;
	globalThis.fetch = fetchDouble(async () => {
		count++;
		if (count === 1) return new Response("no", { status: 503, headers: { "retry-after": "2" } });
		if (count === 2) throw new Error("socket hang up");
		return new Response("ok", { status: 200 });
	});
	let summary: unknown;
	const response = await createHttpClient(undefined, {
		httpTelemetry,
		onRetrySummary: (value) => (summary = value),
	}).get("https://example.com/probe", {
		retry: {
			preset: HttpRetryPreset.SafeRead,
			attempts: 3,
			baseDelayMs: 100,
			maxDelayMs: 5_000,
			jitter: HttpRetryJitter.None,
			retryAfter: HttpRetryAfterPolicy.Respect,
		},
	});
	return { delays, count, status: response.status, summary };
}

describe("review behavior probes", () => {
	it("same fake-clock status/network backoff schedule with collector on/off", async () => {
		const off = await timedRun();
		const events: unknown[] = [];
		const on = await timedRun({
			startRequest() {
				return {
					recordAttempt(value: unknown) {
						events.push(value);
					},
					finish() {},
					toTenantRetryPayload() {
						return { attempts: 3, retries: 2, transport: closedEnum("native") };
					},
				};
			},
		});
		expect(off.delays).toEqual([2_000, 200]);
		expect(on.delays).toEqual(off.delays);
		expect({ ...on, summary: undefined }).toEqual({ ...off, summary: undefined });
		expect(events).toHaveLength(3);
	});

	it("same abort-during-backoff observable with collector on/off", async () => {
		async function run(httpTelemetry?: HttpTelemetrySink) {
			const controller = new AbortController();
			const delays: number[] = [];
			globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number) => {
				delays.push(Number(timeout ?? 0));
				if (timeout === 1_000) queueMicrotask(() => controller.abort(new Error("stop")));
				return originalSetTimeout(handler, timeout);
			}) as typeof setTimeout;
			let count = 0;
			globalThis.fetch = fetchDouble(async () => {
				count++;
				throw new Error("socket hang up");
			});
			let error: unknown;
			try {
				await createHttpClient(undefined, { signal: controller.signal, httpTelemetry }).get(
					"https://example.com/probe",
					{ retry: { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 1_000, jitter: "none" } },
				);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(TransportError);
			if (!(error instanceof TransportError)) throw new Error("expected transport failure");
			return {
				count,
				delays,
				name: error.name,
				message: error.message,
				code: error.code,
				status: error.status,
			};
		}
		const off = await run();
		const on = await run({
			startRequest: () => ({ recordAttempt() {}, finish() {}, toTenantRetryPayload() {} }),
		});
		expect(on).toEqual(off);
		expect(off).toEqual({
			count: 1,
			delays: [1_000],
			name: "TransportError",
			message: "Request cancelled",
			code: "transport_cancelled",
			status: 0,
		});
	});
});
