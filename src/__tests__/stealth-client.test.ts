import { beforeEach, describe, expect, it, mock } from "bun:test";

import { SDKError, TransportError } from "../errors";
import { normalizeResponse } from "../runtime/stealth";
import type { DeclarativeStealthResponse } from "../types";

type MockImpitResponse = {
	status: number;
	body: string;
	headers?: Record<string, string | string[]>;
	arrayBufferBody?: Uint8Array;
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
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function toImpitResponse(response: MockImpitResponse) {
	const headers = toHeaders(response.headers);
	const responseBytes =
		response.arrayBufferBody ?? new TextEncoder().encode(response.body);
	return {
		status: response.status,
		ok: response.status >= 200 && response.status < 300,
		headers,
		url: "https://example.com/final",
		json: async () => JSON.parse(response.body),
		text: async () => response.body,
		arrayBuffer: async () => toArrayBuffer(responseBytes),
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
		const { createStealthClient } = await import("../runtime/stealth");

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

		const { createStealthClient } = await import("../runtime/stealth");
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

	it("normalizes raw response metadata and false ok flag", async () => {
		const response = (await normalizeResponse({
			status: 400,
			headers: toHeaders({
				"content-type": "application/json",
				"set-cookie": "sid=xyz; Path=/",
				"x-test": "1",
			}),
			text: async () => "text-first-corruption",
			arrayBuffer: async () =>
				toArrayBuffer(new TextEncoder().encode('{"error":true}')),
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

	it("preserves multiple cookies when Headers.getSetCookie is unavailable", async () => {
		const headers = toHeaders({
			"set-cookie":
				"sid=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, csrf=def; Path=/",
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
			[
				"set-cookie",
				"sid=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, csrf=def; Path=/",
			],
		]);
	});

	it("throws TransportError on HTTP 500", async () => {
		mockStealthState.queuedResponses.push({
			status: 500,
			body: "boom",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
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

		const { createStealthClient } = await import("../runtime/stealth");
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

		const { createStealthClient } = await import("../runtime/stealth");
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

	it("createSession reuses the same impit client for matching browser/proxy settings", async () => {
		mockStealthState.queuedResponses.push(
			{ status: 200, body: "first", headers: { a: "1" } },
			{ status: 200, body: "second", headers: { a: "2" } },
		);

		const { createStealthClient } = await import("../runtime/stealth");
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

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com");
		const session = client.createSession();

		await session.fetch("/first");
		const impitCookieJar = mockStealthState.clients[0]?.options?.cookieJar as {
			setCookie(cookie: string, url: string): void | Promise<void>;
			getCookieString(url: string): string | Promise<string>;
		};

		expect(impitCookieJar).toBeDefined();
		expect(
			await impitCookieJar.getCookieString("https://example.com/next"),
		).toBe("sid=abc");
		await impitCookieJar.setCookie(
			"redirect_sid=xyz; Path=/",
			"https://example.com/redirect",
		);

		await session.fetch("/second");

		expect(mockStealthState.clients[0]?.calls[1]?.init?.headers).toMatchObject({
			Cookie: "sid=abc; redirect_sid=xyz",
		});
	});

	it("rejects removed Chrome profile names before starting impit", async () => {
		const { createStealthClient } = await import("../runtime/stealth");

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

		const { createStealthClient } = await import("../runtime/stealth");
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

		const { createStealthClient } = await import("../runtime/stealth");
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

		const { createStealthClient } = await import("../runtime/stealth");
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

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", "custom-profile");

		await client.fetch("/profile");

		expect(mockStealthState.clients[0]?.options).toMatchObject({
			browser: "chrome142",
		});
	});

	it("rejects Safari-only stealth profiles instead of silently impersonating Chrome", async () => {
		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", "ios-safari-26");

		await expect(client.fetch("/profile")).rejects.toThrow(
			/Safari stealth fingerprint/,
		);
		expect(mockStealthState.clients).toHaveLength(0);
	});

	it("rejects low-level stealth fingerprint overrides that impit owns internally", async () => {
		const { createStealthClient } = await import("../runtime/stealth");
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

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com");

		await client.fetch("/trace", { method: "TRACE" });
		expect(mockStealthState.clients[0]?.calls[0]?.init.method).toBe("TRACE");

		await expect(
			client.fetch("/tunnel", { method: "CONNECT" as never }),
		).rejects.toThrow(/Unsupported stealth method: CONNECT/);
		expect(mockStealthState.clients).toHaveLength(1);
	});

	it("passes request method, body, timeout, and headers through impit fetch", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
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

	it("wraps network failures in TransportError", async () => {
		mockStealthState.queuedErrors.push(new Error("socket hang up"));

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com");

		await expect(client.fetch("/network")).rejects.toBeInstanceOf(
			TransportError,
		);
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

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com");

		await expect(client.fetch("/slow", { timeout: 10 })).rejects.toMatchObject({
			code: "transport_timeout",
			status: 0,
			message: "Request timed out",
		});
	});
});
