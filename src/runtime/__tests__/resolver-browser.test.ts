import { describe, expect, it } from "bun:test";

import { ProviderError } from "../../errors.js";
import type {
	BrowserClient,
	BrowserCookie,
	BrowserPage,
	ProviderChallengeKind,
} from "../../types.js";
import { createBrowserClient } from "../browser.js";
import { createBrowserResolverVendorAdapter } from "../resolver-vendors/browser.js";
import {
	ResolverChallengeVerdictError,
	ResolverVendorUnavailableError,
} from "../resolver-vendors/types.js";
import { createTraceContext, getTraceRecorder } from "../trace.js";

const AWS_CHALLENGE = {
	kind: "aws_waf",
	pageUrl: "https://example.com/protected",
} as const;

const CLOUDFLARE_CHALLENGE = {
	kind: "cloudflare_interstitial",
	pageUrl: "https://example.com/protected",
} as const;

const COOKIE_BASE = {
	domain: ".example.com",
	path: "/",
	httpOnly: true,
	secure: true,
	sameSite: "None",
} as const;

const CDP_POOL_ERROR_FIXTURES = [
	{
		message: "CDP pool acquire queue is full",
		jsonRpcCode: -32001,
		origin: "apps/cdp-pool/src/index.ts",
		reason: "allocation_exhausted",
	},
	{
		message: "CDP pool acquire timed out",
		jsonRpcCode: -32002,
		origin: "apps/cdp-pool/src/index.ts",
		reason: "allocation_exhausted",
	},
	{
		message: "CDP pool is shutting down",
		jsonRpcCode: -32003,
		origin: "apps/cdp-pool/src/index.ts",
		reason: "allocation_exhausted",
	},
	{
		message: "Unknown CDP pool page lease",
		jsonRpcCode: -32004,
		origin: "apps/cdp-pool/src/index.ts",
		reason: undefined,
	},
	{
		message: "CDP pool acquire requires provider allowedHosts",
		jsonRpcCode: -32006,
		origin: "apps/cdp-pool/src/index.ts",
		reason: undefined,
	},
] as const;

const BROWSER_TRANSPORT_ERROR_FIXTURES = [
	{
		message: "Unable to connect to WebSocket endpoint: ws://cdp-pool.test",
		origin: "src/runtime/browser.ts",
	},
	{
		message: "WebSocket closed: ws://cdp-pool.test",
		origin: "src/runtime/browser.ts",
	},
] as const;

type BrowserStubOptions = {
	readonly closeError?: Error;
	readonly connectError?: Error;
	readonly contextCloseGate?: Promise<void>;
	readonly cookieJars?: readonly (readonly BrowserCookie[])[];
	readonly gotoError?: Error;
	readonly userAgent?: string;
};

function createBrowserStub(options: BrowserStubOptions = {}) {
	let cookieRead = 0;
	const state = {
		clientCloseCalls: 0,
		contextCloseCalls: 0,
		contextCloseStarted: 0,
		gotoUrls: [] as string[],
	};
	const page = {
		async cookies() {
			const jars = options.cookieJars ?? [[]];
			const jar = jars[Math.min(cookieRead, jars.length - 1)] ?? [];
			cookieRead += 1;
			return jar;
		},
		async evaluate<T>(expression: string | (() => T)): Promise<T> {
			void expression;
			return (options.userAgent ?? "StubBrowser/1.0") as T;
		},
		async goto(url: string) {
			state.gotoUrls.push(url);
			if (options.gotoError) throw options.gotoError;
		},
	} as unknown as BrowserPage;
	const client = {
		engine: "playwright-stealth",
		async close() {
			state.clientCloseCalls += 1;
			if (options.closeError) throw options.closeError;
		},
		async withIsolatedContext<T>(handler: (isolatedPage: BrowserPage) => Promise<T>) {
			if (options.connectError) throw options.connectError;
			try {
				return await handler(page);
			} finally {
				state.contextCloseStarted += 1;
				await options.contextCloseGate;
				state.contextCloseCalls += 1;
			}
		},
	} as unknown as BrowserClient;

	return { client, state };
}

function createAdapter(
	stub: ReturnType<typeof createBrowserStub>,
	timeoutMs = 100,
	allowedHosts: readonly string[] = ["example.com"],
) {
	return createBrowserResolverVendorAdapter({
		allowedHosts,
		cdpUrl: "ws://cdp-pool.test",
		createClient: () => stub.client,
		pollIntervalMs: 1,
		timeoutMs,
	});
}

