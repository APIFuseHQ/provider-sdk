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
	resolveStealthProfileSelection,
} from "../stealth/profiles.js";
import type {
	ChallengeSolution,
	HttpMethod,
	ProviderChallenge,
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
		/** @internal SDK-owned response detection/solve wiring, derived from the provider declaration. */
		challengeRuntime?: {
			readonly akamaiSbsd?: {
				readonly allowedHosts: readonly string[];
				/** Resolver-declared transport profile that must match the live native session. */
				readonly clientProfile?: string;
				readonly solve?: (
					challenge: Extract<ProviderChallenge, { readonly kind: "akamai_sbsd" }>,
					transport: ResolverVendorTransport,
					initiatingClientProfile: string,
					signal: AbortSignal,
					initiatingClientProfileSelection: StealthProfileDescriptor,
				) => Promise<ChallengeSolution>;
			};
		};
	};
	/**
	 * Proxy-only stealth transport overrides. Use only for upstream proxy products
	 * that terminate CONNECT with a private CA instead of tunneling the origin
	 * certificate chain.
	 */
	proxyStealth?: { insecureSkipVerify?: boolean };
};

type AkamaiSbsdChallenge = Extract<ProviderChallenge, { readonly kind: "akamai_sbsd" }>;
type AkamaiSbsdSessionState = {
	/**
	 * Latest v-only script for this session; Phase 2 deliberately has no wall-clock TTL.
	 * Challenge-state expiry belongs to the Phase 3 ceremony/solve lease handle
	 * (ADR-0009 v1.1), not to the stealth session.
	 */
	rememberedScript?: URL;
	transaction?: {
		readonly key: string;
		readonly result: Promise<
			{ readonly solved: true } | { readonly solved: false; error: unknown }
		>;
	};
};

const SBSD_INTERSTITIAL_MAX_BYTES = 4_000;
const SBSD_SCRIPT_DISCOVERY_MAX_BYTES = 4 * 1_024 * 1_024;
const SBSD_CHALLENGE_TOKEN_MAX_BYTES = 1_024;

function htmlAttribute(value: string): string {
	return value.replace(/&amp;/giu, "&");
}

function isDeclaredHost(url: URL, allowedHosts: readonly string[]): boolean {
	const hostname = url.hostname.trim().toLowerCase().replace(/\.$/u, "");
	return allowedHosts.some(
		(host) => !host.includes("*") && host.trim().toLowerCase().replace(/\.$/u, "") === hostname,
	);
}

function findAkamaiSbsdScript(
	body: string,
	page: URL,
	allowedHosts: readonly string[],
): URL | undefined {
	if (Buffer.byteLength(body) > SBSD_SCRIPT_DISCOVERY_MAX_BYTES) return undefined;
	let passiveScript: URL | undefined;
	for (const match of body.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)) {
		let script: URL;
		try {
			script = new URL(htmlAttribute(match[1]!), page.origin);
		} catch {
			continue;
		}
		if (
			script.origin !== page.origin ||
			!isDeclaredHost(script, allowedHosts) ||
			!script.searchParams.get("v")?.trim()
		) {
			continue;
		}
		if (script.searchParams.get("t")?.trim()) return script;
		passiveScript ??= script;
	}
	return passiveScript;
}

function parseAkamaiSbsdChallengeToken(body: string): string | undefined {
	if (Buffer.byteLength(body) >= SBSD_INTERSTITIAL_MAX_BYTES) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		!("cpr_chlge" in parsed) ||
		parsed.cpr_chlge !== "true" ||
		!("t" in parsed) ||
		typeof parsed.t !== "string"
	) {
		return undefined;
	}
	const token = parsed.t.trim();
	return token && Buffer.byteLength(token) <= SBSD_CHALLENGE_TOKEN_MAX_BYTES ? token : undefined;
}

