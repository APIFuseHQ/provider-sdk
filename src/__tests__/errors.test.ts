import { describe, expect, it } from "bun:test";
import {
	AuthError,
	ContextAccessError,
	CredentialKeyError,
	CredentialModeError,
	FlowExpiredError,
	ProviderEgressDeniedError,
	ProviderEngineUnavailableError,
	ProviderError,
	ProviderSecretError,
	SDKError,
	SessionExpiredError,
	TransportError,
	TurnValidationError,
	ValidationError,
} from "../errors.js";
import { sdkErrorContractOf } from "../sdk-error-contract.js";

describe("ProviderError", () => {
	it("should include fix hint", () => {
		const err = new ProviderError("Something broke", { fix: "Try again" });
		expect(err.fix).toBe("Try again");
		expect(err.message).toBe("Something broke");
		expect(err.name).toBe("ProviderError");
	});

	it("should include code", () => {
		const err = new ProviderError("Error", { code: "E001" });
		expect(err.code).toBe("E001");
	});

	it("should be instanceof Error", () => {
		const err = new ProviderError("test");
		expect(err instanceof Error).toBe(true);
		expect(err instanceof ProviderError).toBe(true);
	});
});

describe("AuthError", () => {
	it("should be instanceof ProviderError", () => {
		const err = new AuthError("Unauthorized", {
			code: "refresh_failed",
			fix: "Re-authenticate",
		});
		expect(err instanceof ProviderError).toBe(true);
		expect(err instanceof AuthError).toBe(true);
		expect(err.name).toBe("AuthError");
		expect(err.code).toBe("refresh_failed");
	});
});

describe("SessionExpiredError", () => {
	it("maps to the credential-expired reauth signal without credential payload", () => {
		const err = new SessionExpiredError();
		expect(err instanceof AuthError).toBe(true);
		expect(err instanceof ProviderError).toBe(true);
		expect(err.name).toBe("SessionExpiredError");
		expect(err.code).toBe("reauth_required");
		expect(err.details).toBeUndefined();
		expect(err.options?.category).toBe("credential_expired");
		expect(err.options?.retryable).toBe(false);
	});
});

describe("ValidationError", () => {
	it("should store zodError", () => {
		const zodErr = { issues: [{ path: ["id"], message: "Required" }] };
		const err = new ValidationError("Invalid input", {
			zodError: zodErr,
			fix: "Check id field",
		});
		expect(err.zodError).toEqual(zodErr);
		expect(err instanceof ProviderError).toBe(true);
	});
});

describe("TransportError", () => {
	it("should store HTTP status", () => {
		const err = new TransportError("Connection failed", { status: 502 });
		expect(err.status).toBe(502);
		expect(err instanceof ProviderError).toBe(true);
	});
});

describe("SDKError", () => {
	it("should be instanceof ProviderError", () => {
		const err = new SDKError("Internal SDK error");
		expect(err instanceof ProviderError).toBe(true);
		expect(err.name).toBe("SDKError");
	});
});

describe("new provider-sdk foundation errors", () => {
	it("assigns stable error codes", () => {
		expect(new ProviderSecretError("missing secret").code).toBe("provider_secret_error");
		expect(new CredentialKeyError("bad key").code).toBe("credential_key_error");
		expect(new CredentialModeError("bad mode").code).toBe("credential_mode_error");
		expect(new FlowExpiredError("expired").code).toBe("flow_expired");
		expect(new TurnValidationError("invalid turn").code).toBe("turn_validation_error");
		expect(new ContextAccessError("bad context").code).toBe("context_access_error");
	});

	it("inherits from ProviderError", () => {
		expect(new ProviderSecretError("missing")).toBeInstanceOf(ProviderError);
		expect(new CredentialKeyError("bad")).toBeInstanceOf(ProviderError);
		expect(new CredentialModeError("bad")).toBeInstanceOf(ProviderError);
		expect(new FlowExpiredError("expired")).toBeInstanceOf(ProviderError);
		expect(new TurnValidationError("invalid")).toBeInstanceOf(ProviderError);
		expect(new ContextAccessError("bad")).toBeInstanceOf(ProviderError);
	});
});

describe("SDK-owned engine errors carry their contract through the SDK brand", () => {
	// Both state `retryable` with the throw, which `new ProviderError` refuses on
	// unbranded options: constructing them at all proves the brand, and the
	// contract read back proves it is the one the serve layer resolves.
	it("ProviderEngineUnavailableError is retryable and keeps its cause", () => {
		const cause = new Error("ECONNREFUSED");
		const error = new ProviderEngineUnavailableError(undefined, cause);
		expect(error).toBeInstanceOf(SDKError);
		expect(error.name).toBe("ProviderEngineUnavailableError");
		expect(error.code).toBe("PROVIDER_ENGINE_UNAVAILABLE");
		expect(error.cause).toBe(cause);
		expect(sdkErrorContractOf(error)).toEqual({ retryable: true });
	});

	it("ProviderEgressDeniedError is not retryable and keeps its details", () => {
		const error = new ProviderEgressDeniedError("egress denied", { host: "evil.example" });
		expect(error).toBeInstanceOf(ProviderError);
		expect(error.name).toBe("ProviderEgressDeniedError");
		expect(error.code).toBe("PROVIDER_EGRESS_DENIED");
		expect(error.details).toEqual({ host: "evil.example" });
		expect(sdkErrorContractOf(error)).toEqual({ retryable: false });
	});
});
