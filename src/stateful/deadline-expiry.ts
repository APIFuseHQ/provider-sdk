// Internal to the SDK: not re-exported from the stateful entry point.
import { StatefulRoutingDeadlineError } from "./errors.js";

const DEADLINE_EXPIRED_CODE = "STATEFUL_FORWARDING_DEADLINE_EXPIRED";

type DeadlineAbortReasonName = "AbortError" | "TimeoutError";

function statefulDeadlineAbortMessage(requestId: string): string {
	return `Stateful operation request ${requestId} deadline has expired.`;
}

/**
 * The reason a stateful request's deadline aborts its signal with. It is a
 * fresh object per request, and its message names the request, so a failure
 * can be traced back to that exact deadline (`errorCauseChainCarriesDeadline`).
 * The name is the one the replaced signal used to carry: `AbortError` for the
 * router's reason-less `abort()`, `TimeoutError` for the owner route's
 * `AbortSignal.timeout`, so code that inspects the name of an abort reason
 * treats it exactly as before.
 */
export function statefulDeadlineAbortReason(
	requestId: string,
	name: DeadlineAbortReasonName,
): DOMException {
	return new DOMException(statefulDeadlineAbortMessage(requestId), name);
}

/**
 * A signal that aborts with `reason` after `delayMs`, on the same timer
 * `AbortSignal.timeout` uses, so nothing needs to be cleared when the request
 * finishes first.
 */
export function deadlineSignalWithReason(delayMs: number, reason: DOMException): AbortSignal {
	const controller = new AbortController();
	AbortSignal.timeout(delayMs).addEventListener("abort", () => controller.abort(reason), {
		once: true,
	});
	return controller.signal;
}

function readStringProperty(value: object, key: "name" | "message"): string | undefined {
	try {
		const property: unknown = Reflect.get(value, key);
		return typeof property === "string" ? property : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether `error` or one of its first `cause` links is this request's
 * deadline abort reason. The reason object itself matches by identity. A
 * redacted copy of it matches too: ctx.http and ctx.stealth redact a failure
 * when the request declared sensitive values, and the redaction replaces each
 * cause with a clone (a `DOMException` is rebuilt from its message and name).
 * The copy is recognized by the reason's own name and by the message that
 * names this request, so another request's deadline or a provider's own abort
 * never matches.
 */
export function errorCauseChainCarriesDeadline(
	error: unknown,
	reason: unknown,
	requestId: string,
): boolean {
	if (reason === null || typeof reason !== "object") return false;
	const reasonName = readStringProperty(reason, "name");
	const reasonMessage = readStringProperty(reason, "message");
	const recognizable =
		reasonName !== undefined && reasonMessage === statefulDeadlineAbortMessage(requestId);
	const seen = new Set<object>();
	let current = error;
	for (let depth = 0; depth < 5; depth++) {
		if (current === reason) return true;
		if (current === null || (typeof current !== "object" && typeof current !== "function")) {
			return false;
		}
		if (
			recognizable &&
			readStringProperty(current, "name") === reasonName &&
			readStringProperty(current, "message") === reasonMessage
		) {
			return true;
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
		deadlineSignal.aborted &&
		errorCauseChainCarriesDeadline(error, deadlineSignal.reason, request.requestId);
	const ownerReportedDeadline = ownErrorCode(error) === DEADLINE_EXPIRED_CODE;
	if (!abortedByDeadline && !ownerReportedDeadline) return error;
	return statefulRoutingDeadlineErrorCausedBy(request.requestId, request.deadlineAt, error);
}
