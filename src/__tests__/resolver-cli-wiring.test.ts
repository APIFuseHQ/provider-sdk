import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { createProviderContext as createDevProviderContext } from "../../bin/apifuse-dev.js";
import { createCaptureContext, formatResolverTelemetry } from "../../bin/apifuse-record.js";
import { defineProvider, z } from "../index.js";
import { NODEMAVEN_PASSWORD_ENV, NODEMAVEN_USERNAME_ENV } from "../runtime/proxy-nodemaven.js";
import {
	APIFUSE__CDP_POOL__URL,
	APIFUSE__RESOLVER__CAPSOLVER__API_KEY,
	swapResolverAdapterFactoryForTests,
} from "../runtime/resolver.js";
import { ResolverTelemetryCollector } from "../runtime/resolver-telemetry.js";
import {
	type ResolverIdentity,
	type ResolverVendorAdapter,
	ResolverVendorUnavailableError,
} from "../runtime/resolver-vendors/types.js";
import { getStealthProfile } from "../stealth/profiles.js";
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

const TURNSTILE_CHALLENGE = {
	kind: "turnstile",
	pageUrl: "https://example.com/challenge",
	siteKey: "site-key",
} satisfies ProviderChallenge;

const HOSTED_RESOLVER = {
	vendors: ["capsolver"],
	kinds: ["turnstile"],
} as const satisfies ProviderResolverConfig;

type CliResolverHarness = { ctx: ProviderContext; resolverTelemetry: ResolverTelemetryCollector };

const harnesses = [
	{
		name: "apifuse record",
		createContext(provider: ProviderDefinition): ProviderContext {
			return createCaptureContext(provider, "https://example.com", true).ctx;
		},
		createRuntime(provider: ProviderDefinition): CliResolverHarness {
			return createCaptureContext(provider, "https://example.com", true);
		},
		expectedSolveCalls: 2,
		expectedSecondToken: "token-2",
		expectedCacheGets: 0,
		expectedCacheSets: 0,
		expectedCacheStatus: "disabled",
	},
	{
		name: "apifuse dev",
		createContext(provider: ProviderDefinition): ProviderContext {
			return createDevProviderContext(provider).ctx;
		},
		createRuntime(provider: ProviderDefinition): CliResolverHarness {
			return createDevProviderContext(provider);
		},
		expectedSolveCalls: 1,
		expectedSecondToken: "token-1",
		expectedCacheGets: 4,
		expectedCacheSets: 2,
		expectedCacheStatus: "miss",
	},
] as const;
const harnessTable = harnesses.map((harness) => [harness] as const);

let originalCdpUrl: string | undefined;
let originalCapsolverKey: string | undefined;
let originalNodemavenUsername: string | undefined;
let originalNodemavenPassword: string | undefined;
let providerOrdinal = 0;
let restoreAdapter: (() => void) | undefined;

beforeEach(() => {
	originalCdpUrl = process.env[APIFUSE__CDP_POOL__URL];
	originalCapsolverKey = process.env[APIFUSE__RESOLVER__CAPSOLVER__API_KEY];
	originalNodemavenUsername = process.env[NODEMAVEN_USERNAME_ENV];
	originalNodemavenPassword = process.env[NODEMAVEN_PASSWORD_ENV];
	delete process.env[APIFUSE__CDP_POOL__URL];
	delete process.env[APIFUSE__RESOLVER__CAPSOLVER__API_KEY];
	delete process.env[NODEMAVEN_USERNAME_ENV];
	delete process.env[NODEMAVEN_PASSWORD_ENV];
});

afterEach(() => {
	restoreAdapter?.();
	restoreAdapter = undefined;
	if (originalCdpUrl === undefined) delete process.env[APIFUSE__CDP_POOL__URL];
	else process.env[APIFUSE__CDP_POOL__URL] = originalCdpUrl;
	if (originalCapsolverKey === undefined) delete process.env[APIFUSE__RESOLVER__CAPSOLVER__API_KEY];
	else process.env[APIFUSE__RESOLVER__CAPSOLVER__API_KEY] = originalCapsolverKey;
	if (originalNodemavenUsername === undefined) delete process.env[NODEMAVEN_USERNAME_ENV];
	else process.env[NODEMAVEN_USERNAME_ENV] = originalNodemavenUsername;
	if (originalNodemavenPassword === undefined) delete process.env[NODEMAVEN_PASSWORD_ENV];
	else process.env[NODEMAVEN_PASSWORD_ENV] = originalNodemavenPassword;
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
		stealth: { browser: "chrome", os: "macos" },
		cache: true,
		...(options.proxy ? { proxy: options.proxy } : {}),
		...(options.resolver ? { resolver: options.resolver } : {}),
		meta: {
			displayName: "Resolver CLI Wiring",
			descriptionKey: "resolver-cli-wiring.description",
			category: "test",
		},
	})({
		operations: {
			lookup: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => ({ ok: true }),
				healthCheckUnsupported: { reason: "CLI context unit test" },
			},
		},
	});
}

