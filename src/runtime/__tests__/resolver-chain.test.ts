import { describe, expect, it } from "bun:test";

import type {
	ChallengeSolution,
	ProviderChallenge,
	ProviderChallengeKind,
	ProviderResolverVendor,
} from "../../types.js";
import {
	APIFUSE__CDP_POOL__URL,
	APIFUSE__RESOLVER__CAPSOLVER__API_KEY,
	createResolverClient,
	createResolverClientFromEnv,
	RESOLVER_ADAPTER_REGISTRY,
} from "../resolver.js";
import {
	RESOLVER_VENDOR_CAPABILITIES,
	type ResolverVendorAdapter,
	type ResolverVendorUnavailableReason,
	ResolverChallengeVerdictError,
	ResolverVendorUnavailableError,
} from "../resolver-vendors/types.js";

const CHALLENGE = {
	kind: "aws_waf",
	pageUrl: "https://example.com/protected",
} satisfies ProviderChallenge;

const ALL_CHALLENGE_KINDS = [
	"turnstile",
	"recaptcha_v2",
	"recaptcha_v3",
	"hcaptcha",
	"cloudflare_interstitial",
	"aws_waf",
] satisfies readonly ProviderChallengeKind[];

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
		const solve = createChain([first.adapter, second.adapter]).solve(CHALLENGE, controller.signal);
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
		const registry = RESOLVER_ADAPTER_REGISTRY as {
			browser?: (configuration: string, timeoutMs: number) => ResolverVendorAdapter;
		};
		const original = registry.browser;
		delete registry.browser;
		try {
			const resolver = createResolverClientFromEnv(
				{ vendors: ["browser"], kinds: ["aws_waf"] },
				{ [APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test" },
			);

			await expect(resolver.solve(CHALLENGE)).rejects.toThrow(
				'Resolver adapter factory is missing for implemented vendor "browser"',
			);
		} finally {
			registry.browser = original;
		}
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
	for (const vendor of Object.keys(RESOLVER_ADAPTER_REGISTRY) as ProviderResolverVendor[]) {
		it(`${vendor} static capabilities agree with its registered adapter`, () => {
			const factory = RESOLVER_ADAPTER_REGISTRY[vendor];
			if (!factory) throw new Error(`Missing registered adapter factory for ${vendor}`);
			const adapter = factory("ws://resolver.test", 100);
			const staticKinds = RESOLVER_VENDOR_CAPABILITIES[vendor] as readonly ProviderChallengeKind[];

			for (const kind of ALL_CHALLENGE_KINDS) {
				expect(staticKinds.includes(kind)).toBe(adapter.supports(kind));
			}
		});
	}
});
