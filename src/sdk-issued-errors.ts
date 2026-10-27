// Internal to the SDK: no entry point re-exports this module.
//
// The serve error path gives a failure a platform-owned outcome (an APIFuse
// code, category or source the provider does not choose) only for an error
// the SDK created itself. It never decides that from the error's class, name,
// code or any other property: the classes are public and every property can
// be reproduced, so provider code could produce the same values. It decides
// from this record of the objects the SDK issued, which only SDK code can add
// to, so an error a provider constructs is never in it, whatever it carries.
import type { PlatformFaultCategory } from "./observability.js";

/**
 * A fault the platform observed itself and reports under origin `platform`:
 * the category and code it is served as, the HTTP status, whether an
 * identical retry can succeed, and the failure that caused it. Only this
 * module records one, against the error object the SDK throws for it; the
 * serve layer reads the record, never the error's options, for these values.
 */
export type PlatformFault = {
	readonly category: PlatformFaultCategory;
	readonly code: string;
	readonly status: number;
	readonly retryable: boolean;
	readonly cause?: unknown;
};

const sdkIssuedErrors = new WeakSet<object>();
const platformFaults = new WeakMap<object, PlatformFault>();

/**
 * Records `error` as created by the SDK and returns it. With `fault`, also
 * records the platform fault the error stands for.
 */
export function issueSdkError<T extends object>(error: T, fault?: PlatformFault): T {
	sdkIssuedErrors.add(error);
	if (fault !== undefined) {
		platformFaults.set(error, fault);
	}
	return error;
}

/**
 * Whether this very object was created by the SDK through `issueSdkError`.
 * A copy, a subclass instance or a look-alike a provider built is not.
 */
export function isSdkIssuedError(error: unknown): boolean {
	return (
		error !== null &&
		(typeof error === "object" || typeof error === "function") &&
		sdkIssuedErrors.has(error)
	);
}

/**
 * The platform fault recorded for this very object by `issueSdkError`, or
 * `undefined` for an object the SDK did not issue as one.
 */
export function platformFaultOf(error: unknown): PlatformFault | undefined {
	if (error === null || (typeof error !== "object" && typeof error !== "function")) {
		return undefined;
	}
	return platformFaults.get(error);
}
