import { beforeEach, describe, expect, it } from "bun:test";

import type {
	ChallengeSolution,
	ProviderCache,
	ProviderCacheGetOrSetOptions,
	ProviderChallenge,
} from "../../types.js";
import { createProviderCache, resetProviderCacheForTests } from "../cache.js";
import {
	APIFUSE__CDP_POOL__URL,
	createResolverClient,
	createResolverClientFromEnv,
	invalidateResolverSolution,
	RESOLVER_ADAPTER_REGISTRY,
} from "../resolver.js";
import type { ResolverIdentity, ResolverVendorAdapter } from "../resolver-vendors/types.js";

const CHALLENGE = {
	kind: "aws_waf",
	pageUrl: "https://example.com/protected?attempt=1",
} satisfies ProviderChallenge;

type BrowserSolution = Extract<ChallengeSolution, { readonly form: "cookies" }> & {
	readonly expires?: number;
};

type KeyCall = {
	readonly key: string;
	readonly namespace: string;
	readonly parts: unknown;
};

function createRecordingCache(now?: () => number): {
	readonly cache: ProviderCache;
	readonly inner: ProviderCache;
	readonly keyCalls: KeyCall[];
	readonly setCalls: { readonly key: string; readonly options: ProviderCacheGetOrSetOptions }[];
} {
	const inner = createProviderCache({
		providerId: "resolver-cache-test",
		redisUrl: "",
		...(now ? { now } : {}),
	});
	const keyCalls: KeyCall[] = [];
	const setCalls: { key: string; options: ProviderCacheGetOrSetOptions }[] = [];
	const cache: ProviderCache = {
		key(namespace, parts, options) {
			const key = inner.key(namespace, parts, options);
			keyCalls.push({ key, namespace, parts });
			return key;
		},
		get: (key) => inner.get(key),
		async set(key, value, options) {
			setCalls.push({ key, options });
			await inner.set(key, value, options);
		},
		delete: (key) => inner.delete(key),
		getOrSet: (key, loader, options) => inner.getOrSet(key, loader, options),
		responseMeta: () => inner.responseMeta(),
	};
	return { cache, inner, keyCalls, setCalls };
}

function createBrowserAdapter(
	createSolution: (identity: ResolverIdentity | undefined, call: number) => BrowserSolution,
): { readonly adapter: ResolverVendorAdapter; readonly calls: () => number } {
	let calls = 0;
	return {
		adapter: {
			id: "browser",
			supports: (kind) => kind === "aws_waf",
			getIssuingIdentity(solution, requestedIdentity) {
				if (solution.form !== "cookies") return undefined;
				return {
					...(requestedIdentity ? { proxyUrl: requestedIdentity.proxyUrl } : {}),
					userAgent: solution.userAgent,
				};
			},
			async solve(_challenge, identity) {
				calls += 1;
				return createSolution(identity, calls);
			},
		},
		calls: () => calls,
	};
}

function persistentSolution(
	userAgent = "Browser/1.0",
	expires = (Date.now() + 60_000) / 1_000,
): BrowserSolution {
	return {
		form: "cookies",
		cookies: { "aws-waf-token": `token-for-${userAgent}` },
		userAgent,
		expires,
	};
}

function createClient(
	adapter: ResolverVendorAdapter,
	options: { readonly cache?: ProviderCache; readonly identity?: ResolverIdentity } = {},
) {
	return createResolverClient({
		kinds: ["aws_waf"],
		adapters: [adapter],
		...options,
	});
}

beforeEach(() => {
	resetProviderCacheForTests();
});

