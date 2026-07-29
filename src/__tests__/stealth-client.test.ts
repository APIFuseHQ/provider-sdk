import { beforeEach, describe, expect, it, mock } from "bun:test";

import { SDKError, StealthCookieStoreVersionError, TransportError } from "../errors.js";
import { normalizeResponse } from "../runtime/stealth.js";
import {
	type DeclarativeStealthResponse,
	HttpRetryUnsafeMethodPolicy,
	type StealthCookieStoreV1,
} from "../types.js";

type MockImpitResponse = {
	status: number;
	body: string;
	headers?: Record<string, string | string[]>;
	arrayBufferBody?: Uint8Array;
	streamChunks?: Uint8Array[];
	streamState?: MockBodyState;
	url?: string;
	redirected?: boolean;
};

type MockBodyState = {
	arrayBufferCalls: number;
	pulledChunks: number;
	cancelled: boolean;
	aborted: boolean;
};

type MockImpitCall = {
	url: string;
	init?: Record<string, unknown>;
};

type MockStealthClientState = {
	calls: MockImpitCall[];
	options: Record<string, unknown> | undefined;
};

const mockStealthState = {
	clients: [] as MockStealthClientState[],
	queuedResponses: [] as MockImpitResponse[],
	queuedErrors: [] as Error[],
};

function toHeaders(headers: MockImpitResponse["headers"]): Headers {
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
		aborted: false,
	};
}

function byteChunks(...chunks: string[]): Uint8Array[] {
	return chunks.map((chunk) => new TextEncoder().encode(chunk));
}

