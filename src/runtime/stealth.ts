import { createHash } from "node:crypto";
import type {
	BrowserProfile,
	EmulationOS,
	RequestInit as WreqRequestInit,
	Session as WreqSession,
} from "wreq-js";

import type { ProxyResolutionOptions, ProxyVendorName } from "../config/loader.js";
import {
	DEFAULT_SMARTPROXY_POOL_SIZE,
	invalidateProxyResolutionCacheAsync,
	ProxyResolutionError,
	policyResolvesRegistryVendorChain,
	resolvePolicyProxyPoolSpan,
	resolvePolicyTransportAttemptCap,
	resolveProxyConfigAsync,
	vendorFromResolvedSource,
} from "../config/loader.js";
import { SDKError, TransportError } from "../errors.js";
import { getStealthProfile } from "../stealth/profiles.js";
import type {
	HttpMethod,
	StealthClient,
	StealthFetchOptions,
	StealthRedirectHop,
	StealthResponse,
	StealthSession,
} from "../types.js";
import { StealthCookieJar } from "./stealth-cookies.js";
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
import {
	evaluateRedirectHop,
	isRedirectStatus,
	nextRedirectMethod,
	resolveRedirectUrl,
} from "./redirects.js";
import {
	isSensitiveKey,
	normalizeSensitiveParams,
	redactSensitiveError,
	redactSensitiveRequestError,
	redactSensitiveText,
	redactUrlQueryParams,
	serializeRequestUrl,
} from "./request-options.js";

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
const MAX_STEALTH_REDIRECT_HOPS = 10;
const REDIRECT_BODY_HEADERS = new Set([
	"content-encoding",
	"content-language",
	"content-location",
	"content-type",
]);

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

function sensitiveQueryParamNames(url: string): string[] {
	const queryStart = url.indexOf("?");
	if (queryStart === -1) return [];
	const fragmentStart = url.indexOf("#", queryStart);
	const query = url.slice(queryStart + 1, fragmentStart === -1 ? undefined : fragmentStart);
	return [...new URLSearchParams(query).keys()].filter(isSensitiveKey);
}

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

type StealthTransportHeaders = {
	entries(): IterableIterator<[string, string]>;
	get(name: string): string | null;
	getSetCookie?: () => string[];
};

type StealthTransportBody = {
	cancel(): Promise<void>;
	getReader(): {
		read(): Promise<{ done: boolean; value?: Uint8Array }>;
		cancel(): Promise<void>;
		releaseLock(): void;
	};
};

type StealthTransportResponse = {
	arrayBuffer(): Promise<ArrayBuffer>;
	headers: StealthTransportHeaders;
	status: number;
	body?: StealthTransportBody | null;
	url?: string;
	redirected?: boolean;
};

type StealthMethod = HttpMethod | "TRACE";
type StealthRequestInit = WreqRequestInit & {
	redirect?: NonNullable<StealthFetchOptions["redirect"]>;
};

type WreqSessionCacheEntry = {
	session: Promise<WreqSession>;
	tail: Promise<void>;
};

type WreqModule = typeof import("wreq-js");

let wreqModulePromise: Promise<WreqModule> | undefined;

function getWreqModule(): Promise<WreqModule> {
	if (!wreqModulePromise) {
		wreqModulePromise = import("wreq-js").catch((error: unknown) => {
			throw new SDKError(
				`Stealth transport is unavailable on ${process.platform}-${process.arch}: the wreq-js native binary could not be loaded.`,
				{
					code: "stealth_transport_unavailable",
					cause: error instanceof Error ? error : undefined,
				},
			);
		});
	}

	return wreqModulePromise;
}

