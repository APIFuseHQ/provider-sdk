import {
	defineErrorBrand,
	hasOwnBrand,
	hasProviderErrorBrand,
	PROVIDER_ERROR_BRAND,
	PROVIDER_ERROR_BRAND_VALUE,
} from "./error-brands.js";
import type { ProviderErrorMessageParams } from "./i18n/error-messages.js";
import type { ProviderFailureCategory } from "./observability.js";
import { hasSdkErrorContractBrand, sdkErrorOptions } from "./sdk-error-contract.js";
import { issueSdkError } from "./sdk-issued-errors.js";
import type { HttpRedirectFailureReason, ProviderLocaleKeyInput } from "./types.js";

const SESSION_EXPIRED_BRAND = Symbol.for("@apifuse/provider-sdk/error-kind/session-expired@1");
const TRANSPORT_BRAND = Symbol.for("@apifuse/provider-sdk/error-kind/transport@1");
const VALIDATION_BRAND = Symbol.for("@apifuse/provider-sdk/error-kind/validation@1");
const HANDLE_BRAND = Symbol.for("@apifuse/provider-sdk/error-kind/handle@1");

/**
 * Options of a provider-thrown error. The served status, category and
 * retryability of a code are not options: they are declared once with
 * `defineErrors({ CODE: { status, category, retryable, description } })` and
 * thrown as `errors.CODE({ details, cause })`. A `category` or `retryable`
 * passed here is refused at construction (`PER_THROW_ERROR_OPTIONS_RETIRED`).
 */
