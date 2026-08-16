import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { HttpRedirectError, TransportError } from "../errors.js";
import {
	HttpRetryAfterPolicy,
	HttpRetryJitter,
	HttpRetryPreset,
	HttpRetryUnsafeMethodPolicy,
} from "../types.js";

type MockHttpResponse = {
	status: number;
	body: string | Uint8Array;
	headers?: Record<string, string | string[]>;
};

type MockNativeFetchCall = {
	url: string;
	init?: RequestInit;
};

const mockNativeFetchState = {
	calls: [] as MockNativeFetchCall[],
	lastResponse: undefined as Response | undefined,
	queuedNativeResponses: [] as Response[],
	queuedResponses: [] as MockHttpResponse[],
	queuedErrors: [] as Error[],
};

const originalFetch = globalThis.fetch;

function stringifyDiagnosticGraph(value: unknown): string {
	const seen = new WeakSet<object>();
	const snapshot = (current: unknown): unknown => {
		if (current === null || (typeof current !== "object" && typeof current !== "function")) {
			return current;
		}
		if (seen.has(current)) return "[cycle]";
		seen.add(current);
		const output: Record<string, unknown> = {};
		for (const name of Object.getOwnPropertyNames(current)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, name);
			output[name] = descriptor && "value" in descriptor ? snapshot(descriptor.value) : "[accessor]";
		}
		return output;
	};
	return JSON.stringify(snapshot(value));
}

