import type { ProxyResolutionOptions } from "../config/loader";
import { resolveProxyConfigAsync } from "../config/loader";
import { ProviderError, TransportError } from "../errors";
import {
	parseSseStream,
	readableBytes,
	readableLines,
	readableTextChunks,
} from "../stream";
import type {
	HttpClient,
	HttpMethod,
	HttpResponse,
	HttpRetryOptions,
	HttpRetrySummary,
	HttpStreamResponse,
	RequestOptions,
	RequestWithMethodOptions,
	SseMessage,
} from "../types";
import {
	HttpRetryAfterPolicy,
	HttpRetryDelayStrategy,
	HttpRetryJitter,
	HttpRetryPreset,
	HttpRetryUnsafeMethodPolicy,
} from "../types";
import { appendQueryParams, normalizeHttpRequestBody } from "./request-options";

const DEFAULT_HTTP_BASE_URL = "http://localhost";

export type HttpClientOptions = ProxyResolutionOptions & {
	warn?: (message: string) => void;
	userAgent?: string;
	onRetrySummary?: (summary: HttpRetrySummary) => void;
};

type NormalizedRetryOptions = Required<
	Pick<
		HttpRetryOptions,
		| "attempts"
		| "delayStrategy"
		| "baseDelayMs"
		| "maxDelayMs"
		| "jitter"
		| "retryAfter"
		| "unsafeMethodPolicy"
	>
> & {
	preset?: HttpRetryPreset;
	methods: readonly string[];
	statusCodes: readonly number[];
	errorCodes: readonly string[];
};

type HttpStatusOutcome = {
	kind: "http-status";
	status: number;
	headers: Record<string, string>;
	retryable: boolean;
};

function isHttpStatusOutcome(
	outcome: HttpResponse | HttpStatusOutcome,
): outcome is HttpStatusOutcome {
	return "kind" in outcome && outcome.kind === "http-status";
}

const DEFAULT_RETRY_METHODS = ["GET", "HEAD", "OPTIONS"] as const;
const DEFAULT_RETRY_ERROR_CODES = [
	"transport_network_error",
	"transport_timeout",
] as const;
const SAFE_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504] as const;
const RATE_LIMIT_RETRY_STATUS_CODES = [429, 503] as const;
const KNOWN_RETRY_METHODS = new Set([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"DELETE",
	"OPTIONS",
	"TRACE",
	"PATCH",
]);
const UNSAFE_RETRY_METHODS = new Set([
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"TRACE",
]);
const MAX_RETRY_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 30_000;

function hasOwnValue<T extends string>(
	values: Record<string, T>,
	value: unknown,
): value is T {
	if (typeof value !== "string") return false;
	return Object.values(values).some((candidate) => candidate === value);
}

function createInvalidRetryPolicyError(message: string): ProviderError {
	return new ProviderError(message, { code: "retry_invalid_policy" });
}

