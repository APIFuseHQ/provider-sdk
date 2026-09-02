import { describe, expect, it } from "bun:test";

import { createProviderContextDouble } from "../../__tests__/test-utils.js";
import type {
	ChallengeSolution,
	ProviderChallenge,
	ProviderResolverVendor,
} from "../../types.js";
import { wrapWithInstrumentation } from "../instrumentation.js";
import { bindResolverSignal, createResolverClient } from "../resolver.js";
import type { ResolverVendorAdapter } from "../resolver-vendors/types.js";
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

describe("resolver signal binding keeps vendor tracing", () => {
	it("records vendor attempt spans when the server binds a default abort signal", async () => {
		const solution = { form: "token", token: "bound-solution" } as const;
		const resolver = createResolverClient({
			kinds: ["aws_waf"],
			adapters: [adapter("capsolver", async () => solution)],
		});

		// The server always binds the inbound request signal before instrumentation
		// wraps the context, mirroring createProviderContext in serve-implementation.
		const bound = bindResolverSignal(resolver, new AbortController().signal);
		const trace = createTraceContext();
		const instrumented = wrapWithInstrumentation(
			createProviderContextDouble({ trace, resolver: bound }),
		);

		await expect(instrumented.resolver.solve(CHALLENGE)).resolves.toBe(solution);

		const spans = instrumented.trace.getSpans();
		expect(spans.map((span) => span.name)).toEqual([
			"resolver.solve",
			"resolver.vendor.attempt",
		]);
	});
});
