import type { ProxyVendorName } from "../config/loader.js";
import type { ProviderProxyPolicy } from "../types.js";
import { isStickyProxyPolicy, type ProxySessionDirective } from "./proxy-session-id.js";

export type { ProxySessionDirective } from "./proxy-session-id.js";

/**
 * Vendor selection seam. The resolver asks a selector which vendor serves an
 * attempt and with which session, and the transports hand every attempt's
 * outcome back to it. The SDK ships one selector, the static declaration
 * order with an even split of the attempt budget; an adaptive selector
 * (error-rate or latency weighting, circuit breaking, hedging) is a separate
 * change that implements this interface and registers through
 * `setProxyVendorSelector` without touching the resolver or the transports.
 */

/**
 * Transport attempts each vendor in a chain receives when the caller did not
 * pin a retry policy. An implicit, safe-method request on a two-vendor chain
 * may make `2 × PROXY_ATTEMPTS_PER_VENDOR` attempts: the first share on the
 * primary vendor, the rest on the fallback. This replaces the per-vendor pool
 * size that used to decide where the flat attempt index crossed into the next
 * vendor; a policy no longer has to size anything for the fallback to be
 * reachable.
 */
export const PROXY_ATTEMPTS_PER_VENDOR = 3;

export type ProxyVendorDirective = {
	readonly vendor: ProxyVendorName;
	/** Zero-based attempt within this vendor; feeds the session id derivation. */
	readonly vendorAttempt: number;
	readonly session: ProxySessionDirective;
};

export type ProxyAttemptRequest = {
	readonly policy: ProviderProxyPolicy;
	/** Registry vendors declared by the policy, in declaration order. */
	readonly chain: readonly ProxyVendorName[];
	/** Zero-based transport attempt index of the request. */
	readonly attempt: number;
	/** Total attempts the transport may make for the request. */
	readonly attemptCap: number;
	readonly affinityKey?: string;
	readonly now: number;
};

export type ProxyAttemptOutcome = {
	readonly vendor: ProxyVendorName;
	/** `resolution`: the adapter could or could not synthesize; `transport`: the tunnel and request. */
	readonly phase: "resolution" | "transport";
	readonly outcome: "ok" | "error";
	/** Zero-based transport attempt index of the request, when known. */
	readonly attempt?: number;
	readonly vendorAttempt?: number;
	readonly sessionId?: string;
	readonly errorCode?: string;
	readonly status?: number;
	readonly durationMs?: number;
	readonly now: number;
};

export interface ProxyVendorSelector {
	/**
	 * Vendors to try for one attempt, in order. The first directive is the
	 * attempt's vendor; the rest are resolution-time fallbacks the resolver
	 * moves to when that vendor cannot synthesize (no credentials, unsupported
	 * protocol, adapter error). An empty list resolves no vendor.
	 */
	select(request: ProxyAttemptRequest): readonly ProxyVendorDirective[];
	/** Attempt result fed back from the resolver and the transports. */
	report(outcome: ProxyAttemptOutcome): void;
}

export type ProxyAttemptSlot = {
	readonly vendorIndex: number;
	/** Zero-based attempt within that vendor's share. */
	readonly vendorAttempt: number;
};

function normalizeIndex(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Split an attempt budget evenly across a vendor chain, in declaration order:
 * vendor `i` serves attempts `[i × share, (i + 1) × share)` with
 * `share = ceil(attemptCap / chainLength)`, and the last vendor takes the
 * remainder (including attempts past the cap, which a released ceremony
 * binding can produce). Every vendor is reached whenever the cap is at least
 * the chain length; with one vendor every attempt stays on it.
 */
export function mapAttemptToVendor(
	attempt: number,
	chainLength: number,
	attemptCap: number,
): ProxyAttemptSlot {
	const flat = normalizeIndex(attempt);
	const vendors = Math.max(1, Math.floor(chainLength));
	if (vendors === 1) return { vendorIndex: 0, vendorAttempt: flat };
	const cap = Math.max(1, Math.floor(attemptCap));
	const share = Math.max(1, Math.ceil(cap / vendors));
	const vendorIndex = Math.min(vendors - 1, Math.floor(flat / share));
	return { vendorIndex, vendorAttempt: flat - vendorIndex * share };
}

/**
 * Default selector: static declaration order, even attempt split, the
 * policy's own session affinity and lifetime, and no memory of outcomes.
 */
export const staticOrderProxyVendorSelector: ProxyVendorSelector = {
	select(request) {
		if (request.chain.length === 0) return [];
		const slot = mapAttemptToVendor(request.attempt, request.chain.length, request.attemptCap);
		const session: ProxySessionDirective = {
			kind: isStickyProxyPolicy(request.policy) ? "sticky" : "rotating",
			...(request.policy.session?.lifetimeMinutes === undefined
				? {}
				: { lifetimeMinutes: request.policy.session.lifetimeMinutes }),
		};
		return request.chain.slice(slot.vendorIndex).map((vendor, offset) => ({
			vendor,
			// A vendor entered by resolution-time fallback starts at its first attempt.
			vendorAttempt: offset === 0 ? slot.vendorAttempt : 0,
			session,
		}));
	},
	report() {
		// The static selector keeps no state.
	},
};

let processSelector: ProxyVendorSelector = staticOrderProxyVendorSelector;

/** Selector in force for this process; `ProxyResolutionOptions.vendorSelector` overrides it per call. */
export function getProxyVendorSelector(): ProxyVendorSelector {
	return processSelector;
}

/** Register a selector for this process; `undefined` restores the static one. */
export function setProxyVendorSelector(selector: ProxyVendorSelector | undefined): void {
	processSelector = selector ?? staticOrderProxyVendorSelector;
}