function createRetryOptions(preset: HttpRetryPreset): NormalizedRetryOptions {
	switch (preset) {
		case HttpRetryPreset.Off:
			return {
				preset,
				attempts: 1,
				methods: DEFAULT_RETRY_METHODS,
				statusCodes: [],
				errorCodes: DEFAULT_RETRY_ERROR_CODES,
				delayStrategy: HttpRetryDelayStrategy.Exponential,
				baseDelayMs: 100,
				maxDelayMs: 1_000,
				jitter: HttpRetryJitter.Full,
				retryAfter: HttpRetryAfterPolicy.Ignore,
				unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.Reject,
			};
		case HttpRetryPreset.SafeRead:
			return {
				preset,
				attempts: 3,
				methods: DEFAULT_RETRY_METHODS,
				statusCodes: SAFE_RETRY_STATUS_CODES,
				errorCodes: DEFAULT_RETRY_ERROR_CODES,
				delayStrategy: HttpRetryDelayStrategy.Exponential,
				baseDelayMs: 100,
				maxDelayMs: 2_000,
				jitter: HttpRetryJitter.Full,
				retryAfter: HttpRetryAfterPolicy.Cap,
				unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.Reject,
			};
		case HttpRetryPreset.AggressiveRead:
			return {
				preset,
				attempts: 4,
				methods: DEFAULT_RETRY_METHODS,
				statusCodes: SAFE_RETRY_STATUS_CODES,
				errorCodes: DEFAULT_RETRY_ERROR_CODES,
				delayStrategy: HttpRetryDelayStrategy.Exponential,
				baseDelayMs: 150,
				maxDelayMs: 5_000,
				jitter: HttpRetryJitter.Full,
				retryAfter: HttpRetryAfterPolicy.Cap,
				unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.Reject,
			};
		case HttpRetryPreset.RateLimitAware:
			return {
				preset,
				attempts: 3,
				methods: DEFAULT_RETRY_METHODS,
				statusCodes: RATE_LIMIT_RETRY_STATUS_CODES,
				errorCodes: ["transport_timeout"],
				delayStrategy: HttpRetryDelayStrategy.Exponential,
				baseDelayMs: 250,
				maxDelayMs: 5_000,
				jitter: HttpRetryJitter.Equal,
				retryAfter: HttpRetryAfterPolicy.Respect,
				unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.Reject,
			};
		case HttpRetryPreset.TransportTransient:
			return {
				preset,
				attempts: 3,
				methods: DEFAULT_RETRY_METHODS,
				statusCodes: [],
				errorCodes: DEFAULT_RETRY_ERROR_CODES,
				delayStrategy: HttpRetryDelayStrategy.Exponential,
				baseDelayMs: 100,
				maxDelayMs: 1_000,
				jitter: HttpRetryJitter.Full,
				retryAfter: HttpRetryAfterPolicy.Ignore,
				unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.Reject,
			};
	}
	throw createInvalidRetryPolicyError(`Unknown HTTP retry preset: ${preset}`);
}

function clampPositiveInteger(
	value: number | undefined,
	fallback: number,
	max: number,
): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 1) return fallback;
	return Math.min(Math.floor(value), max);
}

function clampDelay(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) return fallback;
	return Math.min(Math.floor(value), MAX_RETRY_DELAY_MS);
}

function normalizeRetryOptions(
	retry: RequestOptions["retry"],
): NormalizedRetryOptions | undefined {
	if (retry === undefined || retry === false) {
		return undefined;
	}
	if (retry === true) {
		return createRetryOptions(HttpRetryPreset.TransportTransient);
	}
	if (typeof retry === "string") {
		if (!hasOwnValue(HttpRetryPreset, retry)) {
			throw createInvalidRetryPolicyError(
				`Unknown HTTP retry preset: ${retry}`,
			);
		}
		return createRetryOptions(retry);
	}
	if (typeof retry !== "object" || retry === null) {
		throw createInvalidRetryPolicyError("HTTP retry policy must be an object");
	}
	if (Array.isArray(retry)) {
		throw createInvalidRetryPolicyError(
			"HTTP retry policy must be a plain object",
		);
	}

	validateRetryOptionsShape(retry);
	const base = createRetryOptions(
		retry.preset ?? HttpRetryPreset.TransportTransient,
	);
	const maxDelayMs = clampDelay(retry.maxDelayMs, base.maxDelayMs);
	const normalized: NormalizedRetryOptions = {
		preset: retry.preset ?? base.preset,
		attempts: clampPositiveInteger(
			retry.attempts,
			base.attempts,
			MAX_RETRY_ATTEMPTS,
		),
		methods:
			retry.methods?.map((method) => method.toUpperCase()) ?? base.methods,
		statusCodes:
			retry.statusCodes?.filter((status) => Number.isInteger(status)) ??
			base.statusCodes,
		errorCodes: retry.errorCodes ?? base.errorCodes,
		delayStrategy: retry.delayStrategy ?? base.delayStrategy,
		baseDelayMs: clampDelay(retry.baseDelayMs, base.baseDelayMs),
		maxDelayMs,
		jitter: retry.jitter ?? base.jitter,
		retryAfter: retry.retryAfter ?? base.retryAfter,
		unsafeMethodPolicy: retry.unsafeMethodPolicy ?? base.unsafeMethodPolicy,
	};

	return normalized;
}

function isProxyRoutedOrRequested(
	options: RequestOptions,
	clientOptions: HttpClientOptions,
): boolean {
	if (options.proxy !== undefined || clientOptions.proxy !== undefined) {
		return true;
	}

	const upstreamProxy = clientOptions.upstream?.proxy;
	if (upstreamProxy === true) {
		return true;
	}
	if (upstreamProxy && upstreamProxy.mode !== "disabled") {
		return true;
	}

	return Boolean(
		clientOptions.proxyPolicy && clientOptions.proxyPolicy.mode !== "disabled",
	);
}

