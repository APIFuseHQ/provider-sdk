import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { defineProvider } from "../../define.js";
import {
	createServerApp,
	swapResolverProxyConfigResolverForTests,
} from "../../server/serve.js";
import type { ProviderChallenge, ResolverContext } from "../../types.js";
import {
	APIFUSE__CDP_POOL__URL,
	APIFUSE__RESOLVER__2CAPTCHA__API_KEY,
	APIFUSE__RESOLVER__CAPSOLVER__API_KEY,
	APIFUSE__RESOLVER__TIMEOUT_MS,
	createResolverClientFromEnv,
	swapResolverAdapterFactoryForTests,
} from "../resolver.js";
import type { ResolverIdentity, ResolverVendorAdapter } from "../resolver-vendors/types.js";

const turnstileChallenge = {
	kind: "turnstile",
	siteKey: "site-key",
	pageUrl: "https://example.com/challenge",
} satisfies ProviderChallenge;

describe("resolver env availability", () => {
	it("fails closed when the provider does not declare resolver capability", async () => {
		await expect(
			createResolverClientFromEnv(undefined, {}).solve(turnstileChallenge),
		).rejects.toMatchObject({
			code: "RESOLVER_UNAVAILABLE",
			message: "Provider does not declare resolver capability",
		});
	});

	it("reports an empty declared vendor chain as unavailable, not kind-unsupported", async () => {
		const error = await createResolverClientFromEnv({ vendors: [], kinds: ["turnstile"] }, {})
			.solve(turnstileChallenge)
			.catch((cause) => cause);

		expect(error).toMatchObject({
			code: "RESOLVER_UNAVAILABLE",
			message: expect.stringContaining("vendor chain is empty"),
		});
		expect(error).not.toMatchObject({
			code: "RESOLVER_KIND_UNSUPPORTED_BY_CHAIN",
		});
	});

	it("gates undeclared kinds before reporting an empty vendor chain", async () => {
		await expect(
			createResolverClientFromEnv({ vendors: [], kinds: ["turnstile"] }, {}).solve({
				kind: "aws_waf",
				pageUrl: "https://example.com/challenge",
			}),
		).rejects.toMatchObject({
			code: "RESOLVER_KIND_NOT_DECLARED",
		});
	});

	it("reports a vendor without its credential as missing credentials", async () => {
		await expect(
			createResolverClientFromEnv({ vendors: ["2captcha"], kinds: ["turnstile"] }, {}).solve(
				turnstileChallenge,
			),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "2captcha", reason: "missing_credentials" }],
		});
	});

	it("reports the same vendor with its credential as not implemented", async () => {
		await expect(
			createResolverClientFromEnv(
				{ vendors: ["2captcha"], kinds: ["turnstile"] },
				{ [APIFUSE__RESOLVER__2CAPTCHA__API_KEY]: "sk-test" },
			).solve(turnstileChallenge),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "2captcha", reason: "not_implemented" }],
		});
	});

	it("reports an unsupported browser kind without CDP configuration", async () => {
		const error = await createResolverClientFromEnv(
			{ vendors: ["browser"], kinds: ["turnstile"] },
			{},
		)
			.solve(turnstileChallenge)
			.catch((cause) => cause);

		expect(error).toMatchObject({
			code: "RESOLVER_KIND_UNSUPPORTED_BY_CHAIN",
		});
		expect(error).not.toMatchObject({ code: "RESOLVER_CHAIN_EXHAUSTED" });
	});

	it("reports the same unsupported browser kind with CDP configuration", async () => {
		const error = await createResolverClientFromEnv(
			{ vendors: ["browser"], kinds: ["turnstile"] },
			{ [APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test" },
		)
			.solve(turnstileChallenge)
			.catch((cause) => cause);

		expect(error).toMatchObject({
			code: "RESOLVER_KIND_UNSUPPORTED_BY_CHAIN",
		});
		expect(error).not.toMatchObject({ code: "RESOLVER_CHAIN_EXHAUSTED" });
	});

	it("reports missing browser configuration for a supported kind", async () => {
		await expect(
			createResolverClientFromEnv({ vendors: ["browser"], kinds: ["aws_waf"] }, {}).solve({
				kind: "aws_waf",
				pageUrl: "https://example.com/challenge",
			}),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "browser", reason: "missing_credentials" }],
		});
	});

	it("reports mixed-chain availability reasons in attempt order", async () => {
		await expect(
			createResolverClientFromEnv(
				{ vendors: ["2captcha", "capsolver"], kinds: ["turnstile"] },
				{ [APIFUSE__RESOLVER__CAPSOLVER__API_KEY]: "sk-test" },
			).solve(turnstileChallenge),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [
				{ vendor: "2captcha", reason: "missing_credentials" },
				{ vendor: "capsolver", reason: "not_implemented" },
			],
		});
	});

	it("reports custom without a transport as missing transport", async () => {
		await expect(
			createResolverClientFromEnv({ vendors: ["custom"], kinds: ["turnstile"] }, {}).solve(
				turnstileChallenge,
			),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "custom", reason: "missing_transport" }],
		});
	});

	it("gates undeclared kinds before reporting missing vendor availability", async () => {
		const resolver = createResolverClientFromEnv(
			{ vendors: ["2captcha"], kinds: ["turnstile"] },
			{},
		);

		await expect(
			resolver.solve({ kind: "aws_waf", pageUrl: "https://example.com/challenge" }),
		).rejects.toMatchObject({
			code: "RESOLVER_KIND_NOT_DECLARED",
			message: expect.stringMatching(/aws_waf.*turnstile/),
			fix: expect.stringContaining("resolver.kinds"),
		});
	});

	it("treats whitespace-only credentials as missing", async () => {
		await expect(
			createResolverClientFromEnv(
				{ vendors: ["2captcha"], kinds: ["turnstile"] },
				{ [APIFUSE__RESOLVER__2CAPTCHA__API_KEY]: " \t " },
			).solve(turnstileChallenge),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "2captcha", reason: "missing_credentials" }],
		});
	});

	it.each([
		"abc",
		"-5",
		"0",
		"1e999",
		"12.5",
		"0x10",
		"1_000",
	])("rejects malformed resolver timeout %p", (timeout) => {
		expect(() =>
			createResolverClientFromEnv(
				{ vendors: ["browser"], kinds: ["turnstile"] },
				{
					[APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test",
					[APIFUSE__RESOLVER__TIMEOUT_MS]: timeout,
				},
			),
		).toThrow("APIFUSE__RESOLVER__TIMEOUT_MS must be a positive integer");
	});

	it("accepts a whitespace-only resolver timeout", async () => {
		await expect(
			createResolverClientFromEnv(
				{ vendors: ["browser"], kinds: ["aws_waf"] },
				{
					[APIFUSE__RESOLVER__TIMEOUT_MS]: "  ",
				},
			).solve({ kind: "aws_waf", pageUrl: "https://example.com/challenge" }),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "browser", reason: "missing_credentials" }],
		});
	});

	it("accepts an unset resolver timeout", async () => {
		await expect(
			createResolverClientFromEnv({ vendors: ["browser"], kinds: ["aws_waf"] }, {}).solve({
				kind: "aws_waf",
				pageUrl: "https://example.com/challenge",
			}),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "browser", reason: "missing_credentials" }],
		});
	});

	it("accepts a valid resolver timeout", async () => {
		await expect(
			createResolverClientFromEnv(
				{ vendors: ["browser"], kinds: ["aws_waf"] },
				{
					[APIFUSE__RESOLVER__TIMEOUT_MS]: "45000",
				},
			).solve({ kind: "aws_waf", pageUrl: "https://example.com/challenge" }),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "browser", reason: "missing_credentials" }],
		});
	});
});

