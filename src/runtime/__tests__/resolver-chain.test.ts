import { describe, expect, it } from "bun:test";

import { VALID_PROVIDER_CHALLENGE_KINDS } from "../../define.js";
import { createProviderCache } from "../cache.js";
import type {
	ChallengeSolution,
	ProviderChallenge,
	ProviderChallengeKind,
	ProviderResolverVendor,
} from "../../types.js";
import {
	APIFUSE__CDP_POOL__URL,
	APIFUSE__RESOLVER__2CAPTCHA__API_KEY,
	APIFUSE__RESOLVER__CAPSOLVER__API_KEY,
	createResolverClient,
	createResolverClientFromEnv,
	createResolverClientFromEnvForTests,
	RESOLVER_ADAPTER_REGISTRY,
} from "../resolver.js";
import {
	RESOLVER_VENDOR_CAPABILITIES,
	ResolverChallengeVerdictError,
	type ResolverVendorAdapter,
	type ResolverVendorTransport,
	ResolverVendorUnavailableError,
	type ResolverVendorUnavailableReason,
} from "../resolver-vendors/types.js";

const CHALLENGE = {
	kind: "aws_waf",
	pageUrl: "https://example.com/protected",
} satisfies ProviderChallenge;

const ALL_CHALLENGE_KINDS: readonly ProviderChallengeKind[] = VALID_PROVIDER_CHALLENGE_KINDS;

type StubBehavior = (
	challenge: ProviderChallenge,
	signal: AbortSignal,
) => Promise<ChallengeSolution>;

function createStubAdapter(options: {
	readonly id: ProviderResolverVendor;
	readonly supports?: boolean;
	readonly behavior?: StubBehavior;
}) {
	const state = { solveCalls: 0, supportsCalls: 0 };
	const adapter: ResolverVendorAdapter = {
		id: options.id,
		supports() {
			state.supportsCalls += 1;
			return options.supports ?? true;
		},
		async solve(challenge, identity, signal) {
			void identity;
			state.solveCalls += 1;
			return await (options.behavior ?? (async () => ({ form: "token", token: options.id })))(
				challenge,
				signal,
			);
		},
	};
	return { adapter, state };
}

function unavailable(
	vendor: ProviderResolverVendor,
	reason: ResolverVendorUnavailableReason,
): StubBehavior {
	return async () => {
		throw new ResolverVendorUnavailableError(vendor, reason);
	};
}

function createChain(adapters: readonly ResolverVendorAdapter[], kinds = ["aws_waf"] as const) {
	return createResolverClient({ adapters, kinds });
}

function createTransportGuardResolver(
	transport: ResolverVendorTransport,
	allowedHosts: readonly string[] = ["sensor.example.com"],
) {
	const adapter: ResolverVendorAdapter = {
		id: "2captcha",
		requiresTransport: true,
		supports: (kind) => kind === "akamai_sensor",
		async solve(challenge, _identity, signal, _traceRecorder, guardedTransport) {
			if (challenge.kind !== "akamai_sensor" || guardedTransport === undefined) {
				throw new Error("Expected a transport-bound Akamai sensor challenge");
			}
			await guardedTransport.fetch(challenge.scriptUrl, { method: "GET", signal });
			return { form: "token", token: "transport-complete" };
		},
	};
	return createResolverClientFromEnvForTests(
		{ vendors: ["2captcha"], kinds: ["akamai_sensor"] },
		{ [APIFUSE__RESOLVER__2CAPTCHA__API_KEY]: "sk-test" },
		{
			allowedHosts,
			createTransport: () => transport,
		},
		{ "2captcha": () => adapter },
	);
}

