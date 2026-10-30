// Internal to the SDK: no entry point re-exports this module. A provider
// declares its codes with `defineErrors`; only SDK-owned construction may
// carry a served category or retryability with the throw, and keeping the
// mark here (not on the public error module) is what stops provider code from
// laundering a per-throw value through it.
import { defineErrorBrand, hasOwnBrand, hasProviderErrorBrand } from "./error-brands.js";
import type { ProviderError, SdkErrorContract, SdkErrorOptions } from "./errors.js";
import type { ProviderFailureCategory } from "./observability.js";
import type { PlatformFault } from "./sdk-issued-errors.js";

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

// The construction refusal (`new ProviderError(message, { code, category |
// retryable })`) happens inside the provider's own copy of this SDK, which
// under `apifuse dev` (server from src/*, provider on dist/*) or a dual
// install is not the serving copy. A module-scoped record (the WeakMap behind
// `issueSdkError`) cannot cross that split, so the refusal carries its fault
// as an own `Symbol.for` brand, read by the server through an own-descriptor
// check like every other SDK kind brand.
const PER_THROW_OPTIONS_RETIRED_BRAND = Symbol.for(
	"@apifuse/provider-sdk/error-kind/per-throw-options-retired@1",
);

/** The code the refusal is thrown and served under. @internal */
export const PER_THROW_ERROR_OPTIONS_RETIRED_CODE = "PER_THROW_ERROR_OPTIONS_RETIRED";

/**
 * The platform fault every SDK copy serves the refusal as: a provider defect
 * the SDK detected, like OUTPUT_VALIDATION_FAILED.
 * @internal
 */
export const PER_THROW_ERROR_OPTIONS_RETIRED_FAULT: PlatformFault = {
	category: "internal_error",
	code: PER_THROW_ERROR_OPTIONS_RETIRED_CODE,
	status: 500,
	retryable: false,
};

/** @internal */
export function brandPerThrowOptionsRetiredError(target: object): void {
	defineErrorBrand(target, PER_THROW_OPTIONS_RETIRED_BRAND, true);
}

/** Whether `value` is the construction refusal of any SDK copy. @internal */
export function isPerThrowOptionsRetiredError(value: unknown): boolean {
	return hasProviderErrorBrand(value) && hasOwnBrand(value, PER_THROW_OPTIONS_RETIRED_BRAND, true);
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
