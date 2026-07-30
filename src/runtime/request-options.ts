import type {
	HttpClient,
	RequestOptions,
	RequestParamPrimitive,
	RequestParams,
	RequestParamValue,
} from "../types.js";

export const REDACTED_QUERY_VALUE = "[REDACTED]";

export const HTTP_REQUEST_METHOD_NAMES = [
	"request",
	"get",
	"post",
	"put",
	"delete",
	"stream",
	"sse",
] as const satisfies readonly (keyof HttpClient)[];

export type HttpRequestMethod = (typeof HTTP_REQUEST_METHOD_NAMES)[number];

const HTTP_REQUEST_METHOD_SET = new Set<string>(HTTP_REQUEST_METHOD_NAMES);

export function isHttpRequestMethod(method: PropertyKey): method is HttpRequestMethod {
	return typeof method === "string" && HTTP_REQUEST_METHOD_SET.has(method);
}

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

	const appended = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (isParamArray(value)) {
			for (const item of value) appendQueryValue(appended, key, item);
			continue;
		}
		appendQueryValue(appended, key, value);
	}

	const query = appended.toString();
	if (!query) return url;
	const fragmentIndex = url.indexOf("#");
	const beforeFragment = fragmentIndex === -1 ? url : url.slice(0, fragmentIndex);
	const fragment = fragmentIndex === -1 ? "" : url.slice(fragmentIndex);
	const separator =
		beforeFragment.includes("?") && !beforeFragment.endsWith("?") && !beforeFragment.endsWith("&")
			? "&"
			: beforeFragment.includes("?")
				? ""
				: "?";
	return `${beforeFragment}${separator}${query}${fragment}`;
}

function decodeQueryComponent(value: string): string {
	try {
		return decodeURIComponent(value.replaceAll("+", " "));
	} catch {
		return value;
	}
}

/** Redacts matching query keys without reserializing any other URL bytes. */
export function redactUrlQueryParams(
	url: string,
	sensitiveParamNames: readonly string[],
): { redactedUrl: string; sensitiveValues: readonly string[] } {
	if (sensitiveParamNames.length === 0) return { redactedUrl: url, sensitiveValues: [] };
	const names = new Set(sensitiveParamNames);
	const queryStart = url.indexOf("?");
	if (queryStart === -1) return { redactedUrl: url, sensitiveValues: [] };
	const fragmentStart = url.indexOf("#", queryStart);
	const queryEnd = fragmentStart === -1 ? url.length : fragmentStart;
	const query = url.slice(queryStart + 1, queryEnd);
	const sensitiveValues: string[] = [];
	const redactedQuery = query
		.split("&")
		.map((part) => {
			const assignment = part.indexOf("=");
			const encodedKey = assignment === -1 ? part : part.slice(0, assignment);
			if (!names.has(decodeQueryComponent(encodedKey))) return part;
			const encodedValue = assignment === -1 ? "" : part.slice(assignment + 1);
			sensitiveValues.push(decodeQueryComponent(encodedValue));
			return `${encodedKey}=${REDACTED_QUERY_VALUE}`;
		})
		.join("&");
	return {
		redactedUrl: `${url.slice(0, queryStart + 1)}${redactedQuery}${url.slice(queryEnd)}`,
		sensitiveValues,
	};
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

	const sensitiveParamNames = Object.keys(sensitiveParams);
	const existing = redactUrlQueryParams(urlWithParams, sensitiveParamNames);
	const sensitiveValues = new Set(existing.sensitiveValues);
	let requestUrl = urlWithParams;

	for (const [key, value] of Object.entries(sensitiveParams)) {
		const serializedValue = String(value);
		requestUrl = appendQueryParams(requestUrl, { [key]: serializedValue });
		sensitiveValues.add(serializedValue);
	}
	const redacted = redactUrlQueryParams(requestUrl, sensitiveParamNames);

	return {
		requestUrl,
		redactedUrl: redacted.redactedUrl,
		sensitiveValues: [...sensitiveValues],
	};
}

const MIN_UNSCOPED_SENSITIVE_VALUE_LENGTH = 4;

function normalizePercentEscapes(value: string): string {
	return value.replace(/%[\da-f]{2}/gi, (percentEscape) => percentEscape.toUpperCase());
}

function sensitiveValueVariants(value: string): string[] {
	if (!value || value === REDACTED_QUERY_VALUE) return [];

	const formEncoded = new URLSearchParams({ value }).toString().slice("value=".length);
	const componentEncoded = encodeURIComponent(value);
	return [...new Set([value, componentEncoded, formEncoded].map(normalizePercentEscapes))];
}

type SensitiveValueVariant = { value: string; requiresTokenBoundary: boolean };

