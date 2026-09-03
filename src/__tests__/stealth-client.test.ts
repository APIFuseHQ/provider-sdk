import { beforeEach, describe, expect, it, mock } from "bun:test";
import { z } from "zod";
import alPlacementCapture from "../../al-placement-capture.json";
import chromeAcceptOverride from "../../chrome-accept-override.json";
import chromeExtendedCapture from "../../chrome-extended-capture.json";
import chromeGroundTruth from "../../chrome-ground-truth-capture.json";
import chromeValueTransform from "../../chrome-value-transform.json";
import h1CasingCapture from "../../h1-casing-capture.json";
import {
	ProviderError,
	SDKError,
	StealthCookieStoreVersionError,
	TransportError,
} from "../errors.js";
import { chrome149HeaderOrder } from "../runtime/chrome149-header-order.js";
import { normalizeResponse } from "../runtime/stealth.js";
import {
	type AutoSolveResolverFactory,
	type AutoSolveResolverSelection,
	type DeclarativeStealthResponse,
	HttpRetryUnsafeMethodPolicy,
	type ProviderDefinition,
	type ResolverContext,
	type StealthCookieStoreV1,
	type StealthFetchOptions,
	type StealthRedirectHop,
} from "../types.js";
import { assertIsError, createProviderDefinitionDouble, emptyArray } from "./test-utils.js";

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

function allWreqCalls(): MockWreqCall[] {
	return mockStealthState.clients.flatMap((client) => client.calls);
}

function requestHeader(
	init: Record<string, unknown> | undefined,
	name: string,
): string | undefined {
	const headers = init?.headers;
	if (Array.isArray(headers)) {
		return (headers as [string, string][]).find(
			([headerName]) => headerName.toLowerCase() === name.toLowerCase(),
		)?.[1];
	}
	if (headers && typeof headers === "object") {
		const entry = Object.entries(headers).find(
			([headerName]) => headerName.toLowerCase() === name.toLowerCase(),
		);
		return typeof entry?.[1] === "string" ? entry[1] : undefined;
	}
	return undefined;
}

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

