import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	__getProxyResolutionCacheStatsForTests,
	__setProxyRedisForTests,
	__setSmartproxyAllocatorDeadlineMsForTests,
	clearProxyResolutionCache,
	invalidateProxyResolutionCache,
	invalidateProxyResolutionCacheAsync,
	loadApiFuseConfig,
	resolveProxyConfig,
	resolveProxyConfigAsync,
	SMARTPROXY_MAX_LIFETIME_MINUTES,
} from "../config/loader";
import { TransportError } from "../errors";
import { ProxyTelemetryCollector } from "../runtime/proxy-telemetry";
import type { ProviderProxyPolicy } from "../types";
import { HttpRetryUnsafeMethodPolicy } from "../types";

type MockImpitResponse = {
	status: number;
	body: string;
	headers?: Record<string, string | string[]>;
};

type MockImpitQueuedItem = MockImpitResponse | Error;

type MockImpitCall = {
	url: string;
	options: Record<string, unknown>;
};

type MockImpitClientState = {
	calls: MockImpitCall[];
	options: Record<string, unknown> | undefined;
	closed: boolean;
};

const stealthState = {
	clients: [] as MockImpitClientState[],
	queuedResponses: [] as MockImpitQueuedItem[],
};

class FakeRedis {
	status: "ready" = "ready";
	readonly setCalls: Array<{
		key: string;
		mode?: string;
		ttlMs?: number;
		condition?: string;
	}> = [];
	private readonly values = new Map<string, string>();
	private readonly expiresAt = new Map<string, number>();
	private readonly failNextNxKeys = new Set<string>();
	private readonly failNextSetKeys = new Set<string>();
	private readonly failNextDelKeys = new Set<string>();

	failNextNxSet(key: string): void {
		this.failNextNxKeys.add(key);
	}

	failNextSet(key: string): void {
		this.failNextSetKeys.add(key);
	}

	failNextDel(key: string): void {
		this.failNextDelKeys.add(key);
	}

	async connect(): Promise<void> {
		this.status = "ready";
	}

	on(): this {
		return this;
	}

	async get(key: string): Promise<string | null> {
		this.deleteIfExpired(key);
		return this.values.get(key) ?? null;
	}

	async set(
		key: string,
		value: string,
		mode?: string,
		ttlMs?: number,
		condition?: string,
	): Promise<"OK" | null> {
		this.deleteIfExpired(key);
		this.setCalls.push({ key, mode, ttlMs, condition });
		if (this.failNextSetKeys.delete(key)) throw new Error("Injected Redis set failure");
		if (condition === "NX" && this.failNextNxKeys.delete(key)) return null;
		if (condition === "NX" && this.values.has(key)) return null;
		this.values.set(key, value);
		if (mode === "PX" && typeof ttlMs === "number") {
			this.expiresAt.set(key, Date.now() + ttlMs);
		}
		return "OK";
	}

	async del(key: string): Promise<number> {
		if (this.failNextDelKeys.delete(key)) throw new Error("Injected Redis del failure");
		const existed = this.values.delete(key);
		this.expiresAt.delete(key);
		return existed ? 1 : 0;
	}

	async pttl(key: string): Promise<number> {
		this.deleteIfExpired(key);
		const expiresAt = this.expiresAt.get(key);
		if (!this.values.has(key)) return -2;
		if (!expiresAt) return -1;
		return Math.max(0, expiresAt - Date.now());
	}

	async eval(_script: string, _keyCount: number, key: string, token: string): Promise<number> {
		if ((await this.get(key)) !== token) return 0;
		return this.del(key);
	}

	private deleteIfExpired(key: string): void {
		const expiresAt = this.expiresAt.get(key);
		if (expiresAt !== undefined && expiresAt <= Date.now()) {
			this.values.delete(key);
			this.expiresAt.delete(key);
		}
	}
}

function stealthProxyCalls(): unknown[] {
	return stealthState.clients.flatMap((client) => client.calls.map((call) => call.options.proxy));
}

const nativeFetchCalls: Array<{
	url: string;
	init?: RequestInit & { proxy?: string };
}> = [];

function nativeProxyCalls(): Array<string | undefined> {
	return nativeFetchCalls.map((call) => call.init?.proxy);
}

function queueNativeFetchResponses(...responses: MockImpitResponse[]): void {
	const queue = [...responses];
	global.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
		nativeFetchCalls.push({
			url: String(input),
			init: init as RequestInit & { proxy?: string },
		});
		const response = queue.shift();
		if (!response) throw new Error("No queued native response");
		return new Response(response.body, {
			headers: response.headers as HeadersInit,
			status: response.status,
		});
	}) as unknown as typeof fetch;
}

function queueAllocatorAndNativeResponses(
	allocatorBody: string,
	...responses: MockImpitResponse[]
): void {
	const queue = [...responses];
	global.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("get-ip-v3")) {
			return new Response(allocatorBody, { status: 200 });
		}
		nativeFetchCalls.push({
			url,
			init: init as RequestInit & { proxy?: string },
		});
		const response = queue.shift();
		if (!response) throw new Error("No queued native response");
		return new Response(response.body, {
			headers: response.headers as HeadersInit,
			status: response.status,
		});
	}) as unknown as typeof fetch;
}

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

function toImpitResponse(response: MockImpitResponse) {
	return {
		status: response.status,
		ok: response.status >= 200 && response.status < 300,
		headers: toHeaders(response.headers),
		url: "https://example.com/final",
		json: async () => JSON.parse(response.body),
		text: async () => response.body,
		arrayBuffer: async () => Buffer.from(response.body).buffer,
	};
}

class MockImpit {
	private readonly state: MockImpitClientState;

	constructor(options?: Record<string, unknown>) {
		this.state = { calls: [], options, closed: false };
		stealthState.clients.push(this.state);
	}

	async fetch(url: string, init?: Record<string, unknown>) {
		this.state.calls.push({
			url,
			options: {
				...(this.state.options ?? {}),
				...(init ?? {}),
				proxy: this.state.options?.proxyUrl,
				insecureSkipVerify: this.state.options?.ignoreTlsErrors,
			},
		});
		const response = stealthState.queuedResponses.shift();
		if (!response) throw new Error("No queued response");
		if (response instanceof Error) throw response;
		return toImpitResponse(response);
	}
}

mock.module("impit", () => ({
	Impit: MockImpit,
}));

