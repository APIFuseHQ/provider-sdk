import { expect, it, mock } from "bun:test";
import { z } from "zod";
import { PROVIDER_TELEMETRY_HEADER } from "../runtime/request-telemetry.js";
import { createResolverClient } from "../runtime/resolver.js";
import { createServerApp, type ProviderServerLogEvent } from "../server/serve.js";
import type { ChallengeSolution } from "../types.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

it("reports zero missing-profile invocations in the public body and request log together", async () => {
	const solve = mock(async (): Promise<ChallengeSolution> => ({ form: "token", token: "unused" }));
	const resolver = createResolverClient({
		kinds: ["akamai_sbsd"],
		adapters: [{ id: "custom", supports: () => true, solve }],
	});
	const provider = createProviderDefinitionDouble({
		id: "resolver-missing-profile",
		resolver: { kinds: ["akamai_sbsd"], clientProfile: "chrome149" },
		operations: {
			solve: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({}),
				async handler(ctx) {
					await ctx.resolver.solve({
						kind: "akamai_sbsd",
						pageUrl: "https://example.com",
						scriptUrl: "https://example.com/.well-known/sbsd?v=fixture&t=fixture",
						stateCookieName: "sbsd_o",
					});
					return {};
				},
			},
		},
	});
	const events: ProviderServerLogEvent[] = [];
	const app = createServerApp(provider, { resolver, logger: (event) => events.push(event) });
	const response = await app.request("/v1/solve", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: "missing-profile", input: {} }),
	});
	expect(response.status).toBe(500);
	expect(solve).toHaveBeenCalledTimes(0);
	expect(await response.json()).toEqual({
		error: {
			code: "RESOLVER_CHAIN_EXHAUSTED",
			message: "The challenge could not be resolved.",
			requestId: "missing-profile",
			retryable: false,
			source: "apifuse",
			fix: "Retry the request or contact support if the challenge continues.",
			details: { challengeKind: "akamai_sbsd", attempts: 0, outcome: "exhausted", retryable: false },
		},
	});
	const log = events.find((event) => event.event === "provider_request_failed")?.resolver;
	expect(log).toEqual({
		outcome: "exhausted",
		challengeKind: "akamai_sbsd",
		solveMs: expect.any(Number),
		identitySource: "none",
		identityFailure: "missing_client_profile",
		attempts: 0,
		failovers: 0,
		vendorChain: [],
		pollCount: 0,
	});
	const header = response.headers.get(PROVIDER_TELEMETRY_HEADER);
	expect(header).not.toBeNull();
	expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString()).resolver).toEqual({
		outcome: "exhausted",
		solveMs: log?.solveMs,
		attempts: 0,
		failovers: 0,
		vendorChain: [],
		pollCount: 0,
		identitySource: "none",
	});
});
