import { randomUUID } from "node:crypto";

import type { ProxyResolutionOptions, ResolvedProxyConfig } from "../config/loader.js";
import {
	policyRotatesTransportVendorChain,
	resolvePolicyTransportAttemptCap,
	resolveProxyConfigAsync,
	vendorFromResolvedSource,
} from "../config/loader.js";
import {
	getProxyVendorSelector,
	type ProxyAttemptRecord,
	type ProxyVendorSelector,
} from "./proxy-vendor-selector.js";
import { ProviderError, TransportError } from "../errors.js";
import { parseSseStream, readableBytes, readableLines, readableTextChunks } from "../stream.js";
import type {
	HttpAttemptContext,
	HttpClient,
	HttpHeadersFactory,
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
import {
	httpTelemetryErrorCode,
	type HttpTelemetrySink,
	type HttpAttemptTelemetryEvent,
} from "./http-telemetry.js";
import {
	invalidRedirectPolicy,
	isRedirectStatus,
	nextSameOriginRedirectHop,
	normalizeRedirectPolicy,
	type RedirectPolicyTransport,
} from "./redirects.js";
import {
	normalizeHttpRequestBody,
	redactSensitiveError,
	redactSensitiveRequestError,
	type SerializedRequestUrl,
	serializeRequestUrl,
} from "./request-options.js";

import { startHttpTelemetry } from "./http-telemetry-guard.js";
import { scopedHttpTelemetry } from "./http-telemetry-binding.js";
import {
	createSessionStateResponseView,
	SESSION_STATE_BINDING,
	SESSION_STATE_RESPONSE_URL,
	SESSION_STATE_SET_COOKIES,
	type SessionStateBinding,
	type SessionStateCarryPlan,
	type SessionStateClientAdapter,
	splitJoinedSetCookie,
} from "./session-state.js";
import { StealthCookieJar } from "./stealth-cookies.js";

const DEFAULT_HTTP_BASE_URL = "http://localhost";

function httpAttemptFailure(
	error: unknown,
	status?: number,
): Omit<HttpAttemptTelemetryEvent, "ms" | "proxyUsed"> {
	try {
		return {
			e: httpTelemetryErrorCode(proxyTransportRetryErrorCode(error)),
			status: proxyTransportRetryErrorStatus(error) ?? status,
			...(error instanceof Error
				? {
						diagnostics: {
							name: error.name,
							message: error.message,
							...(error.cause instanceof Error
								? { cause: { name: error.cause.name, message: error.cause.message } }
								: {}),
						},
					}
				: {}),
		};
	} catch {
		return { e: "other" };
	}
}

export type HttpClientOptions = ProxyResolutionOptions & {
	warn?: (message: string) => void;
	userAgent?: string;
	onRetrySummary?: (summary: HttpRetrySummary) => void;
	/**
	 * Synchronous observer for HTTP attempts, retries, timeouts, status, duration,
	 * and observed proxy use. Observer failures never change transport behavior.
	 * All hooks and their property reads are guarded, including `onRetrySummary`
	 * and the failure reporter. Invalid asynchronous results are ignored and never
	 * awaited. Observer failures set the log-only `telemetryFailed` marker; the
	 * marker and redacted error diagnostics are excluded from headers and tenant
	 * metadata. Tenant `meta.retry` retains its existing response shape.
	 *
	 * After `ProviderEngine.attach`, the server wraps supported host HTTP bindings
	 * with the request collector. The adapter preserves arguments, direct-call,
	 * explicit `.call`/`.apply`, and unbound receivers, plus the original returned
	 * promise, response, stream, and error. Streams and SSE are observed at headers
	 * without consuming their bodies. SDK clients report every observed attempt
	 * and keep any observer configured here; routing is scoped to each call.
	 *
	 * Binding an existing adapter reuses its identity and replaces its collector:
	 * the latest bind receives subsequent calls, the earlier collector receives no
	 * further calls, and in-flight calls keep the collector captured at invocation.
	 * An opaque host invocation is one observed attempt with zero observed retries;
	 * its undisclosed retries and proxy settings cannot be inferred, and tenant
	 * `meta.retry` is omitted. Status, duration, and error class remain available
	 * in logs and telemetry headers.
	 *
	 * Non-object bindings and objects without a callable `request`, `get`, `post`,
	 * `put`, `delete`, `stream`, or `sse` method are left untouched, with no `http`
	 * telemetry sibling and one process-wide warning for this reason:
	 * `[apifuse] http telemetry not attached; reason=unsupported_binding_shape`.
	 */
	httpTelemetry?: HttpTelemetrySink;
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
 * Sentinel returned when a policy-managed attempt resolved an endpoint that a
 * prior attempt already tried (every gateway attempt mints its own session, so
 * this only happens when an endpoint repeats). The retry loop advances to the
 * next attempt rather than re-issuing the request, and does NOT treat it as
 * chain exhaustion, so the attempt index still walks into the fallback vendor's
 * share of the budget.
 */
type NativeHttpSkipOutcome = { kind: "dedupe-skip" };

/** One request's vendor selection state, shared by every attempt of its retry loop. */
type HttpProxyAttemptContext = {
	readonly attemptCap?: number;
	/** The selector that picks each attempt's vendor and receives each attempt's outcome. */
	readonly vendorSelector: ProxyVendorSelector;
	readonly requestId: string;
	/** Transport outcomes of the attempts made so far, oldest first. */
	readonly history: ProxyAttemptRecord[];
};

function createHttpProxyAttemptContext(
	clientOptions: HttpClientOptions,
	attemptCap?: number,
): HttpProxyAttemptContext {
	return {
		...(attemptCap === undefined ? {} : { attemptCap }),
		vendorSelector: clientOptions.vendorSelector ?? getProxyVendorSelector(),
		requestId: randomUUID(),
		history: [],
	};
}

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

function withClientHeaderDefaults(
	headers: Record<string, string> | undefined,
	clientOptions: HttpClientOptions,
	body: unknown,
): Record<string, string> {
	const merged: Record<string, string> = {
		...(clientOptions.userAgent ? { "User-Agent": clientOptions.userAgent } : {}),
		...headers,
	};

	if (body !== undefined && !hasHeader(merged, "Content-Type")) {
		merged["Content-Type"] = "application/json";
	}

	return merged;
}

function withClientHeaders(
	options: RequestOptions | undefined,
	clientOptions: HttpClientOptions,
	body: unknown,
): RequestOptions {
	// The ambient client signal is merged into the per-request one here so every
	// downstream read (retry loop, sleep, body consumption) sees a single signal.
	// The header-factory branch needs it too, otherwise factory-header requests
	// would lose ambient cancellation entirely.
	const signal = mergeAbortSignals(clientOptions.signal, options?.signal);
	// A header factory is resolved per issued attempt (resolveAttemptHeaders);
	// the client defaults are applied to its output at that point.
	if (typeof options?.headers === "function") return { ...options, signal };
	return {
		...options,
		headers: withClientHeaderDefaults(options?.headers, clientOptions, body),
		signal,
	};
}

function headerFactoryFailure(message: string, cause?: unknown): TransportError {
	// A dedicated code keeps a broken proof minter out of the retry predicate:
	// toHttpTransportError would otherwise brand a plain throw as
	// transport_network_error, which the default retry policy re-issues.
	// retryable:false is explicit so the served error envelope does not
	// advertise a deterministic signing failure as retryable, and
	// category:provider_error keeps a provider-local minting bug out of the
	// upstream-failure signal (status 0 would otherwise fall through the
	// observability ladder to upstream_http / source upstream_failure).
	return new TransportError(message, {
		code: "http_header_factory_failed",
		status: 0,
		retryable: false,
		category: "provider_error",
		...(cause instanceof Error ? { cause } : {}),
	});
}

function isHeaderRecord(value: unknown): value is Record<string, string> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Settle `promise`, or reject with the signal's reason as soon as it aborts, so
// a pending header factory cannot outlive the request deadline or an ambient
// cancellation (native fetch has not started yet, so nothing else observes them).
function settleBeforeAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		// Always attach handlers: a late rejection after the abort must settle
		// here (a no-op on the already-rejected promise), never go unhandled.
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

async function resolveAttemptHeaders(
	options: RequestOptions & { body?: unknown },
	clientOptions: HttpClientOptions,
	attempt: () => HttpAttemptContext,
	signal: AbortSignal | undefined,
): Promise<Record<string, string> | undefined> {
	const { headers } = options;
	if (typeof headers !== "function") return headers;
	// The per-call timeout may have fired during proxy resolution: do not start
	// the factory at all once the request is already aborted.
	if (signal?.aborted) throw signal.reason;
	let minted: unknown;
	try {
		minted = await settleBeforeAbort(
			Promise.resolve().then(() => headers(attempt())),
			signal,
		);
	} catch (error) {
		// An abort is classified by toHttpTransportError (cancelled / timed out).
		if (signal?.aborted) throw error;
		throw headerFactoryFailure("Request header factory failed", error);
	}
	if (!isHeaderRecord(minted)) {
		throw headerFactoryFailure("Request header factory must return a header record");
	}
	return withClientHeaderDefaults(minted, clientOptions, options.body);
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

	return withSetCookies(response, {
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
	});
}

/**
 * `headers` keeps one `set-cookie` value; the session-state layer reads every
 * one from this non-enumerable key, which leaves the response's shape unchanged.
 */
function withSetCookies(response: Response, result: HttpResponse): HttpResponse {
	const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] })
		.getSetCookie;
	const setCookies =
		typeof getSetCookie === "function"
			? getSetCookie.call(response.headers)
			: splitJoinedSetCookie(response.headers.get("set-cookie") ?? "");
	Object.defineProperty(result, SESSION_STATE_SET_COOKIES, {
		value: setCookies,
		enumerable: false,
		configurable: true,
	});
	if (response.url) {
		Object.defineProperty(result, SESSION_STATE_RESPONSE_URL, {
			value: response.url,
			enumerable: false,
			configurable: true,
		});
	}
	return result;
}