export type ProviderErrorOptions = {
	fix?: string;
	code?: string;
	details?: unknown;
	cause?: Error;
	/** Provider-authored, bounded metadata safe for operational logs and error headers. */
	observability?: ProviderErrorObservability;
	/**
	 * Locale catalog key for the client-facing `message`, e.g.
	 * `"errors.upstreamSchema.message"`. Resolved at serve time against the
	 * provider's `locales/{en,ko,ja}.json` with the caller's `Accept-Language`,
	 * falling back to `en` and then to the positional `message`.
	 *
	 * The positional `message` stays English: it is what `error.message`, cause
	 * frames, logs and OTLP attributes carry. Only the response envelope is
	 * localized.
	 */
	messageKey?: ProviderLocaleKeyInput;
	/** Locale catalog key for the client-facing `fix`. Same resolution as {@link ProviderErrorOptions.messageKey}. */
	fixKey?: ProviderLocaleKeyInput;
	/**
	 * Values substituted into `{name}` placeholders of the resolved text.
	 * Strings and finite numbers only; string values are scrubbed and length
	 * capped before substitution because upstream text routinely lands here.
	 */
	params?: ProviderErrorMessageParams;
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

/**
 * The served category and retryability an SDK-owned error carries with the
 * throw. Read by the serve layer's resolution through {@link sdkErrorContractOf};
 * only an options object built with {@link sdkErrorOptions} answers.
 */
export type SdkErrorContract = {
	readonly category?: ProviderFailureCategory;
	readonly retryable?: boolean;
};

/**
 * Options for an error the SDK itself constructs (transport failures, session
 * expiry, missing secrets, output validation, stream limits, ...). These are
 * not provider codes and no declaration describes them, so the SDK states
 * their category and retryability where it throws. Not for provider code: a
 * provider declares its codes with `defineErrors`.
 */
export type SdkErrorOptions = ProviderErrorOptions & SdkErrorContract;

/**
 * The retired per-throw contract fields, typed `never` on the options a
 * provider passes to an error constructor, so tsc reports one that arrives
 * through a typed variable, a spread or a subclass `super()`, not only in an
 * object literal. The runtime refusal (`PER_THROW_ERROR_OPTIONS_RETIRED`)
 * stays as the backstop for JavaScript and casts.
 */
export type RetiredErrorContractFields = {
	/** Removed: declare the code with `defineErrors({ CODE: { status, category, description } })` and throw `errors.CODE(...)`. */
	readonly category?: never;
	/** Removed: declare the code with `defineErrors({ CODE: { status, retryable, description } })` and throw `errors.CODE(...)`. */
	readonly retryable?: never;
};

/** What a provider-facing error constructor accepts. */
export type ProviderErrorConstructorOptions<T extends ProviderErrorOptions = ProviderErrorOptions> =
	T & RetiredErrorContractFields;

const RETIRED_PER_THROW_OPTIONS = ["category", "retryable"] as const;

/**
 * The pre-`defineErrors` shape, `new ProviderError(message, { code, category,
 * retryable })`, is refused at construction. The declaration is the only
 * source of a code's category and retryability; a per-throw value that
 * differed from it used to win, which made the served verdict depend on the
 * throw site instead of the contract. SDK-owned construction (see
 * `sdkErrorOptions`) is exempt: no declaration describes those errors.
 *
 * The refusal is a provider defect the SDK detected, served like
 * `OUTPUT_VALIDATION_FAILED`: a platform fault (500, source `apifuse`,
 * `retryable: false`), never the caller's input failure. The code and the
 * options it names stay on the error; the author guidance goes to the
 * failure log (`per_throw_error_options_retired` signal), not the body.
 */
function rejectPerThrowContractOptions(options: ProviderErrorOptions | undefined): void {
	if (options === undefined || hasSdkErrorContractBrand(options)) return;
	const record = options as Record<string, unknown>;
	const present = RETIRED_PER_THROW_OPTIONS.filter((option) => record[option] !== undefined);
	if (present.length === 0) return;
	const code = typeof record.code === "string" ? record.code : "CODE";
	throw issueSdkError(
		new SDKError(
			`new ProviderError(..., { code: "${code}", ${present.join(", ")} }) sets ${present.join(" and ")} per throw; these options were removed. A code's status, category and retryability come from its declaration only.`,
			{
				code: "PER_THROW_ERROR_OPTIONS_RETIRED",
				details: { code, options: present },
			},
		),
		{
			category: "internal_error",
			code: "PER_THROW_ERROR_OPTIONS_RETIRED",
			status: 500,
			retryable: false,
		},
	);
}

/**
 * `TCode` is the error's `code` as a literal union when a `defineErrors`
 * factory made it (`errors.ITEM_NOT_FOUND()` is a `ProviderError<"ITEM_NOT_FOUND">`);
 * a hand-constructed error is a `ProviderError<string>`.
 */
export class ProviderError<TCode extends string = string> extends Error {
	readonly options?: ProviderErrorOptions | undefined;

	constructor(message: string, options?: ProviderErrorConstructorOptions) {
		super(message);
		this.options = options;
		rejectPerThrowContractOptions(options);
		this.name = "ProviderError";
		if (options?.cause) {
			this.cause = options.cause;
		}
		defineErrorBrand(this, PROVIDER_ERROR_BRAND, PROVIDER_ERROR_BRAND_VALUE);
	}

	get fix(): string | undefined {
		return this.options?.fix;
	}

	get code(): TCode | undefined {
		return this.options?.code as TCode | undefined;
	}

	get details(): unknown {
		return this.options?.details;
	}
}

export class SDKError extends ProviderError {
	constructor(message: string, options?: ProviderErrorConstructorOptions) {
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
	constructor(
		message = "Provider engine authentication failed",
		options?: ProviderErrorConstructorOptions,
	) {
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
		super(
			message,
			sdkErrorOptions({
				code: "PROVIDER_ENGINE_UNAVAILABLE",
				retryable: true,
				fix: "Check network access and the provider engine endpoint, then retry.",
				...(cause ? { cause } : {}),
			}),
		);
		this.name = "ProviderEngineUnavailableError";
	}
}

/** Raised when the engine refuses egress outside the workspace's pinned allowlist. */
export class ProviderEgressDeniedError extends ProviderError {
	constructor(message: string, details?: unknown) {
		super(
			message,
			sdkErrorOptions({
				code: "PROVIDER_EGRESS_DENIED",
				retryable: false,
				details,
				fix: "Use a host in the provider's pinned allowedHosts declaration, or request a trusted pin update.",
			}),
		);
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
	constructor(message: string, options?: ProviderErrorConstructorOptions) {
		super(message, options);
		this.name = "AuthError";
	}
}

/**
 * Session expiry is SDK-owned resolution (`reauth_required`, 401,
 * `credential_expired`); the options carry the SDK contract fields so a
 * caller may still mark one as retryable.
 */
export class SessionExpiredError extends AuthError {
	declare readonly options?: SdkErrorOptions;

	constructor(message = "Provider session expired", options?: SdkErrorOptions) {
		super(
			message,
			sdkErrorOptions({
				code: "reauth_required",
				category: "credential_expired",
				retryable: false,
				...options,
			}),
		);
		this.name = "SessionExpiredError";
		defineErrorBrand(this, SESSION_EXPIRED_BRAND, true);
	}
}

export type ValidationErrorOptions = ProviderErrorOptions & {
	zodError?: unknown;
};

export class ValidationError extends ProviderError {
	readonly zodError?: unknown;

	constructor(message: string, options?: ProviderErrorConstructorOptions<ValidationErrorOptions>) {
		super(message, options);
		this.name = "ValidationError";
		this.zodError = options?.zodError;
		defineErrorBrand(this, VALIDATION_BRAND, true);
	}
}

/**
 * A transport failure is SDK-owned: the SDK's HTTP and stealth layers state
 * its category and retryability where they build it, so these options carry
 * the SDK contract fields.
 */
export type TransportErrorOptions = SdkErrorOptions & {
	status?: number;
	upstreamStatus?: number;
};

export class TransportError extends ProviderError {
	declare readonly options?: TransportErrorOptions;
	readonly status?: number;
	readonly upstreamStatus?: number;

	constructor(message: string, options?: TransportErrorOptions) {
		super(message, options === undefined ? undefined : sdkErrorOptions({ ...options }));
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
	return hasProviderErrorBrand(value);
}

export function isSessionExpiredError(value: unknown): value is SessionExpiredError {
	return isProviderError(value) && hasOwnBrand(value, SESSION_EXPIRED_BRAND, true);
}

export function isTransportError(value: unknown): value is TransportError {
	return isProviderError(value) && hasOwnBrand(value, TRANSPORT_BRAND, true);
}

/** Brands a handle error (ADR-0012) so `isHandleError` works across duplicate SDK module copies. */
export function brandHandleError(target: object): void {
	defineErrorBrand(target, HANDLE_BRAND, true);
}

export function hasHandleErrorBrand(value: unknown): boolean {
	return (
		hasOwnBrand(value, PROVIDER_ERROR_BRAND, PROVIDER_ERROR_BRAND_VALUE) &&
		hasOwnBrand(value, HANDLE_BRAND, true)
	);
}

export function isValidationError(value: unknown): value is ValidationError {
	return (
		isProviderError(value) &&
		(hasOwnBrand(value, VALIDATION_BRAND, true) || value.name === "ValidationError")
	);
}

export class ProviderSecretError extends ProviderError {
	constructor(message: string, options?: SdkErrorOptions) {
		super(message, sdkErrorOptions({ code: "provider_secret_error", ...options }));
		this.name = "ProviderSecretError";
	}
}

export class CredentialKeyError extends ProviderError {
	constructor(message: string, options?: ProviderErrorConstructorOptions) {
		super(message, { code: "credential_key_error", ...options });
		this.name = "CredentialKeyError";
	}
}

export class CredentialModeError extends ProviderError {
	constructor(message: string, options?: ProviderErrorConstructorOptions) {
		super(message, { code: "credential_mode_error", ...options });
		this.name = "CredentialModeError";
	}
}

export class FlowExpiredError extends ProviderError {
	constructor(message: string, options?: ProviderErrorConstructorOptions) {
		super(message, { code: "flow_expired", ...options });
		this.name = "FlowExpiredError";
	}
}

export class TurnValidationError extends ProviderError {
	constructor(message: string, options?: ProviderErrorConstructorOptions) {
		super(message, { code: "turn_validation_error", ...options });
		this.name = "TurnValidationError";
	}
}

export class ContextAccessError extends ProviderError {
	constructor(message: string, options?: ProviderErrorConstructorOptions) {
		super(message, { code: "context_access_error", ...options });
		this.name = "ContextAccessError";
	}
}
