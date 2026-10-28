import { HttpTelemetryCollector } from "../runtime/http-telemetry.js";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { assertIsError } from "./test-utils.js";
import {
	PROXY_ATTEMPTS_PER_VENDOR,
	type ProxyAttemptOutcome,
	type ProxyAttemptRecord,
	type ProxyAttemptRequest,
	type ProxyVendorSelector,
	resolvePolicyTransportAttemptCap,
	resolveProxyConfigAsync,
	setProxyVendorSelector,
	staticOrderProxyVendorSelector,
} from "../config/loader.js";
import type { HttpRetrySummary, ProviderProxyPolicy } from "../types.js";
import { TransportError } from "../errors.js";
import { ProxyTelemetryCollector } from "../runtime/proxy-telemetry.js";
import { deriveProxySessionId, proxySessionWindow } from "../runtime/proxy-session-id.js";
import {
	SMARTPROXY_GATEWAY_HOST,
	SMARTPROXY_GATEWAY_PORT,
	SMARTPROXY_MAX_LIFETIME_MINUTES,
	SMARTPROXY_MIN_LIFETIME_MINUTES,
} from "../runtime/proxy-smartproxy.js";
import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";
import { SESSION_STATE_PINNED_EGRESS } from "../runtime/session-state.js";
import { HttpRetryUnsafeMethodPolicy } from "../types.js";

// Fake gateway sub-account credentials; no test reaches a real vendor.
const SMARTPROXY_TEST_USERNAME = "smart-acct";
const SMARTPROXY_TEST_PASSWORD = "sp-secret";
const SMARTPROXY_GATEWAY = `${SMARTPROXY_GATEWAY_HOST}:${SMARTPROXY_GATEWAY_PORT}`;
const SMARTPROXY_URL_PATTERN =
	/^http:\/\/smart-acct(?:_area-[A-Z]{2})?_life-\d+_session-[0-9a-f]{10}:sp-secret@proxy\.smartproxy\.net:3120$/;
const NODEMAVEN_URL_PATTERN = /@gate\.nodemaven\.com:\d+$/;

/** Every env the proxy resolver reads; saved and cleared around each test. */
const PROXY_ENV_NAMES = [
	"APIFUSE__PROXY__SMARTPROXY_USERNAME",
	"APIFUSE__PROXY__SMARTPROXY_PASSWORD",
	"APIFUSE__PROXY__SMARTPROXY_APP_KEY",
	"APIFUSE__PROXY__NODEMAVEN_USERNAME",
	"APIFUSE__PROXY__NODEMAVEN_PASSWORD",
	"APIFUSE__PROXY__NODEMAVEN_FILTER",
	"APIFUSE__PROXY__DEFAULT_LIFETIME_MINUTES",
	"APIFUSE__PROXY__DEFAULT_COUNTRY",
	"APIFUSE__PROXY__PROVIDER",
] as const;

function useSmartproxyCredentials(): void {
	process.env.APIFUSE__PROXY__SMARTPROXY_USERNAME = SMARTPROXY_TEST_USERNAME;
	process.env.APIFUSE__PROXY__SMARTPROXY_PASSWORD = SMARTPROXY_TEST_PASSWORD;
}

function useNodemavenCredentials(): void {
	process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = "acct123";
	process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = "s3cret";
}

/** The `key-value` tokens of a smartproxy gateway username, keyed by token name. */
function smartproxyTokens(proxyUrl: unknown): Record<string, string> {
	if (typeof proxyUrl !== "string") throw new Error(`not a proxy URL: ${String(proxyUrl)}`);
	const username = decodeURIComponent(new URL(proxyUrl).username);
	const [user, ...tokens] = username.split("_");
	const parsed: Record<string, string> = { user: user ?? "" };
	for (const token of tokens) {
		const separator = token.indexOf("-");
		parsed[token.slice(0, separator)] = token.slice(separator + 1);
	}
	return parsed;
}

function smartproxySession(proxyUrl: unknown): string {
	const session = smartproxyTokens(proxyUrl).session;
	if (!session) throw new Error("smartproxy username carries no session token");
	return session;
}

/** Each URL is a smartproxy gateway URL and no two attempts share a vendor session. */
function expectDistinctSmartproxySessions(proxies: readonly unknown[], count: number): void {
	expect(proxies).toHaveLength(count);
	for (const proxy of proxies) expect(proxy).toMatch(SMARTPROXY_URL_PATTERN);
	expect(new Set(proxies.map(smartproxySession)).size).toBe(count);
}

/** Static selector that also records what it was asked and told. */
function createRecordingSelector(): ProxyVendorSelector & {
	readonly requests: ProxyAttemptRequest[];
	readonly outcomes: ProxyAttemptOutcome[];
} {
	const requests: ProxyAttemptRequest[] = [];
	const outcomes: ProxyAttemptOutcome[] = [];
	return {
		requests,
		outcomes,
		select(request) {
			requests.push({ ...request, ...(request.history ? { history: [...request.history] } : {}) });
			return staticOrderProxyVendorSelector.select(request);
		},
		report(outcome) {
			outcomes.push(outcome);
		},
	};
}

type MockWreqResponse = {
	status: number;
	body: string;
	headers?: Record<string, string | string[]>;
};

type MockWreqQueuedItem = MockWreqResponse | Error;

type MockWreqCall = {
	url: string;
	options: Record<string, unknown>;
};

type FetchDoubleImplementation = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

function createFetchDouble(implementation: FetchDoubleImplementation): typeof fetch {
	return Object.assign(implementation, {
		preconnect(_url: string | URL, _options?: Parameters<typeof fetch.preconnect>[1]): void {},
	});
}

type MockWreqSessionState = {
	calls: MockWreqCall[];
	options: Record<string, unknown> | undefined;
	closed: boolean;
};

const stealthState = {
	clients: [] as MockWreqSessionState[],
	queuedResponses: [] as MockWreqQueuedItem[],
};

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

function queueNativeFetchResponses(...responses: MockWreqResponse[]): void {
	const queue = [...responses];
	global.fetch = createFetchDouble(
		mock(async (input: string | URL | Request, init?: RequestInit) => {
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
		}),
	);
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

function toWreqResponse(response: MockWreqResponse) {
	const bytes = new TextEncoder().encode(response.body);
	return {
		status: response.status,
		ok: response.status >= 200 && response.status < 300,
		headers: toHeaders(response.headers),
		url: "https://example.com/final",
		json: async () => JSON.parse(response.body),
		text: async () => response.body,
		arrayBuffer: async () =>
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
	};
}

class MockWreqSession {
	private readonly state: MockWreqSessionState;

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
			},
		});
		const response = stealthState.queuedResponses.shift();
		if (!response) throw new Error("No queued response");
		if (response instanceof Error) throw response;
		return toWreqResponse(response);
	}

	async clearCookies() {}

	getAllCookies() {
		return [];
	}

	async close() {
		this.state.closed = true;
	}
}

