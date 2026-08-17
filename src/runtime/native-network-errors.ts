import { TransportError } from "../errors.js";
import { canonicalizeEgressHost } from "../native-address.js";

export type NativeNetworkErrorCode =
	| "native_connection_aborted"
	| "native_connection_closed"
	| "native_connection_failed"
	| "native_connection_idle_timeout"
	| "native_connection_timeout"
	| "native_egress_authorization_failed"
	| "native_egress_grant_expired"
	| "native_egress_grant_invalid"
	| "native_egress_grant_limit_exceeded"
	| "native_egress_input_invalid"
	| "native_egress_not_declared"
	| "native_egress_policy_invalid"
	| "native_dynamic_egress_unsupported"
	| "native_proxy_expired"
	| "native_proxy_invalid";

export class NativeNetworkError extends TransportError {
	constructor(message: string, code: NativeNetworkErrorCode, cause?: Error) {
		const isEgressPolicyFailure =
			code.startsWith("native_egress_") || code === "native_dynamic_egress_unsupported";
		super(message, {
			code,
			status: 0,
			...(cause ? { cause } : {}),
			...(isEgressPolicyFailure ? { category: "provider_error" as const, retryable: false } : {}),
		});
		this.name = "NativeNetworkError";
	}

	override get code(): NativeNetworkErrorCode {
		return super.code as NativeNetworkErrorCode;
	}
}

export function safeDiagnosticEgressHost(value: unknown): string {
	const canonical = canonicalizeEgressHost(value);
	return canonical.ok ? canonical.host : `<invalid-host:${canonical.reason}>`;
}

export class NativeProxyExpiredError extends NativeNetworkError {
	constructor(readonly expiresAt: string) {
		super("Native connection closed at sticky proxy expiry", "native_proxy_expired");
		this.name = "NativeProxyExpiredError";
	}
}

/** Raised before transport setup when a native destination is not authorized. */
export class NativeEgressNotDeclaredError extends NativeNetworkError {
	readonly host: string;

	constructor(
		host: string,
		readonly port: number,
		readonly tls: "required" | "disabled",
	) {
		const diagnosticHost = safeDiagnosticEgressHost(host);
		super(
			`Native ${tls === "required" ? "TLS" : "TCP"} egress is not declared for ${diagnosticHost}:${port}`,
			"native_egress_not_declared",
		);
		this.host = diagnosticHost;
		this.name = "NativeEgressNotDeclaredError";
	}
}

/**
 * Raised when the destination was authorized by a grant whose TTL elapsed and
 * its expiry remains in the client's bounded recent-expiry evidence window.
 */
export class NativeEgressGrantExpiredError extends NativeNetworkError {
	readonly host: string;

	constructor(
		host: string,
		readonly port: number,
		readonly tls: "required" | "disabled",
		readonly expiresAt: string,
	) {
		const diagnosticHost = safeDiagnosticEgressHost(host);
		super(
			`Native ${tls === "required" ? "TLS" : "TCP"} egress grant expired for ${diagnosticHost}:${port}`,
			"native_egress_grant_expired",
		);
		this.host = diagnosticHost;
		this.name = "NativeEgressGrantExpiredError";
	}
}

/** Raised when an established connection exceeds its opt-in read-idle window. */
export class NativeIdleTimeoutError extends NativeNetworkError {
	constructor() {
		super("Native network socket timed out while reading.", "native_connection_idle_timeout");
		this.name = "NativeIdleTimeoutError";
	}
}
