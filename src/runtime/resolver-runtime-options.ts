import type { ProviderCache, ProviderDefinition, ProviderProxyPolicy } from "../types.js";
import type { ResolverRuntimeOptions } from "./resolver.js";
import type { ResolverTelemetrySink } from "./resolver-telemetry.js";

/**
 * One option set for every SDK-built resolver chain — the server's ctx.resolver and automatic
 * SBSD solve, and the CLI helper contexts — so they share allowed hosts, cache, identity scope,
 * proxy intent, and the telemetry sink. `identityScope` is server-owned; CLI contexts pass none.
 */
export function createResolverRuntimeOptions(
	provider: ProviderDefinition,
	cache: ProviderCache,
	identityScope: string | undefined,
	proxyPolicy: ProviderProxyPolicy | undefined,
	proxyClientOptions: Omit<
		NonNullable<ResolverRuntimeOptions["proxyIntent"]>,
		"mode" | "userAgent"
	>,
	stealthProfile: { readonly userAgent: string } | undefined,
	telemetry: ResolverTelemetrySink,
): ResolverRuntimeOptions {
	return {
		allowedHosts: provider.allowedHosts,
		cache,
		telemetry,
		...(identityScope === undefined ? {} : { identityScope }),
		...(proxyPolicy
			? {
					proxyIntent: {
						mode: proxyPolicy.mode,
						...proxyClientOptions,
						...(stealthProfile ? { userAgent: stealthProfile.userAgent } : {}),
					},
				}
			: {}),
	};
}