describe("resolver vendor chain", () => {
	it("returns a single available vendor's solution unchanged", async () => {
		const solution = { form: "token", token: "first-solution" } as const;
		const first = createStubAdapter({
			id: "browser",
			behavior: async () => solution,
		});

		const result = await createChain([first.adapter]).solve(CHALLENGE);

		expect(result).toBe(solution);
		expect(first.state.solveCalls).toBe(1);
	});

	it("uses the second vendor when the first is unavailable", async () => {
		const secondSolution = { form: "token", token: "second-solution" } as const;
		const first = createStubAdapter({
			id: "browser",
			behavior: unavailable("browser", "allocation_exhausted"),
		});
		const second = createStubAdapter({
			id: "capsolver",
			behavior: async () => secondSolution,
		});

		const result = await createChain([first.adapter, second.adapter]).solve(CHALLENGE);

		expect(result).toBe(secondSolution);
		expect(first.state.solveCalls).toBe(1);
		expect(second.state.solveCalls).toBe(1);
	});

	it("propagates a verdict without calling the next vendor", async () => {
		const verdict = new ResolverChallengeVerdictError("browser", "human_puzzle");
		const first = createStubAdapter({
			id: "browser",
			behavior: async () => {
				throw verdict;
			},
		});
		const second = createStubAdapter({ id: "capsolver" });

		await expect(createChain([first.adapter, second.adapter]).solve(CHALLENGE)).rejects.toBe(
			verdict,
		);
		expect(second.state.solveCalls).toBe(0);
	});

	it("skips a vendor that does not support the requested kind", async () => {
		const unsupported = createStubAdapter({ id: "browser", supports: false });
		const supported = createStubAdapter({ id: "capsolver" });

		const result = await createChain([unsupported.adapter, supported.adapter]).solve(CHALLENGE);

		expect(result).toEqual({ form: "token", token: "capsolver" });
		expect(unsupported.state.solveCalls).toBe(0);
		expect(supported.state.solveCalls).toBe(1);
	});

	it("rejects a kind unsupported by the whole chain before any adapter call", async () => {
		const first = createStubAdapter({ id: "browser", supports: false });
		const second = createStubAdapter({ id: "capsolver", supports: false });

		await expect(
			createChain([first.adapter, second.adapter]).solve(CHALLENGE),
		).rejects.toMatchObject({
			code: "RESOLVER_KIND_UNSUPPORTED_BY_CHAIN",
		});
		expect(first.state.solveCalls).toBe(0);
		expect(second.state.solveCalls).toBe(0);
	});

	it.each([
		"akamai_sec_cpt",
		"akamai_sensor",
	] as const)("reports %s as unsupported by a browser-only chain regardless of credentials", async (kind) => {
		const challenge =
			kind === "akamai_sec_cpt"
				? ({ kind, pageUrl: CHALLENGE.pageUrl } satisfies ProviderChallenge)
				: ({
						kind,
						pageUrl: CHALLENGE.pageUrl,
						scriptUrl: "https://example.com/akamai/sensor.js",
					} satisfies ProviderChallenge);
		const config = { vendors: ["browser"], kinds: [kind] } as const;
		const withoutCredentials = await createResolverClientFromEnv(config, {})
			.solve(challenge)
			.catch((error: unknown) => error);
		const withCredentials = await createResolverClientFromEnv(config, {
			[APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test",
		})
			.solve(challenge)
			.catch((error: unknown) => error);

		expect(withoutCredentials).toMatchObject({
			code: "RESOLVER_KIND_UNSUPPORTED_BY_CHAIN",
		});
		expect(withCredentials).toMatchObject({
			code: "RESOLVER_KIND_UNSUPPORTED_BY_CHAIN",
		});
	});

	it("keeps keyed 2captcha not implemented until its Akamai adapter lands", async () => {
		const challenge = {
			kind: "akamai_sensor",
			pageUrl: CHALLENGE.pageUrl,
			scriptUrl: "https://example.com/akamai/sensor.js",
		} satisfies ProviderChallenge;

		await expect(
			createResolverClientFromEnv(
				{ vendors: ["2captcha"], kinds: ["akamai_sensor"] },
				{ [APIFUSE__RESOLVER__2CAPTCHA__API_KEY]: undefined },
			).solve(challenge),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "2captcha", reason: "missing_credentials" }],
		});

		await expect(
			createResolverClientFromEnv(
				{ vendors: ["2captcha"], kinds: ["akamai_sensor"] },
				{ [APIFUSE__RESOLVER__2CAPTCHA__API_KEY]: "sk-test" },
			).solve(challenge),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "2captcha", reason: "not_implemented" }],
		});
	});

	it("fails closed when an adapter requires an unavailable transport", async () => {
		let solveCalls = 0;
		const adapter: ResolverVendorAdapter = {
			id: "custom",
			requiresTransport: true,
			supports: (kind) => kind === "akamai_sensor",
			async solve() {
				solveCalls += 1;
				return { form: "token", token: "must-not-run" };
			},
		};
		const challenge = {
			kind: "akamai_sensor",
			pageUrl: CHALLENGE.pageUrl,
			scriptUrl: "https://example.com/akamai/sensor.js",
		} satisfies ProviderChallenge;

		await expect(
			createResolverClient({ adapters: [adapter], kinds: ["akamai_sensor"] }).solve(challenge),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "custom", reason: "missing_transport" }],
		});
		expect(solveCalls).toBe(0);
	});

	it("fails closed when required proxy identity is unavailable", async () => {
		const adapter = createStubAdapter({ id: "browser" });
		const resolver = createResolverClient({
			adapters: [adapter.adapter],
			kinds: ["aws_waf"],
			proxyMode: "required",
		});

		await expect(resolver.solve(CHALLENGE)).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "browser", reason: "missing_proxy_identity" }],
		});
		expect(adapter.state.solveCalls).toBe(0);
	});

	it("fails closed under a required proxy policy even when a cached solution exists", async () => {
		const cache = createProviderCache({ providerId: "resolver-required-proxy", redisUrl: "" });
let seedCalls = 0;
		const seededAdapter: ResolverVendorAdapter = {
			id: "browser",
			supports: () => true,
			getIssuingIdentity: () => ({ userAgent: "seed-agent" }),
			async solve() {
				seedCalls += 1;
				return {
					form: "cookies",
					cookies: { aws_waf_token: "seeded" },
					userAgent: "seed-agent",
					expires: (Date.now() + 3_600_000) / 1_000,
				};
			},
		};
		const seeder = createResolverClient({
			adapters: [seededAdapter],
			kinds: ["aws_waf"],
			cache,
			proxyMode: "optional",
		});
		await expect(seeder.solve(CHALLENGE)).resolves.toBeDefined();
		expect(seedCalls).toBe(1);

		const guarded = createStubAdapter({ id: "browser" });
		const resolver = createResolverClient({
			adapters: [guarded.adapter],
			kinds: ["aws_waf"],
			cache,
			proxyMode: "required",
		});

		await expect(resolver.solve(CHALLENGE)).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "browser", reason: "missing_proxy_identity" }],
		});
		expect(guarded.state.solveCalls).toBe(0);
	});

	it("rejects a required proxy policy for a vendor that does not apply the identity", async () => {
		const adapter = createStubAdapter({ id: "browser" });
		const resolver = createResolverClient({
			adapters: [adapter.adapter],
			kinds: ["aws_waf"],
			identity: { proxyUrl: "http://proxy.test:8080", userAgent: "resolver-test-agent" },
			proxyMode: "required",
		});

		await expect(resolver.solve(CHALLENGE)).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "browser", reason: "missing_proxy_identity" }],
		});
		expect(adapter.state.solveCalls).toBe(0);
	});

	it("accepts a required proxy policy for a vendor that applies the identity", async () => {
		const adapter = createStubAdapter({ id: "2captcha" });
		const applying: ResolverVendorAdapter = {
			...adapter.adapter,
			appliesProxyIdentity: true,
		};
		const resolver = createResolverClient({
			adapters: [applying],
			kinds: ["aws_waf"],
			identity: { proxyUrl: "http://proxy.test:8080", userAgent: "resolver-test-agent" },
			proxyMode: "required",
		});

		await expect(resolver.solve(CHALLENGE)).resolves.toEqual({
			form: "token",
			token: "2captcha",
		});
		expect(adapter.state.solveCalls).toBe(1);
	});

	it("skips a non-applying vendor and falls through to one that applies the identity", async () => {
		const browser = createStubAdapter({ id: "browser" });
		const solver = createStubAdapter({ id: "2captcha" });
		const resolver = createResolverClient({
			adapters: [browser.adapter, { ...solver.adapter, appliesProxyIdentity: true }],
			kinds: ["aws_waf"],
			identity: { proxyUrl: "http://proxy.test:8080", userAgent: "resolver-test-agent" },
			proxyMode: "required",
		});

		await expect(resolver.solve(CHALLENGE)).resolves.toEqual({
			form: "token",
			token: "2captcha",
		});
		expect(browser.state.solveCalls).toBe(0);
		expect(solver.state.solveCalls).toBe(1);
	});

	it("allows an optional proxy policy without an identity", async () => {
		const adapter = createStubAdapter({ id: "browser" });
		const resolver = createResolverClient({
			adapters: [adapter.adapter],
			kinds: ["aws_waf"],
			proxyMode: "optional",
		});

		await expect(resolver.solve(CHALLENGE)).resolves.toEqual({ form: "token", token: "browser" });
		expect(adapter.state.solveCalls).toBe(1);
	});

	it("allows a required proxy policy with an internally supplied identity", async () => {
		const adapter = createStubAdapter({ id: "browser" });
		const resolver = createResolverClient({
			// A required policy is only satisfied by a vendor that applies the identity, so
			// this fixture opts in the way the 2captcha adapter does in production.
			adapters: [{ ...adapter.adapter, appliesProxyIdentity: true }],
			kinds: ["aws_waf"],
			identity: {
				proxyUrl: "http://proxy.test:8080",
				userAgent: "resolver-test-agent",
			},
			proxyMode: "required",
		});

		await expect(resolver.solve(CHALLENGE)).resolves.toEqual({ form: "token", token: "browser" });
		expect(adapter.state.solveCalls).toBe(1);
	});

	it("preserves resolver behavior when proxy mode is absent", async () => {
		const adapter = createStubAdapter({ id: "browser" });
		const resolver = createResolverClient({
			adapters: [adapter.adapter],
			kinds: ["aws_waf"],
		});

		await expect(resolver.solve(CHALLENGE)).resolves.toEqual({ form: "token", token: "browser" });
		expect(adapter.state.solveCalls).toBe(1);
	});

	it("evaluates predicate transport requirements for each challenge kind", async () => {
		const solvedKinds: ProviderChallengeKind[] = [];
		const adapter: ResolverVendorAdapter = {
			id: "custom",
			requiresTransport: (kind) => kind === "akamai_sensor",
			supports: (kind) => kind === "turnstile" || kind === "akamai_sensor",
			async solve(challenge) {
				solvedKinds.push(challenge.kind);
				return { form: "token", token: `solved-${challenge.kind}` };
			},
		};
		const resolver = createResolverClient({
			adapters: [adapter],
			kinds: ["turnstile", "akamai_sensor"],
		});

		await expect(
			resolver.solve({
				kind: "turnstile",
				siteKey: "site-key",
				pageUrl: CHALLENGE.pageUrl,
			}),
		).resolves.toEqual({ form: "token", token: "solved-turnstile" });
		await expect(
			resolver.solve({
				kind: "akamai_sensor",
				pageUrl: CHALLENGE.pageUrl,
				scriptUrl: "https://example.com/akamai/sensor.js",
			}),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "custom", reason: "missing_transport" }],
		});
		expect(solvedKinds).toEqual(["turnstile"]);
	});

	it("threads the declared profile and server identity scope through the env transport factory", async () => {
		const identityScope = "proxy-session-one";
		const transport = {
			async fetch() {
				return { status: 200, headers: {}, body: "", cookies: [] };
			},
		};
		let factoryInput: unknown;
		let receivedTransport: unknown;
		const adapter: ResolverVendorAdapter = {
			id: "2captcha",
			requiresTransport: true,
			supports: (kind) => kind === "akamai_sensor",
			async solve(_challenge, _identity, _signal, _traceRecorder, suppliedTransport) {
				receivedTransport = suppliedTransport;
				return { form: "token", token: "solved" };
			},
		};
		const resolver = createResolverClientFromEnvForTests(
			{
				vendors: ["2captcha"],
				kinds: ["akamai_sensor"],
				clientProfile: "safari17_0",
			},
			{ [APIFUSE__RESOLVER__2CAPTCHA__API_KEY]: "sk-test" },
			{
				allowedHosts: ["example.com"],
				createTransport(input) {
					factoryInput = input;
					return transport;
				},
				identityScope,
			},
			{ "2captcha": () => adapter },
		);

		await expect(
			resolver.solve({
				kind: "akamai_sensor",
				pageUrl: CHALLENGE.pageUrl,
				scriptUrl: "https://example.com/akamai/sensor.js",
			}),
		).resolves.toEqual({ form: "token", token: "solved" });
		expect(factoryInput).toEqual({ clientProfile: "safari17_0", identityScope });
		expect(factoryInput).not.toHaveProperty("identity");
		expect(receivedTransport).toBeDefined();
	});

	it("enforces allowedHosts on every adapter transport fetch", async () => {
		const challenge = {
			kind: "akamai_sensor",
			pageUrl: "https://sensor.example.com/challenge",
			scriptUrl: "https://sensor.example.com:8443/akamai/sensor.js",
		} satisfies ProviderChallenge;
		let fetchCalls = 0;
		const underlyingTransport = {
			async fetch() {
				fetchCalls += 1;
				return { status: 200, headers: {}, body: "sensor", cookies: [] };
			},
		};
		const adapter: ResolverVendorAdapter = {
			id: "2captcha",
			requiresTransport: true,
			supports: (kind) => kind === "akamai_sensor",
			async solve(sensorChallenge, _identity, signal, _traceRecorder, transport) {
				if (sensorChallenge.kind !== "akamai_sensor" || transport === undefined) {
					throw new Error("Expected a transport-bound Akamai sensor challenge");
				}
				await transport.fetch(sensorChallenge.scriptUrl, { method: "GET", signal });
				return { form: "token", token: "transport-complete" };
			},
		};
		const createResolver = (allowedHosts: readonly string[]) =>
			createResolverClientFromEnvForTests(
				{ vendors: ["2captcha"], kinds: ["akamai_sensor"] },
				{ [APIFUSE__RESOLVER__2CAPTCHA__API_KEY]: "sk-test" },
				{
					allowedHosts,
					createTransport: () => underlyingTransport,
				},
				{ "2captcha": () => adapter },
			);

		await expect(createResolver(["example.com"]).solve(challenge)).rejects.toMatchObject({
			name: "ProviderError",
			code: "RESOLVER_HOST_NOT_ALLOWED",
		});
		expect(fetchCalls).toBe(0);

		await expect(createResolver(["SENSOR.EXAMPLE.COM."]).solve(challenge)).resolves.toEqual({
			form: "token",
			token: "transport-complete",
		});
		expect(fetchCalls).toBe(1);
	});

	it("allows declared resolver hosts over both https and http", async () => {
		const dialedUrls: string[] = [];
		const resolver = createTransportGuardResolver({
			async fetch(url) {
				dialedUrls.push(url);
				return { status: 200, headers: {}, body: "sensor", cookies: [] };
			},
		});
		const scriptUrls = [
			"https://sensor.example.com/akamai/sensor.js",
			"http://sensor.example.com/akamai/sensor.js",
		] as const;

		for (const scriptUrl of scriptUrls) {
			await expect(
				resolver.solve({
					kind: "akamai_sensor",
					pageUrl: "https://sensor.example.com/challenge",
					scriptUrl,
				}),
			).resolves.toEqual({ form: "token", token: "transport-complete" });
		}
		expect(dialedUrls).toEqual(scriptUrls);
	});

	it("rejects non-http resolver transport schemes before dialing", async () => {
		let fetchCalls = 0;
		const resolver = createTransportGuardResolver({
			async fetch() {
				fetchCalls += 1;
				return { status: 200, headers: {}, body: "sensor", cookies: [] };
			},
		});
		const disallowedUrls = [
			"file://sensor.example.com/akamai/sensor.js",
			"data:text/javascript,challenge",
			"ftp://sensor.example.com/akamai/sensor.js",
		] as const;

		for (const scriptUrl of disallowedUrls) {
			await expect(
				resolver.solve({
					kind: "akamai_sensor",
					pageUrl: "https://sensor.example.com/challenge",
					scriptUrl,
				}),
			).rejects.toMatchObject({
				name: "ProviderError",
				code: "RESOLVER_HOST_NOT_ALLOWED",
				fix: "Use an http or https URL whose exact hostname appears in the provider's allowedHosts declaration.",
			});
		}
		expect(fetchCalls).toBe(0);
	});

	it("refuses redirect responses without following their Location", async () => {
		const scriptUrl = "https://sensor.example.com/akamai/sensor.js";
		let fetchCalls = 0;
		let dialedUrl: string | undefined;
		let redirectMode: "manual" | undefined;
		const resolver = createTransportGuardResolver({
			async fetch(url, init) {
				fetchCalls += 1;
				dialedUrl = url;
				redirectMode = init.redirect;
				return {
					status: 302,
					headers: { LoCaTiOn: "http://169.254.169.254/latest/meta-data" },
					body: "",
					cookies: [],
				};
			},
		});

		await expect(
			resolver.solve({
				kind: "akamai_sensor",
				pageUrl: "https://sensor.example.com/challenge",
				scriptUrl,
			}),
		).rejects.toMatchObject({
			name: "ProviderError",
			code: "RESOLVER_HOST_NOT_ALLOWED",
			message: "Resolver transport refused a redirect response",
		});
		expect(fetchCalls).toBe(1);
		expect(dialedUrl).toBe(scriptUrl);
		expect(redirectMode).toBe("manual");
	});

	it("rejects a declared client profile with a pre-bound transport", () => {
		const transport = {
			async fetch() {
				return { status: 200, headers: {}, body: "", cookies: [] };
			},
		};

		expect(() =>
			createResolverClientFromEnv(
				{
					vendors: ["2captcha"],
					kinds: ["akamai_sensor"],
					clientProfile: "safari17_0",
				},
				{},
				{ transport },
			),
		).toThrow(
			expect.objectContaining({
				code: "RESOLVER_CLIENT_PROFILE_TRANSPORT_CONFLICT",
				fix: expect.stringContaining("createTransport"),
			}),
		);
	});

	it("reports every unavailable vendor and reason in attempt order", async () => {
		const browser = createStubAdapter({
			id: "browser",
			behavior: unavailable("browser", "allocation_exhausted"),
		});
		const capsolver = createStubAdapter({
			id: "capsolver",
			behavior: unavailable("capsolver", "not_implemented"),
		});

		const error = await createChain([browser.adapter, capsolver.adapter])
			.solve(CHALLENGE)
			.catch((error: unknown) => error);

		expect(error).toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			message: expect.stringMatching(/browser: allocation_exhausted, capsolver: not_implemented/),
			details: [
				{ vendor: "browser", reason: "allocation_exhausted" },
				{ vendor: "capsolver", reason: "not_implemented" },
			],
		});
	});

	it("gates an undeclared kind before inspecting an unusable chain", async () => {
		const unusable = createStubAdapter({ id: "browser", supports: false });
		const challenge = {
			kind: "turnstile",
			siteKey: "site-key",
			pageUrl: CHALLENGE.pageUrl,
		} satisfies ProviderChallenge;

		await expect(createChain([unusable.adapter]).solve(challenge)).rejects.toMatchObject({
			code: "RESOLVER_KIND_NOT_DECLARED",
		});
		expect(unusable.state.supportsCalls).toBe(0);
		expect(unusable.state.solveCalls).toBe(0);
	});

	it("propagates an unclassified error without calling the next vendor", async () => {
		const original = new Error("unclassified vendor failure");
		const first = createStubAdapter({
			id: "browser",
			behavior: async () => {
				throw original;
			},
		});
		const second = createStubAdapter({ id: "capsolver" });

		await expect(createChain([first.adapter, second.adapter]).solve(CHALLENGE)).rejects.toBe(
			original,
		);
		expect(second.state.solveCalls).toBe(0);
	});

	it("stops the chain when the caller aborts mid-attempt", async () => {
		const first = createStubAdapter({
			id: "browser",
			behavior: async (_challenge, signal) =>
				await new Promise<ChallengeSolution>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		});
		const second = createStubAdapter({ id: "capsolver" });
		const controller = new AbortController();
		const abortError = new Error("caller aborted");
		const resolver: ResolverContext = createChain([first.adapter, second.adapter]);
		const solve = resolver.solve(CHALLENGE, controller.signal);
		while (first.state.solveCalls === 0) await Promise.resolve();
		controller.abort(abortError);

		await expect(solve).rejects.toBe(abortError);
		expect(second.state.solveCalls).toBe(0);
	});

	it("treats a declared vendor with no adapter as not implemented", async () => {
		const error = await createResolverClientFromEnv(
			{ vendors: ["capsolver"], kinds: ["aws_waf"] },
			{ [APIFUSE__RESOLVER__CAPSOLVER__API_KEY]: "sk-test" },
		)
			.solve(CHALLENGE)
			.catch((error: unknown) => error);

		expect(error).toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "capsolver", reason: "not_implemented" }],
		});
	});

	it("fails loudly when an implemented vendor loses its registered adapter", async () => {
		const resolver = createResolverClientFromEnvForTests(
			{ vendors: ["browser"], kinds: ["aws_waf"] },
			{ [APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test" },
			{},
			{},
		);

		await expect(resolver.solve(CHALLENGE)).rejects.toThrow(
			'Resolver adapter factory is missing for implemented vendor "browser"',
		);
	});

	it("fails loudly for a vendor id outside the known union", () => {
		expect(() =>
			createResolverClientFromEnv(
				{
					vendors: ["unexpected-vendor" as ProviderResolverVendor],
					kinds: ["aws_waf"],
				},
				{},
			),
		).toThrow('Unknown resolver vendor "unexpected-vendor" in resolver configuration');
	});
});

