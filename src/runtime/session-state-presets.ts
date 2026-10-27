import type { ProviderSessionState, ResponseMatcher, SessionStateDuration } from "../types.js";
import { SESSION_STATE_DEFAULTS } from "./session-state-defaults.js";

/**
 * A block page an edge renders itself: 403, `server: cloudflare`, a `cf-ray`
 * header, an HTML body carrying the bot-management bootstrap path or the RayID
 * row. Every block page recorded against a KR travel upstream in October 2026
 * matched it.
 */
export const CLOUDFLARE_BLOCK_PAGE: ResponseMatcher = {
	status: 403,
	headers: { server: "cloudflare", "cf-ray": true, "content-type": { pattern: "^text/html" } },
	bodyIncludes: ["/cdn-cgi/challenge-platform/", "RayID"],
};

/** Options of `sessionStatePresets.cloudflareBlockPage`. */
export interface CloudflareBlockPageOptions {
	/** Hosts the cookie is carried to. Each must be in `allowedHosts`. */
	readonly hosts: readonly string[];
	/** Operation ids in scope. Omitted: every operation. */
	readonly operations?: readonly string[];
	readonly ttl?: SessionStateDuration;
	readonly idleTtl?: SessionStateDuration;
	readonly maxUses?: number;
	/** Requests per second assigned to one cookie; omitted, one cookie carries every request. */
	readonly qps?: number;
	readonly maxConcurrent?: number;
	/** Re-acquisitions one request absorbs. Default `SESSION_STATE_DEFAULTS.presetReacquire`. */
	readonly reacquire?: number;
}

/**
 * Session-state declarations the SDK knows by name. Each preset returns a plain
 * `ProviderSessionState`; a provider can spread it and override any field, and a
 * declaration written by hand with the same values behaves identically.
 */
export const sessionStatePresets = {
	/**
	 * The anonymous bot-management cookie an edge issues on its own block page and
	 * on served responses. Passive acquisition: the first in-scope request
	 * receives the block page and the cookie, the SDK keeps the cookie and
	 * re-sends the request once carrying it; later requests carry it from the start.
	 */
	cloudflareBlockPage(options: CloudflareBlockPageOptions): ProviderSessionState {
		const { hosts, operations, ttl, idleTtl, maxUses, qps, maxConcurrent, reacquire } = options;
		return {
			acquire: { from: "response", capture: { cookies: ["__cf_bm"] } },
			carry: { as: "cookies" },
			validity: {
				...(ttl === undefined ? {} : { ttl }),
				...(idleTtl === undefined ? {} : { idleTtl }),
				...(maxUses === undefined ? {} : { maxUses }),
				invalidWhen: CLOUDFLARE_BLOCK_PAGE,
				reacquire: reacquire ?? SESSION_STATE_DEFAULTS.presetReacquire,
			},
			distribute: {
				hosts: [...hosts],
				...(operations === undefined ? {} : { operations: [...operations] }),
				...(qps === undefined ? {} : { qps }),
				...(maxConcurrent === undefined ? {} : { maxConcurrent }),
			},
		};
	},
} as const;