function parseProfileIdentifier(identifier: string): {
	family: string;
	version: number[];
} | null {
	const match =
		/^(safari_ios|safari_ipad|firefox_android|firefox_private|chrome|edge|firefox|opera|safari|okhttp)_(\d+(?:[._]\d+)*)$/.exec(
			identifier.toLowerCase(),
		);
	if (!match?.[1] || !match[2]) return null;
	return {
		family: match[1],
		version: match[2].split(/[._]/).map(Number),
	};
}

function compareVersionDistance(target: number[], left: number[], right: number[]): number {
	const width = Math.max(target.length, left.length, right.length);
	for (let index = 0; index < width; index += 1) {
		const targetPart = target[index] ?? 0;
		const leftDistance = Math.abs((left[index] ?? 0) - targetPart);
		const rightDistance = Math.abs((right[index] ?? 0) - targetPart);
		if (leftDistance !== rightDistance) return leftDistance - rightDistance;
	}
	return 0;
}

function closestWreqProfile(
	identifier: string,
	wreqProfiles: readonly BrowserProfile[],
): BrowserProfile | undefined {
	const requested = parseProfileIdentifier(identifier);
	if (!requested) return undefined;

	let closest: { name: BrowserProfile; version: number[] } | undefined;
	for (const candidateName of wreqProfiles) {
		const candidate = parseProfileIdentifier(candidateName);
		if (!candidate || candidate.family !== requested.family) continue;
		if (
			!closest ||
			compareVersionDistance(requested.version, candidate.version, closest.version) < 0
		) {
			closest = { name: candidateName, version: candidate.version };
		}
	}
	return closest?.name;
}

function resolveDefaultWreqProfileMapping(): { identifier: string; os: EmulationOS } {
	let profile: ReturnType<typeof getStealthProfile>;
	try {
		profile = getStealthProfile(DEFAULT_PROFILE);
	} catch (error) {
		throw new SDKError(
			`Default stealth profile "${DEFAULT_PROFILE}" cannot be mapped to a wreq-js browser profile.`,
			{ cause: error instanceof Error ? error : undefined },
		);
	}

	const identifier = profile.tlsClientIdentifier?.toLowerCase() ?? "";
	if (!parseProfileIdentifier(identifier)) {
		throw new SDKError(
			`Default stealth profile "${DEFAULT_PROFILE}" cannot be mapped to a wreq-js browser profile.`,
		);
	}
	return { identifier, os: profile.platform };
}

const DEFAULT_WREQ_PROFILE_MAPPING = resolveDefaultWreqProfileMapping();

export function resolveWreqProfile(
	profileName: string,
	wreqProfiles: readonly BrowserProfile[],
): {
	browser: BrowserProfile;
	os: EmulationOS;
} {
	if (REMOVED_CHROME_PROFILE_NAMES.has(profileName)) {
		throw new SDKError(`Unknown stealth profile: ${profileName}`);
	}

	let identifier: string;
	let os: EmulationOS;
	try {
		const profile = getStealthProfile(profileName);
		identifier = profile.tlsClientIdentifier?.toLowerCase() ?? "";
		os = profile.platform;
	} catch {
		// Preserve the previous ctx.stealth.fetch() compatibility behavior: unknown
		// profile strings still run with the transport default instead of failing
		// before the request starts. Removed built-in profile aliases above remain
		// explicit errors so callers do not accidentally pin retired fingerprints.
		identifier = DEFAULT_WREQ_PROFILE_MAPPING.identifier;
		os = DEFAULT_WREQ_PROFILE_MAPPING.os;
	}

	const browser = closestWreqProfile(identifier, wreqProfiles);
	if (!browser) {
		throw new SDKError(
			`Stealth profile "${profileName}" cannot be mapped to a wreq-js browser profile.`,
		);
	}
	return { browser, os };
}

function resolveUrl(baseUrl: string, url: string): string {
	return new URL(url, baseUrl).toString();
}