function selectRetryInput(
	options: RequestOptions,
	clientOptions: HttpClientOptions,
): RequestOptions["retry"] {
	if (options.retry !== undefined) {
		return options.retry;
	}
	if (isProxyRoutedOrRequested(options, clientOptions)) {
		return HttpRetryPreset.TransportTransient;
	}
	return undefined;
}

function validateRetryOptionsShape(retry: HttpRetryOptions): void {
	if (
		retry.preset !== undefined &&
		!hasOwnValue(HttpRetryPreset, retry.preset)
	) {
		throw createInvalidRetryPolicyError(
			`Unknown HTTP retry preset: ${String(retry.preset)}`,
		);
	}
	if (
		retry.delayStrategy !== undefined &&
		!hasOwnValue(HttpRetryDelayStrategy, retry.delayStrategy)
	) {
		throw createInvalidRetryPolicyError(
			`Unknown HTTP retry delay strategy: ${String(retry.delayStrategy)}`,
		);
	}
	if (
		retry.jitter !== undefined &&
		!hasOwnValue(HttpRetryJitter, retry.jitter)
	) {
		throw createInvalidRetryPolicyError(
			`Unknown HTTP retry jitter policy: ${String(retry.jitter)}`,
		);
	}
	if (
		retry.retryAfter !== undefined &&
		!hasOwnValue(HttpRetryAfterPolicy, retry.retryAfter)
	) {
		throw createInvalidRetryPolicyError(
			`Unknown HTTP retry-after policy: ${String(retry.retryAfter)}`,
		);
	}
	if (
		retry.unsafeMethodPolicy !== undefined &&
		!hasOwnValue(HttpRetryUnsafeMethodPolicy, retry.unsafeMethodPolicy)
	) {
		throw createInvalidRetryPolicyError(
			`Unknown HTTP retry unsafe method policy: ${String(retry.unsafeMethodPolicy)}`,
		);
	}
	if (retry.methods !== undefined) {
		if (!Array.isArray(retry.methods)) {
			throw createInvalidRetryPolicyError(
				"HTTP retry methods must be an array",
			);
		}
		const nonStringMethods = retry.methods.filter(
			(method) => typeof method !== "string",
		);
		if (nonStringMethods.length > 0) {
			throw createInvalidRetryPolicyError(
				"HTTP retry methods must contain only strings",
			);
		}
		const unknownMethods = retry.methods
			.map((method) => method.toUpperCase())
			.filter((method) => !KNOWN_RETRY_METHODS.has(method));
		if (unknownMethods.length > 0) {
			throw createInvalidRetryPolicyError(
				`Unknown HTTP retry method(s): ${unknownMethods.join(", ")}`,
			);
		}
	}
	if (retry.statusCodes !== undefined) {
		if (!Array.isArray(retry.statusCodes)) {
			throw createInvalidRetryPolicyError(
				"HTTP retry statusCodes must be an array",
			);
		}
		const invalidStatusCodes = retry.statusCodes.filter(
			(status) =>
				!Number.isInteger(status) ||
				Number(status) < 100 ||
				Number(status) > 599,
		);
		if (invalidStatusCodes.length > 0) {
			throw createInvalidRetryPolicyError(
				"HTTP retry statusCodes must contain HTTP status integers in [100, 599]",
			);
		}
	}
	if (retry.errorCodes !== undefined) {
		if (!Array.isArray(retry.errorCodes)) {
			throw createInvalidRetryPolicyError(
				"HTTP retry errorCodes must be an array",
			);
		}
		const nonStringErrorCodes = retry.errorCodes.filter(
			(errorCode) => typeof errorCode !== "string",
		);
		if (nonStringErrorCodes.length > 0) {
			throw createInvalidRetryPolicyError(
				"HTTP retry errorCodes must contain only strings",
			);
		}
	}
	if (
		retry.preset === HttpRetryPreset.Off &&
		((retry.attempts !== undefined && retry.attempts > 1) ||
			(retry.statusCodes !== undefined && retry.statusCodes.length > 0))
	) {
		throw createInvalidRetryPolicyError(
			"HTTP retry preset off cannot be combined with retry-enabling overrides",
		);
	}
}

