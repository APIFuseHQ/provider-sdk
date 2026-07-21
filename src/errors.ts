import type { ProviderErrorCategory } from "./observability.js";

// Versioned, cross-realm brands. `Symbol.for` resolves to the same symbol in
// any copy/entrypoint of this SDK major version, so an error created by a
// duplicate module instance (e.g. the packaged CLI's src/* server vs a
// provider's dist/* import) still carries a brand the server can recognize even
// though `instanceof` splits across the two constructors. The `@1` suffix lets a
// future breaking change to this contract mint a distinct key.
const PROVIDER_ERROR_BRAND = Symbol.for("@apifuse/provider-sdk/error-brand@1");
const PROVIDER_ERROR_BRAND_VALUE = 1;
const SESSION_EXPIRED_BRAND = Symbol.for("@apifuse/provider-sdk/error-kind/session-expired@1");
const TRANSPORT_BRAND = Symbol.for("@apifuse/provider-sdk/error-kind/transport@1");

// Defines a non-enumerable, non-writable, non-configurable own data property.
// Immutable + own means a guard can trust it via a single descriptor read
// without invoking attacker-controlled getters or accepting inherited brands.
function defineErrorBrand(target: object, brand: symbol, value: number | true): void {
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
function hasOwnBrand(value: unknown, brand: symbol, expected: number | true): boolean {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) {
		return false;
	}
	const descriptor = Object.getOwnPropertyDescriptor(value, brand);
	return (
		descriptor !== undefined && Object.hasOwn(descriptor, "value") && descriptor.value === expected
	);
}

export type ProviderErrorOptions = {
	fix?: string;
	code?: string;
	details?: unknown;
	cause?: Error;
	category?: ProviderErrorCategory;
	retryable?: boolean;
};

export class ProviderError extends Error {
	constructor(
		message: string,
		public readonly options?: ProviderErrorOptions,
	) {
		super(message);
		this.name = "ProviderError";
		if (options?.cause) {
			this.cause = options.cause;
		}
		defineErrorBrand(this, PROVIDER_ERROR_BRAND, PROVIDER_ERROR_BRAND_VALUE);
	}

	get fix(): string | undefined {
		return this.options?.fix;
	}

	get code(): string | undefined {
		return this.options?.code;
	}

	get details(): unknown {
		return this.options?.details;
	}
}

export class SDKError extends ProviderError {
	constructor(message: string, options?: ProviderErrorOptions) {
		super(message, options);
		this.name = "SDKError";
	}
}

export class AuthError extends ProviderError {
	constructor(message: string, options?: ProviderErrorOptions) {
		super(message, options);
		this.name = "AuthError";
	}
}

export class SessionExpiredError extends AuthError {
	constructor(message = "Provider session expired", options?: ProviderErrorOptions) {
		super(message, {
			code: "reauth_required",
			category: "credential_expired",
			retryable: false,
			...options,
		});
		this.name = "SessionExpiredError";
		defineErrorBrand(this, SESSION_EXPIRED_BRAND, true);
	}
}

export type ValidationErrorOptions = ProviderErrorOptions & {
	zodError?: unknown;
};

export class ValidationError extends ProviderError {
	readonly zodError?: unknown;

	constructor(message: string, options?: ValidationErrorOptions) {
		super(message, options);
		this.name = "ValidationError";
		this.zodError = options?.zodError;
	}
}

export type TransportErrorOptions = ProviderErrorOptions & {
	status?: number;
	upstreamStatus?: number;
};

export class TransportError extends ProviderError {
	readonly status?: number;
	readonly upstreamStatus?: number;

	constructor(message: string, options?: TransportErrorOptions) {
		super(message, options);
		this.name = "TransportError";
		this.status = options?.status;
		this.upstreamStatus = options?.upstreamStatus ?? options?.status;
		defineErrorBrand(this, TRANSPORT_BRAND, true);
	}
}

// Cross-module type guards. Prefer these over `instanceof` at any boundary that
// may receive an error from a different copy/entrypoint of the SDK (see the HTTP
// server error boundary). They recognize branded errors regardless of which
// module instance constructed them, while rejecting unbranded lookalikes.
export function isProviderError(value: unknown): value is ProviderError {
	return hasOwnBrand(value, PROVIDER_ERROR_BRAND, PROVIDER_ERROR_BRAND_VALUE);
}

export function isSessionExpiredError(value: unknown): value is SessionExpiredError {
	return isProviderError(value) && hasOwnBrand(value, SESSION_EXPIRED_BRAND, true);
}

export function isTransportError(value: unknown): value is TransportError {
	return isProviderError(value) && hasOwnBrand(value, TRANSPORT_BRAND, true);
}

export class ProviderSecretError extends ProviderError {
	constructor(message: string, options?: ProviderErrorOptions) {
		super(message, { code: "provider_secret_error", ...options });
		this.name = "ProviderSecretError";
	}
}

export class CredentialKeyError extends ProviderError {
	constructor(message: string, options?: ProviderErrorOptions) {
		super(message, { code: "credential_key_error", ...options });
		this.name = "CredentialKeyError";
	}
}

export class CredentialModeError extends ProviderError {
	constructor(message: string, options?: ProviderErrorOptions) {
		super(message, { code: "credential_mode_error", ...options });
		this.name = "CredentialModeError";
	}
}

export class FlowExpiredError extends ProviderError {
	constructor(message: string, options?: ProviderErrorOptions) {
		super(message, { code: "flow_expired", ...options });
		this.name = "FlowExpiredError";
	}
}

export class TurnValidationError extends ProviderError {
	constructor(message: string, options?: ProviderErrorOptions) {
		super(message, { code: "turn_validation_error", ...options });
		this.name = "TurnValidationError";
	}
}

export class ContextAccessError extends ProviderError {
	constructor(message: string, options?: ProviderErrorOptions) {
		super(message, { code: "context_access_error", ...options });
		this.name = "ContextAccessError";
	}
}
