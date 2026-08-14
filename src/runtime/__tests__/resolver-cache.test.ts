import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import type {
	ChallengeSolution,
	ProviderCache,
	ProviderCacheGetOrSetOptions,
	ProviderChallenge,
} from "../../types.js";
import { VALID_PROVIDER_CHALLENGE_KINDS } from "../../define.js";
import { createProviderCache, resetProviderCacheForTests } from "../cache.js";
import {
	APIFUSE__CDP_POOL__URL,
	createResolverClient,
	createResolverClientFromEnvForTests,
	invalidateResolverSolution,
} from "../resolver.js";
import {
	RESOLVER_CHALLENGE_BINDINGS,
	resolverChallengeIsCacheable,
	resolverChallengeIsIdentityScoped,
	resolverChallengeIssuingIdentity,
} from "../resolver-vendors/bindings.js";
import type { ResolverIdentity, ResolverVendorAdapter } from "../resolver-vendors/types.js";

const CHALLENGE = {
	kind: "aws_waf",
	pageUrl: "https://example.com/protected?attempt=1",
} satisfies ProviderChallenge;

const IDENTITY_SCOPED_CHALLENGE = {
	kind: "cloudflare_interstitial",
	pageUrl: CHALLENGE.pageUrl,
} satisfies ProviderChallenge;

const AKAMAI_SENSOR_CHALLENGE = {
	kind: "akamai_sensor",
	pageUrl: CHALLENGE.pageUrl,
	scriptUrl: "https://example.com/akamai/sensor.js",
} satisfies ProviderChallenge;

const AKAMAI_SEC_CPT_CHALLENGE = {
	kind: "akamai_sec_cpt",
	pageUrl: CHALLENGE.pageUrl,
} satisfies ProviderChallenge;

type KeyCall = {
	readonly key: string;
	readonly namespace: string;
	readonly parts: unknown;
};

function createRecordingCache(now?: () => number): {
	readonly cache: ProviderCache;
	readonly inner: ProviderCache;
	readonly keyCalls: KeyCall[];
	readonly getCalls: string[];
	readonly setCalls: { readonly key: string; readonly options: ProviderCacheGetOrSetOptions }[];
} {
	const inner = createProviderCache({
		providerId: "resolver-cache-test",
		redisUrl: "",
		...(now ? { now } : {}),
	});
	const keyCalls: KeyCall[] = [];
	const getCalls: string[] = [];
	const setCalls: { key: string; options: ProviderCacheGetOrSetOptions }[] = [];
	const cache: ProviderCache = {
		key(namespace, parts, options) {
			const key = inner.key(namespace, parts, options);
			keyCalls.push({ key, namespace, parts });
			return key;
		},
		get(key) {
			getCalls.push(key);
			return inner.get(key);
		},
		async set(key, value, options) {
			setCalls.push({ key, options });
			await inner.set(key, value, options);
		},
		delete: (key) => inner.delete(key),
		getOrSet: (key, loader, options) => inner.getOrSet(key, loader, options),
		responseMeta: () => inner.responseMeta(),
	};
	return { cache, inner, keyCalls, getCalls, setCalls };
}

function createBrowserAdapter(
	createSolution: (
		identity: ResolverIdentity | undefined,
		call: number,
	) => Extract<ChallengeSolution, { readonly form: "cookies" }>,
): { readonly adapter: ResolverVendorAdapter; readonly calls: () => number } {
	let calls = 0;
	return {
		adapter: {
			id: "browser",
			supports: (kind) => kind === "aws_waf" || kind === "cloudflare_interstitial",
			getIssuingIdentity(solution, requestedIdentity, challenge) {
				if (solution.form !== "cookies") return undefined;
				return resolverChallengeIssuingIdentity(challenge, {
					...(requestedIdentity ? { proxyUrl: requestedIdentity.proxyUrl } : {}),
					userAgent: solution.userAgent,
				});
			},
			async solve(_challenge, identity) {
				calls += 1;
				return createSolution(identity, calls);
			},
		},
		calls: () => calls,
	};
}