function mockEmulationHeaders(profile: string, os = "macos") {
	const version = /^chrome_(\d+)$/.exec(profile)?.[1] ?? "149";
	const platform = os === "windows" ? '"Windows"' : os === "linux" ? '"Linux"' : '"macOS"';
	const osToken =
		os === "windows"
			? "Windows NT 10.0; Win64; x64"
			: os === "linux"
				? "X11; Linux x86_64"
				: "Macintosh; Intel Mac OS X 10_15_7";
	return new Map([
		["sec-ch-ua", `"Google Chrome";v="${version}", "Chromium";v="${version}"`],
		["sec-ch-ua-mobile", "?0"],
		["sec-ch-ua-platform", platform],
		[
			"user-agent",
			`Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`,
		],
		["sec-fetch-dest", "document"],
		["sec-fetch-mode", "navigate"],
		["sec-fetch-site", "none"],
		[
			"accept",
			"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		],
		["accept-encoding", "gzip, deflate, br, zstd"],
		["accept-language", "en-US,en;q=0.9"],
		["priority", "u=0, i"],
	]);
}

function sbsdInterstitial(scriptUrl: string): string {
	return `<!doctype html><div id="sec-bc-tile-container">fixture challenge</div><script src="${scriptUrl}"></script>`;
}

function queueHardSbsdSolve(
	refetch: MockWreqResponse,
	pageUrl = "https://example.com/protected",
): void {
	mockStealthState.queuedResponses.push(
		{
			status: 403,
			body: sbsdInterstitial("/.well-known/sbsd?v=fixture-uuid&amp;t=fixture-token"),
			headers: { "set-cookie": "sbsd_o=initial-state; Path=/; Secure" },
			url: pageUrl,
		},
		{
			status: 200,
			body: '{"ip":"203.0.113.9"}',
			headers: {},
			url: "https://ip.hypersolutions.co/ip",
		},
		{
			status: 200,
			body: "fixture-sbsd-script",
			headers: {},
			url: "https://example.com/.well-known/sbsd?v=fixture-uuid&t=fixture-token",
		},
		{
			status: 200,
			body: '{"payload":"fixture-payload"}',
			headers: {},
			url: "https://akm.hypersolutions.co/sbsd",
		},
		{
			status: 200,
			body: "payload accepted",
			headers: { "set-cookie": "sbsd_o=updated-state; Path=/; Secure" },
			url: "https://example.com/.well-known/sbsd?t=fixture-token",
		},
		refetch,
	);
}

function fixtureSbsdCookieSolution() {
	return {
		form: "cookies",
		kind: "akamai_sbsd",
		outcome: "payload_accepted_cookies_updated",
		verified: false,
		stateCookieName: "sbsd_o",
	} as const;
}

mock.module("wreq-js", () => ({
	createSession: async (options?: Record<string, unknown>) => new MockWreqSession(options),
	getEmulationHeaders: mockEmulationHeaders,
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
			headers: { "x-request-id": "health" },
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
		const calls = allWreqCalls();
		expect(requestHeader(calls[1]?.init, "cookie")).toBeUndefined();
		expect(requestHeader(calls[2]?.init, "cookie")).toBe("host_a=one");
		expect(requestHeader(calls[2]?.init, "cookie")).not.toContain("host_b=two");
		expect(
			mockStealthState.clients.reduce((total, client) => total + client.clearCookieCalls, 0),
		).toBe(3);
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
		expect(requestHeader(mockStealthState.clients[0]?.calls[0]?.init, "cookie")).toBe(
			"request=first",
		);
		expect(requestHeader(mockStealthState.clients[0]?.calls[1]?.init, "cookie")).toBe(
			"request=second",
		);
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

		const calls = allWreqCalls();
		expect(requestHeader(calls[0]?.init, "cookie")).toBe("bridge=host-a");
		expect(requestHeader(calls[1]?.init, "cookie")).toBeUndefined();
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
			// test-invalid: legacy JavaScript callers can still pass versioned string profiles.
			expect(() =>
				createStealthClient("https://example.com", profile as never).fetch("/profile"),
			).toThrow(SDKError);
		}

		expect(mockStealthState.clients).toHaveLength(0);
	});

	it("rejects a version-pinned profile before starting wreq", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");

		// test-invalid: legacy JavaScript callers can still pass versioned string profiles.
		expect(() =>
			createStealthClient("https://example.com", "chrome-146" as never).createSession(),
		).toThrow(SDKError);
		expect(mockStealthState.clients).toHaveLength(0);
	});

	it("createSession accepts a structured profile override", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			stealth: { browser: "firefox", os: "windows" },
		});
		const session = client.createSession({ stealth: { browser: "chrome", os: "linux" } });

		await session.fetch("/profile");

		expect(mockStealthState.clients[0]?.options).toMatchObject({
			browser: "chrome_149",
			os: "linux",
		});
	});

	it("keeps Firefox selection on Firefox impersonation instead of falling back to Chrome", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			stealth: { browser: "firefox", os: "macos" },
		});

		await client.fetch("/profile");

		expect(mockStealthState.clients[0]?.options).toMatchObject({
			browser: "firefox_147",
			os: "macos",
		});
	});

	it("rejects every removed string selection instead of defaulting it", async () => {
		const { createStealthClient } = await import("../runtime/stealth.js");
		for (const name of ["chrome-desktop", "chrome-windows", "custom-profile"]) {
			// test-invalid: legacy JavaScript callers can still pass removed string profiles.
			expect(() => createStealthClient("https://example.com", name as never)).toThrow(
				"Stealth profile names are no longer supported",
			);
		}
	});

	it("maps Safari OS selection to the matching wreq family", async () => {
		mockStealthState.queuedResponses.push(
			{ status: 200, body: "desktop", headers: {} },
			{ status: 200, body: "ios", headers: {} },
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		await createStealthClient("https://example.com", {
			stealth: { browser: "safari", os: "macos" },
		}).fetch("/profile");
		await createStealthClient("https://example.com", {
			stealth: { browser: "safari", os: "ios" },
		}).fetch("/profile");

		expect(mockStealthState.clients[0]?.options).toMatchObject({
			browser: "safari_17.0",
			os: "macos",
		});
		expect(mockStealthState.clients[1]?.options).toMatchObject({
			browser: "safari_ios_26",
			os: "ios",
		});
	});

	it("applies a per-request profile override once and preserves the client default", async () => {
		mockStealthState.queuedResponses.push(
			{ status: 200, body: "override", headers: {} },
			{ status: 200, body: "default", headers: {} },
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			stealth: { browser: "chrome", os: "windows" },
		});

		await client.fetch("/override", { stealth: { os: "linux" } });
		await client.fetch("/default");

		expect(mockStealthState.clients.map((entry) => entry.options?.os)).toEqual([
			"linux",
			"windows",
		]);
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
			headers: { "content-type": "application/json" },
			method: "POST",
			timeout: 12_000,
		});

		const requestInit = mockStealthState.clients[0]?.calls[0]?.init;
		expect(requestInit).toMatchObject({
			body: '{"ok":true}',
			method: "POST",
		});
		expect(requestHeader(requestInit, "content-type")).toBe("application/json");
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
		expect(allWreqCalls()).toEqual([
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

		const calls = allWreqCalls();
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

describe("Chrome 149 header parity", () => {
	const oses = ["windows", "macos", "linux"] as const;
	// Every fixture capture below was taken through Playwright's `locale` option,
	// which installs Accept-Language via DevTools next to User-Agent. Real Chrome
	// receives it only from //net (URLRequestHttpJob::AddExtraHeaders): after
	// Accept-Encoding, before Cookie. Moving it is exact whenever the harness key did
	// not itself trigger a hash-table expansion, which al-placement-capture.json
	// B_nolocale_none confirms for the XHR shape and which holds for every capture
	// used here (at most two caller map keys, or a caller-supplied Accept-Language).
	function realChromeOrder(harnessOrder: readonly string[]): string[] {
		const acceptLanguage = harnessOrder.find((name) => name.toLowerCase() === "accept-language");
		if (acceptLanguage === undefined) throw new Error("Harness capture lacks Accept-Language");
		const order = harnessOrder.filter((name) => name !== acceptLanguage);
		const acceptEncoding = order.findIndex((name) => name.toLowerCase() === "accept-encoding");
		if (acceptEncoding < 0) throw new Error("Harness capture lacks Accept-Encoding");
		order.splice(acceptEncoding + 1, 0, acceptLanguage);
		return order;
	}
	const honouredOverrides = new Map(
		Object.values(chromeAcceptOverride)
			.filter((capture) => capture.honoured)
			.map((capture) => [capture.header.toLowerCase(), capture]),
	);
	const classes = [
		{
			name: "document_navigation_cold",
			expected: realChromeOrder(chromeGroundTruth.document_navigation_cold.order),
			options: {},
		},
		{
			name: "document_navigation_same_origin",
			expected: realChromeOrder(chromeGroundTruth.document_navigation_same_origin.order),
			options: {},
		},
		{
			name: "xhr",
			expected: [
				...chromeGroundTruth.fetch_xhr.order.slice(0, 4),
				...alPlacementCapture.B_nolocale_none.order,
			],
			options: {
				stealth: { requestClass: "xhr" },
				headers: { Referer: "https://example.com/page" },
			},
		},
		{
			name: "post",
			expected: realChromeOrder(chromeGroundTruth.fetch_post_json.order),
			options: {
				method: "POST" as const,
				body: '{"ok":true}',
				headers: {
					Referer: "https://example.com/page",
					Origin: "https://example.com",
					"Content-Type": "application/json",
				},
			},
		},
	] as const;

	beforeEach(() => {
		mockStealthState.clients.length = 0;
		mockStealthState.queuedResponses.length = 0;
		mockStealthState.queuedErrors.length = 0;
		mockStealthState.queuedCloseErrors.length = 0;
	});

	it("derives the same real-Chrome XHR order from the harness capture and the no-DevTools capture", () => {
		expect(realChromeOrder(chromeGroundTruth.fetch_xhr.order)).toEqual([
			...chromeGroundTruth.fetch_xhr.order.slice(0, 4),
			...alPlacementCapture.B_nolocale_none.order,
		]);
	});

	for (const os of oses) {
		for (const requestClass of classes) {
			it(`matches real-Chrome ${requestClass.name} order on ${os}`, async () => {
				mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
				const { createStealthClient } = await import("../runtime/stealth.js");
				await createStealthClient("https://example.com", {
					stealth: { browser: "chrome", os },
				}).fetch("/api", requestClass.options);

				const defaults = mockStealthState.clients[0]?.options?.defaultHeaders as [string, string][];
				expect(defaults.map(([name]) => name)).toEqual(requestClass.expected.slice(4));
				const wreqHeaders = mockEmulationHeaders("chrome_149", os);
				expect(requestHeader({ headers: defaults }, "sec-ch-ua-platform")).toBe(
					wreqHeaders.get("sec-ch-ua-platform"),
				);
				expect(requestHeader({ headers: defaults }, "user-agent")).toBe(
					wreqHeaders.get("user-agent"),
				);
			});
		}
	}

	it("ignores scrambled caller key order for captured fields", async () => {
		mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
		const { createStealthClient } = await import("../runtime/stealth.js");
		await createStealthClient("https://example.com").fetch("/api", {
			method: "POST",
			body: '{"ok":true}',
			headers: {
				Referer: "https://example.com/page",
				Origin: "https://example.com",
				"Content-Type": "application/json",
			},
		});

		const defaults = mockStealthState.clients[0]?.options?.defaultHeaders as [string, string][];
		expect(defaults.map(([name]) => name)).toEqual(
			realChromeOrder(chromeGroundTruth.fetch_post_json.order).slice(4),
		);
	});

	it("emits Accept-Language where //net appends it and honours client and request overrides", async () => {
		mockStealthState.queuedResponses.push(
			{ status: 200, body: "default", headers: {} },
			{ status: 200, body: "override", headers: {} },
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			stealth: { browser: "chrome", os: "windows", acceptLanguage: "ja" },
		});
		await client.fetch("/api");
		await client.fetch("/api", { headers: { "Accept-Language": "ko" } });

		const expected = realChromeOrder(chromeGroundTruth.document_navigation_cold.order).slice(4);
		expect(expected.indexOf("accept-language")).toBe(expected.indexOf("accept-encoding") + 1);
		const defaults = mockStealthState.clients[0]?.options?.defaultHeaders as [string, string][];
		expect(defaults.map(([name]) => name)).toEqual(expected);
		expect(requestHeader({ headers: defaults }, "accept-language")).toBe("ja");
		const overrideHeaders = mockStealthState.clients[0]?.calls[1]?.init?.headers as [
			string,
			string,
		][];
		expect(overrideHeaders.map(([name]) => name)).toEqual(expected);
		expect(requestHeader({ headers: overrideHeaders }, "accept-language")).toBe("ko");
	});

	interface AcceptLanguagePlacementCapture {
		readonly variant: string;
		readonly caller: readonly string[];
		readonly order: readonly string[];
		readonly acceptLanguage: string;
	}
	const acceptLanguagePlacementCases: Array<[string, AcceptLanguagePlacementCapture]> =
		Object.entries(alPlacementCapture).filter(([, capture]) => capture.variant !== "A_locale");
	for (const [label, capture] of acceptLanguagePlacementCases) {
		it(`reproduces the no-DevTools ${label} capture through the transport`, async () => {
			// B: Chrome's built-in default value; C: --accept-lang=ja, which maps to the
			// client-wide stealth.acceptLanguage option. Same position either way.
			const configured = capture.variant === "C_acceptlang";
			mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
			const { createStealthClient } = await import("../runtime/stealth.js");
			await createStealthClient("https://example.com", {
				stealth: {
					browser: "chrome",
					os: "linux",
					...(configured ? { acceptLanguage: capture.acceptLanguage } : {}),
				},
			}).fetch("/api", {
				stealth: { requestClass: "xhr" },
				headers: {
					Referer: "https://example.com/",
					...Object.fromEntries(capture.caller.map((name) => [name, "1"])),
				},
			});
			const init = mockStealthState.clients[0]?.calls[0]?.init;
			const names = (init?.headers as [string, string][]).map(([name]) => name);
			expect(names).toEqual([...capture.order]);
			expect(requestHeader(init, "accept-language")).toBe(capture.acceptLanguage);
		});
	}

	it("keeps a caller-supplied Accept-Language at its Fetch map bucket on XHR", async () => {
		// Captured under the locale harness, but InspectorEmulationAgent::PrepareRequest
		// skips a key the page already set, so the map was untouched: this is also
		// real-Chrome order, and //net (SetHeaderIfMissing) appends no second
		// Accept-Language.
		const capture = chromeValueTransform.accept_language_override;
		mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
		const { createStealthClient } = await import("../runtime/stealth.js");
		await createStealthClient("https://example.com", {
			stealth: { browser: "chrome", os: "linux", acceptLanguage: "ja" },
		}).fetch("/api", {
			stealth: { requestClass: "xhr" },
			headers: { Referer: capture.observed.referer, ...capture.sent },
		});
		const headers = mockStealthState.clients[0]?.calls[0]?.init?.headers as [string, string][];
		expect(headers.map(([name]) => name)).toEqual(Object.keys(capture.observed));
		expect(headers.filter(([name]) => name === "accept-language")).toEqual([
			["accept-language", capture.observed["accept-language"]],
		]);
	});

	it("places cookies at the captured position for every request class", async () => {
		const xhrCookieOrder = [...alPlacementCapture.B_nolocale_none.order];
		xhrCookieOrder.splice(xhrCookieOrder.indexOf("priority"), 0, "cookie");
		const cases = [
			[
				"navigation",
				realChromeOrder(chromeExtendedCapture.navigation_with_cookie.order).slice(4),
				{},
			],
			["xhr", xhrCookieOrder, { Referer: "https://example.com/" }],
			[
				"post",
				realChromeOrder(chromeExtendedCapture.post_form_urlencoded.order).slice(4),
				{
					"Content-Type": "application/x-www-form-urlencoded",
					Origin: "https://example.com",
					Referer: "https://example.com/",
				},
			],
		] as const;
		for (const [requestClass, expectedWithPseudo, headers] of cases) {
			mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
			const { createStealthClient } = await import("../runtime/stealth.js");
			await createStealthClient("https://example.com").fetch("/api", {
				method: requestClass === "post" ? "POST" : "GET",
				body: requestClass === "post" ? "a=1" : undefined,
				stealth: { requestClass },
				headers: { ...headers, Cookie: "probe_sid=abc123" },
			});
			const init = mockStealthState.clients.at(-1)?.calls[0]?.init;
			const names = (init?.headers as [string, string][]).map(([name]) => name);
			expect(names).toEqual(expectedWithPseudo);
			expect(names.indexOf("cookie")).toBe(expectedWithPseudo.indexOf("cookie"));
			expect(names.indexOf("cookie")).toBe(names.indexOf("accept-language") + 1);
		}
	});

	it("uses identity encoding for Range and compressed encoding otherwise", async () => {
		mockStealthState.queuedResponses.push(
			{ status: 200, body: "range", headers: {} },
			{ status: 200, body: "normal", headers: {} },
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");
		await client.fetch("/range", {
			stealth: { requestClass: "xhr" },
			headers: { Referer: "https://example.com/", Range: "bytes=0-1023" },
		});
		await client.fetch("/normal", { stealth: { requestClass: "xhr" } });
		const calls = allWreqCalls();
		expect(requestHeader(calls[0]?.init, "accept-encoding")).toBe("identity");
		expect(requestHeader(calls[1]?.init, "accept-encoding")).toBe("gzip, deflate, br, zstd");
	});

	it("uses HashMap order for h2 extension headers while preserving measured h1 order", async () => {
		mockStealthState.queuedResponses.push(
			{ status: 200, body: "h2", headers: {} },
			{ status: 200, body: "h1", headers: {} },
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		const h2 = createStealthClient("https://example.com");
		await h2.fetch("/xhr", {
			stealth: { requestClass: "xhr" },
			headers: {
				"Cache-Control": "no-cache",
				"If-None-Match": '"etag-value"',
				Pragma: "no-cache",
				"X-Requested-With": "XMLHttpRequest",
				Referer: "https://example.com/",
				Cookie: "probe_sid=abc123",
			},
		});
		const h1 = createStealthClient("http://example.com");
		await h1.fetch("/xhr", {
			stealth: { requestClass: "xhr" },
			headers: {
				"Cache-Control": "no-cache",
				"X-Requested-With": "XMLHttpRequest",
				Referer: "http://example.com/",
				Cookie: "probe_sid=abc123",
			},
		});
		const h2Names = (
			mockStealthState.clients[0]?.calls[0]?.init?.headers as [string, string][]
		).map(([name]) => name);
		const h2Expected = chrome149HeaderOrder([
			"Cache-Control",
			"If-None-Match",
			"Pragma",
			"X-Requested-With",
		]);
		h2Expected.splice(h2Expected.indexOf("accept-language") + 1, 0, "cookie");
		expect(h2Names).toEqual(h2Expected);
		const h1Names = (
			mockStealthState.clients[1]?.calls[0]?.init?.headers as [string, string][]
		).map(([name]) => name);
		expect(h1Names).toEqual(realChromeOrder(h1CasingCapture.chrome_xhr.names));
	});

	it("allows a refererless XHR without navigation-only headers", async () => {
		mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
		const { createStealthClient } = await import("../runtime/stealth.js");
		await createStealthClient("https://example.com").fetch("/api", {
			stealth: { requestClass: "xhr" },
		});
		const init = mockStealthState.clients[0]?.calls[0]?.init;
		expect(requestHeader(init, "upgrade-insecure-requests")).toBeUndefined();
		expect(requestHeader(init, "sec-fetch-user")).toBeUndefined();
		expect(requestHeader(init, "accept")).toBe("*/*");
	});

	it("keeps h1 casing and Host/Connection order while omitting priority", async () => {
		mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
		const { createStealthClient } = await import("../runtime/stealth.js");
		await createStealthClient("http://example.com").fetch("/", {
			stealth: { requestClass: "navigation" },
			headers: { Cookie: "probe_sid=abc123" },
		});
		const names = (mockStealthState.clients[0]?.calls[0]?.init?.headers as [string, string][]).map(
			([name]) => name,
		);
		expect(names).toEqual(realChromeOrder(h1CasingCapture.chrome_navigation.names));
		expect(names[0]).toBe("Host");
		expect(names[1]).toBe("Connection");
		expect(names).not.toContain("priority");

		mockStealthState.queuedResponses.push({ status: 200, body: "h2", headers: {} });
		await createStealthClient("https://example.com").fetch("/", {
			stealth: { requestClass: "navigation" },
		});
		const h2Names = (
			mockStealthState.clients[1]?.calls[0]?.init?.headers as [string, string][]
		).map(([name]) => name);
		expect(h2Names).toContain("priority");
	});

	const overridePositionCases = [
		{
			capture: honouredOverrides.get("accept"),
			order: chromeValueTransform.accept_padded.observed,
		},
		{
			capture: honouredOverrides.get("priority"),
			order: chromeValueTransform.priority_custom.observed,
		},
		{
			capture: honouredOverrides.get("upgrade-insecure-requests"),
			order: chromeValueTransform.uir_zero.observed,
		},
	] as const;

	for (const { capture, order } of overridePositionCases) {
		if (!capture) throw new Error("Missing honoured Chrome override capture");
		it(`honours ${capture.header} at its captured caller-provided XHR position`, async () => {
			mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
			const { createStealthClient } = await import("../runtime/stealth.js");
			await createStealthClient("https://example.com").fetch("/api", {
				stealth: { requestClass: "xhr" },
				headers: {
					Referer: chromeValueTransform.accept_padded.observed.referer,
					[capture.header]: capture.requested,
				},
			});
			const init = mockStealthState.clients[0]?.calls[0]?.init;
			const headers = init?.headers as [string, string][];
			expect(headers.map(([name]) => name)).toEqual(realChromeOrder(Object.keys(order)));
			expect(requestHeader(init, capture.header)).toBe(capture.observed);
		});
	}

	it("uses profile and request-class defaults when caller-overridable headers are omitted", async () => {
		mockStealthState.queuedResponses.push(
			{ status: 200, body: "navigation", headers: {} },
			{ status: 200, body: "xhr", headers: {} },
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");
		await client.fetch("/navigation");
		await client.fetch("/xhr", { stealth: { requestClass: "xhr" } });

		const navigation = allWreqCalls()[0]?.init;
		const emulation = mockEmulationHeaders("chrome_149");
		expect(requestHeader(navigation, "accept")).toBe(emulation.get("accept"));
		expect(requestHeader(navigation, "priority")).toBe(emulation.get("priority"));
		expect(requestHeader(navigation, "upgrade-insecure-requests")).toBe(
			honouredOverrides.get("upgrade-insecure-requests")?.observed,
		);

		const xhr = allWreqCalls()[1]?.init;
		expect(requestHeader(xhr, "accept")).toBe(chromeValueTransform.uir_zero.observed.accept);
		expect(requestHeader(xhr, "priority")).toBe(chromeValueTransform.uir_zero.observed.priority);
		expect(requestHeader(xhr, "upgrade-insecure-requests")).toBeUndefined();
	});

	const transformCases = [
		chromeValueTransform.accept_padded,
		chromeValueTransform.accept_inner_spaces,
		chromeValueTransform.accept_uppercase,
		chromeValueTransform.accept_q_values,
		chromeValueTransform.accept_empty,
	] as const;
	for (const capture of transformCases) {
		const [header, sent] = Object.entries(capture.sent)[0] ?? [];
		if (header === undefined || sent === undefined) throw new Error("Invalid transform capture");
		it(`${capture.note} matches the captured Chrome value`, async () => {
			mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
			const { createStealthClient } = await import("../runtime/stealth.js");
			await createStealthClient("https://example.com").fetch("/api", {
				stealth: { requestClass: "xhr" },
				headers: { [header]: sent },
			});
			expect(requestHeader(allWreqCalls()[0]?.init, header)).toBe(
				capture.observed[header.toLowerCase() as keyof typeof capture.observed],
			);
		});
	}

	it("applies captured outer trimming to caller extension headers too", async () => {
		mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
		const { createStealthClient } = await import("../runtime/stealth.js");
		const sent = chromeValueTransform.accept_padded.sent.Accept;
		await createStealthClient("https://example.com").fetch("/api", {
			stealth: { requestClass: "xhr" },
			headers: { "X-Captured-Value": sent },
		});
		expect(requestHeader(allWreqCalls()[0]?.init, "x-captured-value")).toBe(
			chromeValueTransform.accept_padded.observed.accept,
		);
	});

	it("joins captured duplicate and array values with the captured separator", async () => {
		const duplicate = chromeValueTransform.accept_duplicate;
		const [[header, first], [, second]] = duplicate.sent;
		mockStealthState.queuedResponses.push(
			{ status: 200, body: "duplicate", headers: {} },
			{ status: 200, body: "array", headers: {} },
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");
		await client.fetch("/duplicate", {
			stealth: { requestClass: "xhr" },
			headers: { [header]: first, [header.toLowerCase()]: second },
		});
		await client.fetch("/array", {
			stealth: { requestClass: "xhr" },
			headers: { [header]: duplicate.sent.map(([, value]) => value) },
		});
		expect(requestHeader(allWreqCalls()[0]?.init, header)).toBe(duplicate.observed.accept);
		expect(requestHeader(allWreqCalls()[1]?.init, header)).toBe(duplicate.observed.accept);
	});

	for (const capture of [
		chromeValueTransform.accept_name_lower,
		chromeValueTransform.accept_name_weird,
	]) {
		const [header, sent] = Object.entries(capture.sent)[0] ?? [];
		if (header === undefined || sent === undefined) throw new Error("Invalid name capture");
		it(`${capture.note} has no effect on the wire name or value`, async () => {
			mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
			const { createStealthClient } = await import("../runtime/stealth.js");
			await createStealthClient("https://example.com").fetch("/api", {
				stealth: { requestClass: "xhr" },
				headers: { [header]: sent },
			});
			const headers = allWreqCalls()[0]?.init?.headers as [string, string][];
			expect(headers.filter(([name]) => name === "accept")).toEqual([
				["accept", capture.observed.accept],
			]);
		});
	}

	it("transmits a malformed caller value without introducing validation", async () => {
		const capture = chromeValueTransform.priority_invalid;
		const [header, sent] = Object.entries(capture.sent)[0] ?? [];
		if (header === undefined || sent === undefined) throw new Error("Invalid malformed capture");
		mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
		const { createStealthClient } = await import("../runtime/stealth.js");
		await createStealthClient("https://example.com").fetch("/api", {
			stealth: { requestClass: "xhr" },
			headers: { [header]: sent },
		});
		expect(requestHeader(allWreqCalls()[0]?.init, header)).toBe(capture.observed.priority);
	});

	it("keeps Range accept-encoding identity when Accept is caller-supplied", async () => {
		const accept = honouredOverrides.get("accept");
		if (!accept) throw new Error("Missing Accept override capture");
		mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
		const { createStealthClient } = await import("../runtime/stealth.js");
		await createStealthClient("https://example.com").fetch("/range", {
			stealth: { requestClass: "xhr" },
			headers: {
				[accept.header]: accept.requested,
				Range: chromeExtendedCapture.xhr_range.values.range,
			},
		});
		const init = allWreqCalls()[0]?.init;
		expect(requestHeader(init, "accept")).toBe(accept.observed);
		expect(requestHeader(init, "accept-encoding")).toBe(
			chromeExtendedCapture.xhr_range.values["accept-encoding"],
		);
	});

	it("places Cookie and Range after //net's Accept-Language on XHR", async () => {
		mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
		const { createStealthClient } = await import("../runtime/stealth.js");
		await createStealthClient("https://example.com").fetch("/range", {
			stealth: { requestClass: "xhr" },
			headers: {
				Referer: chromeExtendedCapture.xhr_range.values.referer,
				Cookie: chromeExtendedCapture.xhr_range.values.cookie,
				Range: chromeExtendedCapture.xhr_range.values.range,
			},
		});
		const names = (allWreqCalls()[0]?.init?.headers as [string, string][]).map(([name]) => name);
		expect(names).toEqual(realChromeOrder(chromeExtendedCapture.xhr_range.order).slice(4));
		expect(names.slice(names.indexOf("accept-encoding"))).toEqual([
			"accept-encoding",
			"accept-language",
			"cookie",
			"range",
			"priority",
		]);
	});

	it("places cookie-jar cookies at the Chrome position with the lowercase h2 name", async () => {
		mockStealthState.queuedResponses.push(
			{ status: 200, body: "login", headers: { "set-cookie": "sid=abc; Path=/" } },
			{ status: 200, body: "xhr", headers: {} },
			{ status: 200, body: "navigation", headers: {} },
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");
		await client.fetch("/login");
		await client.fetch("/api", {
			stealth: { requestClass: "xhr" },
			headers: { Referer: "https://example.com/" },
		});
		await client.fetch("/page");

		const calls = allWreqCalls();
		const xhrNames = (calls[1]?.init?.headers as [string, string][]).map(([name]) => name);
		const xhrExpected = [...alPlacementCapture.B_nolocale_none.order];
		xhrExpected.splice(xhrExpected.indexOf("priority"), 0, "cookie");
		expect(xhrNames).toEqual(xhrExpected);
		expect(requestHeader(calls[1]?.init, "cookie")).toBe("sid=abc");
		const navigationNames = (calls[2]?.init?.headers as [string, string][]).map(([name]) => name);
		expect(navigationNames).toEqual(
			realChromeOrder(chromeExtendedCapture.navigation_with_cookie.order).slice(4),
		);
		expect(requestHeader(calls[2]?.init, "cookie")).toBe("sid=abc");
	});

	it("places Cookie directly after accept-encoding when the caller supplied Accept-Language on XHR", async () => {
		mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
		const { createStealthClient } = await import("../runtime/stealth.js");
		await createStealthClient("https://example.com").fetch("/api", {
			stealth: { requestClass: "xhr" },
			headers: { Referer: "https://example.com/", "Accept-Language": "ko", Cookie: "sid=abc" },
		});
		const names = (allWreqCalls()[0]?.init?.headers as [string, string][]).map(([name]) => name);
		const expected = [...Object.keys(chromeValueTransform.accept_language_override.observed)];
		expected.splice(expected.indexOf("priority"), 0, "cookie");
		expect(names).toEqual(expected);
		expect(names.filter((name) => name === "accept-language")).toHaveLength(1);
		expect(names.slice(names.indexOf("accept-encoding"))).toEqual([
			"accept-encoding",
			"cookie",
			"priority",
		]);
	});

	it("keeps Cookie and Range after //net's Accept-Language when the caller supplied Priority on XHR", async () => {
		mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
		const { createStealthClient } = await import("../runtime/stealth.js");
		await createStealthClient("https://example.com").fetch("/api", {
			stealth: { requestClass: "xhr" },
			headers: {
				Referer: "https://example.com/",
				Priority: "u=4, i",
				Cookie: "sid=abc",
				Range: "bytes=0-1",
			},
		});
		const init = allWreqCalls()[0]?.init;
		const names = (init?.headers as [string, string][]).map(([name]) => name);
		// Range occupies a map bucket and is then re-added at the tail by the HTTP
		// cache; a caller Priority stays in the map, so nothing follows Range.
		const expected = chrome149HeaderOrder(["Priority", "Range"]);
		expected.splice(expected.indexOf("range"), 1);
		expected.push("cookie", "range");
		expect(names).toEqual(expected);
		expect(names.indexOf("priority")).toBeLessThan(names.indexOf("accept"));
		expect(names.slice(-4)).toEqual(["accept-encoding", "accept-language", "cookie", "range"]);
		expect(requestHeader(init, "accept-encoding")).toBe("identity");
	});

	it("orders h1 POST with Accept-Language after Accept-Encoding and before Cookie", async () => {
		mockStealthState.queuedResponses.push({ status: 200, body: "ok", headers: {} });
		const { createStealthClient } = await import("../runtime/stealth.js");
		await createStealthClient("http://example.com").fetch("/submit", {
			method: "POST",
			body: "a=1",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: "http://example.com",
				Referer: "http://example.com/",
				Cookie: "sid=abc",
			},
		});
		const names = (allWreqCalls()[0]?.init?.headers as [string, string][]).map(([name]) => name);
		expect(names.slice(0, 2)).toEqual(["Host", "Connection"]);
		expect(names).not.toContain("priority");
		expect(names.map((name) => name.toLowerCase())).toEqual([
			"host",
			"connection",
			...realChromeOrder(chromeExtendedCapture.post_form_urlencoded.order)
				.slice(4)
				.filter((name) => name !== "priority"),
		]);
		expect(names.indexOf("Accept-Language")).toBe(names.indexOf("Accept-Encoding") + 1);
		expect(names.indexOf("Cookie")).toBe(names.indexOf("Accept-Language") + 1);
	});

	const rejectedCaptures = Object.values(chromeAcceptOverride).filter(
		(capture) => !capture.honoured,
	);
	const remainingRejected = [
		...rejectedCaptures.map((capture) => ({ header: capture.header, value: capture.requested })),
		...[
			"host",
			"connection",
			"sec-ch-ua",
			"sec-ch-ua-mobile",
			"sec-ch-ua-platform",
			"sec-fetch-mode",
			"sec-fetch-site",
			"sec-fetch-user",
			"sec-fetch-future",
		].map((header) => ({ header, value: "caller-value" })),
	];
	for (const { header, value } of remainingRejected) {
		it(`rejects caller override of ${header}`, async () => {
			const { createStealthClient } = await import("../runtime/stealth.js");
			let thrown: unknown;
			try {
				await createStealthClient("https://example.com").fetch("/api", {
					headers: { [header]: value },
				});
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(SDKError);
			if (!(thrown instanceof SDKError)) throw new Error("Expected SDKError");
			expect(thrown.message).toContain(header.toLowerCase());
			expect(mockStealthState.clients).toHaveLength(0);
		});
	}

	it("classifies all three SBSD script URL variants without a resolver or cookie values", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=hard-uuid&amp;t=hard-token"),
				headers: { "set-cookie": "sbsd_o=fixture-secret; Path=/; Secure" },
				url: "https://example.com/hard",
			},
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=hard-raw&t=hard-raw-token"),
				headers: { "set-cookie": "sbsd_o=raw-secret; Path=/; Secure" },
				url: "https://example.com/hard-raw",
			},
			{
				status: 200,
				body: sbsdInterstitial("https://example.com/.well-known/sbsd?v=passive-uuid"),
				headers: { "set-cookie": "bm_so=another-secret; Path=/; Secure" },
				url: "https://example.com/passive",
			},
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		const clientOptions = {
			stealth: {
				browser: "safari",
				os: "macos",
				challengeRuntime: { akamaiSbsd: { allowedHosts: ["example.com"] } },
			},
		} as const;

		const hard = await createStealthClient("https://example.com", clientOptions).fetch("/hard");
		const hardRaw = await createStealthClient("https://example.com", clientOptions).fetch(
			"/hard-raw",
		);
		const passive = await createStealthClient("https://example.com", clientOptions).fetch(
			"/passive",
		);

		expect(hard.challenge).toEqual({
			challenge: {
				kind: "akamai_sbsd",
				pageUrl: "https://example.com/hard",
				scriptUrl: "https://example.com/.well-known/sbsd?v=hard-uuid&t=hard-token",
				stateCookieName: "sbsd_o",
			},
			outcome: "resolver_unavailable",
		});
		expect(hardRaw.challenge).toEqual({
			challenge: {
				kind: "akamai_sbsd",
				pageUrl: "https://example.com/hard-raw",
				scriptUrl: "https://example.com/.well-known/sbsd?v=hard-raw&t=hard-raw-token",
				stateCookieName: "sbsd_o",
			},
			outcome: "resolver_unavailable",
		});
		expect(passive.challenge).toEqual({
			challenge: {
				kind: "akamai_sbsd",
				pageUrl: "https://example.com/passive",
				scriptUrl: "https://example.com/.well-known/sbsd?v=passive-uuid",
				stateCookieName: "bm_so",
			},
			outcome: "resolver_unavailable",
		});
		const classifications = JSON.stringify([hard.challenge, hardRaw.challenge, passive.challenge]);
		expect(classifications).not.toContain("fixture-secret");
		expect(classifications).not.toContain("raw-secret");
		expect(classifications).not.toContain("another-secret");
	});

	it("does not classify a non-Akamai 403", async () => {
		mockStealthState.queuedResponses.push({
			status: 403,
			body: "ordinary forbidden response",
			headers: { "set-cookie": "sbsd_o=irrelevant; Path=/" },
			url: "https://example.com/forbidden",
		});
		const { createStealthClient } = await import("../runtime/stealth.js");
		const response = await createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: { akamaiSbsd: { allowedHosts: ["example.com"] } },
			},
		}).fetch("/forbidden", { throwOnHttpError: false });

		expect(response.status).toBe(403);
		expect(response.challenge).toBeUndefined();
		expect(allWreqCalls()).toHaveLength(1);
	});

	it("leaves a 200 response with only a stray SBSD cookie unclassified", async () => {
		mockStealthState.queuedResponses.push({
			status: 200,
			body: '{"items":["ordinary fixture"]}',
			headers: { "set-cookie": "sbsd_o=stray-secret; Path=/; Secure" },
			url: "https://example.com/ordinary",
		});
		const { createStealthClient } = await import("../runtime/stealth.js");
		const response = await createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: { akamaiSbsd: { allowedHosts: ["example.com"] } },
			},
		}).fetch("/ordinary");

		expect(response.body).toBe('{"items":["ordinary fixture"]}');
		expect(response.challenge).toBeUndefined();
		expect(allWreqCalls()).toHaveLength(1);
	});

	it("remembers a v-only script and applies a later cpr_chlge token as index zero", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 200,
				body: '<!doctype html><script src="/.well-known/sbsd?v=remembered-uuid"></script>',
				headers: { "set-cookie": "sbsd_o=remembered-state; Path=/; Secure" },
				url: "https://example.com/bootstrap",
			},
			{
				status: 429,
				body: '{"cpr_chlge":"true","t":"298133469"}',
				headers: { "content-type": "application/json" },
				url: "https://example.com/apis/bff/home/shortcuts",
			},
			{
				status: 200,
				body: '{"ip":"203.0.113.9"}',
				headers: {},
				url: "https://ip.hypersolutions.co/ip",
			},
			{
				status: 200,
				body: "fixture-remembered-script",
				headers: {},
				url: "https://example.com/.well-known/sbsd?v=remembered-uuid",
			},
			{
				status: 200,
				body: '{"payload":"fixture-later-token-payload"}',
				headers: {},
				url: "https://akm.hypersolutions.co/sbsd",
			},
			{
				status: 200,
				body: "payload accepted",
				headers: { "set-cookie": "sbsd_o=later-token-state; Path=/; Secure" },
				url: "https://example.com/.well-known/sbsd?t=298133469",
			},
			{
				status: 200,
				body: '{"shortcuts":["ok"]}',
				headers: { "content-type": "application/json" },
				url: "https://example.com/apis/bff/home/shortcuts",
			},
		);
		let observedChallenge: unknown;
		const { createHypersolutionsResolverVendorAdapter } = await import(
			"../runtime/resolver-vendors/hypersolutions.js"
		);
		const adapter = createHypersolutionsResolverVendorAdapter({
			apiKey: "fixture-hyper-key",
			allowedHosts: ["example.com"],
		});
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			stealth: {
				browser: "safari",
				os: "macos",
				challengeRuntime: {
					akamaiSbsd: {
						allowedHosts: ["example.com"],
						clientProfile: "safari17_0",
						async solve(challenge, transport, _clientProfile, signal) {
							observedChallenge = challenge;
							return adapter.solve(challenge, undefined, signal, undefined, transport);
						},
					},
				},
			},
		});

		const bootstrap = await client.fetch("/bootstrap");
		const result = await client.fetch("/apis/bff/home/shortcuts");

		expect(bootstrap.challenge).toBeUndefined();
		expect(result).toMatchObject({ status: 200, body: '{"shortcuts":["ok"]}' });
		expect(observedChallenge).toEqual({
			kind: "akamai_sbsd",
			pageUrl: "https://example.com/apis/bff/home/shortcuts",
			scriptUrl: "https://example.com/.well-known/sbsd?v=remembered-uuid",
			stateCookieName: "sbsd_o",
			challengeToken: "298133469",
		});
		expect(
			allWreqCalls().some(
				(call) => call.url === "https://example.com/.well-known/sbsd?v=remembered-uuid",
			),
		).toBe(true);
		expect(
			allWreqCalls().some(
				(call) => call.url === "https://example.com/.well-known/sbsd?t=298133469",
			),
		).toBe(true);
		const hyperCall = allWreqCalls().find(
			(call) => call.url === "https://akm.hypersolutions.co/sbsd",
		);
		expect(JSON.parse(String(hyperCall?.init?.body))).toMatchObject({ index: 0 });
	});

	it("does not share a remembered SBSD script across stealth sessions", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 200,
				body: '<!doctype html><script src="/.well-known/sbsd?v=session-a"></script>',
				headers: { "set-cookie": "sbsd_o=session-a-state; Path=/; Secure" },
				url: "https://example.com/bootstrap",
			},
			{
				status: 429,
				body: '{"cpr_chlge":"true","t":"session-b-token"}',
				headers: { "set-cookie": "sbsd_o=session-b-state; Path=/; Secure" },
				url: "https://example.com/apis/bff/session-b",
			},
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: { akamaiSbsd: { allowedHosts: ["example.com"] } },
			},
		});
		const sessionA = client.createSession();
		const sessionB = client.createSession();

		const bootstrap = await sessionA.fetch("/bootstrap");
		const laterToken = await sessionB.fetch("/apis/bff/session-b", {
			throwOnHttpError: false,
		});

		expect(bootstrap.challenge).toBeUndefined();
		expect(laterToken.status).toBe(429);
		expect(laterToken.challenge).toBeUndefined();
		expect(allWreqCalls()).toHaveLength(2);
	});

	it("replaces the remembered script with the latest hard interstitial version", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 200,
				body: '<!doctype html><script src="/.well-known/sbsd?v=old-version"></script>',
				headers: { "set-cookie": "sbsd_o=old-state; Path=/; Secure" },
				url: "https://example.com/bootstrap",
			},
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=new-version&t=hard-token"),
				headers: { "set-cookie": "sbsd_o=new-state; Path=/; Secure" },
				url: "https://example.com/hard",
			},
			{
				status: 429,
				body: '{"cpr_chlge":"true","t":"later-token"}',
				headers: { "content-type": "application/json" },
				url: "https://example.com/apis/bff/latest",
			},
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: { akamaiSbsd: { allowedHosts: ["example.com"] } },
			},
		}).createSession();

		const bootstrap = await session.fetch("/bootstrap");
		const hard = await session.fetch("/hard", { throwOnHttpError: false });
		const later = await session.fetch("/apis/bff/latest", { throwOnHttpError: false });

		expect(bootstrap.challenge).toBeUndefined();
		expect(hard.challenge?.challenge.scriptUrl).toBe(
			"https://example.com/.well-known/sbsd?v=new-version&t=hard-token",
		);
		expect(later.challenge).toEqual({
			challenge: {
				kind: "akamai_sbsd",
				pageUrl: "https://example.com/apis/bff/latest",
				scriptUrl: "https://example.com/.well-known/sbsd?v=new-version",
				stateCookieName: "sbsd_o",
				challengeToken: "later-token",
			},
			outcome: "resolver_unavailable",
		});
	});

	it("does not compose a token-only response without a remembered script", async () => {
		mockStealthState.queuedResponses.push({
			status: 429,
			body: '{"cpr_chlge":"true","t":"orphan-token"}',
			headers: { "set-cookie": "sbsd_o=orphan-state; Path=/; Secure" },
			url: "https://example.com/apis/bff/orphan",
		});
		const { createStealthClient } = await import("../runtime/stealth.js");
		const response = await createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: { akamaiSbsd: { allowedHosts: ["example.com"] } },
			},
		}).fetch("/apis/bff/orphan", { throwOnHttpError: false });

		expect(response.status).toBe(429);
		expect(response.challenge).toBeUndefined();
		expect(response.body).toContain("orphan-token");
	});

	it("clears the remembered SBSD script when the client closes", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 200,
				body: '<!doctype html><script src="/.well-known/sbsd?v=before-close"></script>',
				headers: { "set-cookie": "sbsd_o=before-close-state; Path=/; Secure" },
				url: "https://example.com/bootstrap",
			},
			{
				status: 429,
				body: '{"cpr_chlge":"true","t":"after-close-token"}',
				headers: { "set-cookie": "sbsd_o=after-close-state; Path=/; Secure" },
				url: "https://example.com/apis/bff/after-close",
			},
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: { akamaiSbsd: { allowedHosts: ["example.com"] } },
			},
		});

		const bootstrap = await client.fetch("/bootstrap");
		expect(bootstrap.challenge).toBeUndefined();
		client.close?.();
		const afterClose = await client.fetch("/apis/bff/after-close", {
			throwOnHttpError: false,
		});

		expect(afterClose.status).toBe(429);
		expect(afterClose.challenge).toBeUndefined();
		expect(afterClose.body).toContain("after-close-token");
	});

	it("solves once on the initiating jar and proxy, then judges success only from one GET refetch", async () => {
		queueHardSbsdSolve({
			status: 200,
			body: "protected fixture",
			headers: {},
			url: "https://example.com/protected",
		});
		const resolutions: unknown[] = [];
		let solves = 0;
		const { createHypersolutionsResolverVendorAdapter } = await import(
			"../runtime/resolver-vendors/hypersolutions.js"
		);
		const adapter = createHypersolutionsResolverVendorAdapter({
			apiKey: "fixture-hyper-key",
			allowedHosts: ["example.com"],
		});
		const { NODEMAVEN_PASSWORD_ENV, NODEMAVEN_USERNAME_ENV } = await import(
			"../runtime/proxy-nodemaven.js"
		);
		const { createStealthClient } = await import("../runtime/stealth.js");
		const response = await createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					providers: ["nodemaven"],
					session: { affinity: "connection" },
				},
			},
			affinityKey: "fixture-lease-id",
			engineCredentials: {
				[NODEMAVEN_USERNAME_ENV]: "fixture-account",
				[NODEMAVEN_PASSWORD_ENV]: "fixture-password",
			},
			telemetry: {
				recordProxyResolution: (event) => resolutions.push(event),
			},
			stealth: {
				browser: "safari",
				os: "macos",
				acceptLanguage: "ja-JP,ja;q=0.9",
				challengeRuntime: {
					akamaiSbsd: {
						allowedHosts: ["example.com"],
						clientProfile: "safari17_0",
						async solve(challenge, transport, _clientProfile, signal) {
							solves += 1;
							expect(_clientProfile).toBe("safari_17.0");
							expect(transport.getCookie?.("sbsd_o", challenge.pageUrl)).toBe("initial-state");
							expect(transport.sessionHeaders?.["Accept-Language"]).toBe("ja-JP,ja;q=0.9");
							return adapter.solve(challenge, undefined, signal, undefined, transport);
						},
					},
				},
			},
		}).fetch("/protected");

		expect(response).toMatchObject({ status: 200, body: "protected fixture" });
		expect(response.challenge).toBeUndefined();
		expect(solves).toBe(1);
		expect(resolutions).toHaveLength(1);
		const proxies = new Set(
			mockStealthState.clients.map((client) => String(client.options?.proxy)),
		);
		expect(proxies.size).toBe(1);
		expect([...proxies][0]).toContain("fixture-account-");
		expect(
			allWreqCalls().filter((call) => call.url === "https://example.com/protected"),
		).toHaveLength(2);
		expect(requestHeader(allWreqCalls().at(-1)?.init, "cookie")).toContain("sbsd_o=updated-state");
	});

	it("returns challenge_persisted after one solve and exactly one refetch", async () => {
		queueHardSbsdSolve({
			status: 403,
			body: sbsdInterstitial("/.well-known/sbsd?v=second-uuid&t=second-token"),
			headers: {},
			url: "https://example.com/protected",
		});
		let solves = 0;
		const { createHypersolutionsResolverVendorAdapter } = await import(
			"../runtime/resolver-vendors/hypersolutions.js"
		);
		const adapter = createHypersolutionsResolverVendorAdapter({
			apiKey: "fixture-hyper-key",
			allowedHosts: ["example.com"],
		});
		const { createStealthClient } = await import("../runtime/stealth.js");
		const response = await createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: {
					akamaiSbsd: {
						allowedHosts: ["example.com"],
						async solve(challenge, transport, _clientProfile, signal) {
							solves += 1;
							return adapter.solve(challenge, undefined, signal, undefined, transport);
						},
					},
				},
			},
		}).fetch("/protected");

		expect(response.challenge?.outcome).toBe("challenge_persisted");
		expect(response.body).toContain("second-uuid");
		expect(solves).toBe(1);
		expect(
			allWreqCalls().filter((call) => call.url === "https://example.com/protected"),
		).toHaveLength(2);
	});

	it("coalesces concurrent challenges on one session into one solve and two refetches", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=shared-uuid&t=shared-token"),
				headers: { "set-cookie": "sbsd_o=shared-state; Path=/; Secure" },
				url: "https://example.com/first",
			},
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=shared-uuid&t=shared-token"),
				headers: {},
				url: "https://example.com/second",
			},
			{ status: 200, body: "first solved", headers: {}, url: "https://example.com/first" },
			{ status: 200, body: "second solved", headers: {}, url: "https://example.com/second" },
		);
		let releaseSolve!: () => void;
		let markSolveStarted!: () => void;
		const solveStarted = new Promise<void>((resolve) => {
			markSolveStarted = resolve;
		});
		const solveReleased = new Promise<void>((resolve) => {
			releaseSolve = resolve;
		});
		let solves = 0;
		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: {
					akamaiSbsd: {
						allowedHosts: ["example.com"],
						async solve() {
							solves += 1;
							markSolveStarted();
							await solveReleased;
							return {
								form: "cookies",
								kind: "akamai_sbsd",
								outcome: "payload_accepted_cookies_updated",
								verified: false,
								stateCookieName: "sbsd_o",
							} as const;
						},
					},
				},
			},
		}).createSession();

		const first = session.fetch("/first");
		await solveStarted;
		const second = session.fetch("/second");
		while (allWreqCalls().filter((call) => /\/(?:first|second)$/u.test(call.url)).length < 2) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		releaseSolve();
		const responses = await Promise.all([first, second]);

		expect(solves).toBe(1);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		expect(responses.every((response) => response.challenge === undefined)).toBe(true);
		expect(allWreqCalls()).toHaveLength(4);
	});

	it("shares a failed in-flight solve without hanging the owner or its waiter", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=failed-epoch&t=shared-token"),
				headers: { "set-cookie": "sbsd_o=shared-failure; Path=/; Secure" },
				url: "https://example.com/failure-owner",
			},
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=failed-epoch&t=shared-token"),
				headers: {},
				url: "https://example.com/failure-waiter",
			},
		);
		let releaseFailure!: () => void;
		let markSolveStarted!: () => void;
		const solveStarted = new Promise<void>((resolve) => {
			markSolveStarted = resolve;
		});
		const failureReleased = new Promise<void>((resolve) => {
			releaseFailure = resolve;
		});
		let solves = 0;
		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: {
					akamaiSbsd: {
						allowedHosts: ["example.com"],
						async solve() {
							solves += 1;
							markSolveStarted();
							await failureReleased;
							throw new SDKError("fixture shared solve failure", {
								code: "FIXTURE_SHARED_SOLVE_FAILED",
							});
						},
					},
				},
			},
		}).createSession();

		const owner = session.fetch("/failure-owner");
		await solveStarted;
		const waiter = session.fetch("/failure-waiter");
		while (allWreqCalls().length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
		releaseFailure();
		const [ownerOutcome, waiterOutcome] = await Promise.allSettled([owner, waiter]);

		expect(solves).toBe(1);
		expect(ownerOutcome.status).toBe("rejected");
		if (ownerOutcome.status !== "rejected") throw new Error("owner must reject");
		expect(ownerOutcome.reason).toMatchObject({ code: "FIXTURE_SHARED_SOLVE_FAILED" });
		expect(waiterOutcome.status).toBe("fulfilled");
		if (waiterOutcome.status !== "fulfilled") throw new Error("waiter must resolve");
		expect(waiterOutcome.value.challenge?.outcome).toBe("challenge_persisted");
		expect(allWreqCalls()).toHaveLength(2);
	});

	it("starts a new solve epoch after a failed solve settles", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=retry-epoch&t=same-token"),
				headers: { "set-cookie": "sbsd_o=first-epoch; Path=/; Secure" },
				url: "https://example.com/retry-epoch",
			},
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=retry-epoch&t=same-token"),
				headers: {},
				url: "https://example.com/retry-epoch",
			},
			{ status: 200, body: "recovered", headers: {}, url: "https://example.com/retry-epoch" },
		);
		let solves = 0;
		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: {
					akamaiSbsd: {
						allowedHosts: ["example.com"],
						async solve() {
							solves += 1;
							if (solves === 1) {
								throw new SDKError("fixture first epoch failure", {
									code: "FIXTURE_FIRST_EPOCH_FAILED",
								});
							}
							return fixtureSbsdCookieSolution();
						},
					},
				},
			},
		}).createSession();

		await expect(session.fetch("/retry-epoch")).rejects.toMatchObject({
			code: "FIXTURE_FIRST_EPOCH_FAILED",
		});
		const recovered = await session.fetch("/retry-epoch");

		expect(recovered).toMatchObject({ status: 200, body: "recovered" });
		expect(recovered.challenge).toBeUndefined();
		expect(solves).toBe(2);
		expect(allWreqCalls()).toHaveLength(3);
	});

	it("keeps a newer in-flight transaction when an older challenge key settles", async () => {
		let markWaiterBodyRead!: () => void;
		let releaseWaiterBody!: () => void;
		const waiterBodyRead = new Promise<void>((resolve) => {
			markWaiterBodyRead = resolve;
		});
		const waiterBodyReleased = new Promise<void>((resolve) => {
			releaseWaiterBody = resolve;
		});
		mockStealthState.queuedResponses.push(
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=overlap-a&t=token-a"),
				headers: { "set-cookie": "sbsd_o=overlap-a; Path=/; Secure" },
				url: "https://example.com/overlap-a",
			},
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=overlap-b&t=token-b"),
				headers: { "set-cookie": "sbsd_o=overlap-b; Path=/; Secure" },
				url: "https://example.com/overlap-b-owner",
			},
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=overlap-b&t=token-b"),
				headers: {},
				url: "https://example.com/overlap-b-waiter",
				beforeArrayBuffer: async () => {
					markWaiterBodyRead();
					await waiterBodyReleased;
				},
			},
			{
				status: 200,
				body: "overlap b owner solved",
				headers: {},
				url: "https://example.com/overlap-b-owner",
			},
			{
				status: 200,
				body: "overlap b waiter solved",
				headers: {},
				url: "https://example.com/overlap-b-waiter",
			},
		);
		let markAStarted!: () => void;
		let markBStarted!: () => void;
		let releaseA!: () => void;
		let releaseB!: () => void;
		const aStarted = new Promise<void>((resolve) => {
			markAStarted = resolve;
		});
		const bStarted = new Promise<void>((resolve) => {
			markBStarted = resolve;
		});
		const aReleased = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const bReleased = new Promise<void>((resolve) => {
			releaseB = resolve;
		});
		let solves = 0;
		const { createStealthClient } = await import("../runtime/stealth.js");
		const session = createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: {
					akamaiSbsd: {
						allowedHosts: ["example.com"],
						async solve(challenge) {
							solves += 1;
							const version = new URL(challenge.scriptUrl).searchParams.get("v");
							if (version === "overlap-a") {
								markAStarted();
								await aReleased;
								throw new SDKError("fixture overlap A failure", {
									code: "FIXTURE_OVERLAP_A_FAILED",
								});
							}
							markBStarted();
							await bReleased;
							return fixtureSbsdCookieSolution();
						},
					},
				},
			},
		}).createSession();

		const requestA = session.fetch("/overlap-a");
		await aStarted;
		const requestBOwner = session.fetch("/overlap-b-owner");
		await bStarted;
		releaseA();
		await expect(requestA).rejects.toMatchObject({ code: "FIXTURE_OVERLAP_A_FAILED" });

		const requestBWaiter = session.fetch("/overlap-b-waiter");
		await waiterBodyRead;
		releaseWaiterBody();
		for (let pendingStep = 0; pendingStep < 10; pendingStep += 1) await Promise.resolve();
		expect(solves).toBe(2);

		releaseB();
		const responses = await Promise.all([requestBOwner, requestBWaiter]);
		expect(solves).toBe(2);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		expect(responses.every((response) => response.challenge === undefined)).toBe(true);
		expect(allWreqCalls()).toHaveLength(5);
	});

	it("does not coalesce concurrent challenges across different sessions", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=session-local&t=shared-token"),
				headers: { "set-cookie": "sbsd_o=session-a; Path=/; Secure" },
				url: "https://example.com/session-a",
			},
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=session-local&t=shared-token"),
				headers: { "set-cookie": "sbsd_o=session-b; Path=/; Secure" },
				url: "https://example.com/session-b",
			},
			{ status: 200, body: "session a solved", headers: {}, url: "https://example.com/session-a" },
			{ status: 200, body: "session b solved", headers: {}, url: "https://example.com/session-b" },
		);
		let releaseSolves!: () => void;
		let markBothStarted!: () => void;
		const bothStarted = new Promise<void>((resolve) => {
			markBothStarted = resolve;
		});
		const solvesReleased = new Promise<void>((resolve) => {
			releaseSolves = resolve;
		});
		let solves = 0;
		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: {
					akamaiSbsd: {
						allowedHosts: ["example.com"],
						async solve() {
							solves += 1;
							if (solves === 2) markBothStarted();
							await solvesReleased;
							return fixtureSbsdCookieSolution();
						},
					},
				},
			},
		});
		const sessionA = client.createSession();
		const sessionB = client.createSession();

		const requests = [sessionA.fetch("/session-a"), sessionB.fetch("/session-b")];
		await bothStarted;
		releaseSolves();
		const responses = await Promise.all(requests);

		expect(solves).toBe(2);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		expect(responses.every((response) => response.challenge === undefined)).toBe(true);
		expect(allWreqCalls()).toHaveLength(4);
	});

	it("automatically solves and refetches a plain HEAD", async () => {
		mockStealthState.queuedResponses.push(
			{
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=head-uuid&t=head-token"),
				headers: { "set-cookie": "sbsd_o=head-state; Path=/; Secure" },
				url: "https://example.com/head",
			},
			{ status: 204, body: "", headers: {}, url: "https://example.com/head" },
		);
		let solves = 0;
		const { createStealthClient } = await import("../runtime/stealth.js");
		const response = await createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: {
					akamaiSbsd: {
						allowedHosts: ["example.com"],
						async solve() {
							solves += 1;
							return {
								form: "cookies",
								kind: "akamai_sbsd",
								outcome: "payload_accepted_cookies_updated",
								verified: false,
								stateCookieName: "sbsd_o",
							} as const;
						},
					},
				},
			},
		}).fetch("/head", { method: "HEAD" });

		expect(response.status).toBe(204);
		expect(response.challenge).toBeUndefined();
		expect(solves).toBe(1);
		expect(allWreqCalls()).toHaveLength(2);
	});

	const unsafeSbsdRequests: Array<{ name: string; options: StealthFetchOptions }> = [
		{ name: "POST without a body", options: { method: "POST" } },
		{ name: "POST with a body", options: { method: "POST", body: '{"fixture":true}' } },
		{ name: "PUT", options: { method: "PUT" } },
		{ name: "DELETE", options: { method: "DELETE" } },
		{ name: "GET with a body", options: { method: "GET", body: "fixture body" } },
		{
			name: "GET with Authorization",
			options: { method: "GET", headers: { Authorization: "Bearer fixture" } },
		},
		{
			name: "GET with a caller Cookie",
			options: { method: "GET", headers: { Cookie: "session=fixture" } },
		},
	];

	it.each(
		unsafeSbsdRequests,
	)("returns replay_required without solving or refetching a $name", async ({ options }) => {
		mockStealthState.queuedResponses.push({
			status: 403,
			body: sbsdInterstitial("/.well-known/sbsd?v=unsafe-uuid&t=unsafe-token"),
			headers: { "set-cookie": "sbsd_o=unsafe-state; Path=/; Secure" },
			url: "https://example.com/protected",
		});
		let solves = 0;
		const { createStealthClient } = await import("../runtime/stealth.js");
		const response = await createStealthClient("https://example.com", {
			stealth: {
				challengeRuntime: {
					akamaiSbsd: {
						allowedHosts: ["example.com"],
						async solve() {
							solves += 1;
							throw new Error("unsafe solve must not run");
						},
					},
				},
			},
		}).fetch("/protected", options);

		expect(response.challenge?.outcome).toBe("replay_required");
		expect(solves).toBe(0);
		expect(allWreqCalls()).toHaveLength(1);
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
		stealth: { browser: "chrome", os: "macos" },
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

function createSbsdWiringProvider(): ProviderDefinition {
	return createProviderDefinitionDouble({
		id: "stealth-sbsd-wiring-provider",
		allowedHosts: ["example.com"],
		stealth: { browser: "safari", os: "macos" },
		proxy: {
			mode: "required",
			providers: ["nodemaven"],
			session: { affinity: "connection" },
		},
		resolver: {
			vendors: ["hypersolutions"],
			kinds: ["akamai_sbsd"],
			clientProfile: "safari17_0",
		},
		auth: {
			mode: "credentials",
			flow: {
				start: async (ctx) => {
					const response = await ctx.stealth.fetch("/auth-protected");
					return {
						kind: "message",
						turnId: "sbsd-auth",
						data: { status: response.status, outcome: response.challenge?.outcome ?? "solved" },
					};
				},
				continue: async () => ({ kind: "abort", turnId: "unused" }),
			},
		},
		operations: {
			sbsd: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ status: z.number(), outcome: z.string() }),
				upstream: { baseUrl: "https://example.com" },
				handler: async (ctx) => {
					const response = await ctx.stealth.fetch("/operation-protected");
					return { status: response.status, outcome: response.challenge?.outcome ?? "solved" };
				},
			},
		},
	});
}

