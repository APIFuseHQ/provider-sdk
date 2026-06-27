import type { ProviderErrorCategory } from "./observability";

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
	constructor(
		message = "Provider session expired",
		options?: ProviderErrorOptions,
	) {
		super(message, {
			code: "reauth_required",
			category: "credential_expired",
			retryable: false,
			...options,
		});
		this.name = "SessionExpiredError";
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
	}
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