describe("resolver server wiring", () => {
	it("passes a context-scoped production identity into the resolver factory", async () => {
		let calls = 0;
		const adapter: ResolverVendorAdapter = {
			id: "browser",
			supports: (kind) => kind === "cloudflare_interstitial",
			getIssuingIdentity(solution) {
				return solution.form === "cookies" ? { userAgent: solution.userAgent } : undefined;
			},
			async solve() {
				calls += 1;
				return {
					form: "cookies",
					cookies: { cf_clearance: `token-${calls}` },
					userAgent: "Server wiring browser/1.0",
					expires: (Date.now() + 60_000) / 1_000,
				};
			},
		};
		const originalCdpUrl = process.env[APIFUSE__CDP_POOL__URL];
		const restoreAdapter = swapResolverAdapterFactoryForTests("browser", () => adapter);
		process.env[APIFUSE__CDP_POOL__URL] = "ws://cdp-pool.test";
		try {
			const provider = defineProvider({
				id: "resolver-production-identity",
				version: "1.0.0",
				runtime: "standard",
				proxy: { mode: "optional", session: { affinity: "connection" } },
				resolver: { vendors: ["browser"], kinds: ["cloudflare_interstitial"] },
				meta: { displayName: "Resolver Production Identity", category: "test" },
				operations: {
					solve: {
						input: z.object({}),
						output: z.object({ first: z.string(), second: z.string() }),
						async handler(ctx) {
							const challenge = {
								kind: "cloudflare_interstitial",
								pageUrl: "https://example.com/challenge",
							} as const;
							const first = await ctx.resolver.solve(challenge);
							const second = await ctx.resolver.solve(challenge);
							if (first.form !== "cookies" || second.form !== "cookies") {
								throw new Error("Expected cookie solutions");
							}
							return {
								first: first.cookies.cf_clearance ?? "",
								second: second.cookies.cf_clearance ?? "",
							};
						},
						healthCheckUnsupported: { reason: "unit test" },
					},
				},
			});
			const app = createServerApp(provider, { logger: () => undefined });
			const request = (requestId: string) =>
				app.request("/v1/solve", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ requestId, connectionId: "connection-one", input: {} }),
				});

			const firstResponse = await request("req-resolver-identity-one");
			const secondResponse = await request("req-resolver-identity-two");

			expect(await firstResponse.json()).toMatchObject({
				data: { first: "token-1", second: "token-1" },
			});
			expect(await secondResponse.json()).toMatchObject({
				data: { first: "token-2", second: "token-2" },
			});
			expect(calls).toBe(2);
		} finally {
			restoreAdapter();
			if (originalCdpUrl === undefined) {
				delete process.env[APIFUSE__CDP_POOL__URL];
			} else {
				process.env[APIFUSE__CDP_POOL__URL] = originalCdpUrl;
			}
		}
	});

	it("resolves the server-owned proxy identity lazily for required operation and auth solves", async () => {
		const proxyUrl = "http://proxy-user:proxy-pass@proxy.test:8443";
		const userAgent =
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
		const identities: Array<ResolverIdentity | undefined> = [];
		const proxyResolutionInputs: Array<{
			readonly upstream?: unknown;
			readonly affinityKey?: string;
		}> = [];
		const adapter: ResolverVendorAdapter = {
			id: "2captcha",
			// Mirrors the production 2captcha adapter, which sends the identity as literal
			// proxy fields on the task and therefore satisfies a required policy.
			appliesProxyIdentity: true,
			supports: (kind) => kind === "turnstile",
			async solve(_challenge, identity) {
				identities.push(identity);
				return { form: "token", token: `solved-${identities.length}` };
			},
		};
		const originalApiKey = process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY];
		const restoreAdapter = swapResolverAdapterFactoryForTests("2captcha", () => adapter);
		const restoreProxyResolver = swapResolverProxyConfigResolverForTests(async (options) => {
			proxyResolutionInputs.push(options);
			return { shouldWarn: false, url: proxyUrl };
		});
		process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY] = "sk-test";
		try {
			const proxy = { mode: "required" } as const;
			const provider = defineProvider({
				id: "resolver-required-server-identity",
				version: "1.0.0",
				runtime: "standard",
				allowedHosts: ["example.com"],
				proxy,
				stealth: { profile: "chrome-146", platform: "macos" },
				resolver: { vendors: ["2captcha"], kinds: ["turnstile"] },
				meta: { displayName: "Resolver Required Server Identity", category: "test" },
				auth: {
					mode: "credentials",
					flow: {
						async start(ctx) {
							await ctx.resolver.solve(turnstileChallenge);
							return { kind: "message", turnId: "turn-1", data: { solved: true } };
						},
						async continue() {
							return { kind: "complete", turnId: "turn-2" };
						},
					},
				},
				operations: {
					solve: {
						input: z.object({}),
						output: z.object({ token: z.string() }),
						async handler(ctx) {
							const solution = await ctx.resolver.solve(turnstileChallenge);
							return { token: solution.form === "token" ? solution.token : "" };
						},
						healthCheckUnsupported: { reason: "unit test" },
					},
				},
			});
			const app = createServerApp(provider, { logger: () => undefined });

			const operationResponse = await app.request("/v1/solve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "req-required-server-identity",
					connectionId: "operation-connection",
					input: {},
				}),
			});
			const authResponse = await app.request("/auth/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "auth-required-server-identity",
					flowId: "flow-required-server-identity",
					connectionId: "auth-connection",
					tenantId: "tenant-required-server-identity",
					providerId: provider.id,
				}),
			});

			expect(operationResponse.status).toBe(200);
			expect(await operationResponse.json()).toMatchObject({ data: { token: "solved-1" } });
			expect(authResponse.status).toBe(200);
			expect(identities).toEqual([
				{ proxyUrl, userAgent },
				{ proxyUrl, userAgent },
			]);
			expect(proxyResolutionInputs).toEqual([
				{ upstream: { proxy }, affinityKey: "operation-connection", telemetry: expect.anything() },
				{ upstream: { proxy }, affinityKey: "auth-connection" },
			]);
		} finally {
			restoreProxyResolver();
			restoreAdapter();
			if (originalApiKey === undefined) {
				delete process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY];
			} else {
				process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY] = originalApiKey;
			}
		}
	});

	it("keeps a required provider without a stealth profile fail-closed", async () => {
		let adapterCalls = 0;
		let proxyResolutionCalls = 0;
		const adapter: ResolverVendorAdapter = {
			id: "2captcha",
			supports: (kind) => kind === "turnstile",
			async solve() {
				adapterCalls += 1;
				return { form: "token", token: "must-not-be-reached" };
			},
		};
		const originalApiKey = process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY];
		const restoreAdapter = swapResolverAdapterFactoryForTests("2captcha", () => adapter);
		const restoreProxyResolver = swapResolverProxyConfigResolverForTests(async () => {
			proxyResolutionCalls += 1;
			return { shouldWarn: false, url: "http://proxy.test:8080" };
		});
		process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY] = "sk-test";
		try {
			const provider = defineProvider({
				id: "resolver-required-without-stealth",
				version: "1.0.0",
				runtime: "standard",
				proxy: { mode: "required" },
				resolver: { vendors: ["2captcha"], kinds: ["turnstile"] },
				meta: { displayName: "Resolver Required Without Stealth", category: "test" },
				operations: {
					solve: {
						input: z.object({}),
						output: z.object({ token: z.string() }),
						async handler(ctx) {
							const solution = await ctx.resolver.solve(turnstileChallenge);
							return { token: solution.form === "token" ? solution.token : "" };
						},
						healthCheckUnsupported: { reason: "unit test" },
					},
				},
			});
			const response = await createServerApp(provider, { logger: () => undefined }).request(
				"/v1/solve",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ requestId: "req-no-stealth", input: {} }),
				},
			);

			expect(await response.json()).toMatchObject({
				error: {
					code: "RESOLVER_CHAIN_EXHAUSTED",
					details: [{ vendor: "2captcha", reason: "missing_proxy_identity" }],
				},
			});
			expect(adapterCalls).toBe(0);
			expect(proxyResolutionCalls).toBe(0);
		} finally {
			restoreProxyResolver();
			restoreAdapter();
			if (originalApiKey === undefined) {
				delete process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY];
			} else {
				process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY] = originalApiKey;
			}
		}
	});

	it("keeps a required provider fail-closed when proxy resolution yields no URL", async () => {
		let adapterCalls = 0;
		let proxyResolutionCalls = 0;
		const adapter: ResolverVendorAdapter = {
			id: "2captcha",
			supports: (kind) => kind === "turnstile",
			async solve() {
				adapterCalls += 1;
				return { form: "token", token: "must-not-be-reached" };
			},
		};
		const originalApiKey = process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY];
		const restoreAdapter = swapResolverAdapterFactoryForTests("2captcha", () => adapter);
		const restoreProxyResolver = swapResolverProxyConfigResolverForTests(async () => {
			proxyResolutionCalls += 1;
			return { shouldWarn: false };
		});
		process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY] = "sk-test";
		try {
			const provider = defineProvider({
				id: "resolver-required-without-proxy-url",
				version: "1.0.0",
				runtime: "standard",
				proxy: { mode: "required" },
				stealth: { profile: "chrome-146", platform: "macos" },
				resolver: { vendors: ["2captcha"], kinds: ["turnstile"] },
				meta: { displayName: "Resolver Required Without Proxy URL", category: "test" },
				operations: {
					solve: {
						input: z.object({}),
						output: z.object({ token: z.string() }),
						async handler(ctx) {
							const solution = await ctx.resolver.solve(turnstileChallenge);
							return { token: solution.form === "token" ? solution.token : "" };
						},
						healthCheckUnsupported: { reason: "unit test" },
					},
				},
			});
			const response = await createServerApp(provider, { logger: () => undefined }).request(
				"/v1/solve",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ requestId: "req-no-proxy-url", input: {} }),
				},
			);

			expect(await response.json()).toMatchObject({
				error: {
					code: "RESOLVER_CHAIN_EXHAUSTED",
					details: [{ vendor: "2captcha", reason: "missing_proxy_identity" }],
				},
			});
			expect(adapterCalls).toBe(0);
			expect(proxyResolutionCalls).toBe(1);
		} finally {
			restoreProxyResolver();
			restoreAdapter();
			if (originalApiKey === undefined) {
				delete process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY];
			} else {
				process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY] = originalApiKey;
			}
		}
	});

	it("leaves an optional-policy provider unaffected when proxy resolution yields no URL", async () => {
		const identities: Array<ResolverIdentity | undefined> = [];
		let proxyResolutionCalls = 0;
		const adapter: ResolverVendorAdapter = {
			id: "2captcha",
			supports: (kind) => kind === "turnstile",
			async solve(_challenge, identity) {
				identities.push(identity);
				return { form: "token", token: "optional-solved" };
			},
		};
		const originalApiKey = process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY];
		const restoreAdapter = swapResolverAdapterFactoryForTests("2captcha", () => adapter);
		const restoreProxyResolver = swapResolverProxyConfigResolverForTests(async () => {
			proxyResolutionCalls += 1;
			return { shouldWarn: false };
		});
		process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY] = "sk-test";
		try {
			const provider = defineProvider({
				id: "resolver-optional-without-proxy-url",
				version: "1.0.0",
				runtime: "standard",
				proxy: { mode: "optional" },
				stealth: { profile: "chrome-146", platform: "macos" },
				resolver: { vendors: ["2captcha"], kinds: ["turnstile"] },
				meta: { displayName: "Resolver Optional Without Proxy URL", category: "test" },
				operations: {
					solve: {
						input: z.object({}),
						output: z.object({ token: z.string() }),
						async handler(ctx) {
							const solution = await ctx.resolver.solve(turnstileChallenge);
							return { token: solution.form === "token" ? solution.token : "" };
						},
						healthCheckUnsupported: { reason: "unit test" },
					},
				},
			});
			const response = await createServerApp(provider, { logger: () => undefined }).request(
				"/v1/solve",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ requestId: "req-optional-no-proxy-url", input: {} }),
				},
			);

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ data: { token: "optional-solved" } });
			expect(identities).toEqual([undefined]);
			expect(proxyResolutionCalls).toBe(1);
		} finally {
			restoreProxyResolver();
			restoreAdapter();
			if (originalApiKey === undefined) {
				delete process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY];
			} else {
				process.env[APIFUSE__RESOLVER__2CAPTCHA__API_KEY] = originalApiKey;
			}
		}
	});

	it("does not resolve the identity during plain provider context construction", async () => {
		let proxyResolutionCalls = 0;
		const restoreProxyResolver = swapResolverProxyConfigResolverForTests(async () => {
			proxyResolutionCalls += 1;
			return { shouldWarn: false, url: "http://proxy.test:8080" };
		});
		try {
			const provider = defineProvider({
				id: "resolver-identity-lazy-context",
				version: "1.0.0",
				runtime: "standard",
				proxy: { mode: "required" },
				stealth: { profile: "chrome-146", platform: "macos" },
				resolver: { vendors: ["2captcha"], kinds: ["turnstile"] },
				meta: { displayName: "Resolver Identity Lazy Context", category: "test" },
				operations: {
					plain: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheckUnsupported: { reason: "unit test" },
					},
				},
			});
			const response = await createServerApp(provider, { logger: () => undefined }).request(
				"/v1/plain",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ requestId: "req-plain-context", input: {} }),
				},
			);

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ data: { ok: true } });
			expect(proxyResolutionCalls).toBe(0);
		} finally {
			restoreProxyResolver();
		}
	});

	it("fails closed at the server boundary when a required proxy policy has no identity", async () => {
		let calls = 0;
		const adapter: ResolverVendorAdapter = {
			id: "browser",
			supports: (kind) => kind === "cloudflare_interstitial",
			async solve() {
				calls += 1;
				return {
					form: "cookies",
					cookies: { cf_clearance: "must-not-be-reached" },
					userAgent: "Server wiring browser/1.0",
					expires: (Date.now() + 60_000) / 1_000,
				};
			},
		};
		const originalCdpUrl = process.env[APIFUSE__CDP_POOL__URL];
		const restoreAdapter = swapResolverAdapterFactoryForTests("browser", () => adapter);
		process.env[APIFUSE__CDP_POOL__URL] = "ws://cdp-pool.test";
		try {
			const provider = defineProvider({
				id: "resolver-required-proxy-policy",
				version: "1.0.0",
				runtime: "standard",
				proxy: { mode: "required" },
				resolver: { vendors: ["browser"], kinds: ["cloudflare_interstitial"] },
				meta: { displayName: "Resolver Required Proxy Policy", category: "test" },
				operations: {
					solve: {
						input: z.object({}),
						output: z.object({ token: z.string() }),
						async handler(ctx) {
							const solution = await ctx.resolver.solve({
								kind: "cloudflare_interstitial",
								pageUrl: "https://example.com/challenge",
							});
							return { token: solution.form === "cookies" ? "solved" : "other" };
						},
						healthCheckUnsupported: { reason: "unit test" },
					},
				},
			});
			const app = createServerApp(provider, { logger: () => undefined });
			const response = await app.request("/v1/solve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "req-required-proxy-policy",
					connectionId: "connection-one",
					input: {},
				}),
			});

			expect(await response.json()).toMatchObject({
				error: { code: "RESOLVER_CHAIN_EXHAUSTED" },
			});
			expect(calls).toBe(0);
		} finally {
			restoreAdapter();
			if (originalCdpUrl === undefined) {
				delete process.env[APIFUSE__CDP_POOL__URL];
			} else {
				process.env[APIFUSE__CDP_POOL__URL] = originalCdpUrl;
			}
		}
	});

	it("fails closed in an auth flow when a required proxy policy has no identity", async () => {
		let calls = 0;
		const adapter: ResolverVendorAdapter = {
			id: "browser",
			supports: (kind) => kind === "cloudflare_interstitial",
			async solve() {
				calls += 1;
				return {
					form: "cookies",
					cookies: { cf_clearance: "must-not-be-reached" },
					userAgent: "Auth flow browser/1.0",
					expires: (Date.now() + 60_000) / 1_000,
				};
			},
		};
		const originalCdpUrl = process.env[APIFUSE__CDP_POOL__URL];
		const restoreAdapter = swapResolverAdapterFactoryForTests("browser", () => adapter);
		process.env[APIFUSE__CDP_POOL__URL] = "ws://cdp-pool.test";
		try {
			const provider = defineProvider({
				id: "resolver-required-proxy-auth-flow",
				version: "1.0.0",
				runtime: "standard",
				proxy: { mode: "required" },
				resolver: { vendors: ["browser"], kinds: ["cloudflare_interstitial"] },
				meta: { displayName: "Resolver Required Proxy Auth Flow", category: "test" },
				auth: {
					mode: "credentials",
					flow: {
						async start(ctx) {
							await ctx.resolver.solve({
								kind: "cloudflare_interstitial",
								pageUrl: "https://example.com/challenge",
							});
							return { kind: "message", turnId: "turn-1", data: { solved: true } };
						},
						async continue() {
							return { kind: "complete", turnId: "turn-2" };
						},
					},
				},
				operations: {
					unused: {
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheckUnsupported: { reason: "unit test" },
					},
				},
			});
			const app = createServerApp(provider, { logger: () => undefined });
			const response = await app.request("/auth/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requestId: "auth-required-proxy-policy",
					flowId: "flow-required-proxy-policy",
					tenantId: "tenant-required-proxy-policy",
					providerId: "resolver-required-proxy-auth-flow",
				}),
			});

			expect(response.status).toBe(500);
			expect(await response.json()).toMatchObject({
				error: {
					code: "RESOLVER_CHAIN_EXHAUSTED",
					details: [{ vendor: "browser", reason: "missing_proxy_identity" }],
				},
			});
			expect(calls).toBe(0);
		} finally {
			restoreAdapter();
			if (originalCdpUrl === undefined) {
				delete process.env[APIFUSE__CDP_POOL__URL];
			} else {
				process.env[APIFUSE__CDP_POOL__URL] = originalCdpUrl;
			}
		}
	});

	it("threads defineProvider resolver declarations into the server without an override", async () => {
		const declaration = { vendors: ["custom"], kinds: ["turnstile"] } as const;
		const provider = defineProvider({
			id: "resolver-authoring-path",
			version: "1.0.0",
			runtime: "standard",
			resolver: declaration,
			meta: { displayName: "Resolver Authoring Path", category: "test" },
			operations: {
				solve: {
					input: z.object({ kind: z.enum(["turnstile", "aws_waf"]) }),
					output: z.object({ ok: z.boolean() }),
					async handler(ctx, input) {
						const challenge: ProviderChallenge =
							input.kind === "turnstile"
								? turnstileChallenge
								: { kind: "aws_waf", pageUrl: "https://example.com/challenge" };
						await ctx.resolver.solve(challenge);
						return { ok: true };
					},
					healthCheckUnsupported: { reason: "unit test" },
				},
			},
		});
		const app = createServerApp(provider, { logger: () => undefined });

		const vendorResponse = await app.request("/v1/solve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-declared-vendor", input: { kind: "turnstile" } }),
		});
		expect(vendorResponse.status).toBe(500);
		expect(await vendorResponse.json()).toMatchObject({
			error: {
				code: "RESOLVER_CHAIN_EXHAUSTED",
				message: `Resolver vendor chain exhausted: ${declaration.vendors[0]}: missing_transport`,
				details: declaration.vendors.map((vendor) => ({ vendor, reason: "missing_transport" })),
			},
		});

		const kindResponse = await app.request("/v1/solve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-declared-kind", input: { kind: "aws_waf" } }),
		});
		expect(kindResponse.status).toBe(500);
		expect(await kindResponse.json()).toMatchObject({
			error: {
				code: "RESOLVER_KIND_NOT_DECLARED",
				message: `Resolver kind "aws_waf" is not declared; declared kinds: ${declaration.kinds.join(", ")}`,
			},
		});
		expect(provider.resolver).toBe(declaration);
	});

	it("keeps undeclared providers on the unsupported resolver client", async () => {
		const provider = defineProvider({
			id: "resolver-undeclared",
			version: "1.0.0",
			runtime: "standard",
			meta: { displayName: "Resolver Undeclared", category: "test" },
			operations: {
				solve: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					async handler(ctx) {
						await ctx.resolver.solve(turnstileChallenge);
						return { ok: true };
					},
					healthCheckUnsupported: { reason: "unit test" },
				},
			},
		});
		const app = createServerApp(provider, { logger: () => undefined });

		expect(provider.resolver).toBeUndefined();
		const response = await app.request("/v1/solve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-undeclared-resolver", input: {} }),
		});
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			error: {
				code: "RESOLVER_UNAVAILABLE",
				message: "Provider does not declare resolver capability",
			},
		});
	});

	it("injects the resolver override into operation and auth contexts", async () => {
		const resolverSignals: (AbortSignal | undefined)[] = [];
		const resolver: ResolverContext = {
			async solve(_challenge, signal) {
				resolverSignals.push(signal);
				return { form: "token", token: "override-token" };
			},
		};
		const provider = defineProvider({
			id: "resolver-server-demo",
			version: "1.0.0",
			runtime: "standard",
			resolver: { vendors: ["browser"], kinds: ["turnstile"] },
			meta: { displayName: "Resolver Server Demo", category: "test" },
			context: { keys: [] },
			auth: {
				mode: "credentials",
				flow: {
					async start(ctx) {
						const solution = await ctx.resolver.solve(turnstileChallenge);
						return {
							kind: "message",
							turnId: "turn-1",
							data: { form: solution.form },
						};
					},
					async continue() {
						return { kind: "complete", turnId: "turn-2" };
					},
				},
			},
			operations: {
				solve: {
					input: z.object({}),
					output: z.object({ token: z.string() }),
					async handler(ctx) {
						const solution = await ctx.resolver.solve(turnstileChallenge);
						return { token: solution.form === "token" ? solution.token : "" };
					},
					healthCheckUnsupported: { reason: "unit test" },
				},
			},
		});
		const app = createServerApp(provider, { resolver });
		const operationController = new AbortController();

		const operationResponse = await app.request("/v1/solve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-1", input: {} }),
			signal: operationController.signal,
		});
		expect(await operationResponse.json()).toEqual({ data: { token: "override-token" } });

		const authController = new AbortController();
		const authResponse = await app.request("/auth/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: "auth-req-1",
				flowId: "flow-1",
				tenantId: "tenant-1",
				providerId: "resolver-server-demo",
			}),
			signal: authController.signal,
		});
		expect(await authResponse.json()).toMatchObject({ data: { data: { form: "token" } } });
		expect(resolverSignals).toEqual([operationController.signal, authController.signal]);
	});
});
