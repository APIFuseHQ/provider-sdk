import { createHash } from "node:crypto";

import { ProviderError } from "../errors.js";
import type {
	ChallengeSolution,
	ProviderCache,
	ProviderChallenge,
	ProviderChallengeKind,
	ProviderResolverConfig,
	ProviderResolverVendor,
	ResolverContext,
} from "../types.js";
import { createBrowserResolverVendorAdapter } from "./resolver-vendors/browser.js";
import {
	resolverVendorSupports,
	type ResolverIdentity,
	type ResolverIssuingIdentity,
	type ResolverVendorAdapter,
	type ResolverVendorUnavailableReason,
	ResolverVendorUnavailableError,
} from "./resolver-vendors/types.js";

export const APIFUSE__RESOLVER__2CAPTCHA__API_KEY = "APIFUSE__RESOLVER__2CAPTCHA__API_KEY";
export const APIFUSE__RESOLVER__CAPSOLVER__API_KEY = "APIFUSE__RESOLVER__CAPSOLVER__API_KEY";
export const APIFUSE__RESOLVER__CAPMONSTER__API_KEY = "APIFUSE__RESOLVER__CAPMONSTER__API_KEY";
export const APIFUSE__RESOLVER__TIMEOUT_MS = "APIFUSE__RESOLVER__TIMEOUT_MS";
export const APIFUSE__CDP_POOL__URL = "APIFUSE__CDP_POOL__URL";
export const DEFAULT_RESOLVER_TIMEOUT_MS = 180_000;

type EnvLike = Record<string, string | undefined>;

type ResolvedResolverVendor =
	| {
			readonly vendor: Exclude<ProviderResolverVendor, "custom">;
			readonly available: true;
			readonly configuration: string;
	  }
	| {
			readonly vendor: ProviderResolverVendor;
			readonly available: false;
			readonly reason: ResolverVendorUnavailableReason;
	  };

type ResolverChainAttempt = {
	readonly vendor: ProviderResolverVendor;
	readonly reason: ResolverVendorUnavailableReason;
};

type ResolverChainClient = ResolverContext & {
	solve(challenge: ProviderChallenge, signal?: AbortSignal): Promise<ChallengeSolution>;
};

export interface ResolverRuntimeOptions {
	readonly allowedHosts?: readonly string[];
	readonly cache?: ProviderCache;
}

type CachedResolverSolution = {
	readonly expiresAtMs: number;
	readonly issuerDigest: string;
	readonly solution: ChallengeSolution;
};

type ResolverCacheIndex = {
	readonly entries: readonly {
		readonly direct: true;
		readonly expiresAtMs: number;
		readonly issuerDigest: string;
	}[];
};

const RESOLVER_SOLUTION_CACHE_NAMESPACE = "resolver-solution";
const RESOLVER_SOLUTION_INDEX_CACHE_NAMESPACE = "resolver-solution-index";
const MIN_RESOLVER_CACHE_TTL_MS = 1_000;
const resolverCaches = new WeakMap<object, ProviderCache>();
const solutionIssuerDigests = new WeakMap<object, string>();

type ResolverAdapterFactory = (
	configuration: string,
	timeoutMs: number,
	allowedHosts: readonly string[],
) => ResolverVendorAdapter;

export const RESOLVER_ADAPTER_REGISTRY: Partial<
	Readonly<Record<ProviderResolverVendor, ResolverAdapterFactory>>
> = {
	browser(configuration, timeoutMs, allowedHosts) {
		return createBrowserResolverVendorAdapter({
			allowedHosts,
			cdpUrl: configuration,
			timeoutMs,
		});
	},
};

type ResolverChainEntry = {
	readonly id: ProviderResolverVendor;
	supports(kind: ProviderChallengeKind): boolean;
	createAdapter(): ResolverVendorAdapter;
};

function normalizedEnvValue(env: EnvLike, key: string): string | undefined {
	const value = env[key]?.trim();
	return value ? value : undefined;
}

function readPositiveIntegerEnv(env: EnvLike, name: string): string | undefined {
	const raw = env[name]?.trim();
	if (!raw) return undefined;
	if (!/^[1-9]\d*$/.test(raw)) {
		throw new Error(`${name} must be a positive integer`);
	}
	return raw;
}

function assertDeclaredKind(
	requestedKind: ProviderChallengeKind,
	declaredKinds: readonly ProviderChallengeKind[],
): void {
	if (declaredKinds.includes(requestedKind)) return;

	const declared = declaredKinds.length > 0 ? declaredKinds.join(", ") : "none";
	throw new ProviderError(
		`Resolver kind "${requestedKind}" is not declared; declared kinds: ${declared}`,
		{
			code: "RESOLVER_KIND_NOT_DECLARED",
			fix: `Add "${requestedKind}" to the provider's resolver.kinds declaration.`,
		},
	);
}

