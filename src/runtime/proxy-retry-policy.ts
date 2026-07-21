import { ProviderError, TransportError } from "../errors.js";
import type { HttpMethod, HttpRetryOptions, RequestOptions } from "../types.js";
import {
	HttpRetryAfterPolicy,
	HttpRetryDelayStrategy,
	HttpRetryJitter,
	HttpRetryPreset,
	HttpRetryUnsafeMethodPolicy,
} from "../types.js";

export type NormalizedProxyTransportRetryOptions = Required<
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

export const DEFAULT_PROXY_TRANSPORT_RETRY_METHODS = ["GET", "HEAD", "OPTIONS"] as const;
export const DEFAULT_PROXY_TRANSPORT_RETRY_ERROR_CODES = [
	"transport_network_error",
	"transport_timeout",
] as const;
const SAFE_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504] as const;
const RATE_LIMIT_RETRY_STATUS_CODES = [429, 503] as const;
const RATE_LIMIT_RETRY_ERROR_CODES = ["transport_timeout"] as const;
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
const UNSAFE_RETRY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE", "TRACE"]);
export const MAX_PROXY_TRANSPORT_RETRY_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 30_000;

type RetryPolicyLabel = "HTTP" | "Stealth" | "Proxy transport";

function hasOwnValue<T extends string>(values: Record<string, T>, value: unknown): value is T {
	if (typeof value !== "string") return false;
	return Object.values(values).some((candidate) => candidate === value);
}

function createInvalidRetryPolicyError(message: string, label: RetryPolicyLabel): ProviderError {
	return new ProviderError(message.replace("{{label}}", label), {
		code: "retry_invalid_policy",
	});
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

export function proxyTransportRetryErrorCode(error: unknown): string | undefined {
	return retryErrorCode(error);
}

export function proxyTransportRetryErrorStatus(error: unknown): number | undefined {
	return retryErrorStatus(error);
}

function createRetryOptions(
	preset: HttpRetryPreset,
	extraErrorCodes: readonly string[],
	label: RetryPolicyLabel,
): NormalizedProxyTransportRetryOptions {
	const defaultErrorCodes = [...DEFAULT_PROXY_TRANSPORT_RETRY_ERROR_CODES, ...extraErrorCodes];
	switch (preset) {
		case HttpRetryPreset.Off:
			return {
				preset,
				attempts: 1,
				methods: DEFAULT_PROXY_TRANSPORT_RETRY_METHODS,
				statusCodes: [],
				errorCodes: defaultErrorCodes,
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
				methods: DEFAULT_PROXY_TRANSPORT_RETRY_METHODS,
				statusCodes: SAFE_RETRY_STATUS_CODES,
				errorCodes: defaultErrorCodes,
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
				methods: DEFAULT_PROXY_TRANSPORT_RETRY_METHODS,
				statusCodes: SAFE_RETRY_STATUS_CODES,
				errorCodes: defaultErrorCodes,
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
				methods: DEFAULT_PROXY_TRANSPORT_RETRY_METHODS,
				statusCodes: RATE_LIMIT_RETRY_STATUS_CODES,
				errorCodes: RATE_LIMIT_RETRY_ERROR_CODES,
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
				methods: DEFAULT_PROXY_TRANSPORT_RETRY_METHODS,
				statusCodes: [],
				errorCodes: defaultErrorCodes,
				delayStrategy: HttpRetryDelayStrategy.Exponential,
				baseDelayMs: 100,
				maxDelayMs: 1_000,
				jitter: HttpRetryJitter.Full,
				retryAfter: HttpRetryAfterPolicy.Ignore,
				unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.Reject,
			};
	}
	throw createInvalidRetryPolicyError(`Unknown ${label} retry preset: ${preset}`, label);
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 1) return fallback;
	return Math.min(Math.floor(value), max);
}

function clampDelay(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) return fallback;
	return Math.min(Math.floor(value), MAX_RETRY_DELAY_MS);
}

export function createDefaultProxyTransportRetryOptions(
	options: { extraErrorCodes?: readonly string[]; label?: RetryPolicyLabel } = {},
): NormalizedProxyTransportRetryOptions {
	return createRetryOptions(
		HttpRetryPreset.TransportTransient,
		options.extraErrorCodes ?? [],
		options.label ?? "Proxy transport",
	);
}

