import { createHash } from "node:crypto";
import type { Browser, ImpitOptions, ImpitResponse, RequestInit } from "impit";
import { Impit } from "impit";

import type { ProxyResolutionOptions } from "../config/loader";
import {
	DEFAULT_SMARTPROXY_POOL_SIZE,
	invalidateProxyResolutionCacheAsync,
	ProxyResolutionError,
	resolveProxyConfigAsync,
	SMARTPROXY_MAX_POOL_SIZE,
} from "../config/loader";
import { ProviderError, SDKError, TransportError } from "../errors";
import { getStealthProfile } from "../stealth/profiles";
import type {
	CookieJar,
	HttpMethod,
	HttpRetryOptions,
	StealthClient,
	StealthFetchOptions,
	StealthResponse,
	StealthSession,
} from "../types";
import { HttpRetryPreset, HttpRetryUnsafeMethodPolicy } from "../types";
import {
	createProxyAuthIpDeniedError,
	createProxyEdgeAuthRejectedError,
	createProxyEdgeTlsRejectedError,
	createProxyPoolExhaustedError,
	createProxyPoolStaleError,
	isProxyAuthIpDeniedMessage,
	isProxyEdgeAuthRejectedMessage,
	isProxyEdgeTlsRejectedResponse,
	isProxyPoolRefreshableError,
	isProxyPoolStaleMessage,
	isProxyPoolStaleStatus,
	PROXY_AUTH_IP_DENIED_CODE,
	PROXY_EDGE_AUTH_REJECTED_CODE,
	PROXY_POOL_STALE_CODE,
} from "./proxy-errors";
import { appendQueryParams } from "./request-options";

const DEFAULT_PROFILE = "chrome-146";

const MISSING_PROXY_WARNING =
	"[provider-sdk] Provider requested proxy routing, but no proxy URL was configured. Continuing without proxy.";

const MAX_POLICY_PROXY_RETRY_ATTEMPTS = SMARTPROXY_MAX_POOL_SIZE;
const MAX_POLICY_PROXY_POOL_REFRESHES = 1;
const PROXY_CONNECT_FAILURE_CODE = "proxy_connect_failed";
const PROXY_CONNECT_FAILURE_BODY_PATTERN =
	/\bproxy\b.*\b(non[\s-]?200|connect|tunnel)|\bconnect\b.*\bproxy\b|\btunnel\b/i;
const PROXY_AUTH_DIAGNOSTIC_URL = "http://example.com/";
const PROXY_AUTH_DIAGNOSTIC_TIMEOUT_MS = 5_000;
const DEFAULT_STEALTH_RETRY_METHODS = ["GET", "HEAD", "OPTIONS"] as const;
const DEFAULT_STEALTH_RETRY_ERROR_CODES = [
	PROXY_CONNECT_FAILURE_CODE,
	"transport_network_error",
	"transport_timeout",
] as const;
const RATE_LIMIT_STEALTH_RETRY_ERROR_CODES = ["transport_timeout"] as const;
const KNOWN_STEALTH_RETRY_METHODS = new Set([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"DELETE",
	"OPTIONS",
	"TRACE",
	"PATCH",
]);
const UNSAFE_STEALTH_RETRY_METHODS = new Set([
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"TRACE",
]);
const MAX_STEALTH_RETRY_ATTEMPTS = 8;

export type StealthClientOptions = ProxyResolutionOptions & {
	warn?: (message: string) => void;
	/**
	 * Proxy-only stealth transport overrides. Use only for upstream proxy products
	 * that terminate CONNECT with a private CA instead of tunneling the origin
	 * certificate chain.
	 */
	proxyStealth?: { insecureSkipVerify?: boolean };
};

const REMOVED_CHROME_PROFILE_NAMES = new Set([
	"chrome-120",
	"chrome-124",
	"chrome-129",
	"chrome-130",
	"chrome-131",
	"chrome-133",
	"chrome-144",
	"chrome-146-psk",
	"chrome-131-psk",
	"chrome-130-psk",
	"edge-131",
]);

type ImpitBrowser = Browser;
type ImpitRequestInit = RequestInit;

const CHROME_IMPIT_BY_MAJOR: Record<number, ImpitBrowser> = {
	100: "chrome100",
	101: "chrome101",
	104: "chrome104",
	107: "chrome107",
	110: "chrome110",
	116: "chrome116",
	124: "chrome124",
	125: "chrome125",
	131: "chrome131",
	136: "chrome136",
	142: "chrome142",
};

const FIREFOX_IMPIT_BY_MAJOR: Record<number, ImpitBrowser> = {
	128: "firefox128",
	133: "firefox133",
	135: "firefox135",
	144: "firefox144",
};

