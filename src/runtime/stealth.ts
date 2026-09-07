import { createHash } from "node:crypto";
import { Cookie } from "tough-cookie";
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
import {
	DEFAULT_STEALTH_BROWSER,
	DEFAULT_STEALTH_OS,
	getStealthProfile,
	resolverClientProfileFamily,
	resolveStealthProfileSelection,
} from "../stealth/profiles.js";
import type {
	HttpMethod,
	StealthClient,
	StealthFetchOptions,
	StealthProfileDescriptor,
	StealthProfileSelection,
	StealthRedirectHop,
	StealthResponse,
	StealthSession,
} from "../types.js";
import { chrome149HeaderOrder } from "./chrome149-header-order.js";
import {
	ENGINE_CEREMONY_EGRESS_LEASE,
	type CeremonyEgressBinding,
	type CeremonyEgressLeaseRuntime,
} from "./egress-lease.js";
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
	isProxyTransportRetryMethod,
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
import type { ResolverVendorTransport } from "./resolver-vendors/types.js";
import {
	type AkamaiSbsdSessionState,
	akamaiSbsdChallengeKey,
	detectAkamaiSbsdChallenge,
	type StealthChallengeRuntime,
} from "./stealth-akamai-sbsd.js";
import { StealthCookieJar } from "./stealth-cookies.js";

export const DEFAULT_STEALTH_PROFILE: StealthProfileDescriptor = Object.freeze({
	browser: DEFAULT_STEALTH_BROWSER,
	os: DEFAULT_STEALTH_OS,
});

const MISSING_PROXY_WARNING =
	"[provider-sdk] Provider requested proxy routing, but no proxy URL was configured. Continuing without proxy.";

const MAX_POLICY_PROXY_POOL_REFRESHES = 1;
const PROXY_CONNECT_FAILURE_CODE = "proxy_connect_failed";
const PROXY_CONNECT_FAILURE_BODY_PATTERN =
	/\bproxy\b.*\b(non[\s-]?200|connect|tunnel)|\bconnect\b.*\bproxy\b|\btunnel\b/i;
const PROXY_AUTH_DIAGNOSTIC_URL = "http://example.com/";
const PROXY_AUTH_DIAGNOSTIC_TIMEOUT_MS = 5_000;
const STEALTH_PROXY_TRANSPORT_RETRY_ERROR_CODES = [PROXY_CONNECT_FAILURE_CODE] as const;
// Failures that mean the bound ceremony endpoint did not carry the request to the origin.
// Proxy-level refusals are covered by isProxyPoolRefreshableError; PROXY_AUTH_IP_DENIED is
// deliberately absent because another endpoint of the same vendor is denied just the same.
const BOUND_EGRESS_TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
	PROXY_CONNECT_FAILURE_CODE,
	"transport_network_error",
	"transport_timeout",
]);

function isBoundEgressTransportFailure(error: TransportError): boolean {
	return (
		isProxyPoolRefreshableError(error) ||
		(error.code !== undefined && BOUND_EGRESS_TRANSPORT_FAILURE_CODES.has(error.code))
	);
}
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
	/** Abort all requests issued by this client. */
	signal?: AbortSignal;
	/** Browser identity and declaration-wide HTTP language defaults. */
	stealth?: StealthProfileSelection & {
		/**
		 * Default Accept-Language value, emitted where Chrome's network layer appends
		 * it (after Accept-Encoding). Requests may override it through `headers`, in
		 * which case it is placed like any other caller header.
		 */
		acceptLanguage?: string;
	};
	/**
	 * Proxy-only stealth transport overrides. Use only for upstream proxy products
	 * that terminate CONNECT with a private CA instead of tunneling the origin
	 * certificate chain.
	 */
	proxyStealth?: { insecureSkipVerify?: boolean };
};

/** Server-attached challenge wiring and engine lease; kept off the public StealthClientOptions type. */
type StealthSessionClientOptions = StealthClientOptions & {
	stealth?: StealthClientOptions["stealth"] & {
		readonly challengeRuntime?: StealthChallengeRuntime;
	};
	readonly [ENGINE_CEREMONY_EGRESS_LEASE]?: CeremonyEgressLeaseRuntime;
};

type ChallengedReplayRecord = {
	consumed: boolean;
	/** Ceremony egress generation the challenged request ran on; a rebind retires the record. */
	readonly generation: number;
	replay(): Promise<StealthResponse>;
};

function assertAkamaiSbsdClientProfile(
	declared: string | undefined,
	session: StealthProfileDescriptor,
): void {
	if (declared === undefined || resolverClientProfileFamily(declared) === session.browser) return;
	throw new SDKError(
		`Resolver client profile "${declared}" does not match the initiating stealth session browser "${session.browser}"`,
		{
			code: "RESOLVER_CLIENT_PROFILE_MISMATCH",
			fix: "Make resolver.clientProfile name the provider stealth browser family (chrome, firefox, or safari).",
		},
	);
}

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

export function resolveWreqProfile(
	selection: StealthProfileSelection,
	wreqProfiles: readonly BrowserProfile[],
): {
	browser: BrowserProfile;
	os: EmulationOS;
} {
	const profile = getStealthProfile(selection);
	const identifier = profile.tlsClientIdentifier?.toLowerCase() ?? "";
	const os = profile.os;

	const browser = closestWreqProfile(identifier, wreqProfiles);
	if (!browser) {
		throw new SDKError(
			`Stealth profile ${profile.browser}/${profile.os} cannot be mapped to a wreq-js browser profile.`,
		);
	}
	return { browser, os };
}

function resolveUrl(baseUrl: string, url: string): string {
	return new URL(url, baseUrl).toString();
}

function resolveRequestUrl(baseUrl: string, url: string): string {
	try {
		return resolveUrl(baseUrl, url);
	} catch (error) {
		// Both inputs are caller-owned, so an unparsable URL is a programming error, never a
		// transport condition: not retryable, not the upstream's fault. Classify it here rather
		// than in normalizeStealthTransportError, which also sees ERR_INVALID_URL from malformed
		// upstream redirect targets. The fixed message keeps the URL (and any inline query
		// values) out of the diagnostic surface; the runtime TypeError stays in `cause`.
		throw new TransportError("Invalid request URL", {
			code: "transport_invalid_url",
			status: 0,
			category: "provider_error",
			retryable: false,
			...(error instanceof Error ? { cause: error } : {}),
		});
	}
}

function headerEntriesFromHeaders(headers: StealthTransportHeaders): [string, string][] {
	return Array.from(headers.entries());
}

type HeaderTuple = [string, string];

function normalizeHeaders(
	headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
	return Object.fromEntries(normalizedHeaderEntries(headers));
}

function trimOuterHttpWhitespace(value: string): string {
	return value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
}

