import type { ProviderErrorCategory } from "./observability.js";
import type { HttpRedirectFailureReason } from "./types.js";

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
const VALIDATION_BRAND = Symbol.for("@apifuse/provider-sdk/error-kind/validation@1");

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
	/** Provider-authored, bounded metadata safe for operational logs and error headers. */
	observability?: ProviderErrorObservability;
};

/**
 * Provider-authored error diagnostics whose runtime values are validated before emission.
 * Classification tokens such as `reason` are source literals, not runtime user input or
 * credentials. The gateway removes the observability header from tenant responses.
 */
export type ProviderErrorObservability = {
	/** A 1-64 character `[A-Za-z0-9_.-]` classification token, for example `LOGIN_COMPLETE_FAILED`. */
	reason?: string;
	/** A provider-computed 12-hex-character fingerprint of private diagnostic input. */
	fingerprint?: string;
	/** The non-negative length of the private diagnostic input, capped at 10,000,000. */
	messageLength?: number;
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

/** Raised when the remote provider engine speaks an incompatible protocol version. */
export class ProviderEngineProtocolVersionError extends SDKError {
	constructor(
		public readonly receivedVersion: unknown,
		public readonly expectedVersion: string,
	) {
		super(
			`Provider engine protocol version mismatch: expected ${expectedVersion}, received ${String(receivedVersion)}`,
			{
				code: "PROVIDER_ENGINE_PROTOCOL_VERSION_MISMATCH",
				details: { receivedVersion, expectedVersion },
				fix: "Update @apifuse/provider-sdk or use a compatible APIFuse provider engine.",
			},
		);
		this.name = "ProviderEngineProtocolVersionError";
	}
}

/** Raised when the remote provider engine rejects a workspace API key. */
export class ProviderEngineAuthenticationError extends SDKError {
	constructor(message = "Provider engine authentication failed", options?: ProviderErrorOptions) {
		super(message, {
			code: "PROVIDER_ENGINE_AUTHENTICATION_FAILED",
			fix: "Set APIFUSE__ENGINE__API_KEY to the workspace API key from your APIFuse bounty dashboard.",
			...options,
		});
		this.name = "ProviderEngineAuthenticationError";
	}
}

/** Raised when the remote engine cannot be reached. There is no local fallback. */
export class ProviderEngineUnavailableError extends SDKError {
	constructor(message = "The remote APIFuse provider engine is unavailable", cause?: Error) {
		super(message, {
			code: "PROVIDER_ENGINE_UNAVAILABLE",
			retryable: true,
			fix: "Check network access and the provider engine endpoint, then retry.",
			...(cause ? { cause } : {}),
		});
		this.name = "ProviderEngineUnavailableError";
	}
}

/** Raised when the engine refuses egress outside the workspace's pinned allowlist. */
export class ProviderEgressDeniedError extends ProviderError {
	constructor(message: string, details?: unknown) {
		super(message, {
			code: "PROVIDER_EGRESS_DENIED",
			retryable: false,
			details,
			fix: "Use a host in the provider's pinned allowedHosts declaration, or request a trusted pin update.",
		});
		this.name = "ProviderEgressDeniedError";
	}
}

/** Raised when persisted stealth cookies use a store version this SDK cannot read. */
export class StealthCookieStoreVersionError extends SDKError {
	constructor(public readonly version: unknown) {
		const displayedVersion =
			typeof version === "string" || typeof version === "number"
				? String(version)
				: "missing or invalid";
		super(`Unsupported stealth cookie store version: ${displayedVersion}`, {
			code: "unsupported_stealth_cookie_store_version",
			details: { receivedVersion: version, supportedVersions: [1] },
		});
		this.name = "StealthCookieStoreVersionError";
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
		defineErrorBrand(this, VALIDATION_BRAND, true);
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

export type HttpRedirectErrorOptions = TransportErrorOptions & {
	reason: HttpRedirectFailureReason;
	/** Redacted redirect target suitable for provider diagnostics. */
	target?: string;
};

/** Raised when an opt-in ctx.http redirect policy refuses or cannot resolve a hop. */
export class HttpRedirectError extends TransportError {
	readonly reason: HttpRedirectFailureReason;
	readonly target?: string;

	constructor(message: string, options: HttpRedirectErrorOptions) {
		const { reason, target, ...transportOptions } = options;
		super(message, {
			...transportOptions,
			code: `http_redirect_${reason}`,
			details: {
				reason,
				...(target ? { target } : {}),
			},
		});
		this.name = "HttpRedirectError";
		this.reason = reason;
		this.target = target;
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

export function isValidationError(value: unknown): value is ValidationError {
	return (
		isProviderError(value) &&
		(hasOwnBrand(value, VALIDATION_BRAND, true) || value.name === "ValidationError")
	);
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