type StealthTransportResponse = Pick<
	ImpitResponse,
	"arrayBuffer" | "headers" | "json" | "ok" | "status" | "text" | "url"
>;

type StealthMethod = NonNullable<ImpitRequestInit["method"]>;
type NormalizedStealthRetryOptions = {
	attempts: number;
	methods: readonly string[];
	errorCodes: readonly string[];
	unsafeMethodPolicy: HttpRetryOptions["unsafeMethodPolicy"];
};

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

class CookieJarImpl implements CookieJar {
	private readonly cookies: Record<string, string>;

	constructor(cookieStrings: string[]) {
		this.cookies = {};
		this.setFromCookieStrings(cookieStrings);
	}

	setFromCookieStrings(cookieStrings: readonly string[]): void {
		for (const cookieString of cookieStrings) {
			const [nameValue] = cookieString.split(";");
			if (!nameValue) {
				continue;
			}

			const separatorIndex = nameValue.indexOf("=");
			if (separatorIndex === -1) {
				continue;
			}

			const name = nameValue.slice(0, separatorIndex).trim();
			const value = nameValue.slice(separatorIndex + 1).trim();
			if (name) this.cookies[name] = value;
		}
	}

	get(name: string): string | undefined {
		return this.cookies[name];
	}

	getAll(): Record<string, string> {
		return { ...this.cookies };
	}

	toString(): string {
		return Object.entries(this.cookies)
			.map(([name, value]) => `${name}=${value}`)
			.join("; ");
	}

	find(predicate: (cookie: string) => boolean): string | undefined {
		for (const [name, value] of Object.entries(this.cookies)) {
			const cookie = `${name}=${value}`;
			if (predicate(cookie)) {
				return cookie;
			}
		}

		return undefined;
	}
}

function closestImpitBrowser(
	major: number,
	candidates: Record<number, ImpitBrowser>,
): ImpitBrowser {
	let closestMajor: number | undefined;
	let closestBrowser: ImpitBrowser | undefined;
	for (const [candidateMajorText, browser] of Object.entries(candidates)) {
		const candidateMajor = Number(candidateMajorText);
		if (
			closestMajor === undefined ||
			Math.abs(candidateMajor - major) < Math.abs(closestMajor - major)
		) {
			closestMajor = candidateMajor;
			closestBrowser = browser;
		}
	}
	return closestBrowser ?? "chrome142";
}

function resolveImpitBrowser(profileName: string): ImpitBrowser {
	if (REMOVED_CHROME_PROFILE_NAMES.has(profileName)) {
		throw new SDKError(`Unknown stealth profile: ${profileName}`);
	}

	let profile: ReturnType<typeof getStealthProfile>;
	try {
		profile = getStealthProfile(profileName);
	} catch {
		// Preserve the previous ctx.stealth.fetch() compatibility behavior: unknown
		// profile strings still run with the transport default instead of failing
		// before the request starts. Removed built-in profile aliases above remain
		// explicit errors so callers do not accidentally pin retired fingerprints.
		return "chrome142";
	}

	const identifier = profile.tlsClientIdentifier?.toLowerCase() ?? "";
	const chromeMatch = /^(?:chrome|edge)_(\d+)/.exec(identifier);
	if (chromeMatch?.[1]) {
		return closestImpitBrowser(Number(chromeMatch[1]), CHROME_IMPIT_BY_MAJOR);
	}
	const firefoxMatch = /^firefox_(\d+)/.exec(identifier);
	if (firefoxMatch?.[1]) {
		return closestImpitBrowser(Number(firefoxMatch[1]), FIREFOX_IMPIT_BY_MAJOR);
	}
	if (identifier.startsWith("safari_")) {
		throw new SDKError(
			`Stealth profile "${profileName}" uses a Safari stealth fingerprint, but TypeScript ctx.stealth uses impit which currently supports Chrome, Firefox, and OkHttp profiles only. Use a Chrome/Firefox stealth profile for ctx.stealth or ctx.browser for Safari-specific behavior.`,
		);
	}
	throw new SDKError(
		`Stealth profile "${profileName}" cannot be mapped to an impit browser profile.`,
	);
}

function resolveUrl(baseUrl: string, url: string): string {
	return new URL(url, baseUrl).toString();
}

function headerEntriesFromHeaders(headers: Headers): [string, string][] {
	return Array.from(headers.entries());
}

function normalizeHeaders(
	headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		normalized[name] = Array.isArray(value) ? value.join(", ") : value;
	}
	return normalized;
}

