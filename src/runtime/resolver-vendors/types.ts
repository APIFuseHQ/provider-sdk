import type {
	ChallengeSolution,
	ProviderChallenge,
	ProviderChallengeKind,
	ProviderResolverVendor,
} from "../../types.js";
import type { TraceRecorder } from "../trace.js";

export const RESOLVER_VENDOR_CAPABILITIES = {
	browser: ["aws_waf", "cloudflare_interstitial"],
	"2captcha": [
		"turnstile",
		"recaptcha_v2",
		"recaptcha_v3",
		"hcaptcha",
		"cloudflare_interstitial",
		"aws_waf",
		"akamai_sec_cpt",
		"akamai_sensor",
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
	custom: [
		"turnstile",
		"recaptcha_v2",
		"recaptcha_v3",
		"hcaptcha",
		"cloudflare_interstitial",
		"aws_waf",
		"akamai_sec_cpt",
		"akamai_sensor",
	],
} as const satisfies Readonly<Record<ProviderResolverVendor, readonly ProviderChallengeKind[]>>;

export function resolverVendorSupports(
	vendor: ProviderResolverVendor,
	kind: ProviderChallengeKind,
): boolean {
	return (RESOLVER_VENDOR_CAPABILITIES[vendor] as readonly ProviderChallengeKind[]).includes(kind);
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
	/** Bound to the resolved proxy lease and client profile. */
	fetch(
		url: string,
		init: {
			method: "GET" | "POST";
			headers?: Readonly<Record<string, string>>;
			body?: string;
			signal: AbortSignal;
		},
	): Promise<{
		readonly status: number;
		readonly headers: Readonly<Record<string, string>>;
		readonly body: string;
		/** Cookies observed on the response, name -> value. */
		readonly cookies: Readonly<Record<string, string>>;
	}>;
}

export interface ResolverVendorAdapter {
	readonly id: ProviderResolverVendor;
	readonly requiresTransport?: boolean;
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
	| "missing_transport"
	| "allocation_exhausted"
	| "transport_failure"
	| "timeout"
	| "not_implemented";

export type ResolverChallengeVerdictReason = "human_puzzle";

type ResolverErrorOptions = {
	readonly cause?: unknown;
};

export class ResolverVendorUnavailableError extends Error {
	constructor(
		readonly vendor: ProviderResolverVendor,
		readonly reason: ResolverVendorUnavailableReason,
		options: ResolverErrorOptions = {},
	) {
		super(`Resolver vendor ${vendor} is unavailable: ${reason}`);
		this.name = "ResolverVendorUnavailableError";
		if (options.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

export class ResolverChallengeVerdictError extends Error {
	constructor(
		readonly vendor: ProviderResolverVendor,
		readonly reason: ResolverChallengeVerdictReason,
		options: ResolverErrorOptions = {},
	) {
		super(`Resolver vendor ${vendor} returned a challenge verdict: ${reason}`);
		this.name = "ResolverChallengeVerdictError";
		if (options.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}
