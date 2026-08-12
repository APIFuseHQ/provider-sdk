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
import {
	resolverChallengeIsIdentityScoped,
	resolverChallengeIssuingIdentity,
} from "./resolver-vendors/bindings.js";
import { createBrowserResolverVendorAdapter } from "./resolver-vendors/browser.js";
import {
	RESOLVER_VENDOR_CAPABILITIES,
	type ResolverIdentity,
	type ResolverIssuingIdentity,
	type ResolverVendorAdapter,
	type ResolverVendorTransport,
	ResolverVendorUnavailableError,
	type ResolverVendorUnavailableReason,
	resolverVendorSupports,
} from "./resolver-vendors/types.js";
import type { TraceRecorder } from "./trace.js";

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
	readonly cause?: {
		readonly name: string;
		readonly message: string;
	};
	readonly upstreamHost?: string;
	readonly phase?: string;
	readonly round?: number;
};

type ResolverChainClient = ResolverContext & {
	solve(
		challenge: ProviderChallenge,
		signal?: AbortSignal,
		traceRecorder?: TraceRecorder,
	): Promise<ChallengeSolution>;
};

export interface ResolverRuntimeOptions {
	readonly allowedHosts?: readonly string[];
	readonly cache?: ProviderCache;
	/** Solving identity used to bind an SDK-created vendor transport. */
	readonly identity?: ResolverIdentity;
	/** Server-owned context/proxy scope used only for identity-bound cache entries. */
	readonly identityScope?: string;
	/** SDK-owned transport already bound to the resolved proxy lease and client profile. */
	readonly transport?: ResolverVendorTransport;
	/** Creates an SDK-owned transport bound to the declared profile and solving identity. */
	readonly createTransport?: (input: {
		readonly clientProfile?: string;
		readonly identity?: ResolverIdentity;
	}) => ResolverVendorTransport;
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
const resolverCaches = new WeakMap<object, ProviderCache | null>();
const solutionIssuerDigests = new WeakMap<object, string>();

export const RESOLVER_INSTRUMENTATION_METADATA = Symbol.for(
	"@apifuse/provider-sdk/runtime/resolver-instrumentation-metadata",
);

export type ResolverInstrumentationMetadata = {
	readonly target: ResolverContext;
	readonly traceRecorder: TraceRecorder;
};

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

// This is the sole allowlist for declared vendors whose registry entry may be absent.
// Remove a vendor here when its adapter is registered.
const KNOWN_UNIMPLEMENTED_RESOLVER_VENDORS: ReadonlySet<ProviderResolverVendor> = new Set([
	"2captcha",
	"capsolver",
	"capmonster",
	"custom",
]);

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
	const factory = RESOLVER_ADAPTER_REGISTRY[vendor.vendor];
	if (!factory && !KNOWN_UNIMPLEMENTED_RESOLVER_VENDORS.has(vendor.vendor)) {
		throw new Error(
			`Resolver adapter factory is missing for implemented vendor "${vendor.vendor}"`,
		);
	}
	if (!vendor.available) {
		return createUnavailableAdapter(vendor.vendor, vendor.reason);
	}

	if (factory) {
		return factory(vendor.configuration, timeoutMs, allowedHosts);
	}
	return createUnavailableAdapter(vendor.vendor, "not_implemented");
}