describe("browser resolver vendor", () => {
	it("supports exactly the two cookie-family challenge kinds", () => {
		const adapter = createAdapter(createBrowserStub());
		const support = Object.fromEntries(
			(
				[
					"turnstile",
					"recaptcha_v2",
					"recaptcha_v3",
					"hcaptcha",
					"cloudflare_interstitial",
					"aws_waf",
				] satisfies ProviderChallengeKind[]
			).map((kind) => [kind, adapter.supports(kind)]),
		);

		expect(support).toEqual({
			turnstile: false,
			recaptcha_v2: false,
			recaptcha_v3: false,
			hcaptcha: false,
			cloudflare_interstitial: true,
			aws_waf: true,
		});
	});

	it("returns the AWS WAF cookie and page user agent, then exits the isolated context", async () => {
		const successCookie = {
			...COOKIE_BASE,
			name: "aws-waf-token",
			value: "waf-token",
			expires: 1_786_698_176.5,
		} satisfies BrowserCookie;
		const stub = createBrowserStub({
			cookieJars: [[], [successCookie]],
			userAgent: "Measured Chromium",
		});
		const adapter = createAdapter(stub);

		const result = await adapter.solve(
			AWS_CHALLENGE,
			undefined,
			new AbortController().signal,
		);

		expect(result).toEqual({
			form: "cookies",
			cookies: { "aws-waf-token": "waf-token" },
			userAgent: "Measured Chromium",
			expires: 1_786_698_176.5,
		});
		expect(
			adapter.getIssuingIdentity?.(result, {
				proxyUrl: "http://must-not-be-attributed.example:8080",
				userAgent: "Caller agent",
			}),
		).toEqual({ userAgent: "Measured Chromium" });
		expect(stub.state.gotoUrls).toEqual([AWS_CHALLENGE.pageUrl]);
		expect(stub.state.contextCloseCalls).toBe(1);
	});

	it("passes only the provider-declared hosts to the browser lease", async () => {
		const stub = createBrowserStub({
			cookieJars: [
				[
					{
						...COOKIE_BASE,
						name: "aws-waf-token",
						value: "waf-token",
					},
				],
			],
		});
		const declaredHosts = ["example.com", "assets.example.com"];
		let clientOptions: Parameters<typeof createBrowserClient>[0] | undefined;
		const adapter = createBrowserResolverVendorAdapter({
			allowedHosts: declaredHosts,
			cdpUrl: "ws://cdp-pool.test",
			createClient(options) {
				clientOptions = options;
				return stub.client;
			},
			timeoutMs: 100,
		});

		await adapter.solve(AWS_CHALLENGE, undefined, new AbortController().signal);

		expect(clientOptions?.allowedHosts).toEqual(declaredHosts);
		expect(stub.state.gotoUrls).toEqual([AWS_CHALLENGE.pageUrl]);
	});

	it("refuses an undeclared challenge host before creating a client or navigating", async () => {
		const stub = createBrowserStub();
		let createCalls = 0;
		const adapter = createBrowserResolverVendorAdapter({
			allowedHosts: ["api.example.com"],
			cdpUrl: "ws://cdp-pool.test",
			createClient() {
				createCalls += 1;
				return stub.client;
			},
			timeoutMs: 100,
		});

		await expect(
			adapter.solve(AWS_CHALLENGE, undefined, new AbortController().signal),
		).rejects.toMatchObject({ code: "RESOLVER_HOST_NOT_ALLOWED" });
		expect(createCalls).toBe(0);
		expect(stub.state.gotoUrls).toEqual([]);
	});

	it("fails closed when no usable provider host is declared", async () => {
		const stub = createBrowserStub();
		let createCalls = 0;
		const adapter = createBrowserResolverVendorAdapter({
			allowedHosts: [" ", "*"],
			cdpUrl: "ws://cdp-pool.test",
			createClient() {
				createCalls += 1;
				return stub.client;
			},
			timeoutMs: 100,
		});

		await expect(
			adapter.solve(AWS_CHALLENGE, undefined, new AbortController().signal),
		).rejects.toMatchObject({ code: "RESOLVER_HOST_NOT_ALLOWED" });
		expect(createCalls).toBe(0);
		expect(stub.state.gotoUrls).toEqual([]);
	});

	it("returns cf_clearance for a Cloudflare interstitial", async () => {
		const stub = createBrowserStub({
			cookieJars: [
				[
					{
						...COOKIE_BASE,
						name: "cf_clearance",
						value: "cloudflare-token",
						expires: 1_800_000_000,
					},
				],
			],
			userAgent: "Cloudflare Chromium",
		});

		const result = await createAdapter(stub).solve(
			CLOUDFLARE_CHALLENGE,
			undefined,
			new AbortController().signal,
		);

		expect(result).toEqual({
			form: "cookies",
			cookies: { cf_clearance: "cloudflare-token" },
			userAgent: "Cloudflare Chromium",
			expires: 1_800_000_000,
		});
		expect(stub.state.contextCloseCalls).toBe(1);
	});

	it("preserves the success cookie expiry on the internal browser solution subtype", async () => {
		const stub = createBrowserStub({
			cookieJars: [
				[
					{
						...COOKIE_BASE,
						name: "aws-waf-token",
						value: "expiring-token",
						expires: 1_900_000_000.25,
					},
				],
			],
		});

		const result = await createAdapter(stub).solve(
			AWS_CHALLENGE,
			undefined,
			new AbortController().signal,
		);

		expect(result.expires).toBe(1_900_000_000.25);
		expect(stub.state.contextCloseCalls).toBe(1);
	});

	it("returns timeout unavailability for a jar that never gains the cookie and cleans up", async () => {
		const stub = createBrowserStub({ cookieJars: [[]] });
		const solve = createAdapter(stub, 10).solve(
			AWS_CHALLENGE,
			undefined,
			new AbortController().signal,
		);

		await expect(solve).rejects.toBeInstanceOf(ResolverVendorUnavailableError);
		await expect(solve).rejects.toMatchObject({ vendor: "browser", reason: "timeout" });
		expect(stub.state.contextCloseCalls).toBe(1);
	});

	for (const fixture of BROWSER_TRANSPORT_ERROR_FIXTURES) {
		it(`maps the transport error from ${fixture.origin}: ${fixture.message}`, async () => {
			const stub = createBrowserStub({ connectError: new Error(fixture.message) });

			await expect(
				createAdapter(stub).solve(AWS_CHALLENGE, undefined, new AbortController().signal),
			).rejects.toMatchObject({ vendor: "browser", reason: "transport_failure" });
		});
	}

	for (const fixture of CDP_POOL_ERROR_FIXTURES.filter(
		(fixture) => fixture.reason === "allocation_exhausted",
	)) {
		it(`maps pool error ${fixture.jsonRpcCode} from ${fixture.origin}`, async () => {
			const stub = createBrowserStub({ connectError: new Error(fixture.message) });

			await expect(
				createAdapter(stub).solve(AWS_CHALLENGE, undefined, new AbortController().signal),
			).rejects.toMatchObject({ vendor: "browser", reason: fixture.reason });
		});
	}

	for (const fixture of CDP_POOL_ERROR_FIXTURES.filter(
		(fixture) => fixture.reason === undefined,
	)) {
		it(`propagates unclassified pool error ${fixture.jsonRpcCode} from ${fixture.origin}`, async () => {
			const originalError = new Error(fixture.message);
			const stub = createBrowserStub({ connectError: originalError });

			await expect(
				createAdapter(stub).solve(AWS_CHALLENGE, undefined, new AbortController().signal),
			).rejects.toBe(originalError);
		});
	}

	it("propagates an unrecognised connection error unchanged", async () => {
		const originalError = new Error("CDP connect failed");
		const stub = createBrowserStub({ connectError: originalError });

		await expect(
			createAdapter(stub).solve(AWS_CHALLENGE, undefined, new AbortController().signal),
		).rejects.toBe(originalError);
	});

	it("stops promptly when aborted and exits the isolated context", async () => {
		const stub = createBrowserStub({ cookieJars: [[]] });
		const controller = new AbortController();
		const solve = createAdapter(stub, 5_000).solve(AWS_CHALLENGE, undefined, controller.signal);
		setTimeout(() => controller.abort(new Error("caller cancelled")), 5);

		const outcome = await Promise.race([
			solve.then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			),
			new Promise<string>((resolve) => setTimeout(() => resolve("too slow"), 200)),
		]);

		expect(outcome).toBe("caller cancelled");
		expect(stub.state.contextCloseCalls).toBe(1);
	});

	it("does not turn an abort during context cleanup into success", async () => {
		let releaseContextClose: (() => void) | undefined;
		const contextCloseGate = new Promise<void>((resolve) => {
			releaseContextClose = resolve;
		});
		const stub = createBrowserStub({
			contextCloseGate,
			cookieJars: [
				[
					{
						...COOKIE_BASE,
						name: "aws-waf-token",
						value: "finished-token",
					},
				],
			],
		});
		const controller = new AbortController();
		const solve = createAdapter(stub).solve(AWS_CHALLENGE, undefined, controller.signal);
		while (stub.state.contextCloseStarted === 0) await Promise.resolve();

		controller.abort(new Error("cancelled during cleanup"));
		releaseContextClose?.();

		await expect(solve).rejects.toThrow("cancelled during cleanup");
		expect(stub.state.contextCloseCalls).toBe(1);
	});

	it("exits the isolated context when a page operation throws", async () => {
		const stub = createBrowserStub({ gotoError: new Error("navigation crashed") });

		await expect(
			createAdapter(stub).solve(AWS_CHALLENGE, undefined, new AbortController().signal),
		).rejects.toThrow("navigation crashed");
		expect(stub.state.contextCloseCalls).toBe(1);
	});

	it("records cleanup failure without replacing a successful solution", async () => {
		const cleanupError = new Error("CDP lease release failed after success");
		const stub = createBrowserStub({
			closeError: cleanupError,
			cookieJars: [
				[
					{
						...COOKIE_BASE,
						name: "aws-waf-token",
						value: "successful-token",
					},
				],
			],
		});
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");

		const result = await createAdapter(stub).solve(
			AWS_CHALLENGE,
			undefined,
			new AbortController().signal,
			recorder,
		);

		expect(result.cookies).toEqual({ "aws-waf-token": "successful-token" });
		expect(stub.state.clientCloseCalls).toBe(1);
		expect(trace.getSpans()).toHaveLength(1);
		expect(trace.getSpans()[0]).toMatchObject({
			name: "resolver.vendor.cleanup",
			status: "error",
			error: cleanupError.message,
			attributes: {
				vendor: "browser",
				challenge_kind: "aws_waf",
				operation: "client.close",
				error_message: cleanupError.message,
				error_stack: expect.stringContaining(cleanupError.message),
			},
		});
	});

	it("records cleanup failure without masking the solve-time error", async () => {
		const solveError = new Error("navigation failed before cleanup");
		const cleanupError = new Error("CDP lease release also failed");
		const stub = createBrowserStub({ closeError: cleanupError, gotoError: solveError });
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");

		await expect(
			createAdapter(stub).solve(AWS_CHALLENGE, undefined, new AbortController().signal, recorder),
		).rejects.toBe(solveError);
		expect(stub.state.clientCloseCalls).toBe(1);
		expect(trace.getSpans()[0]).toMatchObject({
			name: "resolver.vendor.cleanup",
			status: "error",
			attributes: {
				error_message: cleanupError.message,
			},
		});
	});

	it("reports missing CDP configuration without creating a browser client", async () => {
		let createCalls = 0;
		const adapter = createBrowserResolverVendorAdapter({
			allowedHosts: ["example.com"],
			createClient: () => {
				createCalls += 1;
				return createBrowserStub().client;
			},
			timeoutMs: 100,
		});

		await expect(
			adapter.solve(AWS_CHALLENGE, undefined, new AbortController().signal),
		).rejects.toMatchObject({ vendor: "browser", reason: "missing_credentials" });
		expect(createCalls).toBe(0);
	});

	it("maps the real BROWSER_CDP_POOL_REQUIRED ProviderError to missing_credentials", async () => {
		const adapter = createBrowserResolverVendorAdapter({
			allowedHosts: ["example.com"],
			cdpUrl: "ws://resolver-configured.test",
			createClient: () => createBrowserClient({ cdpUrl: "", requireCdpPool: true }),
			timeoutMs: 100,
		});

		const error = await adapter
			.solve(AWS_CHALLENGE, undefined, new AbortController().signal)
			.catch((error: unknown) => error);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({ vendor: "browser", reason: "missing_credentials" });
		if (!(error instanceof ResolverVendorUnavailableError)) throw error;
		expect(error.cause).toBeInstanceOf(ProviderError);
		expect((error.cause as ProviderError).code).toBe("BROWSER_CDP_POOL_REQUIRED");
	});

	it("keeps a human-puzzle verdict distinct from vendor unavailability", () => {
		const verdict = new ResolverChallengeVerdictError("browser", "human_puzzle");

		expect(verdict).toMatchObject({ vendor: "browser", reason: "human_puzzle" });
		expect(verdict).not.toBeInstanceOf(ResolverVendorUnavailableError);
	});
});
