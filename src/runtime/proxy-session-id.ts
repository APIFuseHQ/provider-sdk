import { createHash, randomBytes } from "node:crypto";

import type { ProviderProxyPolicy } from "../types.js";

/**
 * Length of the vendor session id the SDK mints. Both gateways accept `[a-z0-9]`
 * ids of this length (NodeMaven `-sid-<id>`, smartproxy `session-<id>`), and ten
 * hex digits of a SHA-256 digest keep sticky ids distinct across affinity keys.
 */
export const PROXY_SESSION_ID_LENGTH = 10;

/** `affinity: "request"` (the default) rotates; every other affinity is sticky. */
export function isStickyProxyPolicy(policy: ProviderProxyPolicy): boolean {
	return (policy.session?.affinity ?? "request") !== "request";
}

export type ProxySessionWindow = {
	/** `floor(now / lifetime)`: every process derives the same epoch for the same instant. */
	readonly windowEpoch: number;
	/** Hard end of the window, ISO 8601. */
	readonly expiresAt: string;
};

/**
 * Wall-clock window a sticky session lives in. The epoch is shared by every
 * process that serves the same affinity, so they derive the same session id
 * without shared storage, and the window end is the sticky expiry the native
 * drain contract reports.
 */
export function proxySessionWindow(lifetimeMinutes: number, now = Date.now()): ProxySessionWindow {
	const lifetimeMs = Math.max(1, Math.floor(lifetimeMinutes)) * 60_000;
	const windowEpoch = Math.floor(now / lifetimeMs);
	return {
		windowEpoch,
		expiresAt: new Date((windowEpoch + 1) * lifetimeMs).toISOString(),
	};
}

/** How a vendor adapter must mint the session for one attempt (chosen by the vendor selector). */
export type ProxySessionDirective = {
	/**
	 * `sticky`: the id is `sid(affinityKey, window, vendorAttempt)`, shared by
	 * every process in the same window. `rotating`: a random id per attempt.
	 */
	readonly kind: "sticky" | "rotating";
	/**
	 * Requested session lifetime in whole minutes, before the vendor's clamp.
	 * Undefined means the policy's `session.lifetimeMinutes` or the platform default.
	 */
	readonly lifetimeMinutes?: number;
};

export type ProxySessionIdInput = {
	readonly sticky: boolean;
	readonly affinityKey: string | undefined;
	readonly windowEpoch: number;
	/**
	 * Zero-based attempt within the vendor's share of the request's attempt
	 * budget. Each attempt derives a different sticky id, so a retry leaves the
	 * egress IP that failed; attempt 0 of the next request returns to the
	 * affinity's own id.
	 */
	readonly attempt: number;
};

/**
 * A sticky session id is deterministic from the affinity key, the session
 * window and the attempt, so every process serving the same connection in
 * the same window derives the same egress IP without shared storage. A
 * rotating session id is random per call (a fresh egress IP per attempt).
 *
 * The sticky digest input is `<affinityKey>:<windowEpoch>:<attempt>`; attempt
 * 0 reproduces the id the NodeMaven adapter derived before the pool index was
 * retired, so existing sticky NodeMaven sessions keep their egress.
 */
export function deriveProxySessionId(input: ProxySessionIdInput): string {
	if (!input.sticky || !input.affinityKey) {
		return randomBytes(PROXY_SESSION_ID_LENGTH).toString("hex").slice(0, PROXY_SESSION_ID_LENGTH);
	}
	const attempt = Number.isFinite(input.attempt) ? Math.max(0, Math.floor(input.attempt)) : 0;
	const digest = createHash("sha256")
		.update(`${input.affinityKey}:${input.windowEpoch}:${attempt}`)
		.digest("hex");
	// hex digits are a subset of the [a-z0-9] id charset both gateways accept.
	return digest.slice(0, PROXY_SESSION_ID_LENGTH);
}
