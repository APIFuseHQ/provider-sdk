import type { ProxyResolutionOptions } from "../config/loader.js";
import {
	policyRotatesTransportVendorChain,
	resolvePolicyTransportAttemptCap,
	resolveProxyConfigAsync,
} from "../config/loader.js";
import { HttpRedirectError, ProviderError, TransportError } from "../errors.js";
import { parseSseStream, readableBytes, readableLines, readableTextChunks } from "../stream.js";
import type {
	HttpClient,
	HttpMethod,
	HttpRedirectPolicy,
	HttpResponse,
	HttpRetrySummary,
	HttpStreamResponse,
	ProviderProxyPolicy,
	RequestOptions,
	RequestWithMethodOptions,
	SseMessage,
} from "../types.js";
import {
	computeProxyAttemptIndex,
	computeProxyTransportRetryDelayMs,
	createDefaultProxyTransportRetryOptions,
	isProxyTransportRetryMethod,
	normalizeProxyTransportRetryOptions,
	proxyTransportRetryErrorCode,
	proxyTransportRetryErrorStatus,
	shouldRetryProxyTransportAttempt,
	validateUnsafeProxyTransportRetryMethods,
} from "./proxy-retry-policy.js";
import { evaluateRedirectHop, isRedirectStatus, resolveRedirectUrl } from "./redirects.js";
import {
	normalizeHttpRequestBody,
	redactSensitiveError,
	redactSensitiveRequestError,
	type SerializedRequestUrl,
	serializeRequestUrl,
} from "./request-options.js";

const DEFAULT_HTTP_BASE_URL = "http://localhost";

export type HttpClientOptions = ProxyResolutionOptions & {
	warn?: (message: string) => void;
	userAgent?: string;
	onRetrySummary?: (summary: HttpRetrySummary) => void;
	signal?: AbortSignal;
};

type HttpStatusOutcome = {
	kind: "http-status";
	status: number;
	headers: Record<string, string>;
	retryable: boolean;
	proxyUsed: boolean;
};

/**
 * Sentinel returned when a policy-allocator attempt resolved an endpoint that a
 * prior attempt already tried (an under-filled pool repeats endpoints via the
 * modulo mapping before the flat offset crosses into the next vendor). The retry
 * loop advances to the next offset rather than re-issuing the request — but does
 * NOT treat it as chain exhaustion, so the offset still walks into the fallback
 * vendor's span.
 */
type NativeHttpSkipOutcome = { kind: "dedupe-skip" };

type NativeHttpAttemptOutcome = HttpResponse | HttpStatusOutcome | NativeHttpSkipOutcome;

type NativeHttpAttemptError = TransportError & { proxyUsed?: boolean };

function isHttpStatusOutcome(outcome: NativeHttpAttemptOutcome): outcome is HttpStatusOutcome {
	return "kind" in outcome && outcome.kind === "http-status";
}

function isDedupeSkipOutcome(outcome: NativeHttpAttemptOutcome): outcome is NativeHttpSkipOutcome {
	return "kind" in outcome && outcome.kind === "dedupe-skip";
}

function toAmbientCancellationError(
	signal: AbortSignal,
	error: unknown = signal.reason,
): TransportError {
	if (error instanceof TransportError && error.code === "transport_cancelled") {
		return error;
	}
	return new TransportError("Request cancelled", {
		code: "transport_cancelled",
		status: 0,
		retryable: false,
		...(error !== undefined
			? { cause: error instanceof Error ? error : new Error(String(error)) }
			: {}),
	});
}

function throwIfAmbientAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw toAmbientCancellationError(signal);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	throwIfAmbientAborted(signal);
	if (ms <= 0) return;
	if (!signal) {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(toAmbientCancellationError(signal));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function toUpstreamHttpError(status: number): TransportError {
	return new TransportError(`Upstream request failed with status ${status}`, {
		code: "upstream_http_error",
		status,
		upstreamStatus: status,
	});
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const needle = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === needle);
}

function withClientHeaders(
	options: RequestOptions | undefined,
	clientOptions: HttpClientOptions,
	body: unknown,
): RequestOptions {
	const headers: Record<string, string> = {
		...(clientOptions.userAgent ? { "User-Agent": clientOptions.userAgent } : {}),
		...options?.headers,
	};

	if (body !== undefined && !hasHeader(headers, "Content-Type")) {
		headers["Content-Type"] = "application/json";
	}

	return {
		...options,
		headers,
	};
}

function parseHttpData(body: string, headers: Record<string, string>): unknown {
	const contentType = headers["content-type"] ?? headers["Content-Type"] ?? headers["CONTENT-TYPE"];

	if (contentType?.includes("application/json")) {
		return body ? JSON.parse(body) : null;
	}

	return body;
}