/** Client options the server adds for an operation with a session-state declaration in scope. */
type SessionStateHttpClientOptions = HttpClientOptions & {
	readonly [SESSION_STATE_BINDING]?: SessionStateBinding;
};

function cookieHeaderFromPlan(plan: SessionStateCarryPlan, requestUrl: string): string | undefined {
	const parts = [
		...plan.cookieStores.map((store) =>
			new StealthCookieJar(store.setCookies, store.url).toHeader(requestUrl),
		),
		...plan.cookies.map(([name, value]) => `${name}=${value}`),
	].filter((part) => part.length > 0);
	return parts.length === 0 ? undefined : parts.join("; ");
}

/** Adds carried headers the caller has not set, matching names case-insensitively. */
function withCarriedHeaders(
	headers: Record<string, string>,
	carried: readonly (readonly [string, string])[],
): Record<string, string> {
	const merged = { ...headers };
	for (const [name, value] of carried) {
		if (!hasHeader(merged, name)) merged[name] = value;
	}
	return merged;
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

function normalizeHttpMethod(method: string): Uppercase<HttpMethod> {
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

/** Whether `url` carries its own scheme, so it needs no `upstream.baseUrl` to resolve. */
export function isAbsoluteUrl(url: string): boolean {
	return /^[a-z][a-z\d+\-.]*:/i.test(url);
}

function resolveHttpUrl(baseUrl: string | undefined, url: string): string {
	return new URL(url, baseUrl ?? DEFAULT_HTTP_BASE_URL).toString();
}

type NativeFetchInit = RequestInit & { proxy?: string };

const MAX_HTTP_REDIRECT_HOPS = 20;
const HTTP_REDIRECT_POLICY_TRANSPORT: RedirectPolicyTransport = {
	label: "ctx.http",
	maxHops: MAX_HTTP_REDIRECT_HOPS,
};
const REDIRECT_BODY_HEADERS = new Set([
	"content-encoding",
	"content-language",
	"content-location",
	"content-type",
]);

function snapshotHttpRedirectPolicy(options: RequestOptions): HttpRedirectPolicy | undefined {
	try {
		return normalizeRedirectPolicy(options.redirectPolicy, HTTP_REDIRECT_POLICY_TRANSPORT);
	} catch (error) {
		if (error instanceof TransportError) throw error;
		throw invalidRedirectPolicy(
			HTTP_REDIRECT_POLICY_TRANSPORT,
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
		const decision = nextSameOriginRedirectHop({
			policy,
			initialOrigin,
			currentUrl,
			responseUrl: currentUrl,
			status: response.status,
			method,
			location: location ?? undefined,
			followedHops,
			visitedRequests,
		});
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

async function resolveNativeProxyConfig(
	options: RequestOptions,
	clientOptions: HttpClientOptions,
	warn: (message: string) => void,
	proxyAttemptOffset: number,
	request: HttpProxyAttemptContext,
): Promise<ResolvedProxyConfig> {
	const resolvedProxy = await resolveProxyConfigAsync({
		proxy: options.proxy ?? clientOptions.proxy,
		upstream: clientOptions.upstream,
		proxyPolicy: clientOptions.proxyPolicy,
		affinityKey: clientOptions.affinityKey,
		proxyAttempt: computeProxyAttemptIndex({
			baseProxyAttempt: clientOptions.proxyAttempt,
			retryAttemptOffset: proxyAttemptOffset,
		}),
		...(request.attemptCap === undefined ? {} : { proxyAttemptCap: request.attemptCap }),
		vendorSelector: request.vendorSelector,
		proxyRequestId: request.requestId,
		proxyAttemptHistory: request.history,
		...(clientOptions.gatewayOverrides ? { gatewayOverrides: clientOptions.gatewayOverrides } : {}),
		// Bun's native fetch proxy option tunnels HTTP CONNECT only; SOCKS5 is not
		// supported here, so a socks5 policy fails loudly rather than downgrading.
		transportProtocols: ["http"],
		telemetry: clientOptions.telemetry,
		engineCredentials: clientOptions.engineCredentials,
	});
	if (resolvedProxy.shouldWarn) {
		warn(
			"[provider-sdk] Provider requested proxy routing, but no proxy URL was configured. Continuing without proxy.",
		);
	}
	return resolvedProxy;
}

/**
 * Hand one transport attempt's outcome to the selector that served the
 * request and append it to the request's history. An attempt whose response
 * reached the origin is `ok` for the vendor session whatever the status; only
 * a transport failure is `error`.
 */
function reportNativeProxyAttempt(
	request: HttpProxyAttemptContext,
	resolvedProxy: ResolvedProxyConfig | undefined,
	attempt: number,
	startedAt: number,
	outcome: "ok" | "error",
	errorCode?: string,
	status?: number,
): void {
	const vendor = vendorFromResolvedSource(resolvedProxy?.source);
	if (!vendor || !resolvedProxy?.url) return;
	const now = Date.now();
	request.history.push({ vendor, outcome, ...(errorCode ? { errorCode } : {}) });
	try {
		request.vendorSelector.report({
			vendor,
			phase: "transport",
			outcome,
			attempt,
			...(resolvedProxy.sessionId ? { sessionId: resolvedProxy.sessionId } : {}),
			...(errorCode ? { errorCode } : {}),
			...(status === undefined ? {} : { status }),
			durationMs: Math.max(0, now - startedAt),
			now,
			requestId: request.requestId,
		});
	} catch {
		// A selector cannot fail the request it observes.
	}
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
	method: Uppercase<HttpMethod>,
	options: RequestOptions & { body?: unknown },
	clientOptions: HttpClientOptions,
	warn: (message: string) => void,
	statusRetryCodes?: readonly number[],
	proxyAttemptOffset = 0,
	dedupe?: { attempted: Set<string> },
	observeProxy?: (used: boolean, status?: number) => void,
	nextHeaderAttempt: () => number = () => 1,
	proxyAttemptContext: HttpProxyAttemptContext = createHttpProxyAttemptContext(clientOptions),
): Promise<NativeHttpAttemptOutcome> {
	const serializedUrl = serializeHttpRequestUrl(baseUrl, url, options);
	const { requestUrl } = serializedUrl;
	const controller = options.timeout ? new AbortController() : undefined;
	const signal = mergeAbortSignals(options.signal, controller?.signal);
	let timeoutHandle = options.timeout
		? setTimeout(() => controller?.abort(), options.timeout)
		: undefined;
	const disarmTimeout = () => {
		if (!timeoutHandle) return;
		clearTimeout(timeoutHandle);
		timeoutHandle = undefined;
	};

	let proxy: string | undefined;
	let resolvedProxy: ResolvedProxyConfig | undefined;
	const attemptStartedAt = Date.now();
	try {
		throwIfAmbientAborted(options.signal);
		// Resolve inside the try (and after the timeout is armed) so vendor
		// resolution failures are branded as TransportErrors and count against the
		// request deadline, exactly as an inline resolve would.
		resolvedProxy = await resolveNativeProxyConfig(
			options,
			clientOptions,
			warn,
			proxyAttemptOffset,
			proxyAttemptContext,
		);
		proxy = resolvedProxy.url;
		observeProxy?.(Boolean(proxy));
		throwIfAmbientAborted(options.signal);
		// Every attempt on a gateway vendor resolves its own session, so a repeated
		// URL only appears when a caller pins one. Skip it rather than re-issuing.
		if (dedupe && proxy) {
			if (dedupe.attempted.has(proxy)) {
				return { kind: "dedupe-skip" };
			}
			dedupe.attempted.add(proxy);
		}
		// Resolve after the dedupe check so a skipped duplicate offset never burns
		// a single-use proof, and with the serialized URL so URL-bound proofs
		// match what is actually issued.
		const requestHeaders = await resolveAttemptHeaders(
			options,
			clientOptions,
			() => ({ attempt: nextHeaderAttempt(), url: requestUrl, method }),
			signal,
		);
		const requestInit: NativeFetchInit = {
			headers: requestHeaders,
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
		observeProxy?.(Boolean(proxy), response.status);
		reportNativeProxyAttempt(
			proxyAttemptContext,
			resolvedProxy,
			proxyAttemptOffset,
			attemptStartedAt,
			"ok",
			undefined,
			response.status,
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

		// `timeout` bounds the header phase (types.ts RequestOptions.timeout), so it
		// is disarmed before the body is read: awaiting the buffered body inside
		// this try brands a mid-body failure as a transport error, but must not
		// extend the deadline over the download. Cancellation still applies —
		// `signal` stays attached to the native response. The discarded non-2xx
		// bodies drained above stay under the deadline on purpose: nothing else
		// bounds them, and their content is never returned to the caller.
		disarmTimeout();
		return await toNativeHttpResponse(response);
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
			toHttpTransportError(error, options.signal, controller?.signal),
			serializedUrl.sensitiveValues,
			serializedUrl.requestUrl,
			serializedUrl.redactedUrl,
		);
		transportError.proxyUsed = Boolean(proxy);
		reportNativeProxyAttempt(
			proxyAttemptContext,
			resolvedProxy,
			proxyAttemptOffset,
			attemptStartedAt,
			"error",
			transportError.code,
			transportError.status,
		);
		throw transportError;
	} finally {
		disarmTimeout();
	}
}

async function fetchNativeHttpStream(
	baseUrl: string | undefined,
	url: string,
	method: Uppercase<HttpMethod>,
	options: RequestOptions & { body?: unknown },
	clientOptions: HttpClientOptions,
	warn: (message: string) => void,
	observeProxy?: (used: boolean) => void,
): Promise<HttpStreamResponse> {
	const serializedUrl = serializeHttpRequestUrl(baseUrl, url, options);
	const { requestUrl } = serializedUrl;
	const controller = options.timeout ? new AbortController() : undefined;
	const signal = mergeAbortSignals(options.signal, controller?.signal);
	const timeoutHandle = options.timeout
		? setTimeout(() => controller?.abort(), options.timeout)
		: undefined;

	try {
		throwIfAmbientAborted(options.signal);
		// Streams never retry: one attempt, one session, on the selector's first vendor.
		const proxy = (
			await resolveNativeProxyConfig(
				options,
				clientOptions,
				warn,
				0,
				createHttpProxyAttemptContext(clientOptions),
			)
		).url;
		observeProxy?.(Boolean(proxy));
		throwIfAmbientAborted(options.signal);
		// Streams never retry: a header factory is resolved once, as attempt 1.
		const headers = await resolveAttemptHeaders(
			options,
			clientOptions,
			() => ({ attempt: 1, url: requestUrl, method }),
			signal,
		);
		const requestInit: NativeFetchInit = {
			headers,
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

		// The stream timeout remains header-scoped; composed ambient and local
		// cancellation stays attached to native fetch for the body's full lifetime.
		return toNativeHttpStreamResponse(response, serializedUrl, options.signal);
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
			toHttpTransportError(error, options.signal, controller?.signal),
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

	const sessionStateBinding = (clientOptions as SessionStateHttpClientOptions)[
		SESSION_STATE_BINDING
	];

	async function request(
		url: string,
		method: string,
		options: RequestOptions & { body?: unknown } = {},
	): Promise<HttpResponse> {
		if (sessionStateBinding) {
			let requestUrl: URL | undefined;
			try {
				requestUrl =
					baseUrl || isAbsoluteUrl(url) ? new URL(resolveHttpUrl(baseUrl, url)) : undefined;
			} catch {
				requestUrl = undefined;
			}
			const declarations = requestUrl
				? sessionStateBinding.select(requestUrl, options.sessionState)
				: [];
			if (requestUrl && declarations.length > 0) {
				return sessionStateBinding.run(
					createSessionStateAdapter(url, method, options, requestUrl),
					declarations,
				);
			}
		}
		return requestOnce(url, method, options);
	}

	/**
	 * The http half of a session-state request. The layer judges the final
	 * response, so a request in scope of a declaration is sent with
	 * `throwOnHttpError: false` and status-code retries do not apply to it;
	 * transport retries do.
	 */
	function createSessionStateAdapter(
		url: string,
		method: string,
		options: RequestOptions & { body?: unknown },
		requestUrl: URL,
	): SessionStateClientAdapter<HttpResponse> {
		const callerHeaders = typeof options.headers === "function" ? undefined : options.headers;
		const callerHeaderNames = new Set(
			Object.keys(callerHeaders ?? {}).map((name) => name.toLowerCase()),
		);
		const callerQueryNames = new Set([
			...requestUrl.searchParams.keys(),
			...Object.keys(options.params ?? {}),
			...Object.keys(options.sensitiveParams ?? {}),
		]);
		const signal = options.signal ?? clientOptions.signal;
		const exchange = async (response: HttpResponse, requestedUrl: string) => {
			const hiddenFields = response as unknown as Record<symbol, unknown>;
			const hidden = hiddenFields[SESSION_STATE_SET_COOKIES];
			// Cookies belong to the URL that set them: the final hop after redirects.
			const finalUrl = hiddenFields[SESSION_STATE_RESPONSE_URL];
			return {
				view: createSessionStateResponseView({
					url: typeof finalUrl === "string" ? finalUrl : requestedUrl,
					status: response.status,
					headers: response.headers,
					body: await response.text(),
				}),
				setCookies: Array.isArray(hidden)
					? (hidden as string[])
					: splitJoinedSetCookie(response.headers["set-cookie"] ?? ""),
			};
		};
		return {
			client: "http",
			profile: "native",
			url: requestUrl,
			method: method.toUpperCase(),
			...(signal ? { signal } : {}),
			callerHasCookie: () => callerHeaderNames.has("cookie"),
			callerHasHeader: (name) => callerHeaderNames.has(name.toLowerCase()),
			callerHasQuery: (name) => callerQueryNames.has(name),
			send(plan) {
				const cookie = cookieHeaderFromPlan(plan, requestUrl.href);
				const carried: (readonly [string, string])[] = [
					...plan.headers,
					...(cookie === undefined ? [] : [["cookie", cookie] as const]),
				];
				const callerHeadersOption = options.headers;
				const headers: RequestOptions["headers"] =
					carried.length === 0
						? callerHeadersOption
						: typeof callerHeadersOption === "function"
							? async (attempt) => {
									const minted = await callerHeadersOption(attempt);
									return isHeaderRecord(minted) ? withCarriedHeaders(minted, carried) : minted;
								}
							: withCarriedHeaders(callerHeadersOption ?? {}, carried);
				const sensitiveParams =
					plan.query.length === 0
						? options.sensitiveParams
						: { ...(options.sensitiveParams ?? {}), ...Object.fromEntries(plan.query) };
				return requestOnce(url, method, {
					...options,
					...(headers === undefined ? {} : { headers }),
					...(sensitiveParams ? { sensitiveParams } : {}),
					throwOnHttpError: false,
				});
			},
			exchange: (response) => exchange(response, requestUrl.href),
			async acquire(acquisition) {
				const response = await requestOnce(acquisition.url, acquisition.method ?? "GET", {
					...(acquisition.headers ? { headers: { ...acquisition.headers } } : {}),
					...(acquisition.body === undefined ? {} : { body: acquisition.body }),
					throwOnHttpError: false,
				});
				return exchange(response, resolveHttpUrl(baseUrl, acquisition.url));
			},
			finish(response, classification) {
				if (classification) {
					response.sessionState = classification;
					return response;
				}
				if (response.status >= 400 && options.throwOnHttpError !== false) {
					throw toUpstreamHttpError(response.status);
				}
				return response;
			},
		};
	}

	async function requestOnce(
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
		const requestStarted = performance.now();
		const telemetry = startHttpTelemetry(
			scopedHttpTelemetry(clientOptions.httpTelemetry),
			retryOptions?.preset,
		);
		try {
			return await runRequest();
		} finally {
			telemetry.finish(performance.now() - requestStarted);
		}

		async function runRequest(): Promise<HttpResponse> {
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
			// policy-managed proxy resolves a *different* vendor session per attempt
			// and, past a vendor's share of the attempt budget, the next vendor, so a
			// transport failure should advance to the next session rather than stop at
			// the per-endpoint retry budget and strand the request on the primary
			// vendor. resolvePolicyTransportAttemptCap widens the cap to the chain span
			// only for implicit, safe-method policy requests; explicit retry policies
			// (their documented `attempts` ceiling), unsafe methods, and
			// static/non-registry vendors keep the retry budget. Status-code retries
			// stay bounded by the retry budget regardless; only transport rotation gets
			// the full span.
			const policyProxy: ProviderProxyPolicy | undefined = (() => {
				const policy = clientOptions.proxyPolicy ?? clientOptions.upstream?.proxy;
				return policy && typeof policy === "object" ? policy : undefined;
			})();
			const usesPolicyProxy = Boolean(policyProxy) && !options.proxy && !clientOptions.proxy;
			const transportAttemptCap = retryOptions
				? resolvePolicyTransportAttemptCap({
						policy: policyProxy,
						usesPolicyProxy,
						retryAttempts: retryOptions.attempts,
						explicitRetry,
						method: methodName,
					})
				: 1;

			// Track resolved endpoints across a policy-managed vendor chain. Every
			// gateway attempt mints its own session, so an endpoint repeats only when a
			// pinned one comes back; rather than re-hammering it under backoff,
			// fetchNativeHttp returns a skip sentinel for a duplicate and the loop
			// advances the attempt without issuing the request, so it keeps walking
			// toward the fallback vendor's share instead of stalling on the primary.
			// De-duplication is gated on the SAME predicate that widens the attempt cap
			// (implicit, safe-method, registry-chain rotation). It must NOT engage for
			// an explicit retry policy: there the caller's `attempts` count is the
			// contract and each attempt must issue against whatever endpoint it
			// resolves, even a repeat, instead of being silently skipped.
			const dedupeProxyEndpoints = policyRotatesTransportVendorChain({
				policy: policyProxy,
				usesPolicyProxy,
				explicitRetry,
				method: methodName,
			});
			const dedupeContext = dedupeProxyEndpoints ? { attempted: new Set<string>() } : undefined;
			// One selector serves the whole request: it names each attempt's vendor and
			// receives each attempt's outcome, and sees the request's own history.
			const proxyAttemptContext = createHttpProxyAttemptContext(clientOptions, transportAttemptCap);

			// Numbers the attempts a header factory sees: only requests that reached
			// header resolution count, so a failed proxy allocation (which increments
			// the telemetry `issued` count below) or a dedupe-skipped offset does not
			// make the first request that is actually built report `attempt: 2`.
			let headerAttempts = 0;
			const nextHeaderAttempt = () => {
				headerAttempts += 1;
				return headerAttempts;
			};

			const executeOnce = async (proxyAttemptOffset = 0): Promise<NativeHttpAttemptOutcome> => {
				const started = performance.now();
				let proxyUsed = false;
				let observedStatus: number | undefined;
				const record = (event: Omit<HttpAttemptTelemetryEvent, "ms" | "proxyUsed">) => {
					telemetry.recordAttempt({ ...event, ms: performance.now() - started, proxyUsed });
				};
				try {
					const outcome = await fetchNativeHttp(
						baseUrl,
						url,
						methodName,
						attemptOptions,
						clientOptions,
						warnOnce,
						statusRetryEnabled ? retryOptions?.statusCodes : undefined,
						proxyAttemptOffset,
						dedupeContext,
						(used, status) => {
							proxyUsed = used;
							observedStatus = status;
						},
						nextHeaderAttempt,
						proxyAttemptContext,
					);
					if (!isDedupeSkipOutcome(outcome))
						record({
							status: outcome.status,
							...(isHttpStatusOutcome(outcome)
								? { e: "upstream_http_error", statusRetry: true }
								: {}),
						});
					return outcome;
				} catch (error) {
					// Record before the retry loop can catch/rethrow a terminal status.
					record(httpAttemptFailure(error, observedStatus));
					throw error;
				}
			};

			if (!retryEnabled || !retryOptions) {
				throwIfAmbientAborted(headersOptions.signal);
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
			// `attempt` walks the flat proxy offset across the full chain span; `issued`
			// counts requests that were actually sent (skipped duplicate offsets do not
			// increment it). Retry summaries and the status-retry budget must reflect
			// issued requests, not the raw offset, so they stay accurate when partial
			// allocations skip offsets.
			let issued = 0;
			for (let attempt = 1; attempt <= transportAttemptCap; attempt += 1) {
				throwIfAmbientAborted(headersOptions.signal);
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
						if (outcome.retryable && issued < retryOptions.attempts) {
							await sleep(
								computeProxyTransportRetryDelayMs(retryOptions, attempt, outcome.headers),
								headersOptions.signal,
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
						const summary = telemetry.toTenantRetryPayload();
						if (summary) telemetry.observe(() => clientOptions.onRetrySummary?.(summary));
					}
					return response;
				} catch (error) {
					throwIfAmbientAborted(headersOptions.signal);
					if (!issuedThisAttempt) issued += 1;
					lastError = error;
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
							headersOptions.signal,
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
		// Streams never retry. Observe the header fetch without consuming its body.
		const telemetry = startHttpTelemetry(scopedHttpTelemetry(clientOptions.httpTelemetry), "off");
		const started = performance.now();
		const alreadyAborted = headersOptions.signal?.aborted === true;
		let proxyUsed = false;
		const record = (event: Omit<HttpAttemptTelemetryEvent, "ms" | "proxyUsed">) => {
			if (alreadyAborted) return;
			telemetry.recordAttempt({ ...event, ms: performance.now() - started, proxyUsed });
		};
		try {
			const response = await fetchNativeHttpStream(
				baseUrl,
				url,
				methodName,
				headersOptions,
				clientOptions,
				warnOnce,
				(used) => {
					proxyUsed = used;
				},
			);
			record({ status: response.status });
			return response;
		} catch (error) {
			record(httpAttemptFailure(error));
			throw error;
		} finally {
			telemetry.finish(performance.now() - started);
		}
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
			const callerHeaders = options.headers;
			const headers: Record<string, string> | HttpHeadersFactory =
				typeof callerHeaders === "function"
					? async (attempt) => {
							// Pass a malformed result through unchanged so the factory
							// validation rejects it instead of spreading it into `{}`.
							const minted = await callerHeaders(attempt);
							return isHeaderRecord(minted) ? { Accept: "text/event-stream", ...minted } : minted;
						}
					: { Accept: "text/event-stream", ...callerHeaders };
			const response = await streamRequest(url, options.method ?? "GET", {
				...options,
				headers,
			});
			return parseSseStream(response.body);
		},
	};
}
