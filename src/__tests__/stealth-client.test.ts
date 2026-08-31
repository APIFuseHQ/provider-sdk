import { beforeEach, describe, expect, it, mock } from "bun:test";
import { z } from "zod";

import { assertIsError, createProviderDefinitionDouble, emptyArray } from "./test-utils.js";
import {
	ProviderError,
	SDKError,
	StealthCookieStoreVersionError,
	TransportError,
} from "../errors.js";
import { normalizeResponse } from "../runtime/stealth.js";
import {
	type DeclarativeStealthResponse,
	HttpRetryUnsafeMethodPolicy,
	type StealthCookieStoreV1,
	type StealthRedirectHop,
	type ProviderDefinition,
} from "../types.js";

type MockSessionCookie = {
	name: string;
	value: string;
	domain?: string;
	path?: string;
	secure: boolean;
	httpOnly: boolean;
	sameSite?: "lax" | "strict" | "none";
	expiresAtMs?: number;
};

type MockWreqResponse = {
	status: number;
	body: string;
	headers?: Record<string, string | string[]>;
	arrayBufferBody?: Uint8Array;
	streamChunks?: Uint8Array[];
	streamState?: MockBodyState;
	url?: string;
	omitUrl?: boolean;
	redirected?: boolean;
	sessionCookies?: MockSessionCookie[];
	beforeReturn?: (init?: Record<string, unknown>) => Promise<void>;
	beforeArrayBuffer?: () => Promise<void>;
	beforeStreamPull?: (pullIndex: number) => Promise<void>;
};

type MockBodyState = {
	arrayBufferCalls: number;
	pulledChunks: number;
	cancelled: boolean;
};

type MockWreqCall = {
	url: string;
	init?: Record<string, unknown>;
};

type MockStealthClientState = {
	calls: MockWreqCall[];
	options: Record<string, unknown> | undefined;
	cookies: MockSessionCookie[];
	clearCookieCalls: number;
	closed: boolean;
};

const mockStealthState = {
	clients: [] as MockStealthClientState[],
	queuedResponses: [] as MockWreqResponse[],
	queuedErrors: [] as (Error | (() => Error))[],
	queuedCloseErrors: emptyArray<Error>(),
};

function toHeaders(headers: MockWreqResponse["headers"]): Headers {
	const result = new Headers();
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (Array.isArray(value)) {
			for (const item of value) result.append(name, item);
		} else {
			result.append(name, value);
		}
	}
	return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function createMockBodyState(): MockBodyState {
	return {
		arrayBufferCalls: 0,
		pulledChunks: 0,
		cancelled: false,
	};
}

function byteChunks(...chunks: string[]): Uint8Array[] {
	return chunks.map((chunk) => new TextEncoder().encode(chunk));
}

function toWreqResponse(response: MockWreqResponse) {
	const headers = toHeaders(response.headers);
	const responseBytes = response.arrayBufferBody ?? new TextEncoder().encode(response.body);
	const streamChunks = response.streamChunks ?? [responseBytes];
	const streamState = response.streamState ?? createMockBodyState();
	let stream: ReadableStream<Uint8Array> | undefined;
	let nextChunk = 0;
	return {
		status: response.status,
		ok: response.status >= 200 && response.status < 300,
		headers,
		...(response.omitUrl ? {} : { url: response.url ?? "https://example.com/final" }),
		redirected: response.redirected,
		json: async () => JSON.parse(response.body),
		text: async () => response.body,
		arrayBuffer: async () => {
			streamState.arrayBufferCalls += 1;
			await response.beforeArrayBuffer?.();
			if (streamState.cancelled) throw new DOMException("response body cancelled", "AbortError");
			return toArrayBuffer(responseBytes);
		},
		get body() {
			stream ??= new ReadableStream<Uint8Array>({
				async pull(controller) {
					await response.beforeStreamPull?.(nextChunk);
					if (streamState.cancelled) return;
					const chunk = streamChunks[nextChunk];
					if (!chunk) {
						controller.close();
						return;
					}
					nextChunk += 1;
					streamState.pulledChunks += 1;
					controller.enqueue(chunk);
					if (nextChunk === streamChunks.length) controller.close();
				},
				cancel() {
					streamState.cancelled = true;
				},
			});
			return stream;
		},
	};
}

class MockWreqSession {
	private readonly state: MockStealthClientState;

	constructor(options?: Record<string, unknown>) {
		this.state = { calls: [], options, cookies: [], clearCookieCalls: 0, closed: false };
		mockStealthState.clients.push(this.state);
	}

	async fetch(url: string, init?: Record<string, unknown>) {
		this.state.calls.push({ url, init });
		const queuedError = mockStealthState.queuedErrors.shift();
		if (queuedError) throw typeof queuedError === "function" ? queuedError() : queuedError;
		const response = mockStealthState.queuedResponses.shift();
		if (!response) throw new Error("No queued response");
		this.state.cookies = response.sessionCookies ? [...response.sessionCookies] : [];
		await response.beforeReturn?.(init);
		return toWreqResponse(response);
	}

	async clearCookies() {
		this.state.clearCookieCalls += 1;
		this.state.cookies = [];
	}

	getCookies(url: string | URL) {
		const hostname = new URL(url).hostname;
		return Object.fromEntries(
			this.state.cookies
				.filter((cookie) => !cookie.domain || hostname.endsWith(cookie.domain.replace(/^\./, "")))
				.map((cookie) => [cookie.name, cookie.value]),
		);
	}

	getAllCookies() {
		return [...this.state.cookies];
	}

	setCookie(name: string, value: string, url: string | URL) {
		this.state.cookies.push({
			name,
			value,
			domain: new URL(url).hostname,
			path: "/",
			secure: new URL(url).protocol === "https:",
			httpOnly: false,
		});
	}

	async close() {
		this.state.closed = true;
		const error = mockStealthState.queuedCloseErrors.shift();
		if (error) throw error;
	}
}

mock.module("wreq-js", () => ({
	createSession: async (options?: Record<string, unknown>) => new MockWreqSession(options),
	getEmulationHeaders: (profile: string) => {
		const version = /^chrome_(\d+)$/.exec(profile)?.[1] ?? "149";
		return new Map([
			[
				"user-agent",
				`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`,
			],
		]);
	},
	getProfiles: () => [
		"chrome_145",
		"chrome_146",
		"chrome_149",
		"firefox_128",
		"firefox_133",
		"firefox_135",
		"firefox_147",
		"safari_15.5",
		"safari_15.6.1",
		"safari_16",
		"safari_16.5",
		"safari_17.0",
		"safari_17.2.1",
		"safari_ios_17.2",
		"safari_ios_18.1.1",
		"safari_ios_26",
	],
}));