function parseJson<T = unknown>(body: string): T {
	return JSON.parse(body);
}

function isTimeoutMessage(message: string): boolean {
	return /\b(timed out|timeout|deadline exceeded)\b/i.test(message);
}

function toHttpTransportError(
	error: unknown,
	ambientSignal?: AbortSignal,
	timeoutSignal?: AbortSignal,
): TransportError {
	if (ambientSignal?.aborted) {
		return toAmbientCancellationError(ambientSignal, error);
	}
	if (timeoutSignal?.aborted) {
		return new TransportError("Request timed out", {
			code: "transport_timeout",
			status: 0,
			...(error instanceof Error ? { cause: error } : {}),
		});
	}
	if (error instanceof TransportError) {
		if (error.code) {
			return error;
		}

		if (isTimeoutMessage(error.message)) {
			return new TransportError("Request timed out", {
				code: "transport_timeout",
				status: error.status ?? 0,
				cause: error,
			});
		}

		if ((error.status ?? 0) === 0) {
			return new TransportError(error.message || "Network error", {
				code: "transport_network_error",
				status: 0,
				cause: error,
			});
		}

		return error;
	}

	if (error instanceof Error) {
		const timeout =
			error.name === "AbortError" ||
			error.name === "TimeoutError" ||
			isTimeoutMessage(error.message);
		return new TransportError(timeout ? "Request timed out" : "Network error", {
			code: timeout ? "transport_timeout" : "transport_network_error",
			status: 0,
			cause: error,
		});
	}

	return new TransportError("Network error", {
		code: "transport_network_error",
		status: 0,
	});
}

async function toNativeHttpResponse(response: Response): Promise<HttpResponse> {
	const headers = Object.fromEntries(response.headers.entries());
	const bodyBytes = new Uint8Array(await response.arrayBuffer());
	const rawText = new TextDecoder().decode(bodyBytes);
	const data = parseHttpData(rawText, headers);

	return {
		data,
		headers,
		json: async <T = unknown>() => {
			const contentType =
				headers["content-type"] ?? headers["Content-Type"] ?? headers["CONTENT-TYPE"];
			return parseJson<T>(contentType?.includes("application/json") && !rawText ? "null" : rawText);
		},
		ok: response.status >= 200 && response.status < 300,
		status: response.status,
		text: async () => rawText,
		arrayBuffer: async () =>
			bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength),
		bytes: async () => bodyBytes.slice(0),
	};
}

async function drainNativeResponseBody(response: Response): Promise<void> {
	try {
		await response.arrayBuffer();
	} catch {
		await response.body?.cancel().catch(() => undefined);
	}
}

function requireNativeResponseBody(response: Response): ReadableStream<Uint8Array> {
	if (!response.body) {
		throw new TransportError("Response body stream is unavailable", {
			code: "transport_stream_unavailable",
			status: response.status,
		});
	}
	return response.body;
}

function mergeAbortSignals(
	...signals: Array<AbortSignal | null | undefined>
): AbortSignal | undefined {
	const activeSignals = signals.filter((signal): signal is AbortSignal => signal != null);
	if (activeSignals.length === 0) return undefined;
	if (activeSignals.length === 1) return activeSignals[0];
	return AbortSignal.any(activeSignals);
}

function cancelStreamOnAbort(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
	if (!signal) return body;

	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let finished = false;
	let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
	const cleanup = () => signal.removeEventListener("abort", onAbort);
	const onAbort = () => {
		if (finished) return;
		finished = true;
		cleanup();
		const reason = toAmbientCancellationError(signal);
		streamController?.error(reason);
		const cancellation = reader ? reader.cancel(reason) : body.cancel(reason);
		void cancellation.catch(() => undefined).finally(() => reader?.releaseLock());
	};

	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				streamController = controller;
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			},
			async pull(controller) {
				try {
					reader ??= body.getReader();
					const chunk = await reader.read();
					if (finished) return;
					if (chunk.done) {
						finished = true;
						cleanup();
						controller.close();
						reader.releaseLock();
						return;
					}
					controller.enqueue(chunk.value);
				} catch (error) {
					if (finished) return;
					finished = true;
					cleanup();
					controller.error(error);
					reader?.releaseLock();
				}
			},
			async cancel(reason) {
				if (finished) return;
				finished = true;
				cleanup();
				try {
					await (reader ? reader.cancel(reason) : body.cancel(reason));
				} finally {
					reader?.releaseLock();
				}
			},
		},
		{ highWaterMark: 0 },
	);
}

