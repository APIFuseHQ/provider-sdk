import type {
	HttpClient,
	RequestOptions,
	RequestParamPrimitive,
	RequestParams,
	RequestParamValue,
} from "../types.js";

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
	const sensitiveValues = new Set<string>();

	for (const [key, value] of Object.entries(sensitiveParams)) {
		const serializedValue = String(value);
		// Declaring a key sensitive applies to every occurrence of that key,
		// including values already present in the URL or ordinary params.
		for (const existingValue of requestUrl.searchParams.getAll(key)) {
			sensitiveValues.add(existingValue);
		}
		requestUrl.searchParams.append(key, serializedValue);
		// A matching key already present in the URL or ordinary params is
		// conservatively secret once the caller declares that key sensitive.
		redactedUrl.searchParams.set(key, REDACTED_QUERY_VALUE);
		sensitiveValues.add(serializedValue);
	}

	return {
		requestUrl: requestUrl.toString(),
		redactedUrl: displayRedactedUrl(redactedUrl),
		sensitiveValues: [...sensitiveValues],
	};
}

const MIN_UNSCOPED_SENSITIVE_VALUE_LENGTH = 4;

function lowercasePercentEscapes(value: string): string {
	return value.replace(/%[\dA-F]{2}/g, (percentEscape) => percentEscape.toLowerCase());
}

function sensitiveValueVariants(value: string): string[] {
	if (!value || value === REDACTED_QUERY_VALUE) return [];

	const formEncoded = new URLSearchParams({ value }).toString().slice("value=".length);
	const componentEncoded = encodeURIComponent(value);
	return [
		...new Set([
			value,
			componentEncoded,
			lowercasePercentEscapes(componentEncoded),
			formEncoded,
			lowercasePercentEscapes(formEncoded),
		]),
	];
}

function allSensitiveValueVariants(sensitiveValues: readonly string[]): string[] {
	return [
		...new Set(
			sensitiveValues
				.filter((value) => value.length >= MIN_UNSCOPED_SENSITIVE_VALUE_LENGTH)
				.flatMap(sensitiveValueVariants),
		),
	].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

/** Scrubs raw and URL-encoded secret values from diagnostic text. */
export function redactSensitiveText(
	text: string,
	sensitiveValues: readonly string[],
	requestUrl?: string,
	redactedUrl?: string,
): string {
	let redacted = requestUrl && redactedUrl ? text.replaceAll(requestUrl, redactedUrl) : text;
	for (const variant of allSensitiveValueVariants(sensitiveValues)) {
		// Very short values have too little entropy for safe unscoped substring
		// replacement (for example, secret "1" must not corrupt timestamps).
		// Their complete outbound URL is still structurally redacted above.
		redacted = redacted.replaceAll(variant, REDACTED_QUERY_VALUE);
	}
	return redacted;
}

type RedactionContext = {
	sensitiveValues: readonly string[];
	requestUrl?: string;
	redactedUrl?: string;
	seen: Map<object, unknown>;
};

function redactDiagnosticString(value: string, context: RedactionContext): string {
	return redactSensitiveText(
		value,
		context.sensitiveValues,
		context.requestUrl,
		context.redactedUrl,
	);
}

function cloneForRedaction(source: object): object {
	let clone: object;
	try {
		clone = Object.create(Object.getPrototypeOf(source));
	} catch {
		clone = source instanceof Error ? new Error() : {};
	}

	for (const key of Reflect.ownKeys(source)) {
		const descriptor = Object.getOwnPropertyDescriptor(source, key);
		if (!descriptor) continue;
		try {
			// Symbol properties include the SDK's immutable error brands. Preserve
			// their descriptors exactly so replacement Provider/TransportErrors
			// retain their cross-realm identity semantics.
			Object.defineProperty(
				clone,
				key,
				typeof key === "symbol"
					? descriptor
					: {
							...descriptor,
							configurable: true,
							...(Object.hasOwn(descriptor, "value") ? { writable: true } : {}),
						},
			);
		} catch {
			// A hostile or exotic diagnostic property must not make redaction fail.
		}
	}
	if (source instanceof Error) {
		// DOMException exposes name/message through internal-slot getters. An
		// Object.create clone does not carry those slots, so materialize the
		// classification fields as safe own properties on the replacement.
		for (const key of ["name", "message", "stack"] as const) {
			if (Object.hasOwn(clone, key)) continue;
			const property = readDiagnosticProperty(source, key);
			if (!property.ok) continue;
			const propertyValue =
				key === "stack" && typeof property.value !== "string" ? new Error().stack : property.value;
			try {
				Object.defineProperty(clone, key, {
					value: propertyValue,
					configurable: true,
					enumerable: false,
					writable: true,
				});
			} catch {
				// The generic Error fallback remains classifiable even if an exotic
				// prototype rejects an own diagnostic property.
			}
		}
	}
	return clone;
}

function setDiagnosticProperty(target: object, key: string, value: unknown): boolean {
	try {
		return Reflect.set(target, key, value, target);
	} catch {
		return false;
	}
}

function diagnosticPropertyKeys(value: object): string[] {
	const keys = new Set(Object.keys(value));
	if (value instanceof Error) {
		// Built-in error text and AggregateError.errors are commonly
		// non-enumerable, while SDK options carry serializable details.
		for (const key of ["name", "message", "stack", "cause", "errors", "options"] as const) {
			if (key in value) keys.add(key);
		}
	}
	return [...keys];
}

function readDiagnosticProperty(
	value: object,
	key: string,
): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: Reflect.get(value, key, value) };
	} catch {
		return { ok: false };
	}
}