function createUnavailableAdapter(
	vendor: ProviderResolverVendor,
	reason: ResolverVendorUnavailableReason,
): ResolverVendorAdapter {
	return {
		id: vendor,
		supports(kind) {
			return resolverVendorSupports(vendor, kind);
		},
		async solve() {
			throw new ResolverVendorUnavailableError(vendor, reason);
		},
	};
}

function createAdapter(
	vendor: ResolvedResolverVendor,
	timeoutMs: number,
	allowedHosts: readonly string[],
): ResolverVendorAdapter {
	if (!vendor.available) {
		return createUnavailableAdapter(vendor.vendor, vendor.reason);
	}

	const factory = RESOLVER_ADAPTER_REGISTRY[vendor.vendor];
	return (
		factory?.(vendor.configuration, timeoutMs, allowedHosts) ??
		createUnavailableAdapter(vendor.vendor, "not_implemented")
	);
}

function throwUnsupportedKind(kind: ProviderChallengeKind): never {
	throw new ProviderError(`Resolver vendor chain does not support kind "${kind}"`, {
		code: "RESOLVER_KIND_UNSUPPORTED_BY_CHAIN",
		fix: `Add a resolver vendor that supports "${kind}" to the provider's resolver.vendors declaration.`,
	});
}

function throwExhausted(attempts: readonly ResolverChainAttempt[]): never {
	const summary = attempts.map(({ vendor, reason }) => `${vendor}: ${reason}`).join(", ");
	throw new ProviderError(`Resolver vendor chain exhausted: ${summary}`, {
		code: "RESOLVER_CHAIN_EXHAUSTED",
		fix: "Configure another supporting resolver vendor or restore an unavailable vendor.",
		details: attempts,
	});
}

function challengeOrigin(challenge: ProviderChallenge): string {
	return new URL(challenge.pageUrl).origin;
}

function resolverIdentityDigest(identity: ResolverIssuingIdentity): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				proxyUrl: identity.proxyUrl ?? null,
				userAgent: identity.userAgent,
			}),
		)
		.digest("hex");
}

function resolverSolutionCacheKey(
	cache: ProviderCache,
	challenge: ProviderChallenge,
	issuerDigest: string,
): string {
	return cache.key(RESOLVER_SOLUTION_CACHE_NAMESPACE, {
		kind: challenge.kind,
		origin: challengeOrigin(challenge),
		issuerDigest,
	});
}

function resolverSolutionIndexCacheKey(cache: ProviderCache, challenge: ProviderChallenge): string {
	return cache.key(RESOLVER_SOLUTION_INDEX_CACHE_NAMESPACE, {
		kind: challenge.kind,
		origin: challengeOrigin(challenge),
	});
}

function isCachedResolverSolution(value: unknown): value is CachedResolverSolution {
	try {
		if (value === null || typeof value !== "object") return false;
		const candidate = value as Partial<CachedResolverSolution>;
		if (
			typeof candidate.expiresAtMs !== "number" ||
			typeof candidate.issuerDigest !== "string" ||
			candidate.solution === null ||
			typeof candidate.solution !== "object" ||
			candidate.solution.form !== "cookies" ||
			typeof candidate.solution.userAgent !== "string"
		) {
			return false;
		}

		const cookies: unknown = candidate.solution.cookies;
		return (
			cookies !== null &&
			typeof cookies === "object" &&
			!Array.isArray(cookies) &&
			Object.values(cookies).every((cookie) => typeof cookie === "string")
		);
	} catch {
		return false;
	}
}

function isResolverCacheIndex(value: unknown): value is ResolverCacheIndex {
	if (value === null || typeof value !== "object") return false;
	const entries = (value as Partial<ResolverCacheIndex>).entries;
	return (
		Array.isArray(entries) &&
		entries.every(
			(entry) =>
				entry !== null &&
				typeof entry === "object" &&
				entry.direct === true &&
				typeof entry.expiresAtMs === "number" &&
				typeof entry.issuerDigest === "string",
		)
	);
}

function solutionExpiryMs(solution: ChallengeSolution): number | undefined {
	if (solution.form !== "cookies") return undefined;
	const expires = (solution as ChallengeSolution & { readonly expires?: unknown }).expires;
	if (typeof expires !== "number" || !Number.isFinite(expires)) return undefined;
	return expires * 1_000;
}

function rememberSolutionIssuer(solution: ChallengeSolution, issuerDigest: string): void {
	if (typeof solution === "object" && solution !== null) {
		solutionIssuerDigests.set(solution, issuerDigest);
	}
}

