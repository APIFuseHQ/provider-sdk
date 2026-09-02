import type {
	ChallengeSolution,
	ProviderChallenge,
	ProviderChallengeKind,
	ProviderResolverConfig,
	ProviderResolverVendor,
} from "../../types.js";
import type { TraceRecorder } from "../trace.js";

export const RESOLVER_VENDOR_CAPABILITIES = {
	browser: ["aws_waf", "cloudflare_interstitial"],
	// Every kind listed per vendor is implemented by that vendor's adapter; the
	// per-adapter "agrees with every declared capability" tests iterate this
	// table, so adding a kind here without an implementation fails the suite.
	// 2captcha omits `cloudflare_interstitial` and every Akamai kind: its API
	// offers no measured task type for them, so declaring them
	// would route challenges to a vendor that can only refuse.
	"2captcha": [
		"turnstile",
		"recaptcha_v2",
		"recaptcha_v3",
		"hcaptcha",
		"aws_waf",
	],
	capsolver: [
		"turnstile",
		"recaptcha_v2",
		"recaptcha_v3",
		"hcaptcha",
		"cloudflare_interstitial",
		"aws_waf",
	],
	capmonster: ["turnstile", "recaptcha_v2", "recaptcha_v3", "hcaptcha"],
	// Hyper's /sbsd envelope is measured. Its sensor endpoint is deliberately
	// omitted until that separate protocol is implemented and verified.
	hypersolutions: ["akamai_sbsd"],
	custom: [
		"turnstile",
		"recaptcha_v2",
		"recaptcha_v3",
		"hcaptcha",
		"cloudflare_interstitial",
		"aws_waf",
		"akamai_sec_cpt",
		"akamai_sensor",
		"akamai_sbsd",
	],
} as const satisfies Readonly<Record<ProviderResolverVendor, readonly ProviderChallengeKind[]>>;

/**
 * SDK-owned fallback policy for hosted resolver vendors. Capability support is
 * applied separately, so each provider receives only vendors that support one
 * or more of its declared challenge kinds.
 */
export const DEFAULT_RESOLVER_VENDOR_PREFERENCE = [
	"capsolver",
	"2captcha",
	"hypersolutions",
] as const satisfies readonly ProviderResolverVendor[];

export function resolverVendorSupports(
	vendor: ProviderResolverVendor,
	kind: ProviderChallengeKind,
): boolean {
	return (RESOLVER_VENDOR_CAPABILITIES[vendor] as readonly ProviderChallengeKind[]).includes(kind);
}

/** Resolves an explicit provider override or the SDK-owned default vendor chain. */
export function resolveProviderResolverVendors(
	config: ProviderResolverConfig,
): readonly ProviderResolverVendor[] {
	if (config.vendors !== undefined) return config.vendors;
	return DEFAULT_RESOLVER_VENDOR_PREFERENCE.filter((vendor) =>
		config.kinds.some((kind) => resolverVendorSupports(vendor, kind)),
	);
}

export interface ResolverIdentity {
	readonly proxyUrl: string;
	readonly userAgent: string;
}

export interface ResolverIssuingIdentity {
	/** Absent when the adapter genuinely solved without a proxy. */
	readonly proxyUrl?: string;
	readonly userAgent: string;
}

export interface ResolverVendorTransport {
	/**
	 * Exact stable upstream headers owned by the proxy/profile-bound transport.
	 * This does not include dynamic Cookie headers; the transport injects those from its jar.
	 * Adapter requests do not receive these headers implicitly and must forward
	 * them when their measured protocol requires session-header continuity.
	 */
	readonly sessionHeaders?: Readonly<Record<string, string>>;
	/**
	 * Read a cookie from the transport's bound jar for the supplied URL. Responses
	 * returned by `fetch` MUST already have been applied to that jar before this
	 * method is called. Profile-bound adapters fail closed when this seam is absent.
	 */
	readonly getCookie?: (name: string, url: string) => string | undefined;
	/** Implementations MUST NOT follow redirects and must return the initial response. */
	fetch(
		url: string,
		init: {
			method: "GET" | "POST";
			headers?: Readonly<Record<string, string>>;
			body?: string;
			signal: AbortSignal;
			/** Implementations MUST honor manual redirect handling when the SDK guard sets it. */
			redirect?: "manual";
			/** Maximum UTF-8 response body size; implementations must stop reading at this bound. */
			maxBodyBytes?: number;
		},
	): Promise<{
		readonly status: number;
		readonly headers: Readonly<Record<string, string>>;
		readonly body: string;
		/** Cookies observed on the response, including cache-relevant attributes. */
		readonly cookies: readonly {
			readonly name: string;
			readonly value: string;
			/** Epoch seconds. A session cookie must be undefined, never CDP's -1 sentinel. */
			readonly expires?: number;
			readonly httpOnly: boolean;
			readonly secure: boolean;
			readonly domain?: string;
			readonly path?: string;
			readonly sameSite?: string;
		}[];
	}>;
}