function createSbsdFailureCodeProvider(
	id: string,
	stealth: NonNullable<ProviderDefinition["stealth"]>,
): ProviderDefinition {
	return createProviderDefinitionDouble({
		id,
		allowedHosts: ["example.com"],
		stealth,
		resolver: {
			vendors: ["hypersolutions"],
			kinds: ["akamai_sbsd"],
			clientProfile: "safari17_0",
		},
		operations: {
			probe: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ code: z.string() }),
				upstream: { baseUrl: "https://example.com" },
				handler: async (ctx) => {
					try {
						await ctx.stealth.fetch("/profile-probe");
						return { code: "missing_error" };
					} catch (error) {
						return {
							code: error instanceof ProviderError ? (error.code ?? "missing_code") : "not_typed",
						};
					}
				},
			},
		},
	});
}

describe("server SBSD bound-transport wiring", () => {
	beforeEach(() => {
		mockStealthState.clients.length = 0;
		mockStealthState.queuedResponses.length = 0;
		mockStealthState.queuedErrors.length = 0;
		mockStealthState.queuedCloseErrors.length = 0;
	});

	it("returns detection-only classification for a provider without a resolver", async () => {
		mockStealthState.queuedResponses.push({
			status: 403,
			body: sbsdInterstitial("/.well-known/sbsd?v=report-only&t=fixture-token"),
			headers: { "set-cookie": "sbsd_o=report-only-secret; Path=/; Secure" },
			url: "https://example.com/report-only",
		});
		const provider = createProviderDefinitionDouble({
			id: "stealth-sbsd-report-only",
			allowedHosts: ["example.com"],
			stealth: {
				browser: "safari",
				os: "macos",
				challengeDetection: { akamaiSbsd: true },
			},
			operations: {
				report: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({ body: z.string(), outcome: z.string() }),
					upstream: { baseUrl: "https://example.com" },
					handler: async (ctx) => {
						const response = await ctx.stealth.fetch("/report-only");
						return {
							body: response.body,
							outcome: response.challenge?.outcome ?? "missing",
						};
					},
				},
			},
		});
		const { createServerAppAsync } = await import("../server/serve.js");
		const app = await createServerAppAsync(provider, { logger: () => undefined });
		const response = await app.request("/v1/report", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req-sbsd-report", input: {} }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				body: sbsdInterstitial("/.well-known/sbsd?v=report-only&t=fixture-token"),
				outcome: "resolver_unavailable",
			},
		});
		expect(allWreqCalls()).toHaveLength(1);
	});

	it("does not inspect SBSD responses when neither resolver nor detection flag is declared", async () => {
		const interstitial = sbsdInterstitial("/.well-known/sbsd?v=ignored&t=ignored-token");
		mockStealthState.queuedResponses.push({
			status: 403,
			body: interstitial,
			headers: { "set-cookie": "sbsd_o=ignored-secret; Path=/; Secure" },
			url: "https://example.com/ignored",
		});
		const provider = createProviderDefinitionDouble({
			id: "stealth-sbsd-not-declared",
			allowedHosts: ["example.com"],
			stealth: { browser: "safari", os: "macos" },
			operations: {
				probe: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({ body: z.string(), classified: z.boolean() }),
					upstream: { baseUrl: "https://example.com" },
					handler: async (ctx) => {
						const response = await ctx.stealth.fetch("/ignored", {
							throwOnHttpError: false,
						});
						return { body: response.body, classified: response.challenge !== undefined };
					},
				},
			},
		});
		const { createServerAppAsync } = await import("../server/serve.js");
		const app = await createServerAppAsync(provider, { logger: () => undefined });
		const response = await app.request("/v1/probe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req-sbsd-not-declared", input: {} }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: { body: interstitial, classified: false },
		});
		expect(allWreqCalls()).toHaveLength(1);
	});

	it("rejects a resolver client profile that does not match the initiating session", async () => {
		mockStealthState.queuedResponses.push({
			status: 403,
			body: sbsdInterstitial("/.well-known/sbsd?v=mismatch&t=mismatch-token"),
			headers: { "set-cookie": "sbsd_o=mismatch-state; Path=/; Secure" },
			url: "https://example.com/profile-probe",
		});
		const provider = createSbsdFailureCodeProvider("stealth-sbsd-profile-mismatch", {
			browser: "chrome",
			os: "macos",
		});
		const { createServerAppAsync } = await import("../server/serve.js");
		const app = await createServerAppAsync(provider, { logger: () => undefined });
		const response = await app.request("/v1/probe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req-sbsd-profile-mismatch", input: {} }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: { code: "RESOLVER_CLIENT_PROFILE_MISMATCH" },
		});
		expect(allWreqCalls()).toHaveLength(1);
	});

	it("snapshots a valid hooked vendor array before running on the initiating session transport", async () => {
		const { APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY } = await import(
			"../runtime/resolver-config.js"
		);
		const { NODEMAVEN_PASSWORD_ENV, NODEMAVEN_USERNAME_ENV } = await import(
			"../runtime/proxy-nodemaven.js"
		);
		const previous = new Map(
			[
				APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY,
				NODEMAVEN_USERNAME_ENV,
				NODEMAVEN_PASSWORD_ENV,
			].map(
				(name) => [name, process.env[name]] as const,
			),
		);
		process.env[APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY] =
			"fixture-selection-hyper-key";
		process.env[NODEMAVEN_USERNAME_ENV] = "fixture-override-account";
		process.env[NODEMAVEN_PASSWORD_ENV] = "fixture-override-password";
		queueHardSbsdSolve(
			{
				status: 200,
				body: "override protected",
				headers: {},
				url: "https://example.com/operation-protected",
			},
			"https://example.com/operation-protected",
		);
		let overrideCalls = 0;
		let suppliedArrayMapCalls = 0;
		let suppliedArrayIteratorCalls = 0;
		let downstreamReceivedSuppliedArray = false;
		const suppliedVendors = ["hypersolutions"] as const;
		Object.defineProperty(suppliedVendors, "map", {
			value: function () {
				suppliedArrayMapCalls += 1;
				downstreamReceivedSuppliedArray = this === suppliedVendors;
				return [];
			},
		});
		Object.defineProperty(suppliedVendors, Symbol.iterator, {
			value: () => {
				suppliedArrayIteratorCalls += 1;
				return [][Symbol.iterator]();
			},
		});
		const resolverOverride: AutoSolveResolverFactory = ({ clientProfile }) => {
			overrideCalls += 1;
			expect(clientProfile).toMatchObject({ browser: "safari", os: "macos" });
			return { vendors: suppliedVendors };
		};
		try {
			const { createServerAppAsync } = await import("../server/serve.js");
			const app = await createServerAppAsync(createSbsdWiringProvider(), {
				logger: () => undefined,
				resolver: resolverOverride,
			});
			const response = await app.request("/v1/sbsd", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req-sbsd-bound-override",
					connectionId: "connection-sbsd-override",
					input: {},
				}),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ data: { status: 200, outcome: "solved" } });
			expect(overrideCalls).toBe(1);
			expect(suppliedArrayMapCalls).toBe(0);
			expect(suppliedArrayIteratorCalls).toBe(0);
			expect(downstreamReceivedSuppliedArray).toBeFalse();
			expect(mockStealthState.clients).toHaveLength(1);
			expect(String(mockStealthState.clients[0]?.options?.proxy)).toContain(
				"fixture-override-account-",
			);
			expect(
				allWreqCalls().filter((call) => call.url === "https://example.com/operation-protected"),
			).toHaveLength(2);
			expect(requestHeader(allWreqCalls().at(-1)?.init, "cookie")).toContain(
				"sbsd_o=updated-state",
			);
		} finally {
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("rejects a resolver instance on the automatic solve path", async () => {
		let overrideCalls = 0;
		const resolverOverride: ResolverContext = {
			async solve() {
				overrideCalls += 1;
				return { form: "token", token: "must-not-run" } as const;
			},
		};
		const { createServerAppAsync } = await import("../server/serve.js");
		mockStealthState.queuedResponses.push({
			status: 403,
			body: sbsdInterstitial("/.well-known/sbsd?v=override&t=override-token"),
			headers: { "set-cookie": "sbsd_o=override-state; Path=/; Secure" },
			url: "https://example.com/profile-probe",
		});
		const provider = createSbsdFailureCodeProvider("stealth-sbsd-resolver-instance-rejected", {
			browser: "safari",
			os: "macos",
		});
		const app = await createServerAppAsync(provider, {
			logger: () => undefined,
			resolver: resolverOverride,
		});
		const response = await app.request("/v1/probe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req-sbsd-resolver-instance", input: {} }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: { code: "RESOLVER_BOUND_TRANSPORT_REQUIRED" },
		});
		expect(overrideCalls).toBe(0);
		expect(allWreqCalls()).toHaveLength(1);
	});

	it("rejects an old factory that could call and discard a supplied transport", async () => {
		let overrideCalls = 0;
		let discardedTransportCalls = 0;
		const oldResolverFactory = (bound: {
			readonly clientProfile: unknown;
			readonly createTransport: () => unknown;
		}) => {
			bound.createTransport();
			return {
				async solve() {
					overrideCalls += 1;
					return { form: "token", token: "must-not-run" } as const;
				},
			};
		};
		// @ts-expect-error test-invalid: the retired factory received transport construction and returned a resolver.
		const oldFactoryTypeCheck: AutoSolveResolverFactory = oldResolverFactory;
		void oldFactoryTypeCheck;
		const castAroundOldFactory = () =>
			oldResolverFactory({
				clientProfile: { browser: "safari", os: "macos" },
				createTransport: () => {
					discardedTransportCalls += 1;
					return {};
				},
			});
		// @ts-expect-error test-invalid: runtime validation must reject a cast-around resolver return.
		const resolverOverride: AutoSolveResolverFactory = castAroundOldFactory;
		mockStealthState.queuedResponses.push({
			status: 403,
			body: sbsdInterstitial("/.well-known/sbsd?v=ignored&t=ignored-token"),
			headers: { "set-cookie": "sbsd_o=ignored-state; Path=/; Secure" },
			url: "https://example.com/profile-probe",
		});
		const provider = createSbsdFailureCodeProvider("stealth-sbsd-old-factory-rejected", {
			browser: "safari",
			os: "macos",
		});
		const { createServerAppAsync } = await import("../server/serve.js");
		const app = await createServerAppAsync(provider, {
			logger: () => undefined,
			resolver: resolverOverride,
		});
		const response = await app.request("/v1/probe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req-sbsd-old-factory-rejected", input: {} }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: { code: "RESOLVER_BOUND_TRANSPORT_REQUIRED" },
		});
		expect(overrideCalls).toBe(0);
		expect(discardedTransportCalls).toBe(1);
		expect(allWreqCalls()).toHaveLength(1);
		expect(mockStealthState.clients).toHaveLength(1);
	});

	it("rejects automatic resolver selections containing transport ownership keys", async () => {
		let transportCalls = 0;
		const createTransportTypeCheck = {
			vendors: ["hypersolutions"],
			// @ts-expect-error test-invalid: transport construction is always SDK-owned.
			createTransport() {
				return {};
			},
		} satisfies AutoSolveResolverSelection;
		const transportTypeCheck = {
			vendors: ["hypersolutions"],
			// @ts-expect-error test-invalid: a caller-owned transport is never selectable.
			transport: {},
		} satisfies AutoSolveResolverSelection;
		const structurallyWiderTransportSelection = {
			vendors: ["hypersolutions"] as const,
			transport: {},
		};
		const structurallyWiderFactorySelection = {
			vendors: ["hypersolutions"] as const,
			createTransport() {
				return {};
			},
		};
		// @ts-expect-error test-invalid: exact exclusion also rejects structurally wider variables.
		const structuralTransportTypeCheck: AutoSolveResolverSelection =
			structurallyWiderTransportSelection;
		// @ts-expect-error test-invalid: exact exclusion also rejects structurally wider variables.
		const structuralFactoryTypeCheck: AutoSolveResolverSelection =
			structurallyWiderFactorySelection;
		void createTransportTypeCheck;
		void transportTypeCheck;
		void structuralTransportTypeCheck;
		void structuralFactoryTypeCheck;
		const invalidSelections = [
			{
				vendors: ["hypersolutions"] as const,
				transport: {},
			},
			{
				vendors: ["hypersolutions"] as const,
				createTransport() {
					transportCalls += 1;
					return {};
				},
			},
		];
		const { createServerAppAsync } = await import("../server/serve.js");
		for (const [index, invalidSelection] of invalidSelections.entries()) {
			mockStealthState.queuedResponses.push({
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=selection&t=selection-token"),
				headers: { "set-cookie": "sbsd_o=selection-state; Path=/; Secure" },
				url: "https://example.com/profile-probe",
			});
			const provider = createSbsdFailureCodeProvider(
				`stealth-sbsd-selection-transport-rejected-${index}`,
				{ browser: "safari", os: "macos" },
			);
			const invalidFactory = () => invalidSelection;
			// @ts-expect-error test-invalid: runtime validation rejects transport-owning selections.
			const resolverOverride: AutoSolveResolverFactory = invalidFactory;
			const app = await createServerAppAsync(provider, {
				logger: () => undefined,
				resolver: resolverOverride,
			});
			const response = await app.request("/v1/probe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: `req-sbsd-selection-transport-${index}`, input: {} }),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				data: { code: "RESOLVER_BOUND_TRANSPORT_REQUIRED" },
			});
		}
		expect(transportCalls).toBe(0);
		expect(allWreqCalls()).toHaveLength(2);
	});

	it("rejects a hooked vendors container before it can inject a closure-owned adapter", async () => {
		let containerMapCalls = 0;
		let containerIteratorCalls = 0;
		let injectedAdapterCalls = 0;
		let closureTransportCalls = 0;
		const hookedVendors = {
			length: 1,
			0: "hypersolutions",
			map() {
				containerMapCalls += 1;
				return [
					{
						id: "hypersolutions",
						supports: () => true,
						createAdapter: () => {
							injectedAdapterCalls += 1;
							return {
								id: "injected",
								requiresTransport: false,
								supports: () => true,
								async solve() {
									closureTransportCalls += 1;
									return fixtureSbsdCookieSolution();
								},
							};
						},
					},
				];
			},
			[Symbol.iterator]() {
				containerIteratorCalls += 1;
				return ["hypersolutions"][Symbol.iterator]();
			},
		};
		const hookedFactory = () => ({ vendors: hookedVendors });
		// @ts-expect-error test-invalid: a vendors container must be a primitive-name array.
		const resolverOverride: AutoSolveResolverFactory = hookedFactory;
		mockStealthState.queuedResponses.push({
			status: 403,
			body: sbsdInterstitial("/.well-known/sbsd?v=hooked&t=hooked-token"),
			headers: { "set-cookie": "sbsd_o=hooked-state; Path=/; Secure" },
			url: "https://example.com/profile-probe",
		});
		const { createServerAppAsync } = await import("../server/serve.js");
		const app = await createServerAppAsync(
			createSbsdFailureCodeProvider("stealth-sbsd-hooked-vendors-rejected", {
				browser: "safari",
				os: "macos",
			}),
			{ logger: () => undefined, resolver: resolverOverride },
		);
		const response = await app.request("/v1/probe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req-sbsd-hooked-vendors", input: {} }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: { code: "RESOLVER_BOUND_TRANSPORT_REQUIRED" },
		});
		expect(containerMapCalls).toBe(0);
		expect(containerIteratorCalls).toBe(0);
		expect([injectedAdapterCalls, closureTransportCalls]).toEqual([0, 0]);
		expect(allWreqCalls()).toHaveLength(1);
	});

	it("rejects malformed automatic resolver vendor selections", async () => {
		const invalidSelections: readonly unknown[] = [
			{ vendors: "hypersolutions" },
			{ vendors: [42] },
			{ vendors: ["foreign-vendor"] },
			{ vendors: Array(1) },
			{ vendors: ["hypersolutions", "hypersolutions"] },
		];
		const { createServerAppAsync } = await import("../server/serve.js");
		for (const [index, invalidSelection] of invalidSelections.entries()) {
			mockStealthState.queuedResponses.push({
				status: 403,
				body: sbsdInterstitial("/.well-known/sbsd?v=invalid&t=invalid-token"),
				headers: { "set-cookie": "sbsd_o=invalid-state; Path=/; Secure" },
				url: "https://example.com/profile-probe",
			});
			const invalidFactory = () => invalidSelection;
			// @ts-expect-error test-invalid: runtime validation covers JavaScript/cast callers.
			const resolverOverride: AutoSolveResolverFactory = invalidFactory;
			const app = await createServerAppAsync(
				createSbsdFailureCodeProvider(`stealth-sbsd-invalid-vendors-${index}`, {
					browser: "safari",
					os: "macos",
				}),
				{ logger: () => undefined, resolver: resolverOverride },
			);
			const response = await app.request("/v1/probe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: `req-sbsd-invalid-vendors-${index}`, input: {} }),
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				data: { code: "RESOLVER_BOUND_TRANSPORT_REQUIRED" },
			});
		}
		expect(allWreqCalls()).toHaveLength(invalidSelections.length);
	});

	it("supplies the bound transport in operation and auth FlowContext assembly", async () => {
		const { APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY } = await import(
			"../runtime/resolver-config.js"
		);
		const { NODEMAVEN_PASSWORD_ENV, NODEMAVEN_USERNAME_ENV } = await import(
			"../runtime/proxy-nodemaven.js"
		);
		const previous = new Map(
			[
				APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY,
				NODEMAVEN_USERNAME_ENV,
				NODEMAVEN_PASSWORD_ENV,
			].map((name) => [name, process.env[name]] as const),
		);
		process.env[APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY] = "fixture-hyper-key";
		process.env[NODEMAVEN_USERNAME_ENV] = "fixture-server-account";
		process.env[NODEMAVEN_PASSWORD_ENV] = "fixture-server-password";
		try {
			const { createServerAppAsync } = await import("../server/serve.js");
			const app = await createServerAppAsync(createSbsdWiringProvider(), {
				logger: () => undefined,
			});
			queueHardSbsdSolve(
				{
					status: 200,
					body: "operation protected",
					headers: {},
					url: "https://example.com/operation-protected",
				},
				"https://example.com/operation-protected",
			);
			const operation = await app.request("/v1/sbsd", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req-sbsd-operation",
					connectionId: "connection-sbsd",
					input: {},
				}),
			});
			expect(operation.status).toBe(200);
			expect(await operation.json()).toEqual({ data: { status: 200, outcome: "solved" } });

			queueHardSbsdSolve(
				{
					status: 200,
					body: "auth protected",
					headers: {},
					url: "https://example.com/auth-protected",
				},
				"https://example.com/auth-protected",
			);
			const auth = await app.request("/auth/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req-sbsd-auth",
					flowId: "flow-sbsd",
					providerId: "stealth-sbsd-wiring-provider",
					connectionId: "connection-sbsd",
					context: {},
				}),
			});
			expect(auth.status).toBe(200);
			expect(await auth.json()).toMatchObject({
				data: { data: { status: 200, outcome: "solved" } },
			});
			expect(
				allWreqCalls().filter((call) =>
					/https:\/\/example\.com\/(?:operation|auth)-protected/u.test(call.url),
				),
			).toHaveLength(4);
			expect(
				mockStealthState.clients.every(
					(client) => client.options?.browser === "safari_17.0" && client.options?.os === "macos",
				),
			).toBe(true);
		} finally {
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});

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