export function normalizeProxyTransportRetryOptions(
	retry: RequestOptions["retry"],
	options: {
		extraErrorCodes?: readonly string[];
		label?: RetryPolicyLabel;
	} = {},
): NormalizedProxyTransportRetryOptions | undefined {
	const label = options.label ?? "Proxy transport";
	const extraErrorCodes = options.extraErrorCodes ?? [];
	if (retry === undefined || retry === false) {
		return undefined;
	}
	if (retry === true) {
		return createRetryOptions(HttpRetryPreset.TransportTransient, extraErrorCodes, label);
	}
	if (typeof retry === "string") {
		if (!hasOwnValue(HttpRetryPreset, retry)) {
			throw createInvalidRetryPolicyError(`Unknown ${label} retry preset: ${retry}`, label);
		}
		return createRetryOptions(retry, extraErrorCodes, label);
	}
	if (typeof retry !== "object" || retry === null) {
		throw createInvalidRetryPolicyError(`${label} retry policy must be an object`, label);
	}
	if (Array.isArray(retry)) {
		throw createInvalidRetryPolicyError(`${label} retry policy must be a plain object`, label);
	}

	validateRetryOptionsShape(retry, label);
	const base = createRetryOptions(
		retry.preset ?? HttpRetryPreset.TransportTransient,
		extraErrorCodes,
		label,
	);
	const maxDelayMs = clampDelay(retry.maxDelayMs, base.maxDelayMs);
	return {
		preset: retry.preset ?? base.preset,
		attempts: clampPositiveInteger(
			retry.attempts,
			base.attempts,
			MAX_PROXY_TRANSPORT_RETRY_ATTEMPTS,
		),
		methods: retry.methods?.map((method) => method.toUpperCase()) ?? base.methods,
		statusCodes:
			retry.statusCodes?.filter((status) => Number.isInteger(status)) ?? base.statusCodes,
		errorCodes: retry.errorCodes ?? base.errorCodes,
		delayStrategy: retry.delayStrategy ?? base.delayStrategy,
		baseDelayMs: clampDelay(retry.baseDelayMs, base.baseDelayMs),
		maxDelayMs,
		jitter: retry.jitter ?? base.jitter,
		retryAfter: retry.retryAfter ?? base.retryAfter,
		unsafeMethodPolicy: retry.unsafeMethodPolicy ?? base.unsafeMethodPolicy,
	};
}

function validateRetryOptionsShape(retry: HttpRetryOptions, label: RetryPolicyLabel): void {
	if (retry.preset !== undefined && !hasOwnValue(HttpRetryPreset, retry.preset)) {
		throw createInvalidRetryPolicyError(
			`Unknown ${label} retry preset: ${String(retry.preset)}`,
			label,
		);
	}
	if (
		retry.delayStrategy !== undefined &&
		!hasOwnValue(HttpRetryDelayStrategy, retry.delayStrategy)
	) {
		throw createInvalidRetryPolicyError(
			`Unknown ${label} retry delay strategy: ${String(retry.delayStrategy)}`,
			label,
		);
	}
	if (retry.jitter !== undefined && !hasOwnValue(HttpRetryJitter, retry.jitter)) {
		throw createInvalidRetryPolicyError(
			`Unknown ${label} retry jitter policy: ${String(retry.jitter)}`,
			label,
		);
	}
	if (retry.retryAfter !== undefined && !hasOwnValue(HttpRetryAfterPolicy, retry.retryAfter)) {
		throw createInvalidRetryPolicyError(
			`Unknown ${label} retry-after policy: ${String(retry.retryAfter)}`,
			label,
		);
	}
	if (
		retry.unsafeMethodPolicy !== undefined &&
		!hasOwnValue(HttpRetryUnsafeMethodPolicy, retry.unsafeMethodPolicy)
	) {
		throw createInvalidRetryPolicyError(
			`Unknown ${label} retry unsafe method policy: ${String(retry.unsafeMethodPolicy)}`,
			label,
		);
	}
	if (retry.methods !== undefined) {
		if (!Array.isArray(retry.methods)) {
			throw createInvalidRetryPolicyError(`${label} retry methods must be an array`, label);
		}
		const nonStringMethods = retry.methods.filter((method) => typeof method !== "string");
		if (nonStringMethods.length > 0) {
			throw createInvalidRetryPolicyError(
				`${label} retry methods must contain only strings`,
				label,
			);
		}
		const unknownMethods = retry.methods
			.map((method) => method.toUpperCase())
			.filter((method) => !KNOWN_RETRY_METHODS.has(method));
		if (unknownMethods.length > 0) {
			throw createInvalidRetryPolicyError(
				`Unknown ${label} retry method(s): ${unknownMethods.join(", ")}`,
				label,
			);
		}
	}
	if (retry.statusCodes !== undefined) {
		if (!Array.isArray(retry.statusCodes)) {
			throw createInvalidRetryPolicyError(`${label} retry statusCodes must be an array`, label);
		}
		const invalidStatusCodes = retry.statusCodes.filter(
			(status) => !Number.isInteger(status) || Number(status) < 100 || Number(status) > 599,
		);
		if (invalidStatusCodes.length > 0) {
			throw createInvalidRetryPolicyError(
				`${label} retry statusCodes must contain HTTP status integers in [100, 599]`,
				label,
			);
		}
	}
	if (retry.errorCodes !== undefined) {
		if (!Array.isArray(retry.errorCodes)) {
			throw createInvalidRetryPolicyError(`${label} retry errorCodes must be an array`, label);
		}
		const nonStringErrorCodes = retry.errorCodes.filter(
			(errorCode) => typeof errorCode !== "string",
		);
		if (nonStringErrorCodes.length > 0) {
			throw createInvalidRetryPolicyError(
				`${label} retry errorCodes must contain only strings`,
				label,
			);
		}
	}
	if (
		retry.preset === HttpRetryPreset.Off &&
		((retry.attempts !== undefined && retry.attempts > 1) ||
			(retry.statusCodes !== undefined && retry.statusCodes.length > 0))
	) {
		throw createInvalidRetryPolicyError(
			`${label} retry preset off cannot be combined with retry-enabling overrides`,
			label,
		);
	}
}