describe("resolver solution caching", () => {
	it("hits the chain for every solve when no cache is supplied", async () => {
		const stub = createBrowserAdapter(() => persistentSolution());
		const noCacheAdapter: ResolverVendorAdapter = {
			...stub.adapter,
			getIssuingIdentity() {
				throw new Error("no-cache solves must not inspect issuing identity");
			},
		};
		const registry = RESOLVER_ADAPTER_REGISTRY as {
			browser?: (configuration: string, timeoutMs: number) => ResolverVendorAdapter;
		};
		const original = registry.browser;
		registry.browser = () => noCacheAdapter;
		try {
			const resolver = createResolverClientFromEnv(
				{ vendors: ["browser"], kinds: ["aws_waf"] },
				{ [APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test" },
			);
			await resolver.solve(CHALLENGE);
			await resolver.solve(CHALLENGE);
			await resolver.solve(CHALLENGE);
		} finally {
			registry.browser = original;
		}

		expect(stub.calls()).toBe(3);
	});

	it("reuses a browser solution within its advertised lifetime", async () => {
		const { cache } = createRecordingCache();
		const stub = createBrowserAdapter(() => persistentSolution());
		const resolver = createClient(stub.adapter, { cache });

		const first = await resolver.solve(CHALLENGE);
		const second = await resolver.solve(CHALLENGE);

		expect(second).toEqual(first);
		expect(stub.calls()).toBe(1);
	});

	it("enables caching through createResolverClientFromEnv's runtime options", async () => {
		const { cache } = createRecordingCache();
		const stub = createBrowserAdapter(() => persistentSolution());
		const declaredHosts = ["example.com", "assets.example.com"];
		let adapterHosts: readonly string[] | undefined;
		const registry = RESOLVER_ADAPTER_REGISTRY as {
			browser?: (
				configuration: string,
				timeoutMs: number,
				allowedHosts: readonly string[],
			) => ResolverVendorAdapter;
		};
		const original = registry.browser;
		registry.browser = (_configuration, _timeoutMs, allowedHosts) => {
			adapterHosts = allowedHosts;
			return stub.adapter;
		};
		try {
			const resolver = createResolverClientFromEnv(
				{ vendors: ["browser"], kinds: ["aws_waf"] },
				{ [APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test" },
				{ allowedHosts: declaredHosts, cache },
			);
			await resolver.solve(CHALLENGE);
			await resolver.solve(CHALLENGE);
		} finally {
			registry.browser = original;
		}

		expect(stub.calls()).toBe(1);
		expect(adapterHosts).toEqual(declaredHosts);
	});

	it("uses the page origin rather than its query string", async () => {
		const { cache } = createRecordingCache();
		const stub = createBrowserAdapter(() => persistentSolution());
		const resolver = createClient(stub.adapter, { cache });

		await resolver.solve(CHALLENGE);
		await resolver.solve({ ...CHALLENGE, pageUrl: "https://example.com/other?attempt=2" });

		expect(stub.calls()).toBe(1);
	});

	it("runs the adapter again after the upstream expiry", async () => {
		let now = Date.now();
		const { cache } = createRecordingCache(() => now);
		const stub = createBrowserAdapter(() =>
			persistentSolution("Browser/1.0", (now + 5_000) / 1_000),
		);
		const resolver = createClient(stub.adapter, { cache });

		await resolver.solve(CHALLENGE);
		now += 5_001;
		await resolver.solve(CHALLENGE);

		expect(stub.calls()).toBe(2);
	});

	it("separates identities in distinct solution keys and solves each one", async () => {
		const { cache, keyCalls } = createRecordingCache();
		const stub = createBrowserAdapter((identity) => persistentSolution(identity?.userAgent));
		const firstIdentity = {
			proxyUrl: "http://first-user:first-password@proxy.test:8080",
			userAgent: "Browser/shared",
		};
		const secondIdentity = {
			proxyUrl: "http://second-user:second-password@proxy.test:8080",
			userAgent: "Browser/shared",
		};
		const thirdIdentity = {
			proxyUrl: secondIdentity.proxyUrl,
			userAgent: "Browser/other",
		};

		await createClient(stub.adapter, { cache, identity: firstIdentity }).solve(CHALLENGE);
		await createClient(stub.adapter, { cache, identity: secondIdentity }).solve(CHALLENGE);
		await createClient(stub.adapter, { cache, identity: thirdIdentity }).solve(CHALLENGE);

		const solutionKeyCalls = keyCalls.filter((call) => call.namespace === "resolver-solution");
		const solutionKeys = [...new Set(solutionKeyCalls.map((call) => call.key))];
		expect(stub.calls()).toBe(3);
		if (solutionKeys.length !== 3) {
			throw new Error(
				"Each issuerDigest must produce a distinct resolver key; ProviderCache redacts cookie-containing field names, so renaming this field to cookieDigest collapses identities into one cache entry.",
			);
		}
		expect(solutionKeys[0]).not.toBe(solutionKeys[1]);
		expect(solutionKeys[1]).not.toBe(solutionKeys[2]);
		expect(solutionKeyCalls[0]?.parts).toEqual({
			kind: "aws_waf",
			origin: "https://example.com",
			issuerDigest: expect.any(String),
		});

		const issuerDigests = [
			...new Set(
				solutionKeyCalls.map(
					(call) => (call.parts as { readonly issuerDigest?: unknown }).issuerDigest,
				),
			),
		];
		if (issuerDigests.length !== 3 || !issuerDigests.every((value) => typeof value === "string")) {
			throw new Error(
				"Resolver cache identity material must remain under issuerDigest; ProviderCache redacts field names containing cookie and would collapse identities.",
			);
		}
		const firstIssuerKey = cache.key("resolver-identity-field-contrast", {
			issuerDigest: issuerDigests[0],
		});
		const secondIssuerKey = cache.key("resolver-identity-field-contrast", {
			issuerDigest: issuerDigests[1],
		});
		if (firstIssuerKey === secondIssuerKey) {
			throw new Error(
				"issuerDigest must affect resolver cache keys; renaming it to a cookie-containing field would trigger ProviderCache redaction and cross-identity collisions.",
			);
		}
		const firstCookieKey = cache.key("resolver-identity-field-contrast", {
			cookieDigest: issuerDigests[0],
		});
		const secondCookieKey = cache.key("resolver-identity-field-contrast", {
			cookieDigest: issuerDigests[1],
		});
		if (firstCookieKey !== secondCookieKey) {
			throw new Error(
				"The cache-key contrast no longer demonstrates the trap: ProviderCache must redact cookie-containing field names, making different cookieDigest values collide.",
			);
		}
	});

	it("ignores a cached cookie solution missing userAgent and solves fresh", async () => {
		const { cache, inner, keyCalls } = createRecordingCache();
		const stub = createBrowserAdapter((_identity, call) =>
			persistentSolution(`Browser/fresh-${call}`),
		);
		const resolver = createClient(stub.adapter, { cache });
		await resolver.solve(CHALLENGE);
		const solutionKey = keyCalls.find((call) => call.namespace === "resolver-solution")?.key;
		if (!solutionKey) throw new Error("Expected the first solve to write a solution cache key");
		const cached = await inner.get(solutionKey);
		if (!cached || typeof cached.value !== "object" || cached.value === null) {
			throw new Error("Expected the first solve to write a solution cache entry");
		}
		const entry = cached.value as {
			readonly expiresAtMs: number;
			readonly issuerDigest: string;
		};
		await inner.set(
			solutionKey,
			{
				expiresAtMs: entry.expiresAtMs,
				issuerDigest: entry.issuerDigest,
				solution: { form: "cookies", cookies: { "aws-waf-token": "malformed" } },
			},
			{ ttlMs: 60_000 },
		);

		const solution = await resolver.solve(CHALLENGE);

		expect(solution).toMatchObject({
			form: "cookies",
			cookies: { "aws-waf-token": "token-for-Browser/fresh-2" },
			userAgent: "Browser/fresh-2",
		});
		expect(stub.calls()).toBe(2);
	});

	it("ignores a cached cookie solution whose cookies are not a string map", async () => {
		const { cache, inner, keyCalls } = createRecordingCache();
		const stub = createBrowserAdapter((_identity, call) =>
			persistentSolution(`Browser/fresh-${call}`),
		);
		const resolver = createClient(stub.adapter, { cache });
		await resolver.solve(CHALLENGE);
		const solutionKey = keyCalls.find((call) => call.namespace === "resolver-solution")?.key;
		if (!solutionKey) throw new Error("Expected the first solve to write a solution cache key");
		const cached = await inner.get(solutionKey);
		if (!cached || typeof cached.value !== "object" || cached.value === null) {
			throw new Error("Expected the first solve to write a solution cache entry");
		}
		const entry = cached.value as {
			readonly expiresAtMs: number;
			readonly issuerDigest: string;
		};
		await inner.set(
			solutionKey,
			{
				expiresAtMs: entry.expiresAtMs,
				issuerDigest: entry.issuerDigest,
				solution: {
					form: "cookies",
					cookies: { "aws-waf-token": 42 },
					userAgent: "Browser/malformed",
				},
			},
			{ ttlMs: 60_000 },
		);

		const solution = await resolver.solve(CHALLENGE);

		expect(solution).toMatchObject({
			form: "cookies",
			cookies: { "aws-waf-token": "token-for-Browser/fresh-2" },
			userAgent: "Browser/fresh-2",
		});
		expect(stub.calls()).toBe(2);
	});

	it("never serves a proxy-bound entry through the direct-identity locator", async () => {
		const { cache } = createRecordingCache();
		const stub = createBrowserAdapter((identity) => persistentSolution(identity?.userAgent));
		const proxyIdentity = {
			proxyUrl: "http://user:password@proxy.test:8080",
			userAgent: "Browser/proxied",
		};

		await createClient(stub.adapter, { cache, identity: proxyIdentity }).solve(CHALLENGE);
		await createClient(stub.adapter, { cache }).solve(CHALLENGE);

		expect(stub.calls()).toBe(2);
	});

	it("does not cache a session-cookie solution without expires", async () => {
		const { cache } = createRecordingCache();
		const stub = createBrowserAdapter(() => ({
			form: "cookies",
			cookies: { "aws-waf-token": "session-token" },
			userAgent: "Browser/session",
		}));
		const resolver = createClient(stub.adapter, { cache });

		await resolver.solve(CHALLENGE);
		await resolver.solve(CHALLENGE);
		await resolver.solve(CHALLENGE);

		expect(stub.calls()).toBe(3);
	});

	it("does not cache a solution that is expired or inside the one-second floor", async () => {
		const { cache } = createRecordingCache();
		const expiries = [(Date.now() - 1_000) / 1_000, (Date.now() + 500) / 1_000];
		const stub = createBrowserAdapter((_identity, call) =>
			persistentSolution("Browser/expired", expiries[call - 1]),
		);
		const resolver = createClient(stub.adapter, { cache });

		await resolver.solve(CHALLENGE);
		await resolver.solve(CHALLENGE);
		await resolver.solve(CHALLENGE);

		expect(stub.calls()).toBe(3);
	});

	it("invalidates only the rejected solution's issuing identity", async () => {
		const { cache, inner, keyCalls } = createRecordingCache();
		const stub = createBrowserAdapter((identity) => persistentSolution(identity?.userAgent));
		const firstIdentity = {
			proxyUrl: "http://first:first-pass@proxy.test:8080",
			userAgent: "Browser/one",
		};
		const secondIdentity = {
			proxyUrl: "http://second:second-pass@proxy.test:8080",
			userAgent: "Browser/two",
		};
		const firstResolver = createClient(stub.adapter, { cache, identity: firstIdentity });
		const secondResolver = createClient(stub.adapter, { cache, identity: secondIdentity });
		const first = await firstResolver.solve(CHALLENGE);
		await secondResolver.solve(CHALLENGE);
		const solutionKeys = [
			...new Set(
				keyCalls.filter((call) => call.namespace === "resolver-solution").map((call) => call.key),
			),
		];
		const clonedFirst = structuredClone(first);
		await invalidateResolverSolution(firstResolver, CHALLENGE, clonedFirst);
		expect(await inner.get(solutionKeys[0] as string)).not.toBeNull();

		await invalidateResolverSolution(firstResolver, CHALLENGE, first);

		expect(await inner.get(solutionKeys[0] as string)).toBeNull();
		expect(await inner.get(solutionKeys[1] as string)).not.toBeNull();
		await firstResolver.solve(CHALLENGE);
		await secondResolver.solve(CHALLENGE);
		expect(stub.calls()).toBe(3);
	});

	it("never puts raw proxy credentials into cache key material", async () => {
		const { cache, keyCalls } = createRecordingCache();
		const password = "credential-password-that-must-not-leak";
		const identity = {
			proxyUrl: `http://resolver-user:${password}@proxy.test:8080`,
			userAgent: "Browser/credential-test",
		};
		const stub = createBrowserAdapter(() => persistentSolution(identity.userAgent));

		await createClient(stub.adapter, { cache, identity }).solve(CHALLENGE);

		expect(JSON.stringify(keyCalls)).not.toContain(password);
		expect(keyCalls.every((call) => !call.key.includes(password))).toBe(true);
	});

	it("keeps the full upstream lifetime without a maximum clamp", async () => {
		const { cache, setCalls } = createRecordingCache();
		const fourDaysMs = 345_035_000;
		const stub = createBrowserAdapter(() =>
			persistentSolution("Browser/long-lived", (Date.now() + fourDaysMs) / 1_000),
		);

		await createClient(stub.adapter, { cache }).solve(CHALLENGE);

		const solutionWrite = setCalls.find((call) => call.key.includes(":resolver-solution:"));
		expect(solutionWrite?.options.ttlMs).toBeGreaterThan(fourDaysMs - 1_000);
	});
});