async function readCachedSolution(
	cache: ProviderCache,
	challenge: ProviderChallenge,
	issuerDigest: string,
	now: number,
): Promise<ChallengeSolution | undefined> {
	const cached = await cache.get(resolverSolutionCacheKey(cache, challenge, issuerDigest));
	if (!cached || !isCachedResolverSolution(cached.value)) return undefined;
	if (cached.value.issuerDigest !== issuerDigest || cached.value.expiresAtMs <= now)
		return undefined;
	rememberSolutionIssuer(cached.value.solution, issuerDigest);
	return cached.value.solution;
}

async function findCachedSolution(
	cache: ProviderCache,
	challenge: ProviderChallenge,
	identity: ResolverIssuingIdentity | undefined,
): Promise<ChallengeSolution | undefined> {
	const now = Date.now();
	if (identity) {
		return await readCachedSolution(cache, challenge, resolverIdentityDigest(identity), now);
	}

	const index = await cache.get(resolverSolutionIndexCacheKey(cache, challenge));
	if (!index || !isResolverCacheIndex(index.value)) return undefined;
	for (const entry of index.value.entries) {
		if (entry.expiresAtMs <= now) continue;
		const solution = await readCachedSolution(cache, challenge, entry.issuerDigest, now);
		if (solution) return solution;
	}
	return undefined;
}

async function writeResolverCacheIndex(
	cache: ProviderCache,
	challenge: ProviderChallenge,
	entries: ResolverCacheIndex["entries"],
	now: number,
): Promise<void> {
	const indexKey = resolverSolutionIndexCacheKey(cache, challenge);
	const liveEntries = entries.filter((entry) => entry.expiresAtMs > now);
	if (liveEntries.length === 0) {
		await cache.delete(indexKey);
		return;
	}

	const ttlMs = Math.max(
		1,
		Math.floor(Math.max(...liveEntries.map((entry) => entry.expiresAtMs)) - now),
	);
	await cache.set(indexKey, { entries: liveEntries } satisfies ResolverCacheIndex, { ttlMs });
}

async function cacheBrowserSolution(
	cache: ProviderCache,
	challenge: ProviderChallenge,
	solution: ChallengeSolution,
	identity: ResolverIssuingIdentity,
): Promise<void> {
	const expiresAtMs = solutionExpiryMs(solution);
	const now = Date.now();
	if (expiresAtMs === undefined) return;
	const ttlMs = Math.floor(expiresAtMs - now);
	if (ttlMs <= MIN_RESOLVER_CACHE_TTL_MS) return;

	const issuerDigest = resolverIdentityDigest(identity);
	await cache.set(
		resolverSolutionCacheKey(cache, challenge, issuerDigest),
		{ expiresAtMs, issuerDigest, solution } satisfies CachedResolverSolution,
		{ ttlMs },
	);
	rememberSolutionIssuer(solution, issuerDigest);
	if (identity.proxyUrl !== undefined) return;

	const indexKey = resolverSolutionIndexCacheKey(cache, challenge);
	const current = await cache.get(indexKey);
	const currentEntries = isResolverCacheIndex(current?.value) ? current.value.entries : [];
	await writeResolverCacheIndex(
		cache,
		challenge,
		[
			...currentEntries.filter((entry) => entry.issuerDigest !== issuerDigest),
			{ direct: true, expiresAtMs, issuerDigest },
		],
		now,
	);
}

/** Remove the cached entry for the exact solution object returned by this resolver. */
export async function invalidateResolverSolution(
	resolver: ResolverContext,
	challenge: ProviderChallenge,
	solution: ChallengeSolution,
): Promise<void> {
	if (solution.form !== "cookies") return;
	const cache = resolverCaches.get(resolver);
	if (!cache) return;
	const issuerDigest = solutionIssuerDigests.get(solution);
	if (!issuerDigest) return;
	await cache.delete(resolverSolutionCacheKey(cache, challenge, issuerDigest));

	const index = await cache.get(resolverSolutionIndexCacheKey(cache, challenge));
	if (!index || !isResolverCacheIndex(index.value)) return;
	await writeResolverCacheIndex(
		cache,
		challenge,
		index.value.entries.filter((entry) => entry.issuerDigest !== issuerDigest),
		Date.now(),
	);
}