function allSensitiveValueVariants(
	sensitiveValues: readonly string[],
	requireTokenBoundary: boolean,
): SensitiveValueVariant[] {
	const variants = new Map<string, SensitiveValueVariant>();
	for (const sensitiveValue of sensitiveValues) {
		const requiresTokenBoundary =
			requireTokenBoundary || sensitiveValue.length < MIN_UNSCOPED_SENSITIVE_VALUE_LENGTH;
		for (const value of sensitiveValueVariants(sensitiveValue)) {
			const existing = variants.get(value);
			variants.set(value, {
				value,
				requiresTokenBoundary: existing
					? existing.requiresTokenBoundary && requiresTokenBoundary
					: requiresTokenBoundary,
			});
		}
	}
	return [...variants.values()].sort(
		(left, right) =>
			right.value.length - left.value.length || left.value.localeCompare(right.value),
	);
}

function isTokenCharacter(value: string | undefined): boolean {
	return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function replaceSensitiveVariant(text: string, variant: SensitiveValueVariant): string {
	const normalizedNeedle = normalizePercentEscapes(variant.value);
	let result = text;
	let fromIndex = 0;
	while (fromIndex <= result.length - variant.value.length) {
		const normalizedText = normalizePercentEscapes(result);
		const index = normalizedText.indexOf(normalizedNeedle, fromIndex);
		if (index === -1) break;
		const end = index + variant.value.length;
		if (
			variant.requiresTokenBoundary &&
			(isTokenCharacter(result[index - 1]) || isTokenCharacter(result[end]))
		) {
			fromIndex = index + 1;
			continue;
		}
		result = `${result.slice(0, index)}${REDACTED_QUERY_VALUE}${result.slice(end)}`;
		fromIndex = index + REDACTED_QUERY_VALUE.length;
	}
	return result;
}

/** Scrubs raw and URL-encoded secret values from diagnostic text. */
export function redactSensitiveText(
	text: string,
	sensitiveValues: readonly string[],
	requestUrl?: string,
	redactedUrl?: string,
	options: { requireTokenBoundary?: boolean } = {},
): string {
	let redacted = requestUrl && redactedUrl ? text.replaceAll(requestUrl, redactedUrl) : text;
	for (const variant of allSensitiveValueVariants(
		sensitiveValues,
		options.requireTokenBoundary === true,
	)) {
		// Low-entropy values are still redacted, but only as complete tokens. This
		// covers query values and diagnostic phrases such as "credential api rejected"
		// without corrupting timestamps or words such as "rapid".
		redacted = replaceSensitiveVariant(redacted, variant);
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
	const keys = new Set(Object.getOwnPropertyNames(value));
	if (value instanceof Error) {
		// Built-in error text and AggregateError.errors are commonly
		// non-enumerable, while SDK options carry serializable details.
		for (const key of ["name", "message", "stack", "cause", "errors", "options"] as const) {
			if (key in value) keys.add(key);
		}
	}
	return [...keys];
}

function requiresCloneBeforeRedaction(value: object, keys: readonly string[]): boolean {
	for (const key of keys) {
		let owner: object | null = value;
		while (owner) {
			const descriptor = Object.getOwnPropertyDescriptor(owner, key);
			if (descriptor) {
				if (Object.hasOwn(descriptor, "value")) {
					if (owner === value && descriptor.writable === false) return true;
				} else if (descriptor.set === undefined) {
					return true;
				}
				break;
			}
			owner = Object.getPrototypeOf(owner);
		}
	}
	return false;
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

const DIAGNOSTIC_CLASSIFICATION_FIELDS = new Set(["name", "code", "status", "upstreamStatus"]);

function redactDiagnosticValue(
	value: unknown,
	context: RedactionContext,
	propertyName?: string,
): unknown {
	if (propertyName && DIAGNOSTIC_CLASSIFICATION_FIELDS.has(propertyName)) return value;
	if (typeof value === "string") return redactDiagnosticString(value, context);
	if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;

	const previouslySeen = context.seen.get(value);
	if (previouslySeen !== undefined) return previouslySeen;

	// Clone non-extensible graphs before descending so cycles encountered before
	// a secret-bearing readonly field already point at the eventual replacement.
	// Without this, a frozen `error.cause = error` graph could retain the original
	// secret through the cloned node's earlier self-reference.
	const keys = diagnosticPropertyKeys(value);
	let target: object =
		Object.isExtensible(value) && !requiresCloneBeforeRedaction(value, keys)
			? value
			: cloneForRedaction(value);
	context.seen.set(value, target);

	for (const key of keys) {
		const current = readDiagnosticProperty(value, key);
		if (!current.ok) continue;
		const redacted = redactDiagnosticValue(current.value, context, key);
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
	method: PropertyKey,
	args: readonly unknown[],
): RequestOptions | undefined {
	if (!isHttpRequestMethod(method)) return undefined;
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