function hasOwn(object: object, key: string): boolean {
	return Object.hasOwn(object, key);
}
function toImpitCookieJar(
	cookieJar: CookieJarImpl,
): NonNullable<ImpitOptions["cookieJar"]> {
	return {
		setCookie(cookie: string, _url: string, cb?: (error?: unknown) => void) {
			cookieJar.setFromCookieStrings([cookie]);
			if (typeof cb === "function") cb();
		},
		getCookieString(_url: string) {
			return cookieJar.toString();
		},
	};
}

function assertNoUnsupportedFingerprintOverrides(options: unknown): void {
	if (!isRecord(options)) return;
	const unsupported: string[] = [];
	if (hasOwn(options, "headerOrder")) unsupported.push("headerOrder");
	const stealth = options.stealth;
	if (isRecord(stealth) && hasOwn(stealth, "ja3"))
		unsupported.push("stealth.ja3");
	if (isRecord(stealth) && hasOwn(stealth, "h2"))
		unsupported.push("stealth.h2");
	if (unsupported.length === 0) return;

	throw new SDKError(
		`ctx.stealth.fetch uses impit-managed browser fingerprints and no longer accepts low-level stealth overrides: ${unsupported.join(", ")}. Use the profile option instead.`,
	);
}

function responseHeadersToRecord(
	headers: Headers,
): Record<string, string | string[] | undefined> {
	const record: Record<string, string> = {};
	for (const [name, value] of headers.entries()) record[name] = value;
	return record;
}

function setCookieHeadersFromResponse(headers: Headers): string[] {
	const getSetCookie = headers.getSetCookie;
	if (typeof getSetCookie === "function") return getSetCookie.call(headers);
	const setCookie = headers.get("set-cookie");
	return setCookie ? splitCombinedSetCookieHeader(setCookie) : [];
}

function splitCombinedSetCookieHeader(headerValue: string): string[] {
	const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/;
	const cookieStrings: string[] = [];
	let start = 0;
	for (let index = 0; index < headerValue.length; index += 1) {
		if (headerValue[index] !== ",") continue;
		const next = headerValue.slice(index + 1).trimStart();
		if (!cookieNamePattern.test(next)) continue;
		const cookie = headerValue.slice(start, index).trim();
		if (cookie) cookieStrings.push(cookie);
		start = index + 1;
	}
	const finalCookie = headerValue.slice(start).trim();
	if (finalCookie) cookieStrings.push(finalCookie);
	return cookieStrings;
}

export async function normalizeResponse(
	response: StealthTransportResponse,
): Promise<StealthResponse> {
	const headers = Object.fromEntries(response.headers.entries());
	const cookies = new CookieJarImpl(
		setCookieHeadersFromResponse(response.headers),
	);
	const bodyBytes = await response.arrayBuffer();
	const body = new TextDecoder().decode(bodyBytes);

	return {
		status: response.status,
		ok: response.status >= 200 && response.status < 300,
		headers,
		rawHeaders: headerEntriesFromHeaders(response.headers),
		body,
		cookies,
		json<T>(): Promise<T> {
			return Promise.resolve(JSON.parse(body));
		},
		arrayBuffer(): Promise<ArrayBuffer> {
			return Promise.resolve(bodyBytes.slice(0));
		},
		bytes(): Promise<Uint8Array> {
			return Promise.resolve(new Uint8Array(bodyBytes.slice(0)));
		},
	};
}

function normalizeBody(body: StealthFetchOptions["body"]): string {
	if (body === undefined) {
		return "";
	}

	if (typeof body === "string") {
		return body;
	}

	if (Buffer.isBuffer(body)) {
		return body.toString();
	}

	return String(body);
}

function isPolicyManagedProxy(options: StealthClientOptions): boolean {
	const policy = options.proxyPolicy ?? options.upstream?.proxy;
	return Boolean(policy && typeof policy === "object");
}

