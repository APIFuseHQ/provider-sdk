import { describe, expect, it } from "bun:test";

import {
	createBrowserClientDouble,
	createBrowserPageDouble,
} from "../../__tests__/test-utils.js";
import { ProviderError } from "../../errors.js";
import type {
	BrowserCookie,
	BrowserPage,
	BrowserResourcePolicy,
	ChallengeSolution,
	ProviderCache,
	ProviderChallengeKind,
} from "../../types.js";
import { createBrowserClient } from "../browser.js";
import { createProviderCache } from "../cache.js";
import {
	APIFUSE__CDP_POOL__URL,
	createResolverClient,
	createResolverClientFromEnvForTests,
} from "../resolver.js";
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

const EXPECTED_BROWSER_CHALLENGE_BINDINGS = {
	aws_waf: "portable",
	cloudflare_interstitial: "identity_scoped",
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
	readonly blockedRequestUrl?: string;
	readonly closeError?: Error;
	readonly connectError?: Error;
	readonly contextCloseGate?: Promise<void>;
	readonly cookieJars?: readonly (readonly BrowserCookie[])[];
	readonly gotoError?: Error;
	readonly userAgent?: string;
};

function collectNestedStrings(value: unknown, seen = new Set<object>()): string[] {
	if (typeof value === "string") return [value];
	if (typeof value !== "object" || value === null || seen.has(value)) return [];
	seen.add(value);

	const strings = value instanceof Error ? [value.message] : [];
	if (value instanceof Error && value.cause !== undefined) {
		strings.push(...collectNestedStrings(value.cause, seen));
	}
	for (const [key, nestedValue] of Object.entries(value)) {
		if (key !== "message" && key !== "cause") {
			strings.push(...collectNestedStrings(nestedValue, seen));
		}
	}
	return strings;
}

