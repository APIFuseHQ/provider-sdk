import { createHash } from "node:crypto";
import type { Browser, ImpitOptions, ImpitResponse, RequestInit } from "impit";
import { Impit } from "impit";

import type { ProxyResolutionOptions, ProxyVendorName } from "../config/loader.js";
import {
	DEFAULT_SMARTPROXY_POOL_SIZE,
	invalidateProxyResolutionCacheAsync,
	policyResolvesRegistryVendorChain,
	ProxyResolutionError,
	resolvePolicyProxyPoolSpan,
	resolvePolicyTransportAttemptCap,
	resolveProxyConfigAsync,
	vendorFromResolvedSource,
} from "../config/loader.js";
import { SDKError, TransportError } from "../errors.js";
import { getStealthProfile } from "../stealth/profiles.js";
import type {
	CookieJar,
	HttpMethod,
	StealthClient,
	StealthFetchOptions,
	StealthRedirectHop,
	StealthResponse,
	StealthSession,
} from "../types.js";
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
	PROXY_EDGE_AUTH_REJECTED_CODE,
	PROXY_POOL_STALE_CODE,
} from "./proxy-errors.js";
import {
	computeProxyAttemptIndex,
	computeProxyTransportRetryDelayMs,
	createDefaultProxyTransportRetryOptions,
	normalizeProxyTransportRetryOptions,
	shouldRetryProxyTransportAttempt,
	validateUnsafeProxyTransportRetryMethods,
} from "./proxy-retry-policy.js";
import { appendQueryParams } from "./request-options.js";

const DEFAULT_PROFILE = "chrome-146";

const MISSING_PROXY_WARNING =
	"[provider-sdk] Provider requested proxy routing, but no proxy URL was configured. Continuing without proxy.";

const MAX_POLICY_PROXY_POOL_REFRESHES = 1;
const PROXY_CONNECT_FAILURE_CODE = "proxy_connect_failed";
const PROXY_CONNECT_FAILURE_BODY_PATTERN =
	/\bproxy\b.*\b(non[\s-]?200|connect|tunnel)|\bconnect\b.*\bproxy\b|\btunnel\b/i;
const PROXY_AUTH_DIAGNOSTIC_URL = "http://example.com/";
const PROXY_AUTH_DIAGNOSTIC_TIMEOUT_MS = 5_000;
const STEALTH_PROXY_TRANSPORT_RETRY_ERROR_CODES = [PROXY_CONNECT_FAILURE_CODE] as const;

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
	"arrayBuffer" | "headers" | "json" | "ok" | "status" | "text"
> & {
	url?: string;
	redirected?: boolean;
};