function headerEntriesFromHeaders(headers: StealthTransportHeaders): [string, string][] {
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

function assertNoUnsupportedFingerprintOverrides(options: unknown): void {
	if (!isRecord(options)) return;
	const unsupported: string[] = [];
	if (hasOwn(options, "headerOrder")) unsupported.push("headerOrder");
	const stealth = options.stealth;
	if (isRecord(stealth) && hasOwn(stealth, "ja3")) unsupported.push("stealth.ja3");
	if (isRecord(stealth) && hasOwn(stealth, "h2")) unsupported.push("stealth.h2");
	if (unsupported.length === 0) return;

	throw new SDKError(
		`ctx.stealth.fetch uses transport-managed browser fingerprints and no longer accepts low-level stealth overrides: ${unsupported.join(", ")}. Use the profile option instead.`,
	);
}

function responseHeadersToRecord(
	headers: StealthTransportHeaders,
): Record<string, string | string[] | undefined> {
	const record: Record<string, string> = {};
	for (const [name, value] of headers.entries()) record[name] = value;
	return record;
}

function setCookieHeadersFromResponse(headers: StealthTransportHeaders): string[] {
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
	maxBodyBytes?: number,
): Promise<StealthResponse> {
	const headers = Object.fromEntries(response.headers.entries());
	const cookies = new StealthCookieJar(
		setCookieHeadersFromResponse(response.headers),
		response.url ?? requestUrl,
	);
	const bodyBytes =
		maxBodyBytes === undefined
			? await response.arrayBuffer()
			: await readResponseBodyWithLimit(response, maxBodyBytes);
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

function responseTooLargeError(maxBodyBytes: number, observedBytes: number): TransportError {
	return new TransportError(
		`Response body exceeded maxBodyBytes limit of ${maxBodyBytes} bytes (observed ${observedBytes} bytes)`,
		{
			code: "response_too_large",
			category: "upstream_http",
			retryable: false,
			status: 0,
		},
	);
}

function declaredContentLength(headers: StealthTransportHeaders): number | undefined {
	const contentLength = headers.get("content-length")?.trim();
	if (!contentLength || !/^\d+$/.test(contentLength)) return undefined;
	const parsed = Number(contentLength);
	return Number.isFinite(parsed) ? parsed : undefined;
}

async function readResponseBodyWithLimit(
	response: StealthTransportResponse,
	maxBodyBytes: number,
): Promise<ArrayBuffer> {
	const contentLength = declaredContentLength(response.headers);
	if (contentLength !== undefined && contentLength > maxBodyBytes) {
		await response.body?.cancel().catch(() => undefined);
		throw responseTooLargeError(maxBodyBytes, contentLength);
	}

	if (!response.body) {
		throw new TransportError("Response body stream is unavailable", {
			code: "transport_stream_unavailable",
			category: "upstream_http",
			status: 0,
		});
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let receivedBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			receivedBytes += value.byteLength;
			if (receivedBytes > maxBodyBytes) {
				await reader.cancel().catch(() => undefined);
				throw responseTooLargeError(maxBodyBytes, receivedBytes);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bodyBytes = new Uint8Array(receivedBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bodyBytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bodyBytes.buffer;
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

function locationHeader(headers: Record<string, string>): string | undefined {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === "location") return value;
	}
	return undefined;
}

function withoutRedirectBodyHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => !REDIRECT_BODY_HEADERS.has(name.toLowerCase())),
	);
}

function assertStealthRedirectUrl(url: string): void {
	const protocol = new URL(url).protocol;
	if (protocol !== "http:" && protocol !== "https:") {
		throw new TransportError(`Stealth redirect target scheme "${protocol}" is not allowed`, {
			code: "transport_invalid_url",
			status: 0,
		});
	}
}

function discardStealthRedirectBody(response: StealthTransportResponse): void {
	try {
		const cancellation = response.body?.cancel();
		if (cancellation) void cancellation.catch(() => undefined);
	} catch {
		// Redirect handling is decided from status and headers. A cancellation
		// failure must not replace or delay that decision.
	}
}

async function fetchStealthRedirectChain(
	transport: WreqSession,
	cookieJar: StealthCookieJar,
	requestUrl: string,
	method: StealthMethod,
	options: StealthFetchOptions,
): Promise<{ normalized: StealthResponse; response: StealthTransportResponse }> {
	let currentUrl = requestUrl;
	let currentMethod = method;
	let currentBody = options.body === undefined ? undefined : normalizeBody(options.body);
	let currentHeaders = { ...(options.headers ?? {}) };
	let followedHops = 0;
	let response: StealthTransportResponse;
	const deadline = options.timeout ? performance.now() + options.timeout : undefined;

	while (true) {
		const headers = { ...currentHeaders };
		if (!hasHeader(headers, "Cookie")) {
			const cookieHeader = cookieJar.toHeader(currentUrl);
			if (cookieHeader) headers.Cookie = cookieHeader;
		}
		const requestInit: StealthRequestInit = {
			headers: normalizeHeaders(headers),
			method: currentMethod,
			redirect: "manual",
		};
		if (currentBody !== undefined) requestInit.body = currentBody;

		await transport.clearCookies();
		const remainingTimeout =
			deadline === undefined ? undefined : Math.ceil(deadline - performance.now());
		if (remainingTimeout !== undefined && remainingTimeout <= 0) {
			throw new TransportError("Request timed out", {
				code: "transport_timeout",
				status: 0,
			});
		}
		if (remainingTimeout !== undefined) requestInit.timeout = remainingTimeout;
		response = await transport.fetch(currentUrl, requestInit);
		cookieJar.setFromCookieStrings(
			setCookieHeadersFromResponse(response.headers),
			response.url ?? currentUrl,
		);

		if (!isRedirectStatus(response.status) || options.redirect === "manual") break;
		if (options.redirect === "error") {
			discardStealthRedirectBody(response);
			throw new TransportError("Stealth request encountered a redirect", {
				code: "transport_network_error",
				status: 0,
			});
		}

		const nextUrl = resolveRedirectUrl(
			response.headers.get("location") ?? undefined,
			response.url ?? currentUrl,
		);
		if (!nextUrl) break;
		if (followedHops >= MAX_STEALTH_REDIRECT_HOPS) {
			discardStealthRedirectBody(response);
			throw new TransportError(
				`Stealth request exceeded the ${MAX_STEALTH_REDIRECT_HOPS}-redirect limit`,
				{ code: "transport_network_error", status: 0 },
			);
		}
		assertStealthRedirectUrl(nextUrl);
		discardStealthRedirectBody(response);
		const nextMethod = nextRedirectMethod(response.status, currentMethod);
		if (nextMethod !== currentMethod) {
			currentBody = undefined;
			currentHeaders = withoutRedirectBodyHeaders(currentHeaders);
		}
		currentMethod = nextMethod;
		currentUrl = nextUrl;
		followedHops += 1;
	}

	const normalized = await normalizeResponse(response, currentUrl, options.maxBodyBytes);
	if (followedHops > 0) normalized.redirected = true;
	return { normalized, response };
}

function createSessionFetcher(
	baseUrl: string,
	defaultProfile: string,
	clientOptions: StealthClientOptions,
): StealthSession {
	const clients = new Map<string, WreqSessionCacheEntry>();
	let closed = false;
	let hasWarnedMissingProxy = false;
	const warn = clientOptions.warn ?? console.warn;
	const cookieJar = new StealthCookieJar([], baseUrl);

	async function getClientEntry(
		profileName: string,
		proxyUrl: string | undefined,
		ignoreTlsErrors: boolean,
	): Promise<WreqSessionCacheEntry> {
		if (closed) {
			throw new TransportError("Stealth session is closed", { status: 0 });
		}
		const wreq = await getWreqModule();
		const { browser, os } = resolveWreqProfile(profileName, wreq.getProfiles());
		const cacheKey = JSON.stringify({ browser, proxyUrl, ignoreTlsErrors });
		let entry = clients.get(cacheKey);
		if (!entry) {
			entry = {
				session: wreq.createSession({
					browser,
					os,
					...(proxyUrl ? { proxy: proxyUrl } : {}),
					...(ignoreTlsErrors ? { insecure: true } : {}),
					timeout: 30_000,
				}),
				tail: Promise.resolve(),
			};
			clients.set(cacheKey, entry);
		}
		return entry;
	}

	async function withClient<T>(
		profileName: string,
		proxyUrl: string | undefined,
		ignoreTlsErrors: boolean,
		operation: (client: WreqSession) => Promise<T>,
	): Promise<T> {
		const entry = await getClientEntry(profileName, proxyUrl, ignoreTlsErrors);
		const previous = entry.tail;
		let release!: () => void;
		entry.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation(await entry.session);
		} finally {
			release();
		}
	}

	async function resolveRequestProxy(
		options?: StealthFetchOptions,
		proxyAttempt?: number,
		refreshEpoch?: number,
	): Promise<ResolvedAttemptProxy> {
		const resolvedProxy = await resolveProxyConfigAsync({
			proxy: options?.proxy ?? clientOptions.proxy,
			upstream: clientOptions.upstream,
			affinityKey: clientOptions.affinityKey,
			proxyAttempt: computeProxyAttemptIndex({
				baseProxyAttempt: clientOptions.proxyAttempt,
				proxyAttemptOffset: options?.proxyAttemptOffset,
				retryAttemptOffset: proxyAttempt,
			}),
			// The stealth transport tunnels both HTTP CONNECT and SOCKS5,
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
			const { hasExplicitRetryPolicy, method, stealthRetryOptions } = (() => {
				try {
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
					return { hasExplicitRetryPolicy, method, stealthRetryOptions };
				} catch (error) {
					throw redactSensitiveRequestError(error, url, options.sensitiveParams);
				}
			})();
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
			// and drive allocator stale-pool refresh. Deprecated custom/decodo policies
			// have no managed endpoint to rotate or refresh, so they follow the ordinary
			// transport-retry budget instead.
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
					// Reuse the exact serialization used by this outbound attempt in its catch path.
					let serializedUrl: ReturnType<typeof serializeRequestUrl> | undefined;
					let fallbackSensitiveValues: readonly string[] = [];
					let fallbackRequestUrl: string | undefined;
					let fallbackRedactedUrl: string | undefined;
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
						const sensitiveParams = normalizeSensitiveParams(options.sensitiveParams);
						const structural = redactUrlQueryParams(url, Object.keys(sensitiveParams ?? {}));
						fallbackSensitiveValues = [
							...new Set([
								...Object.values(sensitiveParams ?? {}).map(String),
								...structural.sensitiveValues,
							]),
						].filter((value) => value !== "");
						fallbackRequestUrl = url;
						fallbackRedactedUrl = structural.redactedUrl;
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
						serializedUrl = serializeRequestUrl(
							resolveUrl(baseUrl, url),
							options.params,
							sensitiveParams,
						);
						const { requestUrl } = serializedUrl;
						const { normalized, response } = await withClient(
							profileName,
							proxy,
							ignoreTlsErrors,
							(transport) =>
								fetchStealthRedirectChain(transport, cookieJar, requestUrl, method, options),
						);

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
						const sensitiveValues = serializedUrl?.sensitiveValues ?? fallbackSensitiveValues;
						let normalizedError: TransportError;
						try {
							normalizedError = normalizeStealthTransportError(error);
						} catch (normalizationError) {
							throw redactSensitiveError(
								normalizationError,
								sensitiveValues,
								serializedUrl?.requestUrl ?? fallbackRequestUrl,
								serializedUrl?.redactedUrl ?? fallbackRedactedUrl,
							);
						}
						const retryErrorCode = proxyAttemptErrorCode(normalizedError);
						const refreshableProxyError = isProxyPoolRefreshableError(normalizedError);
						const runProxyAuthDiagnostic = shouldRunProxyAuthDiagnostic(normalizedError);
						normalizedError = redactSensitiveError(
							normalizedError,
							sensitiveValues,
							serializedUrl?.requestUrl ?? fallbackRequestUrl,
							serializedUrl?.redactedUrl ?? fallbackRedactedUrl,
						);
						recordProxyAttempt(
							"error",
							proxyAttemptErrorCode(normalizedError),
							proxyAttemptStatus(normalizedError),
						);
						lastError = normalizedError;
						if (proxy && rotatesRegistryChain && refreshableProxyError) {
							stalePoolError = normalizedError;
							if (runProxyAuthDiagnostic) {
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
								error: { code: retryErrorCode },
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
				const {
					url: _url,
					maxHops: _maxHops,
					stopWhen,
					params,
					sensitiveParams,
					...fetchOptions
				} = options;
				const hops: StealthRedirectHop[] = [];
				let method = normalizeMethod(options.method ?? "GET");
				let body = options.body;
				let response: StealthResponse | undefined;
				const visitedRequests = new Set<string>();
				const initialParams = params
					? Object.fromEntries(
							Object.entries(params).map(([key, value]) => [
								key,
								Array.isArray(value) ? [...value] : value,
							]),
						)
					: undefined;
				const normalizedSensitiveParams = normalizeSensitiveParams(sensitiveParams);
				const initialSensitiveParams = normalizedSensitiveParams
					? { ...normalizedSensitiveParams }
					: undefined;
				const sensitiveParamNames = initialSensitiveParams
					? Object.keys(initialSensitiveParams)
					: [];
				const callerStructural = redactUrlQueryParams(options.url, sensitiveParamNames);
				const sensitiveValues = new Set(
					[
						...Object.values(initialSensitiveParams ?? {}),
						...callerStructural.sensitiveValues,
					].filter((value) => value !== ""),
				);
				const redactRedirectUrl = (value: string): string => {
					const structural = redactUrlQueryParams(value, [
						...new Set([...sensitiveParamNames, ...sensitiveQueryParamNames(value)]),
					]);
					for (const sensitiveValue of structural.sensitiveValues) {
						sensitiveValues.add(sensitiveValue);
					}
					return redactSensitiveText(structural.redactedUrl, [...sensitiveValues]);
				};
				let currentUrl: string;
				let initialUrl: ReturnType<typeof serializeRequestUrl>;
				try {
					currentUrl = resolveUrl(baseUrl, options.url);
					redactRedirectUrl(currentUrl);
					initialUrl = serializeRequestUrl(currentUrl, initialParams, initialSensitiveParams);
					for (const value of initialUrl.sensitiveValues) {
						if (value !== "") sensitiveValues.add(value);
					}
				} catch (error) {
					throw redactSensitiveError(
						error,
						[...sensitiveValues],
						options.url,
						redactRedirectUrl(options.url),
					);
				}

				for (let hopIndex = 0; hopIndex <= maxHops; hopIndex += 1) {
					const outboundUrl =
						hopIndex === 0 ? initialUrl.requestUrl : serializeRequestUrl(currentUrl).requestUrl;
					// Preserve params-only loop bookkeeping from before sensitiveParams:
					// the first visited key is the caller's resolved URL, not its expanded query.
					const visitedUrl = hopIndex === 0 && !initialSensitiveParams ? currentUrl : outboundUrl;
					visitedRequests.add(`${method} ${visitedUrl}`);
					try {
						response = await session.fetch(currentUrl, {
							...fetchOptions,
							body,
							method,
							...(hopIndex === 0 && initialParams ? { params: initialParams } : {}),
							...(hopIndex === 0 && initialSensitiveParams
								? { sensitiveParams: initialSensitiveParams }
								: {}),
							redirect: "manual",
							throwOnHttpError: false,
						});
					} catch (error) {
						throw redactSensitiveError(
							error,
							[...sensitiveValues],
							outboundUrl,
							redactRedirectUrl(outboundUrl),
						);
					}
					// StealthResponse.url is programmatic metadata and remains raw. Only the
					// redirect hop emitted below is a diagnostic surface.
					const responseUrl =
						response.url ?? (hopIndex === 0 && initialSensitiveParams ? outboundUrl : currentUrl);

					if (!isRedirectStatus(response.status)) {
						return {
							final: response,
							hops,
							reason: "completed",
							cookies: cookieJar.snapshot(),
							cookieStore: cookieJar.serialize(),
						};
					}

					const location = locationHeader(response.headers);
					const redactedResponseUrl = redactRedirectUrl(responseUrl);
					const redactedLocation = location ? redactRedirectUrl(location) : undefined;
					let nextUrl: string | undefined;
					try {
						nextUrl = resolveRedirectUrl(location, responseUrl);
					} catch (error) {
						throw redactSensitiveError(error, [...sensitiveValues], location, redactedLocation);
					}
					const realHop: StealthRedirectHop = {
						url: responseUrl,
						status: response.status,
						method,
						...(location ? { location } : {}),
						...(nextUrl ? { nextUrl } : {}),
					};
					const hop: StealthRedirectHop = {
						...realHop,
						url: redactedResponseUrl,
						...(redactedLocation ? { location: redactedLocation } : {}),
						...(nextUrl ? { nextUrl: redactRedirectUrl(nextUrl) } : {}),
					};
					hops.push(hop);

					let shouldStop = false;
					if (stopWhen) {
						try {
							shouldStop = await stopWhen(realHop);
						} catch (error) {
							let sanitizedError: unknown = error;
							for (const [rawUrl, safeUrl] of [
								[responseUrl, redactedResponseUrl],
								[location, redactedLocation],
								[nextUrl, nextUrl ? redactRedirectUrl(nextUrl) : undefined],
							] as const) {
								if (!rawUrl || !safeUrl) continue;
								sanitizedError = redactSensitiveError(
									sanitizedError,
									[...sensitiveValues],
									rawUrl,
									safeUrl,
								);
							}
							throw sanitizedError;
						}
					}
					const decision = evaluateRedirectHop({
						status: response.status,
						method,
						nextUrl,
						shouldStop,
						redirectCount: hops.length,
						maxHops,
						visitedRequests,
					});
					if (decision.kind === "stop") {
						return {
							final: response,
							hops,
							reason: decision.reason,
							cookies: cookieJar.snapshot(),
							cookieStore: cookieJar.serialize(),
						};
					}
					if (decision.nextMethod !== method) {
						body = undefined;
					}
					method = decision.nextMethod;
					currentUrl = decision.nextUrl;
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
					cookieStore: cookieJar.serialize(),
				};
			},
		},
		close() {
			closed = true;
			for (const client of clients.values()) {
				void client.session
					.then((session) => session.close())
					.catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						warn(`[provider-sdk] Failed to close stealth transport session: ${message}`);
					});
			}
			clients.clear();
		},
	};
	return session;

	async function classifyProxyAuthDiagnostic(
		profileName: string,
		proxy: string,
	): Promise<"source_ip_denied" | "edge_auth_rejected" | undefined> {
		try {
			return await withClient(profileName, proxy, false, async (client) => {
				await client.clearCookies();
				const response = await client.fetch(PROXY_AUTH_DIAGNOSTIC_URL, {
					method: "GET",
					timeout: PROXY_AUTH_DIAGNOSTIC_TIMEOUT_MS,
				});
				const normalized = await normalizeResponse(response);
				return classifyProxyAuthDiagnosticMessage(normalized.body);
			});
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