function normalizedHeaderEntries(
	headers: Record<string, string | string[] | undefined>,
): HeaderTuple[] {
	const entries: HeaderTuple[] = [];
	const indices = new Map<string, number>();
	for (const [originalName, originalValue] of Object.entries(headers)) {
		if (originalValue === undefined) continue;
		const name = originalName.toLowerCase();
		const value = (Array.isArray(originalValue) ? originalValue : [originalValue])
			.map(trimOuterHttpWhitespace)
			.join(", ");
		const existingIndex = indices.get(name);
		if (existingIndex === undefined) {
			indices.set(name, entries.length);
			entries.push([name, value]);
			continue;
		}
		const existing = entries[existingIndex];
		if (existing) existing[1] = `${existing[1]}, ${value}`;
	}
	return entries;
}

const SDK_OWNED_EXACT_CHROME_HEADERS = new Set([
	"host",
	"connection",
	"user-agent",
	"sec-ch-ua",
	"sec-ch-ua-mobile",
	"sec-ch-ua-platform",
	"accept-encoding",
]);

// Non-pseudo-header order of real Chrome 149. The fixture captures
// (chrome-ground-truth-capture.json, chrome-extended-capture.json,
// h1-casing-capture.json) were taken through Playwright's `locale` option, which
// installs Accept-Language via DevTools next to User-Agent; real Chrome only
// receives it from //net (URLRequestHttpJob::AddExtraHeaders), after
// Accept-Encoding and before Cookie, as al-placement-capture.json B/C show.
const CHROME_HEADER_ORDERS = {
	navigation: [
		"sec-ch-ua",
		"sec-ch-ua-mobile",
		"sec-ch-ua-platform",
		"upgrade-insecure-requests",
		"user-agent",
		"accept",
		"sec-fetch-site",
		"sec-fetch-mode",
		"sec-fetch-user",
		"sec-fetch-dest",
		"accept-encoding",
		"accept-language",
		"cookie",
		"priority",
	],
	// xhr has no fixed table: it is emulated by chrome149HeaderOrder.
	post: [
		"content-length",
		"sec-ch-ua-platform",
		"user-agent",
		"sec-ch-ua",
		"content-type",
		"sec-ch-ua-mobile",
		"accept",
		"origin",
		"sec-fetch-site",
		"sec-fetch-mode",
		"sec-fetch-dest",
		"referer",
		"accept-encoding",
		"accept-language",
		"cookie",
		"priority",
	],
} as const;

const CHROME_H1_HEADER_ORDERS = {
	navigation: [
		"host",
		"connection",
		"sec-ch-ua",
		"sec-ch-ua-mobile",
		"sec-ch-ua-platform",
		"upgrade-insecure-requests",
		"user-agent",
		"accept",
		"sec-fetch-site",
		"sec-fetch-mode",
		"sec-fetch-user",
		"sec-fetch-dest",
		"accept-encoding",
		"accept-language",
		"cookie",
	],
	xhr: [
		"host",
		"connection",
		"sec-ch-ua-platform",
		"cache-control",
		"x-requested-with",
		"user-agent",
		"sec-ch-ua",
		"sec-ch-ua-mobile",
		"accept",
		"sec-fetch-site",
		"sec-fetch-mode",
		"sec-fetch-dest",
		"referer",
		"accept-encoding",
		"accept-language",
		"cookie",
	],
	post: [
		"host",
		"connection",
		"content-length",
		"sec-ch-ua-platform",
		"user-agent",
		"sec-ch-ua",
		"content-type",
		"sec-ch-ua-mobile",
		"accept",
		"origin",
		"sec-fetch-site",
		"sec-fetch-mode",
		"sec-fetch-dest",
		"referer",
		"accept-encoding",
		"accept-language",
		"cookie",
	],
} as const;

const CHROME_H1_HEADER_NAMES: Record<string, string> = {
	host: "Host",
	connection: "Connection",
	"upgrade-insecure-requests": "Upgrade-Insecure-Requests",
	"user-agent": "User-Agent",
	"accept-language": "Accept-Language",
	accept: "Accept",
	"sec-fetch-site": "Sec-Fetch-Site",
	"sec-fetch-mode": "Sec-Fetch-Mode",
	"sec-fetch-user": "Sec-Fetch-User",
	"sec-fetch-dest": "Sec-Fetch-Dest",
	"accept-encoding": "Accept-Encoding",
	cookie: "Cookie",
	"cache-control": "Cache-Control",
	"x-requested-with": "X-Requested-With",
	referer: "Referer",
	"content-length": "Content-Length",
	"content-type": "Content-Type",
	origin: "Origin",
	range: "Range",
};

type ChromeRequestClass = keyof typeof CHROME_HEADER_ORDERS | "xhr";

function chromeHeaderOrder(
	requestClass: ChromeRequestClass,
	isHttp1: boolean,
	caller: ReadonlyMap<string, string>,
): readonly string[] {
	if (isHttp1) return CHROME_H1_HEADER_ORDERS[requestClass];
	if (requestClass !== "xhr") return CHROME_HEADER_ORDERS[requestClass];
	// Cookie and Referer are forbidden Fetch headers, so they never enter the page
	// Fetch Headers map the emulator models. Range does occupy a map bucket
	// (m1-capture.json range_*), but HttpCache::Transaction removes it from the
	// request headers and PartialData re-adds it at the tail.
	const order = chrome149HeaderOrder(
		[...caller.keys()].filter((name) => name !== "cookie" && name !== "referer"),
	);
	if (caller.has("range")) order.splice(order.indexOf("range"), 1);
	// //net appends Accept-Encoding and, unless the caller supplied one,
	// Accept-Language (URLRequestHttpJob::AddExtraHeaders), then writes the Cookie
	// header (SetCookieHeaderAndStart); the HTTP cache re-adds a caller Range after
	// that, and the HTTP/2 Priority header stays last.
	let insertAt = order.indexOf("accept-encoding") + 1;
	if (order[insertAt] === "accept-language") insertAt += 1;
	for (const name of ["cookie", "range"] as const) {
		if (!caller.has(name)) continue;
		order.splice(insertAt, 0, name);
		insertAt += 1;
	}
	return order;
}

function normalizedCallerHeaderEntries(
	headers: Record<string, string | string[] | undefined>,
): HeaderTuple[] {
	const entries = normalizedHeaderEntries(headers);
	assertCallerHeadersSupported(entries);
	return entries;
}

function normalizedCallerHeaderEntriesFromRecord(headers: Record<string, string>): HeaderTuple[] {
	// The record has been through normalizeHeaders (lowercase, merged names); the
	// lowercase here only guards later insertions such as the cookie jar's header.
	const entries: HeaderTuple[] = Object.entries(headers).map(([name, value]) => [
		name.toLowerCase(),
		value,
	]);
	assertCallerHeadersSupported(entries);
	return entries;
}

function assertCallerHeadersSupported(entries: readonly HeaderTuple[]): void {
	for (const [name] of entries) {
		if (SDK_OWNED_EXACT_CHROME_HEADERS.has(name) || name.startsWith("sec-fetch-")) {
			throw new SDKError(`Stealth transport owns the "${name}" header; remove it from headers.`, {
				code: "STEALTH_HEADER_OVERRIDE_UNSUPPORTED",
			});
		}
	}
}