function validateUnsafeRetryMethods(options: NormalizedRetryOptions): void {
	if (
		options.unsafeMethodPolicy ===
		HttpRetryUnsafeMethodPolicy.AllowExplicitUnsafe
	) {
		return;
	}
	const unsafeMethods = options.methods.filter((method) =>
		UNSAFE_RETRY_METHODS.has(method.toUpperCase()),
	);
	if (unsafeMethods.length === 0) return;

	throw new ProviderError(
		`HTTP retry methods include unsafe method(s): ${unsafeMethods.join(", ")}`,
		{ code: "retry_unsafe_method" },
	);
}

function isMethodRetryable(
	method: HttpMethod,
	options: NormalizedRetryOptions,
): boolean {
	return options.methods
		.map((allowedMethod) => allowedMethod.toUpperCase())
		.includes(method.toUpperCase());
}

function retryErrorCode(error: unknown): string | undefined {
	if (error instanceof TransportError) {
		return error.code;
	}
	if (error && typeof error === "object" && "code" in error) {
		const code = Reflect.get(error, "code");
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

function retryErrorStatus(error: unknown): number | undefined {
	if (error instanceof TransportError) {
		return error.status ?? error.upstreamStatus;
	}
	return undefined;
}

function shouldRetryTransportError(
	error: unknown,
	options: NormalizedRetryOptions,
): boolean {
	const code = retryErrorCode(error);
	return Boolean(code && options.errorCodes.includes(code));
}

function retryAfterHeader(headers: Record<string, string>): string | undefined {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === "retry-after") return value;
	}
	return undefined;
}

function parseRetryAfterMs(
	headers: Record<string, string>,
	now: number = Date.now(),
): number | undefined {
	const value = retryAfterHeader(headers);
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) {
		return Math.max(0, Math.floor(seconds * 1_000));
	}
	const dateMs = Date.parse(value);
	if (!Number.isNaN(dateMs)) {
		return Math.max(0, dateMs - now);
	}
	return undefined;
}

function computeRetryDelayMs(
	options: NormalizedRetryOptions,
	attemptIndex: number,
	headers?: Record<string, string>,
): number {
	const multiplier =
		options.delayStrategy === HttpRetryDelayStrategy.Exponential
			? 2 ** Math.max(0, attemptIndex - 1)
			: 1;
	const configuredDelay = Math.min(
		options.baseDelayMs * multiplier,
		options.maxDelayMs,
	);
	const retryAfterMs =
		options.retryAfter === HttpRetryAfterPolicy.Ignore
			? undefined
			: headers
				? parseRetryAfterMs(headers)
				: undefined;
	if (retryAfterMs !== undefined) {
		const boundedRetryAfterMs = Math.min(retryAfterMs, options.maxDelayMs);
		if (options.retryAfter === HttpRetryAfterPolicy.Cap) {
			return Math.min(boundedRetryAfterMs, configuredDelay);
		}
		return boundedRetryAfterMs;
	}

	switch (options.jitter) {
		case HttpRetryJitter.None:
			return configuredDelay;
		case HttpRetryJitter.Equal:
			return Math.floor(
				configuredDelay / 2 + Math.random() * (configuredDelay / 2),
			);
		case HttpRetryJitter.Full:
			return Math.floor(Math.random() * configuredDelay);
	}
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
		...(clientOptions.userAgent
			? { "User-Agent": clientOptions.userAgent }
			: {}),
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
	const contentType =
		headers["content-type"] ??
		headers["Content-Type"] ??
		headers["CONTENT-TYPE"];

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
				headers["content-type"] ??
				headers["Content-Type"] ??
				headers["CONTENT-TYPE"];
			return parseJson<T>(
				contentType?.includes("application/json") && !rawText
					? "null"
					: rawText,
			);
		},
		ok: response.status >= 200 && response.status < 300,
		status: response.status,
		text: async () => rawText,
		arrayBuffer: async () =>
			bodyBytes.buffer.slice(
				bodyBytes.byteOffset,
				bodyBytes.byteOffset + bodyBytes.byteLength,
			),
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

