// Versioned, cross-realm brands. `Symbol.for` resolves to the same symbol in
// any copy/entrypoint of this SDK major version, so an error created by a
// duplicate module instance (e.g. the packaged CLI's src/* server vs a
// provider's dist/* import) still carries a brand the server can recognize even
// though `instanceof` splits across the two constructors. The `@1` suffix lets a
// future breaking change to this contract mint a distinct key.
export const PROVIDER_ERROR_BRAND = Symbol.for("@apifuse/provider-sdk/error-brand@1");
export const PROVIDER_ERROR_BRAND_VALUE = 1;

// Defines a non-enumerable, non-writable, non-configurable own data property.
// Immutable + own means a guard can trust it via a single descriptor read
// without invoking attacker-controlled getters or accepting inherited brands.
export function defineErrorBrand(target: object, brand: symbol, value: number | true): void {
	Object.defineProperty(target, brand, {
		value,
		enumerable: false,
		writable: false,
		configurable: false,
	});
}

// Recognizes an own data-property brand with the expected value. Rejects
// missing brands (unbranded lookalikes), accessor brands (no own `value`
// slot — the getter is never called), and inherited brands (own-descriptor
// lookup returns undefined on the child).
export function hasOwnBrand(value: unknown, brand: symbol, expected: number | true): boolean {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) {
		return false;
	}
	const descriptor = Object.getOwnPropertyDescriptor(value, brand);
	return (
		descriptor !== undefined && Object.hasOwn(descriptor, "value") && descriptor.value === expected
	);
}

/** Whether `value` carries the provider-error brand (any SDK copy's `ProviderError`). */
export function hasProviderErrorBrand(value: unknown): boolean {
	return hasOwnBrand(value, PROVIDER_ERROR_BRAND, PROVIDER_ERROR_BRAND_VALUE);
}
