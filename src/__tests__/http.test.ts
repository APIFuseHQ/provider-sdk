import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { TransportError } from "../errors";
import {
	HttpRetryAfterPolicy,
	HttpRetryJitter,
	HttpRetryPreset,
	HttpRetryUnsafeMethodPolicy,
} from "../types";

type MockImpitResponse = {
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
	queuedResponses: [] as MockImpitResponse[],
	queuedErrors: [] as Error[],
};

const originalFetch = globalThis.fetch;

describe("createHttpClient", () => {
	beforeEach(() => {
		mockNativeFetchState.calls.length = 0;
		mockNativeFetchState.lastResponse = undefined;
		mockNativeFetchState.queuedResponses.length = 0;
		mockNativeFetchState.queuedErrors.length = 0;
		globalThis.fetch = mock(
			async (input: string | URL | Request, init?: RequestInit) => {
				mockNativeFetchState.calls.push({ url: String(input), init });
				const error = mockNativeFetchState.queuedErrors.shift();
				if (error) throw error;
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
			},
		) as typeof fetch;
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

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient();
		const result = await http.get("https://httpbin.org/get", {
			params: { q: "1" },
		});

		expect(mockNativeFetchState.calls[0]?.url).toBe(
			"https://httpbin.org/get?q=1",
		);
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

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient();
		const result = await http.get("https://example.com/empty-json");

		expect(result.data).toBeNull();
		expect(await result.json()).toBeNull();
	});

	it("normalizes rich params and preserves existing query strings", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createHttpClient } = await import("../runtime/http");
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

	it("post() sends body and returns response", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ json: { key: "value" } }),
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient();
		const result = await http.post("https://httpbin.org/post", {
			key: "value",
		});

		expect(mockNativeFetchState.calls[0]?.init?.body).toBe(
			JSON.stringify({ key: "value" }),
		);
		expect(result.data).toEqual({ json: { key: "value" } });
		expect(await result.text()).toBe(
			JSON.stringify({ json: { key: "value" } }),
		);
	});

	it("stream() exposes native response body without eager text buffering", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "first\nsecond\n",
			headers: { "content-type": "text/plain" },
		});

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient();
		const response = await http.stream("https://example.com/logs");

		expect(response.status).toBe(200);
		expect(response.headers["content-type"]).toBe("text/plain");
		expect(mockNativeFetchState.lastResponse?.bodyUsed).toBe(false);
		const lines: string[] = [];
		for await (const line of response.lines()) lines.push(line);
		expect(lines).toEqual(["first", "second"]);
	});

	it("sse() parses native EventSource frames incrementally", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: 'id: evt_1\nevent: delta\ndata: {"value":1}\n\n',
			headers: { "content-type": "text/event-stream" },
		});

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient(undefined, { proxy: "http://proxy.test" });

		const response = await http.stream("https://example.com/events");

		expect(response.status).toBe(200);
		expect(
			(mockNativeFetchState.calls[0]?.init as RequestInit & { proxy?: string })
				?.proxy,
		).toBe("http://proxy.test");
	});

	it("post() preserves caller-encoded string bodies", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient();

		await http.get("https://first.example/session");
		await http.get("https://second.example/resource");

		expect(mockNativeFetchState.calls).toHaveLength(2);
		expect(mockNativeFetchState.calls[1]?.init?.headers).not.toHaveProperty(
			"Cookie",
		);
	});

	it("throws TransportError on 4xx by default", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 404,
			body: "Not Found",
			headers: { "content-type": "text/plain" },
		});

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient();

		await expect(http.get("https://example.com/not-found")).rejects.toThrow(
			TransportError,
		);
		expect(mockNativeFetchState.lastResponse?.bodyUsed).toBe(true);
	});

	it("returns non-2xx response when HTTP errors are not thrown", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 422,
			body: '{"error":"invalid"}',
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient();

		await expect(http.get("https://example.com")).rejects.toMatchObject({
			code: "transport_network_error",
			status: 0,
			message: "Network error",
		});
	});

	it("does not retry when retry is omitted", async () => {
		mockNativeFetchState.queuedErrors.push(new Error("Network error"));
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
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
			expect((call.init as RequestInit & { proxy?: string })?.proxy).toBe(
				"http://proxy.test",
			);
		}
	});

	it("defaults provider-policy proxy GET requests to transient transport retry", async () => {
		const originalRandom = Math.random;
		Math.random = () => 0;
		mockNativeFetchState.queuedErrors.push(new Error("Network error"));
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient(undefined, {
			upstream: {
				proxy: {
					mode: "optional",
					provider: "custom",
					geo: { country: "KR" },
				},
			},
			apifuseConfig: { proxy: { url: "http://proxy.test" } },
		});
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
			expect((call.init as RequestInit & { proxy?: string })?.proxy).toBe(
				"http://proxy.test",
			);
		}
	});

	it("does not default-retry proxy-routed GET requests when retry is false", async () => {
		mockNativeFetchState.queuedErrors.push(new Error("Network error"));
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient(undefined, { proxy: "http://proxy.test" });

		await expect(
			http.get("https://example.com", { retry: false }),
		).rejects.toMatchObject({
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

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient(undefined, { proxy: "http://proxy.test" });

		await expect(
			http.post("https://example.com", { ok: true }),
		).rejects.toMatchObject({
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

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient();

		await expect(
			http.post("https://example.com", { ok: true }, { retry: true }),
		).rejects.toMatchObject({ code: "transport_network_error" });
		expect(mockNativeFetchState.calls).toHaveLength(1);
	});

	it("rejects custom unsafe retry methods unless explicitly allowed", async () => {
		const { createHttpClient } = await import("../runtime/http");
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
		const { createHttpClient } = await import("../runtime/http");
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

	it("rejects malformed retry option values before issuing a request", async () => {
		const { createHttpClient } = await import("../runtime/http");
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
		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
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
		globalThis.setTimeout = ((
			handler: Parameters<typeof setTimeout>[0],
			timeout?: number,
		) => {
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

			const { createHttpClient } = await import("../runtime/http");
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
		globalThis.setTimeout = ((
			handler: Parameters<typeof setTimeout>[0],
			timeout?: number,
		) => {
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

			const { createHttpClient } = await import("../runtime/http");
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
		mockNativeFetchState.queuedErrors.push(
			new Error("Network error"),
			new Error("Network error"),
		);
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http");
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
			expect((call.init as RequestInit & { proxy?: string })?.proxy).toBe(
				"http://proxy.test",
			);
		}
	});

	it("preserves timeout error classification from the native transport", async () => {
		const timeoutError = new Error("operation timed out after 100ms");
		timeoutError.name = "TimeoutError";
		mockNativeFetchState.queuedErrors.push(timeoutError);

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient();

		await expect(
			http.get("https://example.com/slow", { timeout: 100 }),
		).rejects.toMatchObject({
			code: "transport_timeout",
			status: 0,
		});
	});

	it("fails clearly for relative URLs without an upstream base URL", async () => {
		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient();

		await expect(http.get("/relative")).rejects.toMatchObject({
			code: "transport_invalid_url",
			message:
				"ctx.http requires an absolute URL when provider.upstream.baseUrl is not declared",
		});
		expect(mockNativeFetchState.calls).toHaveLength(0);
	});

	it("put() sends body with PUT method", async () => {
		mockNativeFetchState.queuedResponses.push({
			status: 200,
			body: "{}",
			headers: { "content-type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
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

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient();

		await http.request("https://example.com/default");
		await http.request("https://example.com/custom", {
			body: { patched: true },
			method: "PATCH",
		});

		expect(mockNativeFetchState.calls[0]?.init).toEqual(
			expect.objectContaining({ method: "GET" }),
		);
		expect(mockNativeFetchState.calls[1]?.init).toEqual(
			expect.objectContaining({
				body: JSON.stringify({ patched: true }),
				method: "PATCH",
			}),
		);
	});

	it("rejects stealth transport overrides on ctx.http", async () => {
		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient("https://example.com");

		await expect(
			http.get("/profiled", { profile: "chrome-146" } as never),
		).rejects.toMatchObject({ code: "http_transport_override_unsupported" });
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

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient("https://example.com");

		await http.request("/trace", { method: "TRACE" });

		expect(mockNativeFetchState.calls).toHaveLength(1);
		expect(mockNativeFetchState.calls[0]?.url).toBe(
			"https://example.com/trace",
		);
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

		const { createHttpClient } = await import("../runtime/http");
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