function chromeRequestClass(
	method: StealthMethod,
	requestedClass?: ChromeRequestClass,
): ChromeRequestClass {
	if (requestedClass) return requestedClass;
	if (method === "POST") return "post";
	return "navigation";
}

function secFetchSite(requestUrl: string, referer: string | undefined): string {
	if (!referer) return "none";
	try {
		return new URL(referer).origin === new URL(requestUrl).origin ? "same-origin" : "cross-site";
	} catch {
		return "cross-site";
	}
}

function requiredEmulationHeader(headers: ReadonlyMap<string, string>, name: string): string {
	const value = headers.get(name);
	if (value !== undefined) return value;
	throw new SDKError(`wreq-js Chrome emulation exposes no ${name} header.`, {
		code: "STEALTH_PROFILE_UNAVAILABLE",
	});
}

function buildChromeHeaderTuples(options: {
	emulationHeaders: Iterable<[string, string]>;
	method: StealthMethod;
	body?: string | Buffer;
	headers: Record<string, string>;
	requestUrl: string;
	acceptLanguage?: string;
	requestClass?: ChromeRequestClass;
}): HeaderTuple[] {
	const callerEntries = normalizedCallerHeaderEntriesFromRecord(options.headers);
	const caller = new Map(callerEntries);
	const emulation = new Map(
		Array.from(
			options.emulationHeaders,
			([name, value]) => [name.toLowerCase(), value] as HeaderTuple,
		),
	);
	const requestClass = chromeRequestClass(options.method, options.requestClass);
	const referer = caller.get("referer");
	const fetchSite = secFetchSite(options.requestUrl, referer);
	const isNavigation = requestClass === "navigation";
	const values = new Map<string, string>([
		["sec-ch-ua", requiredEmulationHeader(emulation, "sec-ch-ua")],
		["sec-ch-ua-mobile", requiredEmulationHeader(emulation, "sec-ch-ua-mobile")],
		["sec-ch-ua-platform", requiredEmulationHeader(emulation, "sec-ch-ua-platform")],
		["user-agent", requiredEmulationHeader(emulation, "user-agent")],
		[
			"accept-language",
			caller.get("accept-language") ??
				options.acceptLanguage ??
				requiredEmulationHeader(emulation, "accept-language"),
		],
		["accept", isNavigation ? requiredEmulationHeader(emulation, "accept") : "*/*"],
		[
			"accept-encoding",
			caller.has("range") ? "identity" : requiredEmulationHeader(emulation, "accept-encoding"),
		],
		["priority", isNavigation ? requiredEmulationHeader(emulation, "priority") : "u=1, i"],
		["sec-fetch-site", fetchSite],
		["sec-fetch-mode", isNavigation ? "navigate" : "cors"],
		["sec-fetch-dest", isNavigation ? "document" : "empty"],
	]);
	if (isNavigation) {
		values.set("upgrade-insecure-requests", "1");
		values.set("sec-fetch-user", "?1");
	}
	for (const [name, value] of callerEntries) values.set(name, value);
	for (const name of ["content-type", "origin", "referer"] as const) {
		const value = caller.get(name);
		if (value !== undefined) values.set(name, value);
	}
	if (requestClass === "post") {
		values.set(
			"content-length",
			caller.get("content-length") ?? String(Buffer.byteLength(options.body ?? "")),
		);
	}

	const isHttp1 = new URL(options.requestUrl).protocol === "http:";
	if (isHttp1) {
		values.set("host", new URL(options.requestUrl).host);
		values.set("connection", "keep-alive");
	}
	const order = chromeHeaderOrder(requestClass, isHttp1, caller);
	const tuples: HeaderTuple[] = [];
	const placed = new Set<string>();
	for (const name of order) {
		const value = values.get(name);
		if (value === undefined) continue;
		tuples.push([isHttp1 ? (CHROME_H1_HEADER_NAMES[name] ?? name) : name, value]);
		placed.add(name);
	}
	for (const [name, value] of callerEntries) {
		if (placed.has(name)) continue;
		tuples.push([isHttp1 ? (CHROME_H1_HEADER_NAMES[name] ?? name) : name, value]);
	}
	return tuples;
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
		`ctx.stealth.fetch uses transport-managed browser fingerprints and no longer accepts low-level stealth overrides: ${unsupported.join(", ")}. Use stealth.browser and stealth.os instead.`,
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

function resolverCookiesFromResponse(
	response: StealthTransportResponse,
	requestUrl: string,
): Awaited<ReturnType<ResolverVendorTransport["fetch"]>>["cookies"] {
	const responseUrl = response.url ?? requestUrl;
	return setCookieHeadersFromResponse(response.headers).flatMap((cookieString) => {
		const cookie = Cookie.parse(cookieString);
		if (!cookie?.key) return [];
		const expires =
			cookie.expires instanceof Date && Number.isFinite(cookie.expires.getTime())
				? cookie.expires.getTime() / 1_000
				: undefined;
		return [
			{
				name: cookie.key,
				value: cookie.value,
				...(expires === undefined ? {} : { expires }),
				httpOnly: cookie.httpOnly,
				secure: cookie.secure,
				...(cookie.domain ? { domain: cookie.domain } : { domain: new URL(responseUrl).hostname }),
				...(cookie.path ? { path: cookie.path } : {}),
				...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
			},
		];
	});
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
	return normalizeResponseWithSignal(response, requestUrl, maxBodyBytes);
}

async function normalizeResponseWithSignal(
	response: StealthTransportResponse,
	requestUrl?: string,
	maxBodyBytes?: number,
	signal?: AbortSignal,
): Promise<StealthResponse> {
	const headers = Object.fromEntries(response.headers.entries());
	const cookies = new StealthCookieJar(
		setCookieHeadersFromResponse(response.headers),
		response.url ?? requestUrl,
	);
	const bodyBytes =
		maxBodyBytes === undefined
			? await readResponseArrayBuffer(response, signal)
			: await readResponseBodyWithLimit(response, maxBodyBytes, signal);
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

async function readResponseArrayBuffer(
	response: StealthTransportResponse,
	signal?: AbortSignal,
): Promise<ArrayBuffer> {
	if (!signal) return response.arrayBuffer();
	throwIfAmbientAborted(signal);
	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (operation: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			operation();
		};
		const onAbort = () => {
			const error = toAmbientCancellationError(signal);
			try {
				void response.body?.cancel().catch(() => undefined);
			} catch {
				// Preserve the cancellation error if accessing or cancelling the body fails.
			}
			settle(() => reject(error));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			void response.arrayBuffer().then(
				(body) => settle(() => resolve(body)),
				(error) => settle(() => reject(error)),
			);
		} catch (error) {
			settle(() => reject(error));
		}
		if (signal.aborted) onAbort();
	});
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
	signal?: AbortSignal,
): Promise<ArrayBuffer> {
	throwIfAmbientAborted(signal);
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
			const { done, value } = await readResponseBodyChunk(reader, signal);
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

	return concatenateResponseBodyChunks(chunks, receivedBytes);
}

