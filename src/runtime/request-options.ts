import type {
	RequestParamPrimitive,
	RequestParams,
	RequestParamValue,
} from "../types";

function isParamArray(
	value: RequestParamValue,
): value is readonly RequestParamPrimitive[] {
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
			for (const item of value)
				appendQueryValue(parsed.searchParams, key, item);
			continue;
		}
		appendQueryValue(parsed.searchParams, key, value);
	}

	return parsed.toString();
}

export function normalizeHttpRequestBody(
	body: unknown,
): string | Buffer | undefined {
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
