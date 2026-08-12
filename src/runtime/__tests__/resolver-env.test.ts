import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { defineProvider } from "../../define.js";
import { createServerApp } from "../../server/serve.js";
import type { ProviderChallenge, ResolverContext } from "../../types.js";
import {
	APIFUSE__CDP_POOL__URL,
	APIFUSE__RESOLVER__2CAPTCHA__API_KEY,
	APIFUSE__RESOLVER__CAPSOLVER__API_KEY,
	APIFUSE__RESOLVER__TIMEOUT_MS,
	createResolverClientFromEnv,
} from "../resolver.js";

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
		const resolver: ResolverContext = {
			async solve() {
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

		const operationResponse = await app.request("/v1/solve", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-1", input: {} }),
		});
		expect(await operationResponse.json()).toEqual({ data: { token: "override-token" } });

		const authResponse = await app.request("/auth/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: "auth-req-1",
				flowId: "flow-1",
				tenantId: "tenant-1",
				providerId: "resolver-server-demo",
			}),
		});
		expect(await authResponse.json()).toMatchObject({ data: { data: { form: "token" } } });
	});
});
