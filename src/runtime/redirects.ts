import { HttpRedirectError, TransportError } from "../errors.js";
import type { HttpRedirectFailureReason, HttpRedirectPolicy } from "../types.js";

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

const REDIRECT_POLICY_FIELDS = new Set(["mode", "maxHops"]);
export const MALFORMED_REDIRECT_TARGET = "[malformed redirect target]";

/** The transport a redirectPolicy belongs to: its name in diagnostics and its own hop limit. */
export interface RedirectPolicyTransport {
	readonly label: string;
	readonly maxHops: number;
}

export function invalidRedirectPolicy(
	transport: RedirectPolicyTransport,
	message: string,
	cause?: Error,
): TransportError {
	return new TransportError(`Invalid ${transport.label} redirectPolicy: ${message}`, {
		code: "http_redirect_policy_invalid",
		...(cause ? { cause } : {}),
	});
}

/** Snapshot untrusted caller input synchronously, before proxy resolution or fetch. */
export function normalizeRedirectPolicy(
	value: unknown,
	transport: RedirectPolicyTransport,
): HttpRedirectPolicy | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw invalidRedirectPolicy(transport, "expected an object");
	}

	try {
		const keys = Reflect.ownKeys(value);
		for (const key of keys) {
			if (typeof key !== "string" || !REDIRECT_POLICY_FIELDS.has(key)) {
				throw invalidRedirectPolicy(transport, `unknown field ${String(key)}`);
			}
		}
		for (const field of REDIRECT_POLICY_FIELDS) {
			const descriptor = Object.getOwnPropertyDescriptor(value, field);
			if (!descriptor || !("value" in descriptor)) {
				throw invalidRedirectPolicy(transport, `${field} must be an own data property`);
			}
		}

		const record = value as Record<string, unknown>;
		if (record.mode !== "same-origin") {
			throw invalidRedirectPolicy(transport, 'mode must be "same-origin"');
		}
		if (
			typeof record.maxHops !== "number" ||
			!Number.isInteger(record.maxHops) ||
			record.maxHops < 0 ||
			record.maxHops > transport.maxHops
		) {
			throw invalidRedirectPolicy(
				transport,
				`maxHops must be an integer from 0 to ${transport.maxHops}`,
			);
		}

		return { mode: "same-origin", maxHops: record.maxHops };
	} catch (error) {
		if (error instanceof TransportError) throw error;
		throw invalidRedirectPolicy(
			transport,
			"could not be inspected safely",
			error instanceof Error ? error : undefined,
		);
	}
}

export function redirectDiagnosticTarget(value: string): string {
	try {
		const parsed = new URL(value);
		// Origin omits URL userinfo. Keeping only origin + path makes diagnostics
		// useful while structurally excluding every query value and fragment,
		// including attacker-chosen keys the provider did not declare sensitive.
		const redactedQuery = parsed.search ? "?[REDACTED]" : "";
		return parsed.origin === "null"
			? `${parsed.protocol}<opaque-target>`
			: `${parsed.origin}${parsed.pathname}${redactedQuery}`;
	} catch {
		return MALFORMED_REDIRECT_TARGET;
	}
}

/**
 * One hop of a same-origin `redirectPolicy` walk, shared by ctx.http and
 * ctx.stealth so both follow and refuse identically: returns the next request
 * inside the initial origin, or throws the `HttpRedirectError` naming why the
 * walk stopped (cross-origin target, maxHops, loop, missing or malformed
 * Location) before any request leaves for that target.
 */
export function nextSameOriginRedirectHop<TMethod extends string>(input: {
	policy: HttpRedirectPolicy;
	initialOrigin: string;
	currentUrl: string;
	responseUrl: string;
	status: number;
	method: TMethod;
	location: string | undefined;
	followedHops: number;
	visitedRequests: ReadonlySet<string>;
}): { nextMethod: TMethod | "GET"; nextUrl: string } {
	let nextUrl: string | undefined;
	try {
		nextUrl = resolveRedirectUrl(input.location || undefined, input.responseUrl);
	} catch {
		const target = MALFORMED_REDIRECT_TARGET;
		throw new HttpRedirectError(`Redirect response has malformed Location target ${target}`, {
			reason: "missing_location",
			target,
			status: input.status,
		});
	}

	const decision = evaluateRedirectHop({
		status: input.status,
		method: input.method,
		nextUrl,
		shouldStop: nextUrl ? new URL(nextUrl).origin !== input.initialOrigin : false,
		redirectCount: input.followedHops + 1,
		maxHops: input.policy.maxHops,
		visitedRequests: input.visitedRequests,
	});
	if (decision.kind === "follow") {
		return { nextMethod: decision.nextMethod, nextUrl: decision.nextUrl };
	}
	const target = decision.nextUrl ? redirectDiagnosticTarget(decision.nextUrl) : undefined;
	const message = (() => {
		switch (decision.reason) {
			case "stopped":
				return `Redirect policy refused cross-origin target ${target}`;
			case "max_hops":
				return `Redirect policy reached maxHops before target ${target}`;
			case "loop":
				return `Redirect loop refused target ${target}`;
			case "missing_location":
				return `Redirect response from ${redirectDiagnosticTarget(input.currentUrl)} is missing Location`;
		}
	})();
	throw new HttpRedirectError(message, {
		reason: decision.reason,
		...(target ? { target } : {}),
		status: input.status,
	});
}
