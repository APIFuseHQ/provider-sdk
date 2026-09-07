import type { ProviderChallengeKind, ProviderResolverVendor } from "../types.js";
import type {
	ResolverPaidUsageContext,
	ResolverVendorUnavailableError,
} from "./resolver-vendors/types.js";
import type { TraceRecorder } from "./trace.js";

export const RESOLVER_PAID_USAGE_SPAN = "resolver.usage";

export type ResolverPaidUsageOutcome = "success" | "vendor_error" | "timeout" | "abandoned";

export type ResolverPaidUsageEndpoint =
	| "capsolver:create_task"
	| "twocaptcha:create_task"
	| "hyper:ip"
	| "hyper:sbsd_create";

/**
 * How one call to the endpoint is counted. `metered` endpoints are the vendors' task or
 * payload creation calls: the SDK counts one unit per call (the vendor ledger stays
 * authoritative for refunds of failed tasks). Hyper's `/ip` reflector is authenticated
 * but has no published price, so it is recorded with 0 units and `billing: "unconfirmed"`
 * rather than invented as a paid unit; the span still proves the call was made.
 */
const ENDPOINT_BILLING: Record<
	ResolverPaidUsageEndpoint,
	{ readonly billable_units: 0 | 1; readonly billing: "metered" | "unconfirmed" }
> = {
	"capsolver:create_task": { billable_units: 1, billing: "metered" },
	"twocaptcha:create_task": { billable_units: 1, billing: "metered" },
	"hyper:ip": { billable_units: 0, billing: "unconfirmed" },
	"hyper:sbsd_create": { billable_units: 1, billing: "metered" },
};

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

const warnedSinks = new WeakSet<(message: string) => void>();

/**
 * Records one `resolver.usage` span around a paid vendor call. Callers validate credentials
 * and transport first, so a span means a potentially billable request was attempted (a
 * failed create the vendor may still bill is a span too). Without a trace recorder the call
 * still runs; the lost billing record is warned once per warn sink.
 */
export async function recordPaidResolverCreate<T>(options: {
	readonly traceRecorder?: TraceRecorder;
	readonly vendor: ProviderResolverVendor;
	readonly kind: ProviderChallengeKind;
	readonly endpoint: ResolverPaidUsageEndpoint;
	/** 1-based round for endpoints called more than once per solve (Hyper payload rounds). */
	readonly round?: number;
	readonly signal: AbortSignal;
	readonly usage?: ResolverPaidUsageContext;
	readonly warn?: (message: string) => void;
	readonly create: () => Promise<T>;
}): Promise<T> {
	if (!options.traceRecorder) {
		const warn = options.warn ?? console.warn;
		if (!warnedSinks.has(warn)) {
			warnedSinks.add(warn);
			warn(
				`[provider-sdk] Paid resolver call ${options.endpoint} ran without a trace recorder; its resolver.usage record is lost (reported once).`,
			);
		}
		return options.create();
	}
	const baseAttributes = {
		vendor: options.vendor,
		challenge_kind: options.kind,
		endpoint: options.endpoint,
		...ENDPOINT_BILLING[options.endpoint],
		// Only the resolver chain knows the vendor's position; a direct adapter call has none.
		...(options.usage ? { vendor_index: options.usage.vendorIndex } : {}),
		...(options.round === undefined ? {} : { round: options.round }),
		resolver_identity_scope: options.usage?.resolverIdentityScope,
	};
	return options.traceRecorder.runSpan(RESOLVER_PAID_USAGE_SPAN, options.create, {
		attributes: baseAttributes,
		onSuccess: () => ({ outcome: "success" }),
		onError: (error) => ({ outcome: errorOutcome(error, options.signal) }),
	});
}