describe("createStealthClient", () => {
	beforeEach(() => {
		mockStealthState.clients.length = 0;
		mockStealthState.queuedResponses.length = 0;
		mockStealthState.queuedErrors.length = 0;
		mockStealthState.queuedCloseErrors.length = 0;
	});

	it("returns fetch and createSession functions", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");

		const client = createStealthClient("https://example.com");

		expect(client.fetch).toBeFunction();
		expect(client.createSession).toBeFunction();
	});

	it("cancels an in-flight stealth fetch with the SDK transport cancellation error", async () => {
		const controller = new AbortController();
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "too late",
			headers: {},
			beforeReturn: async (init) => {
				const signal = init?.signal;
				if (!(signal instanceof AbortSignal)) return;
				markStarted();
				await new Promise<void>((_resolve, reject) => {
					const onAbort = () => reject(new DOMException("native request aborted", "AbortError"));
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) onAbort();
				});
			},
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", { signal: controller.signal });
		const request = client.fetch("/slow");
		await started;
		controller.abort(new Error("gateway request abandoned"));

		await expect(request).rejects.toBeInstanceOf(TransportError);
		await expect(request).rejects.toMatchObject({
			name: "TransportError",
			code: "transport_cancelled",
			status: 0,
			message: "Request cancelled",
			options: { retryable: false },
		});
		expect(mockStealthState.clients[0]?.calls).toHaveLength(1);
		expect(mockStealthState.clients[0]?.calls[0]?.init?.signal).toBe(controller.signal);
	});

	it("cancels an in-flight stealth response body with the SDK transport cancellation error", async () => {
		const controller = new AbortController();
		const streamState = createMockBodyState();
		let markPullStarted!: () => void;
		const pullStarted = new Promise<void>((resolve) => {
			markPullStarted = resolve;
		});
		const waitForAbort = async () => {
			markPullStarted();
			if (controller.signal.aborted) return;
			await new Promise<void>((resolve) => {
				controller.signal.addEventListener("abort", () => resolve(), { once: true });
			});
		};
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "slow body",
			headers: {},
			streamChunks: byteChunks("slow ", "body"),
			streamState,
			beforeArrayBuffer: waitForAbort,
			beforeStreamPull: waitForAbort,
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const request = createStealthClient("https://example.com", {
			signal: controller.signal,
		}).fetch("/slow-body");
		await pullStarted;
		controller.abort(new Error("gateway request abandoned during body read"));

		await expect(request).rejects.toMatchObject({
			name: "TransportError",
			code: "transport_cancelled",
			status: 0,
			options: { retryable: false },
		});
		expect(streamState.cancelled).toBe(true);
	});

	it("does not issue a stealth retry after the client signal aborts", async () => {
		const controller = new AbortController();
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		mockStealthState.queuedResponses.push(
			{
				status: 200,
				body: "first attempt",
				headers: {},
				beforeReturn: async (init) => {
					const signal = init?.signal;
					if (!(signal instanceof AbortSignal)) return;
					markStarted();
					await new Promise<void>((_resolve, reject) => {
						const onAbort = () =>
							reject(
								new TransportError("native request failed during abort", {
									code: "transport_network_error",
									status: 0,
								}),
							);
						signal.addEventListener("abort", onAbort, { once: true });
						if (signal.aborted) onAbort();
					});
				},
			},
			{ status: 200, body: "retry must not run", headers: {} },
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const request = createStealthClient("https://example.com", {
			signal: controller.signal,
		}).fetch("/slow", {
			proxy: "http://proxy.test",
			retry: { attempts: 2, baseDelayMs: 0, errorCodes: ["transport_network_error"] },
		});
		await started;
		controller.abort(new Error("gateway deadline exceeded"));

		await expect(request).rejects.toMatchObject({ code: "transport_cancelled" });
		expect(mockStealthState.clients[0]?.calls).toHaveLength(1);
		expect(mockStealthState.queuedResponses).toHaveLength(1);
	});

	it("records a cancelled proxy attempt when the client signal aborts", async () => {
		const controller = new AbortController();
		const attempts: unknown[] = [];
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "too late",
			headers: {},
			beforeReturn: async (init) => {
				const signal = init?.signal;
				if (!(signal instanceof AbortSignal)) return;
				markStarted();
				await new Promise<void>((_resolve, reject) => {
					const onAbort = () => reject(new DOMException("native request aborted", "AbortError"));
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) onAbort();
				});
			},
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const request = createStealthClient("https://example.com", {
			signal: controller.signal,
			telemetry: {
				recordProxyResolution: () => undefined,
				recordProxyAttempt: (event) => attempts.push(event),
			},
		}).fetch("/slow", { proxy: "http://proxy.test", retry: false });
		await started;
		controller.abort(new Error("gateway deadline exceeded"));

		await expect(request).rejects.toMatchObject({
			name: "TransportError",
			code: "transport_cancelled",
			status: 0,
			options: { retryable: false },
		});
		expect(attempts).toEqual([
			{
				provider: "smartproxy",
				attempt: 1,
				proxyHash: expect.any(String),
				outcome: "error",
				errorCode: "transport_cancelled",
				status: 0,
				durationMs: expect.any(Number),
			},
		]);
	});

	it("keeps the no-signal stealth request path byte-identical", async () => {
		const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "unused",
			headers: { "content-type": "application/octet-stream", "x-test": "unchanged" },
			arrayBufferBody: bytes,
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const response = await createStealthClient("https://example.com").fetch("/binary");

		expect(await response.bytes()).toEqual(bytes);
		expect(response.status).toBe(200);
		expect(response.headers).toEqual({
			"content-type": "application/octet-stream",
			"x-test": "unchanged",
		});
		expect(Object.hasOwn(mockStealthState.clients[0]?.calls[0]?.init ?? {}, "signal")).toBe(false);
	});

	it("keeps signal-backed uncapped responses on wreq arrayBuffer to avoid double buffering", async () => {
		const controller = new AbortController();
		const streamState = createMockBodyState();
		mockStealthState.queuedResponses.push({
			status: 200,
			body: '{"source":"arrayBuffer"}',
			headers: { "content-type": "application/json" },
			streamChunks: byteChunks('{"source":"stream"}'),
			streamState,
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const response = await createStealthClient("https://example.com", {
			signal: controller.signal,
		}).fetch("/uncapped-with-signal");

		expect(response.body).toBe('{"source":"arrayBuffer"}');
		expect(streamState).toEqual({
			arrayBufferCalls: 1,
			pulledChunks: 0,
			cancelled: false,
		});
	});

	it("returns normalized response for successful fetch", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: '{"ok":true}',
			headers: {
				"content-type": "text/plain",
				"set-cookie": ["sid=abc; Path=/"],
			},
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		const response = (await client.fetch("/health", {
			headers: { accept: "text/plain" },
		})) as DeclarativeStealthResponse;

		expect(response.status).toBe(200);
		expect(response.ok).toBe(true);
		expect(response.headers).toEqual({
			"content-type": "text/plain",
			"set-cookie": "sid=abc; Path=/",
		});
		expect(response.rawHeaders).toEqual([
			["content-type", "text/plain"],
			["set-cookie", "sid=abc; Path=/"],
		]);
		expect(response.cookies.get("sid")).toBe("abc");
		expect(response.cookies.getAll()).toEqual({ sid: "abc" });
		expect(response.cookies.toString()).toBe("sid=abc");
		await expect(response.json<{ ok: boolean }>()).resolves.toEqual({
			ok: true,
		});
	});

	it("keeps the uncapped response path on wreq arrayBuffer", async () => {
		const streamState = createMockBodyState();
		mockStealthState.queuedResponses.push({
			status: 200,
			body: '{"source":"arrayBuffer"}',
			headers: { "content-type": "application/json" },
			streamChunks: byteChunks('{"source":"stream"}'),
			streamState,
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const response = await createStealthClient("https://example.com").fetch("/uncapped");

		expect(response.body).toBe('{"source":"arrayBuffer"}');
		expect(streamState).toEqual({
			arrayBufferCalls: 1,
			pulledChunks: 0,
			cancelled: false,
		});
	});

	it("returns a byte-identical response when the streamed body is under the cap", async () => {
		const bytes = new TextEncoder().encode('{"value":"decoded ☃"}');
		mockStealthState.queuedResponses.push(
			{
				status: 200,
				body: "unused",
				headers: { "content-type": "application/octet-stream" },
				arrayBufferBody: bytes,
			},
			{
				status: 200,
				body: "unused",
				headers: { "content-type": "application/octet-stream" },
				arrayBufferBody: bytes,
				streamChunks: [bytes.slice(0, 2), bytes.slice(2, 5), bytes.slice(5)],
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");
		const uncapped = await client.fetch("/binary");
		const capped = await client.fetch("/binary", { maxBodyBytes: 100 });

		expect(capped.body).toBe(uncapped.body);
		expect(new Uint8Array(await capped.arrayBuffer())).toEqual(
			new Uint8Array(await uncapped.arrayBuffer()),
		);
		expect(await capped.bytes()).toEqual(await uncapped.bytes());
		await expect(capped.json<{ value: string }>()).resolves.toEqual({ value: "decoded ☃" });
		expect(capped.headers).toEqual(uncapped.headers);
		expect(capped.rawHeaders).toEqual(uncapped.rawHeaders);
	});

	it("allows a streamed body exactly at maxBodyBytes", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "exact",
			headers: {},
			streamChunks: byteChunks("ex", "act"),
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const response = await createStealthClient("https://example.com").fetch("/exact", {
			maxBodyBytes: 5,
		});

		expect(response.body).toBe("exact");
	});

	it("cancels a chunked response as soon as its streamed body exceeds maxBodyBytes", async () => {
		const streamState = createMockBodyState();
		const streamChunks = byteChunks("abc", "def", "ghi", "jkl", "mno");
		mockStealthState.queuedResponses.push({
			status: 200,
			body: streamChunks.map((chunk) => new TextDecoder().decode(chunk)).join(""),
			headers: {},
			streamChunks,
			streamState,
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const request = createStealthClient("https://example.com").fetch("/chunked", {
			maxBodyBytes: 5,
		});

		await expect(request).rejects.toMatchObject({
			name: "TransportError",
			code: "response_too_large",
			message: "Response body exceeded maxBodyBytes limit of 5 bytes (observed 6 bytes)",
			options: {
				category: "upstream_http",
				retryable: false,
			},
		});
		expect(streamState.cancelled).toBe(true);
		expect(streamState.pulledChunks).toBeLessThan(streamChunks.length);
	});

	it("fast-fails an over-cap Content-Length before reading the body", async () => {
		const streamState = createMockBodyState();
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "never read",
			headers: { "content-length": "100" },
			streamChunks: byteChunks("never", " read"),
			streamState,
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const request = createStealthClient("https://example.com").fetch("/declared-large", {
			maxBodyBytes: 10,
		});

		await expect(request).rejects.toMatchObject({
			code: "response_too_large",
			message: "Response body exceeded maxBodyBytes limit of 10 bytes (observed 100 bytes)",
		});
		expect(streamState.pulledChunks).toBe(0);
		expect(streamState.arrayBufferCalls).toBe(0);
		expect(streamState.cancelled).toBe(true);
	});

	it("enforces streamed bytes when Content-Length lies below the cap", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "abcdef",
			headers: { "content-length": "2" },
			streamChunks: byteChunks("abc", "def"),
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		await expect(
			createStealthClient("https://example.com").fetch("/lying-length", {
				maxBodyBytes: 5,
			}),
		).rejects.toMatchObject({
			code: "response_too_large",
			message: "Response body exceeded maxBodyBytes limit of 5 bytes (observed 6 bytes)",
		});
	});

	it("counts decoded chunks for compressed responses", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "expanded-body",
			headers: { "content-encoding": "gzip", "content-length": "4" },
			streamChunks: byteChunks("expanded", "-body"),
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		await expect(
			createStealthClient("https://example.com").fetch("/compressed", {
				maxBodyBytes: 10,
			}),
		).rejects.toMatchObject({
			code: "response_too_large",
			message: "Response body exceeded maxBodyBytes limit of 10 bytes (observed 13 bytes)",
		});
	});

	it("normalizes raw response metadata and false ok flag", async () => {
		const response = (await normalizeResponse({
			status: 400,
			headers: toHeaders({
				"content-type": "application/json",
				"set-cookie": "sid=xyz; Path=/",
				"x-test": "1",
			}),
			// @ts-expect-error test-invalid: the legacy text field is ignored in favor of arrayBuffer.
			text: async () => "text-first-corruption",
			arrayBuffer: async () => toArrayBuffer(new TextEncoder().encode('{"error":true}')),
		})) as DeclarativeStealthResponse;

		expect(response.ok).toBe(false);
		expect(response.rawHeaders).toEqual(
			expect.arrayContaining([
				["content-type", "application/json"],
				["set-cookie", "sid=xyz; Path=/"],
				["x-test", "1"],
			]),
		);
		expect(response.cookies.get("sid")).toBe("xyz");
		await expect(response.json<{ error: boolean }>()).resolves.toEqual({
			error: true,
		});
	});

	it("normalizes response url and redirected metadata when available", async () => {
		const response = await normalizeResponse(
			{
				status: 200,
				headers: toHeaders({ "content-type": "text/plain" }),
				url: "https://example.com/final",
				redirected: true,
				// @ts-expect-error test-invalid: legacy text field is ignored in favor of arrayBuffer
				text: async () => "text-first-corruption",
				arrayBuffer: async () => toArrayBuffer(new TextEncoder().encode("ok")),
			},
			"https://example.com/start",
		);

		expect(response.url).toBe("https://example.com/final");
		expect(response.redirected).toBe(true);
	});

	it("preserves multiple cookies when Headers.getSetCookie is unavailable", async () => {
		const headers = toHeaders({
			"set-cookie": "sid=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, csrf=def; Path=/",
		});
		Object.defineProperty(headers, "getSetCookie", { value: undefined });

		const response = (await normalizeResponse({
			status: 200,
			headers,
			// @ts-expect-error test-invalid: the legacy text field is ignored in favor of arrayBuffer.
			text: async () => "text-first-corruption",
			arrayBuffer: async () => toArrayBuffer(new TextEncoder().encode("ok")),
		})) as DeclarativeStealthResponse;

		expect(response.cookies.getAll()).toEqual({ sid: "abc", csrf: "def" });
		expect(response.rawHeaders).toEqual([
			["set-cookie", "sid=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, csrf=def; Path=/"],
		]);
	});

	it("throws TransportError on HTTP 500", async () => {
		mockStealthState.queuedResponses.push({
			status: 500,
			body: "boom",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		await expect(client.fetch("/fail")).rejects.toMatchObject({
			name: "TransportError",
			status: 500,
			message: "Upstream request failed with status 500",
		});
	});

	it("returns non-2xx response when HTTP errors are not thrown", async () => {
		mockStealthState.queuedResponses.push({
			status: 406,
			body: '{"resultCode":"BLOCKED","message":"rejected"}',
			headers: { "content-type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		const response = await client.fetch("/fail", {
			throwOnHttpError: false,
		});

		expect(response.status).toBe(406);
		expect(response.ok).toBe(false);
		expect(response.body).toBe('{"resultCode":"BLOCKED","message":"rejected"}');
		await expect(response.json()).resolves.toEqual({
			resultCode: "BLOCKED",
			message: "rejected",
		});
	});

	it("applies params to fetch URLs with the same normalization rules as ctx.http", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		await client.fetch("/items?existing=1", {
			params: {
				enabled: true,
				limit: 20,
				omit: undefined,
				tag: ["a", null, "b"],
			},
		});

		expect(mockStealthState.clients[0]?.calls[0]?.url).toBe(
			"https://example.com/items?existing=1&enabled=true&limit=20&tag=a&tag=b",
		);
	});

	it("sends sensitiveParams while preserving programmatic response URL metadata", async () => {
		const secret = "stealth-test-secret";
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
			url: `https://example.com/items?page=1&confmKey=${secret}`,
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");
		const response = await client.fetch("/items", {
			params: { page: 1 },
			sensitiveParams: { confmKey: secret },
		});

		expect(mockStealthState.clients[0]?.calls[0]?.url).toBe(
			`https://example.com/items?page=1&confmKey=${secret}`,
		);
		expect(response.url).toBe(`https://example.com/items?page=1&confmKey=${secret}`);
	});

	it("createSession reuses the same wreq session for matching browser/proxy settings", async () => {
		mockStealthState.queuedResponses.push(
			{ status: 200, body: "first", headers: { a: "1" } },
			{ status: 200, body: "second", headers: { a: "2" } },
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const warnings: string[] = [];
		const client = createStealthClient("https://example.com", {
			warn: (message) => warnings.push(message),
		});
		const session = client.createSession();

		await session.fetch("/one");
		await session.fetch("/two");

		expect(mockStealthState.clients).toHaveLength(1);
		expect(mockStealthState.clients[0]?.calls).toEqual([
			expect.objectContaining({
				url: "https://example.com/one",
				init: expect.objectContaining({ method: "GET" }),
			}),
			expect.objectContaining({
				url: "https://example.com/two",
				init: expect.objectContaining({ method: "GET" }),
			}),
		]);

		mockStealthState.queuedCloseErrors.push(new Error("close exploded"));
		session.close();
		await expect(session.fetch("/closed")).rejects.toMatchObject({
			message: "Stealth session is closed",
		});
		await Bun.sleep(0);
		expect(mockStealthState.clients[0]?.closed).toBe(true);
		expect(warnings).toEqual([
			"[provider-sdk] Failed to close stealth transport session: close exploded",
		]);
	});

	it("scopes redirect-hop cookies to the origin that set them", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 302,
				body: "",
				headers: {
					location: "https://host-b.example/landing",
					"set-cookie": "host_a=one; Path=/",
				},
				url: "https://host-a.example/start",
			},
			{
				status: 200,
				body: "landed",
				headers: { "set-cookie": "host_b=two; Path=/" },
				url: "https://host-b.example/landing",
			},
			{
				status: 200,
				body: "back",
				headers: {},
				url: "https://host-a.example/later",
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://host-a.example").createSession();

		await session.fetch("/start");
		await session.fetch("/later");

		expect(session.cookies.toHeader("https://host-a.example/account")).toBe("host_a=one");
		expect(session.cookies.toHeader("https://host-b.example/account")).toBe("host_b=two");
		expect(mockStealthState.clients[0]?.calls[1]?.init?.headers).not.toHaveProperty("Cookie");
		expect(mockStealthState.clients[0]?.calls[2]?.init?.headers).toMatchObject({
			Cookie: "host_a=one",
		});
		expect(mockStealthState.clients[0]?.calls[2]?.init?.headers).not.toMatchObject({
			Cookie: expect.stringContaining("host_b=two"),
		});
		expect(mockStealthState.clients[0]?.clearCookieCalls).toBe(3);
	});

	it("serializes concurrent fetches that share a native session", async () => {
		let markFirstStarted!: () => void;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		let releaseFirst!: () => void;
		const firstRelease = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		mockStealthState.queuedResponses.push(
			{
				status: 200,
				body: "first",
				headers: {},
				beforeReturn: async () => {
					markFirstStarted();
					await firstRelease;
				},
			},
			{ status: 200, body: "second", headers: {} },
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();
		const first = session.fetch("/first", { headers: { Cookie: "request=first" } });
		await firstStarted;
		const second = session.fetch("/second", { headers: { Cookie: "request=second" } });
		await Bun.sleep(0);
		const callsWhileFirstPending = mockStealthState.clients[0]?.calls.length;
		const clearsWhileFirstPending = mockStealthState.clients[0]?.clearCookieCalls;

		releaseFirst();
		await Promise.all([first, second]);

		expect(callsWhileFirstPending).toBe(1);
		expect(clearsWhileFirstPending).toBe(1);
		expect(mockStealthState.clients[0]?.calls).toEqual([
			expect.objectContaining({
				url: "https://example.com/first",
				init: expect.objectContaining({ headers: { Cookie: "request=first" } }),
			}),
			expect.objectContaining({
				url: "https://example.com/second",
				init: expect.objectContaining({ headers: { Cookie: "request=second" } }),
			}),
		]);
	});

	it("does not attach a host-only cookie to a request for another host", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 200,
				body: "first",
				headers: { "set-cookie": "sid=host-a; Path=/" },
				url: "https://a.example.com/first",
				sessionCookies: [
					{
						name: "sid",
						value: "host-a",
						domain: "a.example.com",
						path: "/",
						secure: true,
						httpOnly: false,
					},
				],
			},
			{
				status: 200,
				body: "second",
				headers: {},
				url: "https://b.a.example.com/second",
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://a.example.com").createSession();

		await session.fetch("/first");
		await session.fetch("https://b.a.example.com/second");

		expect(mockStealthState.clients[0]?.calls[1]?.init?.headers).not.toHaveProperty("Cookie");
	});

	it("uses request URLs when applying SDK cookies to wreq requests", async () => {
		mockStealthState.queuedResponses.push(
			{ status: 200, body: "host-a", headers: {} },
			{ status: 200, body: "host-b", headers: {} },
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();
		session.cookies.setFromCookieStrings(["bridge=host-a; Path=/"], "https://host-a.example/login");

		await session.fetch("https://host-a.example/next");
		await session.fetch("https://host-b.example/next");

		expect(mockStealthState.clients[0]?.calls[0]?.init?.headers).toMatchObject({
			Cookie: "bridge=host-a",
		});
		expect(mockStealthState.clients[0]?.calls[1]?.init?.headers).not.toHaveProperty("Cookie");
	});

	it("applies Domain suffix rules and rejects unrelated or public-suffix domains", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		const cookies = createStealthClient("https://example.com").createSession().cookies;

		cookies.setFromCookieStrings(
			[
				"shared=ok; Domain=.example.com; Path=/",
				"poison=bad; Domain=unrelated.test; Path=/",
				"public=bad; Domain=com; Path=/",
			],
			"https://example.com/login",
		);

		expect(cookies.toHeader("https://sub.example.com/account")).toBe("shared=ok");
		expect(cookies.toHeader("https://unrelated.test/")).toBe("");
		expect(cookies.toHeader("https://example.com/")).toBe("shared=ok");
	});

	it("does not send Secure cookies over HTTP", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		const cookies = createStealthClient("https://example.com").createSession().cookies;

		cookies.setFromCookieStrings(["secure_sid=secret; Secure; Path=/"], "https://example.com/");
		const state = cookies.serialize();
		cookies.clear();
		cookies.deserialize(state);

		expect(cookies.toHeader("https://example.com/")).toBe("secure_sid=secret");
		expect(cookies.toHeader("http://example.com/")).toBe("");
	});

	it("drops cookies expired by Expires or Max-Age", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		const cookies = createStealthClient("https://example.com").createSession().cookies;

		cookies.setFromCookieStrings(
			[
				"expires_past=gone; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/",
				"max_age_zero=gone; Max-Age=0; Path=/",
			],
			"https://example.com/",
		);
		const state = cookies.serialize();
		cookies.clear();
		cookies.deserialize(state);

		expect(cookies.toHeader("https://example.com/")).toBe("");
		expect(cookies.getAll("https://example.com/")).toEqual({});
	});

	it("respects Path scope", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		const cookies = createStealthClient("https://example.com").createSession().cookies;

		cookies.setFromCookieStrings(
			["root=yes; Path=/", "account=yes; Path=/account"],
			"https://example.com/login",
		);

		expect(cookies.toHeader("https://example.com/other")).toBe("root=yes");
		expect(cookies.toHeader("https://example.com/account/profile")).toBe("account=yes; root=yes");
	});

	it("emits only the most-specific matching cookie when names collide", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		const cookies = createStealthClient("https://example.com").createSession().cookies;

		cookies.setFromCookieStrings(
			["sid=root; Path=/", "sid=account; Path=/account"],
			"https://example.com/account/login",
		);

		const header = cookies.toHeader("https://example.com/account/profile");
		expect(header).toBe("sid=account");
		expect(header.match(/sid=/g)).toHaveLength(1);
	});

	it("round-trips a flat snapshot as sendable cookies on the session origin", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		const cookies = createStealthClient("https://example.com").createSession().cookies;
		cookies.setFromCookieStrings(["sid=abc; Path=/", "csrf=def; Path=/"]);
		expect(cookies.find?.((cookie) => cookie.startsWith("csrf="))).toBe("csrf=def");

		const snapshot = cookies.snapshot();
		cookies.clear();
		cookies.restore(snapshot);

		expect(snapshot).toEqual({ sid: "abc", csrf: "def" });
		expect(cookies.toHeader("https://example.com/next")).toBe("sid=abc; csrf=def");
	});

	it("includes cookies from every host in the backward-compatible flat snapshot", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		const cookies = createStealthClient("https://tabelog.com").createSession().cookies;

		cookies.setFromCookieStrings(["kaki=abc; Path=/"], "https://account.tabelog.com/login");
		cookies.setFromCookieStrings(["_tabelog_session_id=s1; Path=/"], "https://tabelog.com/");
		cookies.setFromCookieStrings(["yoyaku_tok=yy; Path=/"], "https://yoyaku.tabelog.com/");

		expect(cookies.snapshot()).toEqual({
			kaki: "abc",
			_tabelog_session_id: "s1",
			yoyaku_tok: "yy",
		});
	});

	it("round-trips JSON-safe cookie state without losing origin attributes", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		const cookies = createStealthClient("https://example.com").createSession().cookies;

		cookies.setFromCookieStrings(
			["shared=domain; Domain=.example.com; Path=/account; Secure"],
			"https://example.com/account/login",
		);
		cookies.setFromCookieStrings(
			["host_session=host-only; Path=/; Secure"],
			"https://account.example.com/login",
		);

		const state = JSON.parse(JSON.stringify(cookies.serialize())) as StealthCookieStoreV1;
		const shared = state.jar.cookies.find((cookie) => cookie.key === "shared");
		const hostOnly = state.jar.cookies.find((cookie) => cookie.key === "host_session");
		expect(state.version).toBe(1);
		expect(shared).toMatchObject({
			domain: "example.com",
			hostOnly: false,
			path: "/account",
			secure: true,
		});
		expect(hostOnly).toMatchObject({
			domain: "account.example.com",
			hostOnly: true,
			path: "/",
			secure: true,
		});

		cookies.clear();
		cookies.deserialize(state);

		expect(cookies.toHeader("https://sub.example.com/account/profile")).toBe("shared=domain");
		expect(cookies.toHeader("https://account.example.com/account/profile")).toBe(
			"shared=domain; host_session=host-only",
		);
		expect(cookies.toHeader("https://other.example.com/")).toBe("");
		expect(cookies.toHeader("https://sub.example.com/other")).toBe("");
	});

	it("rejects unsupported cookie-store versions with a typed error", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		const cookies = createStealthClient("https://example.com").createSession().cookies;
		const futureState = {
			version: 2,
			jar: cookies.serialize().jar,
		};

		// @ts-expect-error test-invalid: deserialization must reject unsupported store versions.
		expect(() => cookies.deserialize(futureState)).toThrow(StealthCookieStoreVersionError);
		// @ts-expect-error test-invalid: the message assertion repeats the malformed call deliberately.
		expect(() => cookies.deserialize(futureState)).toThrow(
			"Unsupported stealth cookie store version: 2",
		);
	});

	it("restores a legacy flat map without leaking beyond the session host", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		const cookies = createStealthClient("https://example.com").createSession().cookies;

		cookies.restore({ legacy_sid: "abc", legacy_csrf: "def" });

		expect(cookies.toHeader("https://example.com/next")).toBe("legacy_sid=abc; legacy_csrf=def");
		expect(cookies.toHeader("https://sub.example.com/next")).toBe("");
		expect(cookies.toHeader("https://unrelated.test/next")).toBe("");
	});

	it("rejects removed Chrome profile names before starting wreq", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");

		for (const profile of ["chrome-129", "chrome-130", "chrome-131"]) {
			const client = createStealthClient("https://example.com", profile);

			await expect(client.fetch("/profile")).rejects.toThrow(SDKError);
		}

		expect(mockStealthState.clients).toHaveLength(0);
	});

	it("warns through the stealth diagnostic channel for a registered version pin", async () => {
		const warnings: string[] = [];
		const { createStealthClient } = await import("../runtime/stealth.js");

		createStealthClient("https://example.com", "chrome-146", {
			warn: (message) => warnings.push(message),
		}).createSession();
		createStealthClient("https://example.com", "chrome-desktop", {
			warn: (message) => warnings.push(message),
		}).createSession();

		expect(warnings).toEqual([
			expect.stringContaining(
				'Stealth profile "chrome-146" pins a browser version and is deprecated',
			),
		]);
		expect(warnings[0]).toContain('Use the intent profile "chrome-desktop"');
		expect(warnings[0]).toContain('getStealthProfile("chrome-desktop").userAgent');
	});

	it("maps chrome-146 profile to a wreq browser profile and preserves headers", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", "chrome-146");
		const session = client.createSession();

		await session.fetch("/profile", {
			headers: { "User-Agent": "provider-ua" },
		});

		expect(mockStealthState.clients[0]?.options).toMatchObject({
			browser: "chrome_146",
			os: "macos",
		});
		expect(mockStealthState.clients[0]?.calls[0]?.init).toMatchObject({
			headers: { "User-Agent": "provider-ua" },
			method: "GET",
		});
	});

	it("createSession accepts a canonical profile override", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", "firefox-147");
		const session = client.createSession({ profile: "chrome-146" });

		await session.fetch("/profile");

		expect(mockStealthState.clients[0]?.options).toMatchObject({
			browser: "chrome_146",
			os: "macos",
		});
	});

	it("keeps Firefox profiles on Firefox impersonation instead of falling back to Chrome", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", "firefox-132");

		await client.fetch("/profile");

		expect(mockStealthState.clients[0]?.options).toMatchObject({
			browser: "firefox_133",
			os: "macos",
		});
	});

	it("keeps unknown profile names on the transport default for compatibility", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", "custom-profile");

		await client.fetch("/profile");

		expect(mockStealthState.clients[0]?.options).toMatchObject({
			browser: "chrome_149",
			os: "macos",
		});
	});

	it("maps unknown profile names through the derived default profile", async () => {
		const { resolveWreqProfile } = await import("../runtime/stealth.js");

		expect(resolveWreqProfile("custom-profile", ["chrome_145", "firefox_147"])).toEqual({
			browser: "chrome_145",
			os: "macos",
		});
	});

	it("maps Safari profiles to same-family wreq impersonation", async () => {
		mockStealthState.queuedResponses.push(
			{ status: 200, body: "desktop", headers: {} },
			{ status: 200, body: "ios", headers: {} },
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		await createStealthClient("https://example.com", "safari-17").fetch("/profile");
		await createStealthClient("https://example.com", "ios-safari-26").fetch("/profile");

		expect(mockStealthState.clients[0]?.options).toMatchObject({
			browser: "safari_17.0",
			os: "macos",
		});
		expect(mockStealthState.clients[1]?.options).toMatchObject({
			browser: "safari_ios_26",
			os: "ios",
		});
	});

	it("rejects low-level stealth fingerprint overrides that the transport owns internally", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		await expect(
			client.fetch("/profile", {
				headerOrder: ["host", "user-agent"],
				stealth: {
					// @ts-expect-error test-invalid: low-level fingerprint overrides must be rejected
					ja3: "771,4865-4866",
					h2: { HEADER_TABLE_SIZE: 65536 },
				},
			}),
		).rejects.toThrow(/no longer accepts low-level stealth overrides/);
		expect(mockStealthState.clients).toHaveLength(0);
	});

	it("preserves TRACE support while rejecting unsupported CONNECT-like tunnel methods", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		await client.fetch("/trace", { method: "TRACE" });
		expect(mockStealthState.clients[0]?.calls[0]?.init?.method).toBe("TRACE");

		// @ts-expect-error test-invalid: CONNECT is intentionally unsupported by stealth transport
		await expect(client.fetch("/tunnel", { method: "CONNECT" })).rejects.toThrow(
			/Unsupported stealth method: CONNECT/,
		);
		expect(mockStealthState.clients).toHaveLength(1);
	});

	it("redacts sensitiveParams from method and retry preflight failures", async () => {
		const methodSecret = "INVALID_STEALTH_METHOD";
		const retrySecret = "invalid_stealth_retry";
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		await expect(
			client.fetch("/method", {
				// @ts-expect-error test-invalid: runtime method validation must reject and redact a secret value.
				method: methodSecret,
				sensitiveParams: { token: methodSecret },
			}),
		).rejects.toMatchObject({ message: "Unsupported stealth method: [REDACTED]" });
		let retryError: unknown;
		try {
			await client.fetch("/retry", {
				// @ts-expect-error test-invalid: runtime retry validation must reject and redact a secret value.
				retry: retrySecret,
				sensitiveParams: { token: retrySecret },
			});
		} catch (error) {
			retryError = error;
		}
		expect(retryError).toBeInstanceOf(Error);
		assertIsError(retryError);
		expect(retryError.message).not.toContain(retrySecret);
		expect(JSON.stringify(retryError)).not.toContain(retrySecret);
		expect(mockStealthState.clients).toHaveLength(0);
	});

	it("passes request method, body, timeout, and headers through wreq fetch", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		await client.fetch("/post", {
			body: JSON.stringify({ ok: true }),
			headers: { accept: "text/plain" },
			method: "POST",
			timeout: 12_000,
		});

		const requestInit = mockStealthState.clients[0]?.calls[0]?.init;
		expect(requestInit).toMatchObject({
			body: '{"ok":true}',
			headers: { accept: "text/plain" },
			method: "POST",
		});
		expect(requestInit?.timeout).toBeGreaterThan(0);
		expect(requestInit?.timeout).toBeLessThanOrEqual(12_000);
	});

	it("passes manual redirect mode through wreq fetch", async () => {
		mockStealthState.queuedResponses.push({
			status: 302,
			body: "",
			headers: { location: "/next", "set-cookie": "hop=one; Path=/" },
			url: "https://example.com/start",
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		const response = await client.fetch("/start", {
			redirect: "manual",
			throwOnHttpError: false,
		});

		expect(mockStealthState.clients[0]?.calls[0]?.init).toMatchObject({
			method: "GET",
			redirect: "manual",
		});
		expect(response.headers.location).toBe("/next");
		expect(response.cookies.get("hop")).toBe("one");
	});

	it("bounds one timeout budget across the full redirect chain", async () => {
		const timeout = 110;
		const hopDelay = 40;
		const beforeReturn = async (init?: Record<string, unknown>) => {
			const hopTimeout = init?.timeout;
			if (typeof hopTimeout !== "number") throw new Error("missing hop timeout");
			await Bun.sleep(Math.min(hopDelay, hopTimeout));
			if (hopTimeout < hopDelay) {
				const timeoutError = new Error(`request timeout after ${hopTimeout}ms`);
				timeoutError.name = "TimeoutError";
				throw timeoutError;
			}
		};
		for (let hop = 0; hop < 7; hop += 1) {
			mockStealthState.queuedResponses.push({
				status: 302,
				body: "",
				headers: { location: `/hop-${hop + 1}` },
				url: hop === 0 ? "https://example.com/start" : `https://example.com/hop-${hop}`,
				beforeReturn,
			});
		}
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "too late",
			headers: {},
			url: "https://example.com/hop-7",
			beforeReturn,
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const startedAt = performance.now();
		let thrown: unknown;
		try {
			await createStealthClient("https://example.com").fetch("/start", { timeout });
		} catch (error) {
			thrown = error;
		}
		const elapsed = performance.now() - startedAt;

		expect(thrown).toMatchObject({
			code: "transport_timeout",
			status: 0,
			message: "Request timed out",
		});
		expect(elapsed).toBeLessThan(timeout + 100);
		const hopTimeouts = mockStealthState.clients[0]?.calls.map((call) => call.init?.timeout) ?? [];
		expect(hopTimeouts.length).toBeGreaterThan(1);
		expect(hopTimeouts.length).toBeLessThan(8);
		expect(hopTimeouts?.every((value) => typeof value === "number")).toBe(true);
		for (let index = 1; index < hopTimeouts.length; index += 1) {
			expect(hopTimeouts[index]).toBeLessThan(hopTimeouts[index - 1] as number);
		}
	});

	it("exposes session cookies accumulated across sequential requests", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 200,
				body: "first",
				headers: { "set-cookie": "sid=abc; Path=/" },
			},
			{
				status: 200,
				body: "second",
				headers: { "set-cookie": "csrf=def; Path=/" },
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();

		await session.fetch("/first");
		expect(session.cookies.has("sid")).toBe(true);
		expect(session.cookies.toHeader()).toBe("sid=abc");

		await session.fetch("/second");
		expect(session.cookies.getAll()).toEqual({ sid: "abc", csrf: "def" });

		const snapshot = session.cookies.snapshot();
		session.cookies.clear();
		expect(session.cookies.toString()).toBe("");
		session.cookies.restore(snapshot);
		expect(session.cookies.toString()).toBe("sid=abc; csrf=def");
	});

	it("redirects.run walks POST through 302 and 303 while accumulating cookies", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 302,
				body: "",
				headers: { location: "/step-two", "set-cookie": "a=1; Path=/" },
				url: "https://example.com/login",
			},
			{
				status: 303,
				body: "",
				headers: {
					location: "https://example.com/final",
					"set-cookie": "b=2; Path=/",
				},
				url: "https://example.com/step-two",
			},
			{
				status: 200,
				body: "done",
				headers: { "set-cookie": "c=3; Path=/" },
				url: "https://example.com/final",
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();

		const result = await session.redirects.run({
			url: "/login",
			method: "POST",
			body: "payload",
		});

		expect(result.reason).toBe("completed");
		expect(result.final.status).toBe(200);
		expect(result.hops).toEqual([
			{
				url: "https://example.com/login",
				status: 302,
				method: "POST",
				location: "/step-two",
				nextUrl: "https://example.com/step-two",
			},
			{
				url: "https://example.com/step-two",
				status: 303,
				method: "GET",
				location: "https://example.com/final",
				nextUrl: "https://example.com/final",
			},
		]);
		expect(result.cookies).toEqual({ a: "1", b: "2", c: "3" });
		expect(result.cookieStore.version).toBe(1);
		expect(result.cookieStore.jar.cookies.map((cookie) => cookie.key)).toEqual(["a", "b", "c"]);
		expect(mockStealthState.clients[0]?.calls).toEqual([
			expect.objectContaining({
				url: "https://example.com/login",
				init: expect.objectContaining({
					body: "payload",
					method: "POST",
					redirect: "manual",
				}),
			}),
			expect.objectContaining({
				url: "https://example.com/step-two",
				init: expect.objectContaining({
					method: "GET",
					redirect: "manual",
				}),
			}),
			expect.objectContaining({
				url: "https://example.com/final",
				init: expect.objectContaining({
					method: "GET",
					redirect: "manual",
				}),
			}),
		]);
		expect(mockStealthState.clients[0]?.calls[1]?.init).not.toHaveProperty("body");
	});

	it("enforces maxBodyBytes on every redirect hop", async () => {
		const hopStreamState = createMockBodyState();
		mockStealthState.queuedResponses.push(
			{
				status: 302,
				body: "oversized redirect body",
				headers: { location: "/final" },
				streamChunks: byteChunks("over", "sized", " redirect body"),
				streamState: hopStreamState,
				url: "https://example.com/start",
			},
			{
				status: 200,
				body: "ok",
				headers: {},
				streamChunks: byteChunks("ok"),
				url: "https://example.com/final",
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();

		await expect(session.redirects.run({ url: "/start", maxBodyBytes: 8 })).rejects.toMatchObject({
			code: "response_too_large",
			options: { category: "upstream_http", retryable: false },
		});
		expect(mockStealthState.clients[0]?.calls).toHaveLength(1);
		expect(mockStealthState.queuedResponses).toHaveLength(1);
		expect(hopStreamState.cancelled).toBe(true);
	});

	it("redirects.run returns cookies set by intermediate hops on different hosts", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 302,
				body: "",
				headers: {
					location: "https://yoyaku.tabelog.com/booking",
					"set-cookie": "kaki=abc; Path=/",
				},
				url: "https://account.tabelog.com/login",
			},
			{
				status: 302,
				body: "",
				headers: { location: "https://tabelog.com/done", "set-cookie": "yoyaku_tok=yy; Path=/" },
				url: "https://yoyaku.tabelog.com/booking",
			},
			{
				status: 200,
				body: "done",
				headers: { "set-cookie": "_tabelog_session_id=s1; Path=/" },
				url: "https://tabelog.com/done",
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://tabelog.com").createSession();

		const result = await session.redirects.run({ url: "https://account.tabelog.com/login" });

		expect(result.reason).toBe("completed");
		expect(result.cookies).toEqual({
			kaki: "abc",
			yoyaku_tok: "yy",
			_tabelog_session_id: "s1",
		});
		expect(result.cookieStore.jar.cookies).toHaveLength(3);
		expect(mockStealthState.clients[0]?.calls[1]?.init?.headers).not.toHaveProperty("Cookie");
		expect(mockStealthState.clients[0]?.calls[2]?.init?.headers).not.toHaveProperty("Cookie");
	});

	it("redirects.run preserves method and body for 307 redirects", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 307,
				body: "",
				headers: { location: "/retry" },
				url: "https://example.com/submit",
			},
			{
				status: 200,
				body: "done",
				headers: {},
				url: "https://example.com/retry",
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();

		await session.redirects.run({
			url: "/submit",
			method: "POST",
			body: "payload",
		});

		expect(mockStealthState.clients[0]?.calls[1]?.init).toMatchObject({
			body: "payload",
			method: "POST",
			redirect: "manual",
		});
	});

	it("redirects.run applies redirect method rewriting rules", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 301,
				body: "",
				headers: { location: "/moved" },
				url: "https://example.com/post-start",
			},
			{
				status: 200,
				body: "done",
				headers: {},
				url: "https://example.com/moved",
			},
			{
				status: 303,
				body: "",
				headers: { location: "/head-final" },
				url: "https://example.com/head-start",
			},
			{
				status: 200,
				body: "",
				headers: {},
				url: "https://example.com/head-final",
			},
			{
				status: 308,
				body: "",
				headers: { location: "/put-final" },
				url: "https://example.com/put-start",
			},
			{
				status: 200,
				body: "done",
				headers: {},
				url: "https://example.com/put-final",
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();

		await session.redirects.run({
			url: "/post-start",
			method: "POST",
			body: "payload",
		});
		await session.redirects.run({
			url: "/head-start",
			method: "HEAD",
		});
		await session.redirects.run({
			url: "/put-start",
			method: "PUT",
			body: "payload",
		});

		const calls = mockStealthState.clients[0]?.calls ?? [];
		expect(calls[1]?.init).toMatchObject({
			method: "GET",
			redirect: "manual",
		});
		expect(calls[1]?.init).not.toHaveProperty("body");
		expect(calls[3]?.init).toMatchObject({
			method: "HEAD",
			redirect: "manual",
		});
		expect(calls[5]?.init).toMatchObject({
			body: "payload",
			method: "PUT",
			redirect: "manual",
		});
	});

	it("redirects.run stops on missing Location and maxHops", async () => {
		mockStealthState.queuedResponses.push({
			status: 302,
			body: "",
			headers: {},
			url: "https://example.com/no-location",
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();

		const missingLocation = await session.redirects.run({
			url: "/no-location",
		});

		expect(missingLocation.reason).toBe("missing_location");
		expect(missingLocation.hops).toHaveLength(1);

		mockStealthState.queuedResponses.push({
			status: 302,
			body: "",
			headers: { location: "/loop" },
			url: "https://example.com/loop",
		});

		const maxHops = await session.redirects.run({
			url: "/loop",
			maxHops: 0,
		});

		expect(maxHops.reason).toBe("max_hops");
		expect(maxHops.hops).toHaveLength(1);
		expect(mockStealthState.clients[0]?.calls).toHaveLength(2);

		mockStealthState.queuedResponses.push(
			{
				status: 302,
				body: "",
				headers: { location: "/second-limit" },
				url: "https://example.com/first-limit",
			},
			{
				status: 302,
				body: "",
				headers: { location: "/third-limit" },
				url: "https://example.com/second-limit",
			},
		);

		const oneFollow = await session.redirects.run({
			url: "/first-limit",
			maxHops: 1,
		});

		expect(oneFollow.reason).toBe("max_hops");
		expect(oneFollow.hops).toHaveLength(2);
		expect(mockStealthState.clients[0]?.calls).toHaveLength(4);

		mockStealthState.queuedResponses.push({
			status: 302,
			body: "",
			headers: { location: "/self" },
			url: "https://example.com/self",
		});

		const loop = await session.redirects.run({
			url: "/self",
		});

		expect(loop.reason).toBe("loop");
		expect(loop.hops).toHaveLength(1);
		expect(mockStealthState.clients[0]?.calls).toHaveLength(5);
	});

	it("redirects.run gives stopWhen the next URL before following", async () => {
		mockStealthState.queuedResponses.push({
			status: 302,
			body: "",
			headers: { location: "/review" },
			url: "https://example.com/start",
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();
		const seen: unknown[] = [];

		const stopped = await session.redirects.run({
			url: "/start",
			stopWhen: (hop) => {
				seen.push(hop);
				return hop.nextUrl === "https://example.com/review";
			},
		});

		expect(stopped.reason).toBe("stopped");
		expect(seen).toEqual([
			{
				url: "https://example.com/start",
				status: 302,
				method: "GET",
				location: "/review",
				nextUrl: "https://example.com/review",
			},
		]);
		expect(mockStealthState.clients[0]?.calls).toHaveLength(1);
	});

	it("redirects.run applies params only to the initial request", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 302,
				body: "",
				headers: { location: "/callback?code=123" },
				url: "https://example.com/login?client_id=abc",
			},
			{
				status: 200,
				body: "done",
				headers: {},
				url: "https://example.com/callback?code=123",
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();

		await session.redirects.run({
			url: "/login",
			params: { client_id: "abc" },
		});

		expect(mockStealthState.clients[0]?.calls[0]?.url).toBe(
			"https://example.com/login?client_id=abc",
		);
		expect(mockStealthState.clients[0]?.calls[1]?.url).toBe(
			"https://example.com/callback?code=123",
		);
	});

	it("preserves params-only fragment redirects when the transport omits response.url", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 302,
				body: "",
				headers: { location: "#continue" },
				omitUrl: true,
			},
			{
				status: 200,
				body: "done",
				headers: {},
				url: "https://example.com/login#continue",
			},
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();

		const result = await session.redirects.run({
			url: "/login",
			params: { client_id: "abc" },
		});

		expect(mockStealthState.clients[0]?.calls.map((call) => call.url)).toEqual([
			"https://example.com/login?client_id=abc",
			"https://example.com/login#continue",
		]);
		expect(result.hops[0]?.url).toBe("https://example.com/login");
		expect(result.hops[0]?.nextUrl).toBe("https://example.com/login#continue");
	});

	it("keeps params-only redirect loop detection on the caller URL", async () => {
		mockStealthState.queuedResponses.push({
			status: 302,
			body: "",
			headers: { location: "/login" },
			url: "https://example.com/login?client_id=abc",
		});
		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();

		const result = await session.redirects.run({
			url: "/login",
			params: { client_id: "abc" },
		});

		expect(result.reason).toBe("loop");
		expect(mockStealthState.clients[0]?.calls).toHaveLength(1);
	});

	it("treats empty sensitiveParams as absent for redirect loop detection", async () => {
		mockStealthState.queuedResponses.push({
			status: 307,
			body: "",
			headers: { location: "/charge" },
			url: "https://example.com/charge?attempt=1",
		});
		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();

		const result = await session.redirects.run({
			url: "/charge",
			method: "POST",
			body: "payment",
			params: { attempt: 1 },
			sensitiveParams: {},
		});

		expect(result.reason).toBe("loop");
		expect(mockStealthState.clients[0]?.calls).toHaveLength(1);
	});

	it("redirects.run applies sensitiveParams only to the initial request", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 302,
				body: "",
				headers: { location: "/callback" },
				url: "https://example.com/login?serviceKey=redirect-test-secret",
			},
			{
				status: 200,
				body: "done",
				headers: {},
				url: "https://example.com/callback",
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();
		await session.redirects.run({
			url: "/login",
			sensitiveParams: { serviceKey: "redirect-test-secret" },
		});

		expect(mockStealthState.clients[0]?.calls[0]?.url).toBe(
			"https://example.com/login?serviceKey=redirect-test-secret",
		);
		expect(mockStealthState.clients[0]?.calls[1]?.url).toBe("https://example.com/callback");
	});

	it("redirects.run resolves fragment redirects with the real URL and redacts hop metadata", async () => {
		const secret = "redirect-fragment-secret";
		mockStealthState.queuedResponses.push(
			{
				status: 302,
				body: "",
				headers: { location: "#continue" },
				url: `https://example.com/login?serviceKey=${secret}`,
			},
			{
				status: 200,
				body: "done",
				headers: {},
				url: `https://example.com/login?serviceKey=${secret}#continue`,
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();
		const result = await session.redirects.run({
			url: "/login",
			sensitiveParams: { serviceKey: secret },
		});

		expect(mockStealthState.clients[0]?.calls.map((call) => call.url)).toEqual([
			`https://example.com/login?serviceKey=${secret}`,
			`https://example.com/login?serviceKey=${secret}#continue`,
		]);
		expect(result.hops).toEqual([
			{
				url: "https://example.com/login?serviceKey=[REDACTED]",
				status: 302,
				method: "GET",
				location: "#continue",
				nextUrl: "https://example.com/login?serviceKey=[REDACTED]#continue",
			},
		]);
		// The final response remains programmatic response data, not diagnostic metadata.
		expect(result.final.url).toBe(`https://example.com/login?serviceKey=${secret}#continue`);
	});

	it("redirects.run redacts credential-bearing relative Location diagnostics", async () => {
		const secret = "redirect-location-secret";
		mockStealthState.queuedResponses.push({
			status: 302,
			body: "",
			headers: { location: `../next?serviceKey=${secret}` },
			url: `https://example.com/auth/login?serviceKey=${secret}`,
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();
		const result = await session.redirects.run({
			url: "/auth/login",
			maxHops: 0,
			sensitiveParams: { serviceKey: secret },
		});

		expect(result.reason).toBe("max_hops");
		expect(result.hops[0]).toEqual({
			url: "https://example.com/auth/login?serviceKey=[REDACTED]",
			status: 302,
			method: "GET",
			location: "../next?serviceKey=[REDACTED]",
			nextUrl: "https://example.com/next?serviceKey=[REDACTED]",
		});
		expect(JSON.stringify(result.hops)).not.toContain(secret);
	});

	it("redirects.run structurally redacts one-character credentials in every hop URL", async () => {
		mockStealthState.queuedResponses.push({
			status: 302,
			body: "",
			headers: { location: "/next?pin=1" },
			url: "https://example.com/login?pin=1",
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();
		const result = await session.redirects.run({
			url: "/login",
			maxHops: 0,
			sensitiveParams: { pin: "1" },
		});

		expect(result.hops).toEqual([
			{
				url: "https://example.com/login?pin=[REDACTED]",
				status: 302,
				method: "GET",
				location: "/next?pin=[REDACTED]",
				nextUrl: "https://example.com/next?pin=[REDACTED]",
			},
		]);
		expect(JSON.stringify(result.hops)).not.toContain("pin=1");
	});

	it("redacts rotated sensitive-key values while stopWhen receives the real hop", async () => {
		const rotatedSecret = "rotated-secret";
		const responseCodeSecret = "response-only-code-secret";
		mockStealthState.queuedResponses.push({
			status: 302,
			body: "",
			headers: {
				location: `/next?serviceKey=${rotatedSecret}&code=${responseCodeSecret}`,
			},
			url: "https://example.com/login?serviceKey=initial-secret",
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();
		let callbackHop: StealthRedirectHop | undefined;
		const result = await session.redirects.run({
			url: "/login",
			sensitiveParams: { serviceKey: "initial-secret" },
			stopWhen: (hop) => {
				callbackHop = hop;
				return (
					hop.nextUrl?.includes(rotatedSecret) === true && hop.nextUrl.includes(responseCodeSecret)
				);
			},
		});

		expect(result.reason).toBe("stopped");
		expect(callbackHop?.nextUrl).toContain(rotatedSecret);
		expect(callbackHop?.nextUrl).toContain(responseCodeSecret);
		expect(JSON.stringify(result.hops)).not.toContain("initial-secret");
		expect(JSON.stringify(result.hops)).not.toContain(rotatedSecret);
		expect(JSON.stringify(result.hops)).not.toContain(responseCodeSecret);
		expect(result.hops[0]?.location).toBe("/next?serviceKey=[REDACTED]&code=[REDACTED]");
		expect(result.hops[0]?.nextUrl).toBe(
			"https://example.com/next?serviceKey=[REDACTED]&code=[REDACTED]",
		);
	});

	it("redirects.run redacts malformed credential-bearing Locations in URL errors", async () => {
		const secret = "redirect-malformed-secret";
		mockStealthState.queuedResponses.push({
			status: 302,
			body: "",
			headers: { location: `https://[bad]/?serviceKey=${secret}` },
			url: `https://example.com/login?serviceKey=${secret}`,
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();
		let thrown: unknown;
		try {
			await session.redirects.run({
				url: "/login",
				sensitiveParams: { serviceKey: secret },
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect(String(thrown)).not.toContain(secret);
		assertIsError(thrown);
		expect(thrown.stack).not.toContain(secret);
		expect(String(thrown)).toContain("[REDACTED]");
	});

	it("redirects.run redacts malformed initial URLs before resolution", async () => {
		const secret = "initial-url-secret";
		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();
		let thrown: unknown;
		try {
			await session.redirects.run({
				url: `https://[bad]/?serviceKey=${secret}`,
				sensitiveParams: { serviceKey: "replacement-secret" },
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		const serialized = JSON.stringify(thrown);
		expect(String(thrown)).not.toContain(secret);
		assertIsError(thrown);
		expect(thrown.stack).not.toContain(secret);
		expect(serialized).not.toContain(secret);
		expect(String(thrown)).toContain("[REDACTED]");
	});

	it("redacts raw hop URLs from ProviderError classification fields in stopWhen", async () => {
		const secret = "stop-callback-secret";
		mockStealthState.queuedResponses.push({
			status: 302,
			body: "",
			headers: { location: `/next?serviceKey=${secret}` },
			url: `https://example.com/login?serviceKey=${secret}`,
		});
		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();
		let thrown: unknown;
		try {
			await session.redirects.run({
				url: "/login",
				sensitiveParams: { serviceKey: secret },
				stopWhen: (hop) => {
					throw new ProviderError(`Unexpected redirect to ${hop.nextUrl}`, {
						code: hop.nextUrl,
						// @ts-expect-error test-invalid: preserves a legacy category value for redaction coverage
						category: "upstream",
						retryable: false,
					});
				},
			});
		} catch (error) {
			thrown = error;
		}

		expect(String(thrown)).toContain("serviceKey=[REDACTED]");
		expect(String(thrown)).not.toContain(secret);
		assertIsError(thrown);
		expect(thrown.stack).not.toContain(secret);
		expect(thrown).toBeInstanceOf(ProviderError);
		expect((thrown as ProviderError).code).toBe("https://example.com/next?serviceKey=[REDACTED]");
		expect((thrown as ProviderError).options).toMatchObject({
			category: "upstream",
			retryable: false,
		});
	});

	it("wraps network failures in TransportError", async () => {
		mockStealthState.queuedErrors.push(new Error("socket hang up"));

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		await expect(client.fetch("/network")).rejects.toBeInstanceOf(TransportError);
		mockStealthState.queuedErrors.push(new Error("socket hang up"));
		await expect(client.fetch("/network")).rejects.toMatchObject({
			code: "transport_network_error",
			status: 0,
			message: "Network error",
		});
	});

	it("redacts sensitive request URLs from stealth transport errors and their metadata", async () => {
		const secret = "stealth-network-secret";
		const requestUrl = `https://example.com/network?serviceKey=${secret}`;
		const failure = new Error(`connect failed for ${requestUrl}`);
		Object.assign(failure, {
			url: requestUrl,
			request: { url: requestUrl },
			details: { endpoint: requestUrl },
		});
		mockStealthState.queuedErrors.push(failure);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");
		let thrown: unknown;
		try {
			await client.fetch("/network", {
				sensitiveParams: { serviceKey: secret },
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(TransportError);
		const transportError = thrown as TransportError;
		expect(transportError.message).toBe("Network error");
		expect(String(transportError.cause)).not.toContain(secret);
		assertIsError(transportError.cause);
		expect(transportError.cause.stack).not.toContain(secret);
		expect(JSON.stringify(transportError.cause)).not.toContain(secret);
	});

	it("collects declared-key values from malformed caller URLs before serialization", async () => {
		const oldSecret = "caller-url-secret";
		const newSecret = "replacement-secret";
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");
		let thrown: unknown;
		try {
			await client.fetch(`http://[bad]/?serviceKey=${oldSecret}`, {
				sensitiveParams: { serviceKey: newSecret },
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(TransportError);
		const serialized = JSON.stringify(thrown);
		expect(String(thrown)).not.toContain(oldSecret);
		assertIsError(thrown);
		expect(thrown.stack).not.toContain(oldSecret);
		expect(serialized).not.toContain(oldSecret);
		expect(String((thrown as TransportError).cause)).not.toContain(oldSecret);
	});

	it("redacts readonly timeout errors without losing timeout classification", async () => {
		const secret = "stealth-timeout-secret";
		mockStealthState.queuedErrors.push(
			new DOMException(
				`request timeout for https://example.com/slow?serviceKey=${secret}`,
				"TimeoutError",
			),
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");
		let thrown: unknown;
		try {
			await client.fetch("/slow", {
				timeout: 10,
				sensitiveParams: { serviceKey: secret },
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(TransportError);
		expect(thrown).toMatchObject({
			code: "transport_timeout",
			status: 0,
			message: "Request timed out",
		});
		const transportError = thrown as TransportError;
		expect(String(transportError.cause)).not.toContain(secret);
		assertIsError(transportError.cause);
		expect(transportError.cause.stack).not.toContain(secret);
	});

	it("redacts against the serialized request snapshot when options mutate in flight", async () => {
		const sentSecret = "stealth-snapshot-sent-secret";
		const laterSecret = "stealth-snapshot-later-secret";
		const sensitiveParams = { serviceKey: sentSecret };
		mockStealthState.queuedErrors.push(() => {
			sensitiveParams.serviceKey = laterSecret;
			return new Error(`connect failed for https://example.com/network?serviceKey=${sentSecret}`);
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");
		let thrown: unknown;
		try {
			await client.fetch("/network", { sensitiveParams });
		} catch (error) {
			thrown = error;
		}

		expect(mockStealthState.clients[0]?.calls[0]?.url).toBe(
			`https://example.com/network?serviceKey=${sentSecret}`,
		);
		const transportError = thrown as TransportError;
		expect(String(transportError.cause)).not.toContain(sentSecret);
		assertIsError(transportError.cause);
		expect(transportError.cause.stack).not.toContain(sentSecret);
	});

	it("maps wreq timeout failures to transport_timeout", async () => {
		const timeoutError = new Error("request timeout after 10ms");
		timeoutError.name = "TimeoutError";
		mockStealthState.queuedErrors.push(timeoutError);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		await expect(client.fetch("/slow", { timeout: 10 })).rejects.toMatchObject({
			code: "transport_timeout",
			status: 0,
			message: "Request timed out",
		});
	});

	it("defaults proxy-routed GET network failures to transient transport retry", async () => {
		mockStealthState.queuedErrors.push(new Error("socket hang up"));
		mockStealthState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		const response = await client.fetch("/health", {
			proxy: "http://proxy.test",
		});

		expect(response.status).toBe(200);
		expect(mockStealthState.clients[0]?.calls).toHaveLength(2);
		expect(mockStealthState.clients[0]?.options?.proxy).toBe("http://proxy.test");
	});

	it("keeps proxy_connect_failed retryable when a sensitive value matches its prefix", async () => {
		mockStealthState.queuedErrors.push(new Error("proxy CONNECT failed"));
		mockStealthState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		const response = await client.fetch("/health", {
			proxy: "http://proxy.test",
			sensitiveParams: { token: "proxy" },
		});

		expect(response.status).toBe(200);
		expect(mockStealthState.clients[0]?.calls).toHaveLength(2);
	});

	it("defaults proxy-routed GET timeout failures to transient transport retry", async () => {
		const timeoutError = new Error("request timeout after 10ms");
		timeoutError.name = "TimeoutError";
		mockStealthState.queuedErrors.push(timeoutError);
		mockStealthState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		const response = await client.fetch("/slow", {
			proxy: "http://proxy.test",
			timeout: 10,
		});

		expect(response.status).toBe(200);
		expect(mockStealthState.clients[0]?.calls).toHaveLength(2);
		expect(mockStealthState.clients[0]?.options?.proxy).toBe("http://proxy.test");
	});

	it("does not default-retry when no stealth proxy was resolved", async () => {
		mockStealthState.queuedErrors.push(new Error("socket hang up"));
		mockStealthState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		await expect(client.fetch("/health")).rejects.toMatchObject({
			code: "transport_network_error",
		});
		expect(mockStealthState.clients[0]?.calls).toHaveLength(1);
		expect(mockStealthState.clients[0]?.options?.proxy).toBeUndefined();
	});

	it("does not default-retry proxy-routed GET when retry is false", async () => {
		mockStealthState.queuedErrors.push(new Error("socket hang up"));
		mockStealthState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		await expect(
			client.fetch("/health", { proxy: "http://proxy.test", retry: false }),
		).rejects.toMatchObject({
			code: "transport_network_error",
		});
		expect(mockStealthState.clients[0]?.calls).toHaveLength(1);
	});

	it("honors explicit unsafe POST retry when acknowledged", async () => {
		mockStealthState.queuedErrors.push(new Error("socket hang up"));
		mockStealthState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		const response = await client.fetch("/health", {
			method: "POST",
			body: "{}",
			proxy: "http://proxy.test",
			retry: {
				methods: ["POST"],
				attempts: 2,
				errorCodes: ["transport_network_error"],
				unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.AllowExplicitUnsafe,
			},
		});

		expect(response.status).toBe(200);
		expect(mockStealthState.clients[0]?.calls).toHaveLength(2);
		expect(mockStealthState.clients[0]?.calls[0]?.init?.method).toBe("POST");
		expect(mockStealthState.clients[0]?.calls[1]?.init?.method).toBe("POST");
	});
});

const CancellationErrorShapeSchema = z.object({
	code: z.string(),
	instanceOfTransportError: z.boolean(),
	name: z.string(),
	retryable: z.boolean(),
	status: z.number(),
});

type CancellationErrorShape = z.infer<typeof CancellationErrorShapeSchema>;

function cancellationErrorShape(error: unknown): CancellationErrorShape {
	if (!(error instanceof TransportError)) {
		return {
			code: "not_cancelled",
			instanceOfTransportError: false,
			name: error instanceof Error ? error.name : typeof error,
			retryable: true,
			status: -1,
		};
	}
	return {
		code: error.code ?? "missing_code",
		instanceOfTransportError: true,
		name: error.name,
		retryable: error.options?.retryable ?? true,
		status: error.status ?? -1,
	};
}

function createStealthAbortProvider(): ProviderDefinition {
	return createProviderDefinitionDouble({
		id: "stealth-abort-provider",
		allowedHosts: ["example.com"],
		stealth: { profile: "chrome-desktop", platform: "macos" },
		auth: {
			mode: "credentials",
			flow: {
				start: async (ctx) => {
					try {
						await ctx.stealth.fetch("/auth-slow");
						return {
							kind: "complete",
							turnId: "not-cancelled",
							data: cancellationErrorShape(undefined),
						};
					} catch (error) {
						return {
							kind: "abort",
							turnId: "cancelled",
							data: cancellationErrorShape(error),
						};
					}
				},
				continue: async () => ({ kind: "abort", turnId: "unused" }),
			},
		},
		operations: {
			cancelStealth: {
				riskClass: "read",
				input: z.object({}),
				output: CancellationErrorShapeSchema,
				upstream: { baseUrl: "https://example.com" },
				handler: async (ctx) => {
					try {
						await ctx.stealth.fetch("/operation-slow");
						return cancellationErrorShape(undefined);
					} catch (error) {
						return cancellationErrorShape(error);
					}
				},
			},
		},
	});
}

async function startGatewayRequestAndAbort(
	request: (signal: AbortSignal) => Response | Promise<Response>,
): Promise<Response> {
	const controller = new AbortController();
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	mockStealthState.queuedResponses.push({
		status: 200,
		body: "not cancelled",
		headers: {},
		beforeReturn: async (init) => {
			const signal = init?.signal;
			if (!(signal instanceof AbortSignal)) return;
			markStarted();
			await new Promise<void>((_resolve, reject) => {
				const onAbort = () => reject(new DOMException("native request aborted", "AbortError"));
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			});
		},
	});
	const response = Promise.resolve(request(controller.signal));
	await Promise.race([started, Bun.sleep(100)]);
	controller.abort(new Error("gateway request abandoned"));
	return response;
}

describe("gateway stealth abort wiring", () => {
	beforeEach(() => {
		mockStealthState.clients.length = 0;
		mockStealthState.queuedResponses.length = 0;
		mockStealthState.queuedErrors.length = 0;
		mockStealthState.queuedCloseErrors.length = 0;
	});

	it("propagates the operation request signal into ctx.stealth cancellation", async () => {
		const { createServerAppAsync } = await import("../server/serve.js");
		const app = await createServerAppAsync(createStealthAbortProvider());
		const response = await startGatewayRequestAndAbort((signal) =>
			app.request("/v1/cancelStealth", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "req-operation-abort", input: {} }),
				signal,
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				code: "transport_cancelled",
				instanceOfTransportError: true,
				name: "TransportError",
				retryable: false,
				status: 0,
			},
		});
		expect(mockStealthState.clients[0]?.calls).toHaveLength(1);
		const recordedSignal = mockStealthState.clients[0]?.calls[0]?.init?.signal;
		expect(recordedSignal).toBeInstanceOf(AbortSignal);
		if (!(recordedSignal instanceof AbortSignal)) throw new Error("Expected recorded abort signal");
		expect(recordedSignal.aborted).toBe(true);
	});

	it("propagates the auth-flow request signal into ctx.stealth cancellation", async () => {
		const { createServerAppAsync } = await import("../server/serve.js");
		const app = await createServerAppAsync(createStealthAbortProvider());
		const response = await startGatewayRequestAndAbort((signal) =>
			app.request("/auth/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req-auth-abort",
					flowId: "flow-abort",
					providerId: "stealth-abort-provider",
					context: {},
				}),
				signal,
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				kind: "abort",
				turnId: "cancelled",
				data: {
					code: "transport_cancelled",
					instanceOfTransportError: true,
					name: "TransportError",
					retryable: false,
					status: 0,
				},
			},
		});
		expect(mockStealthState.clients[0]?.calls).toHaveLength(1);
		const recordedSignal = mockStealthState.clients[0]?.calls[0]?.init?.signal;
		expect(recordedSignal).toBeInstanceOf(AbortSignal);
		if (!(recordedSignal instanceof AbortSignal)) throw new Error("Expected recorded abort signal");
		expect(recordedSignal.aborted).toBe(true);
	});
});
