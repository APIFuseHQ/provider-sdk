import { describe, expect, it } from "bun:test";
import {
	CAPABILITY_BODY_UNAVAILABLE,
	readCapabilityErrorBody,
} from "../runtime/capability-response.js";
import { type CapabilityFacts, capabilityFacts } from "../runtime/capability-telemetry.js";
import {
	createCloudflareWorkersAiOcrClient,
	createOpenAiCompatibleOcrClient,
} from "../runtime/ocr.js";
import { createCloudflareWorkersAiSttClient } from "../runtime/stt.js";

const input = { kind: "base64", data: "cHJvYmU=" } as const;

function fetchDouble(response: object): typeof fetch {
	return Object.assign(async () => response as Response, { preconnect: global.fetch.preconnect });
}

function clients(response: object): Array<{ name: string; run: () => Promise<unknown> }> {
	return [
		{
			name: "OCR Cloudflare",
			run: () =>
				createCloudflareWorkersAiOcrClient({
					accountId: "account",
					apiToken: "token",
					fetch: fetchDouble(response),
				}).recognize({ image: input, timeoutMs: 10 }),
		},
		{
			name: "OCR OpenAI compatible",
			run: () =>
				createOpenAiCompatibleOcrClient({
					baseUrl: "https://ocr.invalid",
					model: "model",
					fetch: fetchDouble(response),
				}).recognize({ image: input, timeoutMs: 10 }),
		},
		{
			name: "STT Cloudflare",
			run: () =>
				createCloudflareWorkersAiSttClient({
					accountId: "account",
					apiToken: "token",
					fetch: fetchDouble(response),
				}).transcribe({ audio: input, timeoutMs: 10 }),
		},
	];
}

describe("OCR/STT bounded upstream error diagnostics", () => {
	function neverSettlingBody() {
		let cancelled = 0;
		let pendingPulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull() {
				pendingPulls++;
				return new Promise<void>(() => {});
			},
			cancel() {
				cancelled++;
				pendingPulls = 0;
			},
		});
		return {
			body,
			get cancelled() {
				return cancelled;
			},
			get pendingPulls() {
				return pendingPulls;
			},
		};
	}

	it("cancels a capped body, skips an already-aborted body, and retains a settling body", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const never = neverSettlingBody();
			const started = performance.now();
			const capped = await readCapabilityErrorBody(
				{ body: never.body } as Response,
				new AbortController().signal,
			);
			const elapsed = performance.now() - started;
			expect(capped).toBe(CAPABILITY_BODY_UNAVAILABLE);
			expect(never.body.locked).toBe(true);
			expect(never.cancelled).toBe(1);
			expect(never.pendingPulls).toBe(0);
			expect(elapsed).toBeGreaterThanOrEqual(200);
			expect(elapsed).toBeLessThan(500);

			let abortedReads = 0;
			let abortedCancelled = 0;
			const abortedBody = {
				getReader() {
					abortedReads++;
					throw new Error("body was read");
				},
				cancel() {
					abortedCancelled++;
				},
			};
			const controller = new AbortController();
			controller.abort(new Error("already aborted"));
			const abortedResponse = new Proxy(new Response(null), {
				get(target, property, receiver) {
					if (property === "body") return abortedBody;
					return Reflect.get(target, property, receiver);
				},
			});
			const abortedResult = await readCapabilityErrorBody(
				abortedResponse,
				controller.signal,
			);
			expect(abortedResult).toBe(CAPABILITY_BODY_UNAVAILABLE);
			expect(abortedReads).toBe(0);
			expect(abortedCancelled).toBe(0);

			let settlingCancelled = 0;
			const settling = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"error":"quota exceeded"}'));
					controller.close();
				},
				cancel() {
					settlingCancelled++;
				},
			});
			expect(
				await readCapabilityErrorBody({ body: settling } as Response, new AbortController().signal),
			).toBe('{"error":"quota exceeded"}');
			expect(settlingCancelled).toBe(0);
			expect(unhandled).toHaveLength(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("settles every non-2xx path when the response body never settles", async () => {
		const response = {
			ok: false,
			status: 403,
			statusText: "Forbidden",
			text: () => new Promise<string>(() => {}),
		};
		for (const client of clients(response)) {
			const facts: CapabilityFacts = {};
			const started = performance.now();
			await expect(capabilityFacts.run(facts, client.run)).rejects.toMatchObject({
				code: client.name.startsWith("OCR") ? "OCR_UPSTREAM_FAILED" : "STT_UPSTREAM_FAILED",
			});
			expect(performance.now() - started, client.name).toBeLessThan(100);
			expect(facts).toMatchObject({ status: 403, diagnostics: CAPABILITY_BODY_UNAVAILABLE });
		}
	});

	it("retains a settling non-2xx body for every capability backend", async () => {
		const response = {
			ok: false,
			status: 429,
			statusText: "Too Many Requests",
			text: async () => '{"error":"quota exceeded"}',
		};
		for (const client of clients(response)) {
			const facts: CapabilityFacts = {};
			await expect(capabilityFacts.run(facts, client.run)).rejects.toBeDefined();
			expect(facts.diagnostics, client.name).toBe('{"error":"quota exceeded"}');
		}
	});

	it("applies the hard body-read cap when the request signal remains live", async () => {
		const started = performance.now();
		const body = await readCapabilityErrorBody(
			{ text: () => new Promise<string>(() => {}) } as Response,
			new AbortController().signal,
		);
		const elapsed = performance.now() - started;
		expect(body).toBe(CAPABILITY_BODY_UNAVAILABLE);
		expect(elapsed).toBeGreaterThanOrEqual(200);
		expect(elapsed).toBeLessThan(500);
	});
});