function sanitizeStreamErrors(
	body: ReadableStream<Uint8Array>,
	serializedUrl: SerializedRequestUrl,
): ReadableStream<Uint8Array> {
	if (serializedUrl.sensitiveValues.length === 0) return body;

	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					reader ??= body.getReader();
					const chunk = await reader.read();
					if (chunk.done) {
						controller.close();
						return;
					}
					controller.enqueue(chunk.value);
				} catch (error) {
					controller.error(
						redactSensitiveError(
							error,
							serializedUrl.sensitiveValues,
							serializedUrl.requestUrl,
							serializedUrl.redactedUrl,
						),
					);
				}
			},
			async cancel(reason) {
				try {
					await (reader ? reader.cancel(reason) : body.cancel(reason));
				} catch (error) {
					throw redactSensitiveError(
						error,
						serializedUrl.sensitiveValues,
						serializedUrl.requestUrl,
						serializedUrl.redactedUrl,
					);
				}
			},
		},
		{ highWaterMark: 0 },
	);
}

function toNativeHttpStreamResponse(
	response: Response,
	serializedUrl: SerializedRequestUrl,
	signal?: AbortSignal,
): HttpStreamResponse {
	const headers = Object.fromEntries(response.headers.entries());
	const body = sanitizeStreamErrors(
		cancelStreamOnAbort(requireNativeResponseBody(response), signal),
		serializedUrl,
	);
	return {
		body,
		headers,
		ok: response.status >= 200 && response.status < 300,
		status: response.status,
		bytes: () => readableBytes(body),
		textChunks: () => readableTextChunks(body),
		lines: () => readableLines(body),
	};
}

function normalizeHttpMethod(method: string): HttpMethod {
	switch (method.toUpperCase()) {
		case "HEAD":
			return "HEAD";
		case "GET":
			return "GET";
		case "POST":
			return "POST";
		case "PUT":
			return "PUT";
		case "DELETE":
			return "DELETE";
		case "OPTIONS":
			return "OPTIONS";
		case "TRACE":
			return "TRACE";
		case "PATCH":
			return "PATCH";
		default:
			throw new TransportError(`Unsupported HTTP method: ${method}`, {
				code: "transport_invalid_method",
			});
	}
}

function isAbsoluteUrl(url: string): boolean {
	return /^[a-z][a-z\d+\-.]*:/i.test(url);
}

function resolveHttpUrl(baseUrl: string | undefined, url: string): string {
	return new URL(url, baseUrl ?? DEFAULT_HTTP_BASE_URL).toString();
}

type NativeFetchInit = RequestInit & { proxy?: string };

const MAX_HTTP_REDIRECT_HOPS = 20;
const HTTP_REDIRECT_POLICY_FIELDS = new Set(["mode", "maxHops"]);
const REDIRECT_BODY_HEADERS = new Set([
	"content-encoding",
	"content-language",
	"content-location",
	"content-type",
]);
const MALFORMED_REDIRECT_TARGET = "[malformed redirect target]";

function invalidHttpRedirectPolicy(message: string, cause?: Error): TransportError {
	return new TransportError(`Invalid ctx.http redirectPolicy: ${message}`, {
		code: "http_redirect_policy_invalid",
		...(cause ? { cause } : {}),
	});
}

/** Snapshot untrusted caller input synchronously, before proxy resolution or fetch. */
function normalizeHttpRedirectPolicy(value: unknown): HttpRedirectPolicy | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw invalidHttpRedirectPolicy("expected an object");
	}

	try {
		const keys = Reflect.ownKeys(value);
		for (const key of keys) {
			if (typeof key !== "string" || !HTTP_REDIRECT_POLICY_FIELDS.has(key)) {
				throw invalidHttpRedirectPolicy(`unknown field ${String(key)}`);
			}
		}
		for (const field of HTTP_REDIRECT_POLICY_FIELDS) {
			const descriptor = Object.getOwnPropertyDescriptor(value, field);
			if (!descriptor || !("value" in descriptor)) {
				throw invalidHttpRedirectPolicy(`${field} must be an own data property`);
			}
		}

		const record = value as Record<string, unknown>;
		if (record.mode !== "same-origin") {
			throw invalidHttpRedirectPolicy('mode must be "same-origin"');
		}
		if (
			typeof record.maxHops !== "number" ||
			!Number.isInteger(record.maxHops) ||
			record.maxHops < 0 ||
			record.maxHops > MAX_HTTP_REDIRECT_HOPS
		) {
			throw invalidHttpRedirectPolicy(
				`maxHops must be an integer from 0 to ${MAX_HTTP_REDIRECT_HOPS}`,
			);
		}

		return { mode: "same-origin", maxHops: record.maxHops };
	} catch (error) {
		if (error instanceof TransportError) throw error;
		throw invalidHttpRedirectPolicy(
			"could not be inspected safely",
			error instanceof Error ? error : undefined,
		);
	}
}

