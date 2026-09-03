import { ProviderError } from "../errors.js";
import type { ChallengeSolution, ProviderChallenge, ResolverContext } from "../types.js";
import type { TraceRecorder } from "./trace.js";
import type { ResolverTelemetryOutcome, ResolverTelemetrySink } from "./resolver-telemetry.js";

type ResolverTelemetryBinding = (sink: ResolverTelemetrySink) => ResolverContext;
const telemetryBindings = new WeakMap<ResolverContext, ResolverTelemetryBinding>();

/** Internal contract: reconstruct a chain with a new request sink, without mutating the host chain. */
export function registerResolverTelemetryBinding(
	resolver: ResolverContext,
	bind: ResolverTelemetryBinding,
): void {
	telemetryBindings.set(resolver, bind);
}

/** Preserve reconstruction across SDK wrappers without capturing their current request sink. */
export function inheritResolverTelemetryBinding(
	resolver: ResolverContext,
	wrapper: ResolverContext,
): void {
	const bind = telemetryBindings.get(resolver);
	if (bind) telemetryBindings.set(wrapper, bind);
}

/** SDK chains expose each vendor invocation; opaque host resolvers expose one custom invocation. */
export function bindResolverTelemetry(
	resolver: ResolverContext,
	sink: ResolverTelemetrySink | undefined,
): ResolverContext {
	if (!sink) return resolver;
	const metadata = (
		resolver as ResolverContext & {
			readonly [RESOLVER_INSTRUMENTATION_METADATA]?: { readonly target: ResolverContext };
		}
	)[RESOLVER_INSTRUMENTATION_METADATA];
	if (metadata) return bindResolverTelemetry(metadata.target, sink);
	const bind = telemetryBindings.get(resolver);
	if (bind) return bind(sink);
	const wrapper: ResolverSolveWithRecorder = {
		async solve(challenge, signal, recorder) {
			const startedAt = Date.now();
			let outcome: ResolverTelemetryOutcome = "error";
			try {
				const solution = await (resolver as ResolverSolveWithRecorder).solve(
					challenge,
					signal,
					recorder,
				);
				outcome = "solved";
				return solution;
			} catch (error) {
				outcome = signal?.aborted
					? "aborted"
					: error instanceof ProviderError && error.code === "RESOLVER_CHAIN_EXHAUSTED"
						? "exhausted"
						: "error";
				throw error;
			} finally {
				const ms = Date.now() - startedAt;
				sink.recordVendorAttempt({
					vendor: "custom",
					phase: outcome === "solved" ? "poll_result" : "create_task",
					outcome: outcome === "solved" ? "ok" : "error",
					ms,
				});
				sink.recordOutcome({ outcome, solveMs: ms, challengeKind: challenge.kind });
			}
		},
	};
	// Rebinding this wrapper returns to the original host, never to its previous sink.
	registerResolverTelemetryBinding(wrapper, createOpaqueResolverTelemetryBinding(resolver));
	return wrapper;
}

function createOpaqueResolverTelemetryBinding(resolver: ResolverContext): ResolverTelemetryBinding {
	return (sink) => bindResolverTelemetry(resolver, sink);
}

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