function requireNativeResponseBody(
	response: Response,
): ReadableStream<Uint8Array> {
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
): Promise<string | undefined> {
	const resolvedProxy = await resolveProxyConfigAsync({
		proxy: options.proxy ?? clientOptions.proxy,
		upstream: clientOptions.upstream,
		apifuseConfig: clientOptions.apifuseConfig,
		affinityKey: clientOptions.affinityKey,
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

function normalizeNativeFetchBody(
	body: unknown,
): string | ArrayBuffer | undefined {
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
): Promise<HttpResponse | HttpStatusOutcome> {
	const requestUrl = appendQueryParams(
		resolveHttpUrl(baseUrl, url),
		options.params,
	);
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
		const headers = Object.fromEntries(response.headers.entries());

		if (statusRetryCodes && response.status >= 400) {
			await drainNativeResponseBody(response);
			return {
				kind: "http-status",
				status: response.status,
				headers,
				retryable: statusRetryCodes.includes(response.status),
			};
		}

		if (response.status >= 400 && options.throwOnHttpError !== false) {
			await drainNativeResponseBody(response);
			throw new TransportError(
				`Upstream request failed with status ${response.status}`,
				{
					code: "upstream_http_error",
					status: response.status,
				},
			);
		}

		return toNativeHttpResponse(response);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw error;
		}
		throw toHttpTransportError(error);
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
	const requestUrl = appendQueryParams(
		resolveHttpUrl(baseUrl, url),
		options.params,
	);
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
			throw new TransportError(
				`Upstream request failed with status ${response.status}`,
				{
					code: "upstream_http_error",
					status: response.status,
				},
			);
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
		const headersOptions = withClientHeaders(
			options,
			clientOptions,
			options.body,
		);
		const methodName = normalizeHttpMethod(method);
		const retryOptions = normalizeRetryOptions(
			selectRetryInput(headersOptions, clientOptions),
		);
		if (retryOptions) validateUnsafeRetryMethods(retryOptions);
		const retryEnabled = Boolean(
			retryOptions &&
				retryOptions.attempts > 1 &&
				isMethodRetryable(methodName, retryOptions),
		);
		const statusRetryEnabled = Boolean(
			retryEnabled &&
				retryOptions &&
				retryOptions.statusCodes.length > 0 &&
				headersOptions.throwOnHttpError !== false,
		);
		const attemptOptions: RequestOptions & { body?: unknown } =
			statusRetryEnabled
				? { ...headersOptions, throwOnHttpError: false }
				: headersOptions;

		const executeOnce = (): Promise<HttpResponse | HttpStatusOutcome> =>
			fetchNativeHttp(
				baseUrl,
				url,
				methodName,
				attemptOptions,
				clientOptions,
				warnOnce,
				statusRetryEnabled ? retryOptions?.statusCodes : undefined,
			);

		if (!retryEnabled || !retryOptions) {
			const outcome = await executeOnce();
			if (isHttpStatusOutcome(outcome)) {
				throw toUpstreamHttpError(outcome.status);
			}
			return outcome;
		}

		let lastErrorCode: string | undefined;
		let lastStatus: number | undefined;
		for (let attempt = 1; attempt <= retryOptions.attempts; attempt += 1) {
			try {
				const outcome = await executeOnce();
				if (isHttpStatusOutcome(outcome)) {
					lastStatus = outcome.status;
					if (outcome.retryable && attempt < retryOptions.attempts) {
						await sleep(
							computeRetryDelayMs(retryOptions, attempt, outcome.headers),
						);
						continue;
					}
					throw toUpstreamHttpError(outcome.status);
				}

				const response = outcome;
				if (
					response.status >= 400 &&
					headersOptions.throwOnHttpError !== false
				) {
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
				lastErrorCode = retryErrorCode(error);
				lastStatus = retryErrorStatus(error);
				if (
					attempt < retryOptions.attempts &&
					shouldRetryTransportError(error, retryOptions)
				) {
					await sleep(computeRetryDelayMs(retryOptions, attempt));
					continue;
				}
				throw error;
			}
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
		const headersOptions = withClientHeaders(
			options,
			clientOptions,
			options.body,
		);
		const methodName = normalizeHttpMethod(method);
		return fetchNativeHttpStream(
			baseUrl,
			url,
			methodName,
			headersOptions,
			clientOptions,
			warnOnce,
		);
	}

	return {
		request: async (url, options: RequestWithMethodOptions = {}) =>
			request(url, options.method ?? "GET", options),
		get: async (url, options) => request(url, "GET", options),
		post: async (url, body, options) =>
			request(url, "POST", { ...options, body }),
		put: async (url, body, options) =>
			request(url, "PUT", { ...options, body }),
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
