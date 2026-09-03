import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { defineProvider } from "../../define.js";
import { createServerApp } from "../../server/serve.js";
import type { ProviderChallenge, ProviderContext, ResolverContext } from "../../types.js";
import { getStealthProfile } from "../../stealth/profiles.js";
import { PROVIDER_TELEMETRY_HEADER } from "../proxy-telemetry.js";
import { NODEMAVEN_PASSWORD_ENV, NODEMAVEN_USERNAME_ENV } from "../proxy-nodemaven.js";
import {
	APIFUSE__CDP_POOL__URL,
	APIFUSE__RESOLVER__2CAPTCHA__API_KEY,
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

const resolverAuthoringInputSchema = z.object({
	kind: z.enum(["turnstile", "aws_waf"]),
});
type ResolverAuthoringInput = z.infer<typeof resolverAuthoringInputSchema>;

function installNodemavenTestCredentials(): () => void {
	const originalUsername = process.env[NODEMAVEN_USERNAME_ENV];
	const originalPassword = process.env[NODEMAVEN_PASSWORD_ENV];
	process.env[NODEMAVEN_USERNAME_ENV] = "resolver-server-account";
	process.env[NODEMAVEN_PASSWORD_ENV] = "resolver-server-password";
	return () => {
		if (originalUsername === undefined) delete process.env[NODEMAVEN_USERNAME_ENV];
		else process.env[NODEMAVEN_USERNAME_ENV] = originalUsername;
		if (originalPassword === undefined) delete process.env[NODEMAVEN_PASSWORD_ENV];
		else process.env[NODEMAVEN_PASSWORD_ENV] = originalPassword;
	};
}

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

	it("reaches the configured vendor once its credential is present", async () => {
		await expect(
			createResolverClientFromEnv(
				{ vendors: ["2captcha"], kinds: ["turnstile"] },
				{ [APIFUSE__RESOLVER__2CAPTCHA__API_KEY]: "sk-test" },
				{ allowedHosts: ["example.com"] },
			).solve(turnstileChallenge),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "2captcha", reason: "transport_failure" }],
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

	it("reports mixed-chain missing credentials in attempt order", async () => {
		await expect(
			createResolverClientFromEnv(
				{ vendors: ["2captcha", "capsolver"], kinds: ["turnstile"] },
				{},
			).solve(turnstileChallenge),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [
				{ vendor: "2captcha", reason: "missing_credentials" },
				{ vendor: "capsolver", reason: "missing_credentials" },
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
				return solution.form === "cookies" && "cookies" in solution
					? { userAgent: solution.userAgent }
					: undefined;
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
				meta: {
					displayName: "Resolver Production Identity",
					descriptionKey: "resolver-production-identity.description",
					category: "test",
				},
			})({ operations: {
					solve: {
						riskClass: "read",
						input: z.object({}),
						output: z.object({ first: z.string(), second: z.string() }),
						async handler(ctx) {
							const challenge = {
								kind: "cloudflare_interstitial",
								pageUrl: "https://example.com/challenge",
							} as const;
							const first = await ctx.resolver.solve(challenge);
							const second = await ctx.resolver.solve(challenge);
							if (
								first.form !== "cookies" ||
								!("cookies" in first) ||
								second.form !== "cookies" ||
								!("cookies" in second)
							) {
								throw new Error("Expected cookie solutions");
							}
							return {
								first: first.cookies.cf_clearance ?? "",
								second: second.cookies.cf_clearance ?? "",
							};
						},
						healthCheckUnsupported: { reason: "unit test" },
					},
				} });
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

	it("passes a server-owned proxy identity through the operation context", async () => {
		const identities: Array<ResolverIdentity | undefined> = [];
		const adapter: ResolverVendorAdapter = {
			id: "browser",
			supports: (kind) => kind === "cloudflare_interstitial",
			async solve(_challenge, identity) {
				identities.push(identity);
				return {
					form: "cookies",
					cookies: { cf_clearance: "operation-server-owned-identity" },
					userAgent: "Server wiring browser/1.0",
					expires: (Date.now() + 60_000) / 1_000,
				};
			},
		};
		const originalCdpUrl = process.env[APIFUSE__CDP_POOL__URL];
		const restoreAdapter = swapResolverAdapterFactoryForTests("browser", () => adapter);
		const restoreProxyCredentials = installNodemavenTestCredentials();
		process.env[APIFUSE__CDP_POOL__URL] = "ws://cdp-pool.test";
		try {
			const provider = defineProvider({
				id: "resolver-required-proxy-policy",
				version: "1.0.0",
				runtime: "standard",
				stealth: { browser: "chrome", os: "macos" },
				proxy: { mode: "required", providers: ["nodemaven"] },
				resolver: { vendors: ["browser"], kinds: ["cloudflare_interstitial"] },
				meta: {
					displayName: "Resolver Required Proxy Policy",
					descriptionKey: "resolver-required-proxy-policy.description",
					category: "test",
				},
			})({ operations: {
					solve: {
						riskClass: "read",
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
				} });
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

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				data: { token: "solved" },
			});
			expect(identities).toEqual([
				{
					proxyUrl: expect.stringMatching(/^http:\/\/resolver-server-account-/),
					userAgent: getStealthProfile({ browser: "chrome", os: "macos" }).userAgent,
				},
			]);
		} finally {
			restoreAdapter();
			restoreProxyCredentials();
			if (originalCdpUrl === undefined) {
				delete process.env[APIFUSE__CDP_POOL__URL];
			} else {
				process.env[APIFUSE__CDP_POOL__URL] = originalCdpUrl;
			}
		}
	});

	it("passes a server-owned proxy identity through the auth-flow context", async () => {
		const { APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY } = await import("../egress-lease.js");
		const identities: Array<ResolverIdentity | undefined> = [];
		const adapter: ResolverVendorAdapter = {
			id: "browser",
			supports: (kind) => kind === "cloudflare_interstitial",
			async solve(_challenge, identity) {
				identities.push(identity);
				return {
					form: "cookies",
					cookies: { cf_clearance: "auth-server-owned-identity" },
					userAgent: "Auth flow browser/1.0",
					expires: (Date.now() + 60_000) / 1_000,
				};
			},
		};
		const originalCdpUrl = process.env[APIFUSE__CDP_POOL__URL];
		const originalLeaseKey = process.env[APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY];
		const restoreAdapter = swapResolverAdapterFactoryForTests("browser", () => adapter);
		const restoreProxyCredentials = installNodemavenTestCredentials();
		process.env[APIFUSE__CDP_POOL__URL] = "ws://cdp-pool.test";
		process.env[APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY] = "resolver-auth-fixture-key";
		try {
			const provider = defineProvider({
				id: "resolver-required-proxy-auth-flow",
				version: "1.0.0",
				runtime: "standard",
				stealth: { browser: "chrome", os: "macos" },
				proxy: { mode: "required", providers: ["nodemaven"] },
				resolver: { vendors: ["browser"], kinds: ["cloudflare_interstitial"] },
				meta: {
					displayName: "Resolver Required Proxy Auth Flow",
					descriptionKey: "resolver-required-proxy-auth-flow.description",
					category: "test",
				},
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
			})({ operations: {
					unused: {
						riskClass: "read",
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						async handler() {
							return { ok: true };
						},
						healthCheckUnsupported: { reason: "unit test" },
					},
				} });
			const events: import("../../server/serve.js").ProviderServerLogEvent[] = [];
			const app = createServerApp(provider, { logger: (event) => events.push(event) });
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

			expect(response.status).toBe(200);
			const telemetryHeader = response.headers.get(PROVIDER_TELEMETRY_HEADER);
			expect(telemetryHeader).toBeTruthy();
			const decodedTelemetry = JSON.parse(
				Buffer.from(telemetryHeader ?? "", "base64url").toString("utf8"),
			);
			const authLog = events.find(
				(event) => event.event === "provider_request_completed" && event.kind === "auth",
			);
			expect(authLog && "proxy" in authLog ? authLog.proxy : undefined).toEqual(
				decodedTelemetry.proxy,
			);
			expect(await response.json()).toMatchObject({
				data: { data: { solved: true } },
			});
			expect(identities).toEqual([
				{
					proxyUrl: expect.stringMatching(/^http:\/\/resolver-server-account-/),
					userAgent: getStealthProfile({ browser: "chrome", os: "macos" }).userAgent,
				},
			]);
		} finally {
			restoreAdapter();
			restoreProxyCredentials();
			if (originalCdpUrl === undefined) {
				delete process.env[APIFUSE__CDP_POOL__URL];
			} else {
				process.env[APIFUSE__CDP_POOL__URL] = originalCdpUrl;
			}
			if (originalLeaseKey === undefined) {
				delete process.env[APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY];
			} else {
				process.env[APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY] = originalLeaseKey;
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
			meta: {
				displayName: "Resolver Authoring Path",
				descriptionKey: "resolver-authoring-path.description",
				category: "test",
			},
		})({ operations: {
				solve: {
					riskClass: "read",
					input: resolverAuthoringInputSchema,
					output: z.object({ ok: z.boolean() }),
					async handler(ctx, input: ResolverAuthoringInput) {
						const { kind } = input;
						const challenge: ProviderChallenge =
							kind === "turnstile"
								? turnstileChallenge
								: { kind: "aws_waf", pageUrl: "https://example.com/challenge" };
						await ctx.resolver.solve(challenge);
						return { ok: true };
					},
					healthCheckUnsupported: { reason: "unit test" },
				},
			} });
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

	it("fails closed when an undeclared provider accesses the resolver", async () => {
		const provider = defineProvider({
			id: "resolver-undeclared",
			version: "1.0.0",
			runtime: "standard",
			meta: {
				displayName: "Resolver Undeclared",
				descriptionKey: "resolver-undeclared.description",
				category: "test",
			},
		})({ operations: {
				solve: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					async handler(ctx) {
						await (ctx as ProviderContext).resolver.solve(turnstileChallenge);
						return { ok: true };
					},
					healthCheckUnsupported: { reason: "unit test" },
				},
			} });
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
				code: "PROVIDER_CAPABILITY_UNDECLARED",
				message: expect.stringContaining('undeclared capability "resolver"'),
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
			meta: {
				displayName: "Resolver Server Demo",
				descriptionKey: "resolver-server-demo.description",
				category: "test",
			},
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
		})({ operations: {
				solve: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({ token: z.string() }),
					async handler(ctx) {
						const solution = await ctx.resolver.solve(turnstileChallenge);
						return { token: solution.form === "token" ? solution.token : "" };
					},
					healthCheckUnsupported: { reason: "unit test" },
				},
			} });
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
