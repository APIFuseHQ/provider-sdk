// Compile-time constraints for these types are enforced by the pack:types negative
// controls because tsconfig.json excludes this test file from type checking.
import { describe, expect, it } from "bun:test";

import { createUnsupportedResolverClient } from "../index.js";

import type {
	ChallengeSolution,
	ProviderChallenge,
	ProviderChallengeKind,
	ProviderDefinition,
	ProviderResolverConfig,
	ProviderResolverVendor,
	ResolverContext,
} from "../index.js";

describe("challenge resolver types", () => {
	it("discriminates token and cookie solutions", () => {
		const token: ChallengeSolution = { form: "token", token: "solved-token" };
		const cookies: ChallengeSolution = {
			form: "cookies",
			cookies: { cf_clearance: "clearance" },
			userAgent: "test-agent",
		};

		const readSolution = (solution: ChallengeSolution): string => {
			if (solution.form === "token") return solution.token;
			return `${solution.userAgent}:${solution.cookies.cf_clearance}`;
		};

		expect(readSolution(token)).toBe("solved-token");
		expect(readSolution(cookies)).toBe("test-agent:clearance");
	});

	it("accepts all token-family challenge kinds", () => {
		const tokenChallenges: readonly ProviderChallenge[] = [
			{ kind: "turnstile", siteKey: "turnstile-key", pageUrl: "https://example.com" },
			{ kind: "recaptcha_v2", siteKey: "v2-key", pageUrl: "https://example.com" },
			{ kind: "hcaptcha", siteKey: "hcaptcha-key", pageUrl: "https://example.com" },
			{
				kind: "recaptcha_v3",
				siteKey: "v3-key",
				pageUrl: "https://example.com",
				action: "login",
			},
		];

		expect(tokenChallenges).toHaveLength(4);
	});

	it("accepts both Akamai Bot Manager challenge contracts", () => {
		const challenges: readonly ProviderChallenge[] = [
			{
				kind: "akamai_sec_cpt",
				pageUrl: "https://example.com/challenge",
				challengeHtml: "<main>press and hold</main>",
			},
			{
				kind: "akamai_sensor",
				pageUrl: "https://example.com/challenge",
				scriptUrl: "https://example.com/akamai/sensor.js",
				abck: "current-abck",
				bmsz: "current-bm-sz",
				version: "3",
			},
		];

		expect(challenges.map(({ kind }) => kind)).toEqual(["akamai_sec_cpt", "akamai_sensor"]);
	});

	it("allows provider definitions with or without resolver declarations", async () => {
		const vendor: ProviderResolverVendor = "2captcha";
		const kind: ProviderChallengeKind = "turnstile";
		const resolverConfig: ProviderResolverConfig = {
			vendors: ["2captcha"],
			kinds: [kind],
			clientProfile: "safari17_0",
		};
		const rejectingResolver: ResolverContext = {
			solve: async () => Promise.reject(new Error("resolver is unavailable in type tests")),
		};
		const withResolver: ProviderDefinition = {
			id: "with-resolver",
			version: "1.0.0",
			runtime: "standard",
			resolver: resolverConfig,
			meta: { displayName: "With Resolver", category: "test" },
			operations: {},
		};
		const withoutResolver: ProviderDefinition = {
			id: "without-resolver",
			version: "1.0.0",
			runtime: "standard",
			meta: { displayName: "Without Resolver", category: "test" },
			operations: {},
		};

		expect(withResolver.resolver).toEqual(resolverConfig);
		expect(withResolver.resolver?.clientProfile).toBe("safari17_0");
		expect(vendor).toBe("2captcha");
		expect(withoutResolver.resolver).toBeUndefined();
		await expect(
			rejectingResolver.solve({ kind, siteKey: "key", pageUrl: "https://example.com" }),
		).rejects.toThrow("resolver is unavailable in type tests");
	});

	it("accepts ADR vendor orderings", () => {
		const awsWafResolver: ProviderResolverConfig = {
			vendors: ["browser", "capsolver"],
			kinds: ["aws_waf"],
		};
		const tokenResolver: ProviderResolverConfig = {
			vendors: ["capsolver", "capmonster"],
			kinds: ["turnstile", "recaptcha_v2", "recaptcha_v3", "hcaptcha"],
		};
		expect(awsWafResolver.vendors).toEqual(["browser", "capsolver"]);
		expect(tokenResolver.vendors).toEqual(["capsolver", "capmonster"]);
	});

	it("fails closed when the resolver runtime is unsupported", async () => {
		const reason = "Resolver is unavailable in the challenge resolver type test";
		const challenge: ProviderChallenge = {
			kind: "turnstile",
			siteKey: "key",
			pageUrl: "https://example.com",
		};

		await expect(
			createUnsupportedResolverClient().solve(challenge),
		).rejects.toMatchObject({
			code: "RESOLVER_UNAVAILABLE",
		});
		await expect(createUnsupportedResolverClient(reason).solve(challenge)).rejects.toThrow(reason);
	});
});
