import { ProviderError } from "../errors.js";
import type {
	ChallengeSolution,
	ProviderChallenge,
	ProviderChallengeKind,
	ProviderResolverConfig,
	ProviderResolverVendor,
	ResolverContext,
} from "../types.js";
import { createBrowserResolverVendorAdapter } from "./resolver-vendors/browser.js";
import {
	resolverVendorSupports,
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

type ResolverAdapterFactory = (configuration: string, timeoutMs: number) => ResolverVendorAdapter;

export const RESOLVER_ADAPTER_REGISTRY: Partial<
	Readonly<Record<ProviderResolverVendor, ResolverAdapterFactory>>
> = {
	browser(configuration, timeoutMs) {
		return createBrowserResolverVendorAdapter({
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

function createAdapter(vendor: ResolvedResolverVendor, timeoutMs: number): ResolverVendorAdapter {
	if (!vendor.available) {
		return createUnavailableAdapter(vendor.vendor, vendor.reason);
	}

	const factory = RESOLVER_ADAPTER_REGISTRY[vendor.vendor];
	return (
		factory?.(vendor.configuration, timeoutMs) ??
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

function createResolverChainClient(options: {
	readonly kinds: readonly ProviderChallengeKind[];
	readonly entries: readonly ResolverChainEntry[];
	readonly unavailableReason?: string;
}): ResolverChainClient {
	return {
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
			const attempts: ResolverChainAttempt[] = [];
			for (const entry of supportingEntries) {
				const adapter = entry.createAdapter();
				try {
					return await adapter.solve(challenge, undefined, signal);
				} catch (error) {
					signal.throwIfAborted();
					if (!(error instanceof ResolverVendorUnavailableError)) throw error;
					attempts.push({ vendor: adapter.id, reason: error.reason });
				}
			}

			throwExhausted(attempts);
		},
	};
}

export function createResolverClient(options: {
	readonly kinds: readonly ProviderChallengeKind[];
	readonly adapters: readonly ResolverVendorAdapter[];
	readonly unavailableReason?: string;
}): ResolverChainClient {
	return createResolverChainClient({
		kinds: options.kinds,
		entries: options.adapters.map((adapter) => ({
			id: adapter.id,
			supports: (kind) => adapter.supports(kind),
			createAdapter: () => adapter,
		})),
		unavailableReason: options.unavailableReason,
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
			createAdapter: () => createAdapter(resolveVendorAvailability(vendor, env), timeoutMs),
		})),
	});
}