describe("resolver CLI wiring", () => {
	it.each(harnessTable)("wires a declared resolver into $name", async (harness) => {
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
			expect(cacheGet).toHaveBeenCalledTimes(harness.expectedCacheGets);
			expect(cacheSet).toHaveBeenCalledTimes(harness.expectedCacheSets);
			expect(solveCalls).toBe(harness.expectedSolveCalls);
		} finally {
			cacheGet.mockRestore();
			cacheSet.mockRestore();
		}
	});

	it.each(harnessTable)("fails closed on an undeclared resolver in $name", async (harness) => {
		let error: unknown;
		try {
			await harness.createContext(createProvider({})).resolver.solve(AWS_WAF_CHALLENGE);
		} catch (cause) {
			error = cause;
		}

		expect(error).toMatchObject({
			code: "PROVIDER_CAPABILITY_UNDECLARED",
			message: expect.stringContaining('undeclared capability "resolver"'),
			fix: "Add resolver: {} to the provider declaration, or remove the access.",
		});
	});

	it.each(harnessTable)("reports missing resolver credentials in $name", async (harness) => {
		await expect(
			harness
				.createContext(createProvider({ resolver: DECLARED_RESOLVER }))
				.resolver.solve(AWS_WAF_CHALLENGE),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: { challengeKind: "aws_waf", attempts: 1, outcome: "exhausted", retryable: false },
		});
	});

	it.each(
		harnessTable,
	)("preserves required-proxy fail-closed behavior in $name", async (harness) => {
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
				.createContext(
					createProvider({
						resolver: DECLARED_RESOLVER,
						proxy: { mode: "required", providers: ["nodemaven"] },
					}),
				)
				.resolver.solve(AWS_WAF_CHALLENGE),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: { challengeKind: "aws_waf", attempts: 1, outcome: "exhausted", retryable: false },
		});
		expect(solveCalls).toBe(0);
	});

	it.each(harnessTable)("resolves a proxy lease inside $name", async (harness) => {
		process.env[NODEMAVEN_USERNAME_ENV] = "resolver-cli-account";
		process.env[NODEMAVEN_PASSWORD_ENV] = "resolver-cli-password";
		const identities: Array<ResolverIdentity | undefined> = [];
		const adapter: ResolverVendorAdapter = {
			id: "browser",
			supports: (kind) => kind === "aws_waf",
			async solve(_challenge, identity) {
				identities.push(identity);
				return { form: "token", token: "cli-proxied-solution" };
			},
		};
		restoreAdapter = swapResolverAdapterFactoryForTests("browser", () => adapter);
		process.env[APIFUSE__CDP_POOL__URL] = "ws://cdp-pool.test";
		const context = harness.createContext(
			createProvider({
				resolver: DECLARED_RESOLVER,
				proxy: { mode: "required", providers: ["nodemaven"] },
			}),
		);

		await expect(context.resolver.solve(AWS_WAF_CHALLENGE)).resolves.toEqual({
			form: "token",
			token: "cli-proxied-solution",
		});
		expect(identities).toEqual([
			{
				proxyUrl: expect.stringMatching(/^http:\/\/resolver-cli-account-/),
				userAgent: getStealthProfile({ browser: "chrome", os: "macos" }).userAgent,
			},
		]);
	});

	it.each(harnessTable)("records a solve in the $name resolver telemetry sink", async (harness) => {
		const adapter: ResolverVendorAdapter = {
			id: "browser",
			supports: (kind) => kind === "aws_waf",
			async solve() {
				return {
					form: "cookies",
					cookies: { aws_waf_token: "token-1" },
					userAgent: "CLI resolver test/1.0",
					expires: (Date.now() + 60_000) / 1_000,
				};
			},
		};
		restoreAdapter = swapResolverAdapterFactoryForTests("browser", () => adapter);
		process.env[APIFUSE__CDP_POOL__URL] = "ws://cdp-pool.test";
		const runtime = harness.createRuntime(createProvider({ resolver: DECLARED_RESOLVER }));

		expect(runtime.resolverTelemetry.toLogPayload()).toBeUndefined();
		await runtime.ctx.resolver.solve(AWS_WAF_CHALLENGE);
		expect(runtime.resolverTelemetry.toLogPayload()).toMatchObject({
			outcome: "solved",
			challengeKind: "aws_waf",
			cacheStatus: harness.expectedCacheStatus,
			attempts: 1,
			failovers: 0,
			vendorChain: ["browser"],
			vendorUsed: "browser",
		});
	});

	it.each(
		harnessTable,
	)("forwards the engine solver key and CDP pool URL to adapters in $name", async (harness) => {
		process.env[APIFUSE__RESOLVER__CAPSOLVER__API_KEY] = "cli-capsolver-key";
		process.env[APIFUSE__CDP_POOL__URL] = "ws://cdp-pool.test";
		const configurations: Array<string | undefined> = [];
		const adapter = (id: "capsolver" | "browser"): ResolverVendorAdapter => ({
			id,
			supports: () => true,
			async solve() {
				return { form: "token", token: `${id}-solution` };
			},
		});
		const restoreCapsolver = swapResolverAdapterFactoryForTests("capsolver", (configuration) => {
			configurations.push(configuration);
			return adapter("capsolver");
		});
		const restoreBrowser = swapResolverAdapterFactoryForTests("browser", (configuration) => {
			configurations.push(configuration);
			return adapter("browser");
		});
		restoreAdapter = () => {
			restoreCapsolver();
			restoreBrowser();
		};

		await expect(
			harness
				.createContext(createProvider({ resolver: HOSTED_RESOLVER }))
				.resolver.solve(TURNSTILE_CHALLENGE),
		).resolves.toEqual({ form: "token", token: "capsolver-solution" });
		await expect(
			harness
				.createContext(createProvider({ resolver: DECLARED_RESOLVER }))
				.resolver.solve(AWS_WAF_CHALLENGE),
		).resolves.toEqual({ form: "token", token: "browser-solution" });
		expect(configurations).toEqual(["cli-capsolver-key", "ws://cdp-pool.test"]);
	});

	it.each(
		harnessTable,
	)("redacts the engine solver key from $name resolver diagnostics", async (harness) => {
		process.env[APIFUSE__RESOLVER__CAPSOLVER__API_KEY] = "cli-capsolver-key";
		const adapter: ResolverVendorAdapter = {
			id: "capsolver",
			supports: () => true,
			async solve() {
				throw new ResolverVendorUnavailableError("capsolver", "allocation_exhausted", {
					phase: "create_task",
					cause: new Error("vendor rejected key cli-capsolver-key"),
				});
			},
		};
		restoreAdapter = swapResolverAdapterFactoryForTests("capsolver", () => adapter);
		const runtime = harness.createRuntime(createProvider({ resolver: HOSTED_RESOLVER }));

		await expect(runtime.ctx.resolver.solve(TURNSTILE_CHALLENGE)).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
		});
		const payload = runtime.resolverTelemetry.toLogPayload();
		expect(payload).toMatchObject({
			outcome: "exhausted",
			attempts: 1,
			vendorChain: ["capsolver"],
		});
		expect(payload?.attemptSamples?.[0]?.diagnostics?.cause?.message).toBe(
			"vendor rejected key [REDACTED]",
		);
		expect(JSON.stringify(payload)).not.toContain("cli-capsolver-key");
	});

	it("prints the record telemetry line in the server request-log shape", () => {
		const collector = new ResolverTelemetryCollector();
		expect(formatResolverTelemetry(collector)).toBeUndefined();

		collector.recordVendorAttempt({
			vendor: "browser",
			phase: "poll_result",
			outcome: "ok",
			ms: 12,
		});
		collector.recordOutcome({ outcome: "solved", challengeKind: "aws_waf", solveMs: 12 });
		const line = formatResolverTelemetry(collector);
		expect(line).toStartWith("[apifuse record] Resolver telemetry {");
		expect(JSON.parse(line!.slice("[apifuse record] Resolver telemetry ".length))).toEqual({
			resolver: collector.toLogPayload(),
		});
	});
});
