import { describe, expect, it } from "bun:test";

import type {
	ChallengeSolution,
	ProviderCache,
	ProviderChallenge,
	ProviderContext,
	ProviderResolverVendor,
	ResolverContext,
} from "../../types.js";
import { createProviderCache } from "../cache.js";
import { wrapWithInstrumentation } from "../instrumentation.js";
import { spansToOTLP } from "../otlp.js";
import { createResolverClient, invalidateResolverSolution } from "../resolver.js";
import type { ResolverVendorAdapter } from "../resolver-vendors/types.js";
import { ResolverVendorUnavailableError } from "../resolver-vendors/types.js";
import { createTraceContext, getTraceRecorder } from "../trace.js";

const CHALLENGE = {
	kind: "aws_waf",
	pageUrl: "https://example.com/protected",
} satisfies ProviderChallenge;

function adapter(
	id: ProviderResolverVendor,
	solve: () => Promise<ChallengeSolution>,
): ResolverVendorAdapter {
	return {
		id,
		supports: () => true,
		async solve() {
			return await solve();
		},
	};
}

function instrumentResolver(resolver: ResolverContext) {
	const trace = createTraceContext();
	return wrapWithInstrumentation({ trace, resolver } as unknown as ProviderContext);
}

describe("resolver tracing", () => {
	it("records a degraded vendor attempt when failover succeeds", async () => {
		const solution = { form: "token", token: "fallback-solution" } as const;
		const resolver = createResolverClient({
			kinds: ["aws_waf"],
			adapters: [
				adapter("browser", async () => {
					throw new ResolverVendorUnavailableError("browser", "allocation_exhausted");
				}),
				adapter("capsolver", async () => solution),
			],
		});
		const instrumented = instrumentResolver(resolver);

		await expect(instrumented.resolver.solve(CHALLENGE)).resolves.toBe(solution);

		const spans = instrumented.trace.getSpans();
		const attempts = spans.filter((span) => span.name === "resolver.vendor.attempt");
		expect(spans.map((span) => span.name)).toEqual([
			"resolver.solve",
			"resolver.vendor.attempt",
			"resolver.vendor.attempt",
		]);
		expect(attempts[0]).toMatchObject({
			parentId: spans[0]?.id,
			status: "error",
			attributes: {
				vendor: "browser",
				challenge_kind: "aws_waf",
				unavailability_reason: "allocation_exhausted",
			},
		});
		expect(attempts[1]).toMatchObject({
			parentId: spans[0]?.id,
			status: "ok",
			attributes: {
				vendor: "capsolver",
				challenge_kind: "aws_waf",
			},
		});

		const exportedAttempts = spansToOTLP(spans).resourceSpans[0]?.scopeSpans[0]?.spans.filter(
			(span) => span.name === "resolver.vendor.attempt",
		);
		expect(exportedAttempts?.[0]).toMatchObject({ status: { code: 2 } });
		expect(exportedAttempts?.[0]?.attributes).toEqual(
			expect.arrayContaining([
				{ key: "vendor", value: { stringValue: "browser" } },
				{ key: "challenge_kind", value: { stringValue: "aws_waf" } },
				{
					key: "unavailability_reason",
					value: { stringValue: "allocation_exhausted" },
				},
			]),
		);
	});

	it("keeps a resolver operational when the input context has no trace recorder", async () => {
		const solution = { form: "token", token: "direct-solution" } as const;
		const resolver = createResolverClient({
			kinds: ["aws_waf"],
			adapters: [adapter("browser", async () => solution)],
		});
		const context = { trace: {}, resolver } as unknown as ProviderContext;
		expect(getTraceRecorder(context.trace)).toBeNull();
		const instrumented = wrapWithInstrumentation(context);

		await expect(instrumented.resolver.solve(CHALLENGE)).resolves.toBe(solution);
	});

	it("records sanitized transport failure context on spans and exhausted attempts", async () => {
		const secrets = [
			"ABCK_SECRET_VALUE",
			"BMSZ_SECRET_VALUE",
			"AWS_WAF_SECRET_VALUE",
			"eyJhbGciOiJIUzI1NiJ9.bearer-secret-payload",
			"proxy-user",
			"proxy-password-must-not-leak",
		];
		const cause = new Error(
			`connect ETIMEDOUT at https://${secrets[4]}:${secrets[5]}@proxy.example.com/private _abck=${secrets[0]} bm_sz=${secrets[1]} aws-waf-token=${secrets[2]} Bearer ${secrets[3]}`,
		);
		cause.name = "TlsError";
		const resolver = createResolverClient({
			clientProfile: "safari17_0",
			kinds: ["akamai_sensor"],
			adapters: [
				{
					id: "custom",
					supports: (kind) => kind === "akamai_sensor",
					async solve() {
						throw new ResolverVendorUnavailableError("custom", "transport_failure", {
							cause,
							upstreamHost: "sensor.example.com",
							phase: "post_sensor",
							round: 2,
						});
					},
				},
			],
		});
		const instrumented = instrumentResolver(resolver);
		const error = await instrumented.resolver
			.solve({
				kind: "akamai_sensor",
				pageUrl: "https://sensor.example.com/challenge",
				scriptUrl: "https://sensor.example.com/sensor.js",
			})
			.catch((error: unknown) => error);
		const attempt = instrumented.trace
			.getSpans()
			.find((span) => span.name === "resolver.vendor.attempt");

		expect(attempt).toMatchObject({
			status: "error",
			attributes: {
				vendor: "custom",
				challenge_kind: "akamai_sensor",
				client_profile: "safari17_0",
				unavailability_reason: "transport_failure",
				cause_name: "TlsError",
				cause_message: "connect ETIMEDOUT at [REDACTED_PROXY_URL] [REDACTED]",
				upstream_host: "sensor.example.com",
				transport_phase: "post_sensor",
				transport_round: 2,
			},
		});
		expect(error).toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [
				{
					vendor: "custom",
					reason: "transport_failure",
					cause: {
						name: "TlsError",
						message: "connect ETIMEDOUT at [REDACTED_PROXY_URL] [REDACTED]",
					},
					upstreamHost: "sensor.example.com",
					phase: "post_sensor",
					round: 2,
				},
			],
		});
		const diagnostics = JSON.stringify({ attempt, details: error.details });
		for (const secret of secrets) expect(diagnostics).not.toContain(secret);
		expect(diagnostics).toContain("connect ETIMEDOUT");
	});

	it("invalidates a cached solution through an instrumented resolver wrapper", async () => {
		const innerCache = createProviderCache({
			providerId: `resolver-trace-invalidation-${crypto.randomUUID()}`,
			redisUrl: "",
		});
		const cache: ProviderCache = {
			key: (namespace, parts, options) => innerCache.key(namespace, parts, options),
			get: (key) => innerCache.get(key),
			set: (key, value, options) => innerCache.set(key, value, options),
			delete: (key) => innerCache.delete(key),
			getOrSet: (key, loader, options) => innerCache.getOrSet(key, loader, options),
			responseMeta: () => innerCache.responseMeta(),
		};
		let vendorCalls = 0;
		const browserAdapter: ResolverVendorAdapter = {
			id: "browser",
			supports: (kind) => kind === "aws_waf",
			getIssuingIdentity(solution) {
				return solution.form === "cookies" ? { userAgent: solution.userAgent } : undefined;
			},
			async solve() {
				vendorCalls += 1;
				return {
					form: "cookies",
					cookies: { "aws-waf-token": `vendor-token-${vendorCalls}` },
					expires: (Date.now() + 60_000) / 1_000,
					userAgent: "Instrumented Browser/1.0",
				};
			},
		};
		const rawResolver = createResolverClient({
			adapters: [browserAdapter],
			cache,
			kinds: ["aws_waf"],
		});
		const instrumented = instrumentResolver(rawResolver);

		const first = await instrumented.resolver.solve(CHALLENGE);
		const cached = await instrumented.resolver.solve(CHALLENGE);
		expect(cached).toEqual(first);
		expect(vendorCalls).toBe(1);

		await invalidateResolverSolution(instrumented.resolver, CHALLENGE, first);
		const refreshed = await instrumented.resolver.solve(CHALLENGE);

		expect(refreshed).toMatchObject({
			form: "cookies",
			cookies: { "aws-waf-token": "vendor-token-2" },
		});
		expect(vendorCalls).toBe(2);
		expect(instrumented.trace.getSpans()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "resolver.cache.invalidate",
					status: "ok",
					attributes: expect.objectContaining({
						challenge_kind: "aws_waf",
						outcome: "index_entry_deleted",
					}),
				}),
			]),
		);
	});
});
