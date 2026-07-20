import { TransportError } from "../errors.js";

export const PROXY_AUTH_IP_DENIED_CODE = "PROXY_AUTH_IP_DENIED";
export const PROXY_AUTH_IP_DENIED_MESSAGE =
	"Proxy source IP is not authorized. Add the runtime egress IP to the proxy provider allowlist.";
export const PROXY_EDGE_AUTH_REJECTED_CODE = "PROXY_EDGE_AUTH_REJECTED";
export const PROXY_EDGE_AUTH_REJECTED_MESSAGE =
	"Proxy provider rejected a candidate endpoint during authentication. The SDK will retry or refresh the proxy pool when safe.";
export const PROXY_POOL_STALE_CODE = "PROXY_POOL_STALE";
export const PROXY_EDGE_TLS_REJECTED_CODE = "PROXY_EDGE_TLS_REJECTED";
export const PROXY_POOL_EXHAUSTED_CODE = "PROXY_POOL_EXHAUSTED";
export const PROXY_POOL_EXHAUSTED_MESSAGE =
	"Proxy provider pool was exhausted. The SDK refreshed the proxy allocation, but all candidate endpoints failed.";

const PROXY_POOL_STALE_STATUS_CODES = new Set([509, 512]);
const PROXY_EDGE_TLS_REJECTED_STATUS_CODES = new Set([495]);

const PROXY_AUTH_IP_DENIED_PATTERN =
	/\b(?:source|egress|client)\s+ip\b.{0,120}\b(?:deny|denied|unauthori[sz]ed|not\s+authori[sz]ed|white\s*list|allow\s*list)\b|\b(?:white\s*list|allow\s*list)\b.{0,120}\b(?:source|egress|client)\s+ip\b/i;
const PROXY_EDGE_AUTH_REJECTED_PATTERN =
	/\bauth\s+ip\s+err\b|\bproxy\b.{0,120}\bauth(?:entication)?\b.{0,120}\b(?:reject(?:ed)?|fail(?:ed)?|invalid|den(?:y|ied)|unauthori[sz]ed)\b|\bauth(?:entication)?\b.{0,120}\b(?:reject(?:ed)?|fail(?:ed)?|invalid|den(?:y|ied)|unauthori[sz]ed)\b.{0,120}\bproxy\b/i;
const PROXY_POOL_STALE_MESSAGE_PATTERN =
	/\bproxy\b.{0,120}\b(?:pool|lease|expired|unavailable|exhausted|non[\s-]?200\s+code:\s*(?:509|512))\b|\bnon[\s-]?200\s+code:\s*(?:509|512)\b.{0,120}\bproxy\b|\bsmartproxy\b.{0,120}\b(?:509|512)\b/i;
const PROXY_EDGE_TLS_REJECTED_MESSAGE_PATTERN =
	/\b(?:smartproxy|proxy)\b.{0,160}\b(?:495|ssl|tls|cert(?:ificate)?|handshake|edge|connect|non[\s-]?200)\b|\b(?:495|ssl|tls|cert(?:ificate)?|handshake|edge|connect|non[\s-]?200)\b.{0,160}\b(?:smartproxy|proxy)\b/i;

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
	return new TransportError(PROXY_EDGE_AUTH_REJECTED_MESSAGE, {
		code: PROXY_EDGE_AUTH_REJECTED_CODE,
		cause,
	});
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
	return new TransportError(`Proxy provider pool failed with status ${status}`, {
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
	return new TransportError(PROXY_POOL_EXHAUSTED_MESSAGE, {
		code: PROXY_POOL_EXHAUSTED_CODE,
		cause,
	});
}