function isRetrySafeStealthMethod(method: StealthMethod): boolean {
	return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function createStealthRetryOptions(
	preset: HttpRetryPreset,
): NormalizedStealthRetryOptions {
	switch (preset) {
		case HttpRetryPreset.Off:
			return {
				attempts: 1,
				methods: DEFAULT_STEALTH_RETRY_METHODS,
				errorCodes: DEFAULT_STEALTH_RETRY_ERROR_CODES,
				unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.Reject,
			};
		case HttpRetryPreset.AggressiveRead:
			return {
				attempts: 4,
				methods: DEFAULT_STEALTH_RETRY_METHODS,
				errorCodes: DEFAULT_STEALTH_RETRY_ERROR_CODES,
				unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.Reject,
			};
		case HttpRetryPreset.RateLimitAware:
			return {
				attempts: 3,
				methods: DEFAULT_STEALTH_RETRY_METHODS,
				errorCodes: RATE_LIMIT_STEALTH_RETRY_ERROR_CODES,
				unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.Reject,
			};
		case HttpRetryPreset.SafeRead:
		case HttpRetryPreset.TransportTransient:
			return {
				attempts: 3,
				methods: DEFAULT_STEALTH_RETRY_METHODS,
				errorCodes: DEFAULT_STEALTH_RETRY_ERROR_CODES,
				unsafeMethodPolicy: HttpRetryUnsafeMethodPolicy.Reject,
			};
	}
	throw new ProviderError(`Unknown stealth retry preset: ${preset}`, {
		code: "retry_invalid_policy",
	});
}

function normalizeStealthRetryOptions(
	retry: StealthFetchOptions["retry"],
): NormalizedStealthRetryOptions | undefined {
	if (retry === undefined) return undefined;
	if (retry === false) return createStealthRetryOptions(HttpRetryPreset.Off);
	if (retry === true)
		return createStealthRetryOptions(HttpRetryPreset.TransportTransient);
	if (typeof retry === "string") {
		if (!Object.values(HttpRetryPreset).includes(retry)) {
			throw new ProviderError(`Unknown stealth retry preset: ${retry}`, {
				code: "retry_invalid_policy",
			});
		}
		return createStealthRetryOptions(retry);
	}
	if (typeof retry !== "object" || retry === null || Array.isArray(retry)) {
		throw new ProviderError("Stealth retry policy must be a plain object", {
			code: "retry_invalid_policy",
		});
	}
	if (
		retry.unsafeMethodPolicy !== undefined &&
		!Object.values(HttpRetryUnsafeMethodPolicy).includes(
			retry.unsafeMethodPolicy,
		)
	) {
		throw new ProviderError(
			`Unknown stealth retry unsafe method policy: ${String(retry.unsafeMethodPolicy)}`,
			{ code: "retry_invalid_policy" },
		);
	}
	if (retry.methods !== undefined) {
		if (!Array.isArray(retry.methods)) {
			throw new ProviderError("Stealth retry methods must be an array", {
				code: "retry_invalid_policy",
			});
		}
		const unknownMethods = retry.methods
			.map((method) => (typeof method === "string" ? method.toUpperCase() : ""))
			.filter((method) => !KNOWN_STEALTH_RETRY_METHODS.has(method));
		if (unknownMethods.length > 0) {
			throw new ProviderError(
				`Unknown stealth retry method(s): ${unknownMethods.join(", ")}`,
				{ code: "retry_invalid_policy" },
			);
		}
	}
	if (retry.errorCodes !== undefined) {
		if (
			!Array.isArray(retry.errorCodes) ||
			retry.errorCodes.some((errorCode) => typeof errorCode !== "string")
		) {
			throw new ProviderError(
				"Stealth retry errorCodes must contain only strings",
				{ code: "retry_invalid_policy" },
			);
		}
	}

	const base = createStealthRetryOptions(
		retry.preset ?? HttpRetryPreset.TransportTransient,
	);
	const attempts =
		retry.attempts === undefined || !Number.isFinite(retry.attempts)
			? base.attempts
			: Math.max(
					1,
					Math.min(MAX_STEALTH_RETRY_ATTEMPTS, Math.floor(retry.attempts)),
				);
	const normalized: NormalizedStealthRetryOptions = {
		attempts,
		methods:
			retry.methods?.map((method) => method.toUpperCase()) ?? base.methods,
		errorCodes: retry.errorCodes ?? base.errorCodes,
		unsafeMethodPolicy: retry.unsafeMethodPolicy ?? base.unsafeMethodPolicy,
	};

	if (
		normalized.unsafeMethodPolicy !==
		HttpRetryUnsafeMethodPolicy.AllowExplicitUnsafe
	) {
		const unsafeMethods = normalized.methods.filter((method) =>
			UNSAFE_STEALTH_RETRY_METHODS.has(method.toUpperCase()),
		);
		if (unsafeMethods.length > 0) {
			throw new ProviderError(
				`Stealth retry methods include unsafe method(s): ${unsafeMethods.join(", ")}`,
				{ code: "retry_unsafe_method" },
			);
		}
	}

	return normalized;
}

function isExplicitStealthRetryAllowed(
	method: StealthMethod,
	error: TransportError,
	retryOptions: NormalizedStealthRetryOptions | undefined,
): boolean {
	if (!retryOptions || retryOptions.attempts <= 1) return false;
	return (
		retryOptions.methods.includes(method.toUpperCase()) &&
		retryOptions.errorCodes.includes(proxyAttemptErrorCode(error))
	);
}

function isRetryableProxyTransportError(error: unknown): boolean {
	if (error instanceof TransportError) {
		if (error.code === PROXY_AUTH_IP_DENIED_CODE) {
			return false;
		}
		return (
			error.code === PROXY_CONNECT_FAILURE_CODE ||
			error.code === "transport_network_error" ||
			error.code === "transport_timeout"
		);
	}

	if (error instanceof SDKError) {
		return false;
	}

	const message = error instanceof Error ? error.message : String(error);
	return /\bproxy\b|\bnon[\s-]?200\b|\bconnect\b|\btunnel\b/i.test(message);
}

function isProxyConnectFailureResponse(
	response: StealthTransportResponse,
	body: string,
): boolean {
	return (
		response.status === 0 && PROXY_CONNECT_FAILURE_BODY_PATTERN.test(body ?? "")
	);
}

function createProxyConnectFailureError(
	body: string,
	cause?: Error,
): TransportError {
	const bodyExcerpt = (body ?? "").trim().slice(0, 1_000);
	if (isProxyAuthIpDeniedMessage(bodyExcerpt)) {
		return createProxyAuthIpDeniedError(cause);
	}
	if (isProxyEdgeAuthRejectedMessage(bodyExcerpt)) {
		return createProxyEdgeAuthRejectedError(cause);
	}
	if (isProxyPoolStaleMessage(bodyExcerpt)) {
		return createProxyPoolStaleError(
			bodyExcerpt.includes("512") ? 512 : 509,
			cause,
		);
	}
	return new TransportError(bodyExcerpt || "Proxy CONNECT failed", {
		code: PROXY_CONNECT_FAILURE_CODE,
		status: 0,
		cause,
	});
}

function shouldRunProxyAuthDiagnostic(error: unknown): boolean {
	if (!(error instanceof TransportError)) {
		return false;
	}
	if (error.code !== PROXY_POOL_STALE_CODE || error.status !== 512) {
		return false;
	}

	return error.cause instanceof Error;
}

type ResolvedAttemptProxy = {
	url?: string;
	poolIndex?: number;
	proxyHash?: string;
};

function proxyPoolIndexFromDiagnostics(
	diagnostics: Record<string, string | number | boolean> | undefined,
): number | undefined {
	const value = diagnostics?.poolIndex;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

function proxyEndpointHash(proxyUrl: string | undefined): string | undefined {
	if (!proxyUrl) return undefined;
	try {
		const parsed = new URL(proxyUrl);
		return createHash("sha256")
			.update(`${parsed.protocol}//${parsed.host}`)
			.digest("hex")
			.slice(0, 12);
	} catch {
		return createHash("sha256").update(proxyUrl).digest("hex").slice(0, 12);
	}
}

function getProxyTunnelStatus(error: unknown): number | undefined {
	if (isRecord(error)) {
		const status = error.status;
		if (typeof status === "number" && Number.isFinite(status)) {
			return status;
		}
	}

	const cause = error instanceof Error ? error.cause : undefined;
	if (cause && cause !== error) {
		return getProxyTunnelStatus(cause);
	}

	return undefined;
}

function isTimeoutError(error: unknown, message: string): boolean {
	if (error instanceof Error) {
		if (error.name === "AbortError" || error.name === "TimeoutError") {
			return true;
		}
	}

	return /\b(timed out|timeout|deadline exceeded)\b/i.test(message);
}

function normalizeStealthTransportError(error: unknown): TransportError {
	if (error instanceof ProxyResolutionError) {
		return new TransportError(error.message, {
			code: error.code,
			status: 0,
			cause: error,
		});
	}

	if (error instanceof TransportError) {
		return error;
	}

	if (error instanceof SDKError) {
		throw error;
	}

	const message =
		error instanceof Error
			? [error.message, error.cause instanceof Error ? error.cause.message : ""]
					.filter(Boolean)
					.join(" ")
			: String(error);
	if (isTimeoutError(error, message)) {
		return new TransportError("Request timed out", {
			code: "transport_timeout",
			status: 0,
			cause: error instanceof Error ? error : undefined,
		});
	}

	if (isProxyAuthIpDeniedMessage(message)) {
		return createProxyAuthIpDeniedError(
			error instanceof Error ? error : undefined,
		);
	}

	if (isProxyEdgeAuthRejectedMessage(message)) {
		return createProxyEdgeAuthRejectedError(
			error instanceof Error ? error : undefined,
		);
	}

	const proxyTunnelStatus = getProxyTunnelStatus(error);
	if (
		proxyTunnelStatus !== undefined &&
		isProxyPoolStaleStatus(proxyTunnelStatus)
	) {
		return createProxyPoolStaleError(
			proxyTunnelStatus,
			error instanceof Error ? error : undefined,
		);
	}

	if (PROXY_CONNECT_FAILURE_BODY_PATTERN.test(message)) {
		return createProxyConnectFailureError(
			message,
			error instanceof Error ? error : undefined,
		);
	}

	return new TransportError("Network error", {
		code: "transport_network_error",
		status: 0,
		cause: error instanceof Error ? error : undefined,
	});
}

function normalizeMethod(method: HttpMethod | string): StealthMethod {
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
			throw new SDKError(`Unsupported stealth method: ${method}`);
	}
}

function createSessionFetcher(
	baseUrl: string,
	defaultProfile: string,
	clientOptions: StealthClientOptions,
): StealthSession {
	const clients = new Map<string, Impit>();
	let closed = false;
	let hasWarnedMissingProxy = false;
	const warn = clientOptions.warn ?? console.warn;
	const cookieJar = new CookieJarImpl([]);
	const impitCookieJar = toImpitCookieJar(cookieJar);

	function getClient(
		profileName: string,
		proxyUrl: string | undefined,
		ignoreTlsErrors: boolean,
	): Impit {
		if (closed) {
			throw new TransportError("Stealth session is closed", { status: 0 });
		}
		const browser = resolveImpitBrowser(profileName);
		const cacheKey = JSON.stringify({ browser, proxyUrl, ignoreTlsErrors });
		let client = clients.get(cacheKey);
		if (!client) {
			client = new Impit({
				browser,
				cookieJar: impitCookieJar,
				...(proxyUrl ? { proxyUrl } : {}),
				...(ignoreTlsErrors ? { ignoreTlsErrors: true } : {}),
				timeout: 30_000,
			});
			clients.set(cacheKey, client);
		}
		return client;
	}

	async function resolveRequestProxy(
		options?: StealthFetchOptions,
		proxyAttempt?: number,
	): Promise<ResolvedAttemptProxy> {
		const rawProxyAttemptOffset = options?.proxyAttemptOffset ?? 0;
		const proxyAttemptOffset = Number.isFinite(rawProxyAttemptOffset)
			? Math.max(0, Math.floor(rawProxyAttemptOffset))
			: 0;
		const resolvedProxy = await resolveProxyConfigAsync({
			proxy: options?.proxy ?? clientOptions.proxy,
			upstream: clientOptions.upstream,
			apifuseConfig: clientOptions.apifuseConfig,
			affinityKey: clientOptions.affinityKey,
			proxyAttempt:
				proxyAttempt === undefined
					? proxyAttemptOffset
					: proxyAttemptOffset + proxyAttempt,
			telemetry: clientOptions.telemetry,
		});

		if (resolvedProxy.shouldWarn && !hasWarnedMissingProxy) {
			hasWarnedMissingProxy = true;
			warn(MISSING_PROXY_WARNING);
		}

		return {
			url: resolvedProxy.url,
			poolIndex: proxyPoolIndexFromDiagnostics(resolvedProxy.diagnostics),
			proxyHash: proxyEndpointHash(resolvedProxy.url),
		};
	}

	return {
		async fetch(url, options: StealthFetchOptions = {}) {
			const method = normalizeMethod(options.method ?? "GET");
			const hasExplicitRetryPolicy = options.retry !== undefined;
			const stealthRetryOptions = normalizeStealthRetryOptions(options.retry);
			const hasPolicyProxy = isPolicyManagedProxy(clientOptions);
			const usesPolicyAllocator =
				hasPolicyProxy && !options.proxy && !clientOptions.proxy;
			const maxAttempts = usesPolicyAllocator
				? Math.max(
						1,
						Math.min(
							MAX_POLICY_PROXY_RETRY_ATTEMPTS,
							clientOptions.proxyPolicy?.session?.poolSize ??
								(typeof clientOptions.upstream?.proxy === "object"
									? clientOptions.upstream.proxy.session?.poolSize
									: undefined) ??
								DEFAULT_SMARTPROXY_POOL_SIZE,
						),
					)
				: 1;
			let lastError: unknown;

			for (
				let refreshAttempt = 0;
				refreshAttempt <= MAX_POLICY_PROXY_POOL_REFRESHES;
				refreshAttempt += 1
			) {
				let stalePoolError: unknown;
				let stalePoolDiagnosticProxy: string | undefined;
				const attemptedProxies = new Set<string>();

				for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
					let proxy: string | undefined;
					let attemptProxy: ResolvedAttemptProxy | undefined;
					const attemptStartedAt = Date.now();
					let attemptRecorded = false;
					const recordProxyAttempt = (
						outcome: "ok" | "error",
						errorCode?: string,
						status?: number,
					) => {
						if (attemptRecorded || !proxy) return;
						attemptRecorded = true;
						clientOptions.telemetry?.recordProxyAttempt?.({
							provider: "smartproxy",
							attempt: attempt + 1,
							...(attemptProxy?.poolIndex === undefined
								? {}
								: { poolIndex: attemptProxy.poolIndex }),
							...(attemptProxy?.proxyHash
								? { proxyHash: attemptProxy.proxyHash }
								: {}),
							outcome,
							...(errorCode ? { errorCode } : {}),
							...(status === undefined ? {} : { status }),
							durationMs: Date.now() - attemptStartedAt,
						});
					};
					try {
						assertNoUnsupportedFingerprintOverrides(options);
						attemptProxy = await resolveRequestProxy(options, attempt);
						proxy = attemptProxy.url;
						if (proxy) {
							if (attemptedProxies.has(proxy)) {
								break;
							}
							attemptedProxies.add(proxy);
						}
						const ignoreTlsErrors = Boolean(
							options.stealth?.insecureSkipVerify ??
								(!hasPolicyProxy &&
									proxy &&
									clientOptions.proxyStealth?.insecureSkipVerify),
						);
						const profileName = options.profile ?? defaultProfile;
						const requestUrl = appendQueryParams(
							resolveUrl(baseUrl, url),
							options.params,
						);
						const headers = { ...(options.headers ?? {}) };
						if (!hasHeader(headers, "Cookie")) {
							const cookieHeader = cookieJar.toString();
							if (cookieHeader) headers.Cookie = cookieHeader;
						}
						const requestInit: ImpitRequestInit = {
							headers: normalizeHeaders(headers),
							method,
							...(options.timeout ? { timeout: options.timeout } : {}),
						};
						if (options.body !== undefined) {
							requestInit.body = normalizeBody(options.body);
						}
						const response = await getClient(
							profileName,
							proxy,
							ignoreTlsErrors,
						).fetch(requestUrl, requestInit);
						const normalized = await normalizeResponse(response);
						cookieJar.setFromCookieStrings(
							setCookieHeadersFromResponse(response.headers),
						);

						if (
							proxy &&
							isProxyConnectFailureResponse(response, normalized.body)
						) {
							throw createProxyConnectFailureError(normalized.body);
						}

						if (response.status >= 400) {
							if (
								proxy &&
								usesPolicyAllocator &&
								isProxyEdgeTlsRejectedResponse(
									response.status,
									[
										JSON.stringify(responseHeadersToRecord(response.headers)),
										normalized.body,
									].join("\n"),
								)
							) {
								throw createProxyEdgeTlsRejectedError(response.status);
							}
							if (proxy && isProxyAuthIpDeniedMessage(normalized.body)) {
								throw createProxyAuthIpDeniedError();
							}
							if (proxy && isProxyEdgeAuthRejectedMessage(normalized.body)) {
								throw createProxyEdgeAuthRejectedError();
							}
							if (
								proxy &&
								isProxyPoolStaleStatus(response.status) &&
								isProxyPoolStaleMessage(normalized.body)
							) {
								throw createProxyPoolStaleError(response.status);
							}
						}

						if (response.status >= 400 && options.throwOnHttpError !== false) {
							throw new TransportError(
								`Upstream request failed with status ${response.status}`,
								{
									code: "upstream_http_error",
									status: response.status,
								},
							);
						}

						recordProxyAttempt("ok", undefined, response.status);
						return normalized;
					} catch (error) {
						const normalizedError = normalizeStealthTransportError(error);
						recordProxyAttempt(
							"error",
							proxyAttemptErrorCode(normalizedError),
							proxyAttemptStatus(normalizedError),
						);
						lastError = normalizedError;
						if (
							proxy &&
							usesPolicyAllocator &&
							isProxyPoolRefreshableError(normalizedError)
						) {
							stalePoolError = normalizedError;
							if (shouldRunProxyAuthDiagnostic(normalizedError)) {
								stalePoolDiagnosticProxy = proxy;
							}
							if (attempt + 1 < maxAttempts) {
								continue;
							}
							break;
						}
						if (
							proxy &&
							attempt + 1 <
								(stealthRetryOptions
									? Math.min(maxAttempts, stealthRetryOptions.attempts)
									: maxAttempts) &&
							(!hasExplicitRetryPolicy
								? isRetrySafeStealthMethod(method)
								: isExplicitStealthRetryAllowed(
										method,
										normalizedError,
										stealthRetryOptions,
									)) &&
							isRetryableProxyTransportError(normalizedError)
						) {
							continue;
						}
						throw normalizedError;
					}
				}

				if (
					usesPolicyAllocator &&
					stalePoolError &&
					refreshAttempt < MAX_POLICY_PROXY_POOL_REFRESHES
				) {
					await invalidateProxyResolutionCacheAsync({
						proxyPolicy: clientOptions.proxyPolicy,
						upstream: clientOptions.upstream,
						affinityKey: clientOptions.affinityKey,
					});
					continue;
				}

				const proxyAuthDiagnostic =
					stalePoolError && stalePoolDiagnosticProxy
						? await classifyProxyAuthDiagnostic(
								options.profile ?? defaultProfile,
								stalePoolDiagnosticProxy,
							)
						: undefined;
				if (proxyAuthDiagnostic === "source_ip_denied") {
					throw createProxyAuthIpDeniedError(
						stalePoolError instanceof Error ? stalePoolError : undefined,
					);
				}
				if (proxyAuthDiagnostic === "edge_auth_rejected") {
					throw createProxyEdgeAuthRejectedError(
						stalePoolError instanceof Error ? stalePoolError : undefined,
					);
				}

				if (stalePoolError) {
					if (
						stalePoolError instanceof TransportError &&
						stalePoolError.code === PROXY_EDGE_AUTH_REJECTED_CODE
					) {
						throw stalePoolError;
					}
					throw createProxyPoolExhaustedError(
						stalePoolError instanceof Error ? stalePoolError : undefined,
					);
				}
				break;
			}

			throw normalizeStealthTransportError(lastError);
		},
		close() {
			closed = true;
			clients.clear();
		},
	};

	async function classifyProxyAuthDiagnostic(
		profileName: string,
		proxy: string,
	): Promise<"source_ip_denied" | "edge_auth_rejected" | undefined> {
		try {
			const response = await getClient(profileName, proxy, false).fetch(
				PROXY_AUTH_DIAGNOSTIC_URL,
				{
					method: "GET",
					timeout: PROXY_AUTH_DIAGNOSTIC_TIMEOUT_MS,
				},
			);
			const normalized = await normalizeResponse(response);
			return classifyProxyAuthDiagnosticMessage(normalized.body);
		} catch (error) {
			const message =
				error instanceof Error
					? [
							error.message,
							error.cause instanceof Error ? error.cause.message : "",
						]
							.filter(Boolean)
							.join(" ")
					: String(error);
			return classifyProxyAuthDiagnosticMessage(message);
		}
	}
}

