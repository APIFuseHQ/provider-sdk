// Internal to the SDK: not re-exported from the stateful entry point.
import { StatefulRoutingDeadlineError } from "./errors.js";

const DEADLINE_EXPIRED_CODE = "STATEFUL_FORWARDING_DEADLINE_EXPIRED";

/**
 * The reason a stateful request's deadline timer aborts its signal with. It is
 * a fresh object per request so a failure can be traced back to that exact
 * timer by identity (`errorCauseChainIncludes`), and it keeps the `AbortError`
 * name of a reason-less `abort()` so code that inspects the name of an abort
 * reason treats it exactly as before.
 */
export function statefulDeadlineAbortReason(requestId: string): DOMException {
	return new DOMException(
		`Stateful operation request ${requestId} deadline has expired.`,
		"AbortError",
	);
}

/** Whether `target` is `error` or one of its first `cause` links, by identity. */
export function errorCauseChainIncludes(error: unknown, target: unknown): boolean {
	if (target === null || typeof target !== "object") return false;
	const seen = new Set<object>();
	let current = error;
	for (let depth = 0; depth < 5; depth++) {
		if (current === target) return true;
		if (current === null || (typeof current !== "object" && typeof current !== "function")) {
			return false;
		}
		if (seen.has(current)) return false;
		seen.add(current);
		let cause: PropertyDescriptor | undefined;
		try {
			cause = Object.getOwnPropertyDescriptor(current, "cause");
		} catch {
			return false;
		}
		if (!cause || !Object.hasOwn(cause, "value")) return false;
		current = cause.value;
	}
	return false;
}

/**
 * A StatefulRoutingDeadlineError that keeps the failure the deadline produced
 * as its `cause`, attached like a native `{ cause }` option so the logged cause
 * chain still shows what was cancelled. The public constructor stays unchanged.
 */
export function statefulRoutingDeadlineErrorCausedBy(
	requestId: string,
	deadlineAt: string,
	cause: unknown,
): StatefulRoutingDeadlineError {
	const expiry = new StatefulRoutingDeadlineError(requestId, deadlineAt);
	Object.defineProperty(expiry, "cause", {
		value: cause,
		writable: true,
		configurable: true,
		enumerable: false,
	});
	return expiry;
}

function ownErrorCode(error: unknown): unknown {
	if (error === null || typeof error !== "object") return undefined;
	try {
		const code = Object.getOwnPropertyDescriptor(error, "code");
		return code && Object.hasOwn(code, "value") ? code.value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The source pod's deadline timer aborts the forwarding request at
 * `deadlineAt`, the same instant the owner pod's own deadline starts producing
 * its 504, so the owner's answer usually never arrives: the forwarder reports
 * its own aborted request (`STATEFUL_FORWARDING_REQUEST_FAILED`), with the
 * timer's abort reason as the cause. When the owner's 504 does arrive first
 * (for example, its clock runs ahead), the forwarder relays the owner's
 * `STATEFUL_FORWARDING_DEADLINE_EXPIRED` code instead. Both are this
 * request's deadline expiring, so both become the StatefulRoutingDeadlineError
 * the router already throws for a deadline that expired before routing, with
 * the forwarding failure as its cause. Any other forwarding failure, such as
 * an unreachable owner or a broken connection, keeps its own error.
 */
export function forwardingDeadlineExpiryOrSelf(
	error: unknown,
	request: { readonly requestId: string; readonly deadlineAt?: string },
	deadlineSignal: AbortSignal,
): unknown {
	if (request.deadlineAt === undefined || error instanceof StatefulRoutingDeadlineError) {
		return error;
	}
	const abortedByDeadline =
		deadlineSignal.aborted && errorCauseChainIncludes(error, deadlineSignal.reason);
	const ownerReportedDeadline = ownErrorCode(error) === DEADLINE_EXPIRED_CODE;
	if (!abortedByDeadline && !ownerReportedDeadline) return error;
	return statefulRoutingDeadlineErrorCausedBy(request.requestId, request.deadlineAt, error);
}
