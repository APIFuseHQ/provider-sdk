import type { ProxyResolutionOptions } from "../config/loader.js";
import {
	policyResolvesRegistryVendorChain,
	resolvePolicyTransportAttemptCap,
	resolveProxyConfigAsync,
} from "../config/loader.js";
import { ProviderError, TransportError } from "../errors.js";
import { parseSseStream, readableBytes, readableLines, readableTextChunks } from "../stream.js";
import type {
	HttpClient,
	HttpMethod,
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
import { appendQueryParams, normalizeHttpRequestBody } from "./request-options.js";

const DEFAULT_HTTP_BASE_URL = "http://localhost";

export type HttpClientOptions = ProxyResolutionOptions & {
	warn?: (message: string) => void;
	userAgent?: string;
	onRetrySummary?: (summary: HttpRetrySummary) => void;
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

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, ms));
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

function toHttpTransportError(error: unknown): TransportError {
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

function toNativeHttpStreamResponse(response: Response): HttpStreamResponse {
	const headers = Object.fromEntries(response.headers.entries());
	const body = requireNativeResponseBody(response);
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

async function resolveNativeProxy(
	options: RequestOptions,
	clientOptions: HttpClientOptions,
	warn: (message: string) => void,
	proxyAttemptOffset = 0,
): Promise<string | undefined> {
	const resolvedProxy = await resolveProxyConfigAsync({
		proxy: options.proxy ?? clientOptions.proxy,
		upstream: clientOptions.upstream,
		apifuseConfig: clientOptions.apifuseConfig,
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
	const requestUrl = appendQueryParams(resolveHttpUrl(baseUrl, url), options.params);
	const controller = options.timeout ? new AbortController() : undefined;
	const timeoutHandle = options.timeout
		? setTimeout(() => controller?.abort(), options.timeout)
		: undefined;

	let proxy: string | undefined;
	try {
		// Resolve inside the try (and after the timeout is armed) so allocator
		// failures are branded as TransportErrors and count against the request
		// deadline, exactly as an inline resolve would.
		proxy = await resolveNativeProxy(options, clientOptions, warn, proxyAttemptOffset);
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
			signal: controller?.signal,
		};
		if (options.body !== undefined) {
			requestInit.body = normalizeNativeFetchBody(options.body);
		}
		const response = await fetch(requestUrl, {
			...requestInit,
		});
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
			throw error;
		}
		const transportError = toHttpTransportError(error) as NativeHttpAttemptError;
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
	const requestUrl = appendQueryParams(resolveHttpUrl(baseUrl, url), options.params);
	const controller = options.timeout ? new AbortController() : undefined;
	const timeoutHandle = options.timeout
		? setTimeout(() => controller?.abort(), options.timeout)
		: undefined;

	try {
		const proxy = await resolveNativeProxy(options, clientOptions, warn);
		const requestInit: NativeFetchInit = {
			headers: options.headers,
			method,
			...(proxy ? { proxy } : {}),
			signal: controller?.signal,
		};
		if (options.body !== undefined) {
			requestInit.body = normalizeNativeFetchBody(options.body);
		}
		const response = await fetch(requestUrl, {
			...requestInit,
		});

		if (response.status >= 400 && options.throwOnHttpError !== false) {
			await drainNativeResponseBody(response);
			throw new TransportError(`Upstream request failed with status ${response.status}`, {
				code: "upstream_http_error",
				status: response.status,
			});
		}

		return toNativeHttpStreamResponse(response);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw error;
		}
		throw toHttpTransportError(error);
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
		if (!baseUrl && !isAbsoluteUrl(url)) {
			throw new TransportError(
				"ctx.http requires an absolute URL when provider.upstream.baseUrl is not declared",
				{ code: "transport_invalid_url" },
			);
		}
		assertNoHttpTransportOverrides(options);
		const headersOptions = withClientHeaders(options, clientOptions, options.body);
		const methodName = normalizeHttpMethod(method);
		const explicitRetry = headersOptions.retry !== undefined;
		const retryOptions =
			normalizeProxyTransportRetryOptions(headersOptions.retry, {
				label: "HTTP",
			}) ??
			(explicitRetry ? undefined : createDefaultProxyTransportRetryOptions({ label: "HTTP" }));
		if (retryOptions) validateUnsafeProxyTransportRetryMethods(retryOptions, "HTTP");
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
		// Only registry vendor chains (smartproxy/nodemaven) rotate endpoints per
		// attempt; static/custom/decodo policies resolve the same URL every time
		// and must keep retrying it, so restrict de-duplication to registry chains.
		const dedupeAllocatorEndpoints =
			usesPolicyAllocator && policyResolvesRegistryVendorChain(policyProxy);
		const dedupeContext = dedupeAllocatorEndpoints
			? { attempted: new Set<string>() }
			: undefined;

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
		for (let attempt = 1; attempt <= transportAttemptCap; attempt += 1) {
			try {
				const outcome = await executeOnce(attempt - 1);
				if (isDedupeSkipOutcome(outcome)) {
					// Duplicate endpoint from a partial allocation: advance the flat
					// offset without issuing the request (no backoff, not a failure) so
					// the loop keeps rotating toward the fallback vendor.
					continue;
				}
				if (isHttpStatusOutcome(outcome)) {
					lastStatus = outcome.status;
					if (outcome.retryable && attempt < retryOptions.attempts) {
						await sleep(computeProxyTransportRetryDelayMs(retryOptions, attempt, outcome.headers));
						continue;
					}
					throw toUpstreamHttpError(outcome.status);
				}

				const response = outcome;
				if (response.status >= 400 && headersOptions.throwOnHttpError !== false) {
					throw toUpstreamHttpError(response.status);
				}

				if (attempt > 1) {
					const summary: HttpRetrySummary = {
						attempts: attempt,
						retries: attempt - 1,
						...(retryOptions.preset ? { preset: retryOptions.preset } : {}),
						transport: "native",
						...(lastErrorCode ? { lastErrorCode } : {}),
						...(lastStatus ? { lastStatus } : {}),
					};
					clientOptions.onRetrySummary?.(summary);
				}
				return response;
			} catch (error) {
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
					await sleep(computeProxyTransportRetryDelayMs(retryOptions, attempt));
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
		if (!baseUrl && !isAbsoluteUrl(url)) {
			throw new TransportError(
				"ctx.http requires an absolute URL when provider.upstream.baseUrl is not declared",
				{ code: "transport_invalid_url" },
			);
		}
		assertNoHttpTransportOverrides(options);
		const headersOptions = withClientHeaders(options, clientOptions, options.body);
		const methodName = normalizeHttpMethod(method);
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