function snapshotHttpRedirectPolicy(options: RequestOptions): HttpRedirectPolicy | undefined {
	try {
		return normalizeHttpRedirectPolicy(options.redirectPolicy);
	} catch (error) {
		if (error instanceof TransportError) throw error;
		throw invalidHttpRedirectPolicy(
			"could not be read safely",
			error instanceof Error ? error : undefined,
		);
	}
}

function withoutRedirectBodyHeaders(headers: HeadersInit | undefined): Headers {
	const nextHeaders = new Headers(headers);
	for (const name of REDIRECT_BODY_HEADERS) nextHeaders.delete(name);
	return nextHeaders;
}

function redirectDiagnosticTarget(value: string): string {
	try {
		const parsed = new URL(value);
		// Origin omits URL userinfo. Keeping only origin + path makes diagnostics
		// useful while structurally excluding every query value and fragment,
		// including attacker-chosen keys the provider did not declare sensitive.
		const redactedQuery = parsed.search ? "?[REDACTED]" : "";
		return parsed.origin === "null"
			? `${parsed.protocol}<opaque-target>`
			: `${parsed.origin}${parsed.pathname}${redactedQuery}`;
	} catch {
		return MALFORMED_REDIRECT_TARGET;
	}
}

function discardRedirectResponseBody(response: Response): void {
	try {
		const cancellation = response.body?.cancel();
		if (cancellation) void cancellation.catch(() => undefined);
	} catch {
		// The redirect decision is security-significant and must not be replaced
		// or delayed by an upstream body's cancellation failure. Cancellation was
		// attempted; redirect evaluation continues without awaiting its completion.
	}
}

async function fetchWithHttpRedirectPolicy(
	requestUrl: string,
	requestInit: NativeFetchInit,
	policy: HttpRedirectPolicy | undefined,
): Promise<Response> {
	if (!policy) return fetch(requestUrl, requestInit);

	const initialUrl = new URL(requestUrl);
	if (initialUrl.protocol !== "http:" && initialUrl.protocol !== "https:") {
		throw new TransportError("ctx.http redirectPolicy requires an HTTP(S) origin", {
			code: "transport_invalid_url",
		});
	}

	const initialOrigin = initialUrl.origin;
	let currentUrl = requestUrl;
	let method = normalizeHttpMethod(requestInit.method ?? "GET");
	let body = requestInit.body;
	let headers = requestInit.headers;
	let followedHops = 0;
	const visitedRequests = new Set([`${method} ${currentUrl}`]);

	while (true) {
		const response = await fetch(currentUrl, {
			...requestInit,
			body,
			headers,
			method,
			redirect: "manual",
		});
		if (!isRedirectStatus(response.status)) return response;

		const location = response.headers.get("location");
		discardRedirectResponseBody(response);
		let nextUrlString: string | undefined;
		try {
			nextUrlString = resolveRedirectUrl(location || undefined, currentUrl);
		} catch {
			const target = MALFORMED_REDIRECT_TARGET;
			throw new HttpRedirectError(`Redirect response has malformed Location target ${target}`, {
				reason: "missing_location",
				target,
				status: response.status,
			});
		}

		const decision = evaluateRedirectHop({
			status: response.status,
			method,
			nextUrl: nextUrlString,
			shouldStop: nextUrlString ? new URL(nextUrlString).origin !== initialOrigin : false,
			redirectCount: followedHops + 1,
			maxHops: policy.maxHops,
			visitedRequests,
		});
		if (decision.kind === "stop") {
			const target = decision.nextUrl ? redirectDiagnosticTarget(decision.nextUrl) : undefined;
			const message = (() => {
				switch (decision.reason) {
					case "stopped":
						return `Redirect policy refused cross-origin target ${target}`;
					case "max_hops":
						return `Redirect policy reached maxHops before target ${target}`;
					case "loop":
						return `Redirect loop refused target ${target}`;
					case "missing_location":
						return `Redirect response from ${redirectDiagnosticTarget(currentUrl)} is missing Location`;
			}
			})();
			throw new HttpRedirectError(message, {
				reason: decision.reason,
				...(target ? { target } : {}),
				status: response.status,
			});
		}
		if (decision.nextMethod !== method) {
			body = undefined;
			headers = withoutRedirectBodyHeaders(headers);
		}

		method = decision.nextMethod;
		currentUrl = decision.nextUrl;
		followedHops += 1;
		visitedRequests.add(`${method} ${currentUrl}`);
	}
}