function redactDiagnosticValue(value: unknown, context: RedactionContext): unknown {
	if (typeof value === "string") return redactDiagnosticString(value, context);
	if (
		(typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") &&
		context.sensitiveValues.includes(String(value))
	) {
		// JSON parsers can turn a numeric-looking credential into a number. Exact
		// primitive equality is scoped enough to remain safe even for short values.
		return REDACTED_QUERY_VALUE;
	}
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;

	const previouslySeen = context.seen.get(value);
	if (previouslySeen !== undefined) return previouslySeen;

	// Clone non-extensible graphs before descending so cycles encountered before
	// a secret-bearing readonly field already point at the eventual replacement.
	// Without this, a frozen `error.cause = error` graph could retain the original
	// secret through the cloned node's earlier self-reference.
	let target: object = Object.isExtensible(value) ? value : cloneForRedaction(value);
	context.seen.set(value, target);

	for (const key of diagnosticPropertyKeys(value)) {
		const current = readDiagnosticProperty(value, key);
		if (!current.ok) continue;
		const redacted = redactDiagnosticValue(current.value, context);
		if (Object.is(redacted, current.value)) continue;

		if (!setDiagnosticProperty(target, key, redacted)) {
			if (target === value) {
				target = cloneForRedaction(value);
				context.seen.set(value, target);
			}
			if (!setDiagnosticProperty(target, key, redacted)) {
				// cloneForRedaction deliberately makes string-keyed own properties
				// configurable. This is a last-resort path for inherited readonly
				// accessors such as DOMException.message.
				try {
					Object.defineProperty(target, key, {
						value: redacted,
						configurable: true,
						enumerable: key !== "message" && key !== "stack" && key !== "cause",
						writable: true,
					});
				} catch {
					// Redaction is best-effort for inaccessible exotic properties, but
					// it must never mask the original transport failure.
				}
			}
		}
	}

	return target;
}

/**
 * Redacts error text and recursively serializable diagnostic metadata.
 * Mutable errors retain identity; readonly/frozen errors may be replaced, so
 * callers must use the returned value.
 */
export function redactSensitiveError<T>(
	error: T,
	sensitiveValues: readonly string[],
	requestUrl?: string,
	redactedUrl?: string,
): T {
	if (sensitiveValues.length === 0) return error;
	return redactDiagnosticValue(error, {
		sensitiveValues,
		requestUrl,
		redactedUrl,
		seen: new Map(),
	}) as T;
}

function isRequestOptions(value: unknown): value is RequestOptions {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Internal typed registry for the request-options position of HttpClient calls. */
export function requestOptionsFromHttpInvocation(
	method: keyof HttpClient,
	args: readonly unknown[],
): RequestOptions | undefined {
	let candidate: unknown;
	switch (method) {
		case "post":
		case "put":
			candidate = args[2];
			break;
		case "request":
		case "get":
		case "delete":
		case "stream":
		case "sse":
			candidate = args[1];
			break;
		default:
			return undefined;
	}
	return isRequestOptions(candidate) ? candidate : undefined;
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
