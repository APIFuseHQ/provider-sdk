import { TransportError } from "../errors.js";
import { issueSdkError } from "../sdk-issued-errors.js";

export const PROXY_AUTH_IP_DENIED_CODE = "PROXY_AUTH_IP_DENIED";
export const PROXY_AUTH_IP_DENIED_MESSAGE =
	"Proxy source IP is not authorized. Add the runtime egress IP to the proxy provider allowlist.";
export const PROXY_EDGE_AUTH_REJECTED_CODE = "PROXY_EDGE_AUTH_REJECTED";
export const PROXY_EDGE_AUTH_REJECTED_MESSAGE =
	"Proxy provider rejected a session during authentication. The SDK retries with a new session when safe.";
/**
 * The vendor edge refused this attempt's session (CONNECT 509/512 and their
 * message forms). The code keeps its allocator-era name because the gateway
 * persists it under the `proxy_pool` category; there is no pool behind it.
 */
export const PROXY_POOL_STALE_CODE = "PROXY_POOL_STALE";
export const PROXY_EDGE_TLS_REJECTED_CODE = "PROXY_EDGE_TLS_REJECTED";
/** Every session the request's attempt budget allowed was refused by the vendor edge. */
export const PROXY_POOL_EXHAUSTED_CODE = "PROXY_POOL_EXHAUSTED";
export const PROXY_POOL_EXHAUSTED_MESSAGE =
	"Proxy provider refused every session the attempt budget allowed.";

// The status a proxy pool fault is served with when a transport throws it as a
// TransportError, like any transport failure.
export const PROXY_POOL_TRANSPORT_STATUS = 502;
// The status a proxy resolution failure that reaches serve as itself is served
// with: it is not a ProviderError, so its body is masked.
export const PROXY_POOL_RESOLUTION_STATUS = 500;

/**
 * Records `error` as the platform fault `proxy_pool`: the proxy egress APIFuse
 * runs could not carry the request, because no proxy endpoint could be
 * resolved or the vendor edge refused the request's sessions, and a retry on
 * a new session can succeed. Only the SDK's proxy resolution and transports
 * call this, where they create the error they throw for such a failure; serve
 * classifies from the record, never from the error's code, so a provider that
 * throws an error with one of these codes has thrown a provider failure.
 */
export function issueProxyPoolFault<T extends object>(error: T, code: string, status: number): T {
	return issueSdkError(error, { category: "proxy_pool", code, status, retryable: true });
}

const PROXY_POOL_STALE_STATUS_CODES = new Set([509, 512]);
const PROXY_EDGE_TLS_REJECTED_STATUS_CODES = new Set([495]);

const PROXY_AUTH_IP_DENIED_PATTERN =
	/\b(?:source|egress|client)\s+ip\b.{0,120}\b(?:deny|denied|unauthori[sz]ed|not\s+authori[sz]ed|white\s*list|allow\s*list)\b|\b(?:white\s*list|allow\s*list)\b.{0,120}\b(?:source|egress|client)\s+ip\b/i;
const PROXY_EDGE_AUTH_REJECTED_PATTERN =
	/\bauth\s+ip\s+err\b|\bproxy\b.{0,120}\bauth(?:entication)?\b.{0,120}\b(?:reject(?:ed)?|fail(?:ed)?|invalid|den(?:y|ied)|unauthori[sz]ed)\b|\bauth(?:entication)?\b.{0,120}\b(?:reject(?:ed)?|fail(?:ed)?|invalid|den(?:y|ied)|unauthori[sz]ed)\b.{0,120}\bproxy\b/i;