function assertKnownResolverVendor(vendor: string): asserts vendor is ProviderResolverVendor {
	if (Object.hasOwn(RESOLVER_VENDOR_CAPABILITIES, vendor)) return;
	throw new Error(`Unknown resolver vendor "${vendor}" in resolver configuration`);
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

function assertClientProfileTransportContract(
	clientProfile: string | undefined,
	transport: ResolverVendorTransport | undefined,
): void {
	if (clientProfile === undefined || transport === undefined) return;
	throw new ProviderError(
		`Resolver client profile "${clientProfile}" cannot be applied to a pre-bound transport`,
		{
			code: "RESOLVER_CLIENT_PROFILE_TRANSPORT_CONFLICT",
			fix: "Remove the pre-bound transport and provide createTransport({ clientProfile, identity }) so the SDK can apply the provider-declared profile.",
		},
	);
}

function adapterRequiresTransport(
	adapter: ResolverVendorAdapter,
	kind: ProviderChallengeKind,
): boolean {
	return typeof adapter.requiresTransport === "function"
		? adapter.requiresTransport(kind)
		: adapter.requiresTransport === true;
}

function sanitizeDiagnosticUrl(rawUrl: string): string {
	try {
		const parsed = new URL(rawUrl);
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return "[REDACTED_URL]";
	}
}

function sanitizeCauseMessage(message: string): string {
	const withoutUrls = message.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, sanitizeDiagnosticUrl);
	const sensitiveStart = withoutUrls.search(
		/\b(?:authorization|proxy-authorization|set-cookie|cookies?|headers?|request\s+body|response\s+body|body|api[-_ ]?key|password|secret|credential|token)\b/i,
	);
	return (sensitiveStart === -1 ? withoutUrls : `${withoutUrls.slice(0, sensitiveStart)}[REDACTED]`)
		.replaceAll("\r", " ")
		.replaceAll("\n", " ")
		.slice(0, 512);
}

function safeCause(error: ResolverVendorUnavailableError): ResolverChainAttempt["cause"] {
	if (error.cause === undefined) return undefined;
	const cause = error.cause;
	const rawName = cause instanceof Error ? cause.name : "Error";
	return {
		name: /^[a-z\d_.:-]{1,64}$/i.test(rawName) ? rawName : "Error",
		message: sanitizeCauseMessage(cause instanceof Error ? cause.message : String(cause)),
	};
}

