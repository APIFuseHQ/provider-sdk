import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { defineProvider } from "../../define.js";
import { createServerApp } from "../../server/serve.js";
import type { ProviderChallenge, ResolverContext } from "../../types.js";
import {
	APIFUSE__CDP_POOL__URL,
	APIFUSE__RESOLVER__2CAPTCHA__API_KEY,
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

	it("fails closed when the declared vendor chain is empty", async () => {
		await expect(
			createResolverClientFromEnv({ vendors: [], kinds: ["turnstile"] }, {}).solve(
				turnstileChallenge,
			),
		).rejects.toMatchObject({
			code: "RESOLVER_UNAVAILABLE",
			message: expect.stringContaining("chain is empty"),
		});
	});

	it("names the missing 2captcha credential", async () => {
		await expect(
			createResolverClientFromEnv({ vendors: ["2captcha"], kinds: ["turnstile"] }, {}).solve(
				turnstileChallenge,
			),
		).rejects.toMatchObject({
			code: "RESOLVER_UNAVAILABLE",
			message: expect.stringContaining(APIFUSE__RESOLVER__2CAPTCHA__API_KEY),
		});
	});

	it("makes browser available when the CDP pool URL is configured", async () => {
		await expect(
			createResolverClientFromEnv(
				{ vendors: ["browser"], kinds: ["turnstile"] },
				{ [APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test" },
			).solve(turnstileChallenge),
		).rejects.toMatchObject({
			code: "RESOLVER_NOT_IMPLEMENTED",
			message: expect.stringContaining("later phase"),
		});
	});

	it("makes browser unavailable when the CDP pool URL is missing", async () => {
		await expect(
			createResolverClientFromEnv({ vendors: ["browser"], kinds: ["turnstile"] }, {}).solve(
				turnstileChallenge,
			),
		).rejects.toMatchObject({
			code: "RESOLVER_UNAVAILABLE",
			message: expect.stringContaining(APIFUSE__CDP_POOL__URL),
		});
	});

	it("makes a partially resolved chain available", async () => {
		await expect(
			createResolverClientFromEnv(
				{ vendors: ["2captcha", "browser"], kinds: ["turnstile"] },
				{ [APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test" },
			).solve(turnstileChallenge),
		).rejects.toMatchObject({ code: "RESOLVER_NOT_IMPLEMENTED" });
	});

	it("treats custom as unavailable until it has a transport", async () => {
		await expect(
			createResolverClientFromEnv({ vendors: ["custom"], kinds: ["turnstile"] }, {}).solve(
				turnstileChallenge,
			),
		).rejects.toMatchObject({
			code: "RESOLVER_UNAVAILABLE",
			message: expect.stringContaining("no configured transport"),
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
			code: "RESOLVER_UNAVAILABLE",
			message: expect.stringContaining(APIFUSE__RESOLVER__2CAPTCHA__API_KEY),
		});
	});

	it.each(["abc", "-5", "0", "1e999", "12.5", "0x10", "1_000"])(
		"rejects malformed resolver timeout %p",
		(timeout) => {
			expect(() =>
				createResolverClientFromEnv(
					{ vendors: ["browser"], kinds: ["turnstile"] },
					{
						[APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test",
						[APIFUSE__RESOLVER__TIMEOUT_MS]: timeout,
					},
				),
			).toThrow("APIFUSE__RESOLVER__TIMEOUT_MS must be a positive integer");
		},
	);

	it("uses the default resolver timeout when the value is whitespace-only", async () => {
		await expect(
			createResolverClientFromEnv(
				{ vendors: ["browser"], kinds: ["turnstile"] },
				{
					[APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test",
					[APIFUSE__RESOLVER__TIMEOUT_MS]: "  ",
				},
			).solve(turnstileChallenge),
		).rejects.toMatchObject({
			code: "RESOLVER_NOT_IMPLEMENTED",
			details: { timeoutMs: 180_000 },
		});
	});

	it("uses the default resolver timeout when the variable is unset", async () => {
		await expect(
			createResolverClientFromEnv(
				{ vendors: ["browser"], kinds: ["turnstile"] },
				{ [APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test" },
			).solve(turnstileChallenge),
		).rejects.toMatchObject({
			code: "RESOLVER_NOT_IMPLEMENTED",
			details: { timeoutMs: 180_000 },
		});
	});

	it("carries a valid resolver timeout through to the client", async () => {
		await expect(
			createResolverClientFromEnv(
				{ vendors: ["browser"], kinds: ["turnstile"] },
				{
					[APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test",
					[APIFUSE__RESOLVER__TIMEOUT_MS]: "45000",
				},
			).solve(turnstileChallenge),
		).rejects.toMatchObject({
			code: "RESOLVER_NOT_IMPLEMENTED",
			details: { timeoutMs: 45_000 },
		});
	});
});

describe("resolver server wiring", () => {
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