function createAkamaiAdapter(
	createSolution: (
		identity: ResolverIdentity | undefined,
		call: number,
	) => Extract<ChallengeSolution, { readonly form: "cookies" }>,
): { readonly adapter: ResolverVendorAdapter; readonly calls: () => number } {
	let calls = 0;
	return {
		adapter: {
			id: "custom",
			supports: (kind) => kind === "akamai_sec_cpt" || kind === "akamai_sensor",
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
): Extract<ChallengeSolution, { readonly form: "cookies" }> {
	return {
		form: "cookies",
		cookies: { "aws-waf-token": `token-for-${userAgent}` },
		userAgent,
		expires,
	};
}

function persistentAkamaiSolution(
	userAgent = "Safari/17.0",
	expires = (Date.now() + 60_000) / 1_000,
): Extract<ChallengeSolution, { readonly form: "cookies" }> {
	return {
		form: "cookies",
		cookies: { _abck: `sensor-cookie-for-${userAgent}` },
		userAgent,
		expires,
	};
}

function expectedSolutionCacheKey(
	cache: ProviderCache,
	challenge: ProviderChallenge,
	identity: { readonly proxyUrl?: string; readonly userAgent: string },
): string {
	const issuerDigest = createHash("sha256")
		.update(
			JSON.stringify({
				proxyUrl: identity.proxyUrl ?? null,
				userAgent: identity.userAgent,
			}),
		)
		.digest("hex");
	return cache.key("resolver-solution", {
		kind: challenge.kind,
		origin: new URL(challenge.pageUrl).origin,
		issuerDigest,
	});
}

function expectedDirectIndexKey(cache: ProviderCache, challenge: ProviderChallenge): string {
	return cache.key("resolver-solution-index", {
		kind: challenge.kind,
		origin: new URL(challenge.pageUrl).origin,
	});
}

function expectedScopedSolutionCacheKey(
	cache: ProviderCache,
	challenge: ProviderChallenge,
	identityScope: string,
): string {
	const issuerDigest = createHash("sha256").update(JSON.stringify({ identityScope })).digest("hex");
	return cache.key("resolver-solution", {
		kind: challenge.kind,
		origin: new URL(challenge.pageUrl).origin,
		issuerDigest,
	});
}

function createClient(
	adapter: ResolverVendorAdapter,
	options: {
		readonly cache?: ProviderCache;
		readonly identity?: ResolverIdentity;
		readonly kinds?: readonly ProviderChallenge["kind"][];
	} = {},
) {
	return createResolverClient({
		kinds: options.kinds ?? ["aws_waf"],
		adapters: [adapter],
		...(options.cache ? { cache: options.cache } : {}),
		...(options.identity ? { identity: options.identity } : {}),
	});
}

beforeEach(() => {
	resetProviderCacheForTests();
});

describe("resolver solution caching", () => {
	it("declares cache behavior for every challenge kind", () => {
		expect(Object.keys(RESOLVER_CHALLENGE_BINDINGS)).toEqual([...VALID_PROVIDER_CHALLENGE_KINDS]);
		expect(
			Object.fromEntries(
				Object.entries(RESOLVER_CHALLENGE_BINDINGS).map(([kind, binding]) => [
					kind,
					{ cacheable: binding.cacheable, directCacheable: binding.directCacheable },
				]),
			),
		).toEqual({
			turnstile: { cacheable: false, directCacheable: false },
			recaptcha_v2: { cacheable: false, directCacheable: false },
			recaptcha_v3: { cacheable: false, directCacheable: false },
			hcaptcha: { cacheable: false, directCacheable: false },
			cloudflare_interstitial: { cacheable: true, directCacheable: true },
			aws_waf: { cacheable: true, directCacheable: true },
			akamai_sec_cpt: { cacheable: true, directCacheable: false },
			akamai_sensor: { cacheable: true, directCacheable: false },
		});
	});

	it("treats both Akamai challenge kinds as identity-scoped", () => {
		expect(
			resolverChallengeIsIdentityScoped({
				kind: "akamai_sec_cpt",
				pageUrl: "https://example.com/challenge",
			}),
		).toBe(true);
		expect(resolverChallengeIsIdentityScoped(AKAMAI_SENSOR_CHALLENGE)).toBe(true);
	});

	it("does not consult the cache for token kinds and does consult it for cookie kinds", async () => {
		const tokenRecording = createRecordingCache();
		const tokenAdapter: ResolverVendorAdapter = {
			id: "custom",
			supports: (kind) => kind === "turnstile",
			async solve() {
				return { form: "token", token: "solved" };
			},
		};
		await createClient(tokenAdapter, {
			cache: tokenRecording.cache,
			kinds: ["turnstile"],
		}).solve({ kind: "turnstile", siteKey: "site-key", pageUrl: CHALLENGE.pageUrl });

		expect(
			resolverChallengeIsCacheable({
				kind: "turnstile",
				siteKey: "site-key",
				pageUrl: CHALLENGE.pageUrl,
			}),
		).toBe(false);
		expect(tokenRecording.getCalls).toHaveLength(0);

		const cookieRecording = createRecordingCache();
		const cookieStub = createBrowserAdapter(() => ({
			form: "cookies",
			cookies: { "aws-waf-token": "session-token" },
			userAgent: "Browser/session",
		}));
		await createClient(cookieStub.adapter, { cache: cookieRecording.cache }).solve(CHALLENGE);

		expect(resolverChallengeIsCacheable(CHALLENGE)).toBe(true);
		expect(cookieRecording.getCalls).toHaveLength(1);
	});

	it("hits the chain for every solve when no cache is supplied", async () => {
		const stub = createBrowserAdapter(() => persistentSolution());
		const noCacheAdapter: ResolverVendorAdapter = {
			...stub.adapter,
			getIssuingIdentity() {
				throw new Error("no-cache solves must not inspect issuing identity");
			},
		};
		const resolver = createResolverClientFromEnvForTests(
			{ vendors: ["browser"], kinds: ["aws_waf"] },
			{ [APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test" },
			{},
			{ browser: () => noCacheAdapter },
		);
		await resolver.solve(CHALLENGE);
		await resolver.solve(CHALLENGE);
		await resolver.solve(CHALLENGE);

		expect(stub.calls()).toBe(3);
	});

	it("caches a portable direct solution through the shared index", async () => {
		const { cache, inner } = createRecordingCache();
		const userAgent = "Browser/direct-portable";
		const stub = createBrowserAdapter(() => persistentSolution(userAgent));
		const resolver = createClient(stub.adapter, { cache });

		const first = await resolver.solve(CHALLENGE);
		expect(
			await inner.get(expectedSolutionCacheKey(cache, CHALLENGE, { userAgent })),
		).not.toBeNull();
		expect(await inner.get(expectedDirectIndexKey(cache, CHALLENGE))).not.toBeNull();
		const second = await resolver.solve(CHALLENGE);

		expect(second).toEqual(first);
		expect(stub.calls()).toBe(1);
	});

	it("caches a direct Cloudflare solution and retrieves it through the direct index", async () => {
		const { cache, inner } = createRecordingCache();
		const userAgent = "Browser/cloudflare-direct";
		const stub = createBrowserAdapter(() => persistentSolution(userAgent));
		const resolver = createClient(stub.adapter, {
			cache,
			kinds: ["cloudflare_interstitial"],
		});

		const first = await resolver.solve(IDENTITY_SCOPED_CHALLENGE);
		expect(
			await inner.get(expectedSolutionCacheKey(cache, IDENTITY_SCOPED_CHALLENGE, { userAgent })),
		).not.toBeNull();
		expect(
			await inner.get(expectedDirectIndexKey(cache, IDENTITY_SCOPED_CHALLENGE)),
		).not.toBeNull();

		const second = await resolver.solve(IDENTITY_SCOPED_CHALLENGE);

		expect(second).toEqual(first);
		expect(stub.calls()).toBe(1);
	});

	it("keeps a scoped Cloudflare solution on its identity-scope key", async () => {
		const { cache, inner } = createRecordingCache();
		const identityScope = "proxy-session-cloudflare";
		const stub = createBrowserAdapter(() => persistentSolution("Browser/cloudflare-scoped"));
		const resolver = createResolverClientFromEnvForTests(
			{ vendors: ["browser"], kinds: ["cloudflare_interstitial"] },
			{ [APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test" },
			{ cache, identityScope },
			{ browser: () => stub.adapter },
		);

		const first = await resolver.solve(IDENTITY_SCOPED_CHALLENGE);
		expect(
			await inner.get(
				expectedScopedSolutionCacheKey(cache, IDENTITY_SCOPED_CHALLENGE, identityScope),
			),
		).not.toBeNull();
		expect(await inner.get(expectedDirectIndexKey(cache, IDENTITY_SCOPED_CHALLENGE))).toBeNull();

		const second = await resolver.solve(IDENTITY_SCOPED_CHALLENGE);

		expect(second).toEqual(first);
		expect(stub.calls()).toBe(1);
	});

	it("re-serves an identity-scoped solution bound to a proxy identity", async () => {
		const { cache } = createRecordingCache();
		const identity = {
			proxyUrl: "http://user:password@proxy.test:8080",
			userAgent: "Safari/17.0 proxied",
		};
		const stub = createAkamaiAdapter((requestedIdentity) =>
			persistentAkamaiSolution(requestedIdentity?.userAgent),
		);
		const resolver = createClient(stub.adapter, {
			cache,
			identity,
			kinds: ["akamai_sensor"],
		});

		const first = await resolver.solve(AKAMAI_SENSOR_CHALLENGE);
		const second = await resolver.solve(AKAMAI_SENSOR_CHALLENGE);

		expect(second).toEqual(first);
		expect(stub.calls()).toBe(1);
	});

	it.each([
		AKAMAI_SEC_CPT_CHALLENGE,
		AKAMAI_SENSOR_CHALLENGE,
	] as const)("does not cache unbound direct $kind solutions", async (challenge) => {
		const { cache, inner } = createRecordingCache();
		const stub = createAkamaiAdapter((_identity, call) =>
			persistentAkamaiSolution(`Safari/unbound-${call}`),
		);
		const resolver = createClient(stub.adapter, {
			cache,
			kinds: [challenge.kind],
		});
		const firstUserAgent = "Safari/unbound-1";

		const first = await resolver.solve(challenge);
		expect(
			await inner.get(expectedSolutionCacheKey(cache, challenge, { userAgent: firstUserAgent })),
		).toBeNull();
		expect(await inner.get(expectedDirectIndexKey(cache, challenge))).toBeNull();

		const second = await resolver.solve(challenge);

		expect(second).not.toEqual(first);
		expect(stub.calls()).toBe(2);
		expect(await inner.get(expectedDirectIndexKey(cache, challenge))).toBeNull();
	});

	it("enables caching through createResolverClientFromEnv's runtime options", async () => {
		const { cache } = createRecordingCache();
		const stub = createBrowserAdapter(() => persistentSolution());
		const declaredHosts = ["example.com", "assets.example.com"];
		let adapterHosts: readonly string[] | undefined;
		const resolver = createResolverClientFromEnvForTests(
			{ vendors: ["browser"], kinds: ["aws_waf"] },
			{ [APIFUSE__CDP_POOL__URL]: "ws://cdp-pool.test" },
			{
				allowedHosts: declaredHosts,
				cache,
			},
			{
				browser(_configuration, _timeoutMs, allowedHosts) {
					adapterHosts = allowedHosts;
					return stub.adapter;
				},
			},
		);
		await resolver.solve(CHALLENGE);
		await resolver.solve(CHALLENGE);

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

	it("shares a portable solution across proxy identities", async () => {
		const { cache } = createRecordingCache();
		const stub = createBrowserAdapter((identity) => persistentSolution(identity?.userAgent));
		const firstIdentity = {
			proxyUrl: "http://first-user:first-password@proxy.test:8080",
			userAgent: "Browser/shared",
		};
		const secondIdentity = {
			proxyUrl: "http://second-user:second-password@proxy.test:8080",
			userAgent: "Browser/shared",
		};

		await createClient(stub.adapter, { cache, identity: firstIdentity }).solve(CHALLENGE);
		await createClient(stub.adapter, { cache, identity: secondIdentity }).solve(CHALLENGE);

		expect(stub.calls()).toBe(1);
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

		const kinds = ["cloudflare_interstitial"] as const;
		await createClient(stub.adapter, { cache, identity: firstIdentity, kinds }).solve(
			IDENTITY_SCOPED_CHALLENGE,
		);
		await createClient(stub.adapter, { cache, identity: secondIdentity, kinds }).solve(
			IDENTITY_SCOPED_CHALLENGE,
		);
		await createClient(stub.adapter, { cache, identity: thirdIdentity, kinds }).solve(
			IDENTITY_SCOPED_CHALLENGE,
		);

		const solutionKeyCalls = keyCalls.filter((call) => call.namespace === "resolver-solution");
		const solutionKeys = [...new Set(solutionKeyCalls.map((call) => call.key))];
		expect(stub.calls()).toBe(3);
		if (solutionKeys.length !== 3) {
			throw new Error(
				"Each issuerDigest must produce a distinct resolver key for each issuing identity.",
			);
		}
		expect(solutionKeys[0]).not.toBe(solutionKeys[1]);
		expect(solutionKeys[1]).not.toBe(solutionKeys[2]);
		expect(solutionKeyCalls[0]?.parts).toEqual({
			kind: "cloudflare_interstitial",
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
				"Resolver cache identity material must remain under issuerDigest.",
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
				"issuerDigest must affect resolver cache keys.",
			);
		}
		const firstCookieKey = cache.key("resolver-identity-field-contrast", {
			cookieDigest: issuerDigests[0],
		});
		const secondCookieKey = cache.key("resolver-identity-field-contrast", {
			cookieDigest: issuerDigests[1],
		});
		if (firstCookieKey === secondCookieKey) {
			throw new Error(
				"Secret-looking cache-key fields must preserve identity separation after their values are hashed.",
			);
		}
	});

	it("uses distinct non-secret cache keys for Akamai sensor identities", async () => {
		const { cache, keyCalls } = createRecordingCache();
		const stub = createAkamaiAdapter((identity) => persistentAkamaiSolution(identity?.userAgent));
		const firstPassword = "akamai-first-password";
		const secondPassword = "akamai-second-password";
		const firstIdentity = {
			proxyUrl: `http://first-user:${firstPassword}@proxy.test:8080`,
			userAgent: "Safari/17.0 first",
		};
		const secondIdentity = {
			proxyUrl: `http://second-user:${secondPassword}@proxy.test:8080`,
			userAgent: "Safari/17.0 second",
		};
		const kinds = ["akamai_sensor"] as const;

		await createClient(stub.adapter, { cache, identity: firstIdentity, kinds }).solve(
			AKAMAI_SENSOR_CHALLENGE,
		);
		await createClient(stub.adapter, { cache, identity: secondIdentity, kinds }).solve(
			AKAMAI_SENSOR_CHALLENGE,
		);

		const solutionKeys = [
			...new Set(
				keyCalls.filter((call) => call.namespace === "resolver-solution").map((call) => call.key),
			),
		];
		expect(solutionKeys).toHaveLength(2);
		expect(solutionKeys[0]).not.toBe(solutionKeys[1]);
		expect(solutionKeys.every((key) => !key.includes(firstPassword))).toBe(true);
		expect(solutionKeys.every((key) => !key.includes(secondPassword))).toBe(true);
	});

	it("caches an expiring non-browser cookie solution but not a session solution", async () => {
		const { cache } = createRecordingCache();
		const persistent = createAkamaiAdapter(() =>
			persistentAkamaiSolution("Safari/17.0", (Date.now() + 60_000) / 1_000),
		);
		const persistentResolver = createClient(persistent.adapter, {
			cache,
			identity: {
				proxyUrl: "http://persistent-identity.proxy.test:8080",
				userAgent: "Safari/17.0",
			},
			kinds: ["akamai_sensor"],
		});

		await persistentResolver.solve(AKAMAI_SENSOR_CHALLENGE);
		await persistentResolver.solve(AKAMAI_SENSOR_CHALLENGE);
		expect(persistent.calls()).toBe(1);

		const session = createAkamaiAdapter(() => ({
			form: "cookies",
			cookies: { _abck: "session-cookie" },
			userAgent: "Safari/17.0 session",
		}));
		const sessionResolver = createClient(session.adapter, {
			cache,
			identity: {
				proxyUrl: "http://session-identity.proxy.test:8080",
				userAgent: "Safari/17.0 session",
			},
			kinds: ["akamai_sensor"],
		});

		await sessionResolver.solve(AKAMAI_SENSOR_CHALLENGE);
		await sessionResolver.solve(AKAMAI_SENSOR_CHALLENGE);
		expect(session.calls()).toBe(2);
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

		const kinds = ["cloudflare_interstitial"] as const;
		await createClient(stub.adapter, { cache, identity: proxyIdentity, kinds }).solve(
			IDENTITY_SCOPED_CHALLENGE,
		);
		await createClient(stub.adapter, { cache, kinds }).solve(IDENTITY_SCOPED_CHALLENGE);

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
		const kinds = ["cloudflare_interstitial"] as const;
		const firstResolver = createClient(stub.adapter, { cache, identity: firstIdentity, kinds });
		const secondResolver = createClient(stub.adapter, { cache, identity: secondIdentity, kinds });
		const first = await firstResolver.solve(IDENTITY_SCOPED_CHALLENGE);
		await secondResolver.solve(IDENTITY_SCOPED_CHALLENGE);
		const solutionKeys = [
			...new Set(
				keyCalls.filter((call) => call.namespace === "resolver-solution").map((call) => call.key),
			),
		];
		const clonedFirst = structuredClone(first);
		await invalidateResolverSolution(firstResolver, IDENTITY_SCOPED_CHALLENGE, clonedFirst);
		expect(await inner.get(solutionKeys[0] as string)).not.toBeNull();

		await invalidateResolverSolution(firstResolver, IDENTITY_SCOPED_CHALLENGE, first);

		expect(await inner.get(solutionKeys[0] as string)).toBeNull();
		expect(await inner.get(solutionKeys[1] as string)).not.toBeNull();
		await firstResolver.solve(IDENTITY_SCOPED_CHALLENGE);
		await secondResolver.solve(IDENTITY_SCOPED_CHALLENGE);
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