function createBrowserStub(options: BrowserStubOptions = {}) {
	let cookieRead = 0;
	const state = {
		clientCloseCalls: 0,
		contextCloseCalls: 0,
		contextCloseStarted: 0,
		gotoOptions: [] as Array<Parameters<BrowserPage["goto"]>[1]>,
		gotoUrls: [] as string[],
		pageOperations: [] as string[],
		resourcePolicies: [] as BrowserResourcePolicy[],
	};
	const page = createBrowserPageDouble({
		async cookies() {
			const jars = options.cookieJars ?? [[]];
			const jar = jars[Math.min(cookieRead, jars.length - 1)] ?? [];
			cookieRead += 1;
			return jar;
		},
		async userAgent(): Promise<string> {
			state.pageOperations.push("evaluate-user-agent");
			return options.userAgent ?? "StubBrowser/1.0";
		},
		async goto(url: string, gotoOptions?: Parameters<BrowserPage["goto"]>[1]) {
			state.pageOperations.push("goto");
			state.gotoUrls.push(url);
			state.gotoOptions.push(gotoOptions);
			if (options.blockedRequestUrl) {
				await state.resourcePolicies.at(-1)?.routes[0]?.handle({
					headers: {},
					method: "GET",
					url: options.blockedRequestUrl,
				});
			}
			if (options.gotoError) throw options.gotoError;
		},
		async withResourcePolicy<T>(policy: BrowserResourcePolicy, run: () => Promise<T>): Promise<T> {
			state.resourcePolicies.push(policy);
			return await run();
		},
	});
	const client = createBrowserClientDouble({
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
	});

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
		expect(Object.keys(EXPECTED_BROWSER_CHALLENGE_BINDINGS).sort()).toEqual(
			Object.entries(support)
				.filter(([, supported]) => supported)
				.map(([kind]) => kind)
				.sort(),
		);
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

		const result = await adapter.solve(AWS_CHALLENGE, undefined, new AbortController().signal);

		expect(result).toEqual({
			form: "cookies",
			cookies: { "aws-waf-token": "waf-token" },
			userAgent: "Measured Chromium",
			expires: 1_786_698_176.5,
		});
		expect(
			adapter.getIssuingIdentity?.(
				result,
				{
					proxyUrl: "http://must-not-be-attributed.example:8080",
					userAgent: "Caller agent",
				},
				AWS_CHALLENGE,
			),
		).toEqual({ userAgent: "Measured Chromium" });
		expect(stub.state.gotoUrls).toEqual([AWS_CHALLENGE.pageUrl]);
		expect(stub.state.gotoOptions).toEqual([
			{ timeout: 100, waitUntil: "domcontentloaded" },
		]);
		expect(stub.state.pageOperations).toEqual(["evaluate-user-agent", "goto"]);
		expect(stub.state.contextCloseCalls).toBe(1);
	});

	it("returns and caches only the required cookie from the challenge URL's most specific domain", async () => {
		const stub = createBrowserStub({
			cookieJars: [
				[
					{
						...COOKIE_BASE,
						domain: "accounts.example.net",
						name: "session",
						value: "unrelated-http-only-credential",
					},
					{
						...COOKIE_BASE,
						domain: "redirect.example.net",
						name: "aws-waf-token",
						value: "wrong-host-token",
					},
					{
						...COOKIE_BASE,
						domain: ".example.com",
						name: "aws-waf-token",
						value: "parent-domain-token",
						expires: 1_900_000_000,
					},
					{
						...COOKIE_BASE,
						domain: "example.com",
						name: "aws-waf-token",
						value: "challenge-host-token",
						expires: 1_900_000_000,
					},
					{
						...COOKIE_BASE,
						name: "resource-session",
						value: "unrelated-resource-cookie",
					},
				],
			],
		});
		const adapter = createAdapter(stub);
		const innerCache = createProviderCache({
			providerId: `resolver-browser-cookie-scope-${crypto.randomUUID()}`,
			redisUrl: "",
		});
		const writes: unknown[] = [];
		const cache: ProviderCache = {
			key: (namespace, parts, options) => innerCache.key(namespace, parts, options),
			get: (key) => innerCache.get(key),
			async set(key, value, options) {
				writes.push(value);
				await innerCache.set(key, value, options);
			},
			delete: (key) => innerCache.delete(key),
			getOrSet: (key, loader, options) => innerCache.getOrSet(key, loader, options),
			responseMeta: () => innerCache.responseMeta(),
		};
		const resolver = createResolverClient({
			adapters: [adapter],
			cache,
			kinds: ["aws_waf"],
		});

		const result = await resolver.solve(AWS_CHALLENGE);

		expect(result).toMatchObject({
			form: "cookies",
			cookies: { "aws-waf-token": "challenge-host-token" },
		});
		expect((result as { readonly cookies: Readonly<Record<string, string>> }).cookies).toEqual({
			"aws-waf-token": "challenge-host-token",
		});
		const cachedSolution = writes.find(
			(value) => typeof value === "object" && value !== null && "solution" in value,
		) as { readonly solution?: ChallengeSolution } | undefined;
		expect(cachedSolution?.solution).toMatchObject({
			form: "cookies",
			cookies: { "aws-waf-token": "challenge-host-token" },
		});
		expect(
			(cachedSolution?.solution as Extract<ChallengeSolution, { form: "cookies" }>).cookies,
		).toEqual({ "aws-waf-token": "challenge-host-token" });
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

		expect(clientOptions).toMatchObject({
			allowedHosts: declaredHosts,
			cdpUrl: "ws://cdp-pool.test",
			requireCdpPool: true,
			serviceWorkers: "block",
		});
		expect(clientOptions?.proxy).toBeUndefined();
		expect(stub.state.gotoUrls).toEqual([AWS_CHALLENGE.pageUrl]);
	});

	it("admits only HTTPS AWS WAF infrastructure outside declared hosts", async () => {
		const stub = createBrowserStub({
			cookieJars: [[{ ...COOKIE_BASE, name: "aws-waf-token", value: "waf-token" }]],
		});
		const adapter = createAdapter(stub);

		await adapter.solve(AWS_CHALLENGE, undefined, new AbortController().signal);

		const policy = stub.state.resourcePolicies[0];
		const route = policy?.routes[0];
		if (!route) throw new Error("Browser resolver did not install its resource policy");
		expect(policy.documentContentSecurityPolicy).toBe(
			"connect-src http: https:; worker-src 'none'",
		);
		const request = (url: string) => ({ headers: {}, method: "GET", url }) as const;
		expect(await route.handle(request("https://example.com/asset.js"))).toEqual({
			action: "continue",
		});
		expect(await route.handle(request("https://tenant.token.awswaf.com/challenge"))).toEqual({
			action: "continue",
		});
		expect(await route.handle(request("http://tenant.token.awswaf.com/challenge"))).toEqual({
			action: "block",
		});
		expect(await route.handle(request("https://attacker.example/collect"))).toEqual({
			action: "block",
		});
	});

	it("declines a pooled solve with a proxy identity before acquiring a session", async () => {
		const proxyUrl = "http://proxy-user:proxy-password@proxy.test:8080";
		const stub = createBrowserStub();
		let createCalls = 0;
		const adapter = createBrowserResolverVendorAdapter({
			allowedHosts: ["example.com"],
			cdpUrl: "ws://cdp-pool.test",
			createClient() {
				createCalls += 1;
				return stub.client;
			},
			timeoutMs: 100,
		});

		const error = await adapter
			.solve(
				AWS_CHALLENGE,
				{ proxyUrl, userAgent: "BoundBrowser/1.0" },
				new AbortController().signal,
			)
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({ vendor: "browser", reason: "not_implemented" });
		expect(createCalls).toBe(0);
		expect(stub.state.gotoUrls).toEqual([]);
		expect(stub.state.contextCloseStarted).toBe(0);
		expect(collectNestedStrings(error).join("\n")).not.toContain(proxyUrl);
	});

	it("advances to the next vendor when the pool cannot bind the proxy identity", async () => {
		const proxyUrl = "http://proxy-user:proxy-password@proxy.test:8080";
		const browserStub = createBrowserStub();
		let browserCreateCalls = 0;
		let secondVendorCalls = 0;
		const browser = createBrowserResolverVendorAdapter({
			allowedHosts: ["example.com"],
			cdpUrl: "ws://cdp-pool.test",
			createClient() {
				browserCreateCalls += 1;
				return browserStub.client;
			},
			timeoutMs: 100,
		});
		const secondVendor = {
			id: "2captcha",
			supports: (kind: ProviderChallengeKind) => kind === "aws_waf",
			async solve() {
				secondVendorCalls += 1;
				return { form: "token", token: "second-vendor-solution" } as const;
			},
		} satisfies import("../resolver-vendors/types.js").ResolverVendorAdapter;
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");
		const resolver = createResolverClient({
			adapters: [browser, secondVendor],
			identity: { proxyUrl, userAgent: "BoundBrowser/1.0" },
			kinds: ["aws_waf"],
			// @ts-expect-error test-invalid: legacy proxy mode is intentionally ignored by resolver config
			proxyMode: "required",
		});

		const result = await resolver.solve(AWS_CHALLENGE, undefined, recorder);

		expect(result).toEqual({ form: "token", token: "second-vendor-solution" });
		expect(browserCreateCalls).toBe(0);
		expect(browserStub.state.contextCloseStarted).toBe(0);
		expect(secondVendorCalls).toBe(1);
		expect(
			collectNestedStrings(trace.getSpans().map((span) => span.attributes)).join("\n"),
		).not.toContain(proxyUrl);
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

	it("scopes Cloudflare cache entries to the identity that produced them", async () => {
		const expires = 1_900_000_000;
		const stub = createBrowserStub({
			cookieJars: [
				[
					{
						...COOKIE_BASE,
						name: "cf_clearance",
						value: "identity-one-token",
						expires,
					},
				],
				[
					{
						...COOKIE_BASE,
						name: "cf_clearance",
						value: "identity-two-token",
						expires,
					},
				],
			],
			userAgent: "Cloudflare Browser/1.0",
		});
		const adapter = createAdapter(stub);
		const cache = createProviderCache({
			providerId: `resolver-browser-cloudflare-binding-${crypto.randomUUID()}`,
			redisUrl: "",
		});
		const config = {
			vendors: ["browser"],
			kinds: ["cloudflare_interstitial"],
		} as const;
		const env = { [APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test" };
		const adapterFactories = { browser: () => adapter } as const;
		const firstResolver = createResolverClientFromEnvForTests(
			config,
			env,
			{ cache, identityScope: "proxy-session-one" },
			adapterFactories,
		);
		const secondResolver = createResolverClientFromEnvForTests(
			config,
			env,
			{ cache, identityScope: "proxy-session-two" },
			adapterFactories,
		);

		const first = await firstResolver.solve(CLOUDFLARE_CHALLENGE);
		const second = await secondResolver.solve(CLOUDFLARE_CHALLENGE);
		const firstCached = await firstResolver.solve(CLOUDFLARE_CHALLENGE);
		const secondCached = await secondResolver.solve(CLOUDFLARE_CHALLENGE);

		expect(first).toMatchObject({ cookies: { cf_clearance: "identity-one-token" } });
		expect(second).toMatchObject({ cookies: { cf_clearance: "identity-two-token" } });
		expect(firstCached).toEqual(first);
		expect(secondCached).toEqual(second);
		expect(stub.state.contextCloseCalls).toBe(2);
	});

	it("preserves the success cookie expiry on the canonical cookie solution", async () => {
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
		it(`maps pool error code ${fixture.jsonRpcCode} from ${fixture.origin}`, async () => {
			// The numeric code is what PR #119 propagates and what production must classify on.
			// The message is deliberately unrelated so a message-only implementation fails here.
			const codedError = Object.assign(new Error("pool rejected the acquire"), {
				code: fixture.jsonRpcCode,
			});
			const stub = createBrowserStub({ connectError: codedError });

			await expect(
				createAdapter(stub).solve(AWS_CHALLENGE, undefined, new AbortController().signal),
			).rejects.toMatchObject({ vendor: "browser", reason: fixture.reason });
		});

		it(`still maps the legacy message for ${fixture.jsonRpcCode} when no code is present`, async () => {
			// Fallback path for pool builds predating numeric-code propagation.
			const stub = createBrowserStub({ connectError: new Error(fixture.message) });

			await expect(
				createAdapter(stub).solve(AWS_CHALLENGE, undefined, new AbortController().signal),
			).rejects.toMatchObject({ vendor: "browser", reason: fixture.reason });
		});
	}

	for (const fixture of CDP_POOL_ERROR_FIXTURES.filter((fixture) => fixture.reason === undefined)) {
		it(`propagates unclassified pool error code ${fixture.jsonRpcCode} from ${fixture.origin}`, async () => {
			// -32004 and -32006 are caller bugs: the next vendor would fail identically,
			// so they must reach the caller instead of becoming a failover reason.
			const originalError = Object.assign(new Error(fixture.message), {
				code: fixture.jsonRpcCode,
			});
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

	it("bounds an unresponsive context release and preserves the caller abort", async () => {
		const contextCloseGate = new Promise<void>(() => undefined);
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
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");
		const controller = new AbortController();
		const abortError = new Error("caller cancelled during release");
		const solve = createAdapter(stub, 10).solve(
			AWS_CHALLENGE,
			undefined,
			controller.signal,
			recorder,
		);
		while (stub.state.contextCloseStarted === 0) await Promise.resolve();
		controller.abort(abortError);

		const outcome = await Promise.race([
			solve.catch((error: unknown) => error),
			new Promise<"too slow">((resolve) => setTimeout(() => resolve("too slow"), 100)),
		]);

		expect(outcome).toBe(abortError);
		expect(stub.state.contextCloseCalls).toBe(0);
		expect(trace.getSpans()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "resolver.vendor.cleanup",
					status: "error",
					attributes: expect.objectContaining({
						operation: "context.close",
						error_message: "Browser resolver cleanup exceeded 10ms",
					}),
				}),
			]),
		);
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

	it("classifies blocked navigation with the navigation and blocked request URLs", async () => {
		const redirectedUrl = "https://www.example.com/protected";
		const stub = createBrowserStub({
			blockedRequestUrl: redirectedUrl,
			gotoError: new Error(
				`page.goto: net::ERR_BLOCKED_BY_CLIENT at ${AWS_CHALLENGE.pageUrl}`,
			),
		});

		const error = await createAdapter(stub)
			.solve(AWS_CHALLENGE, undefined, new AbortController().signal)
			.catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({
			vendor: "browser",
			reason: "transport_failure",
			cause: {
				name: "BrowserNavigationBlockedError",
				code: "RESOLVER_BROWSER_NAVIGATION_BLOCKED",
				navigationUrl: AWS_CHALLENGE.pageUrl,
				blockedUrls: [redirectedUrl],
			},
		});
		expect(collectNestedStrings(error).join("\n")).toContain(
			`blocked 1 requests: [${redirectedUrl}]`,
		);
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

	it("keeps the human-puzzle error type distinct from unavailability without claiming adapter classification", () => {
		// The browser adapter intentionally does not infer a definitive verdict from a timeout.
		const verdict = new ResolverChallengeVerdictError("browser", "human_puzzle");

		expect(verdict).toMatchObject({ vendor: "browser", reason: "human_puzzle" });
		expect(verdict).not.toBeInstanceOf(ResolverVendorUnavailableError);
	});
});