describe("createHttpClient", () => {
	beforeEach(() => {
		mockNativeFetchState.calls.length = 0;
		mockNativeFetchState.lastResponse = undefined;
		mockNativeFetchState.queuedNativeResponses.length = 0;
		mockNativeFetchState.queuedResponses.length = 0;
		mockNativeFetchState.queuedErrors.length = 0;
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			mockNativeFetchState.calls.push({ url: String(input), init });
			const error = mockNativeFetchState.queuedErrors.shift();
			if (error) throw error;
			const queuedNativeResponse = mockNativeFetchState.queuedNativeResponses.shift();
			if (queuedNativeResponse) {
				mockNativeFetchState.lastResponse = queuedNativeResponse;
				return queuedNativeResponse;
			}
			const response = mockNativeFetchState.queuedResponses.shift();
			if (!response) throw new Error("No queued native response");
			const body =
				typeof response.body === "string"
					? response.body
					: new Uint8Array(response.body).slice(0).buffer;
			const nativeResponse = new Response(body, {
				headers: response.headers as HeadersInit,
				status: response.status,
			});
			mockNativeFetchState.lastResponse = nativeResponse;
			return nativeResponse;
		}) as typeof fetch;
	});

	afterAll(() => {
		globalThis.fetch = originalFetch;
	});

	it("get() returns HttpResponse with plain response fields", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ args: { q: "1" } }),
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const result = await http.get("https://httpbin.org/get", {
			params: { q: "1" },
		});

		expect(mockNativeFetchState.calls[0]?.url).toBe("https://httpbin.org/get?q=1");
		expect(result.status).toBe(200);
		expect(result.ok).toBeTrue();
		expect(result.headers["content-type"]).toBe("application/json");
		expect(result.data).toEqual({ args: { q: "1" } });
		expect(await result.json<{ args: { q: string } }>()).toEqual({
			args: { q: "1" },
		});
		expect(await result.text()).toBe(JSON.stringify({ args: { q: "1" } }));
		expect(Array.from(await result.bytes())).toEqual(
			Array.from(new TextEncoder().encode(JSON.stringify({ args: { q: "1" } }))),
		);
		expect(Array.from(new Uint8Array(await result.arrayBuffer()))).toEqual(
			Array.from(new TextEncoder().encode(JSON.stringify({ args: { q: "1" } }))),
		);
	});

	it("preserves raw non-UTF-8 bytes while keeping lossy text compatibility", async () => {
		const originalBytes = new Uint8Array([0x52, 0x49, 0xff, 0x00, 0x80, 0x45]);
		const expectedText = new TextDecoder().decode(originalBytes);
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: originalBytes,
			headers: { "content-type": "text/plain" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const result = await http.get("https://example.com/binary");

		expect(Array.from(await result.bytes())).toEqual(Array.from(originalBytes));
		expect(Array.from(new Uint8Array(await result.arrayBuffer()))).toEqual(
			Array.from(originalBytes),
		);
		expect(await result.text()).toBe(expectedText);
		expect(result.data).toBe(expectedText);
	});

	it("lets callers decode EUC-KR bodies from preserved response bytes", async () => {
		const originalBytes = new Uint8Array([0xbe, 0xc8, 0xb3, 0xe7]);
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: originalBytes,
			headers: { "content-type": "text/html" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const result = await http.get("https://example.com/euc-kr");

		expect(new TextDecoder("euc-kr").decode(await result.bytes())).toBe("안녕");
	});

	it("returns defensive copies from byte-native response methods", async () => {
		const originalBytes = new Uint8Array([0x52, 0x49, 0xff, 0x00, 0x80, 0x45]);
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: originalBytes,
			headers: { "content-type": "application/octet-stream" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const result = await http.get("https://example.com/defensive-copy");

		const bytes = await result.bytes();
		bytes[0] = 0x00;
		const arrayBufferBytes = new Uint8Array(await result.arrayBuffer());
		arrayBufferBytes[1] = 0x00;

		expect(Array.from(await result.bytes())).toEqual(Array.from(originalBytes));
		expect(Array.from(new Uint8Array(await result.arrayBuffer()))).toEqual(
			Array.from(originalBytes),
		);
	});

	it("keeps empty JSON response compatibility", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const result = await http.get("https://example.com/empty-json");

		expect(result.data).toBeNull();
		expect(await result.json()).toBeNull();
	});

	it("keeps params-only URL serialization byte-identical", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com");

		await http.get("/items?existing=1", {
			params: {
				empty: null,
				enabled: true,
				page: 2,
				q: "chair",
				skip: undefined,
				tag: ["a", undefined, "b"],
			},
		});

		expect(mockNativeFetchState.calls[0]?.url).toBe(
			"https://example.com/items?existing=1&enabled=true&page=2&q=chair&tag=a&tag=b",
		);
	});

	it("merges sensitiveParams into the outgoing query", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com");

		await http.get("/items?existing=1", {
			params: { page: 2 },
			sensitiveParams: { serviceKey: "test key/with+symbols" },
		});

		expect(mockNativeFetchState.calls[0]?.url).toBe(
			"https://example.com/items?existing=1&page=2&serviceKey=test+key%2Fwith%2Bsymbols",
		);
	});

	it("post() sends body and returns response", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ json: { key: "value" } }),
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const result = await http.post("https://httpbin.org/post", {
			key: "value",
		});

		expect(mockNativeFetchState.calls[0]?.init?.body).toBe(JSON.stringify({ key: "value" }));
		expect(result.data).toEqual({ json: { key: "value" } });
		expect(await result.text()).toBe(JSON.stringify({ json: { key: "value" } }));
	});

	it("blocks a cross-origin 307 before a credential-bearing POST is issued", async () => {
		const calls: MockNativeFetchCall[] = [];
		const diagnosticSecret = "cross-origin-diagnostic-secret";
		const redirectTarget = `https://alice:${diagnosticSecret}@attacker.example/collect?token=${diagnosticSecret}#${diagnosticSecret}`;
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			if (url === "https://api.example.com/login") {
				if (init?.redirect === "manual") {
					return new Response(null, {
						headers: { location: redirectTarget },
						status: 307,
					});
				}
				// Model native fetch's default redirect following. If production stops
				// forcing manual mode, this mock actually carries the POST to the target.
				return globalThis.fetch(redirectTarget, init);
			}
			return new Response("stolen", { status: 200 });
		}) as typeof fetch;

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		let caught: unknown;
		try {
			await http.post(
				"https://api.example.com/login",
				{ username: "alice", password: "credential" },
				{ redirectPolicy: { mode: "same-origin", maxHops: 5 } },
			);
		} catch (error) {
			caught = error;
		}

		// This is the security property: the refused target was never requested.
		expect(calls).toHaveLength(1);
		expect(caught).toBeInstanceOf(HttpRedirectError);
		expect(caught).toMatchObject({
			code: "http_redirect_stopped",
			reason: "stopped",
			target: "https://attacker.example/collect?[REDACTED]",
		});
		expect(String((caught as Error).message)).toContain("https://attacker.example/collect");
		expect(stringifyDiagnosticGraph(caught)).not.toContain(diagnosticSecret);
		expect(calls[0]?.init).toMatchObject({
			body: JSON.stringify({ username: "alice", password: "credential" }),
			method: "POST",
			redirect: "manual",
		});
	});

	it("cancels an unbounded redirect body and still refuses the target promptly", async () => {
		let cancelled = false;
		const calls: MockNativeFetchCall[] = [];
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return new Response(
				new ReadableStream<Uint8Array>({
					pull: () => new Promise<void>(() => undefined),
					cancel() {
						cancelled = true;
						return new Promise<void>(() => undefined);
					},
				}),
				{
					headers: { location: "https://other.example/never-read" },
					status: 307,
				},
			);
		}) as typeof fetch;

		const { createHttpClient } = await import("../runtime/http.js");
		const outcome = await Promise.race([
			createHttpClient()
				.get("https://example.com/start", {
					redirectPolicy: { mode: "same-origin", maxHops: 2 },
				})
				.catch((error: unknown) => error),
			new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 100)),
		]);

		expect(outcome).toBeInstanceOf(HttpRedirectError);
		expect(outcome).toMatchObject({ code: "http_redirect_stopped", reason: "stopped" });
		expect(cancelled).toBeTrue();
		expect(calls).toHaveLength(1);
	});

	it("follows legitimate same-origin redirects and applies fetch method/body semantics", async () => {
		const rewrittenRedirect = new Response("ignored redirect body", {
			headers: { location: "/after-post" },
			status: 302,
		});
		const preservedRedirect = new Response("ignored redirect body", {
			headers: { location: "https://example.com:443/retry" },
			status: 307,
		});
		mockNativeFetchState.queuedNativeResponses.push(
			rewrittenRedirect,
			new Response("done", { headers: { "content-type": "text/plain" }, status: 200 }),
			preservedRedirect,
			new Response("preserved", {
				headers: { "content-type": "text/plain" },
				status: 200,
			}),
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const policy = { mode: "same-origin", maxHops: 2 } as const;
		await http.post("https://example.com/start", { credential: "secret" }, {
			redirectPolicy: policy,
		});
		await http.post("https://example.com/preserve", "credential=secret", {
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			redirectPolicy: policy,
		});

		expect(mockNativeFetchState.calls).toHaveLength(4);
		expect(mockNativeFetchState.calls[1]).toMatchObject({
			url: "https://example.com/after-post",
			init: { method: "GET", redirect: "manual" },
		});
		expect(mockNativeFetchState.calls[1]?.init?.body).toBeUndefined();
		expect(new Headers(mockNativeFetchState.calls[1]?.init?.headers).has("content-type")).toBeFalse();
		expect(rewrittenRedirect.bodyUsed).toBeTrue();
		expect(mockNativeFetchState.calls[3]).toMatchObject({
			url: "https://example.com/retry",
			init: {
				body: "credential=secret",
				method: "POST",
				redirect: "manual",
			},
		});
		expect(preservedRedirect.bodyUsed).toBeTrue();
	});

	it("uses GET without a body after 303, while 308 preserves PUT bodies", async () => {
		mockNativeFetchState.queuedResponses.push(
			{ status: 303, body: "", headers: { location: "/get-result" } },
			{ status: 200, body: "ok", headers: {} },
			{ status: 308, body: "", headers: { location: "/put-again" } },
			{ status: 200, body: "ok", headers: {} },
		);
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com");
		const policy = { mode: "same-origin", maxHops: 1 } as const;

		await http.request("/submit", {
			body: "credential",
			method: "PATCH",
			redirectPolicy: policy,
		});
		await http.put("/update", "credential", { redirectPolicy: policy });

		expect(mockNativeFetchState.calls[1]?.init).toMatchObject({
			method: "GET",
			redirect: "manual",
		});
		expect(mockNativeFetchState.calls[1]?.init?.body).toBeUndefined();
		expect(mockNativeFetchState.calls[3]?.init).toMatchObject({
			body: "credential",
			method: "PUT",
			redirect: "manual",
		});
	});

	it("fails closed with aligned reasons for missing/malformed Location, limits, and loops", async () => {
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com");
		const policy = { mode: "same-origin", maxHops: 1 } as const;

		mockNativeFetchState.queuedResponses.push({ status: 302, body: "", headers: {} });
		await expect(http.get("/missing", { redirectPolicy: policy })).rejects.toMatchObject({
			code: "http_redirect_missing_location",
			reason: "missing_location",
		});

		const malformedSecret = "malformed-location-secret";
		const malformedRedirect = new Response("must be discarded", {
			headers: {
				location: `https://${malformedSecret}@[attacker.example/collect`,
			},
			status: 302,
		});
		mockNativeFetchState.queuedNativeResponses.push(malformedRedirect);
		let malformedError: unknown;
		try {
			await http.get("/malformed", { redirectPolicy: policy });
		} catch (error) {
			malformedError = error;
		}
		expect(malformedError).toMatchObject({
			code: "http_redirect_missing_location",
			reason: "missing_location",
		});
		expect((malformedError as HttpRedirectError).target).toBe("[malformed redirect target]");
		expect((malformedError as Error & { cause?: unknown }).cause).toBeUndefined();
		expect(stringifyDiagnosticGraph(malformedError)).not.toContain(malformedSecret);
		expect(malformedRedirect.bodyUsed).toBeTrue();

		mockNativeFetchState.queuedResponses.push(
			{ status: 302, body: "", headers: { location: "/limit-two" } },
			{ status: 302, body: "", headers: { location: "/limit-three" } },
		);
		await expect(http.get("/limit-one", { redirectPolicy: policy })).rejects.toMatchObject({
			code: "http_redirect_max_hops",
			reason: "max_hops",
			target: "https://example.com/limit-three",
		});

		mockNativeFetchState.queuedResponses.push(
			{ status: 302, body: "", headers: { location: "/loop-two" } },
			{ status: 302, body: "", headers: { location: "/loop-one" } },
		);
		await expect(
			http.get("/loop-one", {
				redirectPolicy: { mode: "same-origin", maxHops: 2 },
			}),
		).rejects.toMatchObject({
			code: "http_redirect_loop",
			reason: "loop",
			target: "https://example.com/loop-one",
		});
		expect(mockNativeFetchState.calls).toHaveLength(6);
	});

	it("validates and snapshots redirectPolicy before any transport work", async () => {
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const invalidPolicies: unknown[] = [
			null,
			{},
			{ mode: "follow", maxHops: 1 },
			{ mode: "same-origin", maxHops: -1 },
			{ mode: "same-origin", maxHops: 21 },
			{ mode: "same-origin", maxHops: 1, surprise: true },
		];

		for (const redirectPolicy of invalidPolicies) {
			await expect(
				http.get("https://example.com", { redirectPolicy } as never),
			).rejects.toMatchObject({ code: "http_redirect_policy_invalid" });
		}
		const accessorPolicy = {} as Record<string, unknown>;
		Object.defineProperty(accessorPolicy, "mode", {
			get() {
				throw new Error("getter must not run");
			},
			enumerable: true,
		});
		Object.defineProperty(accessorPolicy, "maxHops", { value: 1, enumerable: true });
		await expect(
			http.get("https://example.com", { redirectPolicy: accessorPolicy } as never),
		).rejects.toMatchObject({ code: "http_redirect_policy_invalid" });
		expect(mockNativeFetchState.calls).toHaveLength(0);
	});

	it("enforces redirectPolicy for streaming requests before opening the target stream", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 307,
			body: "",
			headers: { location: "https://other.example/events" },
		});
		const { createHttpClient } = await import("../runtime/http.js");
		await expect(
			createHttpClient().stream("https://example.com/events", {
				redirectPolicy: { mode: "same-origin", maxHops: 2 },
			}),
		).rejects.toMatchObject({ code: "http_redirect_stopped", reason: "stopped" });
		expect(mockNativeFetchState.calls).toHaveLength(1);
	});

	it("preserves native fetch redirect behavior when redirectPolicy is absent", async () => {
		mockNativeFetchState.queuedResponses.push({ status: 200, body: "followed", headers: {} });
		const { createHttpClient } = await import("../runtime/http.js");
		const response = await createHttpClient().get("https://example.com/legacy");

		expect(await response.text()).toBe("followed");
		expect(mockNativeFetchState.calls[0]?.init).not.toHaveProperty("redirect");
	});

	it("stream() exposes native response body without eager text buffering", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "first\nsecond\n",
			headers: { "content-type": "text/plain" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const response = await http.stream("https://example.com/logs", {
			sensitiveParams: { crtfc_key: "stream-test-secret" },
		});

		expect(response.status).toBe(200);
		expect(response.headers["content-type"]).toBe("text/plain");
		expect(mockNativeFetchState.calls[0]?.url).toBe(
			"https://example.com/logs?crtfc_key=stream-test-secret",
		);
		expect(mockNativeFetchState.lastResponse?.bodyUsed).toBe(false);
		const lines: string[] = [];
		for await (const line of response.lines()) lines.push(line);
		expect(lines).toEqual(["first", "second"]);
	});

	it("aborts an in-flight buffered request from the ambient request signal", async () => {
		const ambientController = new AbortController();
		let fetchSignal: AbortSignal | null | undefined;
		let markFetchStarted: (() => void) | undefined;
		const fetchStarted = new Promise<void>((resolve) => {
			markFetchStarted = resolve;
		});
		globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
			fetchSignal = init?.signal;
			markFetchStarted?.();
			return new Promise<Response>((_resolve, reject) => {
				const onAbort = () => reject(fetchSignal?.reason);
				fetchSignal?.addEventListener("abort", onAbort, { once: true });
				if (fetchSignal?.aborted) onAbort();
			});
		}) as typeof fetch;
		const { createHttpClient } = await import("../runtime/http.js");
		const pending = createHttpClient(undefined, { signal: ambientController.signal }).get(
			"https://example.com/slow",
		);

		await fetchStarted;
		ambientController.abort();

		await expect(pending).rejects.toMatchObject({
			code: "transport_cancelled",
			cause: { name: "AbortError" },
		});
		expect(fetchSignal?.aborted).toBe(true);
	});

	it("aborts an in-flight streamed request from the ambient request signal", async () => {
		const ambientController = new AbortController();
		let fetchSignal: AbortSignal | null | undefined;
		let markFetchStarted: (() => void) | undefined;
		const fetchStarted = new Promise<void>((resolve) => {
			markFetchStarted = resolve;
		});
		globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
			fetchSignal = init?.signal;
			markFetchStarted?.();
			return new Promise<Response>((_resolve, reject) => {
				const onAbort = () => reject(fetchSignal?.reason);
				fetchSignal?.addEventListener("abort", onAbort, { once: true });
				if (fetchSignal?.aborted) onAbort();
			});
		}) as typeof fetch;
		const { createHttpClient } = await import("../runtime/http.js");
		const pending = createHttpClient(undefined, { signal: ambientController.signal }).stream(
			"https://example.com/slow-stream",
		);

		await fetchStarted;
		ambientController.abort();

		await expect(pending).rejects.toMatchObject({
			code: "transport_cancelled",
			cause: { name: "AbortError" },
		});
		expect(fetchSignal?.aborted).toBe(true);
	});

	it("keeps the ambient signal active while a streamed body is consumed", async () => {
		const ambientController = new AbortController();
		let sourceCancelled = false;
		mockNativeFetchState.queuedNativeResponses.push(
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						sourceCancelled = true;
					},
				}),
			),
		);
		const { createHttpClient } = await import("../runtime/http.js");
		const response = await createHttpClient(undefined, {
			signal: ambientController.signal,
		}).stream("https://example.com/body-stream");
		const nextChunk = response.bytes()[Symbol.asyncIterator]().next();

		ambientController.abort();

		await expect(nextChunk).rejects.toMatchObject({
			name: "TransportError",
			code: "transport_cancelled",
		});
		expect(sourceCancelled).toBe(true);
	});

	it("preserves per-call timeout cancellation without an ambient signal", async () => {
		let fetchSignal: AbortSignal | null | undefined;
		globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
			fetchSignal = init?.signal;
			return new Promise<Response>((_resolve, reject) => {
				const onAbort = () => reject(fetchSignal?.reason);
				fetchSignal?.addEventListener("abort", onAbort, { once: true });
				if (fetchSignal?.aborted) onAbort();
			});
		}) as typeof fetch;
		const { createHttpClient } = await import("../runtime/http.js");

		await expect(
			createHttpClient().get("https://example.com/timeout", { timeout: 1 }),
		).rejects.toMatchObject({ code: "transport_timeout" });
		expect(fetchSignal?.aborted).toBe(true);
	});

	it("retries a per-call timeout when the proxy retry policy allows it", async () => {
		let attempt = 0;
		globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
			mockNativeFetchState.calls.push({ url: String(_input), init });
			attempt += 1;
			if (attempt > 1) {
				return Promise.resolve(
					new Response('{"ok":true}', {
						headers: { "content-type": "application/json" },
					}),
				);
			}
			const fetchSignal = init?.signal;
			return new Promise<Response>((_resolve, reject) => {
				const onAbort = () => reject(fetchSignal?.reason);
				fetchSignal?.addEventListener("abort", onAbort, { once: true });
				if (fetchSignal?.aborted) onAbort();
			});
		}) as typeof fetch;
		const { createHttpClient } = await import("../runtime/http.js");

		const response = await createHttpClient(undefined, {
			proxy: "http://proxy.test",
		}).get("https://example.com/retry-timeout", {
			timeout: 1,
			retry: {
				preset: HttpRetryPreset.TransportTransient,
				attempts: 2,
				baseDelayMs: 0,
			},
		});

		expect(response.data).toEqual({ ok: true });
		expect(mockNativeFetchState.calls).toHaveLength(2);
	});

	it("merges ambient and per-call timeout signals with the first abort reason", async () => {
		const ambientController = new AbortController();
		const ambientReason = new DOMException("request abandoned", "AbortError");
		let fetchSignal: AbortSignal | null | undefined;
		let markFetchStarted: (() => void) | undefined;
		const fetchStarted = new Promise<void>((resolve) => {
			markFetchStarted = resolve;
		});
		globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
			fetchSignal = init?.signal;
			markFetchStarted?.();
			return new Promise<Response>((_resolve, reject) => {
				const onAbort = () => reject(fetchSignal?.reason);
				fetchSignal?.addEventListener("abort", onAbort, { once: true });
				if (fetchSignal?.aborted) onAbort();
			});
		}) as typeof fetch;
		const { createHttpClient } = await import("../runtime/http.js");
		const pending = createHttpClient(undefined, { signal: ambientController.signal }).get(
			"https://example.com/merged",
			{ timeout: 60_000 },
		);

		await fetchStarted;
		ambientController.abort(ambientReason);

		await expect(pending).rejects.toMatchObject({ code: "transport_cancelled" });
		expect(fetchSignal?.reason).toBe(ambientReason);
	});

	it("interrupts retry backoff when the ambient request is aborted", async () => {
		const ambientController = new AbortController();
		const originalSetTimeout = globalThis.setTimeout;
		let markBackoffStarted: (() => void) | undefined;
		const backoffStarted = new Promise<void>((resolve) => {
			markBackoffStarted = resolve;
		});
		globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number) => {
			if (timeout === 1_000) markBackoffStarted?.();
			return originalSetTimeout(handler, timeout);
		}) as typeof setTimeout;
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			mockNativeFetchState.calls.push({ url: String(input), init });
			throw new Error("Network error");
		}) as typeof fetch;

		try {
			const { createHttpClient } = await import("../runtime/http.js");
			const pending = createHttpClient(undefined, {
				signal: ambientController.signal,
			}).get("https://example.com/retry", {
				retry: {
					preset: HttpRetryPreset.TransportTransient,
					attempts: 3,
					baseDelayMs: 1_000,
					maxDelayMs: 1_000,
					jitter: HttpRetryJitter.None,
				},
			});

			await backoffStarted;
			ambientController.abort(new DOMException("request disconnected", "AbortError"));

			await expect(pending).rejects.toMatchObject({
				code: "transport_cancelled",
				options: { retryable: false },
			});
			expect(mockNativeFetchState.calls).toHaveLength(1);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});

	it("does not start a fetch for an already-aborted ambient request", async () => {
		const ambientController = new AbortController();
		ambientController.abort(new DOMException("request disconnected", "AbortError"));
		const { createHttpClient } = await import("../runtime/http.js");

		await expect(
			createHttpClient(undefined, { signal: ambientController.signal }).get(
				"https://example.com/not-started",
			),
		).rejects.toMatchObject({ code: "transport_cancelled" });
		expect(mockNativeFetchState.calls).toHaveLength(0);
	});

	it("lets the per-call timeout win while a merged ambient signal stays active", async () => {
		const ambientController = new AbortController();
		let fetchSignal: AbortSignal | null | undefined;
		globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
			fetchSignal = init?.signal;
			return new Promise<Response>((_resolve, reject) => {
				const onAbort = () => reject(fetchSignal?.reason);
				fetchSignal?.addEventListener("abort", onAbort, { once: true });
				if (fetchSignal?.aborted) onAbort();
			});
		}) as typeof fetch;
		const { createHttpClient } = await import("../runtime/http.js");

		await expect(
			createHttpClient(undefined, { signal: ambientController.signal }).get(
				"https://example.com/merged-timeout",
				{ timeout: 1 },
			),
		).rejects.toMatchObject({ code: "transport_timeout" });
		expect(fetchSignal?.aborted).toBe(true);
		expect(ambientController.signal.aborted).toBe(false);
	});

	it("redacts sensitiveParams from mid-stream transport errors", async () => {
		const secret = "mid-stream-test-secret";
		mockNativeFetchState.queuedNativeResponses.push(
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.error(
							new TransportError(`Stream failed at https://example.com/logs?crtfc_key=${secret}`, {
								code: "transport_network_error",
								status: 0,
							}),
						);
					},
				}),
				{ status: 200 },
			),
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const response = await createHttpClient().stream("https://example.com/logs", {
			sensitiveParams: { crtfc_key: secret },
		});
		let caught: unknown;
		try {
			for await (const _line of response.lines()) {
				// The test stream fails before yielding a line.
			}
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(TransportError);
		expect((caught as Error).message).toContain("crtfc_key=[REDACTED]");
		expect((caught as Error).message).not.toContain(secret);
	});

	it("preserves mid-stream error semantics while redacting sensitiveParams", async () => {
		const secret = "stream-semantics-secret";
		const streamError = new Error(`Socket closed at https://example.com/logs?crtfc_key=${secret}`);
		streamError.name = "SocketError";
		mockNativeFetchState.queuedNativeResponses.push(
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.error(streamError);
					},
				}),
				{ status: 200 },
			),
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const response = await createHttpClient().stream("https://example.com/logs", {
			sensitiveParams: { crtfc_key: secret },
		});
		let caught: unknown;
		try {
			for await (const _line of response.lines()) {
				// The test stream fails before yielding a line.
			}
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(streamError);
		expect(caught).not.toBeInstanceOf(TransportError);
		expect(caught).toMatchObject({
			name: "SocketError",
			message: "Socket closed at https://example.com/logs?crtfc_key=[REDACTED]",
		});
	});

	it("redacts sensitiveParams from stream cancellation errors", async () => {
		const secret = "cancel-stream-secret";
		mockNativeFetchState.queuedNativeResponses.push(
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						throw new Error(`Cancel failed at https://example.com/logs?crtfc_key=${secret}`);
					},
				}),
				{ status: 200 },
			),
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const response = await createHttpClient().stream("https://example.com/logs", {
			sensitiveParams: { crtfc_key: secret },
		});

		await expect(response.body.cancel()).rejects.toThrow(
			"https://example.com/logs?crtfc_key=[REDACTED]",
		);
	});

	it("sse() parses native EventSource frames incrementally", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: 'id: evt_1\nevent: delta\ndata: {"value":1}\n\n',
			headers: { "content-type": "text/event-stream" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const events = await http.sse("https://example.com/events");
		const first = await events[Symbol.asyncIterator]().next();

		expect(mockNativeFetchState.calls[0]?.init?.headers).toMatchObject({
			Accept: "text/event-stream",
		});
		expect(first.done).toBe(false);
		expect(first.value?.event).toBe("delta");
		expect(first.value?.id).toBe("evt_1");
		expect(first.value?.json<{ value: number }>()).toEqual({ value: 1 });
	});

	it("stream() uses native HTTP through configured proxy", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "hello",
			headers: { "content-type": "text/plain" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient(undefined, { proxy: "http://proxy.test" });

		const response = await http.stream("https://example.com/events");

		expect(response.status).toBe(200);
		expect((mockNativeFetchState.calls[0]?.init as RequestInit & { proxy?: string })?.proxy).toBe(
			"http://proxy.test",
		);
	});

	it("post() preserves caller-encoded string bodies", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const result = await http.post("https://example.com/form", "a=1&b=2", {
			headers: {
				"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
			},
		});

		expect(mockNativeFetchState.calls[0]?.init?.body).toBe("a=1&b=2");
		expect(mockNativeFetchState.calls[0]?.init?.headers).toMatchObject({
			"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
		});
		expect(await result.text()).toBe("ok");
	});

	it("does not persist cookies across ctx.http helper calls", async () => {
		mockNativeFetchState.queuedResponses.push(
			{
				status: 200,
				body: "first",
				headers: {
					"content-type": "text/plain",
					"set-cookie": "sid=first; Path=/",
				},
			},
			{
				status: 200,
				body: "second",
				headers: { "content-type": "text/plain" },
			},
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await http.get("https://first.example/session");
		await http.get("https://second.example/resource");

		expect(mockNativeFetchState.calls).toHaveLength(2);
		expect(mockNativeFetchState.calls[1]?.init?.headers).not.toHaveProperty("Cookie");
	});

	it("throws TransportError on 4xx by default", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 404,
			body: "Not Found",
			headers: { "content-type": "text/plain" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(http.get("https://example.com/not-found")).rejects.toThrow(TransportError);
		expect(mockNativeFetchState.lastResponse?.bodyUsed).toBe(true);
	});

	it("returns non-2xx response when HTTP errors are not thrown", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 422,
			body: '{"error":"invalid"}',
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const response = await http.get("https://example.com/invalid", {
			throwOnHttpError: false,
		});

		expect(response.status).toBe(422);
		expect(response.ok).toBe(false);
		expect(response.data).toEqual({ error: "invalid" });
		expect(await response.text()).toBe('{"error":"invalid"}');
	});

	it("TransportError has status code", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 500,
			body: "Server Error",
			headers: { "content-type": "text/plain" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		try {
			await http.get("https://example.com/error");
		} catch (error) {
			expect(error instanceof TransportError).toBe(true);
			expect((error as TransportError).status).toBe(500);
			expect((error as TransportError).code).toBe("upstream_http_error");
		}
	});

	it("throws TransportError on network error", async () => {
		mockNativeFetchState.queuedErrors.push(new Error("Network error"));

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(http.get("https://example.com")).rejects.toMatchObject({
			code: "transport_network_error",
			status: 0,
			message: "Network error",
		});
	});

	it("redacts sensitiveParams from transport errors that embed the request URL", async () => {
		const secret = "transport-error-test-secret";
		mockNativeFetchState.queuedErrors.push(
			new TransportError(`Failed to fetch https://example.com/data?serviceKey=${secret}`, {
				code: "transport_network_error",
				status: 0,
			}),
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		let caught: unknown;
		try {
			await http.get("https://example.com/data", {
				sensitiveParams: { serviceKey: secret },
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(TransportError);
		expect((caught as Error).message).toBe(
			"Failed to fetch https://example.com/data?serviceKey=[REDACTED]",
		);
		expect(JSON.stringify(caught)).not.toContain(secret);
	});

	it("does not retry when retry is omitted", async () => {
		mockNativeFetchState.queuedErrors.push(new Error("Network error"));
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(http.get("https://example.com")).rejects.toMatchObject({
			code: "transport_network_error",
		});
		expect(mockNativeFetchState.calls).toHaveLength(1);
	});

	it("maps retry true to TransportTransient and retries native GET transport failures", async () => {
		const summaries: unknown[] = [];
		const originalRandom = Math.random;
		Math.random = () => 0;
		mockNativeFetchState.queuedErrors.push(new Error("Network error"));
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient(undefined, {
			onRetrySummary: (summary) => summaries.push(summary),
		});
		let response: Awaited<ReturnType<typeof http.get>> | undefined;
		try {
			response = await http.get("https://example.com", { retry: true });
		} finally {
			Math.random = originalRandom;
		}

		expect(response?.data).toEqual({ ok: true });
		expect(mockNativeFetchState.calls).toHaveLength(2);
		expect(summaries).toEqual([
			{
				attempts: 2,
				retries: 1,
				preset: HttpRetryPreset.TransportTransient,
				transport: "native",
				lastErrorCode: "transport_network_error",
			},
		]);
	});

	it("keeps readonly sensitive timeout errors classified and retryable", async () => {
		const secret = "http-timeout-secret";
		const summaries: unknown[] = [];
		const originalRandom = Math.random;
		Math.random = () => 0;
		mockNativeFetchState.queuedErrors.push(
			new DOMException(
				`request aborted at https://example.com/slow?serviceKey=${secret}`,
				"AbortError",
			),
		);
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		let response: Awaited<ReturnType<ReturnType<typeof createHttpClient>["get"]>> | undefined;
		try {
			response = await createHttpClient(undefined, {
				onRetrySummary: (summary) => summaries.push(summary),
			}).get("https://example.com/slow", {
				retry: true,
				sensitiveParams: { serviceKey: secret },
			});
		} finally {
			Math.random = originalRandom;
		}

		expect(response?.data).toEqual({ ok: true });
		expect(mockNativeFetchState.calls).toHaveLength(2);
		expect(summaries).toEqual([
			{
				attempts: 2,
				retries: 1,
				preset: HttpRetryPreset.TransportTransient,
				transport: "native",
				lastErrorCode: "transport_timeout",
			},
		]);
	});

	it("classifies timeout failures before scrubbing the sensitive value from their code", async () => {
		mockNativeFetchState.queuedErrors.push(new Error("request timeout"));
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(
			http.get("https://example.com/slow", {
				sensitiveParams: { serviceKey: "timeout" },
			}),
		).rejects.toMatchObject({ code: "transport_[REDACTED]", status: 0 });
	});

	it("redacts declared keys when malformed request URLs fail before fetch", async () => {
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		let thrown: unknown;
		try {
			await http.get("http://[bad]/?serviceKey=api", {
				sensitiveParams: { serviceKey: "api" },
			});
		} catch (error) {
			thrown = error;
		}

		expect(String(thrown)).not.toContain("serviceKey=api");
		expect(String(thrown)).toContain("serviceKey=[REDACTED]");
		expect(mockNativeFetchState.calls).toHaveLength(0);
	});

	it("TransportTransient does not retry HTTP status failures", async () => {
		mockNativeFetchState.queuedResponses.push(
			{
				status: 503,
				body: "Unavailable",
				headers: { "content-type": "text/plain" },
			},
			{
				status: 200,
				body: "{}",
				headers: { "content-type": "application/json" },
			},
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(
			http.get("https://example.com", {
				retry: { preset: HttpRetryPreset.TransportTransient, baseDelayMs: 0 },
			}),
		).rejects.toMatchObject({
			code: "upstream_http_error",
			status: 503,
		});
		expect(mockNativeFetchState.calls).toHaveLength(1);
	});

	it("defaults proxy-routed GET requests to transient transport retry", async () => {
		const originalRandom = Math.random;
		Math.random = () => 0;
		mockNativeFetchState.queuedErrors.push(new Error("Network error"));
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient(undefined, { proxy: "http://proxy.test" });
		let response: Awaited<ReturnType<typeof http.get>> | undefined;
		try {
			response = await http.get("https://example.com");
		} finally {
			Math.random = originalRandom;
		}

		expect(response?.ok).toBeTrue();
		expect(response?.data).toEqual({ ok: true });
		expect(mockNativeFetchState.calls).toHaveLength(2);
		for (const call of mockNativeFetchState.calls) {
			expect((call.init as RequestInit & { proxy?: string })?.proxy).toBe("http://proxy.test");
		}
	});

	it("does not default-retry optional proxy policies that resolve without a proxy URL", async () => {
		const originalSmartproxyKey = process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		mockNativeFetchState.queuedErrors.push(new Error("Network error"));
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient(undefined, {
			upstream: {
				proxy: {
					mode: "optional",
					provider: "smartproxy",
					geo: { country: "KR" },
				},
			},
			warn: () => undefined,
		});

		try {
			await expect(http.get("https://example.com")).rejects.toMatchObject({
				code: "transport_network_error",
			});
			expect(mockNativeFetchState.calls).toHaveLength(1);
			expect(
				(mockNativeFetchState.calls[0]?.init as RequestInit & { proxy?: string })?.proxy,
			).toBeUndefined();
		} finally {
			if (originalSmartproxyKey === undefined) {
				delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
			} else {
				process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = originalSmartproxyKey;
			}
		}
	});

	it("honors explicit retry when optional proxy policies resolve without a proxy URL", async () => {
		const originalSmartproxyKey = process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		mockNativeFetchState.queuedErrors.push(new Error("Network error"));
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient(undefined, {
			upstream: {
				proxy: {
					mode: "optional",
					provider: "smartproxy",
					geo: { country: "KR" },
				},
			},
			warn: () => undefined,
		});

		try {
			const response = await http.get("https://example.com", {
				retry: { preset: HttpRetryPreset.TransportTransient, baseDelayMs: 0 },
			});

			expect(response.data).toEqual({ ok: true });
			expect(mockNativeFetchState.calls).toHaveLength(2);
			for (const call of mockNativeFetchState.calls) {
				expect((call.init as RequestInit & { proxy?: string })?.proxy).toBe(undefined);
			}
		} finally {
			if (originalSmartproxyKey === undefined) {
				delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
			} else {
				process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = originalSmartproxyKey;
			}
		}
	});

	it("rotates provider-policy proxy attempts across default HTTP retries", async () => {
		const originalSmartproxyKey = process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		const originalFetch = globalThis.fetch;
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const upstreamCalls: MockNativeFetchCall[] = [];
		globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("smartproxy.org/web_v1/ip/get-ip-v3")) {
				return new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), { status: 200 });
			}
			upstreamCalls.push({ url, init });
			if (upstreamCalls.length === 1) {
				throw new Error("Network error");
			}
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
				status: 200,
			});
		}) as typeof fetch;

		const { clearProxyResolutionCache } = await import("../config/loader.js");
		clearProxyResolutionCache();
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient(undefined, {
			affinityKey: "http_retry_rotation",
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			warn: () => undefined,
		});

		try {
			const response = await http.get("https://example.com");

			expect(response.data).toEqual({ ok: true });
			expect(upstreamCalls).toHaveLength(2);
			expect((upstreamCalls[0]?.init as RequestInit & { proxy?: string })?.proxy).toBe(
				"http://5.78.24.25:31001",
			);
			expect((upstreamCalls[1]?.init as RequestInit & { proxy?: string })?.proxy).toBe(
				"http://5.78.24.26:31002",
			);
		} finally {
			clearProxyResolutionCache();
			globalThis.fetch = originalFetch;
			if (originalSmartproxyKey === undefined) {
				delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
			} else {
				process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = originalSmartproxyKey;
			}
		}
	});

	it("does not default-retry proxy-routed GET requests when retry is false", async () => {
		mockNativeFetchState.queuedErrors.push(new Error("Network error"));
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient(undefined, { proxy: "http://proxy.test" });

		await expect(http.get("https://example.com", { retry: false })).rejects.toMatchObject({
			code: "transport_network_error",
		});
		expect(mockNativeFetchState.calls).toHaveLength(1);
	});

	it("does not default-retry proxy-routed POST requests", async () => {
		mockNativeFetchState.queuedErrors.push(new Error("Network error"));
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient(undefined, { proxy: "http://proxy.test" });

		await expect(http.post("https://example.com", { ok: true })).rejects.toMatchObject({
			code: "transport_network_error",
		});
		expect(mockNativeFetchState.calls).toHaveLength(1);
	});

	it("SafeRead retries configured HTTP statuses and preserves terminal HTTP error shape", async () => {
		mockNativeFetchState.queuedResponses.push(
			{
				status: 503,
				body: "Unavailable",
				headers: { "content-type": "text/plain" },
			},
			{
				status: 503,
				body: "Still unavailable",
				headers: { "content-type": "text/plain" },
			},
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(
			http.get("https://example.com", {
				retry: {
					preset: HttpRetryPreset.SafeRead,
					attempts: 2,
					baseDelayMs: 0,
				},
			}),
		).rejects.toMatchObject({
			code: "upstream_http_error",
			status: 503,
			upstreamStatus: 503,
		});
		expect(mockNativeFetchState.calls).toHaveLength(2);
	});

	it("SafeRead retries status failures before parsing invalid error bodies", async () => {
		mockNativeFetchState.queuedResponses.push(
			{
				status: 503,
				body: "{not-json",
				headers: { "content-type": "application/json" },
			},
			{
				status: 200,
				body: JSON.stringify({ ok: true }),
				headers: { "content-type": "application/json" },
			},
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const response = await http.get("https://example.com", {
			retry: {
				preset: HttpRetryPreset.SafeRead,
				baseDelayMs: 0,
			},
		});

		expect(response.data).toEqual({ ok: true });
		expect(mockNativeFetchState.calls).toHaveLength(2);
	});

	it("does not status-retry when caller opts into inspecting non-2xx responses", async () => {
		mockNativeFetchState.queuedResponses.push(
			{
				status: 503,
				body: "Unavailable",
				headers: { "content-type": "text/plain" },
			},
			{
				status: 200,
				body: "{}",
				headers: { "content-type": "application/json" },
			},
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();
		const response = await http.get("https://example.com", {
			retry: { preset: HttpRetryPreset.SafeRead, baseDelayMs: 0 },
			throwOnHttpError: false,
		});

		expect(response.status).toBe(503);
		expect(mockNativeFetchState.calls).toHaveLength(1);
	});

	it("does not retry POST for safe presets by default", async () => {
		mockNativeFetchState.queuedErrors.push(new Error("Network error"));
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(
			http.post("https://example.com", { ok: true }, { retry: true }),
		).rejects.toMatchObject({ code: "transport_network_error" });
		expect(mockNativeFetchState.calls).toHaveLength(1);
	});

	it("rejects custom unsafe retry methods unless explicitly allowed", async () => {
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(
			http.post(
				"https://example.com",
				{ ok: true },
				{
					retry: { methods: ["POST"], attempts: 2, baseDelayMs: 0 },
				},
			),
		).rejects.toMatchObject({ code: "retry_unsafe_method" });
		expect(mockNativeFetchState.calls).toHaveLength(0);
	});

	it("rejects invalid retry presets with a stable provider-facing error", async () => {
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(
			http.get("https://example.com", {
				retry: "definitely_not_a_preset" as HttpRetryPreset,
			}),
		).rejects.toMatchObject({ code: "retry_invalid_policy" });
		await expect(
			http.get("https://example.com", {
				retry: {
					preset: "also_not_a_preset" as HttpRetryPreset,
				},
			}),
		).rejects.toMatchObject({ code: "retry_invalid_policy" });
		expect(mockNativeFetchState.calls).toHaveLength(0);
	});

	it("redacts sensitiveParams from method and retry preflight failures", async () => {
		const methodSecret = "INVALID_METHOD_SECRET";
		const retrySecret = "definitely_not_a_preset";
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(
			http.request("https://example.com", {
				method: methodSecret as never,
				sensitiveParams: { token: methodSecret },
			}),
		).rejects.toMatchObject({
			code: "transport_invalid_method",
			message: "Unsupported HTTP method: [REDACTED]",
		});
		let retryError: unknown;
		try {
			await http.get("https://example.com", {
				retry: retrySecret as HttpRetryPreset,
				sensitiveParams: { token: retrySecret },
			});
		} catch (error) {
			retryError = error;
		}
		expect(retryError).toBeInstanceOf(Error);
		expect((retryError as Error).message).not.toContain(retrySecret);
		expect(JSON.stringify(retryError)).not.toContain(retrySecret);
		expect(mockNativeFetchState.calls).toHaveLength(0);
	});

	it("rejects malformed retry option values before issuing a request", async () => {
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(
			http.get("https://example.com", {
				retry: [] as unknown as HttpRetryPreset,
			}),
		).rejects.toMatchObject({ code: "retry_invalid_policy" });
		await expect(
			http.get("https://example.com", {
				retry: {
					methods: ["CONNECT" as unknown as "GET"],
				},
			}),
		).rejects.toMatchObject({ code: "retry_invalid_policy" });
		await expect(
			http.get("https://example.com", {
				retry: {
					jitter: "some_jitter" as HttpRetryJitter,
				},
			}),
		).rejects.toMatchObject({ code: "retry_invalid_policy" });
		await expect(
			http.get("https://example.com", {
				retry: {
					statusCodes: [42],
				},
			}),
		).rejects.toMatchObject({ code: "retry_invalid_policy" });
		expect(mockNativeFetchState.calls).toHaveLength(0);
	});

	it("rejects retry-enabling overrides when preset is Off", async () => {
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(
			http.get("https://example.com", {
				retry: {
					preset: HttpRetryPreset.Off,
					attempts: 2,
					baseDelayMs: 0,
				},
			}),
		).rejects.toMatchObject({ code: "retry_invalid_policy" });
		await expect(
			http.get("https://example.com", {
				retry: {
					preset: HttpRetryPreset.Off,
					statusCodes: [503],
				},
			}),
		).rejects.toMatchObject({ code: "retry_invalid_policy" });
		expect(mockNativeFetchState.calls).toHaveLength(0);
	});

	it("allows explicit read-like POST retry when unsafe policy is acknowledged", async () => {
		mockNativeFetchState.queuedErrors.push(new Error("Network error"));
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await http.post(
			"https://example.com",
			{ ok: true },
			{
				retry: {
					methods: ["POST"],
					attempts: 2,
					baseDelayMs: 0,
					unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.AllowExplicitUnsafe,
				},
			},
		);
		expect(mockNativeFetchState.calls).toHaveLength(2);
	});

	it("caps Retry-After delays by maxDelayMs", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const delays: number[] = [];
		globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number) => {
			delays.push(Number(timeout ?? 0));
			if (typeof handler === "function") {
				queueMicrotask(handler as () => void);
			}
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		try {
			mockNativeFetchState.queuedResponses.push(
				{
					status: 503,
					body: "Unavailable",
					headers: {
						"content-type": "text/plain",
						"retry-after": "120",
					},
				},
				{
					status: 200,
					body: "{}",
					headers: { "content-type": "application/json" },
				},
			);

			const { createHttpClient } = await import("../runtime/http.js");
			const http = createHttpClient();
			await http.get("https://example.com", {
				retry: {
					preset: HttpRetryPreset.SafeRead,
					attempts: 2,
					jitter: HttpRetryJitter.None,
					maxDelayMs: 25,
					retryAfter: HttpRetryAfterPolicy.Cap,
				},
			});

			expect(delays).toEqual([25]);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});

	it("distinguishes bounded Retry-After respect from cap-to-backoff behavior", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const delays: number[] = [];
		globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number) => {
			delays.push(Number(timeout ?? 0));
			if (typeof handler === "function") {
				queueMicrotask(handler as () => void);
			}
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout;
		try {
			mockNativeFetchState.queuedResponses.push(
				{
					status: 503,
					body: "Unavailable",
					headers: {
						"content-type": "text/plain",
						"retry-after": "2",
					},
				},
				{
					status: 200,
					body: "{}",
					headers: { "content-type": "application/json" },
				},
				{
					status: 503,
					body: "Unavailable",
					headers: {
						"content-type": "text/plain",
						"retry-after": "2",
					},
				},
				{
					status: 200,
					body: "{}",
					headers: { "content-type": "application/json" },
				},
			);

			const { createHttpClient } = await import("../runtime/http.js");
			const http = createHttpClient();
			await http.get("https://example.com/respect", {
				retry: {
					preset: HttpRetryPreset.SafeRead,
					attempts: 2,
					baseDelayMs: 100,
					jitter: HttpRetryJitter.None,
					maxDelayMs: 5_000,
					retryAfter: HttpRetryAfterPolicy.Respect,
				},
			});
			await http.get("https://example.com/cap", {
				retry: {
					preset: HttpRetryPreset.SafeRead,
					attempts: 2,
					baseDelayMs: 100,
					jitter: HttpRetryJitter.None,
					maxDelayMs: 5_000,
					retryAfter: HttpRetryAfterPolicy.Cap,
				},
			});

			expect(delays).toEqual([2_000, 100]);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});

	it("retries native HTTP through the configured proxy without switching transports", async () => {
		mockNativeFetchState.queuedErrors.push(new Error("Network error"), new Error("Network error"));
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com", {
			proxy: "http://proxy.test",
		});

		await http.get("/resource", {
			retry: {
				preset: HttpRetryPreset.TransportTransient,
				attempts: 3,
				baseDelayMs: 0,
			},
		});

		expect(mockNativeFetchState.calls).toHaveLength(3);
		for (const call of mockNativeFetchState.calls) {
			expect((call.init as RequestInit & { proxy?: string })?.proxy).toBe("http://proxy.test");
		}
	});

	it("preserves timeout error classification from the native transport", async () => {
		const timeoutError = new Error("operation timed out after 100ms");
		timeoutError.name = "TimeoutError";
		mockNativeFetchState.queuedErrors.push(timeoutError);

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(http.get("https://example.com/slow", { timeout: 100 })).rejects.toMatchObject({
			code: "transport_timeout",
			status: 0,
		});
	});

	it("defaults proxy-routed GET timeout failures to transient transport retry", async () => {
		const originalRandom = Math.random;
		Math.random = () => 0;
		const timeoutError = new Error("operation timed out after 100ms");
		timeoutError.name = "TimeoutError";
		mockNativeFetchState.queuedErrors.push(timeoutError);
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient(undefined, { proxy: "http://proxy.test" });
		try {
			const response = await http.get("https://example.com/slow", {
				timeout: 100,
			});

			expect(response.data).toEqual({ ok: true });
			expect(mockNativeFetchState.calls).toHaveLength(2);
			for (const call of mockNativeFetchState.calls) {
				expect((call.init as RequestInit & { proxy?: string })?.proxy).toBe("http://proxy.test");
			}
		} finally {
			Math.random = originalRandom;
		}
	});

	it("fails clearly for relative URLs without an upstream base URL", async () => {
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await expect(http.get("/relative")).rejects.toMatchObject({
			code: "transport_invalid_url",
			message: "ctx.http requires an absolute URL when provider.upstream.baseUrl is not declared",
		});
		expect(mockNativeFetchState.calls).toHaveLength(0);
	});

	it("put() sends body with PUT method", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await http.put("https://example.com/resource", { data: "updated" });
		expect(mockNativeFetchState.calls[0]?.init?.method).toBe("PUT");
	});

	it("delete() sends DELETE method", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await http.delete("https://example.com/resource");
		expect(mockNativeFetchState.calls[0]?.init?.method).toBe("DELETE");
	});

	it("request() uses GET by default and supports custom methods and body", async () => {
		mockNativeFetchState.queuedResponses.push(
			{
				status: 200,
				body: "{}",
				headers: { "content-type": "application/json" },
			},
			{
				status: 200,
				body: "{}",
				headers: { "content-type": "application/json" },
			},
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient();

		await http.request("https://example.com/default");
		await http.request("https://example.com/custom", {
			body: { patched: true },
			method: "PATCH",
		});

		expect(mockNativeFetchState.calls[0]?.init).toEqual(expect.objectContaining({ method: "GET" }));
		expect(mockNativeFetchState.calls[1]?.init).toEqual(
			expect.objectContaining({
				body: JSON.stringify({ patched: true }),
				method: "PATCH",
			}),
		);
	});

	it("rejects stealth transport overrides on ctx.http", async () => {
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com");

		await expect(http.get("/profiled", { profile: "chrome-146" } as never)).rejects.toMatchObject({
			code: "http_transport_override_unsupported",
		});
		await expect(
			http.get("/profiled", { stealth: { profile: "chrome-146" } } as never),
		).rejects.toMatchObject({ code: "http_transport_override_unsupported" });
		expect(mockNativeFetchState.calls).toHaveLength(0);
	});

	it("routes TRACE through native HTTP instead of stealth fallback", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com");

		await http.request("/trace", { method: "TRACE" });

		expect(mockNativeFetchState.calls).toHaveLength(1);
		expect(mockNativeFetchState.calls[0]?.url).toBe("https://example.com/trace");
		expect(mockNativeFetchState.calls[0]?.init).toMatchObject({
			method: "TRACE",
		});
	});

	it("keeps provider stealth profile out of ctx.http headers", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com", {
			userAgent: "native-agent",
		});

		await http.get("/resource", {
			headers: { "Accept-Language": "en-US" },
		});

		expect(mockNativeFetchState.calls[0]?.init?.headers).toEqual({
			"Accept-Language": "en-US",
			"User-Agent": "native-agent",
		});
	});
});