function createResolverChainClient(options: {
	readonly kinds: readonly ProviderChallengeKind[];
	readonly entries: readonly ResolverChainEntry[];
	readonly unavailableReason?: string;
	readonly cache?: ProviderCache;
	readonly identity?: ResolverIdentity;
}): ResolverChainClient {
	const client: ResolverChainClient = {
		async solve(challenge: ProviderChallenge, signal: AbortSignal = new AbortController().signal) {
			assertDeclaredKind(challenge.kind, options.kinds);
			if (options.unavailableReason) {
				throw new ProviderError(options.unavailableReason, {
					code: "RESOLVER_UNAVAILABLE",
					fix: "Configure at least one declared resolver vendor or provide a test ResolverContext override.",
				});
			}

			const supportingEntries = options.entries.filter((entry) => entry.supports(challenge.kind));
			if (supportingEntries.length === 0) throwUnsupportedKind(challenge.kind);
			signal.throwIfAborted();
			if (options.cache && supportingEntries.some((entry) => entry.id === "browser")) {
				const cached = await findCachedSolution(options.cache, challenge, options.identity);
				if (cached) return cached;
			}

			const attempts: ResolverChainAttempt[] = [];
			for (const entry of supportingEntries) {
				const adapter = entry.createAdapter();
				try {
					const solution = await adapter.solve(challenge, options.identity, signal);
					if (options.cache && entry.id === "browser" && solution.form === "cookies") {
						const issuingIdentity = adapter.getIssuingIdentity?.(solution, options.identity);
						if (issuingIdentity) {
							await cacheBrowserSolution(options.cache, challenge, solution, issuingIdentity);
						}
					}
					return solution;
				} catch (error) {
					signal.throwIfAborted();
					if (!(error instanceof ResolverVendorUnavailableError)) throw error;
					attempts.push({ vendor: adapter.id, reason: error.reason });
				}
			}

			throwExhausted(attempts);
		},
	};
	if (options.cache) resolverCaches.set(client, options.cache);
	return client;
}

export function createResolverClient(options: {
	readonly kinds: readonly ProviderChallengeKind[];
	readonly adapters: readonly ResolverVendorAdapter[];
	readonly unavailableReason?: string;
	readonly cache?: ProviderCache;
	readonly identity?: ResolverIdentity;
}): ResolverChainClient {
	return createResolverChainClient({
		kinds: options.kinds,
		entries: options.adapters.map((adapter) => ({
			id: adapter.id,
			supports: (kind) => adapter.supports(kind),
			createAdapter: () => adapter,
		})),
		unavailableReason: options.unavailableReason,
		cache: options.cache,
		identity: options.identity,
	});
}

function resolveVendorAvailability(
	vendor: ProviderResolverVendor,
	env: EnvLike,
): ResolvedResolverVendor {
	if (vendor === "custom") {
		return {
			vendor,
			available: false,
			reason: "missing_transport",
		};
	}

	const envKey =
		vendor === "2captcha"
			? APIFUSE__RESOLVER__2CAPTCHA__API_KEY
			: vendor === "capsolver"
				? APIFUSE__RESOLVER__CAPSOLVER__API_KEY
				: vendor === "capmonster"
					? APIFUSE__RESOLVER__CAPMONSTER__API_KEY
					: APIFUSE__CDP_POOL__URL;

	const configuration = normalizedEnvValue(env, envKey);
	return configuration
		? { vendor, available: true, configuration }
		: { vendor, available: false, reason: "missing_credentials" };
}

export function createUnsupportedResolverClient(reason?: string): ResolverContext {
	return {
		async solve() {
			throw new ProviderError(reason ?? "Resolver runtime is not configured", {
				code: "RESOLVER_UNAVAILABLE",
				fix: "Declare resolver on the provider definition and configure vendor credentials.",
			});
		},
	};
}

export function createResolverClientFromEnv(
	config: ProviderResolverConfig | undefined,
	env: EnvLike = process.env,
	options: ResolverRuntimeOptions = {},
): ResolverContext {
	if (!config) {
		return createUnsupportedResolverClient("Provider does not declare resolver capability");
	}

	if (config.vendors.length === 0) {
		return createResolverChainClient({
			kinds: config.kinds,
			entries: [],
			unavailableReason: "Provider resolver vendor chain is empty",
		});
	}

	const timeoutValue = readPositiveIntegerEnv(env, APIFUSE__RESOLVER__TIMEOUT_MS);
	const timeoutMs = timeoutValue === undefined ? DEFAULT_RESOLVER_TIMEOUT_MS : Number(timeoutValue);

	return createResolverChainClient({
		kinds: config.kinds,
		entries: config.vendors.map((vendor) => ({
			id: vendor,
			supports: (kind) => resolverVendorSupports(vendor, kind),
			createAdapter: () =>
				createAdapter(resolveVendorAvailability(vendor, env), timeoutMs, options.allowedHosts ?? []),
		})),
		cache: options.cache,
	});
}