function detectAkamaiSbsdChallenge(
	response: StealthResponse,
	pageUrl: string,
	jar: StealthCookieJar,
	allowedHosts: readonly string[],
	state: AkamaiSbsdSessionState,
): AkamaiSbsdChallenge | undefined {
	let page: URL;
	try {
		page = new URL(response.url ?? pageUrl);
	} catch {
		return undefined;
	}
	if (!isDeclaredHost(page, allowedHosts)) return undefined;
	const currentScript = findAkamaiSbsdScript(response.body, page, allowedHosts);
	if (currentScript) {
		const version = currentScript.searchParams.get("v")?.trim();
		if (version) {
			const rememberedScript = new URL(currentScript.pathname, currentScript.origin);
			rememberedScript.searchParams.set("v", version);
			state.rememberedScript = rememberedScript;
		}
	}
	const stateCookieName = jar.has("sbsd_o", page.toString())
		? "sbsd_o"
		: jar.has("bm_so", page.toString())
			? "bm_so"
			: undefined;
	if (!stateCookieName) return undefined;

	const laterToken = parseAkamaiSbsdChallengeToken(response.body);
	const rememberedScript = state.rememberedScript;
	if (
		laterToken &&
		rememberedScript &&
		rememberedScript.origin === page.origin &&
		isDeclaredHost(rememberedScript, allowedHosts)
	) {
		return {
			kind: "akamai_sbsd",
			pageUrl: page.toString(),
			scriptUrl: rememberedScript.toString(),
			stateCookieName,
			challengeToken: laterToken,
		};
	}
	if (
		!currentScript ||
		Buffer.byteLength(response.body) >= SBSD_INTERSTITIAL_MAX_BYTES ||
		!/sec-bc-tile-container|Access Denied|Reference #\d|Pardon Our Interruption|cpr_chlge/iu.test(
			response.body,
		)
	) {
		return undefined;
	}
	return {
		kind: "akamai_sbsd",
		pageUrl: page.toString(),
		scriptUrl: currentScript.toString(),
		stateCookieName,
	};
}

function normalizedClientProfile(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]/gu, "");
}

function assertAkamaiSbsdClientProfile(declared: string | undefined, actual: string): void {
	if (
		declared === undefined ||
		normalizedClientProfile(declared) === normalizedClientProfile(actual)
	) {
		return;
	}
	throw new SDKError(
		`Resolver client profile "${declared}" does not match the initiating stealth session profile`,
		{
			code: "RESOLVER_CLIENT_PROFILE_MISMATCH",
			fix: "Make resolver.clientProfile match the provider stealth browser/OS profile.",
		},
	);
}