export function validateUnsafeProxyTransportRetryMethods(
	options: NormalizedProxyTransportRetryOptions,
	label: RetryPolicyLabel = "Proxy transport",
): void {
	if (options.unsafeMethodPolicy === HttpRetryUnsafeMethodPolicy.AllowExplicitUnsafe) {
		return;
	}
	const unsafeMethods = options.methods.filter((method) =>
		UNSAFE_RETRY_METHODS.has(method.toUpperCase()),
	);
	if (unsafeMethods.length === 0) return;

	throw new ProviderError(
		`${label} retry methods include unsafe method(s): ${unsafeMethods.join(", ")}`,
		{ code: "retry_unsafe_method" },
	);
}

export function isProxyTransportRetryMethod(
	method: HttpMethod | string,
	options: NormalizedProxyTransportRetryOptions,
): boolean {
	return options.methods
		.map((allowedMethod) => allowedMethod.toUpperCase())
		.includes(method.toUpperCase());
}

export function shouldRetryProxyTransportError(
	error: unknown,
	options: NormalizedProxyTransportRetryOptions,
): boolean {
	const code = retryErrorCode(error);
	return Boolean(code && options.errorCodes.includes(code));
}

export function shouldRetryProxyTransportAttempt(input: {
	error: unknown;
	explicitRetry: boolean;
	method: HttpMethod | string;
	options: NormalizedProxyTransportRetryOptions | undefined;
	proxyUsed: boolean;
}): boolean {
	const { error, explicitRetry, method, options, proxyUsed } = input;
	if (!options || options.attempts <= 1) return false;
	if (!explicitRetry && !proxyUsed) return false;
	return (
		isProxyTransportRetryMethod(method, options) && shouldRetryProxyTransportError(error, options)
	);
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

export function computeProxyTransportRetryDelayMs(
	options: NormalizedProxyTransportRetryOptions,
	attemptIndex: number,
	headers?: Record<string, string>,
): number {
	const multiplier =
		options.delayStrategy === HttpRetryDelayStrategy.Exponential
			? 2 ** Math.max(0, attemptIndex - 1)
			: 1;
	const configuredDelay = Math.min(options.baseDelayMs * multiplier, options.maxDelayMs);
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
			return Math.floor(configuredDelay / 2 + Math.random() * (configuredDelay / 2));
		case HttpRetryJitter.Full:
			return Math.floor(Math.random() * configuredDelay);
	}
}

export function normalizeProxyAttemptIndex(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

export function computeProxyAttemptIndex(options: {
	baseProxyAttempt?: number;
	proxyAttemptOffset?: number;
	retryAttemptOffset?: number;
}): number {
	return (
		normalizeProxyAttemptIndex(options.baseProxyAttempt) +
		normalizeProxyAttemptIndex(options.proxyAttemptOffset) +
		normalizeProxyAttemptIndex(options.retryAttemptOffset)
	);
}
