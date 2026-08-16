import { ProviderError } from "../errors.js";
import type { ResolverContext } from "../types.js";

export const RESOLVER_INSTRUMENTATION_METADATA = Symbol.for(
	"@apifuse/provider-sdk/runtime/resolver-instrumentation-metadata",
);

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