describe("resolver vendor capabilities", () => {
	it.each([
		"akamai_sec_cpt",
		"akamai_sensor",
	] as const)("declares only 2captcha and custom capable of %s", (kind) => {
		const capableVendors = (
			Object.keys(RESOLVER_VENDOR_CAPABILITIES) as ProviderResolverVendor[]
		).filter((vendor) =>
			(RESOLVER_VENDOR_CAPABILITIES[vendor] as readonly ProviderChallengeKind[]).includes(kind),
		);

		expect(capableVendors).toEqual(["2captcha", "custom"]);
	});

	for (const vendor of Object.keys(RESOLVER_ADAPTER_REGISTRY) as ProviderResolverVendor[]) {
		it(`${vendor} static capabilities agree with its registered adapter`, () => {
			const factory = RESOLVER_ADAPTER_REGISTRY[vendor];
			if (!factory) throw new Error(`Missing registered adapter factory for ${vendor}`);
			const adapter = factory("ws://resolver.test", 100, []);
			const staticKinds = RESOLVER_VENDOR_CAPABILITIES[vendor] as readonly ProviderChallengeKind[];

			for (const kind of ALL_CHALLENGE_KINDS) {
				expect(staticKinds.includes(kind)).toBe(adapter.supports(kind));
			}
		});
	}
});