async function resolveNativeProxy(
	options: RequestOptions,
	clientOptions: HttpClientOptions,
	warn: (message: string) => void,
	proxyAttemptOffset = 0,
): Promise<string | undefined> {
	const resolvedProxy = await resolveProxyConfigAsync({
		proxy: options.proxy ?? clientOptions.proxy,
		upstream: clientOptions.upstream,
		proxyPolicy: clientOptions.proxyPolicy,
		affinityKey: clientOptions.affinityKey,
		proxyAttempt: computeProxyAttemptIndex({
			baseProxyAttempt: clientOptions.proxyAttempt,
			retryAttemptOffset: proxyAttemptOffset,
		}),
		// Bun's native fetch proxy option tunnels HTTP CONNECT only; SOCKS5 is not
		// supported here, so a socks5 policy fails loudly rather than downgrading.
		transportProtocols: ["http"],
		telemetry: clientOptions.telemetry,
	});
	if (resolvedProxy.shouldWarn) {
		warn(
			"[provider-sdk] Provider requested proxy routing, but no proxy URL was configured. Continuing without proxy.",
		);
	}
	return resolvedProxy.url;
}

function assertNoHttpTransportOverrides(options: RequestOptions): void {
	if ("profile" in options || "stealth" in options) {
		throw new ProviderError(
			"ctx.http does not accept stealth transport options. Use ctx.stealth.fetch() for browser-like impersonation.",
			{ code: "http_transport_override_unsupported" },
		);
	}
}

function normalizeNativeFetchBody(body: unknown): string | ArrayBuffer | undefined {
	const normalized = normalizeHttpRequestBody(body);
	if (!Buffer.isBuffer(normalized)) {
		return normalized;
	}
	const copied = new Uint8Array(normalized.byteLength);
	copied.set(normalized);
	return copied.buffer;
}

function serializeHttpRequestUrl(
	baseUrl: string | undefined,
	url: string,
	options: RequestOptions,
): SerializedRequestUrl {
	try {
		return serializeRequestUrl(
			resolveHttpUrl(baseUrl, url),
			options.params,
			options.sensitiveParams,
		);
	} catch (error) {
		throw redactSensitiveRequestError(error, url, options.sensitiveParams);
	}
}

async function fetchNativeHttp(
	baseUrl: string | undefined,
	url: string,
	method: HttpMethod,
	options: RequestOptions & { body?: unknown },
	clientOptions: HttpClientOptions,
	warn: (message: string) => void,
	statusRetryCodes?: readonly number[],
	proxyAttemptOffset = 0,
	dedupe?: { attempted: Set<string> },
): Promise<NativeHttpAttemptOutcome> {
	const serializedUrl = serializeHttpRequestUrl(baseUrl, url, options);
	const { requestUrl } = serializedUrl;
	const controller = options.timeout ? new AbortController() : undefined;
	const signal = mergeAbortSignals(clientOptions.signal, controller?.signal);
	const timeoutHandle = options.timeout
		? setTimeout(() => controller?.abort(), options.timeout)
		: undefined;

	let proxy: string | undefined;
	try {
		throwIfAmbientAborted(clientOptions.signal);
		// Resolve inside the try (and after the timeout is armed) so allocator
		// failures are branded as TransportErrors and count against the request
		// deadline, exactly as an inline resolve would.
		proxy = await resolveNativeProxy(options, clientOptions, warn, proxyAttemptOffset);
		throwIfAmbientAborted(clientOptions.signal);
		// For a registry allocator chain, skip an endpoint a prior attempt already
		// tried rather than re-issuing the same request. Returning the sentinel
		// (instead of breaking) lets the loop keep advancing the flat offset until
		// it crosses into the fallback vendor's pool span.
		if (dedupe && proxy) {
			if (dedupe.attempted.has(proxy)) {
				return { kind: "dedupe-skip" };
			}
			dedupe.attempted.add(proxy);
		}
		const requestInit: NativeFetchInit = {
			headers: options.headers,
			method,
			...(proxy ? { proxy } : {}),
			...(signal ? { signal } : {}),
		};
		if (options.body !== undefined) {
			requestInit.body = normalizeNativeFetchBody(options.body);
		}
		const response = await fetchWithHttpRedirectPolicy(
			requestUrl,
			requestInit,
			options.redirectPolicy,
		);
		const headers = Object.fromEntries(response.headers.entries());

		if (statusRetryCodes && response.status >= 400) {
			await drainNativeResponseBody(response);
			return {
				kind: "http-status",
				status: response.status,
				headers,
				retryable: statusRetryCodes.includes(response.status),
				proxyUsed: Boolean(proxy),
			};
		}

		if (response.status >= 400 && options.throwOnHttpError !== false) {
			await drainNativeResponseBody(response);
			throw new TransportError(`Upstream request failed with status ${response.status}`, {
				code: "upstream_http_error",
				status: response.status,
			});
		}

		return toNativeHttpResponse(response);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw redactSensitiveError(
				error,
				serializedUrl.sensitiveValues,
				serializedUrl.requestUrl,
				serializedUrl.redactedUrl,
			);
		}
		const transportError: NativeHttpAttemptError = redactSensitiveError(
			toHttpTransportError(error, clientOptions.signal, controller?.signal),
			serializedUrl.sensitiveValues,
			serializedUrl.requestUrl,
			serializedUrl.redactedUrl,
		);
		transportError.proxyUsed = Boolean(proxy);
		throw transportError;
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}

