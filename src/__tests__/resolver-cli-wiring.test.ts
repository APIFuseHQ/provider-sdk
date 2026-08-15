import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { createProviderContext as createDevProviderContext } from "../../bin/apifuse-dev.js";
import { createCaptureContext } from "../../bin/apifuse-record.js";
import { defineProvider, z } from "../index.js";
import { APIFUSE__CDP_POOL__URL, swapResolverAdapterFactoryForTests } from "../runtime/resolver.js";
import type { ResolverVendorAdapter } from "../runtime/resolver-vendors/types.js";
import type {
	ProviderChallenge,
	ProviderContext,
	ProviderDefinition,
	ProviderProxyPolicy,
	ProviderResolverConfig,
} from "../types.js";

const AWS_WAF_CHALLENGE = {
	kind: "aws_waf",
	pageUrl: "https://example.com/challenge",
} satisfies ProviderChallenge;

const DECLARED_RESOLVER = {
	vendors: ["browser"],
	kinds: ["aws_waf"],
} as const satisfies ProviderResolverConfig;

const harnesses = [
	{
		name: "apifuse record",
		createContext(provider: ProviderDefinition): ProviderContext {
			return createCaptureContext(provider, "https://example.com", true).ctx;
		},
		expectedSolveCalls: 2,
		expectedSecondToken: "token-2",
	},
	{
		name: "apifuse dev",
		createContext(provider: ProviderDefinition): ProviderContext {
			return createDevProviderContext(provider).ctx;
		},
		expectedSolveCalls: 1,
		expectedSecondToken: "token-1",
	},
] as const;

let originalCdpUrl: string | undefined;
let providerOrdinal = 0;
let restoreAdapter: (() => void) | undefined;

beforeEach(() => {
	originalCdpUrl = process.env[APIFUSE__CDP_POOL__URL];
	delete process.env[APIFUSE__CDP_POOL__URL];
});

afterEach(() => {
	restoreAdapter?.();
	restoreAdapter = undefined;
	if (originalCdpUrl === undefined) delete process.env[APIFUSE__CDP_POOL__URL];
	else process.env[APIFUSE__CDP_POOL__URL] = originalCdpUrl;
});

function createProvider(options: {
	resolver?: ProviderResolverConfig;
	proxy?: ProviderProxyPolicy;
}): ProviderDefinition {
	providerOrdinal += 1;
	return defineProvider({
		id: `resolver-cli-test${providerOrdinal}`,
		version: "1.0.0",
		runtime: "standard",
		allowedHosts: ["example.com"],
		...(options.proxy ? { proxy: options.proxy } : {}),
		...(options.resolver ? { resolver: options.resolver } : {}),
		meta: { displayName: "Resolver CLI Wiring", category: "test" },
		operations: {
			lookup: {
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => ({ ok: true }),
				healthCheckUnsupported: { reason: "CLI context unit test" },
			},
		},
	});
}

describe("resolver CLI wiring", () => {
	it.each(harnesses)("wires a declared resolver into $name", async (harness) => {
		let factoryAllowedHosts: readonly string[] | undefined;
		let solveCalls = 0;
		const adapter: ResolverVendorAdapter = {
			id: "browser",
			supports: (kind) => kind === "aws_waf",
			async solve() {
				solveCalls += 1;
				return {
					form: "cookies",
					cookies: { aws_waf_token: `token-${solveCalls}` },
					userAgent: "CLI resolver test/1.0",
					expires: (Date.now() + 60_000) / 1_000,
				};
			},
		};
		restoreAdapter = swapResolverAdapterFactoryForTests(
			"browser",
			(_configuration, _timeoutMs, allowedHosts) => {
				factoryAllowedHosts = allowedHosts;
				return adapter;
			},
		);
		process.env[APIFUSE__CDP_POOL__URL] = "ws://cdp-pool.test";
		const context = harness.createContext(createProvider({ resolver: DECLARED_RESOLVER }));
		const cacheGet = spyOn(context.cache, "get");
		const cacheSet = spyOn(context.cache, "set");
		try {
			await expect(context.resolver.solve(AWS_WAF_CHALLENGE)).resolves.toMatchObject({
				form: "cookies",
				cookies: { aws_waf_token: "token-1" },
			});
			await expect(context.resolver.solve(AWS_WAF_CHALLENGE)).resolves.toMatchObject({
				form: "cookies",
				cookies: { aws_waf_token: harness.expectedSecondToken },
			});
			expect(factoryAllowedHosts).toEqual(["example.com"]);
			expect(cacheGet).toHaveBeenCalled();
			expect(cacheSet).toHaveBeenCalled();
			expect(solveCalls).toBe(harness.expectedSolveCalls);
		} finally {
			cacheGet.mockRestore();
			cacheSet.mockRestore();
		}
	});

	it.each(harnesses)("keeps an undeclared resolver unsupported in $name", async (harness) => {
		const error = await harness
			.createContext(createProvider({}))
			.resolver.solve(AWS_WAF_CHALLENGE)
			.catch((cause: unknown) => cause);

		expect(error).toMatchObject({
			code: "RESOLVER_UNAVAILABLE",
			message: "Provider does not declare resolver capability",
			fix: "Declare resolver on the provider definition and configure vendor credentials.",
		});
	});

	it.each(harnesses)("reports missing resolver credentials in $name", async (harness) => {
		await expect(
			harness
				.createContext(createProvider({ resolver: DECLARED_RESOLVER }))
				.resolver.solve(AWS_WAF_CHALLENGE),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "browser", reason: "missing_credentials" }],
		});
	});

	it.each(harnesses)("preserves required-proxy fail-closed behavior in $name", async (harness) => {
		let solveCalls = 0;
		const adapter: ResolverVendorAdapter = {
			id: "browser",
			supports: (kind) => kind === "aws_waf",
			async solve() {
				solveCalls += 1;
				return {
					form: "cookies",
					cookies: { aws_waf_token: "must-not-be-reached" },
					userAgent: "CLI resolver test/1.0",
				};
			},
		};
		restoreAdapter = swapResolverAdapterFactoryForTests("browser", () => adapter);
		process.env[APIFUSE__CDP_POOL__URL] = "ws://cdp-pool.test";

		await expect(
			harness
				.createContext(createProvider({ resolver: DECLARED_RESOLVER, proxy: { mode: "required" } }))
				.resolver.solve(AWS_WAF_CHALLENGE),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "browser", reason: "missing_proxy_identity" }],
		});
		expect(solveCalls).toBe(0);
	});
});