// Vendor host tokens that can appear in upstream error strings. Adding a proxy
// vendor updates every classifier below in one place. `proxy` is the generic
// fallback so vendor-agnostic messages still classify.
const PROXY_VENDOR_ALTERNATION = "smartproxy|nodemaven|proxy";
const PROXY_POOL_STALE_MESSAGE_PATTERN = new RegExp(
	`\\bproxy\\b.{0,120}\\b(?:pool|lease|expired|unavailable|exhausted|non[\\s-]?200\\s+code:\\s*(?:509|512))\\b|\\bnon[\\s-]?200\\s+code:\\s*(?:509|512)\\b.{0,120}\\bproxy\\b|\\b(?:${PROXY_VENDOR_ALTERNATION})\\b.{0,120}\\b(?:509|512)\\b`,
	"i",
);
const PROXY_EDGE_TLS_REJECTED_MESSAGE_PATTERN = new RegExp(
	`\\b(?:${PROXY_VENDOR_ALTERNATION})\\b.{0,160}\\b(?:495|ssl|tls|cert(?:ificate)?|handshake|edge|connect|non[\\s-]?200)\\b|\\b(?:495|ssl|tls|cert(?:ificate)?|handshake|edge|connect|non[\\s-]?200)\\b.{0,160}\\b(?:${PROXY_VENDOR_ALTERNATION})\\b`,
	"i",
);

export function isProxyAuthIpDeniedMessage(message: string): boolean {
	return PROXY_AUTH_IP_DENIED_PATTERN.test(message);
}

export function createProxyAuthIpDeniedError(cause?: Error): TransportError {
	return new TransportError(PROXY_AUTH_IP_DENIED_MESSAGE, {
		code: PROXY_AUTH_IP_DENIED_CODE,
		cause,
	});
}

export function isProxyEdgeAuthRejectedMessage(message: string): boolean {
	return PROXY_EDGE_AUTH_REJECTED_PATTERN.test(message);
}

export function createProxyEdgeAuthRejectedError(cause?: Error): TransportError {
	return issueProxyPoolFault(
		new TransportError(PROXY_EDGE_AUTH_REJECTED_MESSAGE, {
			code: PROXY_EDGE_AUTH_REJECTED_CODE,
			cause,
		}),
		PROXY_EDGE_AUTH_REJECTED_CODE,
		PROXY_POOL_TRANSPORT_STATUS,
	);
}

export function isProxyPoolStaleStatus(status: number): boolean {
	return PROXY_POOL_STALE_STATUS_CODES.has(status);
}

export function isProxyEdgeTlsRejectedResponse(status: number, evidence: string): boolean {
	return (
		PROXY_EDGE_TLS_REJECTED_STATUS_CODES.has(status) &&
		PROXY_EDGE_TLS_REJECTED_MESSAGE_PATTERN.test(evidence)
	);
}

export function isProxyPoolStaleMessage(message: string): boolean {
	return PROXY_POOL_STALE_MESSAGE_PATTERN.test(message);
}

export function isProxyPoolRefreshableError(error: unknown): boolean {
	if (error instanceof TransportError && error.code === PROXY_AUTH_IP_DENIED_CODE) {
		return false;
	}

	if (
		error instanceof TransportError &&
		(error.code === PROXY_POOL_STALE_CODE ||
			error.code === PROXY_EDGE_AUTH_REJECTED_CODE ||
			error.code === PROXY_EDGE_TLS_REJECTED_CODE)
	) {
		return true;
	}

	const cause = error instanceof Error ? error.cause : undefined;
	const message = [
		error instanceof Error ? error.message : String(error),
		cause instanceof Error ? cause.message : "",
	].join(" ");
	return (
		PROXY_POOL_STALE_MESSAGE_PATTERN.test(message) || PROXY_EDGE_AUTH_REJECTED_PATTERN.test(message)
	);
}

export const isProxyPoolStaleError = isProxyPoolRefreshableError;

export function createProxyPoolStaleError(status: number, cause?: Error): TransportError {
	return new TransportError(`Proxy provider refused the session with status ${status}`, {
		code: PROXY_POOL_STALE_CODE,
		status,
		cause,
	});
}

export function createProxyEdgeTlsRejectedError(status: number, cause?: Error): TransportError {
	return new TransportError(`Proxy edge TLS request was rejected with status ${status}`, {
		code: PROXY_EDGE_TLS_REJECTED_CODE,
		status,
		cause,
	});
}

export function createProxyPoolExhaustedError(cause?: Error): TransportError {
	return issueProxyPoolFault(
		new TransportError(PROXY_POOL_EXHAUSTED_MESSAGE, {
			code: PROXY_POOL_EXHAUSTED_CODE,
			cause,
		}),
		PROXY_POOL_EXHAUSTED_CODE,
		PROXY_POOL_TRANSPORT_STATUS,
	);
}