function safeUpstreamHost(host: string | undefined): string | undefined {
	if (host === undefined) return undefined;
	const trimmed = host.trim();
	if (/^[a-z\d.-]+$/i.test(trimmed)) return trimmed.toLowerCase();
	try {
		return new URL(trimmed).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

function safePhase(phase: string | undefined): string | undefined {
	return phase !== undefined && /^[a-z\d_.:-]{1,64}$/i.test(phase) ? phase : undefined;
}

function unavailableAttempt(error: ResolverVendorUnavailableError): ResolverChainAttempt {
	const cause = safeCause(error);
	const upstreamHost = safeUpstreamHost(error.upstreamHost);
	const phase = safePhase(error.phase);
	const round =
		Number.isSafeInteger(error.round) && (error.round as number) > 0 ? error.round : undefined;
	return {
		vendor: error.vendor,
		reason: error.reason,
		...(cause ? { cause } : {}),
		...(upstreamHost ? { upstreamHost } : {}),
		...(phase ? { phase } : {}),
		...(round !== undefined ? { round } : {}),
	};
}

function unavailableSpanAttributes(error: ResolverVendorUnavailableError): Record<string, unknown> {
	const attempt = unavailableAttempt(error);
	return {
		unavailability_reason: error.reason,
		cause_name: attempt.cause?.name,
		cause_message: attempt.cause?.message,
		upstream_host: attempt.upstreamHost,
		transport_phase: attempt.phase,
		transport_round: attempt.round,
	};
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

function resolverIdentityScopeDigest(identityScope: string): string {
	return createHash("sha256").update(JSON.stringify({ identityScope })).digest("hex");
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
	identityScope: string | undefined,
): Promise<ChallengeSolution | undefined> {
	const now = Date.now();
	if (identityScope !== undefined && resolverChallengeIsIdentityScoped(challenge)) {
		return await readCachedSolution(
			cache,
			challenge,
			resolverIdentityScopeDigest(identityScope),
			now,
		);
	}
	if (identity) {
		const lookupIdentity = resolverChallengeIssuingIdentity(challenge, identity);
		return await readCachedSolution(cache, challenge, resolverIdentityDigest(lookupIdentity), now);
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

async function cacheResolverSolution(
	cache: ProviderCache,
	challenge: ProviderChallenge,
	solution: ChallengeSolution,
	identity: ResolverIssuingIdentity,
	identityScope: string | undefined,
): Promise<void> {
	const expiresAtMs = solutionExpiryMs(solution);
	const now = Date.now();
	if (expiresAtMs === undefined) return;
	const ttlMs = Math.floor(expiresAtMs - now);
	if (ttlMs <= MIN_RESOLVER_CACHE_TTL_MS) return;

	const scopedDigest =
		identityScope !== undefined && resolverChallengeIsIdentityScoped(challenge)
			? resolverIdentityScopeDigest(identityScope)
			: undefined;
	const issuerDigest = scopedDigest ?? resolverIdentityDigest(identity);
	await cache.set(
		resolverSolutionCacheKey(cache, challenge, issuerDigest),
		{ expiresAtMs, issuerDigest, solution } satisfies CachedResolverSolution,
		{ ttlMs },
	);
	rememberSolutionIssuer(solution, issuerDigest);
	if (scopedDigest !== undefined || identity.proxyUrl !== undefined) return;

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
	const metadata = (
		resolver as ResolverContext & {
			readonly [RESOLVER_INSTRUMENTATION_METADATA]?: ResolverInstrumentationMetadata;
		}
	)[RESOLVER_INSTRUMENTATION_METADATA];
	const cacheOwner = metadata?.target ?? resolver;
	const invalidate = async (): Promise<
		| "cache_disabled"
		| "entry_deleted"
		| "index_entry_deleted"
		| "not_cookie_solution"
		| "solution_not_cached"
	> => {
		if (solution.form !== "cookies") return "not_cookie_solution";
		if (!resolverCaches.has(cacheOwner)) {
			throw new Error("Resolver cache registration lookup failed during solution invalidation");
		}
		const cache = resolverCaches.get(cacheOwner);
		if (cache === null || cache === undefined) return "cache_disabled";
		const issuerDigest = solutionIssuerDigests.get(solution);
		if (!issuerDigest) return "solution_not_cached";
		await cache.delete(resolverSolutionCacheKey(cache, challenge, issuerDigest));

		const index = await cache.get(resolverSolutionIndexCacheKey(cache, challenge));
		if (!index) return "entry_deleted";
		if (!isResolverCacheIndex(index.value)) {
			throw new Error("Resolver solution cache index is malformed during invalidation");
		}
		await writeResolverCacheIndex(
			cache,
			challenge,
			index.value.entries.filter((entry) => entry.issuerDigest !== issuerDigest),
			Date.now(),
		);
		return "index_entry_deleted";
	};

	if (!metadata) {
		await invalidate();
		return;
	}
	await metadata.traceRecorder.runSpan("resolver.cache.invalidate", invalidate, {
		attributes: { challenge_kind: challenge.kind },
		onSuccess: (outcome) => ({ outcome }),
	});
}

function createResolverChainClient(options: {
	readonly kinds: readonly ProviderChallengeKind[];
	readonly entries: readonly ResolverChainEntry[];
	readonly unavailableReason?: string;
	readonly cache?: ProviderCache;
	readonly identity?: ResolverIdentity;
	readonly identityScope?: string;
	readonly transport?: ResolverVendorTransport;
	readonly createTransport?: ResolverRuntimeOptions["createTransport"];
	readonly clientProfile?: string;
}): ResolverChainClient {
	assertClientProfileTransportContract(options.clientProfile, options.transport);
	const client: ResolverChainClient = {
		async solve(
			challenge: ProviderChallenge,
			signal: AbortSignal = new AbortController().signal,
			traceRecorder?: TraceRecorder,
		) {
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
			if (options.cache) {
				const cached = await findCachedSolution(
					options.cache,
					challenge,
					options.identity,
					options.identityScope,
				);
				if (cached) return cached;
			}

			const attempts: ResolverChainAttempt[] = [];
			for (const entry of supportingEntries) {
				const adapter = entry.createAdapter();
				try {
					const solveAttempt = () => {
						const requiresTransport = adapterRequiresTransport(adapter, challenge.kind);
						const transport =
							options.transport ??
							(requiresTransport
								? options.createTransport?.({
										clientProfile: options.clientProfile,
										identity: options.identity,
									})
								: undefined);
						if (requiresTransport && transport === undefined) {
							throw new ResolverVendorUnavailableError(adapter.id, "missing_transport");
						}
						return adapter.solve(challenge, options.identity, signal, traceRecorder, transport);
					};
					const solution = traceRecorder
						? await traceRecorder.runSpan("resolver.vendor.attempt", solveAttempt, {
								attributes: {
									vendor: adapter.id,
									challenge_kind: challenge.kind,
									client_profile: options.clientProfile,
								},
								onError(error) {
									return error instanceof ResolverVendorUnavailableError
										? unavailableSpanAttributes(error)
										: undefined;
								},
							})
						: await solveAttempt();
					if (
						options.cache &&
						solution.form === "cookies" &&
						solutionExpiryMs(solution) !== undefined
					) {
						const issuingIdentity =
							adapter.getIssuingIdentity?.(solution, options.identity, challenge) ??
							resolverChallengeIssuingIdentity(challenge, {
								...(options.identity ? { proxyUrl: options.identity.proxyUrl } : {}),
								userAgent: solution.userAgent,
							});
						if (issuingIdentity) {
							await cacheResolverSolution(
								options.cache,
								challenge,
								solution,
								issuingIdentity,
								options.identityScope,
							);
						}
					}
					return solution;
				} catch (error) {
					signal.throwIfAborted();
					if (!(error instanceof ResolverVendorUnavailableError)) throw error;
					attempts.push(unavailableAttempt(error));
				}
			}

			throwExhausted(attempts);
		},
	};
	resolverCaches.set(client, options.cache ?? null);
	return client;
}

export function createResolverClient(options: {
	readonly kinds: readonly ProviderChallengeKind[];
	readonly adapters: readonly ResolverVendorAdapter[];
	readonly unavailableReason?: string;
	readonly cache?: ProviderCache;
	readonly identity?: ResolverIdentity;
	readonly transport?: ResolverVendorTransport;
	readonly createTransport?: ResolverRuntimeOptions["createTransport"];
	readonly clientProfile?: string;
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
		transport: options.transport,
		createTransport: options.createTransport,
		clientProfile: options.clientProfile,
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

export function bindResolverSignal(
	resolver: ResolverContext,
	defaultSignal: AbortSignal | undefined,
): ResolverContext {
	if (!defaultSignal) return resolver;
	const boundResolver: ResolverContext = {
		solve(challenge, signal = defaultSignal) {
			return resolver.solve(challenge, signal);
		},
	};
	if (resolverCaches.has(resolver)) {
		resolverCaches.set(boundResolver, resolverCaches.get(resolver) ?? null);
	}
	return boundResolver;
}

export function createResolverClientFromEnv(
	config: ProviderResolverConfig | undefined,
	env: EnvLike = process.env,
	options: ResolverRuntimeOptions = {},
): ResolverContext {
	if (!config) {
		return createUnsupportedResolverClient("Provider does not declare resolver capability");
	}
	assertClientProfileTransportContract(config.clientProfile, options.transport);

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
		entries: config.vendors.map((configuredVendor) => {
			assertKnownResolverVendor(configuredVendor);
			const vendor = configuredVendor;
			return {
				id: vendor,
				supports: (kind: ProviderChallengeKind) => resolverVendorSupports(vendor, kind),
				createAdapter: () =>
					createAdapter(
						resolveVendorAvailability(vendor, env),
						timeoutMs,
						options.allowedHosts ?? [],
					),
			};
		}),
		cache: options.cache,
		identity: options.identity,
		identityScope: options.identityScope,
		transport: options.transport,
		createTransport: options.createTransport,
		clientProfile: config.clientProfile,
	});
}
