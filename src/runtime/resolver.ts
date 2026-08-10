import { ProviderError } from "../errors.js";
import type {
	ProviderChallengeKind,
	ProviderResolverConfig,
	ProviderResolverVendor,
	ResolverContext,
} from "../types.js";

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
			readonly reason: string;
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

function createResolverClient(options: {
	readonly kinds: readonly ProviderChallengeKind[];
	readonly vendors: readonly ResolvedResolverVendor[];
	readonly timeoutMs: number;
	readonly unavailableReason?: string;
}): ResolverContext {
	return {
		async solve(challenge) {
			assertDeclaredKind(challenge.kind, options.kinds);

			if (options.unavailableReason) {
				throw new ProviderError(options.unavailableReason, {
					code: "RESOLVER_UNAVAILABLE",
					fix: "Configure at least one declared resolver vendor or provide a test ResolverContext override.",
				});
			}

			const availableVendors = options.vendors
				.filter((entry) => entry.available)
				.map((entry) => entry.vendor);
			throw new ProviderError(
				`Resolver vendor adapters for ${availableVendors.join(", ")} land in a later phase`,
				{
					code: "RESOLVER_NOT_IMPLEMENTED",
					fix: "Use a ResolverContext override until the vendor adapters are implemented.",
					details: { availableVendors, timeoutMs: options.timeoutMs },
				},
			);
		},
	};
}

function resolveVendorAvailability(
	vendor: ProviderResolverVendor,
	env: EnvLike,
): ResolvedResolverVendor {
	if (vendor === "custom") {
		return {
			vendor,
			available: false,
			reason: `${vendor} has no configured transport`,
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
		: { vendor, available: false, reason: `${vendor} requires ${envKey}` };
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
		return createResolverClient({
			kinds: config.kinds,
			vendors: [],
			timeoutMs: DEFAULT_RESOLVER_TIMEOUT_MS,
			unavailableReason: "Provider resolver vendor chain is empty",
		});
	}

	const vendors = config.vendors.map((vendor) => resolveVendorAvailability(vendor, env));
	const unavailableVendors = vendors.filter((entry) => !entry.available);
	const timeoutValue = readPositiveIntegerEnv(env, APIFUSE__RESOLVER__TIMEOUT_MS);
	const timeoutMs = timeoutValue === undefined ? DEFAULT_RESOLVER_TIMEOUT_MS : Number(timeoutValue);

	return createResolverClient({
		kinds: config.kinds,
		vendors,
		timeoutMs,
		unavailableReason:
			unavailableVendors.length === vendors.length
				? `No declared resolver vendor is available: ${unavailableVendors
						.map((entry) => entry.reason)
						.join("; ")}`
				: undefined,
	});
}