function toImpitResponse(response: MockImpitResponse) {
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
		url: response.url ?? "https://example.com/final",
		redirected: response.redirected,
		json: async () => JSON.parse(response.body),
		text: async () => response.body,
		arrayBuffer: async () => {
			streamState.arrayBufferCalls += 1;
			return toArrayBuffer(responseBytes);
		},
		get body() {
			stream ??= new ReadableStream<Uint8Array>({
				pull(controller) {
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
		abort() {
			streamState.aborted = true;
		},
	};
}

class MockImpit {
	private readonly state: MockStealthClientState;

	constructor(options?: Record<string, unknown>) {
		this.state = { calls: [], options };
		mockStealthState.clients.push(this.state);
	}

	async fetch(url: string, init?: Record<string, unknown>) {
		this.state.calls.push({ url, init });
		const error = mockStealthState.queuedErrors.shift();
		if (error) throw error;
		const response = mockStealthState.queuedResponses.shift();
		if (!response) throw new Error("No queued response");
		return toImpitResponse(response);
	}
}

mock.module("impit", () => ({
	Impit: MockImpit,
}));

describe("createStealthClient", () => {
	beforeEach(() => {
		mockStealthState.clients.length = 0;
		mockStealthState.queuedResponses.length = 0;
		mockStealthState.queuedErrors.length = 0;
	});

	it("returns fetch and createSession functions", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");

		const client = createStealthClient("https://example.com");

		expect(client.fetch).toBeFunction();
		expect(client.createSession).toBeFunction();
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

	it("keeps the uncapped response path on impit arrayBuffer", async () => {
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
			aborted: false,
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

	it("aborts a chunked response as soon as its streamed body exceeds maxBodyBytes", async () => {
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
		expect(streamState.aborted).toBe(true);
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
		expect(streamState.aborted).toBe(true);
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
			text: async () => "text-first-corruption",
			arrayBuffer: async () => toArrayBuffer(new TextEncoder().encode('{"error":true}')),
		} as never)) as DeclarativeStealthResponse;

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
			text: async () => "text-first-corruption",
			arrayBuffer: async () => toArrayBuffer(new TextEncoder().encode("ok")),
		} as never)) as DeclarativeStealthResponse;

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

	it("sends sensitiveParams while redacting returned request URL metadata", async () => {
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
		expect(response.url).toBe("https://example.com/items?page=1&confmKey=[REDACTED]");
	});

	it("createSession reuses the same impit client for matching browser/proxy settings", async () => {
		mockStealthState.queuedResponses.push(
			{ status: 200, body: "first", headers: { a: "1" } },
			{ status: 200, body: "second", headers: { a: "2" } },
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");
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

		session.close();
		await expect(session.fetch("/closed")).rejects.toMatchObject({
			message: "Stealth session is closed",
		});
	});

	it("passes the session cookie jar to impit for redirect and sequential cookies", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 200,
				body: "first",
				headers: { "set-cookie": "sid=abc; Path=/" },
			},
			{ status: 200, body: "second", headers: {} },
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");
		const session = client.createSession();

		await session.fetch("/first");
		const impitCookieJar = mockStealthState.clients[0]?.options?.cookieJar as {
			setCookie(cookie: string, url: string): void | Promise<void>;
			getCookieString(url: string): string | Promise<string>;
		};

		expect(impitCookieJar).toBeDefined();
		expect(await impitCookieJar.getCookieString("https://example.com/next")).toBe("sid=abc");
		await impitCookieJar.setCookie("redirect_sid=xyz; Path=/", "https://example.com/redirect");

		await session.fetch("/second");

		expect(mockStealthState.clients[0]?.calls[1]?.init?.headers).toMatchObject({
			Cookie: "sid=abc; redirect_sid=xyz",
		});
	});

	it("does not attach a host-only cookie to a request for another host", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 200,
				body: "first",
				headers: { "set-cookie": "sid=host-a; Path=/" },
				url: "https://host-a.example/first",
			},
			{
				status: 200,
				body: "second",
				headers: {},
				url: "https://host-b.example/second",
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://host-a.example").createSession();

		await session.fetch("/first");
		await session.fetch("https://host-b.example/second");

		expect(mockStealthState.clients[0]?.calls[1]?.init?.headers).not.toHaveProperty("Cookie");
	});

	it("passes request URLs through the impit cookie bridge on set and get", async () => {
		mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });

		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com").createSession();
		await session.fetch("/");
		const impitCookieJar = mockStealthState.clients[0]?.options?.cookieJar as {
			setCookie(cookie: string, url: string): void | Promise<void>;
			getCookieString(url: string): string | Promise<string>;
		};

		await impitCookieJar.setCookie("bridge=host-a; Path=/", "https://host-a.example/login");

		expect(await impitCookieJar.getCookieString("https://host-a.example/next")).toBe(
			"bridge=host-a",
		);
		expect(await impitCookieJar.getCookieString("https://host-b.example/next")).toBe("");
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
		} as unknown as StealthCookieStoreV1;

		expect(() => cookies.deserialize(futureState)).toThrow(StealthCookieStoreVersionError);
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

	it("rejects removed Chrome profile names before starting impit", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");

		for (const profile of ["chrome-129", "chrome-130", "chrome-131"]) {
			const client = createStealthClient("https://example.com", profile);

			await expect(client.fetch("/profile")).rejects.toThrow(SDKError);
		}

		expect(mockStealthState.clients).toHaveLength(0);
	});

	it("maps chrome-146 profile to an impit browser profile and preserves headers", async () => {
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
			browser: "chrome142",
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
			browser: "chrome142",
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
			browser: "firefox133",
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
			browser: "chrome142",
		});
	});

	it("rejects Safari-only stealth profiles instead of silently impersonating Chrome", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", "ios-safari-26");

		await expect(client.fetch("/profile")).rejects.toThrow(/Safari stealth fingerprint/);
		expect(mockStealthState.clients).toHaveLength(0);
	});

	it("rejects low-level stealth fingerprint overrides that impit owns internally", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		await expect(
			client.fetch("/profile", {
				headerOrder: ["host", "user-agent"],
				stealth: {
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
		expect(mockStealthState.clients[0]?.calls[0]?.init.method).toBe("TRACE");

		await expect(client.fetch("/tunnel", { method: "CONNECT" as never })).rejects.toThrow(
			/Unsupported stealth method: CONNECT/,
		);
		expect(mockStealthState.clients).toHaveLength(1);
	});

	it("passes request method, body, timeout, and headers through impit fetch", async () => {
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

		expect(mockStealthState.clients[0]?.calls[0]?.init).toMatchObject({
			body: '{"ok":true}',
			headers: { accept: "text/plain" },
			method: "POST",
			timeout: 12_000,
		});
	});

	it("passes manual redirect mode through impit fetch", async () => {
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

	it("maps impit timeout failures to transport_timeout", async () => {
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
		expect(mockStealthState.clients[0]?.options?.proxyUrl).toBe("http://proxy.test");
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
		expect(mockStealthState.clients[0]?.options?.proxyUrl).toBe("http://proxy.test");
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
		expect(mockStealthState.clients[0]?.options?.proxyUrl).toBeUndefined();
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
