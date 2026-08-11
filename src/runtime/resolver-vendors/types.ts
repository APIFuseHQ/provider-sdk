import type {
	ChallengeSolution,
	ProviderChallenge,
	ProviderChallengeKind,
	ProviderResolverVendor,
} from "../../types.js";

export interface ResolverIdentity {
	readonly proxyUrl: string;
	readonly userAgent: string;
}

export interface ResolverVendorAdapter {
	readonly id: ProviderResolverVendor;
	supports(kind: ProviderChallengeKind): boolean;
	solve(
		challenge: ProviderChallenge,
		identity: ResolverIdentity | undefined,
		signal: AbortSignal,
	): Promise<ChallengeSolution>;
}

export type ResolverVendorUnavailableReason =
	| "missing_credentials"
	| "allocation_exhausted"
	| "transport_failure"
	| "timeout";

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
