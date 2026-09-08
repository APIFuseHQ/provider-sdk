import { readDiagnosticEnv } from "./diagnostic-env.js";
import { createHash } from "node:crypto";

import {
	resolveProxyConfigAsync,
	type ProxyResolutionOptions,
	type ProxyUserAgentSource,
} from "../config/loader.js";
import { ProviderError } from "../errors.js";
import { getStealthProfile } from "../stealth/profiles.js";
import type {
	ChallengeSolution,
	ProviderCache,
	ProviderChallenge,
	ProviderChallengeKind,
	ProviderProxyMode,
	ProviderResolverConfig,
	ProviderResolverVendor,
	ResolverContext,
} from "../types.js";
import { isProviderCacheBypassed } from "./cache.js";
import {
	RESOLVER_CHALLENGE_BINDINGS,
	resolverChallengeAllowsDirectCache,
	resolverChallengeIsCacheable,
	resolverChallengeIsIdentityScoped,
	resolverChallengeIssuingIdentity,
} from "./resolver-vendors/bindings.js";
import { createBrowserResolverVendorAdapter } from "./resolver-vendors/browser.js";
import { createCapsolverResolverVendorAdapter } from "./resolver-vendors/capsolver.js";
import { createHypersolutionsResolverVendorAdapter } from "./resolver-vendors/hypersolutions.js";
import {
	assertResolverHostAllowed,
	assertResolverVendorTransportHosts,
} from "./resolver-vendors/hosts.js";
import { createTwoCaptchaResolverVendorAdapter } from "./resolver-vendors/twocaptcha.js";
import {
	RESOLVER_VENDOR_CAPABILITIES,
	type ResolverIdentity,
	type ResolverIssuingIdentity,
	type ResolverPaidUsageContext,
	type ResolverVendorAdapter,
	type ResolverVendorTransport,
	ResolverVendorUnavailableError,
	attachResolverVendorPollObserver,
	type ResolverVendorUnavailableReason,
	resolveProviderResolverVendors,
	resolverVendorSupports,
} from "./resolver-vendors/types.js";
import {
	createUnsupportedResolverClient,
	inheritResolverTelemetryBinding,
	registerResolverTelemetryBinding,
	RESOLVER_INSTRUMENTATION_METADATA,
	type ResolverSolveWithRecorder,
} from "./resolver-shared.js";
import {
	APIFUSE__CDP_POOL__URL,
	APIFUSE__RESOLVER__2CAPTCHA__API_KEY,
	APIFUSE__RESOLVER__CAPMONSTER__API_KEY,
	APIFUSE__RESOLVER__CAPSOLVER__API_KEY,
	APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY,
	APIFUSE__RESOLVER__TIMEOUT_MS,
	DEFAULT_RESOLVER_TIMEOUT_MS,
	kindRequiresClientProfile,
} from "./resolver-config.js";
import { DEFAULT_STEALTH_PROFILE } from "./stealth.js";
import type { TraceRecorder } from "./trace.js";
import type {
	ResolverTelemetryErrorClass,
	ResolverTelemetryPhase,
	ResolverTelemetrySink,
} from "./resolver-telemetry.js";

export {
	createUnsupportedResolverClient,
	RESOLVER_INSTRUMENTATION_METADATA,
} from "./resolver-shared.js";
export {
	APIFUSE__CDP_POOL__URL,
	APIFUSE__RESOLVER__2CAPTCHA__API_KEY,
	APIFUSE__RESOLVER__CAPMONSTER__API_KEY,
	APIFUSE__RESOLVER__CAPSOLVER__API_KEY,
	APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY,
	APIFUSE__RESOLVER__TIMEOUT_MS,
	DEFAULT_RESOLVER_TIMEOUT_MS,
} from "./resolver-config.js";
export {
	DEFAULT_RESOLVER_VENDOR_PREFERENCE,
	resolveProviderResolverVendors,
} from "./resolver-vendors/types.js";

type EnvLike = Record<string, string | undefined>;

type ResolvedResolverVendor =
	| {
			readonly vendor: Exclude<ProviderResolverVendor, "custom">;
			readonly available: true;
			readonly configuration: string | undefined;
	  }
	| {
			readonly vendor: ProviderResolverVendor;
			readonly available: false;
			readonly reason: ResolverVendorUnavailableReason;
	  };

