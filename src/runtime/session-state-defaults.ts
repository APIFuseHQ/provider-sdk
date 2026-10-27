import type { HttpMethod } from "../types.js";

/**
 * SDK defaults of the session-state layer, in one place. The values marked
 * "Proposal (decision pending)" are proposals awaiting the owner's answer;
 * when an answer differs, change the value here and nowhere else.
 */
export const SESSION_STATE_DEFAULTS = {
	/** Re-acquisitions a preset declaration absorbs per request. Proposal (decision pending). */
	presetReacquire: 1,
	/** Re-acquisitions a direct declaration absorbs per request when `validity.reacquire` is omitted. Proposal (decision pending). */
	reacquire: 0,
	/** Methods re-sent after a re-acquisition when `validity.replayMethods` is omitted: the SDK safe set (ADR-0008 D10). */
	replayMethods: ["GET", "HEAD", "OPTIONS"] as readonly HttpMethod[],
	/** Connection-scoped pools one declaration keeps before the least recently used is dropped. Proposal (decision pending). */
	maxConnectionPools: 1_000,
	/** Window over which `distribute.qps` is measured, in milliseconds. */
	qpsWindowMs: 1_000,
} as const;
