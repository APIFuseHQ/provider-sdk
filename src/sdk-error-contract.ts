// Internal to the SDK: no entry point re-exports this module. A provider
// declares its codes with `defineErrors`; only SDK-owned construction may
// carry a served category or retryability with the throw, and keeping the
// mark here (not on the public error module) is what stops provider code from
// laundering a per-throw value through it.
import { defineErrorBrand, hasOwnBrand, hasProviderErrorBrand } from "./error-brands.js";
import type { ProviderError, SdkErrorContract, SdkErrorOptions } from "./errors.js";
import type { ProviderFailureCategory } from "./observability.js";

// Marks an options object built by the SDK's own error constructors (transport,
// session expiry, secrets, output validation, ...): those carry their served
// category and retryability with the throw because no provider declaration
// describes them. A provider throw never carries this mark, so its category
// and retryability come from its `defineErrors` declaration alone.
const SDK_ERROR_CONTRACT_BRAND = Symbol.for("@apifuse/provider-sdk/error-contract@1");

/**
 * Marks `options` as SDK-constructed so `ProviderError` accepts the category
 * and retryability it carries. The mark is an own non-enumerable property, so
 * a spread of these options into a new object drops it (and the new object is
 * then refused like any provider options object). The contract fields are read
 * back through {@link sdkErrorContractOf}, so the returned type leaves them out
 * and the options fit a provider-facing constructor input.
 * @internal
 */
export function sdkErrorOptions<T extends SdkErrorOptions>(
	options: T,
): Omit<T, keyof SdkErrorContract> {
	defineErrorBrand(options, SDK_ERROR_CONTRACT_BRAND, true);
	return options;
}

/** @internal */
export function hasSdkErrorContractBrand(options: unknown): boolean {
	return hasOwnBrand(options, SDK_ERROR_CONTRACT_BRAND, true);
}

/**
 * The category and retryability an SDK-constructed error carries, or an empty
 * contract for a provider-thrown error (whose declaration is the only source).
 * Reads own data properties only, like the brand guards: the error's `options`
 * may come from another SDK copy.
 * @internal
 */
export function sdkErrorContractOf(error: unknown): SdkErrorContract {
	if (!hasProviderErrorBrand(error)) return {};
	let options: unknown;
	try {
		options = (error as ProviderError).options;
	} catch {
		return {};
	}
	if (!hasSdkErrorContractBrand(options)) return {};
	const record = options as Record<string, unknown>;
	const category = Object.getOwnPropertyDescriptor(record, "category")?.value;
	const retryable = Object.getOwnPropertyDescriptor(record, "retryable")?.value;
	return {
		...(typeof category === "string" ? { category: category as ProviderFailureCategory } : {}),
		...(typeof retryable === "boolean" ? { retryable } : {}),
	};
}