type ResolverChainAttempt = {
	readonly vendor: ProviderResolverVendor;
	readonly reason: ResolverVendorUnavailableReason;
	readonly missingFields?: readonly string[];
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
	/** Optional request-scoped observability sink; never used as resolver identity. */
	readonly telemetry?: ResolverTelemetrySink;
	/** Inputs for SDK-owned lazy proxy resolution. The SDK never accepts a caller-built identity. */
	readonly proxyIntent?: {
		readonly mode: ProviderProxyMode;
		readonly upstream: NonNullable<ProxyResolutionOptions["upstream"]>;
		readonly affinityKey?: ProxyResolutionOptions["affinityKey"];
		readonly telemetry?: ProxyResolutionOptions["telemetry"];
		readonly userAgent?: string;
	};
	/** Server-owned context/proxy scope used only for identity-bound cache entries. */
	readonly identityScope?: string;
	/** SDK-owned transport already bound to the resolved proxy lease and client profile. */
	readonly transport?: ResolverVendorTransport;
	/** Creates an SDK-owned transport bound to the declared profile and server-owned scope. */
	readonly createTransport?: (input: {
		readonly clientProfile?: string;
		/** Server-owned proxy/context scope; the SDK never accepts a caller-built identity. */
		readonly identityScope?: string;
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

export type ResolverSolutionSource = "cache" | "vendor";

type ResolverSolutionInvalidationOutcome =
	| "cache_disabled"
	| "entry_deleted"
	| "index_entry_deleted"
	| "not_cookie_solution"
	| "solution_not_cached";

const RESOLVER_SOLUTION_CACHE_NAMESPACE = "resolver-solution";
const RESOLVER_SOLUTION_INDEX_CACHE_NAMESPACE = "resolver-solution-index";
const MIN_RESOLVER_CACHE_TTL_MS = 1_000;
const resolverCaches = new WeakMap<object, ProviderCache | null>();
const solutionIssuerDigests = new WeakMap<object, string>();
const resolverSolutionSources = new WeakMap<object, ResolverSolutionSource>();
const SAFE_CAUSE_MESSAGE_WORDS: ReadonlySet<string> = new Set([
	"abort",
	"aborted",
	"at",
	"closed",
	"connect",
	"connection",
	"dns",
	"during",
	"econnrefused",
	"econnreset",
	"error",
	"etimedout",
	"failed",
	"failure",
	"fetch",
	"from",
	"get",
	"lookup",
	"network",
	"post",
	"reading",
	"refused",
	"request",
	"reset",
	"response",
	"socket",
	"timed",
	"timeout",
	"tls",
	"to",
	"unavailable",
	"upstream",
	"while",
	"writing",
]);

export type ResolverInstrumentationMetadata = {
	readonly target: ResolverContext;
	readonly traceRecorder: TraceRecorder;
};

export type ResolverAdapterFactory = (
	configuration: string | undefined,
	timeoutMs: number,
	allowedHosts: readonly string[],
) => ResolverVendorAdapter;

const resolverAdapterRegistry: Partial<Record<ProviderResolverVendor, ResolverAdapterFactory>> = {
	"2captcha"(configuration, timeoutMs, allowedHosts) {
		if (configuration === undefined) {
			throw new Error("2captcha resolver adapter factory requires an API key");
		}
		return createTwoCaptchaResolverVendorAdapter({
			allowedHosts,
			apiKey: configuration,
			timeoutMs,
		});
	},
	capsolver(configuration, timeoutMs, allowedHosts) {
		return createCapsolverResolverVendorAdapter({
			allowedHosts,
			apiKey: configuration,
			timeoutMs,
		});
	},
	browser(configuration, timeoutMs, allowedHosts) {
		return createBrowserResolverVendorAdapter({
			allowedHosts,
			cdpUrl: configuration,
			timeoutMs,
		});
	},
	hypersolutions(configuration, timeoutMs, allowedHosts) {
		return createHypersolutionsResolverVendorAdapter({
			allowedHosts,
			apiKey: configuration,
			timeoutMs,
		});
	},
};

export const RESOLVER_ADAPTER_REGISTRY: Partial<
	Readonly<Record<ProviderResolverVendor, ResolverAdapterFactory>>
> = resolverAdapterRegistry;

export function swapResolverAdapterFactoryForTests(
	vendor: ProviderResolverVendor,
	factory: ResolverAdapterFactory | undefined,
): () => void {
	const original = resolverAdapterRegistry[vendor];
	if (factory === undefined) delete resolverAdapterRegistry[vendor];
	else resolverAdapterRegistry[vendor] = factory;
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		if (original === undefined) delete resolverAdapterRegistry[vendor];
		else resolverAdapterRegistry[vendor] = original;
	};
}

let resolveDefaultResolverUserAgent: () => string | undefined = () =>
	getStealthProfile(DEFAULT_STEALTH_PROFILE).userAgent;

/** Internal test seam; deliberately not re-exported from the package root. */
export function swapResolverDefaultUserAgentForTests(
	resolver: (() => string | undefined) | undefined,
): () => void {
	const original = resolveDefaultResolverUserAgent;
	resolveDefaultResolverUserAgent =
		resolver ?? (() => getStealthProfile(DEFAULT_STEALTH_PROFILE).userAgent);
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		resolveDefaultResolverUserAgent = original;
	};
}

// This is the sole allowlist for declared vendors whose registry entry may be absent.
// Remove a vendor here when its adapter is registered.
const KNOWN_UNIMPLEMENTED_RESOLVER_VENDORS: ReadonlySet<ProviderResolverVendor> = new Set([
	"capmonster",
	"custom",
]);

type ResolverChainEntry = {
	readonly id: ProviderResolverVendor;
	supports(kind: ProviderChallengeKind): boolean;
	createAdapter(): ResolverVendorAdapter;
};

function normalizedEnvValue(env: EnvLike, key: string): string | undefined {
	const value = readDiagnosticEnv(key, env)?.trim();
	return value ? value : undefined;
}

function readPositiveIntegerEnv(env: EnvLike, name: string): string | undefined {
	const raw = readDiagnosticEnv(name, env)?.trim();
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
	if (!Object.hasOwn(RESOLVER_CHALLENGE_BINDINGS, requestedKind)) {
		throw new ProviderError(`Unknown resolver kind "${requestedKind}"`, {
			code: "RESOLVER_KIND_NOT_DECLARED",
			fix: "Use a challenge kind exported by @apifuse/provider-sdk.",
		});
	}
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
	adapterFactories: Partial<Readonly<Record<ProviderResolverVendor, ResolverAdapterFactory>>>,
): ResolverVendorAdapter {
	const factory = adapterFactories[vendor.vendor];
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

function throwUnsupportedKind(kind: ProviderChallengeKind, usingDefaultVendors: boolean): never {
	throw new ProviderError(`Resolver vendor chain does not support kind "${kind}"`, {
		code: "RESOLVER_KIND_UNSUPPORTED_BY_CHAIN",
		fix: usingDefaultVendors
			? `No SDK default resolver vendor supports "${kind}". Declare an explicit resolver.vendors override with a supporting vendor.`
			: `Add a resolver vendor that supports "${kind}" to the provider's resolver.vendors declaration.`,
	});
}

function throwExhausted(
	challengeKind: ProviderChallengeKind,
	attempts: readonly ResolverChainAttempt[],
	executedAttemptCount = attempts.length,
): never {
	const hasMissingChallengeInput = attempts.some(
		(attempt) => attempt.reason === "missing_challenge_input",
	);
	throw new ProviderError("The challenge could not be resolved.", {
		code: "RESOLVER_CHAIN_EXHAUSTED",
		fix: hasMissingChallengeInput
			? "Capture all required challenge fields and retry the request."
			: "Retry the request or contact support if the challenge continues.",
		retryable: false,
		details: {
			challengeKind,
			attempts: executedAttemptCount,
			outcome: "exhausted",
			retryable: false,
		},
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
			fix: "Remove the pre-bound transport and provide createTransport({ clientProfile, identityScope }) so the SDK can apply the provider-declared profile.",
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
		if (parsed.username || parsed.password) return "[REDACTED_PROXY_URL]";
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return "[REDACTED_URL]";
	}
}

function sanitizeCauseMessage(message: string): string {
	const withoutUrls = message.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, sanitizeDiagnosticUrl);
	const withoutAssignments = withoutUrls.replace(/(?:^|\s)[^\s=]+=[^\s]*/g, " [REDACTED]");
	const safeTokens = withoutAssignments
		.replaceAll("\r", " ")
		.replaceAll("\n", " ")
		.split(/\s+/)
		.filter(Boolean)
		.map((token) => {
			if (
				token === "[REDACTED]" ||
				token === "[REDACTED_PROXY_URL]" ||
				/^[a-z][a-z\d+.-]*:\/\/[^\s]+$/i.test(token)
			)
				return token;
			const word = token.replace(/^[^a-z\d]+|[^a-z\d]+$/gi, "");
			return word.length > 0 &&
				word.length <= 32 &&
				SAFE_CAUSE_MESSAGE_WORDS.has(word.toLowerCase())
				? token
				: "[REDACTED]";
		});
	return safeTokens
		.filter((token, index) => token !== "[REDACTED]" || safeTokens[index - 1] !== token)
		.join(" ")
		.slice(0, 512);
}

function assertResolverTransportLive(revoked: boolean): void {
	if (!revoked) return;
	throw new ProviderError("Resolver transport was revoked when the vendor solve settled", {
		code: "RESOLVER_TRANSPORT_REVOKED",
		fix: "Complete every bound-transport call before solve() settles; the transport is per-attempt and must not be retained.",
	});
}

function restrictResolverTransport(
	transport: ResolverVendorTransport,
	allowedHosts: readonly string[],
): { readonly transport: ResolverVendorTransport; revoke(): void } {
	// A retained reference must fail closed once the adapter's solve has settled.
	let revoked = false;
	const restricted: ResolverVendorTransport = {
		sessionHeaders: transport.sessionHeaders,
		...(transport.getCookie
			? {
					getCookie(name, url) {
						assertResolverTransportLive(revoked);
						// Jar reads are gated like fetches: an adapter may only read state for declared hosts.
						assertResolverHostAllowed(url, allowedHosts);
						return transport.getCookie?.(name, url);
					},
				}
			: {}),
		async fetch(url, init) {
			assertResolverTransportLive(revoked);
			// Empty declarations remain deny-by-default, matching the adapter-factory/browser path.
			assertResolverHostAllowed(url, allowedHosts);
			const response = await transport.fetch(url, { ...init, redirect: "manual" });
			const hasLocationHeader = Object.keys(response.headers).some(
				(name) => name.toLowerCase() === "location",
			);
			if (response.status >= 300 && response.status < 400 && hasLocationHeader) {
				throw new ProviderError("Resolver transport refused a redirect response", {
					code: "RESOLVER_HOST_NOT_ALLOWED",
					fix: "Use a non-redirecting http or https URL on a host declared in allowedHosts.",
				});
			}
			return response;
		},
	};
	return {
		transport: restricted,
		revoke() {
			revoked = true;
		},
	};
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

function unavailableAttempt(
	error: ResolverVendorUnavailableError,
	forTelemetry = false,
): ResolverChainAttempt {
	// Preserve the full input for the collector's redact-then-bound path. Span
	// attributes retain their existing sanitization and phase validation.
	const cause =
		forTelemetry && error.cause !== undefined
			? {
					name: error.cause instanceof Error ? error.cause.name : "Error",
					message: error.cause instanceof Error ? error.cause.message : String(error.cause),
				}
			: safeCause(error);
	const upstreamHost = safeUpstreamHost(error.upstreamHost);
	const phase = forTelemetry ? error.phase : safePhase(error.phase);
	const round =
		Number.isSafeInteger(error.round) && (error.round as number) > 0 ? error.round : undefined;
	return {
		vendor: error.vendor,
		reason: error.reason,
		...(error.missingFields ? { missingFields: [...error.missingFields] } : {}),
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
		missing_fields: error.missingFields,
		cause_name: attempt.cause?.name,
		cause_message: attempt.cause?.message,
		upstream_host: attempt.upstreamHost,
		transport_phase: attempt.phase,
		transport_round: attempt.round,
	};
}

type ResolverAttemptDiagnostics = {
	phase?: string;
	pollCount?: number;
	vendorErrorCode?: string;
	vendorErrorDescription?: string;
};

function resolverTelemetryPhase(value: unknown): ResolverTelemetryPhase | undefined {
	return value === "create_task" ||
		value === "poll_result" ||
		value === "cleanup" ||
		value === "measure_ip" ||
		value === "fetch_script" ||
		value === "generate_payload" ||
		value === "post_payload"
		? value
		: undefined;
}

function diagnosticString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function diagnosticCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: undefined;
}

function createResolverTelemetryTraceRecorder(input: {
	base?: TraceRecorder;
	vendor: ProviderResolverVendor;
	attemptIndex: number;
	telemetry?: ResolverTelemetrySink;
	diagnostics: ResolverAttemptDiagnostics;
}): TraceRecorder | undefined {
	if (!input.base && !input.telemetry) return undefined;
	const recorder: TraceRecorder = {
		async runSpan<T>(
			name: string,
			fn: () => Promise<T> | T,
			spanOptions: {
				attributes?: Record<string, unknown>;
				onSuccess?: (value: T) => Record<string, unknown> | undefined;
				onError?: (error: unknown) => Record<string, unknown> | undefined;
			} = {},
		) {
			const adapterPhase = name.startsWith("resolver.vendor.")
				? diagnosticString(name.replace("resolver.vendor.", ""))
				: undefined;
			const phase = resolverTelemetryPhase(adapterPhase);
			const startedAt = Date.now();
			let attributes: Record<string, unknown> | undefined;
			let spanOutcome: "ok" | "error" = "ok";
			const wrappedOptions = {
				...spanOptions,
				onSuccess(value: T) {
					attributes = spanOptions.onSuccess?.(value);
					return attributes;
				},
				onError(error: unknown) {
					attributes = spanOptions.onError?.(error);
					return attributes;
				},
			};
			try {
				if (input.base) return await input.base.runSpan(name, fn, wrappedOptions);
				const value = await fn();
				attributes = spanOptions.onSuccess?.(value);
				return value;
			} catch (error) {
				spanOutcome = "error";
				if (!input.base) attributes = spanOptions.onError?.(error);
				throw error;
			} finally {
				if (adapterPhase && adapterPhase !== "attempt") {
					const reportedPhase = diagnosticString(attributes?.transport_phase) ?? adapterPhase;
					const pollCount = diagnosticCount(attributes?.poll_count);
					const vendorErrorCode = diagnosticString(attributes?.vendor_error_code);
					const vendorErrorDescription = diagnosticString(
						attributes?.vendor_error_description ?? attributes?.error_message,
					);
					if (phase === "cleanup") {
						input.telemetry?.recordVendorAttempt({
							vendor: input.vendor,
							phase: "cleanup",
							diagnostics: { phase: reportedPhase, attemptIndex: input.attemptIndex },
							outcome: spanOutcome,
							ms: Date.now() - startedAt,
							...(pollCount === undefined ? {} : { pollCount }),
							...(vendorErrorCode ? { vendorErrorCode } : {}),
							...(vendorErrorDescription ? { vendorErrorDescription } : {}),
							...(spanOutcome === "error" ? { errorClass: "unexpected" as const } : {}),
						});
					} else {
						input.diagnostics.phase = reportedPhase;
						if (pollCount !== undefined) input.diagnostics.pollCount = pollCount;
						if (vendorErrorCode) input.diagnostics.vendorErrorCode = vendorErrorCode;
						if (vendorErrorDescription) {
							input.diagnostics.vendorErrorDescription = vendorErrorDescription;
						}
					}
				}
			}
		},
	};
	return attachResolverVendorPollObserver(recorder, () => {
		input.diagnostics.pollCount = (input.diagnostics.pollCount ?? 0) + 1;
	});
}

function resolverAttemptErrorClass(
	error: unknown,
	signal: AbortSignal,
): ResolverTelemetryErrorClass {
	if (signal.aborted) return "aborted";
	return error instanceof ResolverVendorUnavailableError ? error.reason : "unexpected";
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
	const expires = solution.expires ?? solution.sdkEstimatedExpires;
	if (typeof expires !== "number" || !Number.isFinite(expires)) return undefined;
	return expires * 1_000;
}

function rememberSolutionIssuer(solution: ChallengeSolution, issuerDigest: string): void {
	if (typeof solution === "object" && solution !== null) {
		solutionIssuerDigests.set(solution, issuerDigest);
	}
}

function rememberSolutionSource(solution: ChallengeSolution, source: ResolverSolutionSource): void {
	if (typeof solution === "object" && solution !== null) {
		resolverSolutionSources.set(solution, source);
	}
}

/**
 * Identify whether this exact SDK-returned solution object came from the cache
 * or a vendor solve. Returns undefined for copied or caller-created objects.
 */
export function getResolverSolutionSource(
	solution: ChallengeSolution,
): ResolverSolutionSource | undefined {
	return resolverSolutionSources.get(solution);
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
	if (cached.value.solution.form !== "cookies") return undefined;
	const solution = {
		...cached.value.solution,
		cookies: { ...cached.value.solution.cookies },
	};
	rememberSolutionIssuer(solution, issuerDigest);
	rememberSolutionSource(solution, "cache");
	return solution;
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
): Promise<{ written: boolean; reason?: "no_expires" | "not_cacheable" }> {
	if (!resolverChallengeIsCacheable(challenge)) return { written: false, reason: "not_cacheable" };
	const expiresAtMs = solutionExpiryMs(solution);
	const now = Date.now();
	if (expiresAtMs === undefined) return { written: false, reason: "no_expires" };
	const ttlMs = Math.floor(expiresAtMs - now);
	if (ttlMs <= MIN_RESOLVER_CACHE_TTL_MS) return { written: false, reason: "no_expires" };

	const scopedDigest =
		identityScope !== undefined && resolverChallengeIsIdentityScoped(challenge)
			? resolverIdentityScopeDigest(identityScope)
			: undefined;
	if (
		!resolverChallengeAllowsDirectCache(challenge) &&
		scopedDigest === undefined &&
		identity.proxyUrl === undefined
	) {
		return { written: false, reason: "not_cacheable" };
	}
	const issuerDigest = scopedDigest ?? resolverIdentityDigest(identity);
	await cache.set(
		resolverSolutionCacheKey(cache, challenge, issuerDigest),
		{ expiresAtMs, issuerDigest, solution } satisfies CachedResolverSolution,
		{ ttlMs },
	);
	rememberSolutionIssuer(solution, issuerDigest);
	if (scopedDigest !== undefined || identity.proxyUrl !== undefined) return { written: true };

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
	return { written: true };
}

async function invalidateResolverSolutionWithOutcome(
	resolver: ResolverContext,
	challenge: ProviderChallenge,
	solution: ChallengeSolution,
): Promise<ResolverSolutionInvalidationOutcome> {
	const metadata = (
		resolver as ResolverContext & {
			readonly [RESOLVER_INSTRUMENTATION_METADATA]?: ResolverInstrumentationMetadata;
		}
	)[RESOLVER_INSTRUMENTATION_METADATA];
	const cacheOwner = metadata?.target ?? resolver;
	const invalidate = async (): Promise<ResolverSolutionInvalidationOutcome> => {
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
		return await invalidate();
	}
	return await metadata.traceRecorder.runSpan("resolver.cache.invalidate", invalidate, {
		attributes: { challenge_kind: challenge.kind },
		onSuccess: (outcome) => ({ outcome }),
	});
}

/** Remove the cached entry for the exact solution object returned by this resolver. */
export async function invalidateResolverSolution(
	resolver: ResolverContext,
	challenge: ProviderChallenge,
	solution: ChallengeSolution,
): Promise<void> {
	await invalidateResolverSolutionWithOutcome(resolver, challenge, solution);
}

/**
 * Remove a solution only when it was returned from the resolver cache. Providers
 * should call this when an upstream serves the same challenge after a cached
 * solution was applied, so the next `solve()` mints a fresh solution.
 */
export async function invalidateCachedResolverSolution(
	resolver: ResolverContext,
	challenge: ProviderChallenge,
	solution: ChallengeSolution,
): Promise<boolean> {
	if (getResolverSolutionSource(solution) !== "cache") return false;
	const outcome = await invalidateResolverSolutionWithOutcome(resolver, challenge, solution);
	return outcome === "entry_deleted" || outcome === "index_entry_deleted";
}

async function resolveResolverIdentity(
	proxyIntent: NonNullable<ResolverRuntimeOptions["proxyIntent"]>,
): Promise<{
	readonly identity?: ResolverIdentity;
	readonly unavailableReason?: ResolverVendorUnavailableReason;
	readonly userAgentSource?: ProxyUserAgentSource;
}> {
	const userAgentSource: ProxyUserAgentSource = proxyIntent.userAgent ? "declared" : "defaulted";
	let proxyUrl: string | undefined;
	try {
		const resolved = await resolveProxyConfigAsync({
			upstream: proxyIntent.upstream,
			affinityKey: proxyIntent.affinityKey,
			telemetry: proxyIntent.telemetry
				? {
						...proxyIntent.telemetry,
						recordProxyResolution(event) {
							proxyIntent.telemetry?.recordProxyResolution({
								...event,
								userAgentSource,
							});
						},
					}
				: undefined,
		});
		proxyUrl = resolved.url;
		if (!proxyUrl) return { unavailableReason: "missing_proxy_identity", userAgentSource };
	} catch {
		// Lease failures contain infrastructure detail that must not cross the resolver
		// boundary. A required policy is classified by the existing fail-closed guard.
		return { unavailableReason: "missing_proxy_identity", userAgentSource };
	}

	try {
		const userAgent = proxyIntent.userAgent || resolveDefaultResolverUserAgent();
		if (!userAgent) return { unavailableReason: "missing_client_profile", userAgentSource };
		return {
			identity: { proxyUrl, userAgent },
			userAgentSource,
		};
	} catch {
		return { unavailableReason: "missing_client_profile", userAgentSource };
	}
}

function createChainTelemetryBinding(options: Parameters<typeof createResolverChainClient>[0]) {
	return (telemetry: ResolverTelemetrySink) => createResolverChainClient({ ...options, telemetry });
}

function createResolverChainClient(options: {
	readonly kinds: readonly ProviderChallengeKind[];
	readonly entries: readonly ResolverChainEntry[];
	readonly unavailableReason?: string;
	readonly usingDefaultVendors?: boolean;
	readonly cache?: ProviderCache;
	readonly identity?: ResolverIdentity;
	readonly proxyIntent?: ResolverRuntimeOptions["proxyIntent"];
	readonly identityScope?: string;
	readonly transport?: ResolverVendorTransport;
	readonly createTransport?: ResolverRuntimeOptions["createTransport"];
	readonly clientProfile?: string;
	readonly allowedHosts?: readonly string[];
	readonly telemetry?: ResolverTelemetrySink;
}): ResolverChainClient {
	assertClientProfileTransportContract(options.clientProfile, options.transport);
	const cache =
		options.cache && !isProviderCacheBypassed(options.cache) ? options.cache : undefined;
	const client: ResolverChainClient = {
		async solve(
			challenge: ProviderChallenge,
			signal: AbortSignal = new AbortController().signal,
			traceRecorder?: TraceRecorder,
		) {
			const solveStartedAt = Date.now();
			let terminalOutcome: "solved" | "cached" | "exhausted" | "aborted" | "error" = "error";
			try {
				assertDeclaredKind(challenge.kind, options.kinds);
				if (options.unavailableReason) {
					throw new ProviderError(options.unavailableReason, {
						code: "RESOLVER_UNAVAILABLE",
						fix: "Configure at least one declared resolver vendor or provide a test ResolverContext override.",
					});
				}

				const supportingEntries = options.entries.filter((entry) => entry.supports(challenge.kind));
				if (supportingEntries.length === 0) {
					throwUnsupportedKind(challenge.kind, options.usingDefaultVendors ?? false);
				}
				if (kindRequiresClientProfile(challenge.kind) && !options.clientProfile?.trim()) {
					options.telemetry?.recordIdentity({ source: "none", failure: "missing_client_profile" });
					throwExhausted(
						challenge.kind,
						supportingEntries.map((entry) => ({
							vendor: entry.id,
							reason: "missing_client_profile",
						})),
						0,
					);
				}
				signal.throwIfAborted();
				const identityResolution = options.proxyIntent
					? await resolveResolverIdentity(options.proxyIntent)
					: { identity: options.identity };
				const identity = identityResolution.identity;
				options.telemetry?.recordIdentity({
					// For SBSD, "declared" identifies the configured client profile and its bound
					// session identity; the engine independently supplies solver credentials.
					source:
						kindRequiresClientProfile(challenge.kind) && options.clientProfile
							? "declared"
							: options.proxyIntent
								? (identityResolution.userAgentSource ?? "defaulted")
								: identity
									? "declared"
									: "none",
					...(identityResolution.unavailableReason
						? { failure: identityResolution.unavailableReason }
						: {}),
				});
				signal.throwIfAborted();
				const requiredProxyIdentityMissing =
					options.proxyIntent?.mode === "required" && identity === undefined;
				if (requiredProxyIdentityMissing) {
					const reason = identityResolution.unavailableReason ?? "missing_proxy_identity";
					for (const [entryIndex, entry] of supportingEntries.entries()) {
						options.telemetry?.recordVendorAttempt({
							vendor: entry.id,
							phase: "create_task",
							diagnostics: { attemptIndex: entryIndex + 1 },
							outcome: "error",
							ms: 0,
							errorClass: reason,
						});
						const next = supportingEntries[entryIndex + 1];
						if (next) {
							options.telemetry?.recordFailover({ from: entry.id, to: next.id, reason });
						}
					}
					throwExhausted(
						challenge.kind,
						supportingEntries.map((entry) => ({
							vendor: entry.id,
							reason,
						})),
					);
				}
				if (!cache) {
					options.telemetry?.recordCacheRead({ status: "disabled", challengeKind: challenge.kind });
				} else if (!resolverChallengeIsCacheable(challenge)) {
					options.telemetry?.recordCacheRead({
						status: "not_cacheable",
						challengeKind: challenge.kind,
					});
				} else {
					const cached = await findCachedSolution(
						cache,
						challenge,
						identity,
						options.identityScope,
					);
					options.telemetry?.recordCacheRead({
						status: cached ? "hit" : "miss",
						challengeKind: challenge.kind,
					});
					if (cached) {
						terminalOutcome = "cached";
						return cached;
					}
				}
				const attempts: ResolverChainAttempt[] = [];
				for (const [entryIndex, entry] of supportingEntries.entries()) {
					const adapter = entry.createAdapter();
					const attemptStartedAt = Date.now();
					const diagnostics: ResolverAttemptDiagnostics = {};
					const telemetryTraceRecorder = createResolverTelemetryTraceRecorder({
						base: traceRecorder,
						vendor: adapter.id,
						attemptIndex: entryIndex + 1,
						telemetry: options.telemetry,
						diagnostics,
					});
					let solution: ChallengeSolution;
					try {
						const solveAttempt = async () => {
							// Boundary first: an overreaching declaration is a caller fault even when no
							// transport is configured, not a "missing_transport" vendor unavailability.
							const adapterHosts = adapter.transportAllowedHosts ?? [];
							assertResolverVendorTransportHosts(adapter.id, adapterHosts);
							const requiresTransport = adapterRequiresTransport(adapter, challenge.kind);
							const unrestrictedTransport =
								options.transport ??
								(requiresTransport
									? options.createTransport?.({
											clientProfile: options.clientProfile,
											identityScope: options.identityScope,
										})
									: undefined);
							if (requiresTransport && unrestrictedTransport === undefined) {
								throw new ResolverVendorUnavailableError(adapter.id, "missing_transport");
							}
							const boundTransport = unrestrictedTransport
								? restrictResolverTransport(unrestrictedTransport, [
										...(options.allowedHosts ?? []),
										...adapterHosts,
									])
								: undefined;
							const usage: ResolverPaidUsageContext = {
								// Position in the declared chain, not in the kind-filtered list.
								vendorIndex: options.entries.indexOf(entry) + 1,
								...(options.identityScope
									? {
											resolverIdentityScope: createHash("sha256")
												.update(options.identityScope, "utf8")
												.digest("hex"),
										}
									: {}),
							};
							try {
								return await adapter.solve(
									challenge,
									identity,
									signal,
									telemetryTraceRecorder,
									boundTransport?.transport,
									usage,
								);
							} finally {
								boundTransport?.revoke();
							}
						};
						solution = traceRecorder
							? await traceRecorder.runSpan("resolver.vendor.attempt", solveAttempt, {
									attributes: {
										vendor: adapter.id,
										challenge_kind: challenge.kind,
										client_profile: options.clientProfile,
										resolver_identity_source: identityResolution.userAgentSource,
									},
									onError(error) {
										return error instanceof ResolverVendorUnavailableError
											? unavailableSpanAttributes(error)
											: undefined;
									},
								})
							: await solveAttempt();
					} catch (error) {
						const unavailable = error instanceof ResolverVendorUnavailableError ? error : undefined;
						const attempt = unavailable ? unavailableAttempt(unavailable, true) : undefined;
						options.telemetry?.recordVendorAttempt({
							vendor: adapter.id,
							phase:
								resolverTelemetryPhase(unavailable?.phase) ??
								resolverTelemetryPhase(diagnostics.phase) ??
								"create_task",
							diagnostics: {
								...attempt,
								attemptIndex: entryIndex + 1,
								phase: attempt?.phase ?? diagnostics.phase,
							},
							outcome: "error",
							ms: Date.now() - attemptStartedAt,
							errorClass: resolverAttemptErrorClass(error, signal),
							...(diagnostics.pollCount === undefined ? {} : { pollCount: diagnostics.pollCount }),
							...(diagnostics.vendorErrorCode
								? { vendorErrorCode: diagnostics.vendorErrorCode }
								: {}),
							...(diagnostics.vendorErrorDescription
								? { vendorErrorDescription: diagnostics.vendorErrorDescription }
								: {}),
						});
						signal.throwIfAborted();
						if (!unavailable || !attempt) throw error;
						attempts.push(attempt);
						const next = supportingEntries[entryIndex + 1];
						if (next) {
							options.telemetry?.recordFailover({
								from: adapter.id,
								to: next.id,
								reason: unavailable.reason,
							});
						}
						continue;
					}
					options.telemetry?.recordVendorAttempt({
						vendor: adapter.id,
						phase: resolverTelemetryPhase(diagnostics.phase) ?? "poll_result",
						diagnostics: { attemptIndex: entryIndex + 1, phase: diagnostics.phase },
						outcome: "ok",
						ms: Date.now() - attemptStartedAt,
						...(diagnostics.pollCount === undefined ? {} : { pollCount: diagnostics.pollCount }),
					});
					if (cache) {
						try {
							let cacheWrite: { written: boolean; reason?: "no_expires" | "not_cacheable" };
							if (!resolverChallengeIsCacheable(challenge)) {
								cacheWrite = { written: false, reason: "not_cacheable" };
							} else if (solution.form !== "cookies" || solutionExpiryMs(solution) === undefined) {
								cacheWrite = { written: false, reason: "no_expires" };
							} else {
								const issuingIdentity =
									adapter.getIssuingIdentity?.(solution, identity, challenge) ??
									resolverChallengeIssuingIdentity(challenge, {
										...(identity ? { proxyUrl: identity.proxyUrl } : {}),
										userAgent: solution.userAgent,
									});
								cacheWrite = issuingIdentity
									? await cacheResolverSolution(
											cache,
											challenge,
											solution,
											issuingIdentity,
											options.identityScope,
										)
									: { written: false, reason: "not_cacheable" };
							}
							options.telemetry?.recordCacheWrite(cacheWrite);
						} catch (error) {
							options.telemetry?.recordCacheWrite({ written: false, reason: "error" });
							throw error;
						}
					}
					rememberSolutionSource(solution, "vendor");
					// Adapter success includes SBSD payload acceptance with verified:false.
					// The caller reports protected-refetch verification separately.
					terminalOutcome = "solved";
					return solution;
				}

				throwExhausted(challenge.kind, attempts);
			} catch (error) {
				terminalOutcome = signal.aborted
					? "aborted"
					: error instanceof ProviderError && error.code === "RESOLVER_CHAIN_EXHAUSTED"
						? "exhausted"
						: "error";
				throw error;
			} finally {
				options.telemetry?.recordOutcome({
					outcome: terminalOutcome,
					solveMs: Date.now() - solveStartedAt,
					challengeKind: challenge.kind,
				});
			}
		},
	};
	resolverCaches.set(client, cache ?? null);
	const reusableOptions = { ...options, telemetry: undefined };
	registerResolverTelemetryBinding(client, createChainTelemetryBinding(reusableOptions));
	return client;
}

export function createResolverClient(options: {
	readonly kinds: readonly ProviderChallengeKind[];
	readonly adapters: readonly ResolverVendorAdapter[];
	readonly unavailableReason?: string;
	readonly cache?: ProviderCache;
	readonly identity?: ResolverIdentity;
	readonly proxyIntent?: ResolverRuntimeOptions["proxyIntent"];
	readonly transport?: ResolverVendorTransport;
	readonly createTransport?: ResolverRuntimeOptions["createTransport"];
	readonly clientProfile?: string;
	readonly allowedHosts?: readonly string[];
	readonly telemetry?: ResolverTelemetrySink;
}): ResolverChainClient {
	for (const adapter of options.adapters) {
		// Fail at construction, not on the first solve, when a supplied adapter oversteps its vendor.
		assertResolverVendorTransportHosts(adapter.id, adapter.transportAllowedHosts ?? []);
	}
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
		proxyIntent: options.proxyIntent,
		transport: options.transport,
		createTransport: options.createTransport,
		clientProfile: options.clientProfile,
		allowedHosts: options.allowedHosts,
		telemetry: options.telemetry,
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
	if (vendor === "browser") {
		return {
			vendor,
			available: true,
			configuration: normalizedEnvValue(env, APIFUSE__CDP_POOL__URL),
		};
	}

	const envKey =
		vendor === "2captcha"
			? APIFUSE__RESOLVER__2CAPTCHA__API_KEY
			: vendor === "capsolver"
				? APIFUSE__RESOLVER__CAPSOLVER__API_KEY
				: vendor === "capmonster"
					? APIFUSE__RESOLVER__CAPMONSTER__API_KEY
					: APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY;

	const configuration = normalizedEnvValue(env, envKey);
	return configuration
		? { vendor, available: true, configuration }
		: { vendor, available: false, reason: "missing_credentials" };
}

export function bindResolverSignal(
	resolver: ResolverContext,
	defaultSignal: AbortSignal | undefined,
): ResolverContext {
	if (!defaultSignal) return resolver;
	const boundResolver: ResolverContext = {
		solve(challenge, signal = defaultSignal, traceRecorder?: TraceRecorder) {
			return (resolver as Partial<ResolverSolveWithRecorder> & ResolverContext).solve(
				challenge,
				signal,
				traceRecorder,
			);
		},
	};
	if (resolverCaches.has(resolver)) {
		resolverCaches.set(boundResolver, resolverCaches.get(resolver) ?? null);
	}
	inheritResolverTelemetryBinding(resolver, boundResolver);
	return boundResolver;
}

function createResolverClientFromEnvInternal(
	config: ProviderResolverConfig | undefined,
	env: EnvLike,
	options: ResolverRuntimeOptions,
	adapterFactories: Partial<Readonly<Record<ProviderResolverVendor, ResolverAdapterFactory>>>,
): ResolverContext {
	if (!config) {
		return createUnsupportedResolverClient("Provider does not declare resolver capability");
	}
	assertClientProfileTransportContract(config.clientProfile, options.transport);

	const vendors = resolveProviderResolverVendors(config);
	if (config.vendors !== undefined && config.vendors.length === 0) {
		return createResolverChainClient({
			kinds: config.kinds,
			entries: [],
			unavailableReason: "Provider resolver vendor chain is empty",
			telemetry: options.telemetry,
		});
	}

	const timeoutValue = readPositiveIntegerEnv(env, APIFUSE__RESOLVER__TIMEOUT_MS);
	const timeoutMs = timeoutValue === undefined ? DEFAULT_RESOLVER_TIMEOUT_MS : Number(timeoutValue);
	const allowedHosts = [...(options.allowedHosts ?? [])];

	return createResolverChainClient({
		kinds: config.kinds,
		entries: vendors.map((configuredVendor) => {
			assertKnownResolverVendor(configuredVendor);
			const vendor = configuredVendor;
			return {
				id: vendor,
				supports: (kind: ProviderChallengeKind) => resolverVendorSupports(vendor, kind),
				createAdapter: () =>
					createAdapter(
						resolveVendorAvailability(vendor, env),
						timeoutMs,
						allowedHosts,
						adapterFactories,
					),
			};
		}),
		usingDefaultVendors: config.vendors === undefined,
		cache: options.cache,
		proxyIntent: options.proxyIntent,
		identityScope: options.identityScope,
		transport: options.transport,
		createTransport: options.createTransport,
		clientProfile: config.clientProfile,
		allowedHosts,
		telemetry: options.telemetry,
	});
}

export function createResolverClientFromEnv(
	config: ProviderResolverConfig | undefined,
	env: EnvLike = process.env,
	options: ResolverRuntimeOptions = {},
): ResolverContext {
	return createResolverClientFromEnvInternal(config, env, options, RESOLVER_ADAPTER_REGISTRY);
}

/** Internal test seam; deliberately not re-exported from the package root. */
export function createResolverClientFromEnvForTests(
	config: ProviderResolverConfig | undefined,
	env: EnvLike,
	options: ResolverRuntimeOptions,
	adapterFactories: Partial<Readonly<Record<ProviderResolverVendor, ResolverAdapterFactory>>>,
): ResolverContext {
	return createResolverClientFromEnvInternal(config, env, options, adapterFactories);
}
