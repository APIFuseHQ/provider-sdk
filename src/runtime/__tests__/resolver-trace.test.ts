import { describe, expect, it } from "bun:test";

import type {
	ChallengeSolution,
	ProviderChallenge,
	ProviderContext,
	ProviderResolverVendor,
	ResolverContext,
} from "../../types.js";
import { wrapWithInstrumentation } from "../instrumentation.js";
import { spansToOTLP } from "../otlp.js";
import { createResolverClient } from "../resolver.js";
import type { ResolverVendorAdapter } from "../resolver-vendors/types.js";
import { ResolverVendorUnavailableError } from "../resolver-vendors/types.js";
import { createTraceContext } from "../trace.js";

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

	it("keeps a resolver with no trace context operational", async () => {
		const solution = { form: "token", token: "direct-solution" } as const;
		const resolver = createResolverClient({
			kinds: ["aws_waf"],
			adapters: [adapter("browser", async () => solution)],
		});

		await expect(resolver.solve(CHALLENGE)).resolves.toBe(solution);
	});
});
