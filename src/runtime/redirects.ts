import type { HttpRedirectFailureReason } from "../types.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type RedirectHopDecision<TMethod extends string> =
	| {
			kind: "follow";
			nextMethod: TMethod | "GET";
			nextUrl: string;
	  }
	| {
			kind: "stop";
			reason: HttpRedirectFailureReason;
			nextUrl?: string;
	  };

export function isRedirectStatus(status: number): boolean {
	return REDIRECT_STATUSES.has(status);
}

/** Shared fetch-compatible redirect method rewriting for stealth and ctx.http. */
export function nextRedirectMethod<TMethod extends string>(
	status: number,
	method: TMethod,
): TMethod | "GET" {
	if (status === 303 && method !== "HEAD") return "GET";
	if ((status === 301 || status === 302) && method === "POST") return "GET";
	return method;
}

/** Resolves a Location value against the response URL without issuing a request. */
export function resolveRedirectUrl(
	location: string | undefined,
	responseUrl: string,
): string | undefined {
	return location ? new URL(location, responseUrl).toString() : undefined;
}

/**
 * Shared post-response decision ordering for both redirect walkers. The
 * caller-owned stop hook is checked first, matching stealth's pre-follow
 * contract, then structural termination and loop checks run before follow.
 */
export function evaluateRedirectHop<TMethod extends string>(input: {
	status: number;
	method: TMethod;
	nextUrl: string | undefined;
	shouldStop: boolean;
	redirectCount: number;
	maxHops: number;
	visitedRequests: ReadonlySet<string>;
}): RedirectHopDecision<TMethod> {
	if (input.shouldStop) {
		return { kind: "stop", reason: "stopped", ...(input.nextUrl ? { nextUrl: input.nextUrl } : {}) };
	}
	if (!input.nextUrl) return { kind: "stop", reason: "missing_location" };
	if (input.redirectCount > input.maxHops) {
		return { kind: "stop", reason: "max_hops", nextUrl: input.nextUrl };
	}

	const nextMethod = nextRedirectMethod(input.status, input.method);
	if (input.visitedRequests.has(`${nextMethod} ${input.nextUrl}`)) {
		return { kind: "stop", reason: "loop", nextUrl: input.nextUrl };
	}
	return { kind: "follow", nextMethod, nextUrl: input.nextUrl };
}