async function fetchNativeHttpStream(
	baseUrl: string | undefined,
	url: string,
	method: HttpMethod,
	options: RequestOptions & { body?: unknown },
	clientOptions: HttpClientOptions,
	warn: (message: string) => void,
): Promise<HttpStreamResponse> {
	const serializedUrl = serializeHttpRequestUrl(baseUrl, url, options);
	const { requestUrl } = serializedUrl;
	const controller = options.timeout ? new AbortController() : undefined;
	const signal = mergeAbortSignals(clientOptions.signal, controller?.signal);
	const timeoutHandle = options.timeout
		? setTimeout(() => controller?.abort(), options.timeout)
		: undefined;

	try {
		throwIfAmbientAborted(clientOptions.signal);
		const proxy = await resolveNativeProxy(options, clientOptions, warn);
		throwIfAmbientAborted(clientOptions.signal);
		const requestInit: NativeFetchInit = {
			headers: options.headers,
			method,
			...(proxy ? { proxy } : {}),
			...(signal ? { signal } : {}),
		};
		if (options.body !== undefined) {
			requestInit.body = normalizeNativeFetchBody(options.body);
		}
		const response = await fetchWithHttpRedirectPolicy(
			requestUrl,
			requestInit,
			options.redirectPolicy,
		);

		if (response.status >= 400 && options.throwOnHttpError !== false) {
			await drainNativeResponseBody(response);
			throw new TransportError(`Upstream request failed with status ${response.status}`, {
				code: "upstream_http_error",
				status: response.status,
			});
		}

		// Per-call timeout remains header-scoped, while the ambient request signal
		// stays attached to the response body for its full consumption lifetime.
		return toNativeHttpStreamResponse(response, serializedUrl, clientOptions.signal);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw redactSensitiveError(
				error,
				serializedUrl.sensitiveValues,
				serializedUrl.requestUrl,
				serializedUrl.redactedUrl,
			);
		}
		throw redactSensitiveError(
			toHttpTransportError(error, clientOptions.signal, controller?.signal),
			serializedUrl.sensitiveValues,
			serializedUrl.requestUrl,
			serializedUrl.redactedUrl,
		);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}

