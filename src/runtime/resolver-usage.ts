import type { ProviderChallengeKind, ProviderResolverVendor } from "../types.js";
import type {
	ResolverVendorAdapter,
	ResolverVendorUnavailableError,
} from "./resolver-vendors/types.js";
import type { TraceRecorder } from "./trace.js";

type ResolverPaidUsageContext = NonNullable<Parameters<ResolverVendorAdapter["solve"]>[5]>;

export const RESOLVER_PAID_USAGE_SPAN = "resolver.usage";

export type ResolverPaidUsageOutcome = "success" | "vendor_error" | "timeout" | "abandoned";

function errorOutcome(error: unknown, signal: AbortSignal): ResolverPaidUsageOutcome {
	const signalReason = signal.reason;
	const errorName = error instanceof Error ? error.name : "";
	const reasonName = signalReason instanceof Error ? signalReason.name : "";
	const unavailableReason = (error as Partial<ResolverVendorUnavailableError> | undefined)?.reason;
	if (
		unavailableReason === "timeout" ||
		/timeout/iu.test(errorName) ||
		/timeout/iu.test(reasonName)
	) {
		return "timeout";
	}
	if (signal.aborted) return "abandoned";
	return "vendor_error";
}

/**
 * Records exactly one allowlisted engine span around a paid task-creation call.
 * Callers perform credential/transport validation before invoking this helper,
 * so an event implies that a potentially billable vendor request was attempted.
 */
export async function recordPaidResolverCreate<T>(options: {
	readonly traceRecorder?: TraceRecorder;
	readonly vendor: ProviderResolverVendor;
	readonly kind: ProviderChallengeKind;
	readonly signal: AbortSignal;
	readonly usage?: ResolverPaidUsageContext;
	readonly create: () => Promise<T>;
}): Promise<T> {
	if (!options.traceRecorder) return options.create();
	const baseAttributes = {
		vendor: options.vendor,
		challenge_kind: options.kind,
		billable_units: 1,
		attempt_index: options.usage?.attemptIndex ?? 1,
		resolver_identity_scope: options.usage?.resolverIdentityScope,
	};
	return options.traceRecorder.runSpan(RESOLVER_PAID_USAGE_SPAN, options.create, {
		attributes: baseAttributes,
		onSuccess: () => ({ outcome: "success" }),
		onError: (error) => ({ outcome: errorOutcome(error, options.signal) }),
	});
}