export interface ResolverVendorAdapter {
	readonly id: ProviderResolverVendor;
	readonly requiresTransport?: boolean | ((kind: ProviderChallengeKind) => boolean);
	/** Exact SDK-owned service hosts this adapter may reach through its bound transport. */
	readonly transportAllowedHosts?: readonly string[];
	supports(kind: ProviderChallengeKind): boolean;
	/** Identity the adapter actually used, reported after a successful solve. */
	getIssuingIdentity?(
		solution: ChallengeSolution,
		requestedIdentity: ResolverIdentity | undefined,
		challenge: ProviderChallenge,
	): ResolverIssuingIdentity | undefined;
	solve(
		challenge: ProviderChallenge,
		identity: ResolverIdentity | undefined,
		signal: AbortSignal,
		traceRecorder?: TraceRecorder,
		transport?: ResolverVendorTransport,
	): Promise<ChallengeSolution>;
}

export type ResolverVendorUnavailableReason =
	| "missing_credentials"
	| "missing_proxy_identity"
	| "missing_client_profile"
	| "missing_challenge_input"
	| "missing_transport"
	| "allocation_exhausted"
	| "transport_failure"
	| "timeout"
	| "not_implemented";

export type ResolverChallengeVerdictReason = "human_puzzle" | "solve_failed";

type ResolverErrorOptions = {
	/** Raw cause; adapters must not place bodies, cookies, headers, credentials, or proxy URLs here. */
	readonly cause?: unknown;
	/** Names of challenge fields required by this adapter but absent from this call's input. */
	readonly missingFields?: readonly string[];
	/** Upstream hostname only; never a URL. */
	readonly upstreamHost?: string;
	/** Adapter-defined sensor-loop phase, such as fetch_script or post_sensor. */
	readonly phase?: string;
	/** One-based sensor-loop round when known. */
	readonly round?: number;
};

export class ResolverVendorUnavailableError extends Error {
	readonly missingFields?: readonly string[];
	readonly upstreamHost?: string;
	readonly phase?: string;
	readonly round?: number;

	constructor(
		readonly vendor: ProviderResolverVendor,
		readonly reason: ResolverVendorUnavailableReason,
		options: ResolverErrorOptions = {},
	) {
		const missingFields =
			reason === "missing_challenge_input"
				? options.missingFields?.filter((field) => /^[A-Za-z][A-Za-z0-9_]*$/u.test(field))
				: undefined;
		super(
			reason === "missing_challenge_input" && missingFields !== undefined && missingFields.length > 0
				? `Resolver vendor ${vendor} cannot use incomplete challenge input; missing fields: ${missingFields.join(", ")}`
				: `Resolver vendor ${vendor} is unavailable: ${reason}`,
		);
		this.name = "ResolverVendorUnavailableError";
		if (missingFields !== undefined && missingFields.length > 0) {
			this.missingFields = Object.freeze([...missingFields]);
		}
		if (options.cause !== undefined) {
			this.cause = options.cause;
		}
		this.upstreamHost = options.upstreamHost;
		this.phase = options.phase;
		this.round = options.round;
	}
}

export class ResolverChallengeVerdictError extends Error {
	constructor(
		readonly vendor: ProviderResolverVendor,
		readonly reason: ResolverChallengeVerdictReason,
		options: ResolverErrorOptions = {},
	) {
		super(
			reason === "solve_failed"
				? `Resolver vendor ${vendor} attempted the challenge but did not solve it`
				: `Resolver vendor ${vendor} returned a challenge verdict: ${reason}`,
		);
		this.name = "ResolverChallengeVerdictError";
		if (options.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}