function concatenateResponseBodyChunks(
	chunks: readonly Uint8Array[],
	receivedBytes: number,
): ArrayBuffer {
	const bodyBytes = new Uint8Array(receivedBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bodyBytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bodyBytes.buffer;
}

function readResponseBodyChunk(
	reader: ReturnType<StealthTransportBody["getReader"]>,
	signal?: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
	if (!signal) return reader.read();
	throwIfAmbientAborted(signal);
	return new Promise((resolve, reject) => {
		let settled = false;
		const settle = (operation: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			operation();
		};
		const onAbort = () => {
			const error = toAmbientCancellationError(signal);
			void reader.cancel().catch(() => undefined);
			settle(() => reject(error));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void reader.read().then(
			(chunk) => settle(() => resolve(chunk)),
			(error) => settle(() => reject(error)),
		);
		if (signal.aborted) onAbort();
	});
}

function normalizeBody(body: unknown): string | Buffer | undefined {
	if (body === undefined) {
		return undefined;
	}

	if (typeof body === "string") {
		return body;
	}

	if (Buffer.isBuffer(body)) {
		return Buffer.from(body);
	}

	// `StealthFetchOptions.body` is `string | Buffer`; anything else is a provider fault,
	// caught before the first request so a later replay can send the same bytes.
	throw new SDKError("Stealth request bodies must be a string or Buffer", {
		code: "STEALTH_BODY_UNSUPPORTED",
		fix: "Supply a string or Buffer body; streams and typed arrays are not snapshotted.",
	});
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
	refreshEpoch?: number;
	lifetimeMinutes?: number;
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

function positiveDiagnosticNumber(
	diagnostics: Record<string, string | number | boolean> | undefined,
	name: string,
): number | undefined {
	const value = diagnostics?.[name];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
	throwIfAmbientAborted(signal);
	return new Promise((resolve, reject) => {
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
	signal?: AbortSignal,
	buildHeaders?: (
		url: string,
		method: StealthMethod,
		body: string | Buffer | undefined,
		headers: Record<string, string>,
	) => HeaderTuple[],
): Promise<{ normalized: StealthResponse; response: StealthTransportResponse }> {
	let currentUrl = requestUrl;
	let currentMethod = method;
	let currentBody = options.body === undefined ? undefined : normalizeBody(options.body);
	let currentHeaders = normalizeHeaders({ ...(options.headers ?? {}) });
	let followedHops = 0;
	let response: StealthTransportResponse;
	const deadline = options.timeout ? performance.now() + options.timeout : undefined;

	while (true) {
		throwIfAmbientAborted(signal);
		const headers = { ...currentHeaders };
		if (!hasHeader(headers, "cookie")) {
			const cookieHeader = cookieJar.toHeader(currentUrl);
			if (cookieHeader) headers.cookie = cookieHeader;
		}
		const requestInit: StealthRequestInit = {
			headers: buildHeaders
				? buildHeaders(currentUrl, currentMethod, currentBody, headers)
				: headers,
			method: currentMethod,
			redirect: "manual",
			...(new URL(currentUrl).protocol === "http:" ? { disableDefaultHeaders: true } : {}),
			...(signal ? { signal } : {}),
		};
		if (currentBody !== undefined) requestInit.body = currentBody;

		await transport.clearCookies();
		throwIfAmbientAborted(signal);
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
		if (signal?.aborted) {
			discardStealthRedirectBody(response);
			throw toAmbientCancellationError(signal);
		}
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

	const normalized = await normalizeResponseWithSignal(
		response,
		currentUrl,
		options.maxBodyBytes,
		signal,
	);
	if (followedHops > 0) normalized.redirected = true;
	return { normalized, response };
}

function createSessionFetcher(
	baseUrl: string,
	defaultProfile: StealthProfileDescriptor,
	clientOptions: StealthSessionClientOptions,
): StealthSession {
	const clients = new Map<string, WreqSessionCacheEntry>();
	let closed = false;
	let hasWarnedMissingProxy = false;
	const warn = clientOptions.warn ?? console.warn;
	const cookieJar = new StealthCookieJar([], baseUrl);
	const akamaiSbsdState: AkamaiSbsdSessionState = { transactions: new Map() };
	const challengedReplays = new WeakMap<StealthResponse, ChallengedReplayRecord>();
	const ceremonyEgressLease = clientOptions[ENGINE_CEREMONY_EGRESS_LEASE];
	let ceremonyEgressGeneration = 0;
	const automaticChallengeRefetchPolicy = {
		...createDefaultProxyTransportRetryOptions({ label: "Stealth" }),
		methods: ["GET"],
	};

	function clearAkamaiSbsdState(): void {
		akamaiSbsdState.rememberedScript = undefined;
		akamaiSbsdState.transactions.clear();
		akamaiSbsdState.completedSuccessKey = undefined;
	}

	/**
	 * Every path that leaves the bound endpoint also discards the challenge state that was
	 * only valid on it and retires outstanding replay records made on it.
	 */
	function unbindCeremonyEgress(): void {
		clearAkamaiSbsdState();
		ceremonyEgressGeneration += 1;
	}

	/**
	 * A binding past its vendor session lifetime is dropped, together with the challenge
	 * state that was only valid on that endpoint, so this request selects and binds afresh.
	 */
	function expireCeremonyEgressLease(): void {
		if (!ceremonyEgressLease?.dropExpiredBinding()) return;
		unbindCeremonyEgress();
	}

	/**
	 * The lease is best effort (ADR-0010: a raw Smartproxy endpoint is not a vendor-guaranteed
	 * lease). When the attempt that ran on the bound endpoint fails at the transport (the
	 * proxy refused it, the tunnel never opened, the socket died or timed out) the binding is
	 * released so the ceremony can leave a dead endpoint before its lifetime elapses. Origin
	 * responses, however bad, keep the binding: the endpoint is alive. Returns true when a
	 * binding was released.
	 */
	function releaseFailedCeremonyEgress(
		attemptProxyUrl: string | undefined,
		error: TransportError,
	): boolean {
		const bound = ceremonyEgressLease?.binding;
		if (
			!ceremonyEgressLease ||
			!bound ||
			!attemptProxyUrl ||
			attemptProxyUrl !== bound.proxyUrl ||
			!isBoundEgressTransportFailure(error)
		) {
			return false;
		}
		ceremonyEgressLease.dropBinding();
		unbindCeremonyEgress();
		return true;
	}

	async function getClientEntry(
		profile: StealthProfileDescriptor,
		proxyUrl: string | undefined,
		ignoreTlsErrors: boolean,
		defaultHeaders?: HeaderTuple[],
	): Promise<WreqSessionCacheEntry> {
		if (closed) {
			throw new TransportError("Stealth session is closed", { status: 0 });
		}
		const wreq = await getWreqModule();
		const { browser, os } = resolveWreqProfile(profile, wreq.getProfiles());
		const cacheKey = JSON.stringify({
			browser,
			os,
			proxyUrl,
			ignoreTlsErrors,
			headerOrder: defaultHeaders?.map(([name]) => name),
		});
		let entry = clients.get(cacheKey);
		if (!entry) {
			entry = {
				session: wreq.createSession({
					browser,
					os,
					...(defaultHeaders ? { defaultHeaders } : {}),
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
		profile: StealthProfileDescriptor,
		proxyUrl: string | undefined,
		ignoreTlsErrors: boolean,
		operation: (client: WreqSession) => Promise<T>,
		signal?: AbortSignal,
		defaultHeaders?: HeaderTuple[],
	): Promise<T> {
		throwIfAmbientAborted(signal);
		const entry = await getClientEntry(profile, proxyUrl, ignoreTlsErrors, defaultHeaders);
		throwIfAmbientAborted(signal);
		const previous = entry.tail;
		let release!: () => void;
		entry.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		let acquired = false;
		try {
			await waitForClientTurn(previous, signal);
			acquired = true;
			throwIfAmbientAborted(signal);
			const client = await entry.session;
			throwIfAmbientAborted(signal);
			const result = await operation(client);
			throwIfAmbientAborted(signal);
			return result;
		} finally {
			if (acquired) {
				release();
			} else {
				void previous.then(release, release);
			}
		}
	}

	async function waitForClientTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
		if (!signal) {
			await previous;
			return;
		}
		throwIfAmbientAborted(signal);
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const settle = (operation: () => void) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				operation();
			};
			const onAbort = () => settle(() => reject(toAmbientCancellationError(signal)));
			signal.addEventListener("abort", onAbort, { once: true });
			void previous.then(
				() => settle(resolve),
				(error) => settle(() => reject(error)),
			);
			if (signal.aborted) onAbort();
		});
	}

	async function resolveRequestProxy(
		options?: StealthFetchOptions,
		proxyAttempt?: number,
		refreshEpoch?: number,
	): Promise<ResolvedAttemptProxy> {
		const bound = ceremonyEgressLease?.binding;
		if (bound) {
			if (options?.proxy !== undefined || options?.proxyAttemptOffset !== undefined) {
				throw new SDKError(
					"A ceremony-bound egress cannot be overridden by provider request options",
					{
						code: "EGRESS_LEASE_BINDING_INVALID",
						fix: "Remove `proxy` and `proxyAttemptOffset` from stealth requests made inside an auth ceremony.",
					},
				);
			}
			return {
				url: bound.proxyUrl,
				poolIndex: bound.poolIndex,
				proxyHash: proxyEndpointHash(bound.proxyUrl),
				vendor: bound.vendor,
				refreshEpoch: bound.refreshEpoch,
				lifetimeMinutes: bound.lifetimeMinutes,
			};
		}
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
			engineCredentials: clientOptions.engineCredentials,
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
			refreshEpoch: refreshEpoch ?? 0,
			...(positiveDiagnosticNumber(resolvedProxy.diagnostics, "lifetimeMinutes") === undefined
				? {}
				: {
						lifetimeMinutes: positiveDiagnosticNumber(resolvedProxy.diagnostics, "lifetimeMinutes"),
					}),
		};
	}

	function bindCeremonyEgress(attemptProxy: ResolvedAttemptProxy | undefined): void {
		const lease = ceremonyEgressLease;
		if (!lease || !attemptProxy?.url || !attemptProxy.vendor) return;
		if (lease.binding) {
			// A concurrent request on this session may have bound the ceremony while this one
			// was in flight on an endpoint it selected before the binding existed (pool
			// rotation after a transport failure). Its response reached the origin from an
			// egress the handle does not name; accepting it would split the ceremony identity.
			if (attemptProxy.url !== lease.binding.proxyUrl) {
				throw new SDKError("The response arrived on an egress other than the ceremony's bound endpoint", {
					code: "EGRESS_LEASE_BINDING_INVALID",
				});
			}
			return;
		}
		if (
			attemptProxy.poolIndex === undefined ||
			attemptProxy.lifetimeMinutes === undefined ||
			!clientOptions.affinityKey
		) {
			// Registry vendors always report pool index and session lifetime; missing either
			// is an SDK fault, not something the caller can correct.
			throw new SDKError("The selected egress cannot be represented by a ceremony lease", {
				code: "EGRESS_LEASE_BINDING_INVALID",
			});
		}
		const binding: CeremonyEgressBinding = {
			vendor: attemptProxy.vendor,
			proxyUrl: attemptProxy.url,
			poolIndex: attemptProxy.poolIndex,
			affinityKey: clientOptions.affinityKey,
			refreshEpoch: attemptProxy.refreshEpoch ?? 0,
			lifetimeMinutes: attemptProxy.lifetimeMinutes,
		};
		lease.bind(binding);
	}

	const session: StealthSession = {
		async fetch(url, callerOptions: StealthFetchOptions = {}) {
			expireCeremonyEgressLease();
			const requestBody = normalizeBody(callerOptions.body);
			// Snapshot the caller's headers with the body before the first send: the first
			// request and an explicit replay both use this copy, so a caller mutating its own
			// objects afterwards cannot make the two sends differ.
			const options: StealthFetchOptions = {
				...callerOptions,
				...(callerOptions.headers
					? {
							headers: Object.fromEntries(
								Object.entries(callerOptions.headers).map(([name, value]) => [
									name,
									Array.isArray(value) ? [...value] : value,
								]),
							),
						}
					: {}),
				...(requestBody === undefined ? {} : { body: requestBody }),
			};
			const requestProfile = resolveStealthProfileSelection(options.stealth, defaultProfile);
			let challengeSolveAttempted = false;
			let challengeRefetchAttempted = false;
			let challengeSolveFailure: { readonly error: unknown } | undefined;
			const { hasExplicitRetryPolicy, method, stealthRetryOptions } = (() => {
				try {
					const method = normalizeMethod(options.method ?? "GET");
					normalizedCallerHeaderEntries(options.headers ?? {});
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
			throwIfAmbientAborted(clientOptions.signal);
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
			const unboundMaxAttempts = rotatesRegistryChain ? policyProxyAttemptCap : retryAttemptCap;
			// A bound ceremony has exactly one endpoint to try; releasing the binding after a
			// transport failure widens the budget back to the ordinary rotation span.
			let maxAttempts = ceremonyEgressLease?.binding ? 1 : unboundMaxAttempts;
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
					throwIfAmbientAborted(clientOptions.signal);
					let proxy: string | undefined;
					let attemptProxy: ResolvedAttemptProxy | undefined;
					// Reuse the exact serialization used by this outbound attempt in its catch path.
					let serializedUrl: ReturnType<typeof serializeRequestUrl> | undefined;
					let fallbackSensitiveValues: readonly string[] = [];
					let fallbackRequestUrl: string | undefined;
					let fallbackRedactedUrl: string | undefined;
					let attemptStartedAt = Date.now();
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
					// Shared tail of the first fetch, the automatic refetch, and an explicit replay: a
					// classified challenge is returned whatever `throwOnHttpError` says (documented on
					// StealthFetchOptions), any other non-2xx honours it, and the proxy attempt is
					// recorded once per delivered response.
					const finalizeAttempt = (
						attemptResponse: StealthTransportResponse,
						attemptNormalized: StealthResponse,
					): StealthResponse => {
						if (
							!attemptNormalized.challenge &&
							attemptResponse.status >= 400 &&
							options.throwOnHttpError !== false
						) {
							throw new TransportError(
								`Upstream request failed with status ${attemptResponse.status}`,
								{ code: "upstream_http_error", status: attemptResponse.status },
							);
						}
						recordProxyAttempt("ok", undefined, attemptResponse.status);
						return attemptNormalized;
					};
					const redactAttemptError = <T>(error: T): T =>
						redactSensitiveError(
							error,
							serializedUrl?.sensitiveValues ?? fallbackSensitiveValues,
							serializedUrl?.requestUrl ?? fallbackRequestUrl,
							serializedUrl?.redactedUrl ?? fallbackRedactedUrl,
						);
					// Cancellation and resolver failures leave the transport path here, redacted; any
					// other failure becomes the TransportError the retry decision reasons about.
					const normalizeAttemptError = (error: unknown): TransportError => {
						let normalizedError: TransportError;
						try {
							throwIfAmbientAborted(clientOptions.signal);
							normalizedError = normalizeStealthTransportError(error);
						} catch (normalizationError) {
							if (
								normalizationError instanceof TransportError &&
								normalizationError.code === "transport_cancelled"
							) {
								recordProxyAttempt(
									"error",
									proxyAttemptErrorCode(normalizationError),
									proxyAttemptStatus(normalizationError),
								);
							}
							throw redactAttemptError(normalizationError);
						}
						if (challengeSolveFailure && error === challengeSolveFailure) {
							throw redactAttemptError(challengeSolveFailure.error);
						}
						return normalizedError;
					};
					const recordAttemptFailure = (normalizedError: TransportError): TransportError => {
						const redactedError = redactAttemptError(normalizedError);
						recordProxyAttempt(
							"error",
							proxyAttemptErrorCode(redactedError),
							proxyAttemptStatus(redactedError),
						);
						return redactedError;
					};
					try {
						throwIfAmbientAborted(clientOptions.signal);
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
						throwIfAmbientAborted(clientOptions.signal);
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
						serializedUrl = serializeRequestUrl(
							resolveRequestUrl(baseUrl, url),
							options.params,
							sensitiveParams,
						);
						const { requestUrl } = serializedUrl;
						const wreq = await getWreqModule();
						const mapping = resolveWreqProfile(requestProfile, wreq.getProfiles());
						const emulationHeaders = Array.from(
							wreq.getEmulationHeaders(mapping.browser, mapping.os),
							([name, value]) => [String(name), String(value)] as HeaderTuple,
						);
						const chromeEmulationHeaders = mapping.browser.startsWith("chrome_")
							? emulationHeaders
							: undefined;
						const buildOrderedHeaders = chromeEmulationHeaders
							? (
									currentUrl: string,
									currentMethod: StealthMethod,
									currentBody: string | Buffer | undefined,
									currentHeaders: Record<string, string>,
								) =>
									buildChromeHeaderTuples({
										emulationHeaders: chromeEmulationHeaders,
										method: currentMethod,
										body: currentBody,
										headers: currentHeaders,
										requestUrl: currentUrl,
										acceptLanguage: clientOptions.stealth?.acceptLanguage,
										requestClass: options.stealth?.requestClass,
									})
							: undefined;
						const initialHeaders = normalizeHeaders({ ...(options.headers ?? {}) });
						if (!hasHeader(initialHeaders, "cookie")) {
							const cookieHeader = cookieJar.toHeader(requestUrl);
							if (cookieHeader) initialHeaders.cookie = cookieHeader;
						}
						const defaultHeaders = buildOrderedHeaders?.(
							requestUrl,
							method,
							requestBody,
							initialHeaders,
						);
						const fetchOnBoundSession = (
							fetchUrl: string,
							fetchMethod: StealthMethod,
							fetchOptions: StealthFetchOptions,
							fetchSignal: AbortSignal | undefined,
							orderedHeaders = buildOrderedHeaders,
							sessionDefaultHeaders = defaultHeaders,
						) =>
							withClient(
								requestProfile,
								proxy,
								ignoreTlsErrors,
								(transport) =>
									fetchStealthRedirectChain(
										transport,
										cookieJar,
										fetchUrl,
										fetchMethod,
										fetchOptions,
										fetchSignal,
										orderedHeaders,
									),
								fetchSignal,
								sessionDefaultHeaders,
							);
						const throwProxyTransportFault = (
							faultResponse: StealthTransportResponse,
							faultBody: string,
						) => {
							if (!proxy) return;
							if (isProxyConnectFailureResponse(faultResponse, faultBody)) {
								throw createProxyConnectFailureError(faultBody);
							}
							if (faultResponse.status < 400) return;
							if (
								usesPolicyAllocator &&
								isProxyEdgeTlsRejectedResponse(
									faultResponse.status,
									[JSON.stringify(responseHeadersToRecord(faultResponse.headers)), faultBody].join(
										"\n",
									),
								)
							) {
								throw createProxyEdgeTlsRejectedError(faultResponse.status);
							}
							if (isProxyAuthIpDeniedMessage(faultBody)) {
								throw createProxyAuthIpDeniedError();
							}
							if (isProxyEdgeAuthRejectedMessage(faultBody)) {
								throw createProxyEdgeAuthRejectedError();
							}
							if (
								isProxyPoolStaleStatus(faultResponse.status) &&
								isProxyPoolStaleMessage(faultBody)
							) {
								throw createProxyPoolStaleError(faultResponse.status);
							}
						};
						let { normalized, response } = await fetchOnBoundSession(
							requestUrl,
							method,
							options,
							clientOptions.signal,
						);
						throwProxyTransportFault(response, normalized.body);

						// Commit only after the selected endpoint reached the origin. A failed
						// proxy attempt may rotate pool index; the successful exact endpoint is
						// the one sealed into the ceremony handle.
						bindCeremonyEgress(attemptProxy);

						const akamaiSbsd = clientOptions.stealth?.challengeRuntime?.akamaiSbsd;
						const detected = akamaiSbsd
							? detectAkamaiSbsdChallenge(
									normalized,
									requestUrl,
									cookieJar,
									akamaiSbsd.allowedHosts,
									akamaiSbsdState,
								)
							: undefined;
						if (detected && akamaiSbsd) {
							if (challengeSolveAttempted || challengeRefetchAttempted) {
								normalized.challenge = {
									challenge: detected,
									outcome: "challenge_persisted",
								};
								return finalizeAttempt(response, normalized);
							}
							const automaticReplayEligible = isProxyTransportRetryMethod(
								method,
								automaticChallengeRefetchPolicy,
								{ body: requestBody, headers: options.headers },
							);
							if (automaticReplayEligible && !akamaiSbsd.solve) {
								normalized.challenge = {
									challenge: detected,
									outcome: "resolver_unavailable",
								};
								return finalizeAttempt(response, normalized);
							}

							const emulationHeaderMap = new Map(
								emulationHeaders.map(([name, value]) => [name.toLowerCase(), value] as const),
							);
							const initiatingHeaders = normalizeHeaders({ ...(options.headers ?? {}) });
							// Mirror what the protected request actually sent: `stealth.acceptLanguage` is
							// applied by the Chrome header builder only; Safari/Firefox sessions send the
							// emulation default.
							const sessionHeaders = {
								"User-Agent": requiredEmulationHeader(emulationHeaderMap, "user-agent"),
								"Accept-Language":
									initiatingHeaders["accept-language"] ??
									(chromeEmulationHeaders ? clientOptions.stealth?.acceptLanguage : undefined) ??
									requiredEmulationHeader(emulationHeaderMap, "accept-language"),
							};
							const resolverBuildHeaders = chromeEmulationHeaders
								? (
										currentUrl: string,
										currentMethod: StealthMethod,
										currentBody: string | Buffer | undefined,
										currentHeaders: Record<string, string>,
									) =>
										buildChromeHeaderTuples({
											emulationHeaders: chromeEmulationHeaders,
											method: currentMethod,
											body: currentBody,
											headers: currentHeaders,
											requestUrl: currentUrl,
											acceptLanguage: clientOptions.stealth?.acceptLanguage,
										})
								: undefined;
							const resolverTransport: ResolverVendorTransport = {
								sessionHeaders,
								getCookie(name, cookieUrl) {
									return cookieJar.get(name, cookieUrl);
								},
								async fetch(transportUrl, init) {
									const boundSignal = clientOptions.signal
										? AbortSignal.any([clientOptions.signal, init.signal])
										: init.signal;
									const transportHeaders = { ...(init.headers ?? {}) };
									if (resolverBuildHeaders) {
										for (const name of Object.keys(transportHeaders)) {
											if (name.toLowerCase() === "user-agent") {
												delete transportHeaders[name];
											}
										}
									}
									// Session defaults come from this request's own shape, never from the
									// initiating request: its defaults carry the upstream Cookie header,
									// which wreq would otherwise merge into the Hyper /ip call.
									const result = await fetchOnBoundSession(
										transportUrl,
										init.method,
										{
											method: init.method,
											headers: transportHeaders,
											...(init.body === undefined ? {} : { body: init.body }),
											redirect: "manual",
											throwOnHttpError: false,
											...(init.maxBodyBytes === undefined
												? {}
												: { maxBodyBytes: init.maxBodyBytes }),
										},
										boundSignal,
										resolverBuildHeaders,
										resolverBuildHeaders?.(
											transportUrl,
											init.method,
											init.body,
											normalizeHeaders(transportHeaders),
										),
									);
									return {
										status: result.normalized.status,
										headers: result.normalized.headers,
										body: result.normalized.body,
										cookies: resolverCookiesFromResponse(result.response, transportUrl),
									};
								},
							};
							// `options` is already the fetch-start snapshot; the replay gets its own copy
							// of the body bytes so the transport cannot alias the first send's buffer.
							const replayOptions: StealthFetchOptions = {
								...options,
								...(Buffer.isBuffer(requestBody) ? { body: Buffer.from(requestBody) } : {}),
							};
							const transactionKey = akamaiSbsdChallengeKey(detected, {
								wreqBrowser: mapping.browser,
								wreqOs: mapping.os,
								proxyUrl: proxy,
							});
							const challenged = { normalized, response };
							const solveAndReplay = async (
								explicitReplay: boolean,
							): Promise<{ normalized: StealthResponse; response: StealthTransportResponse }> => {
								if (!akamaiSbsd.solve) {
									throw new SDKError("No resolver is available for the challenged request", {
										code: "RESOLVER_UNAVAILABLE",
									});
								}
								// Only a solve that will actually run on this session needs the profile match.
								assertAkamaiSbsdClientProfile(akamaiSbsd.clientProfile, requestProfile);
								// A safe request that already solved this exact challenge on this identity
								// left the session cookies valid: the explicit replay reuses them once
								// instead of paying for a second solve.
								const reuseCompletedSuccess =
									explicitReplay && akamaiSbsdState.completedSuccessKey === transactionKey;
								if (reuseCompletedSuccess) akamaiSbsdState.completedSuccessKey = undefined;
							let ownsTransaction = false;
								if (!reuseCompletedSuccess) {
									let transaction = akamaiSbsdState.transactions.get(transactionKey);
							if (!transaction) {
										akamaiSbsdState.completedSuccessKey = undefined;
								challengeSolveAttempted = true;
								ownsTransaction = true;
								// The solve spans several round trips, so it runs under the client's ambient
								// signal and the resolver's own timeouts, not this fetch's per-request `timeout`.
								transaction = {
									result: akamaiSbsd
										.solve(
											detected,
											resolverTransport,
											clientOptions.signal ?? new AbortController().signal,
										)
										.then(
											() => ({ solved: true }) as const,
											(error: unknown) => ({ solved: false, error }) as const,
										)
										.finally(() => {
											akamaiSbsdState.transactions.delete(transactionKey);
										}),
								};
								akamaiSbsdState.transactions.set(transactionKey, transaction);
							}
							const transactionResult = await transaction.result;
							if (!transactionResult.solved) {
								if (ownsTransaction) {
									// The proxy delivered the challenged response; the resolver failed.
									// Surface that failure as-is: it is not a transport fault to normalize
									// or retry.
											if (!explicitReplay) {
												recordProxyAttempt("ok", undefined, challenged.response.status);
											}
									challengeSolveFailure = { error: transactionResult.error };
									throw challengeSolveFailure;
								}
										return {
											normalized: {
												...challenged.normalized,
												challenge: { challenge: detected, outcome: "solve_failed" },
											},
											response: challenged.response,
								};
									}
							}
							challengeRefetchAttempted = true;
								// An explicit replay is a new transport exchange on the bound endpoint and
								// gets its own proxy-attempt record timed from here, not from the initiating
								// fetch (the caller's think time in between is not transport duration); the
								// automatic refetch stays within the initiating attempt's record.
								if (explicitReplay) {
									attemptRecorded = false;
									attemptStartedAt = Date.now();
								}
								const replayed = await fetchOnBoundSession(
								requestUrl,
								method,
									replayOptions,
								clientOptions.signal,
								);
								throwProxyTransportFault(replayed.response, replayed.normalized.body);
							const persisted = detectAkamaiSbsdChallenge(
									replayed.normalized,
								requestUrl,
								cookieJar,
								akamaiSbsd.allowedHosts,
								akamaiSbsdState,
							);
							if (persisted) {
									replayed.normalized.challenge = {
									challenge: persisted,
									outcome: "challenge_persisted",
								};
								} else if (ownsTransaction && !explicitReplay) {
									akamaiSbsdState.completedSuccessKey = transactionKey;
						}
								return replayed;
							};

							if (!automaticReplayEligible) {
								normalized.challenge = {
									challenge: detected,
									outcome: "replay_required",
								};
								challengedReplays.set(normalized, {
									consumed: false,
									generation: ceremonyEgressGeneration,
									async replay() {
						try {
											const replayed = await solveAndReplay(true);
											return finalizeAttempt(replayed.response, replayed.normalized);
										} catch (error) {
											const normalizedError = normalizeAttemptError(error);
											releaseFailedCeremonyEgress(proxy, normalizedError);
											throw recordAttemptFailure(normalizedError);
							}
									},
								});
								return finalizeAttempt(response, normalized);
						}
							({ normalized, response } = await solveAndReplay(false));
						}

						return finalizeAttempt(response, normalized);
					} catch (error) {
						const normalizedError = normalizeAttemptError(error);
						const retryErrorCode = proxyAttemptErrorCode(normalizedError);
						const refreshableProxyError = isProxyPoolRefreshableError(normalizedError);
						const runProxyAuthDiagnostic = shouldRunProxyAuthDiagnostic(normalizedError);
						const redactedError = recordAttemptFailure(normalizedError);
						lastError = redactedError;
						const releasedBoundEgress = releaseFailedCeremonyEgress(proxy, normalizedError);
						if (releasedBoundEgress) {
							// The request now proceeds as an unbound one with the full rotation budget;
							// the attempt spent on the dead endpoint does not count against it.
							maxAttempts = attempt + 1 + unboundMaxAttempts;
						}
						if (challengeSolveAttempted || challengeRefetchAttempted) {
							// The single refetch is spent (owner or waiter of a shared solve): another
							// transport attempt would replay the original request and may rotate the
							// proxy the solved jar is bound to.
							throw redactedError;
						}
						if (
							releasedBoundEgress &&
							attempt + 1 < maxAttempts &&
							(refreshableProxyError || retryErrorCode === PROXY_CONNECT_FAILURE_CODE)
						) {
							// The proxy refused the request or the tunnel never opened, so the origin never
							// saw it: selecting and binding a fresh endpoint in this request is safe for
							// any method. Ambiguous failures (reset, timeout) fall through to the ordinary
							// method-aware retry decision below with the binding already released.
							continue;
						}
						if (proxy && rotatesRegistryChain && refreshableProxyError) {
							stalePoolError = redactedError;
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
								await sleep(
									computeProxyTransportRetryDelayMs(stealthRetryOptions, attempt + 1),
									clientOptions.signal,
								);
							}
							throwIfAmbientAborted(clientOptions.signal);
							continue;
						}
						throw redactedError;
					}
				}

				if (
					rotatesRegistryChain &&
					stalePoolError &&
					refreshAttempt < MAX_POLICY_PROXY_POOL_REFRESHES
				) {
					throwIfAmbientAborted(clientOptions.signal);
					await invalidateProxyResolutionCacheAsync({
						proxyPolicy: clientOptions.proxyPolicy,
						upstream: clientOptions.upstream,
						affinityKey: clientOptions.affinityKey,
					});
					throwIfAmbientAborted(clientOptions.signal);
					continue;
				}

				const proxyAuthDiagnostic =
					stalePoolError && stalePoolDiagnosticProxy
						? await classifyProxyAuthDiagnostic(requestProfile, stalePoolDiagnosticProxy)
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

			throwIfAmbientAborted(clientOptions.signal);
			throw normalizeStealthTransportError(lastError);
		},
		async replayChallenged(challengedResponse) {
			// Lease expiry is evaluated when a fetch starts, not here: the replay belongs to the
			// exchange that was challenged on the bound endpoint (Akamai state is IP-bound), so a
			// lifetime boundary crossed during the solve does not move it elsewhere. The next
			// fetch drops the expired binding and rebinds.
			const replay = challengedReplays.get(challengedResponse);
			if (!replay || challengedResponse.challenge?.outcome !== "replay_required") {
				throw new SDKError("The challenged response does not belong to this stealth session", {
					code: "REPLAY_SESSION_MISMATCH",
				});
			}
			if (replay.generation !== ceremonyEgressGeneration) {
				// The ceremony rebound to another egress after this request ran; solving and
				// replaying on the retired endpoint would split the identity the handle names.
				throw new SDKError(
					"The challenged response predates the ceremony's current egress binding",
					{ code: "REPLAY_SESSION_MISMATCH" },
				);
			}
			if (replay.consumed) {
				throw new SDKError("The challenged request has already used its one replay budget", {
					code: "REPLAY_ALREADY_ATTEMPTED",
				});
			}
			replay.consumed = true;
			return replay.replay();
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
			clearAkamaiSbsdState();
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
		profile: StealthProfileDescriptor,
		proxy: string,
	): Promise<"source_ip_denied" | "edge_auth_rejected" | undefined> {
		try {
			return await withClient(
				profile,
				proxy,
				false,
				async (client) => {
					throwIfAmbientAborted(clientOptions.signal);
					await client.clearCookies();
					throwIfAmbientAborted(clientOptions.signal);
					const response = await client.fetch(PROXY_AUTH_DIAGNOSTIC_URL, {
						method: "GET",
						timeout: PROXY_AUTH_DIAGNOSTIC_TIMEOUT_MS,
						...(clientOptions.signal ? { signal: clientOptions.signal } : {}),
					});
					const normalized = await normalizeResponseWithSignal(
						response,
						undefined,
						undefined,
						clientOptions.signal,
					);
					return classifyProxyAuthDiagnosticMessage(normalized.body);
				},
				clientOptions.signal,
			);
		} catch (error) {
			throwIfAmbientAborted(clientOptions.signal);
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
	clientOptions: StealthClientOptions = {},
): StealthClient {
	if (typeof clientOptions === "string") {
		resolveStealthProfileSelection(clientOptions as unknown as StealthProfileSelection);
	}
	const defaultProfile = resolveStealthProfileSelection(clientOptions.stealth);
	let sharedSession: StealthSession | null = null;

	function getSharedSession(): StealthSession {
		if (!sharedSession) {
			sharedSession = createSessionFetcher(baseUrl, defaultProfile, clientOptions);
		}

		return sharedSession;
	}

	return {
		fetch(url: string, options?: StealthFetchOptions) {
			return getSharedSession().fetch(url, options);
		},
		createSession(opts?: { stealth?: StealthProfileSelection }) {
			const sessionProfile = resolveStealthProfileSelection(opts?.stealth, defaultProfile);
			return createSessionFetcher(baseUrl, sessionProfile, clientOptions);
		},
		close() {
			sharedSession?.close();
			sharedSession = null;
		},
	};
}