type StealthMethod = NonNullable<ImpitRequestInit["method"]>;
type StealthRequestInit = ImpitRequestInit & {
	redirect?: NonNullable<StealthFetchOptions["redirect"]>;
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

	has(name: string): boolean {
		return Object.hasOwn(this.cookies, name);
	}

	toString(): string {
		return Object.entries(this.cookies)
			.map(([name, value]) => `${name}=${value}`)
			.join("; ");
	}

	toHeader(): string {
		return this.toString();
	}

	snapshot(): Record<string, string> {
		return this.getAll();
	}

	restore(cookies: Record<string, string>): void {
		this.clear();
		for (const [name, value] of Object.entries(cookies)) {
			if (name) this.cookies[name] = value;
		}
	}

	clear(): void {
		for (const name of Object.keys(this.cookies)) {
			delete this.cookies[name];
		}
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
function toImpitCookieJar(cookieJar: CookieJarImpl): NonNullable<ImpitOptions["cookieJar"]> {
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
	if (isRecord(stealth) && hasOwn(stealth, "ja3")) unsupported.push("stealth.ja3");
	if (isRecord(stealth) && hasOwn(stealth, "h2")) unsupported.push("stealth.h2");
	if (unsupported.length === 0) return;

	throw new SDKError(
		`ctx.stealth.fetch uses impit-managed browser fingerprints and no longer accepts low-level stealth overrides: ${unsupported.join(", ")}. Use the profile option instead.`,
	);
}

function responseHeadersToRecord(headers: Headers): Record<string, string | string[] | undefined> {
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
	requestUrl?: string,
): Promise<StealthResponse> {
	const headers = Object.fromEntries(response.headers.entries());
	const cookies = new CookieJarImpl(setCookieHeadersFromResponse(response.headers));
	const bodyBytes = await response.arrayBuffer();
	const body = new TextDecoder().decode(bodyBytes);

	return {
		status: response.status,
		ok: response.status >= 200 && response.status < 300,
		...(response.url ? { url: response.url } : {}),
		...(response.redirected !== undefined
			? { redirected: response.redirected }
			: requestUrl && response.url
				? { redirected: response.url !== requestUrl }
				: {}),
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

function isProxyConnectFailureResponse(response: StealthTransportResponse, body: string): boolean {
	return response.status === 0 && PROXY_CONNECT_FAILURE_BODY_PATTERN.test(body ?? "");
}

function createProxyConnectFailureError(body: string, cause?: Error): TransportError {
	const bodyExcerpt = (body ?? "").trim().slice(0, 1_000);
	if (isProxyAuthIpDeniedMessage(bodyExcerpt)) {
		return createProxyAuthIpDeniedError(cause);
	}
	if (isProxyEdgeAuthRejectedMessage(bodyExcerpt)) {
		return createProxyEdgeAuthRejectedError(cause);
	}
	if (isProxyPoolStaleMessage(bodyExcerpt)) {
		return createProxyPoolStaleError(bodyExcerpt.includes("512") ? 512 : 509, cause);
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
	vendor?: ProxyVendorName;
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
		return createProxyAuthIpDeniedError(error instanceof Error ? error : undefined);
	}

	if (isProxyEdgeAuthRejectedMessage(message)) {
		return createProxyEdgeAuthRejectedError(error instanceof Error ? error : undefined);
	}

	const proxyTunnelStatus = getProxyTunnelStatus(error);
	if (proxyTunnelStatus !== undefined && isProxyPoolStaleStatus(proxyTunnelStatus)) {
		return createProxyPoolStaleError(proxyTunnelStatus, error instanceof Error ? error : undefined);
	}

	if (PROXY_CONNECT_FAILURE_BODY_PATTERN.test(message)) {
		return createProxyConnectFailureError(message, error instanceof Error ? error : undefined);
	}

	return new TransportError("Network error", {
		code: "transport_network_error",
		status: 0,
		cause: error instanceof Error ? error : undefined,
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

function isRedirectStatus(status: number): boolean {
	return [301, 302, 303, 307, 308].includes(status);
}

function nextRedirectMethod(status: number, method: StealthMethod): StealthMethod {
	if (status === 303 && method !== "HEAD") return "GET";
	if ((status === 301 || status === 302) && method === "POST") return "GET";
	return method;
}

function locationHeader(headers: Record<string, string>): string | undefined {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === "location") return value;
	}
	return undefined;
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
		refreshEpoch?: number,
	): Promise<ResolvedAttemptProxy> {
		const resolvedProxy = await resolveProxyConfigAsync({
			proxy: options?.proxy ?? clientOptions.proxy,
			upstream: clientOptions.upstream,
			apifuseConfig: clientOptions.apifuseConfig,
			affinityKey: clientOptions.affinityKey,
			proxyAttempt: computeProxyAttemptIndex({
				baseProxyAttempt: clientOptions.proxyAttempt,
				proxyAttemptOffset: options?.proxyAttemptOffset,
				retryAttemptOffset: proxyAttempt,
			}),
			// The impit stealth transport tunnels both HTTP CONNECT and SOCKS5,
			// preserving the client TLS fingerprint end-to-end.
			transportProtocols: ["http", "socks5"],
			...(refreshEpoch === undefined ? {} : { proxyRefreshEpoch: refreshEpoch }),
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
			vendor: vendorFromResolvedSource(resolvedProxy.source),
		};
	}

	const session: StealthSession = {
		async fetch(url, options: StealthFetchOptions = {}) {
			const method = normalizeMethod(options.method ?? "GET");
			const hasExplicitRetryPolicy = options.retry !== undefined;
			const stealthRetryOptions =
				normalizeProxyTransportRetryOptions(options.retry, {
					extraErrorCodes: STEALTH_PROXY_TRANSPORT_RETRY_ERROR_CODES,
					label: "Stealth",
				}) ??
				(hasExplicitRetryPolicy
					? undefined
					: createDefaultProxyTransportRetryOptions({
							extraErrorCodes: STEALTH_PROXY_TRANSPORT_RETRY_ERROR_CODES,
							label: "Stealth",
						}));
			if (stealthRetryOptions) {
				validateUnsafeProxyTransportRetryMethods(stealthRetryOptions, "Stealth");
			}
			const hasPolicyProxy = isPolicyManagedProxy(clientOptions);
			const usesPolicyAllocator = hasPolicyProxy && !options.proxy && !clientOptions.proxy;
			const retryAttemptCap = Math.max(1, stealthRetryOptions?.attempts ?? 1);
			// Span the whole vendor chain: successive attempts rotate one vendor's
			// pool, then fail over to the next vendor via the flat attempt index.
			const policyProxy =
				clientOptions.proxyPolicy ??
				(typeof clientOptions.upstream?.proxy === "object"
					? clientOptions.upstream.proxy
					: undefined);
			// The pool span is already bounded by each vendor's max pool size
			// (smartproxy ≤20, nodemaven ≤50), so the configured span never exceeds
			// the chain's true maximum — a large NodeMaven pool stays fully
			// reachable rather than being truncated at an arbitrary ceiling.
			const policyProxyAttemptCap = Math.max(
				1,
				policyProxy ? resolvePolicyProxyPoolSpan(policyProxy) : DEFAULT_SMARTPROXY_POOL_SIZE,
			);
			// A registry vendor chain (smartproxy/nodemaven) is the only policy whose
			// successive attempts resolve a *different* endpoint, so it is the only one
			// that may widen the attempt cap to the pool span, de-duplicate endpoints,
			// and drive allocator stale-pool refresh. A static custom/decodo policy
			// resolves the same URL every attempt: widening/refreshing it would resend
			// the request dozens of times (up to maxAttempts × refreshes) and bypass
			// retry:false and unsafe-method controls. Static policies therefore follow
			// the ordinary transport-retry budget instead.
			const rotatesRegistryChain =
				usesPolicyAllocator && policyResolvesRegistryVendorChain(policyProxy);
			const maxAttempts = rotatesRegistryChain ? policyProxyAttemptCap : retryAttemptCap;
			const dedupeAllocatorEndpoints = rotatesRegistryChain;
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
							provider: attemptProxy?.vendor ?? "smartproxy",
							attempt: attempt + 1,
							...(attemptProxy?.poolIndex === undefined
								? {}
								: { poolIndex: attemptProxy.poolIndex }),
							...(attemptProxy?.proxyHash ? { proxyHash: attemptProxy.proxyHash } : {}),
							outcome,
							...(errorCode ? { errorCode } : {}),
							...(status === undefined ? {} : { status }),
							durationMs: Date.now() - attemptStartedAt,
						});
					};
					try {
						assertNoUnsupportedFingerprintOverrides(options);
						attemptProxy = await resolveRequestProxy(options, attempt, refreshAttempt);
						proxy = attemptProxy.url;
						if (proxy && dedupeAllocatorEndpoints) {
							// An under-filled allocation repeats endpoints (via the modulo
							// pool mapping) before the flat offset crosses into the next
							// vendor. Skip an already-tried endpoint and advance the offset
							// rather than breaking — breaking here would strand the request on
							// the primary vendor and never reach the fallback leg.
							if (attemptedProxies.has(proxy)) {
								continue;
							}
							attemptedProxies.add(proxy);
						}
						const ignoreTlsErrors = Boolean(
							options.stealth?.insecureSkipVerify ??
								(!hasPolicyProxy && proxy && clientOptions.proxyStealth?.insecureSkipVerify),
						);
						const profileName = options.profile ?? defaultProfile;
						const requestUrl = appendQueryParams(resolveUrl(baseUrl, url), options.params);
						const headers = { ...(options.headers ?? {}) };
						if (!hasHeader(headers, "Cookie")) {
							const cookieHeader = cookieJar.toString();
							if (cookieHeader) headers.Cookie = cookieHeader;
						}
						const requestInit: StealthRequestInit = {
							headers: normalizeHeaders(headers),
							method,
							...(options.redirect ? { redirect: options.redirect } : {}),
							...(options.timeout ? { timeout: options.timeout } : {}),
						};
						if (options.body !== undefined) {
							requestInit.body = normalizeBody(options.body);
						}
						const response = await getClient(profileName, proxy, ignoreTlsErrors).fetch(
							requestUrl,
							requestInit,
						);
						const normalized = await normalizeResponse(response, requestUrl);
						cookieJar.setFromCookieStrings(setCookieHeadersFromResponse(response.headers));

						if (proxy && isProxyConnectFailureResponse(response, normalized.body)) {
							throw createProxyConnectFailureError(normalized.body);
						}

						if (response.status >= 400) {
							if (
								proxy &&
								usesPolicyAllocator &&
								isProxyEdgeTlsRejectedResponse(
									response.status,
									[JSON.stringify(responseHeadersToRecord(response.headers)), normalized.body].join(
										"\n",
									),
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
							throw new TransportError(`Upstream request failed with status ${response.status}`, {
								code: "upstream_http_error",
								status: response.status,
							});
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
						if (proxy && rotatesRegistryChain && isProxyPoolRefreshableError(normalizedError)) {
							stalePoolError = normalizedError;
							if (shouldRunProxyAuthDiagnostic(normalizedError)) {
								stalePoolDiagnosticProxy = proxy;
							}
							if (attempt + 1 < maxAttempts) {
								continue;
							}
							break;
						}
						// Cap the number of transport retries. For a policy-allocator chain,
						// every attempt resolves a *different* endpoint/vendor (poolIndex
						// rotates across the concatenated vendor pool spans), so a transport
						// failure is a signal to advance to the next endpoint — potentially
						// crossing into the fallback vendor — not to retry the same endpoint.
						// Truncating that rotation at the per-endpoint retry budget would
						// strand the request on the primary vendor and never reach the
						// fallback, since the crossover only happens once the flat attempt
						// index exceeds the primary vendor's pool size (~10-20).
						// resolvePolicyTransportAttemptCap widens to the full chain span only
						// for implicit, safe-method allocator requests; explicit retry
						// policies (their documented `attempts` ceiling), unsafe methods, and
						// static/non-registry vendors keep the per-endpoint retry budget.
						const transportRetryCap = resolvePolicyTransportAttemptCap({
							policy: policyProxy,
							usesPolicyAllocator,
							retryAttempts: stealthRetryOptions?.attempts ?? 1,
							explicitRetry: hasExplicitRetryPolicy,
							method,
						});
						if (
							attempt + 1 < transportRetryCap &&
							shouldRetryProxyTransportAttempt({
								error: normalizedError,
								explicitRetry: hasExplicitRetryPolicy,
								method,
								options: stealthRetryOptions,
								proxyUsed: Boolean(proxy),
							})
						) {
							if (stealthRetryOptions) {
								await sleep(computeProxyTransportRetryDelayMs(stealthRetryOptions!, attempt + 1));
							}
							continue;
						}
						throw normalizedError;
					}
				}

				if (
					rotatesRegistryChain &&
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
		cookies: cookieJar,
		redirects: {
			async run(options) {
				const maxHops =
					options.maxHops === undefined || !Number.isFinite(options.maxHops)
						? 10
						: Math.max(0, Math.floor(options.maxHops));
				const hops: StealthRedirectHop[] = [];
				let currentUrl = resolveUrl(baseUrl, options.url);
				let method = normalizeMethod(options.method ?? "GET");
				let body = options.body;
				let response: StealthResponse | undefined;
				const visitedRequests = new Set<string>();

				const { url: _url, maxHops: _maxHops, stopWhen, params, ...fetchOptions } = options;

				for (let hopIndex = 0; hopIndex <= maxHops; hopIndex += 1) {
					visitedRequests.add(`${method} ${currentUrl}`);
					response = await session.fetch(currentUrl, {
						...fetchOptions,
						body,
						method,
						...(hopIndex === 0 && params ? { params } : {}),
						redirect: "manual",
						throwOnHttpError: false,
					});

					if (!isRedirectStatus(response.status)) {
						return {
							final: response,
							hops,
							reason: "completed",
							cookies: cookieJar.snapshot(),
						};
					}

					const location = locationHeader(response.headers);
					const nextUrl = location
						? new URL(location, response.url ?? currentUrl).toString()
						: undefined;
					const hop: StealthRedirectHop = {
						url: response.url ?? currentUrl,
						status: response.status,
						method,
						...(location ? { location } : {}),
						...(nextUrl ? { nextUrl } : {}),
					};
					hops.push(hop);

					if (stopWhen && (await stopWhen(hop))) {
						return {
							final: response,
							hops,
							reason: "stopped",
							cookies: cookieJar.snapshot(),
						};
					}

					if (!nextUrl) {
						return {
							final: response,
							hops,
							reason: "missing_location",
							cookies: cookieJar.snapshot(),
						};
					}

					if (hops.length > maxHops) {
						return {
							final: response,
							hops,
							reason: "max_hops",
							cookies: cookieJar.snapshot(),
						};
					}

					const nextMethod = nextRedirectMethod(response.status, method);
					if (nextMethod !== method) {
						body = undefined;
					}
					if (visitedRequests.has(`${nextMethod} ${nextUrl}`)) {
						return {
							final: response,
							hops,
							reason: "loop",
							cookies: cookieJar.snapshot(),
						};
					}
					method = nextMethod;
					currentUrl = nextUrl;
				}

				if (!response) {
					response = await session.fetch(currentUrl, {
						...fetchOptions,
						body,
						method,
						...(params ? { params } : {}),
						redirect: "manual",
						throwOnHttpError: false,
					});
				}
				return {
					final: response,
					hops,
					reason: "max_hops",
					cookies: cookieJar.snapshot(),
				};
			},
		},
		close() {
			closed = true;
			clients.clear();
		},
	};
	return session;

	async function classifyProxyAuthDiagnostic(
		profileName: string,
		proxy: string,
	): Promise<"source_ip_denied" | "edge_auth_rejected" | undefined> {
		try {
			const response = await getClient(profileName, proxy, false).fetch(PROXY_AUTH_DIAGNOSTIC_URL, {
				method: "GET",
				timeout: PROXY_AUTH_DIAGNOSTIC_TIMEOUT_MS,
			});
			const normalized = await normalizeResponse(response);
			return classifyProxyAuthDiagnosticMessage(normalized.body);
		} catch (error) {
			const message =
				error instanceof Error
					? [error.message, error.cause instanceof Error ? error.cause.message : ""]
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
		typeof defaultProfileOrOptions === "string" ? defaultProfileOrOptions : DEFAULT_PROFILE;
	const resolvedClientOptions =
		typeof defaultProfileOrOptions === "string" ? clientOptions : defaultProfileOrOptions;
	let sharedSession: StealthSession | null = null;

	function getSharedSession(): StealthSession {
		if (!sharedSession) {
			sharedSession = createSessionFetcher(baseUrl, defaultProfile, resolvedClientOptions);
		}

		return sharedSession;
	}

	return {
		fetch(url: string, options?: StealthFetchOptions) {
			return getSharedSession().fetch(url, options);
		},
		createSession(opts?: { profile?: string }) {
			const sessionProfile = opts?.profile ?? defaultProfile;
			return createSessionFetcher(baseUrl, sessionProfile, resolvedClientOptions);
		},
		close() {
			sharedSession?.close();
			sharedSession = null;
		},
	};
}