function akamaiSbsdChallengeKey(challenge: AkamaiSbsdChallenge, actualProfile: string): string {
	return JSON.stringify([
		new URL(challenge.scriptUrl).toString(),
		challenge.challengeToken ?? "",
		challenge.stateCookieName,
		normalizedClientProfile(actualProfile),
	]);
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
	body?: string;
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
		body: string | undefined,
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
	clientOptions: StealthClientOptions,
): StealthSession {
	const clients = new Map<string, WreqSessionCacheEntry>();
	let closed = false;
	let hasWarnedMissingProxy = false;
	const warn = clientOptions.warn ?? console.warn;
	const cookieJar = new StealthCookieJar([], baseUrl);
	const akamaiSbsdState: AkamaiSbsdSessionState = {};
	const automaticChallengeRefetchPolicy = {
		...createDefaultProxyTransportRetryOptions({ label: "Stealth" }),
		methods: ["GET", "HEAD"],
	};

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
		};
	}

	const session: StealthSession = {
		async fetch(url, options: StealthFetchOptions = {}) {
			const requestProfile = resolveStealthProfileSelection(options.stealth, defaultProfile);
			let challengeSolveAttempted = false;
			let challengeRefetchAttempted = false;
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
					throwIfAmbientAborted(clientOptions.signal);
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
							resolveUrl(baseUrl, url),
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
									currentBody: string | undefined,
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
							options.body === undefined ? undefined : normalizeBody(options.body),
							initialHeaders,
						);
						const fetchOnBoundSession = (
							fetchUrl: string,
							fetchMethod: StealthMethod,
							fetchOptions: StealthFetchOptions,
							fetchSignal: AbortSignal | undefined,
							orderedHeaders = buildOrderedHeaders,
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
								defaultHeaders,
							);
						let { normalized, response } = await fetchOnBoundSession(
							requestUrl,
							method,
							options,
							clientOptions.signal,
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
								recordProxyAttempt("ok", undefined, response.status);
								return normalized;
							}
							if (
								!isProxyTransportRetryMethod(method, automaticChallengeRefetchPolicy, {
									body: options.body,
									headers: options.headers,
								})
							) {
								normalized.challenge = {
									challenge: detected,
									outcome: "replay_required",
								};
								recordProxyAttempt("ok", undefined, response.status);
								return normalized;
							}
							assertAkamaiSbsdClientProfile(akamaiSbsd.clientProfile, mapping.browser);
							if (!akamaiSbsd.solve) {
								normalized.challenge = {
									challenge: detected,
									outcome: "resolver_unavailable",
								};
								recordProxyAttempt("ok", undefined, response.status);
								return normalized;
							}

							const emulationHeaderMap = new Map(
								emulationHeaders.map(([name, value]) => [name.toLowerCase(), value] as const),
							);
							const initiatingHeaders = normalizeHeaders({ ...(options.headers ?? {}) });
							const sessionHeaders = {
								"User-Agent": requiredEmulationHeader(emulationHeaderMap, "user-agent"),
								"Accept-Language":
									initiatingHeaders["accept-language"] ??
									clientOptions.stealth?.acceptLanguage ??
									requiredEmulationHeader(emulationHeaderMap, "accept-language"),
							};
							const resolverBuildHeaders = chromeEmulationHeaders
								? (
										currentUrl: string,
										currentMethod: StealthMethod,
										currentBody: string | undefined,
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
									);
									return {
										status: result.normalized.status,
										headers: result.normalized.headers,
										body: result.normalized.body,
										cookies: resolverCookiesFromResponse(result.response, transportUrl),
									};
								},
							};
							const transactionKey = akamaiSbsdChallengeKey(detected, mapping.browser);
							let transaction = akamaiSbsdState.transaction;
							let ownsTransaction = false;
							if (!transaction || transaction.key !== transactionKey) {
								challengeSolveAttempted = true;
								ownsTransaction = true;
								let createdTransaction!: NonNullable<AkamaiSbsdSessionState["transaction"]>;
								const result = akamaiSbsd
									.solve(
										detected,
										resolverTransport,
										mapping.browser,
										clientOptions.signal ?? new AbortController().signal,
										requestProfile,
									)
									.then(
										() => ({ solved: true }) as const,
										(error: unknown) => ({ solved: false, error }) as const,
									)
									.finally(() => {
										if (akamaiSbsdState.transaction === createdTransaction) {
											akamaiSbsdState.transaction = undefined;
										}
									});
								createdTransaction = {
									key: transactionKey,
									result,
								};
								transaction = createdTransaction;
								akamaiSbsdState.transaction = createdTransaction;
							}
							const transactionResult = await transaction.result;
							if (!transactionResult.solved) {
								if (ownsTransaction) throw transactionResult.error;
								normalized.challenge = {
									challenge: detected,
									outcome: "challenge_persisted",
								};
								recordProxyAttempt("ok", undefined, response.status);
								return normalized;
							}
							challengeRefetchAttempted = true;
							({ normalized, response } = await fetchOnBoundSession(
								requestUrl,
								method,
								options,
								clientOptions.signal,
							));
							const persisted = detectAkamaiSbsdChallenge(
								normalized,
								requestUrl,
								cookieJar,
								akamaiSbsd.allowedHosts,
								akamaiSbsdState,
							);
							if (persisted) {
								normalized.challenge = {
									challenge: persisted,
									outcome: "challenge_persisted",
								};
								recordProxyAttempt("ok", undefined, response.status);
								return normalized;
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
							throwIfAmbientAborted(clientOptions.signal);
							normalizedError = normalizeStealthTransportError(error);
						} catch (normalizationError) {
							const redactedNormalizationError = redactSensitiveError(
								normalizationError,
								sensitiveValues,
								serializedUrl?.requestUrl ?? fallbackRequestUrl,
								serializedUrl?.redactedUrl ?? fallbackRedactedUrl,
							);
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
							throw redactedNormalizationError;
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
								await sleep(
									computeProxyTransportRetryDelayMs(stealthRetryOptions, attempt + 1),
									clientOptions.signal,
								);
							}
							throwIfAmbientAborted(clientOptions.signal);
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
			akamaiSbsdState.rememberedScript = undefined;
			akamaiSbsdState.transaction = undefined;
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
