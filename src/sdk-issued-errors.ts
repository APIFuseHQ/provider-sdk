// Internal to the SDK: no entry point re-exports this module.
//
// The serve error path gives a failure a platform-owned outcome (an APIFuse
// code, category or source the provider does not choose) only for an error
// the SDK created itself. It never decides that from the error's class, name,
// code or any other property: the classes are public and every property can
// be reproduced, so provider code could produce the same values. It decides
// from this record of the objects the SDK issued, which only SDK code can add
// to, so an error a provider constructs is never in it, whatever it carries.
const sdkIssuedErrors = new WeakSet<object>();

/** Records `error` as created by the SDK and returns it. */
export function issueSdkError<T extends object>(error: T): T {
	sdkIssuedErrors.add(error);
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