describe("proxy integration", () => {
	let originalFetch: typeof fetch;
	let originalProxyEnv: string | undefined;
	let originalSmartproxyKey: string | undefined;
	let originalProxySessionId: string | undefined;
	let originalProxySessionDuration: string | undefined;
	let originalProxyDefaultLifetime: string | undefined;

	beforeEach(() => {
		originalFetch = global.fetch;
		originalProxyEnv = process.env.APIFUSE__PROXY__URL;
		originalSmartproxyKey = process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		originalProxySessionId = process.env.APIFUSE__PROXY__SESSION_ID;
		originalProxySessionDuration = process.env.APIFUSE__PROXY__SESSION_DURATION;
		originalProxyDefaultLifetime = process.env.APIFUSE__PROXY__DEFAULT_LIFETIME_MINUTES;
		delete process.env.APIFUSE__PROXY__URL;
		delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		delete process.env.APIFUSE__PROXY__SESSION_ID;
		delete process.env.APIFUSE__PROXY__SESSION_DURATION;
		delete process.env.APIFUSE__PROXY__DEFAULT_LIFETIME_MINUTES;
		clearProxyResolutionCache();
		stealthState.clients.length = 0;
		stealthState.queuedResponses.length = 0;
		nativeFetchCalls.length = 0;
		__setProxyRedisForTests(undefined);
		__setSmartproxyAllocatorDeadlineMsForTests(undefined);
	});

	afterEach(() => {
		global.fetch = originalFetch;
		if (originalProxyEnv) {
			process.env.APIFUSE__PROXY__URL = originalProxyEnv;
		} else {
			delete process.env.APIFUSE__PROXY__URL;
		}
		if (originalSmartproxyKey) {
			process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = originalSmartproxyKey;
		} else {
			delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		}
		if (originalProxySessionId) {
			process.env.APIFUSE__PROXY__SESSION_ID = originalProxySessionId;
		} else {
			delete process.env.APIFUSE__PROXY__SESSION_ID;
		}
		if (originalProxySessionDuration) {
			process.env.APIFUSE__PROXY__SESSION_DURATION = originalProxySessionDuration;
		} else {
			delete process.env.APIFUSE__PROXY__SESSION_DURATION;
		}
		if (originalProxyDefaultLifetime) {
			process.env.APIFUSE__PROXY__DEFAULT_LIFETIME_MINUTES = originalProxyDefaultLifetime;
		} else {
			delete process.env.APIFUSE__PROXY__DEFAULT_LIFETIME_MINUTES;
		}
		clearProxyResolutionCache();
		__setProxyRedisForTests(undefined);
		__setSmartproxyAllocatorDeadlineMsForTests(undefined);
	});

	it("encodes bounded public-safe per-attempt proxy telemetry", () => {
		const telemetry = new ProxyTelemetryCollector();
		telemetry.recordProxyResolution({
			provider: "smartproxy",
			cacheStatus: "allocator",
			cacheHit: false,
			resolutionMs: 12,
			allocatorStatus: 500,
			allocatorBodyClass: "http_error",
			allocatorAttempts: 2,
			attempts: 2,
		});
		telemetry.recordProxyAttempt({
			provider: "smartproxy",
			attempt: 1,
			poolIndex: 0,
			proxyHash: "abcdef123456",
			outcome: "error",
			errorCode: "PROXY_EDGE_AUTH_REJECTED",
			status: 512,
			durationMs: 37,
		});
		telemetry.recordProxyAttempt({
			provider: "smartproxy",
			attempt: 2,
			poolIndex: 1,
			proxyHash: "123456abcdef",
			outcome: "ok",
			status: 200,
			durationMs: 42,
		});

		const header = telemetry.toHeaderValue();
		expect(header).toBeTruthy();
		const decoded = JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"));

		expect(decoded.proxy).toMatchObject({
			allocatorStatus: 500,
			allocatorBodyClass: "http_error",
			allocatorAttempts: 2,
		});
		expect(decoded.proxy.attemptSamples).toEqual([
			{
				n: 1,
				a: 1,
				i: 0,
				h: "abcdef123456",
				o: "error",
				c: "PROXY_EDGE_AUTH_REJECTED",
				s: 512,
				d: 37,
			},
			{ n: 2, a: 2, i: 1, h: "123456abcdef", o: "ok", s: 200, d: 42 },
		]);
		expect(JSON.stringify(decoded)).not.toContain("5.78.24.25");
	});

	it("uses apifuse config proxy when upstream proxy routing is enabled", async () => {
		queueNativeFetchResponses({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient("https://example.com", {
			apifuseConfig: { proxy: { url: "https://config-proxy.example:8443" } },
			upstream: { proxy: true },
		});

		await http.get("/health");

		expect(nativeProxyCalls()).toEqual(["https://config-proxy.example:8443"]);
	});

	it("uses APIFUSE__PROXY__URL when upstream proxy routing is enabled", async () => {
		process.env.APIFUSE__PROXY__URL = "https://env-proxy.example:8443";
		queueNativeFetchResponses({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient("https://example.com", {
			upstream: { proxy: true },
		});

		await http.get("/health");

		expect(nativeProxyCalls()).toEqual(["https://env-proxy.example:8443"]);
	});

	it("passes request-level proxy through ctx.http", async () => {
		queueNativeFetchResponses({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient("https://example.com");

		await http.get("/health", { proxy: "https://request-proxy.example:8443" });

		expect(nativeProxyCalls()).toEqual(["https://request-proxy.example:8443"]);
	});

	it("warns once when proxy routing is required but missing", async () => {
		const warnings: string[] = [];
		queueNativeFetchResponses(
			{
				status: 200,
				body: JSON.stringify({ ok: true }),
				headers: { "Content-Type": "application/json" },
			},
			{
				status: 200,
				body: JSON.stringify({ ok: true }),
				headers: { "Content-Type": "application/json" },
			},
		);

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient("https://example.com", {
			upstream: { proxy: true },
			warn: (message) => {
				warnings.push(message);
			},
		});

		await http.get("/health");
		await http.get("/health");

		expect(warnings).toEqual([
			"[provider-sdk] Provider requested proxy routing, but no proxy URL was configured. Continuing without proxy.",
		]);
	});

	it("passes resolved proxy through ctx.stealth session config and request options", async () => {
		stealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			apifuseConfig: { proxy: { url: "https://stealth-proxy.example:8443" } },
			upstream: { proxy: true },
		});

		await client.fetch("/health");

		expect(stealthState.clients[0]?.calls[0]?.options).toMatchObject({
			proxy: "https://stealth-proxy.example:8443",
		});
		expect(stealthState.clients[0]?.calls[0]?.options).toMatchObject({
			proxy: "https://stealth-proxy.example:8443",
		});
	});

	it("can skip certificate verification only when proxy routing is active", async () => {
		stealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			apifuseConfig: { proxy: { url: "https://stealth-proxy.example:8443" } },
			proxyStealth: { insecureSkipVerify: true },
			upstream: { proxy: true },
		});

		await client.fetch("/health");

		expect(stealthState.clients[0]?.calls[0]?.options).toMatchObject({
			insecureSkipVerify: true,
			proxy: "https://stealth-proxy.example:8443",
		});
	});

	it("passes request-level proxy through ctx.stealth", async () => {
		stealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com");

		await client.fetch("/health", {
			proxy: "https://request-stealth-proxy.example:8443",
		});

		expect(stealthState.clients[0]?.calls[0]?.options).toMatchObject({
			proxy: "https://request-stealth-proxy.example:8443",
		});
		expect(stealthState.clients[0]?.calls[0]?.options).toMatchObject({
			proxy: "https://request-stealth-proxy.example:8443",
		});
	});

	it("resolves proxy config from env before config", () => {
		process.env.APIFUSE__PROXY__URL = "https://env-proxy.example:8443";

		expect(
			resolveProxyConfig({
				apifuseConfig: { proxy: { url: "https://config-proxy.example:8443" } },
				upstream: { proxy: true },
			}),
		).toEqual({
			shouldWarn: false,
			url: "https://env-proxy.example:8443",
		});
	});

	it("adds sticky sessions to Smartproxy-compatible proxy URLs", () => {
		process.env.APIFUSE__PROXY__URL = "http://smart-user_area-KR:secret@proxy.smartproxy.net:3120";
		process.env.APIFUSE__PROXY__SESSION_ID = "fixed-session";
		process.env.APIFUSE__PROXY__SESSION_DURATION = "90";

		expect(resolveProxyConfig({ upstream: { proxy: true } })).toEqual({
			shouldWarn: false,
			url: "http://smart-user_area-KR_session-fixed-session_life-90:secret@proxy.smartproxy.net:3120/",
		});
	});

	it("normalizes stale Smartproxy sticky session ordering", () => {
		process.env.APIFUSE__PROXY__URL =
			"http://smart-user_area-KR_life-60_session-old:secret@proxy.smartproxy.net:3120";
		process.env.APIFUSE__PROXY__SESSION_ID = "fresh-session";
		process.env.APIFUSE__PROXY__SESSION_DURATION = "90";

		expect(resolveProxyConfig({ upstream: { proxy: true } })).toEqual({
			shouldWarn: false,
			url: "http://smart-user_area-KR_session-fresh-session_life-90:secret@proxy.smartproxy.net:3120/",
		});
	});

	it("uses Smartproxy username format for regional Smartproxy hosts", () => {
		process.env.APIFUSE__PROXY__URL =
			"http://smart-user_area-KR_life-120:secret@as.smartproxy.net:3121";
		process.env.APIFUSE__PROXY__SESSION_ID = "fresh-session";
		delete process.env.APIFUSE__PROXY__SESSION_DURATION;

		expect(resolveProxyConfig({ upstream: { proxy: true } })).toEqual({
			shouldWarn: false,
			url: "http://smart-user_area-KR_session-fresh-session_life-120:secret@as.smartproxy.net:3121/",
		});
	});

	it("falls back to Smartproxy configured life when session duration env is blank", () => {
		process.env.APIFUSE__PROXY__URL =
			"http://smart-user_area-KR_life-120:secret@as.smartproxy.net:3121";
		process.env.APIFUSE__PROXY__SESSION_ID = "fresh-session";
		process.env.APIFUSE__PROXY__SESSION_DURATION = "   ";

		expect(resolveProxyConfig({ upstream: { proxy: true } })).toEqual({
			shouldWarn: false,
			url: "http://smart-user_area-KR_session-fresh-session_life-120:secret@as.smartproxy.net:3121/",
		});
	});

	it("rejects malformed sticky session duration instead of embedding it in the proxy username", () => {
		process.env.APIFUSE__PROXY__URL = "http://smart-user_area-KR:secret@proxy.smartproxy.net:3120";
		process.env.APIFUSE__PROXY__SESSION_DURATION = "abc";

		expect(() => resolveProxyConfig({ upstream: { proxy: true } })).toThrow(
			"APIFUSE__PROXY__SESSION_DURATION must be a positive integer",
		);
	});

	it("adds sticky sessions to Decodo proxy URLs", () => {
		process.env.APIFUSE__PROXY__URL = "http://smart-user_area-KR:secret@gate.decodo.com:7000";
		process.env.APIFUSE__PROXY__SESSION_ID = "fixed-session";
		process.env.APIFUSE__PROXY__SESSION_DURATION = "90";

		expect(resolveProxyConfig({ upstream: { proxy: true } })).toEqual({
			shouldWarn: false,
			url: "http://user-smart-user_area-KR-session-fixed-session-sessionduration-90:secret@gate.decodo.com:7000/",
		});
	});

	it("allocates Smartproxy raw CONNECT endpoints from provider proxy policy", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		let requestedUrl = "";
		global.fetch = (async (url) => {
			requestedUrl = String(url);
			return new Response(
				JSON.stringify({
					code: 0,
					data: { list: [{ ip: "5.78.24.25", port: 31001 }] },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const resolved = await resolveProxyConfigAsync({
			affinityKey: "af_con_123",
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: {
						affinity: "connection",
						lifetimeMinutes: SMARTPROXY_MAX_LIFETIME_MINUTES + 10,
					},
				},
			},
		});

		expect(resolved).toMatchObject({
			shouldWarn: false,
			source: "smartproxy-allocator",
			url: "http://5.78.24.25:31001",
			diagnostics: {
				provider: "smartproxy",
				country: "KR",
				lifetimeMinutes: SMARTPROXY_MAX_LIFETIME_MINUTES,
				rawConnect: true,
			},
		});
		const allocatorUrl = new URL(requestedUrl);
		expect(allocatorUrl.searchParams.get("app_key")).toBe("redacted-test-key");
		expect(allocatorUrl.searchParams.get("cc")).toBe("KR");
		expect(allocatorUrl.searchParams.get("num")).toBe("20");
		expect(allocatorUrl.searchParams.get("life")).toBe(String(SMARTPROXY_MAX_LIFETIME_MINUTES));
	});

	it("shares Smartproxy allocator results through Redis across SDK cache resets", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		__setProxyRedisForTests(new FakeRedis());
		let allocatorCalls = 0;
		global.fetch = (async () => {
			allocatorCalls += 1;
			return new Response("5.78.24.25:31001", { status: 200 });
		}) as typeof fetch;

		const policy = {
			mode: "required" as const,
			provider: "smartproxy" as const,
			geo: { country: "KR" },
			session: { affinity: "connection" as const, poolSize: 1 },
		};

		const first = await resolveProxyConfigAsync({
			affinityKey: "af_con_shared",
			upstream: { proxy: policy },
		});
		clearProxyResolutionCache();
		const second = await resolveProxyConfigAsync({
			affinityKey: "af_con_shared",
			upstream: { proxy: policy },
		});

		expect(first.url).toBe("http://5.78.24.25:31001");
		expect(second.url).toBe("http://5.78.24.25:31001");
		expect(allocatorCalls).toBe(1);
	});

	it("expires Smartproxy extraction cache independently from requested session life", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const originalNow = Date.now;
		let now = 1_700_000_000_000;
		Date.now = () => now;
		let allocatorCalls = 0;
		global.fetch = (async () => {
			allocatorCalls += 1;
			return new Response(`5.78.24.${20 + allocatorCalls}:31001`, {
				status: 200,
			});
		}) as typeof fetch;

		const policy = {
			mode: "required" as const,
			provider: "smartproxy" as const,
			geo: { country: "KR" },
			session: {
				affinity: "connection" as const,
				lifetimeMinutes: 120,
				poolSize: 1,
			},
		};

		try {
			const first = await resolveProxyConfigAsync({
				affinityKey: "af_con_fresh_window",
				upstream: { proxy: policy },
			});
			const cached = await resolveProxyConfigAsync({
				affinityKey: "af_con_fresh_window",
				upstream: { proxy: policy },
			});
			now += 16_000;
			const fresh = await resolveProxyConfigAsync({
				affinityKey: "af_con_fresh_window",
				upstream: { proxy: policy },
			});

			expect(first.url).toBe("http://5.78.24.21:31001");
			expect(cached.url).toBe("http://5.78.24.21:31001");
			expect(fresh.url).toBe("http://5.78.24.22:31001");
			expect(allocatorCalls).toBe(2);
		} finally {
			Date.now = originalNow;
		}
	});

	it("reclaims expired Smartproxy pools when another affinity is allocated", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const originalNow = Date.now;
		let now = 1_700_000_000_000;
		Date.now = () => now;
		let allocatorCalls = 0;
		global.fetch = (async () => {
			allocatorCalls += 1;
			return new Response(`5.78.24.${40 + allocatorCalls}:31001`, {
				status: 200,
			});
		}) as typeof fetch;

		const policy = {
			mode: "required" as const,
			provider: "smartproxy" as const,
			geo: { country: "KR" },
			session: { affinity: "connection" as const, poolSize: 1 },
		};

		try {
			await resolveProxyConfigAsync({
				affinityKey: "af_con_reclaim_a",
				upstream: { proxy: policy },
			});
			expect(__getProxyResolutionCacheStatsForTests().proxyCacheEntries).toBe(1);

			now += 16_000;
			await resolveProxyConfigAsync({
				affinityKey: "af_con_reclaim_b",
				upstream: { proxy: policy },
			});

			expect(allocatorCalls).toBe(2);
			expect(__getProxyResolutionCacheStatsForTests().proxyCacheEntries).toBe(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it("keeps Redis fail-closed through lock contention when invalidation tombstones exceed the local cap", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const originalNow = Date.now;
		const now = 1_700_000_000_000;
		Date.now = () => now;
		const redis = new FakeRedis();
		__setProxyRedisForTests(redis);
		let allocatorCalls = 0;
		global.fetch = (async () => {
			allocatorCalls += 1;
			return new Response(`5.78.24.${50 + allocatorCalls}:31001`, {
				status: 200,
			});
		}) as typeof fetch;

		const policy: ProviderProxyPolicy = {
			mode: "required" as const,
			provider: "smartproxy" as const,
			geo: { country: "KR" },
			session: { affinity: "connection" as const, poolSize: 1 },
		};
		const firstOptions = {
			affinityKey: "af_con_overflow_0",
			upstream: { proxy: policy },
		};
		const unrelatedOptions = {
			affinityKey: "af_con_overflow_unrelated",
			upstream: { proxy: policy },
		};

		try {
			const first = await resolveProxyConfigAsync(firstOptions);
			const firstLockKey = redis.setCalls.find(
				(call) => call.condition === "NX",
			)?.key;
			if (!firstLockKey) throw new Error("Expected initial Smartproxy lock key");
			clearProxyResolutionCache();
			const unrelated = await resolveProxyConfigAsync(unrelatedOptions);
			expect(invalidateProxyResolutionCache(firstOptions)).toBe(true);
			for (let index = 1; index <= 1_000; index += 1) {
				invalidateProxyResolutionCache({
					affinityKey: `af_con_overflow_${index}`,
					upstream: { proxy: policy },
				});
			}
			expect(
				__getProxyResolutionCacheStatsForTests().invalidatedProxyKeyEntries,
			).toBe(1_000);

			const unrelatedCached = await resolveProxyConfigAsync(unrelatedOptions);
			redis.failNextNxSet(firstLockKey);
			const second = await resolveProxyConfigAsync(firstOptions);

			expect(first.url).toBe("http://5.78.24.51:31001");
			expect(unrelated.url).toBe("http://5.78.24.52:31001");
			expect(unrelatedCached.url).toBe("http://5.78.24.52:31001");
			expect(second.url).toBe("http://5.78.24.53:31001");
			expect(allocatorCalls).toBe(3);
		} finally {
			Date.now = originalNow;
		}
	});

	it("keeps stale Redis blocked when a replacement write fails and its local pool is evicted", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const originalNow = Date.now;
		const now = 1_700_000_000_000;
		Date.now = () => now;
		const redis = new FakeRedis();
		__setProxyRedisForTests(redis);
		let allocatorCalls = 0;
		global.fetch = (async () => {
			allocatorCalls += 1;
			const zeroBased = allocatorCalls - 1;
			const thirdOctet = Math.floor(zeroBased / 250);
			const fourthOctet = (zeroBased % 250) + 1;
			return new Response(`10.2.${thirdOctet}.${fourthOctet}:31001`, {
				status: 200,
			});
		}) as typeof fetch;

		const policy: ProviderProxyPolicy = {
			mode: "required",
			provider: "smartproxy",
			geo: { country: "KR" },
			session: { affinity: "connection", poolSize: 1 },
		};
		const options = {
			affinityKey: "af_con_failed_replacement",
			upstream: { proxy: policy },
		};

		try {
			const first = await resolveProxyConfigAsync(options);
			const poolKey = redis.setCalls.find(
				(call) => call.mode === "PX" && call.condition === undefined,
			)?.key;
			if (!poolKey) throw new Error("Expected initial Smartproxy pool key");

			redis.failNextDel(poolKey);
			await invalidateProxyResolutionCacheAsync(options);
			redis.failNextSet(poolKey);
			const replacement = await resolveProxyConfigAsync(options);
			const cachedReplacement = await resolveProxyConfigAsync(options);
			expect(
				__getProxyResolutionCacheStatsForTests().invalidatedProxyKeyEntries,
			).toBe(1);

			for (let index = 0; index < 1_000; index += 1) {
				await resolveProxyConfigAsync({
					affinityKey: `af_con_failed_replacement_filler_${index}`,
					upstream: { proxy: policy },
				});
			}
			expect(__getProxyResolutionCacheStatsForTests().proxyCacheEntries).toBe(
				1_000,
			);

			const afterLocalEviction = await resolveProxyConfigAsync(options);

			expect(first.url).toBe("http://10.2.0.1:31001");
			expect(replacement.url).toBe("http://10.2.0.2:31001");
			expect(cachedReplacement.url).toBe("http://10.2.0.2:31001");
			expect(afterLocalEviction.url).toBe("http://10.2.4.3:31001");
			expect(allocatorCalls).toBe(1_003);
			expect(
				__getProxyResolutionCacheStatsForTests().invalidatedProxyKeyEntries,
			).toBe(0);
		} finally {
			Date.now = originalNow;
		}
	});

	it("does not clear a newer invalidation that arrives during allocation", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const originalNow = Date.now;
		const now = 1_700_000_000_000;
		Date.now = () => now;
		__setProxyRedisForTests(new FakeRedis());
		let allocatorCalls = 0;
		let markReplacementStarted!: () => void;
		let releaseReplacement!: () => void;
		const replacementStarted = new Promise<void>((resolve) => {
			markReplacementStarted = resolve;
		});
		const replacementRelease = new Promise<void>((resolve) => {
			releaseReplacement = resolve;
		});
		global.fetch = (async () => {
			allocatorCalls += 1;
			if (allocatorCalls === 2) {
				markReplacementStarted();
				await replacementRelease;
			}
			return new Response(`10.3.0.${allocatorCalls}:31001`, { status: 200 });
		}) as typeof fetch;

		const policy: ProviderProxyPolicy = {
			mode: "required",
			provider: "smartproxy",
			geo: { country: "KR" },
			session: { affinity: "connection", poolSize: 1 },
		};
		const options = {
			affinityKey: "af_con_invalidation_generation",
			upstream: { proxy: policy },
		};

		try {
			const first = await resolveProxyConfigAsync(options);
			expect(invalidateProxyResolutionCache(options)).toBe(true);
			const replacementPromise = resolveProxyConfigAsync(options);
			await replacementStarted;
			expect(invalidateProxyResolutionCache(options)).toBe(true);
			releaseReplacement();
			const replacement = await replacementPromise;
			expect(
				__getProxyResolutionCacheStatsForTests().invalidatedProxyKeyEntries,
			).toBe(1);

			const afterNewerInvalidation = await resolveProxyConfigAsync(options);

			expect(first.url).toBe("http://10.3.0.1:31001");
			expect(replacement.url).toBe("http://10.3.0.2:31001");
			expect(afterNewerInvalidation.url).toBe("http://10.3.0.3:31001");
			expect(allocatorCalls).toBe(3);
			expect(
				__getProxyResolutionCacheStatsForTests().invalidatedProxyKeyEntries,
			).toBe(0);
		} finally {
			Date.now = originalNow;
		}
	});

	it("purges shared Smartproxy Redis pools when a stale pool is invalidated", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		__setProxyRedisForTests(new FakeRedis());
		let allocatorCalls = 0;
		global.fetch = (async () => {
			allocatorCalls += 1;
			return new Response(`5.78.24.${30 + allocatorCalls}:31001`, {
				status: 200,
			});
		}) as typeof fetch;

		const policy = {
			mode: "required" as const,
			provider: "smartproxy" as const,
			geo: { country: "KR" },
			session: { affinity: "connection" as const, poolSize: 1 },
		};
		const options = {
			affinityKey: "af_con_purge",
			upstream: { proxy: policy },
		};

		const first = await resolveProxyConfigAsync(options);
		clearProxyResolutionCache();
		await invalidateProxyResolutionCacheAsync(options);
		const second = await resolveProxyConfigAsync(options);

		expect(first.url).toBe("http://5.78.24.31:31001");
		expect(second.url).toBe("http://5.78.24.32:31001");
		expect(allocatorCalls).toBe(2);
	});

	it("clamps non-finite Smartproxy proxy attempts to the first pool endpoint", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		global.fetch = (async () =>
			new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), {
				status: 200,
			})) as typeof fetch;

		const policy = {
			mode: "required" as const,
			provider: "smartproxy" as const,
			geo: { country: "KR" as const },
			session: { affinity: "connection" as const, poolSize: 2 },
		};

		const nanAttempt = await resolveProxyConfigAsync({
			affinityKey: "af_con_nonfinite_attempt",
			upstream: { proxy: policy },
			proxyAttempt: Number.NaN,
		});
		const infiniteAttempt = await resolveProxyConfigAsync({
			affinityKey: "af_con_nonfinite_attempt",
			upstream: { proxy: policy },
			proxyAttempt: Number.POSITIVE_INFINITY,
		});
		const rotatedAttempt = await resolveProxyConfigAsync({
			affinityKey: "af_con_nonfinite_attempt",
			upstream: { proxy: policy },
			proxyAttempt: 1,
		});

		expect(nanAttempt.url).toBe("http://5.78.24.25:31001");
		expect(infiniteAttempt.url).toBe("http://5.78.24.25:31001");
		expect(rotatedAttempt.url).toBe("http://5.78.24.26:31002");
	});

	it("singleflights concurrent Smartproxy allocator requests and reports lock-wait telemetry", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		__setProxyRedisForTests(new FakeRedis());
		let allocatorCalls = 0;
		const events: unknown[] = [];
		global.fetch = (async () => {
			allocatorCalls += 1;
			await new Promise((resolve) => setTimeout(resolve, 25));
			return new Response("5.78.24.25:31001", { status: 200 });
		}) as typeof fetch;

		const policy = {
			mode: "required" as const,
			provider: "smartproxy" as const,
			geo: { country: "KR" },
			session: { affinity: "connection" as const, poolSize: 1 },
		};

		const [first, second] = await Promise.all([
			resolveProxyConfigAsync({
				affinityKey: "af_con_concurrent",
				upstream: { proxy: policy },
				telemetry: { recordProxyResolution: (event) => events.push(event) },
			}),
			resolveProxyConfigAsync({
				affinityKey: "af_con_concurrent",
				upstream: { proxy: policy },
				telemetry: { recordProxyResolution: (event) => events.push(event) },
			}),
		]);

		expect(first.url).toBe("http://5.78.24.25:31001");
		expect(second.url).toBe("http://5.78.24.25:31001");
		expect(allocatorCalls).toBe(1);
		expect(events).toContainEqual(expect.objectContaining({ cacheStatus: "allocator" }));
		expect(events).toContainEqual(
			expect.objectContaining({ cacheStatus: "lock_wait", cacheHit: true }),
		);
	});

	it("aborts a hung Smartproxy allocator attempt within the allocator deadline", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		__setSmartproxyAllocatorDeadlineMsForTests(35);
		const events: unknown[] = [];
		let allocatorCalls = 0;
		let allocatorSignal: AbortSignal | undefined;
		global.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
			allocatorCalls += 1;
			allocatorSignal = init?.signal ?? undefined;
			return await new Promise<Response>((_resolve, reject) => {
				allocatorSignal?.addEventListener("abort", () => reject(new Error("allocator aborted")), {
					once: true,
				});
			});
		}) as unknown as typeof fetch;

		const startedAt = Date.now();
		await expect(
			resolveProxyConfigAsync({
				affinityKey: "af_con_hung_allocator",
				upstream: {
					proxy: {
						mode: "required",
						provider: "smartproxy",
						geo: { country: "KR" },
						session: { affinity: "connection", poolSize: 1 },
					},
				},
				telemetry: { recordProxyResolution: (event) => events.push(event) },
			}),
		).rejects.toMatchObject({
			code: "PROXY_ALLOCATION_FAILED",
		});

		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(allocatorCalls).toBe(1);
		expect(allocatorSignal).toBeInstanceOf(AbortSignal);
		expect(allocatorSignal?.aborted).toBe(true);
		expect(events).toContainEqual(
			expect.objectContaining({
				cacheStatus: "allocator",
				allocatorAttempts: 1,
				allocatorBodyClass: "network_error",
			}),
		);
	});

	it("fails within the allocator deadline when the Smartproxy response body stalls", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		__setSmartproxyAllocatorDeadlineMsForTests(35);
		const events: unknown[] = [];
		const redis = new FakeRedis();
		__setProxyRedisForTests(redis);
		let allocatorCalls = 0;
		let allocatorSignal: AbortSignal | undefined;
		let bodyReadStarted = false;
		global.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
			allocatorCalls += 1;
			allocatorSignal = init?.signal ?? undefined;
			return {
				ok: true,
				status: 200,
				text: () => {
					bodyReadStarted = true;
					return new Promise<string>(() => undefined);
				},
			} as Response;
		}) as unknown as typeof fetch;

		const startedAt = Date.now();
		await expect(
			resolveProxyConfigAsync({
				affinityKey: "af_con_stalled_allocator_body",
				upstream: {
					proxy: {
						mode: "required",
						provider: "smartproxy",
						geo: { country: "KR" },
						session: { affinity: "connection", poolSize: 1 },
					},
				},
				telemetry: { recordProxyResolution: (event) => events.push(event) },
			}),
		).rejects.toMatchObject({
			code: "PROXY_ALLOCATION_FAILED",
		});

		const lockCall = redis.setCalls.find((call) => call.condition === "NX");
		expect(lockCall?.ttlMs).toBe(10_000);
		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(allocatorCalls).toBe(1);
		expect(bodyReadStarted).toBe(true);
		expect(allocatorSignal).toBeInstanceOf(AbortSignal);
		expect(allocatorSignal?.aborted).toBe(true);
		expect(events).toContainEqual(
			expect.objectContaining({
				provider: "smartproxy",
				cacheStatus: "allocator",
				cacheHit: false,
				attempts: 1,
				allocatorAttempts: 1,
				allocatorStatus: 200,
				allocatorBodyClass: "network_error",
			}),
		);
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain("redacted-test-key");
		expect(serialized).not.toContain("af_con_stalled_allocator_body");
		expect(serialized).not.toContain("get-ip-v3");
		expect(serialized).not.toContain("app_key");
	});

	it("aborts allocator work before the Redis singleflight lock TTL can expire", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		__setSmartproxyAllocatorDeadlineMsForTests(35);
		const redis = new FakeRedis();
		__setProxyRedisForTests(redis);
		let allocatorSignal: AbortSignal | undefined;
		global.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
			allocatorSignal = init?.signal ?? undefined;
			return await new Promise<Response>((_resolve, reject) => {
				allocatorSignal?.addEventListener("abort", () => reject(new Error("allocator aborted")), {
					once: true,
				});
			});
		}) as unknown as typeof fetch;

		const startedAt = Date.now();
		await expect(
			resolveProxyConfigAsync({
				affinityKey: "af_con_lock_timeout",
				upstream: {
					proxy: {
						mode: "required",
						provider: "smartproxy",
						geo: { country: "KR" },
						session: { affinity: "connection", poolSize: 1 },
					},
				},
			}),
		).rejects.toMatchObject({
			code: "PROXY_ALLOCATION_FAILED",
		});

		const lockCall = redis.setCalls.find((call) => call.condition === "NX");
		expect(lockCall?.ttlMs).toBe(10_000);
		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(allocatorSignal).toBeInstanceOf(AbortSignal);
		expect(allocatorSignal?.aborted).toBe(true);
	});

	it("reports redacted Smartproxy allocator failure telemetry before throwing", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const events: unknown[] = [];
		global.fetch = (async () => new Response("allocator denied", { status: 503 })) as typeof fetch;

		await expect(
			resolveProxyConfigAsync({
				affinityKey: "af_con_failure",
				upstream: {
					proxy: {
						mode: "required",
						provider: "smartproxy",
						geo: { country: "KR" },
						session: { affinity: "connection", poolSize: 1 },
					},
				},
				telemetry: { recordProxyResolution: (event) => events.push(event) },
			}),
		).rejects.toMatchObject({
			code: "PROXY_ALLOCATION_FAILED",
		});

		expect(events).toContainEqual(
			expect.objectContaining({
				provider: "smartproxy",
				cacheStatus: "allocator",
				cacheHit: false,
				attempts: 3,
				allocatorAttempts: 3,
				allocatorStatus: 503,
				allocatorBodyClass: "http_error",
			}),
		);
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain("redacted-test-key");
		expect(serialized).not.toContain("af_con_failure");
		expect(serialized).not.toContain("allocator denied");
	});

	it("retries Smartproxy allocator after a network error and reports attempts", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const events: unknown[] = [];
		let allocatorCalls = 0;
		global.fetch = (async () => {
			allocatorCalls += 1;
			if (allocatorCalls === 1) {
				throw new Error("transient allocator network failure");
			}
			return new Response("5.78.24.25:31001", { status: 200 });
		}) as typeof fetch;

		const resolved = await resolveProxyConfigAsync({
			affinityKey: "af_con_retry_network",
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 1 },
				},
			},
			telemetry: { recordProxyResolution: (event) => events.push(event) },
		});

		expect(resolved.url).toBe("http://5.78.24.25:31001");
		expect(allocatorCalls).toBe(2);
		expect(events).toContainEqual(
			expect.objectContaining({
				cacheStatus: "allocator",
				allocatorAttempts: 2,
				allocatorBodyClass: "network_error",
			}),
		);
	});

	it("retries Smartproxy allocator after HTTP errors and keeps safe classification telemetry", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const events: unknown[] = [];
		let allocatorCalls = 0;
		global.fetch = (async () => {
			allocatorCalls += 1;
			if (allocatorCalls === 1) {
				return new Response("allocator denied with private body", {
					status: 500,
				});
			}
			return new Response(
				JSON.stringify({
					code: 0,
					data: { list: [{ ip: "5.78.24.26", port: 31002 }] },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const resolved = await resolveProxyConfigAsync({
			affinityKey: "af_con_retry_http",
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 1 },
				},
			},
			telemetry: { recordProxyResolution: (event) => events.push(event) },
		});

		expect(resolved.url).toBe("http://5.78.24.26:31002");
		expect(allocatorCalls).toBe(2);
		expect(events).toContainEqual(
			expect.objectContaining({
				allocatorAttempts: 2,
				allocatorStatus: 500,
				allocatorBodyClass: "http_error",
			}),
		);
		expect(JSON.stringify(events)).not.toContain("allocator denied");
	});

	it("retries Smartproxy allocator after empty/no-proxy responses", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const events: unknown[] = [];
		let allocatorCalls = 0;
		global.fetch = (async () => {
			allocatorCalls += 1;
			if (allocatorCalls === 1) {
				return new Response("", { status: 200 });
			}
			return new Response("5.78.24.27:31003", { status: 200 });
		}) as typeof fetch;

		const resolved = await resolveProxyConfigAsync({
			affinityKey: "af_con_retry_empty",
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 1 },
				},
			},
			telemetry: { recordProxyResolution: (event) => events.push(event) },
		});

		expect(resolved.url).toBe("http://5.78.24.27:31003");
		expect(allocatorCalls).toBe(2);
		expect(events).toContainEqual(
			expect.objectContaining({
				allocatorAttempts: 2,
				allocatorBodyClass: "empty",
			}),
		);
	});

	it("fails Smartproxy allocation after retry exhaustion with safe final telemetry", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const events: unknown[] = [];
		let allocatorCalls = 0;
		global.fetch = (async () => {
			allocatorCalls += 1;
			return new Response(JSON.stringify({ code: 0, data: { list: [{ ip: "", port: "" }] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		await expect(
			resolveProxyConfigAsync({
				affinityKey: "af_con_retry_exhausted",
				upstream: {
					proxy: {
						mode: "required",
						provider: "smartproxy",
						geo: { country: "KR" },
						session: { affinity: "connection", poolSize: 1 },
					},
				},
				telemetry: { recordProxyResolution: (event) => events.push(event) },
			}),
		).rejects.toMatchObject({
			code: "PROXY_ALLOCATION_FAILED",
		});

		expect(allocatorCalls).toBe(3);
		expect(events).toContainEqual(
			expect.objectContaining({
				cacheStatus: "allocator",
				cacheHit: false,
				attempts: 3,
				allocatorAttempts: 3,
				allocatorStatus: 200,
				allocatorBodyClass: "json_without_proxies",
			}),
		);
		expect(JSON.stringify(events)).not.toContain("redacted-test-key");
		expect(JSON.stringify(events)).not.toContain("af_con_retry_exhausted");
	});

	it("encodes safe Smartproxy allocator fields in telemetry headers", () => {
		const telemetry = new ProxyTelemetryCollector();
		telemetry.recordProxyResolution({
			provider: "smartproxy",
			cacheStatus: "allocator",
			cacheHit: false,
			resolutionMs: 12,
			allocatorStatus: 500,
			allocatorBodyClass: "http_error",
			allocatorAttempts: 3,
			attempts: 3,
		});

		const header = telemetry.toHeaderValue();
		expect(header).toBeTruthy();
		const decoded = JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"));

		expect(decoded.proxy).toMatchObject({
			allocatorStatus: 500,
			allocatorBodyClass: "http_error",
			allocatorAttempts: 3,
		});
		const serialized = JSON.stringify(decoded);
		expect(serialized).not.toContain("redacted-test-key");
		expect(serialized).not.toContain("allocator denied with private body");
	});

	it("forwards Smartproxy telemetry through ctx.http native transport", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const events: unknown[] = [];
		const attempts: unknown[] = [];
		queueAllocatorAndNativeResponses("5.78.24.25:31001", {
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http");
		const http = createHttpClient("https://example.com", {
			affinityKey: "af_con_http",
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 1 },
				},
			},
			telemetry: {
				recordProxyResolution: (event) => events.push(event),
				recordProxyAttempt: (event) => attempts.push(event),
			},
		});

		await http.get("/health");

		expect(nativeProxyCalls()).toEqual(["http://5.78.24.25:31001"]);
		expect(events).toContainEqual(
			expect.objectContaining({
				provider: "smartproxy",
				cacheStatus: "allocator",
				cacheHit: false,
			}),
		);
		expect(attempts).toEqual([]);
	});

	it("rejects malformed default Smartproxy lifetime before optional allocator fallback", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		process.env.APIFUSE__PROXY__DEFAULT_LIFETIME_MINUTES = "abc";
		global.fetch = mock(async () => {
			throw new Error("allocator should not be called");
		}) as typeof fetch;

		await expect(
			resolveProxyConfigAsync({
				upstream: {
					proxy: {
						mode: "optional",
						provider: "smartproxy",
						geo: { country: "KR" },
					},
				},
			}),
		).rejects.toThrow("APIFUSE__PROXY__DEFAULT_LIFETIME_MINUTES must be a positive number");
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("retries Smartproxy stealth requests with the next raw CONNECT endpoint on proxy failure", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		let allocatorCalls = 0;
		global.fetch = (async () => {
			allocatorCalls += 1;
			return new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), {
				status: 200,
			});
		}) as typeof fetch;
		stealthState.queuedResponses.push(new Error("Proxy responded with non 200 code: 512 OK"), {
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		expect(allocatorCalls).toBe(1);
		expect(stealthProxyCalls()).toEqual(["http://5.78.24.25:31001", "http://5.78.24.26:31002"]);
	});

	it("retry false preserves Smartproxy stale-pool candidate rotation before refresh", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const pools = [
			["5.78.24.25:31001", "5.78.24.26:31002"],
			["5.78.24.27:31003", "5.78.24.28:31004"],
		];
		let allocatorCalls = 0;
		global.fetch = (async () => {
			const pool = pools[allocatorCalls] ?? pools[pools.length - 1];
			allocatorCalls += 1;
			return new Response(pool.join("\n"), { status: 200 });
		}) as typeof fetch;
		stealthState.queuedResponses.push(
			{
				status: 512,
				body: "proxy pool unavailable",
				headers: { "content-type": "text/plain" },
			},
			{
				status: 512,
				body: "proxy pool unavailable",
				headers: { "content-type": "text/plain" },
			},
			{
				status: 200,
				body: JSON.stringify({ ok: true }),
				headers: { "Content-Type": "application/json" },
			},
		);

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_retry_false_stale_pool",
		});

		const response = await client.fetch("/health", { retry: false });

		expect(response.status).toBe(200);
		expect(allocatorCalls).toBe(2);
		expect(stealthProxyCalls()).toEqual([
			"http://5.78.24.25:31001",
			"http://5.78.24.26:31002",
			"http://5.78.24.27:31003",
		]);
	});

	it("refreshes stale Smartproxy stealth pools after all endpoints return 509 or 512", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const pools = [
			["5.78.24.25:31001", "5.78.24.26:31002"],
			["5.78.24.27:31003", "5.78.24.28:31004"],
		];
		let allocatorCalls = 0;
		global.fetch = (async () => {
			const pool = pools[allocatorCalls] ?? pools[pools.length - 1];
			allocatorCalls += 1;
			return new Response(pool.join("\n"), { status: 200 });
		}) as typeof fetch;
		stealthState.queuedResponses.push(
			{
				status: 509,
				body: "proxy pool lease expired",
				headers: { "content-type": "text/plain" },
			},
			{
				status: 512,
				body: "proxy pool unavailable",
				headers: { "content-type": "text/plain" },
			},
			{
				status: 200,
				body: JSON.stringify({ ok: true }),
				headers: { "Content-Type": "application/json" },
			},
		);

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		expect(allocatorCalls).toBe(2);
		expect(stealthProxyCalls()).toEqual([
			"http://5.78.24.25:31001",
			"http://5.78.24.26:31002",
			"http://5.78.24.27:31003",
		]);
	});

	it("does not refresh Smartproxy stealth pools for origin 509 responses without proxy markers", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		let allocatorCalls = 0;
		global.fetch = (async () => {
			allocatorCalls += 1;
			return new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), {
				status: 200,
			});
		}) as typeof fetch;
		stealthState.queuedResponses.push({
			status: 509,
			body: "origin quota exceeded",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		let error: unknown;
		try {
			await client.fetch("/health");
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(TransportError);
		expect((error as TransportError).status).toBe(509);
		expect(allocatorCalls).toBe(1);
		expect(stealthState.clients[0]?.calls.map((call) => call.options.proxy)).toEqual([
			"http://5.78.24.25:31001",
		]);
	});

	it("refreshes Smartproxy stealth pools after all endpoints return edge certificate 495", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const pools = [
			["5.78.24.25:31001", "5.78.24.26:31002"],
			["5.78.24.27:31003", "5.78.24.28:31004"],
		];
		let allocatorCalls = 0;
		global.fetch = (async () => {
			const pool = pools[allocatorCalls] ?? pools[pools.length - 1];
			allocatorCalls += 1;
			return new Response(pool.join("\n"), { status: 200 });
		}) as typeof fetch;
		stealthState.queuedResponses.push(
			{
				status: 495,
				body: "Smartproxy edge TLS non-200 code: 495",
				headers: { "content-type": "text/plain" },
			},
			{
				status: 495,
				body: "Smartproxy edge TLS non-200 code: 495",
				headers: { "content-type": "text/plain" },
			},
			{
				status: 200,
				body: JSON.stringify({ ok: true }),
				headers: { "Content-Type": "application/json" },
			},
		);

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		expect(allocatorCalls).toBe(2);
		expect(stealthProxyCalls()).toEqual([
			"http://5.78.24.25:31001",
			"http://5.78.24.26:31002",
			"http://5.78.24.27:31003",
		]);
	});

	it("does not refresh Smartproxy stealth pools for origin 495 responses without proxy markers", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		let allocatorCalls = 0;
		global.fetch = (async () => {
			allocatorCalls += 1;
			return new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), {
				status: 200,
			});
		}) as typeof fetch;
		stealthState.queuedResponses.push({
			status: 495,
			body: "origin SSL certificate error",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		let error: unknown;
		try {
			await client.fetch("/health");
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(TransportError);
		expect((error as TransportError).status).toBe(495);
		expect(allocatorCalls).toBe(1);
		expect(stealthState.clients[0]?.calls.map((call) => call.options.proxy)).toEqual([
			"http://5.78.24.25:31001",
		]);
	});

	it("does not retry origin certificate 495 responses without policy-managed proxy", async () => {
		stealthState.queuedResponses.push({
			status: 495,
			body: "origin SSL certificate error",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com");

		let error: unknown;
		try {
			await client.fetch("/health");
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(TransportError);
		expect((error as TransportError).status).toBe(495);
		expect(stealthState.clients[0]?.calls).toHaveLength(1);
		expect(stealthState.clients[0]?.calls[0]?.options.proxy).toBeUndefined();
	});

	it("closes the shared stealth session when the declarative stealth client is closed", async () => {
		stealthState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com");

		await client.fetch("/health");
		client.close?.();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(stealthState.clients).toHaveLength(1);
		stealthState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		await client.fetch("/after-close");

		expect(stealthState.clients).toHaveLength(2);
	});

	it("retries Smartproxy stealth requests when impit returns a status-zero proxy CONNECT response", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		global.fetch = (async () =>
			new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), {
				status: 200,
			})) as typeof fetch;
		stealthState.queuedResponses.push(
			{
				status: 0,
				body: 'failed to do request: Post "https://ct-api.catchtable.co.kr/api/v6/search/list": Proxy responded with non 200 code: 509 OK',
				headers: {},
			},
			{
				status: 200,
				body: JSON.stringify({ ok: true }),
				headers: { "Content-Type": "application/json" },
			},
		);

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		expect(stealthProxyCalls()).toEqual(["http://5.78.24.25:31001", "http://5.78.24.26:31002"]);
	});

	it("retries Smartproxy stealth requests when impit throws a proxy CONNECT error", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		global.fetch = (async () =>
			new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), {
				status: 200,
			})) as typeof fetch;
		stealthState.queuedResponses.push(
			new Error("failed to do request: proxy CONNECT tunnel failed with non 200 code: 509 OK"),
			{
				status: 200,
				body: JSON.stringify({ ok: true }),
				headers: { "Content-Type": "application/json" },
			},
		);

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		expect(stealthProxyCalls()).toEqual(["http://5.78.24.25:31001", "http://5.78.24.26:31002"]);
	});

	it("retries safe Smartproxy stealth reads when impit throws a generic network error", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		global.fetch = (async () =>
			new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), {
				status: 200,
			})) as typeof fetch;
		stealthState.queuedResponses.push(new Error("socket hang up"), {
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		expect(stealthProxyCalls()).toEqual(["http://5.78.24.25:31001", "http://5.78.24.26:31002"]);
	});

	it("retries safe Smartproxy stealth reads when impit throws a timeout error", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		global.fetch = (async () =>
			new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), {
				status: 200,
			})) as typeof fetch;
		const timeoutError = new Error("request timeout after 10ms");
		timeoutError.name = "TimeoutError";
		stealthState.queuedResponses.push(timeoutError, {
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health", { timeout: 10 });

		expect(response.status).toBe(200);
		expect(stealthProxyCalls()).toEqual(["http://5.78.24.25:31001", "http://5.78.24.26:31002"]);
	});

	it("does not retry generic Smartproxy stealth network errors for unsafe methods", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		global.fetch = (async () =>
			new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), {
				status: 200,
			})) as typeof fetch;
		stealthState.queuedResponses.push(new Error("socket hang up"));

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		let error: unknown;
		try {
			await client.fetch("/health", { method: "POST", body: "{}" });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(TransportError);
		expect((error as TransportError).code).toBe("transport_network_error");
		expect((error as Error).message).toBe("Network error");
		expect(stealthProxyCalls()).toEqual(["http://5.78.24.25:31001"]);
	});

	it("rejects explicit Smartproxy stealth POST retry without unsafe acknowledgement", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		global.fetch = (async () =>
			new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), {
				status: 200,
			})) as typeof fetch;

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		await expect(
			client.fetch("/health", {
				method: "POST",
				body: "{}",
				retry: { methods: ["POST"], attempts: 2 },
			}),
		).rejects.toMatchObject({ code: "retry_unsafe_method" });
		expect(stealthProxyCalls()).toEqual([]);
	});

	it("retries explicit read-like Smartproxy stealth POST network errors with proxy rotation", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		global.fetch = (async () =>
			new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), {
				status: 200,
			})) as typeof fetch;
		stealthState.queuedResponses.push(new Error("socket hang up"), {
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health", {
			method: "POST",
			body: "{}",
			retry: {
				methods: ["POST"],
				attempts: 2,
				errorCodes: ["transport_network_error"],
				unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.AllowExplicitUnsafe,
			},
		});

		expect(response.status).toBe(200);
		expect(stealthProxyCalls()).toEqual(["http://5.78.24.25:31001", "http://5.78.24.26:31002"]);
	});

	it("retries Smartproxy stealth requests when impit exposes structured proxy tunnel status", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		global.fetch = (async () =>
			new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), {
				status: 200,
			})) as typeof fetch;
		const proxyTunnelError = Object.assign(new Error("proxy tunnel failed"), {
			status: 509,
		});
		stealthState.queuedResponses.push(proxyTunnelError, {
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		expect(stealthProxyCalls()).toEqual(["http://5.78.24.25:31001", "http://5.78.24.26:31002"]);
	});

	it("classifies Smartproxy stealth auth-ip edge rejection without source-IP allowlist messaging", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		global.fetch = (async () =>
			new Response(["5.78.24.25:31001", "5.78.24.26:31002"].join("\n"), {
				status: 200,
			})) as typeof fetch;
		stealthState.queuedResponses.push(
			{
				status: 0,
				body: 'failed to do request: Post "https://ct-api.catchtable.co.kr/api/v6/search/list": Proxy responded with non 200 code: 512 OK: auth ip err 203.0.113.10 userid=123 5.78.24.25',
				headers: {},
			},
			{
				status: 0,
				body: 'failed to do request: Post "https://ct-api.catchtable.co.kr/api/v6/search/list": Proxy responded with non 200 code: 512 OK: auth ip err 203.0.113.10 userid=123 5.78.24.26',
				headers: {},
			},
			{
				status: 0,
				body: 'failed to do request: Post "https://ct-api.catchtable.co.kr/api/v6/search/list": Proxy responded with non 200 code: 512 OK: auth ip err 203.0.113.10 userid=123 5.78.24.25',
				headers: {},
			},
			{
				status: 0,
				body: 'failed to do request: Post "https://ct-api.catchtable.co.kr/api/v6/search/list": Proxy responded with non 200 code: 512 OK: auth ip err 203.0.113.10 userid=123 5.78.24.26',
				headers: {},
			},
		);

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		let error: unknown;
		try {
			await client.fetch("/health");
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(TransportError);
		expect((error as TransportError).code).toBe("PROXY_EDGE_AUTH_REJECTED");
		expect((error as Error).message).toContain("candidate endpoint");
		expect((error as Error).message).not.toContain("userid=123");
		expect(stealthProxyCalls()).toEqual([
			"http://5.78.24.25:31001",
			"http://5.78.24.25:31001",
			"http://5.78.24.26:31002",
			"http://5.78.24.26:31002",
		]);
	});

	it("refreshes stale Smartproxy stealth pools before classifying hidden CONNECT 512 auth rejection", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const pools = [
			["5.78.24.25:31001", "5.78.24.26:31002"],
			["5.78.24.27:31003", "5.78.24.28:31004"],
		];
		let allocatorCalls = 0;
		global.fetch = (async () => {
			const pool = pools[allocatorCalls] ?? pools[pools.length - 1];
			allocatorCalls += 1;
			return new Response(pool.join("\n"), { status: 200 });
		}) as typeof fetch;
		stealthState.queuedResponses.push(
			new Error("Proxy responded with non 200 code: 512 OK"),
			new Error("Proxy responded with non 200 code: 512 OK"),
			{
				status: 512,
				body: "auth ip err 203.0.113.10 userid=123 5.78.24.27",
				headers: { "content-type": "text/plain" },
			},
			{
				status: 512,
				body: "auth ip err 203.0.113.10 userid=123 5.78.24.28",
				headers: { "content-type": "text/plain" },
			},
		);

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", poolSize: 2 },
				},
			},
			affinityKey: "af_con_123",
		});

		let error: unknown;
		try {
			await client.fetch("/health");
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(TransportError);
		expect((error as TransportError).code).toBe("PROXY_EDGE_AUTH_REJECTED");
		expect((error as Error).message).toContain("candidate endpoint");
		expect((error as Error).message).not.toContain("userid=123");
		expect(allocatorCalls).toBe(2);
		expect(stealthProxyCalls()).toEqual([
			"http://5.78.24.25:31001",
			"http://5.78.24.26:31002",
			"http://5.78.24.27:31003",
			"http://5.78.24.28:31004",
		]);
		expect(stealthState.clients.flatMap((client) => client.calls.map((call) => call.url))).toEqual([
			"https://example.com/health",
			"https://example.com/health",
			"https://example.com/health",
			"https://example.com/health",
		]);
	});

	it("does not retry stealth proxy failover when optional policy resolves unproxied", async () => {
		stealthState.queuedResponses.push(new Error("connect failed"));

		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "optional",
					provider: "smartproxy",
					geo: { country: "KR" },
				},
			},
			warn: () => undefined,
		});

		await expect(client.fetch("/health")).rejects.toThrow("Network error");

		expect(stealthState.clients).toHaveLength(1);
		expect(stealthState.clients[0]?.calls[0]?.options.proxy).toBeUndefined();
	});

	it("fails closed when required Smartproxy egress lacks an app key", async () => {
		await expect(
			resolveProxyConfigAsync({
				upstream: {
					proxy: {
						mode: "required",
						provider: "smartproxy",
						geo: { country: "KR" },
					},
				},
			}),
		).rejects.toMatchObject({
			code: "PROXY_REQUIRED",
			message: expect.stringContaining("APIFUSE__PROXY__SMARTPROXY_APP_KEY"),
		});
	});

	it("keeps Smartproxy policy stealth clients on origin certificate verification", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		global.fetch = (async () => new Response("5.78.24.25:31001", { status: 200 })) as typeof fetch;
		stealthState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});
		const { createStealthClient } = await import("../runtime/stealth");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
				},
			},
			proxyStealth: { insecureSkipVerify: true },
		});

		await client.fetch("/health");

		expect(stealthState.clients[0]?.calls[0]?.options.proxy).toBe("http://5.78.24.25:31001");
		expect(stealthState.clients[0]?.calls[0]?.options.insecureSkipVerify).toBeUndefined();
	});

	it("hydrates APIFUSE__PROXY__URL from apifuse.config.ts when env is unset", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "apifuse-proxy-"));

		await Bun.write(
			`${directory}/apifuse.config.ts`,
			["export default {", "  proxy: { url: 'https://file-proxy.example:8443' },", "};"].join("\n"),
		);

		const config = await loadApiFuseConfig(directory);

		expect(config.proxy?.url).toBe("https://file-proxy.example:8443");
		expect(process.env.APIFUSE__PROXY__URL).toBe("https://file-proxy.example:8443");
	});
});
