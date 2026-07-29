import type { RequestParamPrimitive, RequestParams, RequestParamValue } from "../types.js";

export const REDACTED_QUERY_VALUE = "[REDACTED]";

export type SerializedRequestUrl = {
	requestUrl: string;
	redactedUrl: string;
	sensitiveValues: readonly string[];
};

function isParamArray(value: RequestParamValue): value is readonly RequestParamPrimitive[] {
	return Array.isArray(value);
}

function appendQueryValue(
	searchParams: URLSearchParams,
	key: string,
	value: string | number | boolean | null | undefined,
): void {
	if (value === null || value === undefined) {
		return;
	}
	searchParams.append(key, String(value));
}

export function appendQueryParams(url: string, params?: RequestParams): string {
	if (!params || Object.keys(params).length === 0) {
		return url;
	}

	const parsed = new URL(url);
	for (const [key, value] of Object.entries(params)) {
		if (isParamArray(value)) {
			for (const item of value) appendQueryValue(parsed.searchParams, key, item);
			continue;
		}
		appendQueryValue(parsed.searchParams, key, value);
	}

	return parsed.toString();
}

function displayRedactedUrl(url: URL): string {
	return url.toString().replaceAll(encodeURIComponent(REDACTED_QUERY_VALUE), REDACTED_QUERY_VALUE);
}

/**
 * Serializes public and secret query parameters together while constructing a
 * separate, structurally redacted URL for diagnostics and observability.
 */
export function serializeRequestUrl(
	url: string,
	params?: RequestParams,
	sensitiveParams?: Record<string, string>,
): SerializedRequestUrl {
	const urlWithParams = appendQueryParams(url, params);
	if (!sensitiveParams || Object.keys(sensitiveParams).length === 0) {
		return { requestUrl: urlWithParams, redactedUrl: urlWithParams, sensitiveValues: [] };
	}

	const requestUrl = new URL(urlWithParams);
	const redactedUrl = new URL(urlWithParams);
	const sensitiveValues: string[] = [];

	for (const [key, value] of Object.entries(sensitiveParams)) {
		requestUrl.searchParams.append(key, value);
		// A matching key already present in the URL or ordinary params is
		// conservatively secret once the caller declares that key sensitive.
		redactedUrl.searchParams.set(key, REDACTED_QUERY_VALUE);
		sensitiveValues.push(value);
	}

	return {
		requestUrl: requestUrl.toString(),
		redactedUrl: displayRedactedUrl(redactedUrl),
		sensitiveValues,
	};
}

function sensitiveValueVariants(value: string): string[] {
	if (!value || value === REDACTED_QUERY_VALUE) return [];

	const formEncoded = new URLSearchParams({ value }).toString().slice("value=".length);
	return [...new Set([value, encodeURIComponent(value), formEncoded])].sort(
		(left, right) => right.length - left.length,
	);
}

/** Scrubs raw and URL-encoded secret values from diagnostic text. */
export function redactSensitiveText(
	text: string,
	sensitiveValues: readonly string[],
	requestUrl?: string,
	redactedUrl?: string,
): string {
	let redacted = requestUrl && redactedUrl ? text.replaceAll(requestUrl, redactedUrl) : text;
	for (const value of sensitiveValues) {
		for (const variant of sensitiveValueVariants(value)) {
			redacted = redacted.replaceAll(variant, REDACTED_QUERY_VALUE);
		}
	}
	return redacted;
}

/** Redacts messages, stacks, and nested causes without changing error identity. */
export function redactSensitiveError<T>(
	error: T,
	sensitiveValues: readonly string[],
	requestUrl?: string,
	redactedUrl?: string,
): T {
	if (!(error instanceof Error) || sensitiveValues.length === 0) return error;

	error.message = redactSensitiveText(error.message, sensitiveValues, requestUrl, redactedUrl);
	if (error.stack) {
		error.stack = redactSensitiveText(error.stack, sensitiveValues, requestUrl, redactedUrl);
	}
	if (error.cause && error.cause !== error) {
		redactSensitiveError(error.cause, sensitiveValues, requestUrl, redactedUrl);
	}
	return error;
}

export function normalizeHttpRequestBody(body: unknown): string | Buffer | undefined {
	if (body === undefined) {
		return undefined;
	}

	if (typeof body === "string" || Buffer.isBuffer(body)) {
		return body;
	}

	if (body instanceof URLSearchParams) {
		return body.toString();
	}

	if (body instanceof ArrayBuffer) {
		return Buffer.from(body);
	}

	if (ArrayBuffer.isView(body)) {
		return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	}

	return JSON.stringify(body);
}