function classifyProxyAuthDiagnosticMessage(
	message: string,
): "source_ip_denied" | "edge_auth_rejected" | undefined {
	if (isProxyAuthIpDeniedMessage(message)) {
		return "source_ip_denied";
	}
	if (isProxyEdgeAuthRejectedMessage(message)) {
		return "edge_auth_rejected";
	}
	return undefined;
}

function proxyAttemptErrorCode(error: TransportError): string {
	return error.code ?? error.name ?? "transport_error";
}

function proxyAttemptStatus(error: TransportError): number | undefined {
	return error.status ?? error.upstreamStatus;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const needle = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === needle);
}

export function createStealthClient(
	baseUrl: string,
	defaultProfileOrOptions: string | StealthClientOptions = DEFAULT_PROFILE,
	clientOptions: StealthClientOptions = {},
): StealthClient {
	const defaultProfile =
		typeof defaultProfileOrOptions === "string"
			? defaultProfileOrOptions
			: DEFAULT_PROFILE;
	const resolvedClientOptions =
		typeof defaultProfileOrOptions === "string"
			? clientOptions
			: defaultProfileOrOptions;
	let sharedSession: StealthSession | null = null;

	function getSharedSession(): StealthSession {
		if (!sharedSession) {
			sharedSession = createSessionFetcher(
				baseUrl,
				defaultProfile,
				resolvedClientOptions,
			);
		}

		return sharedSession;
	}

	return {
		fetch(url: string, options?: StealthFetchOptions) {
			return getSharedSession().fetch(url, options);
		},
		createSession(opts?: { profile?: string }) {
			const sessionProfile = opts?.profile ?? defaultProfile;
			return createSessionFetcher(
				baseUrl,
				sessionProfile,
				resolvedClientOptions,
			);
		},
		close() {
			sharedSession?.close();
			sharedSession = null;
		},
	};
}