export function createHttpClient(
	baseUrl?: string,
	clientOptions: HttpClientOptions = {},
): HttpClient {
	const warnedMessages = new Set<string>();
	const warn = clientOptions.warn ?? console.warn;
	const warnOnce = (message: string) => {
		if (warnedMessages.has(message)) {
			return;
		}
		warnedMessages.add(message);
		warn(message);
	};

	async function request(
		url: string,
		method: string,
		options: RequestOptions & { body?: unknown } = {},
	): Promise<HttpResponse> {
		const { explicitRetry, headersOptions, methodName, retryOptions } = (() => {
			try {
				if (!baseUrl && !isAbsoluteUrl(url)) {
					throw new TransportError(
						"ctx.http requires an absolute URL when provider.upstream.baseUrl is not declared",
						{ code: "transport_invalid_url" },
					);
				}
				assertNoHttpTransportOverrides(options);
				const redirectPolicy = snapshotHttpRedirectPolicy(options);
				const headersOptions = {
					...withClientHeaders(options, clientOptions, options.body),
					redirectPolicy,
				};
				const methodName = normalizeHttpMethod(method);
				const explicitRetry = headersOptions.retry !== undefined;
				const retryOptions =
					normalizeProxyTransportRetryOptions(headersOptions.retry, {
						label: "HTTP",
					}) ??
					(explicitRetry ? undefined : createDefaultProxyTransportRetryOptions({ label: "HTTP" }));
				if (retryOptions) validateUnsafeProxyTransportRetryMethods(retryOptions, "HTTP");
				return { explicitRetry, headersOptions, methodName, retryOptions };
			} catch (error) {
				throw redactSensitiveRequestError(error, url, options.sensitiveParams);
			}
		})();
		const retryEnabled = Boolean(
			retryOptions &&
				retryOptions.attempts > 1 &&
				isProxyTransportRetryMethod(methodName, retryOptions),
		);
		const statusRetryEnabled = Boolean(
			retryEnabled &&
				explicitRetry &&
				retryOptions &&
				retryOptions.statusCodes.length > 0 &&
				headersOptions.throwOnHttpError !== false,
		);
		const attemptOptions: RequestOptions & { body?: unknown } = statusRetryEnabled
			? { ...headersOptions, throwOnHttpError: false }
			: headersOptions;

		// Span the whole vendor chain on transport failures. Like ctx.stealth, a
		// policy-managed proxy resolves a *different* endpoint/vendor per attempt
		// (the flat proxyAttemptOffset rotates across the concatenated vendor pool
		// spans), so a transport failure should advance to the next endpoint —
		// potentially crossing into the fallback vendor — rather than stopping at
		// the per-endpoint retry budget and stranding the request on the primary
		// vendor. resolvePolicyTransportAttemptCap widens the cap to the chain span
		// only for implicit, safe-method allocator requests; explicit retry
		// policies (their documented `attempts` ceiling), unsafe methods, and
		// static/non-registry vendors keep the retry budget. Status-code retries
		// stay bounded by the retry budget regardless; only transport rotation gets
		// the full span.
		const policyProxy: ProviderProxyPolicy | undefined = (() => {
			const policy = clientOptions.proxyPolicy ?? clientOptions.upstream?.proxy;
			return policy && typeof policy === "object" ? policy : undefined;
		})();
		const usesPolicyAllocator = Boolean(policyProxy) && !options.proxy && !clientOptions.proxy;
		const transportAttemptCap = retryOptions
			? resolvePolicyTransportAttemptCap({
					policy: policyProxy,
					usesPolicyAllocator,
					retryAttempts: retryOptions.attempts,
					explicitRetry,
					method: methodName,
				})
			: 1;

		// Track resolved endpoints across a policy-allocator chain. Successive
		// attempts rotate the flat offset across the concatenated vendor pool
		// spans, but an under-filled allocation (fewer live endpoints than the
		// configured pool size) makes the modulo mapping repeat endpoints before
		// the offset reaches the next vendor. Rather than re-hammering an
		// already-tried endpoint under backoff, fetchNativeHttp returns a skip
		// sentinel for a duplicate; the loop then advances the flat offset without
		// issuing the request, so it keeps walking toward — and into — the fallback
		// vendor's pool span instead of stalling on the primary vendor.
		// De-duplication is gated on the SAME predicate that widens the attempt cap
		// (implicit, safe-method, registry-chain rotation). It must NOT engage for
		// an explicit retry policy: there the caller's `attempts` count is the
		// contract and each attempt must issue against whatever endpoint it resolves
		// — even a repeat — instead of being silently skipped (which would collapse
		// a `poolSize: 1` + `attempts: 3` request to a single fetch).
		const dedupeAllocatorEndpoints = policyRotatesTransportVendorChain({
			policy: policyProxy,
			usesPolicyAllocator,
			explicitRetry,
			method: methodName,
		});
		const dedupeContext = dedupeAllocatorEndpoints ? { attempted: new Set<string>() } : undefined;

		const executeOnce = (proxyAttemptOffset = 0): Promise<NativeHttpAttemptOutcome> =>
			fetchNativeHttp(
				baseUrl,
				url,
				methodName,
				attemptOptions,
				clientOptions,
				warnOnce,
				statusRetryEnabled ? retryOptions?.statusCodes : undefined,
				proxyAttemptOffset,
				dedupeContext,
			);

		if (!retryEnabled || !retryOptions) {
			throwIfAmbientAborted(clientOptions.signal);
			const outcome = await executeOnce();
			if (isDedupeSkipOutcome(outcome)) {
				// Single-shot path never de-duplicates (dedupeContext is undefined),
				// but keep the union total.
				throw new TransportError("HTTP request produced no terminal result", {
					code: "retry_exhausted",
				});
			}
			if (isHttpStatusOutcome(outcome)) {
				throw toUpstreamHttpError(outcome.status);
			}
			return outcome;
		}

		let lastError: unknown;
		let lastErrorCode: string | undefined;
		let lastStatus: number | undefined;
		// `attempt` walks the flat proxy offset across the full chain span; `issued`
		// counts requests that were actually sent (skipped duplicate offsets do not
		// increment it). Retry summaries and the status-retry budget must reflect
		// issued requests, not the raw offset, so they stay accurate when partial
		// allocations skip offsets.
		let issued = 0;
		for (let attempt = 1; attempt <= transportAttemptCap; attempt += 1) {
			throwIfAmbientAborted(clientOptions.signal);
			// Whether this offset actually issued a request (vs. a skipped duplicate),
			// so the catch counts a thrown *transport* failure once without
			// double-counting a status outcome that already incremented before it
			// re-threw as an upstream HTTP error.
			let issuedThisAttempt = false;
			try {
				const outcome = await executeOnce(attempt - 1);
				if (isDedupeSkipOutcome(outcome)) {
					// Duplicate endpoint from a partial allocation: advance the flat
					// offset without issuing the request (no backoff, not a failure) so
					// the loop keeps rotating toward the fallback vendor.
					continue;
				}
				issued += 1;
				issuedThisAttempt = true;
				if (isHttpStatusOutcome(outcome)) {
					lastStatus = outcome.status;
					if (outcome.retryable && issued < retryOptions.attempts) {
						await sleep(
							computeProxyTransportRetryDelayMs(retryOptions, attempt, outcome.headers),
							clientOptions.signal,
						);
						continue;
					}
					throw toUpstreamHttpError(outcome.status);
				}

				const response = outcome;
				if (response.status >= 400 && headersOptions.throwOnHttpError !== false) {
					throw toUpstreamHttpError(response.status);
				}

				if (issued > 1) {
					const summary: HttpRetrySummary = {
						attempts: issued,
						retries: issued - 1,
						...(retryOptions.preset ? { preset: retryOptions.preset } : {}),
						transport: "native",
						...(lastErrorCode ? { lastErrorCode } : {}),
						...(lastStatus ? { lastStatus } : {}),
					};
					clientOptions.onRetrySummary?.(summary);
				}
				return response;
			} catch (error) {
				throwIfAmbientAborted(clientOptions.signal);
				if (!issuedThisAttempt) issued += 1;
				lastError = error;
				lastErrorCode = proxyTransportRetryErrorCode(error);
				lastStatus = proxyTransportRetryErrorStatus(error);
				const proxyUsed = Boolean((error as NativeHttpAttemptError).proxyUsed);
				if (
					attempt < transportAttemptCap &&
					shouldRetryProxyTransportAttempt({
						error,
						explicitRetry,
						method: methodName,
						options: retryOptions,
						proxyUsed,
					})
				) {
					await sleep(
						computeProxyTransportRetryDelayMs(retryOptions, attempt),
						clientOptions.signal,
					);
					continue;
				}
				throw error;
			}
		}

		// Reached when the attempt cap is consumed without a terminal outcome —
		// e.g. the final offsets of a partial allocation all resolved to
		// already-tried endpoints and were skipped. Surface the last real transport
		// failure rather than a synthetic exhaustion error.
		if (lastError !== undefined) {
			throw lastError;
		}
		throw new TransportError("HTTP retry exhausted without a terminal result", {
			code: "retry_exhausted",
		});
	}

	async function streamRequest(
		url: string,
		method: string,
		options: RequestOptions & { body?: unknown } = {},
	): Promise<HttpStreamResponse> {
		const { headersOptions, methodName } = (() => {
			try {
				if (!baseUrl && !isAbsoluteUrl(url)) {
					throw new TransportError(
						"ctx.http requires an absolute URL when provider.upstream.baseUrl is not declared",
						{ code: "transport_invalid_url" },
					);
				}
				assertNoHttpTransportOverrides(options);
				const redirectPolicy = snapshotHttpRedirectPolicy(options);
				return {
					headersOptions: {
						...withClientHeaders(options, clientOptions, options.body),
						redirectPolicy,
					},
					methodName: normalizeHttpMethod(method),
				};
			} catch (error) {
				throw redactSensitiveRequestError(error, url, options.sensitiveParams);
			}
		})();
		return fetchNativeHttpStream(baseUrl, url, methodName, headersOptions, clientOptions, warnOnce);
	}

	return {
		request: async (url, options: RequestWithMethodOptions = {}) =>
			request(url, options.method ?? "GET", options),
		get: async (url, options) => request(url, "GET", options),
		post: async (url, body, options) => request(url, "POST", { ...options, body }),
		put: async (url, body, options) => request(url, "PUT", { ...options, body }),
		delete: async (url, options) => request(url, "DELETE", options),
		stream: async (url, options: RequestWithMethodOptions = {}) =>
			streamRequest(url, options.method ?? "GET", options),
		sse: async (
			url,
			options: RequestWithMethodOptions = {},
		): Promise<AsyncIterable<SseMessage>> => {
			const headers = {
				Accept: "text/event-stream",
				...options.headers,
			};
			const response = await streamRequest(url, options.method ?? "GET", {
				...options,
				headers,
			});
			return parseSseStream(response.body);
		},
	};
}
