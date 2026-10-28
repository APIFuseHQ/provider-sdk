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

/** One earlier transport attempt of the same request, as the transport saw it. */
export type ProxyAttemptRecord = {
	readonly vendor: ProxyVendorName;
	readonly outcome: "ok" | "error";
	/** Transport error code of a failed attempt, when one was classified. */
	readonly errorCode?: string;
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
	/**
	 * Identifier the transport gives one request; every attempt of its retry loop
	 * and every outcome it reports carry the same value. Absent when the caller
	 * resolves outside a transport retry loop.
	 */
	readonly requestId?: string;
	/**
	 * Transport outcomes of this request's earlier attempts, oldest first. A
	 * selector can use it to leave a vendor that already failed in this request.
	 */
	readonly history?: readonly ProxyAttemptRecord[];
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
	/** The `requestId` of the attempt request this outcome belongs to, when it had one. */
	readonly requestId?: string;
};

export interface ProxyVendorSelector {
	/**
	 * Vendors to try for one attempt, in order. The first directive is the
	 * attempt's vendor; the rest are resolution-time fallbacks the resolver
	 * moves to when that vendor cannot synthesize (no credentials, unsupported
	 * protocol, adapter error). An empty list resolves no vendor.
	 */
	select(request: ProxyAttemptRequest): readonly ProxyVendorDirective[];
	/**
	 * Attempt result fed back from the resolver and the transports. Outcomes go
	 * to the selector instance that served `select` for the attempt (the one
	 * passed as `ProxyResolutionOptions.vendorSelector`, else the process
	 * selector at the start of the request).
	 */
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
 * vendor `i` starts at attempt `ceil(i × cap / chainLength)` and serves until
 * the next vendor's start; the last vendor takes the remainder (including
 * attempts past the cap, which a released ceremony binding can produce). With
 * two vendors this is a share of `ceil(cap / 2)` attempts for the first. Every
 * vendor is reached whenever the cap is at least the chain length (a smaller
 * cap counts as the chain length, one attempt per vendor); with one vendor
 * every attempt stays on it.
 */
export function mapAttemptToVendor(
	attempt: number,
	chainLength: number,
	attemptCap: number,
): ProxyAttemptSlot {
	const flat = normalizeIndex(attempt);
	const vendors = Math.max(1, Math.floor(chainLength));
	if (vendors === 1) return { vendorIndex: 0, vendorAttempt: flat };
	const cap = Number.isFinite(attemptCap) ? Math.floor(attemptCap) : vendors;
	const budget = Math.max(vendors, cap);
	const start = (index: number) => Math.ceil((index * budget) / vendors);
	let vendorIndex = 0;
	while (vendorIndex + 1 < vendors && start(vendorIndex + 1) <= flat) vendorIndex += 1;
	return { vendorIndex, vendorAttempt: flat - start(vendorIndex) };
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
		// Attempts each vendor already served in this request. A vendor entered by
		// resolution-time fallback (the one before it had no credentials or could not
		// synthesize) continues after them, so a retry leaves the sticky session that
		// just failed instead of deriving it again; the attempt's own vendor does the
		// same once fallbacks have already used its first sessions.
		const served = new Map<ProxyVendorName, number>();
		for (const record of request.history ?? []) {
			served.set(record.vendor, (served.get(record.vendor) ?? 0) + 1);
		}
		return request.chain.slice(slot.vendorIndex).map((vendor, offset) => ({
			vendor,
			vendorAttempt: Math.max(offset === 0 ? slot.vendorAttempt : 0, served.get(vendor) ?? 0),
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