mock.module("wreq-js", () => ({
	createSession: async (options?: Record<string, unknown>) => new MockWreqSession(options),
	getEmulationHeaders: (profile: string, os = "macos") => {
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
			["accept", "text/html,application/xhtml+xml,*/*;q=0.8"],
			["accept-encoding", "gzip, deflate, br, zstd"],
			["accept-language", "en-US,en;q=0.9"],
			["priority", "u=0, i"],
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

describe("proxy integration", () => {
	let originalFetch: typeof fetch;
	const originalEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		originalFetch = global.fetch;
		for (const name of PROXY_ENV_NAMES) {
			originalEnv.set(name, process.env[name]);
			delete process.env[name];
		}
		setProxyVendorSelector(undefined);
		stealthState.clients.length = 0;
		stealthState.queuedResponses.length = 0;
		nativeFetchCalls.length = 0;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		for (const name of PROXY_ENV_NAMES) {
			const value = originalEnv.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		setProxyVendorSelector(undefined);
	});

	it("encodes bounded public-safe per-attempt proxy telemetry", () => {
		const telemetry = new ProxyTelemetryCollector();
		telemetry.recordProxyResolution({
			provider: "smartproxy",
			protocol: "http",
			cacheStatus: "disabled",
			cacheHit: false,
			resolutionMs: 12,
			attempts: 1,
		});
		telemetry.recordProxyAttempt({
			provider: "smartproxy",
			attempt: 1,
			proxyHash: "abcdef123456",
			outcome: "error",
			errorCode: "PROXY_EDGE_AUTH_REJECTED",
			status: 512,
			durationMs: 37,
		});
		telemetry.recordProxyAttempt({
			provider: "smartproxy",
			attempt: 2,
			proxyHash: "123456abcdef",
			outcome: "ok",
			status: 200,
			durationMs: 42,
		});

		const header = telemetry.toHeaderValue();
		expect(header).toBeTruthy();
		const decoded = JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"));

		expect(decoded.proxy).toMatchObject({
			kind: "resolved",
			provider: "smartproxy",
			cacheStatus: "disabled",
			cacheHit: false,
			attempts: 1,
		});
		// The allocator-era fields and the pool index are no longer emitted.
		for (const retired of [
			"allocatorMs",
			"allocatorStatus",
			"allocatorBodyClass",
			"allocatorAttempts",
			"lockWaitMs",
			"poolAgeMs",
			"poolExpiresInMs",
			"refreshes",
		]) {
			expect(decoded.proxy).not.toHaveProperty(retired);
		}
		expect(decoded.proxy.attemptSamples).toEqual([
			{
				n: 1,
				a: 1,
				h: "abcdef123456",
				o: "error",
				c: "PROXY_EDGE_AUTH_REJECTED",
				s: 512,
				d: 37,
			},
			{ n: 2, a: 2, h: "123456abcdef", o: "ok", s: 200, d: 42 },
		]);
		expect(JSON.stringify(decoded)).not.toContain(SMARTPROXY_TEST_PASSWORD);
	});

	it("emits unresolved telemetry with distinct vendors and header parity", () => {
		const telemetry = new ProxyTelemetryCollector();
		telemetry.recordProxyVendorFailover({
			vendor: "smartproxy",
			nextVendor: "nodemaven",
			phase: "resolution",
			reason: "no_credentials",
		});
		telemetry.recordProxyVendorFailover({
			vendor: "nodemaven",
			phase: "resolution",
			reason: "protocol_unsupported",
		});
		telemetry.recordProxyVendorFailover({
			vendor: "smartproxy",
			phase: "transport",
			reason: "pool_exhausted",
			attempt: 2,
		});
		telemetry.recordProxyAttempt({
			provider: "smartproxy",
			attempt: 2,
			outcome: "error",
			errorCode: "PROXY_EDGE_AUTH_REJECTED",
		});

		const payload = telemetry.toLogPayload();
		expect(payload).toEqual({
			kind: "unresolved",
			vendors: ["smartproxy", "nodemaven"],
			failovers: [
				{ v: "smartproxy", nx: "nodemaven", p: "resolution", r: "no_credentials" },
				{ v: "nodemaven", p: "resolution", r: "protocol_unsupported" },
				{ v: "smartproxy", p: "transport", r: "pool_exhausted", a: 2 },
			],
			attemptSamples: [{ n: 1, a: 2, o: "error", c: "PROXY_EDGE_AUTH_REJECTED" }],
		});
		const header = telemetry.toHeaderValue();
		expect(header).toBeTruthy();
		const decoded = JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"));
		expect(decoded).toEqual({
			v: 1,
			taxonomy: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			proxy: payload,
		});
	});

	it("uses the last successful resolution as the serving vendor while aggregating failures", () => {
		const telemetry = new ProxyTelemetryCollector();
		telemetry.recordProxyResolution({
			provider: "smartproxy",
			outcome: "error",
			cacheStatus: "disabled",
			cacheHit: false,
			resolutionMs: 12,
			attempts: 1,
		});
		telemetry.recordProxyVendorFailover({
			vendor: "smartproxy",
			nextVendor: "nodemaven",
			phase: "resolution",
			reason: "allocation_failed",
		});
		telemetry.recordProxyResolution({
			provider: "nodemaven",
			protocol: "http",
			cacheStatus: "disabled",
			cacheHit: false,
			resolutionMs: 8,
			attempts: 1,
		});

		expect(telemetry.toLogPayload()).toEqual({
			kind: "resolved",
			provider: "nodemaven",
			protocol: "http",
			cacheStatus: "disabled",
			cacheHit: false,
			resolutionMs: 20,
			attempts: 2,
			vendors: ["smartproxy", "nodemaven"],
			failovers: [
				{
					v: "smartproxy",
					nx: "nodemaven",
					p: "resolution",
					r: "allocation_failed",
				},
			],
		});
	});

	it("keeps the serving vendor when a later resolution fails", () => {
		// Transport-phase failover ordering: a vendor resolves OK first, the
		// transport then fails, and the NEXT vendor's resolution fails — the
		// failure event is recorded LAST. The serving vendor must stay the
		// successful one, never the trailing failure.
		const telemetry = new ProxyTelemetryCollector();
		telemetry.recordProxyResolution({
			provider: "smartproxy",
			protocol: "http",
			cacheStatus: "disabled",
			cacheHit: false,
			resolutionMs: 3,
			attempts: 1,
		});
		telemetry.recordProxyVendorFailover({
			vendor: "smartproxy",
			nextVendor: "nodemaven",
			phase: "transport",
			reason: "pool_exhausted",
			attempt: 2,
		});
		telemetry.recordProxyResolution({
			provider: "nodemaven",
			outcome: "error",
			cacheStatus: "disabled",
			cacheHit: false,
			resolutionMs: 9,
			attempts: 1,
		});

		const payload = telemetry.toLogPayload();
		expect(payload?.kind).toBe("resolved");
		expect(payload?.kind === "resolved" ? payload.provider : undefined).toBe("smartproxy");
		expect(payload?.kind === "resolved" ? payload.protocol : undefined).toBe("http");
	});

	it("omits telemetry for an empty collector", () => {
		const telemetry = new ProxyTelemetryCollector();

		expect(telemetry.toLogPayload()).toBeUndefined();
		expect(telemetry.toHeaderValue()).toBeUndefined();
	});

	it("passes request-level proxy through ctx.http", async () => {
		queueNativeFetchResponses({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
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

		const { createHttpClient } = await import("../runtime/http.js");
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

	it("passes request-level proxy through ctx.stealth", async () => {
		stealthState.queuedResponses.push({
			status: 200,
			body: "ok",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com");

		await client.fetch("/health", {
			proxy: "https://request-stealth-proxy.example:8443",
		});

		expect(stealthState.clients[0]?.calls[0]?.options).toMatchObject({
			proxy: "https://request-stealth-proxy.example:8443",
		});
	});

	it("synthesizes the smartproxy gateway URL from the provider proxy policy without a network call", async () => {
		useSmartproxyCredentials();
		const fetchDouble = mock(async (): Promise<Response> => {
			throw new Error("gateway resolution must not call fetch");
		});
		global.fetch = createFetchDouble(fetchDouble);
		const now = Date.UTC(2026, 9, 28, 5, 10, 0);

		const resolved = await resolveProxyConfigAsync({
			affinityKey: "af_con_123",
			now,
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

		const window = proxySessionWindow(SMARTPROXY_MAX_LIFETIME_MINUTES, now);
		const sessionId = deriveProxySessionId({
			sticky: true,
			affinityKey: "af_con_123",
			windowEpoch: window.windowEpoch,
			attempt: 0,
		});
		expect(resolved).toMatchObject({
			shouldWarn: false,
			source: "smartproxy-gateway",
			protocol: "http",
			sticky: true,
			sessionId,
			expiresAt: window.expiresAt,
			lifetimeMinutes: SMARTPROXY_MAX_LIFETIME_MINUTES,
			url: `http://smart-acct_area-KR_life-${SMARTPROXY_MAX_LIFETIME_MINUTES}_session-${sessionId}:sp-secret@${SMARTPROXY_GATEWAY}`,
			diagnostics: {
				vendor: "smartproxy",
				protocol: "http",
				sticky: true,
				country: "KR",
				lifetimeMinutes: SMARTPROXY_MAX_LIFETIME_MINUTES,
				lifetimeClamped: true,
				attempt: 0,
			},
		});
		expect(fetchDouble).not.toHaveBeenCalled();
	});

	it("clamps a lifetime below the vendor minimum to the shortest sticky window", async () => {
		useSmartproxyCredentials();

		const resolved = await resolveProxyConfigAsync({
			affinityKey: "af_con_short",
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection", lifetimeMinutes: 1 },
				},
			},
		});

		expect(smartproxyTokens(resolved.url).life).toBe(String(SMARTPROXY_MIN_LIFETIME_MINUTES));
		expect(resolved.lifetimeMinutes).toBe(SMARTPROXY_MIN_LIFETIME_MINUTES);
		expect(resolved.diagnostics?.lifetimeClamped).toBe(true);
	});

	it("derives one sticky smartproxy session per affinity key and lifetime window, and a new one per attempt", async () => {
		useSmartproxyCredentials();
		const policy: ProviderProxyPolicy = {
			mode: "required",
			provider: "smartproxy",
			geo: { country: "KR" },
			session: { affinity: "connection", lifetimeMinutes: 30 },
		};
		// 05:10Z sits in the [05:00, 05:30) window of a 30 minute lifetime.
		const now = Date.UTC(2026, 9, 28, 5, 10, 0);
		const resolve = (overrides: { affinityKey?: string; now?: number; proxyAttempt?: number }) =>
			resolveProxyConfigAsync({
				upstream: { proxy: policy },
				affinityKey: "af_con_sticky",
				now,
				...overrides,
			});

		const first = await resolve({});
		const sameWindow = await resolve({ now: now + 60_000 });
		const otherKey = await resolve({ affinityKey: "af_con_other" });
		const nextWindow = await resolve({ now: now + 30 * 60_000 });
		const retry = await resolve({ proxyAttempt: 1 });

		expect(first.url).toMatch(SMARTPROXY_URL_PATTERN);
		expect(first.sticky).toBe(true);
		// Every process serving the key in the same window reaches the same egress.
		expect(sameWindow.url).toBe(first.url);
		expect(sameWindow.sessionId).toBe(first.sessionId);
		expect(otherKey.sessionId).not.toBe(first.sessionId);
		expect(nextWindow.sessionId).not.toBe(first.sessionId);
		// A retry leaves the session that failed for the attempt's own derived id.
		expect(retry.sessionId).not.toBe(first.sessionId);
		expect(retry.sessionId).toBe(
			deriveProxySessionId({
				sticky: true,
				affinityKey: "af_con_sticky",
				windowEpoch: proxySessionWindow(30, now).windowEpoch,
				attempt: 1,
			}),
		);
		expect(smartproxySession(retry.url)).toBe(retry.sessionId ?? "");
	});

	it("mints a random smartproxy session per attempt for a rotating policy", async () => {
		useSmartproxyCredentials();
		const options = {
			affinityKey: "af_con_rotating",
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
				} satisfies ProviderProxyPolicy,
			},
		};

		const first = await resolveProxyConfigAsync(options);
		const second = await resolveProxyConfigAsync(options);

		expect(first.url).toMatch(SMARTPROXY_URL_PATTERN);
		expect(second.url).toMatch(SMARTPROXY_URL_PATTERN);
		expect(first.sticky).toBe(false);
		expect(first.expiresAt).toBeUndefined();
		expect(second.sessionId).not.toBe(first.sessionId);
		expect(smartproxySession(first.url)).toBe(first.sessionId ?? "");
	});

	it("clamps non-finite smartproxy proxy attempts to the first attempt's session", async () => {
		useSmartproxyCredentials();
		const policy: ProviderProxyPolicy = {
			mode: "required",
			provider: "smartproxy",
			geo: { country: "KR" },
			session: { affinity: "connection" },
		};
		const now = Date.UTC(2026, 9, 28, 5, 10, 0);
		const resolve = (proxyAttempt?: number) =>
			resolveProxyConfigAsync({
				affinityKey: "af_con_nonfinite_attempt",
				upstream: { proxy: policy },
				now,
				...(proxyAttempt === undefined ? {} : { proxyAttempt }),
			});

		const firstAttempt = await resolve();
		const nanAttempt = await resolve(Number.NaN);
		const infiniteAttempt = await resolve(Number.POSITIVE_INFINITY);
		const rotatedAttempt = await resolve(1);

		expect(nanAttempt.url).toBe(firstAttempt.url);
		expect(infiniteAttempt.url).toBe(firstAttempt.url);
		expect(rotatedAttempt.url).not.toBe(firstAttempt.url);
	});

	it("omits the smartproxy area token when no country is known", async () => {
		useSmartproxyCredentials();

		const resolved = await resolveProxyConfigAsync({
			upstream: { proxy: { mode: "required", provider: "smartproxy" } },
		});

		expect(resolved.url).toMatch(SMARTPROXY_URL_PATTERN);
		expect(smartproxyTokens(resolved.url)).not.toHaveProperty("area");
		expect(smartproxyTokens(resolved.url).user).toBe(SMARTPROXY_TEST_USERNAME);
	});

	it("points a vendor at a gateway override without changing its username grammar", async () => {
		useSmartproxyCredentials();
		useNodemavenCredentials();

		const smartproxy = await resolveProxyConfigAsync({
			upstream: { proxy: { mode: "required", provider: "smartproxy", geo: { country: "KR" } } },
			gatewayOverrides: { smartproxy: { host: "127.0.0.1", port: 18080 } },
		});
		const nodemaven = await resolveProxyConfigAsync({
			upstream: { proxy: { mode: "required", provider: "nodemaven", geo: { country: "KR" } } },
			gatewayOverrides: { nodemaven: { host: "127.0.0.1", port: 18081 } },
		});

		expect(smartproxy.url).toMatch(
			/^http:\/\/smart-acct_area-KR_life-30_session-[0-9a-f]{10}:sp-secret@127\.0\.0\.1:18080$/,
		);
		expect(nodemaven.url).toMatch(/^http:\/\/acct123-country-kr-.*@127\.0\.0\.1:18081$/);
		await expect(
			resolveProxyConfigAsync({
				upstream: { proxy: { mode: "required", provider: "smartproxy" } },
				gatewayOverrides: { smartproxy: { host: "evil.example/path", port: 18080 } },
			}),
		).rejects.toThrow("Proxy gateway override host");
		await expect(
			resolveProxyConfigAsync({
				upstream: { proxy: { mode: "required", provider: "smartproxy" } },
				gatewayOverrides: { smartproxy: { host: "127.0.0.1", port: 0 } },
			}),
		).rejects.toThrow("Proxy gateway override port");
	});

	it("fails closed naming the gateway credentials when required smartproxy egress lacks them", async () => {
		// The retired extraction key is not a substitute for the gateway sub-account.
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "retired-extraction-key";
		const policy: ProviderProxyPolicy = {
			mode: "required",
			provider: "smartproxy",
			geo: { country: "KR" },
		};

		await expect(resolveProxyConfigAsync({ upstream: { proxy: policy } })).rejects.toMatchObject({
			code: "PROXY_REQUIRED",
			message: expect.stringContaining(
				"Missing: APIFUSE__PROXY__SMARTPROXY_USERNAME and APIFUSE__PROXY__SMARTPROXY_PASSWORD (smartproxy).",
			),
		});

		process.env.APIFUSE__PROXY__SMARTPROXY_USERNAME = SMARTPROXY_TEST_USERNAME;
		let error: unknown;
		try {
			await resolveProxyConfigAsync({ upstream: { proxy: policy } });
		} catch (caught) {
			error = caught;
		}
		assertIsError(error);
		expect(error).toMatchObject({ code: "PROXY_REQUIRED" });
		expect(error.message).toContain("Missing: APIFUSE__PROXY__SMARTPROXY_PASSWORD (smartproxy).");
		expect(error.message).not.toContain("APIFUSE__PROXY__SMARTPROXY_USERNAME");
		expect(error.message).not.toContain("retired-extraction-key");
	});

	it("rejects malformed default smartproxy lifetime before optional fallback", async () => {
		useSmartproxyCredentials();
		process.env.APIFUSE__PROXY__DEFAULT_LIFETIME_MINUTES = "abc";
		global.fetch = createFetchDouble(
			mock(async (): Promise<Response> => {
				throw new Error("resolution should not call fetch");
			}),
		);

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

	it("forwards smartproxy telemetry through ctx.http native transport", async () => {
		useSmartproxyCredentials();
		const events: unknown[] = [];
		const attempts: unknown[] = [];
		queueNativeFetchResponses({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com", {
			affinityKey: "af_con_http",
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			telemetry: {
				recordProxyResolution: (event) => events.push(event),
				recordProxyAttempt: (event) => attempts.push(event),
			},
		});

		await http.get("/health");

		expectDistinctSmartproxySessions(nativeProxyCalls(), 1);
		expect(events).toContainEqual(
			expect.objectContaining({
				provider: "smartproxy",
				protocol: "http",
				cacheStatus: "disabled",
				cacheHit: false,
				attempts: 1,
			}),
		);
		// ctx.http records the same per-attempt sample as ctx.stealth.
		expect(attempts).toEqual([
			{
				provider: "smartproxy",
				attempt: 1,
				proxyHash: expect.stringMatching(/^[0-9a-f]{12}$/),
				outcome: "ok",
				status: 200,
				durationMs: expect.any(Number),
			},
		]);
	});

	it("advances a ctx.http transport failure across the vendor chain into nodemaven", async () => {
		// The implicit GET budget on a two-vendor chain is 2 × PROXY_ATTEMPTS_PER_VENDOR,
		// split evenly: three smartproxy sessions, then the NodeMaven leg. The retry
		// loop must not stop at the retry budget and strand the request on smartproxy.
		useSmartproxyCredentials();
		useNodemavenCredentials();
		global.fetch = createFetchDouble(
			mock(async (input: string | URL | Request, init?: RequestInit) => {
				nativeFetchCalls.push({
					url: String(input),
					init: init as RequestInit & { proxy?: string },
				});
				const proxy = (init as { proxy?: string } | undefined)?.proxy;
				// The NodeMaven leg answers; every smartproxy session fails transport.
				if (typeof proxy === "string" && NODEMAVEN_URL_PATTERN.test(proxy)) {
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error("socket hang up");
			}),
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com", {
			affinityKey: "af_con_http_vendor_advance",
			upstream: {
				proxy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
		});

		const response = await http.get("/health");

		expect(response.status).toBe(200);
		const proxies = nativeProxyCalls();
		expect(proxies).toHaveLength(PROXY_ATTEMPTS_PER_VENDOR + 1);
		expectDistinctSmartproxySessions(proxies.slice(0, PROXY_ATTEMPTS_PER_VENDOR), 3);
		expect(proxies[PROXY_ATTEMPTS_PER_VENDOR]).toMatch(NODEMAVEN_URL_PATTERN);
	});

	it("issues every ctx.http attempt on a new smartproxy session", async () => {
		// Each attempt mints its own vendor session, so nothing repeats and the
		// implicit budget (PROXY_ATTEMPTS_PER_VENDOR for one vendor) is spent on
		// three distinct egress sessions before the request fails.
		useSmartproxyCredentials();
		global.fetch = createFetchDouble(
			mock(async (input: string | URL | Request, init?: RequestInit) => {
				nativeFetchCalls.push({
					url: String(input),
					init: init as RequestInit & { proxy?: string },
				});
				throw new Error("socket hang up");
			}),
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com", {
			affinityKey: "af_con_http_sessions",
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
		});

		await expect(http.get("/health")).rejects.toBeInstanceOf(TransportError);
		expectDistinctSmartproxySessions(nativeProxyCalls(), PROXY_ATTEMPTS_PER_VENDOR);
	});

	it("counts every issued ctx.http attempt across the vendor crossover", async () => {
		useSmartproxyCredentials();
		useNodemavenCredentials();
		global.fetch = createFetchDouble(
			mock(async (input: string | URL | Request, init?: RequestInit) => {
				nativeFetchCalls.push({
					url: String(input),
					init: init as RequestInit & { proxy?: string },
				});
				const proxy = (init as { proxy?: string } | undefined)?.proxy;
				if (typeof proxy === "string" && NODEMAVEN_URL_PATTERN.test(proxy)) {
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error("socket hang up");
			}),
		);

		let retrySummary: HttpRetrySummary | undefined;
		const httpTelemetry = new HttpTelemetryCollector();
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com", {
			affinityKey: "af_con_http_crossover_summary",
			httpTelemetry,
			onRetrySummary: (summary) => {
				retrySummary = summary;
			},
			upstream: {
				proxy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
		});

		const response = await http.get("/health");

		expect(response.status).toBe(200);
		// Three smartproxy sessions and one NodeMaven session were issued.
		expect(retrySummary).toEqual({
			attempts: 4,
			retries: 3,
			preset: "transport_transient",
			transport: "native",
			lastErrorCode: "transport_network_error",
		});
		expect(httpTelemetry.toLogPayload()?.attempts).toBe(4);
		expect(httpTelemetry.toLogPayload()?.attemptSamples.map(({ n }) => n)).toEqual([1, 2, 3, 4]);
		expect(httpTelemetry.toLogPayload()?.retry as unknown).toEqual(retrySummary);
		expect(httpTelemetry.toLogPayload()?.proxyUsed).toBe(true);
	});

	it("numbers header-factory attempts by issued request across the vendor crossover", async () => {
		useSmartproxyCredentials();
		useNodemavenCredentials();
		global.fetch = createFetchDouble(
			mock(async (input: string | URL | Request, init?: RequestInit) => {
				nativeFetchCalls.push({
					url: String(input),
					init: init as RequestInit & { proxy?: string },
				});
				const proxy = (init as { proxy?: string } | undefined)?.proxy;
				if (typeof proxy === "string" && NODEMAVEN_URL_PATTERN.test(proxy)) {
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error("socket hang up");
			}),
		);

		const attempts: number[] = [];
		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com", {
			affinityKey: "af_con_http_crossover_factory",
			upstream: {
				proxy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
		});

		const response = await http.get("/health", {
			headers: ({ attempt }) => {
				attempts.push(attempt);
				return { dpop: `proof-${attempt}` };
			},
		});

		expect(response.status).toBe(200);
		expect(nativeFetchCalls).toHaveLength(4);
		expect(attempts).toEqual([1, 2, 3, 4]);
		expect(
			nativeFetchCalls.map((call) => (call.init?.headers as Record<string, string>).dpop),
		).toEqual(["proof-1", "proof-2", "proof-3", "proof-4"]);
	});

	it("numbers the first issued header-factory attempt as 1 after a failed proxy resolution", async () => {
		// A resolution failure spends a slot of the retry budget but builds no
		// request, so a single-use proof minter still sees `attempt: 1` on the first
		// request that actually goes out. The selector resolves no vendor once.
		useSmartproxyCredentials();
		let selections = 0;
		const vendorSelector: ProxyVendorSelector = {
			select(request) {
				selections += 1;
				return selections === 1 ? [] : staticOrderProxyVendorSelector.select(request);
			},
			report() {},
		};
		queueNativeFetchResponses({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const attempts: number[] = [];
		const { createHttpClient } = await import("../runtime/http.js");
		const response = await createHttpClient("https://example.com", {
			affinityKey: "af_con_http_resolution_failure_factory",
			vendorSelector,
			upstream: {
				proxy: {
					mode: "required",
					providers: ["smartproxy"],
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
		}).get("/health", {
			retry: { attempts: 2, baseDelayMs: 0 },
			headers: ({ attempt }) => {
				attempts.push(attempt);
				return { dpop: `proof-${attempt}` };
			},
		});

		expect(response.status).toBe(200);
		expect(selections).toBe(2);
		expect(nativeFetchCalls).toHaveLength(1);
		expect(attempts).toEqual([1]);
		expect((nativeFetchCalls[0]?.init?.headers as Record<string, string>).dpop).toBe("proof-1");
	});

	it("moves each ctx.http retry to a new sticky session on a vendor entered by resolution fallback", async () => {
		// smartproxy has no credentials, so every attempt of its share resolves the
		// NodeMaven fallback. Each retry must leave the sticky session that just failed
		// rather than derive NodeMaven's first session again.
		useNodemavenCredentials();
		let targetCalls = 0;
		global.fetch = createFetchDouble(
			mock(async (input: string | URL | Request, init?: RequestInit) => {
				targetCalls += 1;
				nativeFetchCalls.push({
					url: String(input),
					init: init as RequestInit & { proxy?: string },
				});
				if (targetCalls < 3) throw new Error("socket hang up");
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com", {
			affinityKey: "af_con_http_resolution_fallback",
			upstream: {
				proxy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
		});

		const response = await http.get("/health", {
			retry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: "none" },
		});

		expect(response.status).toBe(200);
		const proxies = nativeProxyCalls();
		expect(proxies).toHaveLength(3);
		for (const proxy of proxies) expect(proxy).toMatch(NODEMAVEN_URL_PATTERN);
		const sids = proxies.map((proxy) => /-sid-([0-9a-f]{10})-/.exec(proxy ?? "")?.[1]);
		expect(new Set(sids).size).toBe(3);
	});

	it("honors an explicit ctx.http retry count on a smartproxy policy", async () => {
		// A caller that pinned `retry: { attempts: 3, statusCodes: [503] }` documented
		// three attempts, and each one goes out on its own vendor session.
		useSmartproxyCredentials();
		let targetCalls = 0;
		global.fetch = createFetchDouble(
			mock(async (input: string | URL | Request, init?: RequestInit) => {
				targetCalls += 1;
				nativeFetchCalls.push({
					url: String(input),
					init: init as RequestInit & { proxy?: string },
				});
				return new Response("upstream busy", { status: 503 });
			}),
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const http = createHttpClient("https://example.com", {
			affinityKey: "af_con_http_explicit_retry",
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
		});

		let error: unknown;
		try {
			await http.get("/health", {
				retry: {
					attempts: 3,
					statusCodes: [503],
					baseDelayMs: 0,
					maxDelayMs: 0,
					jitter: "none",
				},
			});
		} catch (caught) {
			error = caught;
		}

		expect(targetCalls).toBe(3);
		expectDistinctSmartproxySessions(nativeProxyCalls(), 3);
		// The terminal error surfaces the real 503, not a synthetic exhaustion.
		expect((error as { status?: number }).status).toBe(503);
		expect((error as { code?: string }).code).toBe("upstream_http_error");
	});

	it("reports every ctx.http attempt to the request's selector with one request id and its history", async () => {
		useSmartproxyCredentials();
		const vendorSelector = createRecordingSelector();
		const processSelector = createRecordingSelector();
		setProxyVendorSelector(processSelector);
		let calls = 0;
		global.fetch = createFetchDouble(
			mock(async (input: string | URL | Request, init?: RequestInit) => {
				calls += 1;
				nativeFetchCalls.push({
					url: String(input),
					init: init as RequestInit & { proxy?: string },
				});
				if (calls < 3) throw new Error("socket hang up");
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		const { createHttpClient } = await import("../runtime/http.js");
		const response = await createHttpClient("https://example.com", {
			affinityKey: "af_con_http_selector",
			vendorSelector,
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
		}).get("/health");

		expect(response.status).toBe(200);
		const requestId = vendorSelector.requests[0]?.requestId;
		expect(requestId).toEqual(expect.any(String));
		expect(vendorSelector.requests.map((request) => request.requestId)).toEqual([
			requestId,
			requestId,
			requestId,
		]);
		expect(vendorSelector.requests.map((request) => request.attempt)).toEqual([0, 1, 2]);
		const failed: ProxyAttemptRecord = {
			vendor: "smartproxy",
			outcome: "error",
			errorCode: "transport_network_error",
		};
		expect(vendorSelector.requests.map((request) => request.history ?? [])).toEqual([
			[],
			[failed],
			[failed, failed],
		]);
		const transport = vendorSelector.outcomes.filter((outcome) => outcome.phase === "transport");
		expect(transport.map((outcome) => outcome.outcome)).toEqual(["error", "error", "ok"]);
		expect(transport.map((outcome) => outcome.status)).toEqual([0, 0, 200]);
		expect(vendorSelector.outcomes.filter((outcome) => outcome.phase === "resolution").length).toBe(
			3,
		);
		expect(vendorSelector.outcomes.every((outcome) => outcome.requestId === requestId)).toBe(true);
		// The process selector neither served nor heard about this request.
		expect(processSelector.requests).toEqual([]);
		expect(processSelector.outcomes).toEqual([]);
	});

	it("retries a refused smartproxy stealth session on a new session id", async () => {
		useSmartproxyCredentials();
		stealthState.queuedResponses.push(new Error("Proxy responded with non 200 code: 512 OK"), {
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		const proxies = stealthProxyCalls();
		expectDistinctSmartproxySessions(proxies, 2);
		expect(smartproxyTokens(proxies[0])).toMatchObject({ area: "KR", life: "30" });
	});

	it("advances a stealth transport failure across the vendor chain into nodemaven", async () => {
		// Regression for the fallback SPOF: every smartproxy session fails at the
		// transport level. The stealth loop spends the primary vendor's share of
		// the attempt budget (PROXY_ATTEMPTS_PER_VENDOR) and then fails over into
		// the NodeMaven leg instead of stranding the request on smartproxy.
		useSmartproxyCredentials();
		useNodemavenCredentials();
		stealthState.queuedResponses.push(
			new Error("socket hang up"),
			new Error("socket hang up"),
			new Error("socket hang up"),
			{
				status: 200,
				body: JSON.stringify({ ok: true }),
				headers: { "Content-Type": "application/json" },
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_vendor_advance",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		const proxies = stealthProxyCalls();
		expect(proxies).toHaveLength(PROXY_ATTEMPTS_PER_VENDOR + 1);
		expectDistinctSmartproxySessions(proxies.slice(0, PROXY_ATTEMPTS_PER_VENDOR), 3);
		expect(proxies[PROXY_ATTEMPTS_PER_VENDOR]).toMatch(NODEMAVEN_URL_PATTERN);
	});

	it("splits an explicit stealth retry budget across the chain like ctx.http", async () => {
		// `retry.attempts: 2` on a two-vendor chain is the budget the selector splits:
		// the second attempt is the fallback vendor's, as on ctx.http, rather than a
		// second smartproxy session inside a chain-span budget the retry never reaches.
		useSmartproxyCredentials();
		useNodemavenCredentials();
		stealthState.queuedResponses.push(new Error("socket hang up"), {
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});
		const selector = createRecordingSelector();

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					geo: { country: "KR" },
				},
			},
			vendorSelector: selector,
		});

		const response = await client.fetch("/health", { retry: { attempts: 2, baseDelayMs: 0 } });

		expect(response.status).toBe(200);
		const proxies = stealthProxyCalls();
		expect(proxies).toHaveLength(2);
		expect(proxies[0]).toMatch(SMARTPROXY_URL_PATTERN);
		expect(proxies[1]).toMatch(NODEMAVEN_URL_PATTERN);
		expect(selector.requests.map(({ attempt, attemptCap }) => [attempt, attemptCap])).toEqual([
			[0, 2],
			[1, 2],
		]);
	});

	it("runs edge refusals past an explicit budget on the last vendor of the chain", async () => {
		// Vendor edge refusals may use the whole rotation span; the attempts past the
		// explicit budget stay on the fallback vendor instead of returning to the first.
		useSmartproxyCredentials();
		useNodemavenCredentials();
		stealthState.queuedResponses.push(
			{ status: 512, body: "proxy pool unavailable", headers: { "content-type": "text/plain" } },
			{ status: 512, body: "proxy pool unavailable", headers: { "content-type": "text/plain" } },
			{
				status: 200,
				body: JSON.stringify({ ok: true }),
				headers: { "Content-Type": "application/json" },
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_explicit_budget",
		});

		const response = await client.fetch("/health", { retry: { attempts: 2, baseDelayMs: 0 } });

		expect(response.status).toBe(200);
		const proxies = stealthProxyCalls();
		expect(proxies).toHaveLength(3);
		expect(proxies[0]).toMatch(SMARTPROXY_URL_PATTERN);
		expect(proxies[1]).toMatch(NODEMAVEN_URL_PATTERN);
		expect(proxies[2]).toMatch(NODEMAVEN_URL_PATTERN);
		expect(proxies[2]).not.toBe(proxies[1]);
	});

	it("does not re-send a session-state pinned egress within one stealth request", async () => {
		// The one place a gateway URL repeats inside a request is a state pinned to the
		// egress it was acquired on: every attempt resolves that same URL, and a retry
		// would re-hammer the exit that just failed, so the repeat is skipped.
		useSmartproxyCredentials();
		stealthState.queuedResponses.push(new Error("socket hang up"), {
			status: 200,
			body: "must not be reached",
			headers: { "content-type": "text/plain" },
		});
		const pinnedUrl = `http://${SMARTPROXY_TEST_USERNAME}_area-KR_life-30_session-0123456789:${SMARTPROXY_TEST_PASSWORD}@proxy.smartproxy.net:3120`;
		const pinnedFetch = {
			method: "GET" as const,
			[SESSION_STATE_PINNED_EGRESS]: {
				url: pinnedUrl,
				vendor: "smartproxy",
				sessionId: "0123456789",
			},
		};

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: { mode: "required", providers: ["smartproxy"], geo: { country: "KR" } },
			},
		});

		await expect(client.fetch("/state", pinnedFetch)).rejects.toMatchObject({
			code: "transport_network_error",
		});
		expect(stealthProxyCalls()).toEqual([pinnedUrl]);
		expect(stealthState.queuedResponses).toHaveLength(1);
	});

	it("throws only after attempting every vendor in the chain on persistent transport failure", async () => {
		useSmartproxyCredentials();
		useNodemavenCredentials();
		// Two vendors × PROXY_ATTEMPTS_PER_VENDOR attempts, all failing.
		for (let index = 0; index < 2 * PROXY_ATTEMPTS_PER_VENDOR; index += 1) {
			stealthState.queuedResponses.push(new Error("socket hang up"));
		}

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_vendor_exhaust",
		});

		let error: unknown;
		try {
			await client.fetch("/health");
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(TransportError);
		const proxies = stealthProxyCalls();
		expect(proxies).toHaveLength(2 * PROXY_ATTEMPTS_PER_VENDOR);
		expectDistinctSmartproxySessions(proxies.slice(0, PROXY_ATTEMPTS_PER_VENDOR), 3);
		for (const proxy of proxies.slice(PROXY_ATTEMPTS_PER_VENDOR)) {
			expect(proxy).toMatch(NODEMAVEN_URL_PATTERN);
		}
	});

	it("retry false still moves a refused smartproxy stealth session to a new session", async () => {
		useSmartproxyCredentials();
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

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_retry_false_refused_session",
		});

		const response = await client.fetch("/health", { retry: false });

		expect(response.status).toBe(200);
		expectDistinctSmartproxySessions(stealthProxyCalls(), 3);
	});

	it("moves past smartproxy sessions the edge refused with 509 or 512 without a refresh pass", async () => {
		useSmartproxyCredentials();
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

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		expectDistinctSmartproxySessions(stealthProxyCalls(), 3);
	});

	it("fails as exhausted once every smartproxy session the budget allows is refused", async () => {
		// One pass over the attempt budget: there is no pool to refresh, so after
		// PROXY_ATTEMPTS_PER_VENDOR refused sessions the request fails and no
		// further attempt is made.
		useSmartproxyCredentials();
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
				status: 512,
				body: "proxy pool unavailable",
				headers: { "content-type": "text/plain" },
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_exhausted",
		});

		let error: unknown;
		try {
			await client.fetch("/health");
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(TransportError);
		expect(error).toMatchObject({ code: "PROXY_POOL_EXHAUSTED" });
		assertIsError(error);
		expect(error.message).toBe("Proxy provider refused every session the attempt budget allowed.");
		expectDistinctSmartproxySessions(stealthProxyCalls(), PROXY_ATTEMPTS_PER_VENDOR);
	});

	it("does not rotate smartproxy stealth sessions for origin 509 responses without proxy markers", async () => {
		useSmartproxyCredentials();
		stealthState.queuedResponses.push({
			status: 509,
			body: "origin quota exceeded",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
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
		expectDistinctSmartproxySessions(stealthProxyCalls(), 1);
	});

	it("moves a smartproxy session the edge refused with certificate 495 to a new session", async () => {
		useSmartproxyCredentials();
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

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		expectDistinctSmartproxySessions(stealthProxyCalls(), 3);
	});

	it("does not rotate smartproxy stealth sessions for origin 495 responses without proxy markers", async () => {
		useSmartproxyCredentials();
		stealthState.queuedResponses.push({
			status: 495,
			body: "origin SSL certificate error",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
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
		expectDistinctSmartproxySessions(stealthProxyCalls(), 1);
	});

	it("does not retry origin certificate 495 responses without policy-managed proxy", async () => {
		stealthState.queuedResponses.push({
			status: 495,
			body: "origin SSL certificate error",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
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

		const { createStealthClient } = await import("../runtime/stealth.js");
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

	it("retries smartproxy stealth requests when impit returns a status-zero proxy CONNECT response", async () => {
		useSmartproxyCredentials();
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

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		expectDistinctSmartproxySessions(stealthProxyCalls(), 2);
	});

	it("retries smartproxy stealth requests when impit throws a proxy CONNECT error", async () => {
		useSmartproxyCredentials();
		stealthState.queuedResponses.push(
			new Error("failed to do request: proxy CONNECT tunnel failed with non 200 code: 509 OK"),
			{
				status: 200,
				body: JSON.stringify({ ok: true }),
				headers: { "Content-Type": "application/json" },
			},
		);

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		expectDistinctSmartproxySessions(stealthProxyCalls(), 2);
	});

	it("retries safe smartproxy stealth reads when impit throws a generic network error", async () => {
		useSmartproxyCredentials();
		stealthState.queuedResponses.push(new Error("socket hang up"), {
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		expectDistinctSmartproxySessions(stealthProxyCalls(), 2);
	});

	it("retries safe smartproxy stealth reads when impit throws a timeout error", async () => {
		useSmartproxyCredentials();
		const timeoutError = new Error("request timeout after 10ms");
		timeoutError.name = "TimeoutError";
		stealthState.queuedResponses.push(timeoutError, {
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health", { timeout: 10 });

		expect(response.status).toBe(200);
		expectDistinctSmartproxySessions(stealthProxyCalls(), 2);
	});

	it("does not retry generic smartproxy stealth network errors for unsafe methods", async () => {
		useSmartproxyCredentials();
		stealthState.queuedResponses.push(new Error("socket hang up"));

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
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
		assertIsError(error);
		expect(error.message).toBe("Network error");
		expectDistinctSmartproxySessions(stealthProxyCalls(), 1);
	});

	it("rejects explicit smartproxy stealth POST retry without unsafe acknowledgement", async () => {
		useSmartproxyCredentials();

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
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

	it("retries explicit read-like smartproxy stealth POST network errors on a new session", async () => {
		useSmartproxyCredentials();
		stealthState.queuedResponses.push(new Error("socket hang up"), {
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
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
		expectDistinctSmartproxySessions(stealthProxyCalls(), 2);
	});

	it("retries smartproxy stealth requests when impit exposes structured proxy tunnel status", async () => {
		useSmartproxyCredentials();
		const proxyTunnelError = Object.assign(new Error("proxy tunnel failed"), {
			status: 509,
		});
		stealthState.queuedResponses.push(proxyTunnelError, {
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_123",
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		expectDistinctSmartproxySessions(stealthProxyCalls(), 2);
	});

	it("classifies smartproxy stealth auth-ip edge rejection without source-IP allowlist messaging", async () => {
		useSmartproxyCredentials();
		for (let index = 0; index < PROXY_ATTEMPTS_PER_VENDOR; index += 1) {
			stealthState.queuedResponses.push({
				status: 0,
				body: 'failed to do request: Post "https://ct-api.catchtable.co.kr/api/v6/search/list": Proxy responded with non 200 code: 512 OK: auth ip err 203.0.113.10 userid=123 5.78.24.25',
				headers: {},
			});
		}

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
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
		assertIsError(error);
		expect(error.message).toContain("rejected a session during authentication");
		expect(error.message).not.toContain("allowlist");
		expect(error.message).not.toContain("userid=123");
		// Every session the budget allows is tried once; none is retried.
		expectDistinctSmartproxySessions(stealthProxyCalls(), PROXY_ATTEMPTS_PER_VENDOR);
	});

	it("classifies a hidden CONNECT 512 auth rejection through the proxy diagnostic after every session is refused", async () => {
		// The CONNECT 512 carries no body, so after the last refused session the
		// stealth runtime sends one diagnostic request through that session and
		// classifies the vendor's answer.
		useSmartproxyCredentials();
		for (let index = 0; index < PROXY_ATTEMPTS_PER_VENDOR; index += 1) {
			stealthState.queuedResponses.push(new Error("Proxy responded with non 200 code: 512 OK"));
		}
		stealthState.queuedResponses.push({
			status: 200,
			body: "auth ip err 203.0.113.10 userid=123",
			headers: { "content-type": "text/plain" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
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
		assertIsError(error);
		expect(error.message).toContain("rejected a session during authentication");
		expect(error.message).not.toContain("userid=123");
		const proxies = stealthProxyCalls();
		expectDistinctSmartproxySessions(proxies.slice(0, PROXY_ATTEMPTS_PER_VENDOR), 3);
		// The diagnostic runs on the last refused session, after the request attempts.
		expect(proxies).toHaveLength(PROXY_ATTEMPTS_PER_VENDOR + 1);
		expect(proxies[PROXY_ATTEMPTS_PER_VENDOR]).toBe(proxies[PROXY_ATTEMPTS_PER_VENDOR - 1]);
		expect(stealthState.clients.flatMap((client) => client.calls.map((call) => call.url))).toEqual([
			"https://example.com/health",
			"https://example.com/health",
			"https://example.com/health",
			"http://example.com/",
		]);
	});

	it("does not retry stealth proxy failover when optional policy resolves unproxied", async () => {
		stealthState.queuedResponses.push(new Error("connect failed"));

		const { createStealthClient } = await import("../runtime/stealth.js");
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

	it("keeps smartproxy policy stealth clients on origin certificate verification", async () => {
		useSmartproxyCredentials();
		stealthState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});
		const { createStealthClient } = await import("../runtime/stealth.js");
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

		expect(stealthState.clients[0]?.calls[0]?.options.proxy).toMatch(SMARTPROXY_URL_PATTERN);
		expect(stealthState.clients[0]?.calls[0]?.options.insecure).toBeUndefined();
	});

	it("reports every stealth attempt to the request's selector with one request id and its history", async () => {
		useSmartproxyCredentials();
		const vendorSelector = createRecordingSelector();
		const processSelector = createRecordingSelector();
		setProxyVendorSelector(processSelector);
		stealthState.queuedResponses.push(new Error("socket hang up"), {
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});

		const { createStealthClient } = await import("../runtime/stealth.js");
		const client = createStealthClient("https://example.com", {
			upstream: {
				proxy: {
					mode: "required",
					provider: "smartproxy",
					geo: { country: "KR" },
					session: { affinity: "connection" },
				},
			},
			affinityKey: "af_con_stealth_selector",
			vendorSelector,
		});

		const response = await client.fetch("/health");

		expect(response.status).toBe(200);
		const requestId = vendorSelector.requests[0]?.requestId;
		expect(requestId).toEqual(expect.any(String));
		expect(vendorSelector.requests.map((request) => request.requestId)).toEqual([
			requestId,
			requestId,
		]);
		expect(vendorSelector.requests.map((request) => request.history ?? [])).toEqual([
			[],
			[{ vendor: "smartproxy", outcome: "error", errorCode: "transport_network_error" }],
		]);
		const transport = vendorSelector.outcomes.filter((outcome) => outcome.phase === "transport");
		expect(transport.map((outcome) => outcome.outcome)).toEqual(["error", "ok"]);
		expect(transport.map((outcome) => outcome.attempt)).toEqual([0, 1]);
		expect(vendorSelector.outcomes.every((outcome) => outcome.requestId === requestId)).toBe(true);
		expect(processSelector.requests).toEqual([]);
		expect(processSelector.outcomes).toEqual([]);

		// The next request is a new request id with an empty history.
		stealthState.queuedResponses.push({
			status: 200,
			body: JSON.stringify({ ok: true }),
			headers: { "Content-Type": "application/json" },
		});
		await client.fetch("/health");
		const next = vendorSelector.requests[2];
		expect(next?.requestId).toEqual(expect.any(String));
		expect(next?.requestId).not.toBe(requestId);
		expect(next?.history ?? []).toEqual([]);
	});
});

describe("resolvePolicyTransportAttemptCap", () => {
	const chainPolicy: ProviderProxyPolicy = {
		mode: "required",
		providers: ["smartproxy", "nodemaven"],
		geo: { country: "KR" },
		session: { affinity: "connection" },
	};

	it("widens an implicit, safe-method policy request to every vendor's share of the chain", () => {
		// Two vendors × PROXY_ATTEMPTS_PER_VENDOR: the even split reaches NodeMaven
		// at attempt 3, past the default per-endpoint budget.
		expect(
			resolvePolicyTransportAttemptCap({
				policy: chainPolicy,
				usesPolicyProxy: true,
				retryAttempts: 3,
				explicitRetry: false,
				method: "GET",
			}),
		).toBe(2 * PROXY_ATTEMPTS_PER_VENDOR);
	});

	it("honours an explicit retry policy's attempt ceiling instead of widening", () => {
		// A caller that pinned attempts:2 must not have the request duplicated
		// across the whole chain — `attempts` is the documented total ceiling.
		expect(
			resolvePolicyTransportAttemptCap({
				policy: chainPolicy,
				usesPolicyProxy: true,
				retryAttempts: 2,
				explicitRetry: true,
				method: "GET",
			}),
		).toBe(2);
	});

	it("never widens an unsafe method across the chain", () => {
		expect(
			resolvePolicyTransportAttemptCap({
				policy: chainPolicy,
				usesPolicyProxy: true,
				retryAttempts: 2,
				explicitRetry: false,
				method: "POST",
			}),
		).toBe(2);
	});

	it("keeps the retry budget for non-registry vendor policies", () => {
		// Deprecated `custom`/`decodo` policies have no managed endpoint, so widening
		// cannot cross over to another vendor session.
		const staticPolicy: ProviderProxyPolicy = {
			mode: "required",
			provider: "custom",
			geo: { country: "KR" },
			session: { affinity: "connection" },
		};
		expect(
			resolvePolicyTransportAttemptCap({
				policy: staticPolicy,
				usesPolicyProxy: true,
				retryAttempts: 3,
				explicitRetry: false,
				method: "GET",
			}),
		).toBe(3);
	});

	it("keeps the retry budget when the request is not policy-managed", () => {
		expect(
			resolvePolicyTransportAttemptCap({
				policy: chainPolicy,
				usesPolicyProxy: false,
				retryAttempts: 3,
				explicitRetry: false,
				method: "GET",
			}),
		).toBe(3);
	});

	it("keeps a retry budget larger than the chain span for any vendor order", () => {
		// The span no longer depends on a declared pool size: a NodeMaven-first
		// chain is entitled to the same 2 × PROXY_ATTEMPTS_PER_VENDOR, and a larger
		// implicit budget is never truncated.
		const nodemavenFirst: ProviderProxyPolicy = {
			mode: "required",
			providers: ["nodemaven", "smartproxy"],
			geo: { country: "KR" },
			session: { affinity: "connection" },
		};
		expect(
			resolvePolicyTransportAttemptCap({
				policy: nodemavenFirst,
				usesPolicyProxy: true,
				retryAttempts: 3,
				explicitRetry: false,
				method: "GET",
			}),
		).toBe(2 * PROXY_ATTEMPTS_PER_VENDOR);
		expect(
			resolvePolicyTransportAttemptCap({
				policy: nodemavenFirst,
				usesPolicyProxy: true,
				retryAttempts: 8,
				explicitRetry: false,
				method: "GET",
			}),
		).toBe(8);
	});
});
