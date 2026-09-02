import { ProviderError } from "../errors.js";
import type { ChallengeSolution, ProviderChallenge, ResolverContext } from "../types.js";
import type { TraceRecorder } from "./trace.js";

export const RESOLVER_INSTRUMENTATION_METADATA = Symbol.for(
	"@apifuse/provider-sdk/runtime/resolver-instrumentation-metadata",
);

/**
 * Internal solve surface. The instrumentation layer threads its recorder as a
 * third argument so vendor-level spans (`resolver.vendor.*`) attach to the
 * active trace. Every wrapper that re-exposes `solve` must forward the extra
 * arguments; a wrapper typed against the public two-argument `ResolverContext`
 * silently drops the recorder and vendor spans vanish.
 */
export type ResolverSolveWithRecorder = {
	solve(
		challenge: ProviderChallenge,
		signal?: AbortSignal,
		traceRecorder?: TraceRecorder,
	): Promise<ChallengeSolution>;
};

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
