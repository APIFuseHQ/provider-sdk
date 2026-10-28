import { readDiagnosticEnv } from "./diagnostic-env.js";
import { createHash } from "node:crypto";

import type { NodemavenConnectionType, ProviderProxyPolicy } from "../types.js";
import {
	deriveProxySessionId,
	isStickyProxyPolicy,
	type ProxySessionDirective,
	type ProxySessionWindow,
	proxySessionWindow,
} from "./proxy-session-id.js";

export const NODEMAVEN_USERNAME_ENV = "APIFUSE__PROXY__NODEMAVEN_USERNAME";
export const NODEMAVEN_PASSWORD_ENV = "APIFUSE__PROXY__NODEMAVEN_PASSWORD";
export const NODEMAVEN_FILTER_ENV = "APIFUSE__PROXY__NODEMAVEN_FILTER";

export const NODEMAVEN_GATEWAY_HOST = "gate.nodemaven.com";

export type NodemavenCredentials = {
	readonly username: string;
	readonly password: string;
	readonly filter?: string;
};

/** Both schemes tunnel bytes end-to-end, preserving the client TLS handshake. */
export type ProxyProtocol = "http" | "socks5";

/**
 * Host and port a gateway vendor's proxy URL points at. Every vendor has one
 * fixed gateway; an endpoint is only ever supplied through
 * `ProxyResolutionOptions.gatewayOverrides`, by assembly tests and the
 * verification harness that point a vendor at a loopback fake gateway. The
 * username grammar, the session id and the credentials are unchanged by it.
 */
export type ProxyGatewayEndpoint = {
	/** Hostname or IPv4 address. */
	readonly host: string;
	readonly port: number;
};

const GATEWAY_HOST_PATTERN = /^[A-Za-z0-9.-]+$/;

/** `host:port` of a gateway endpoint override, validated so it cannot rewrite the URL around it. */
export function formatProxyGatewayEndpoint(endpoint: ProxyGatewayEndpoint): string {
	const host = typeof endpoint.host === "string" ? endpoint.host.trim() : "";
	if (!host || !GATEWAY_HOST_PATTERN.test(host)) {
		throw new Error("Proxy gateway override host must be a hostname or IPv4 address");
	}
	if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535) {
		throw new Error("Proxy gateway override port must be an integer between 1 and 65535");
	}
	return `${host}:${endpoint.port}`;
}

/**
 * NodeMaven's fastest protocol: HTTP CONNECT. Benchmarks (KR, cold + warm)
 * showed socks5 through the gateway adds ~500ms per request over http, so
 * NodeMaven never defaults to socks5.
 */
export const NODEMAVEN_DEFAULT_PROTOCOL: ProxyProtocol = "http";

/** NodeMaven gateway port ranges per protocol (docs: HTTP 8080-9080, SOCKS5 1080-2080). */
const NODEMAVEN_PORTS: Record<ProxyProtocol, { min: number; max: number }> = {
	http: { min: 8080, max: 9080 },
	socks5: { min: 1080, max: 2080 },
};

const NODEMAVEN_FILTERS = new Set(["medium", "high"]);
const DEFAULT_NODEMAVEN_FILTER = "medium";
/** NodeMaven sticky sessions persist up to 24h server-side, keyed by the sid. */
const NODEMAVEN_MAX_LIFETIME_MINUTES = 1440;

/**
 * `-isp-` carrier slug grammar: lowercase letters, digits and `_` (NodeMaven
 * writes multi-word carriers with underscores, e.g. `sk_telecom`, `lg_uplus`).
 * Verified 2026-10-23: `sk_telecom`, `lg_uplus`, `kt` are accepted for KR
 * mobile; an unknown slug (`skt`) is refused by the gateway with HTTP 406.
 */
export const NODEMAVEN_ISP_SLUG_PATTERN = /^[a-z0-9_]+$/;
/** `-ttl-` accepts 60..86400 seconds (docs: "from 60 up to 86,400"). */
export const NODEMAVEN_TTL_SECONDS_MIN = 60;
export const NODEMAVEN_TTL_SECONDS_MAX = 86_400;

/**
 * Encode a sticky TTL the way the NodeMaven dashboard does: whole minutes then
 * the remaining seconds, `XmYs` (500 → `8m20s`). Callers validate the range.
 */
export function formatNodemavenTtl(seconds: number): string {
	const whole = Math.floor(seconds);
	return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

export function hasNodemavenCredentials(): boolean {
	return Boolean(readNodemavenUsername() && readNodemavenPassword());
}

function readNodemavenUsername(): string | undefined {
	return readDiagnosticEnv(NODEMAVEN_USERNAME_ENV)?.trim() || undefined;
}

function readNodemavenPassword(): string | undefined {
	return readDiagnosticEnv(NODEMAVEN_PASSWORD_ENV)?.trim() || undefined;
}

/**
 * The `-filter-` tier. Residential usernames always carry one (`medium` unless
 * `APIFUSE__PROXY__NODEMAVEN_FILTER` says otherwise). Mobile usernames carry
 * one only when that variable is set: the measured passing mobile shape had
 * no filter token, and mobile with a filter tier is unverified.
 */
function resolveNodemavenFilter(
	value: string | undefined,
	connectionType: NodemavenConnectionType,
): string | undefined {
	const raw = value?.trim().toLowerCase();
	if (!raw) return connectionType === "mobile" ? undefined : DEFAULT_NODEMAVEN_FILTER;
	if (!NODEMAVEN_FILTERS.has(raw)) {
		throw new Error(`${NODEMAVEN_FILTER_ENV} must be "medium" or "high"`);
	}
	return raw;
}

/**
 * One carrier per attempt: `isp[attempt % isp.length]`. The first attempt
 * takes the first slug and a caller-managed retry with
 * `proxyAttemptOffset: 1` takes the next, so a blocked carrier is not retried
 * back to back.
 */
function selectNodemavenIsp(
	isp: readonly string[] | undefined,
	attempt: number,
): string | undefined {
	if (!isp || isp.length === 0) return undefined;
	const index = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
	return isp[index % isp.length];
}

/**
 * Sticky lifetime in whole minutes: `session.lifetimeMinutes` (default and cap
 * 24h), shortened to the gateway TTL when `nodemaven.ttlSeconds` is set. The
 * TTL rounds down to whole minutes so the SDK's session window, reported
 * expiry, ceremony lease and native drain timers never outlive the sticky IP
 * the gateway keeps for the `-ttl-` token.
 */
export function nodemavenLifetimeMinutes(
	policy: ProviderProxyPolicy,
	lifetimeOverride?: number,
): number {
	const configured = lifetimeOverride ?? policy.session?.lifetimeMinutes;
	const sessionMinutes =
		typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0
			? NODEMAVEN_MAX_LIFETIME_MINUTES
			: Math.min(NODEMAVEN_MAX_LIFETIME_MINUTES, Math.max(1, Math.floor(configured)));
	const ttlSeconds = policy.nodemaven?.ttlSeconds;
	if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds)) return sessionMinutes;
	return Math.min(sessionMinutes, Math.max(1, Math.floor(ttlSeconds / 60)));
}

/** Stable wall-clock window shared by every process deriving the same sticky sid. */
export function nodemavenSessionWindow(
	policy: ProviderProxyPolicy,
	now = Date.now(),
	lifetimeOverride?: number,
): ProxySessionWindow {
	return proxySessionWindow(nodemavenLifetimeMinutes(policy, lifetimeOverride), now);
}

/** NodeMaven username tokens accept `[a-z0-9]`; slugify geo values to that set. */
function slugifyGeo(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const slug = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
	return slug || undefined;
}

function selectPort(protocol: ProxyProtocol, sid: string, attempt: number): number {
	const { min, max } = NODEMAVEN_PORTS[protocol];
	const span = max - min + 1;
	const hashInt = Number.parseInt(
		createHash("sha256").update(`${sid}:${attempt}`).digest("hex").slice(0, 8),
		16,
	);
	return min + (hashInt % span);
}

export type NodemavenSynthesisInput = {
	policy: ProviderProxyPolicy;
	/** Explicit credentials; synthesis never reads process-global state. */
	credentials: NodemavenCredentials;
	affinityKey: string | undefined;
	protocol: ProxyProtocol;
	/** Zero-based attempt within this vendor's share of the request's attempt budget. */
	attempt: number;
	/** Sticky session window epoch (`nodemavenSessionWindow`); ignored for rotating policies. */
	windowEpoch: number;
	/** Session kind and lifetime chosen by the vendor selector; absent means the policy's own. */
	session?: ProxySessionDirective;
	/** ISO 3166-1 alpha-2, already resolved by the caller (falls back to env). */
	country?: string;
	/** Clock injection used by native sticky-expiry lifecycle tests. */
	now?: number;
	/** Stable caller-owned hard expiry when the window epoch is wall-clock-derived. */
	expiresAt?: string;
	/** Fixed gateway endpoint in place of `gate.nodemaven.com` and the per-session port. */
	gateway?: ProxyGatewayEndpoint;
};

export type NodemavenSynthesis = {
	url: string;
	protocol: ProxyProtocol;
	sticky: boolean;
	sessionId: string;
	expiresAt?: string;
	lifetimeMinutes: number;
	diagnostics: Record<string, string | number | boolean>;
};

/**
 * Synthesize a NodeMaven gateway proxy URL locally from static credentials.
 * There is no allocation API — geo/session are encoded in the username.
 *
 * Username token order (contract, docs.nodemaven.com/residential-mobile/proxy-string):
 *
 *   <user> -country-<cc> -region-<r> -city-<c> -isp-<slug> -type-mobile
 *          -ipv4-true -sid-<sid> -ttl-<XmYs> -filter-<tier>
 *
 * - `-isp-`, `-type-mobile` and `-ttl-` come from `policy.nodemaven` (type,
 *   isp[attempt % isp.length], ttlSeconds via `formatNodemavenTtl`).
 * - Residential policies keep the token set and values of earlier releases
 *   (`country`, `region`, `city`, `ipv4-true`, `sid`, `filter`); only the
 *   position of `-ipv4-true` moved ahead of `-sid-` to match the documented
 *   order. The sid derivation (`deriveProxySessionId`, attempt 0) and the port
 *   choice are unchanged, so sticky sessions keep their egress. The gateway
 *   assigned exits for both orders in the 2026-10-22 measurements (59 with the
 *   earlier order, 5 with the documented one).
 * - Mobile policies emit `-filter-` only when `APIFUSE__PROXY__NODEMAVEN_FILTER`
 *   is set explicitly; the measured passing shape
 *   (`<user>-country-kr-type-mobile-ipv4-true-sid-<sid>`, 12/15 on
 *   nol.yanolja.com) carries no filter token and the mobile+filter
 *   combination is unverified.
 * - `diagnostics` carries `type` and, when encoded, `isp` so telemetry can
 *   tell a mobile attempt from a residential one without exposing the
 *   username.
 */
export function synthesizeNodemavenProxy(input: NodemavenSynthesisInput): NodemavenSynthesis {
	const username = input.credentials.username.trim();
	const password = input.credentials.password.trim();
	if (!username || !password) {
		throw new Error(
			`NodeMaven credentials missing: set ${NODEMAVEN_USERNAME_ENV} and ${NODEMAVEN_PASSWORD_ENV}.`,
		);
	}

	const options = input.policy.nodemaven;
	const connectionType: NodemavenConnectionType = options?.type ?? "residential";
	const filter = resolveNodemavenFilter(input.credentials.filter, connectionType);
	const isp = selectNodemavenIsp(options?.isp, input.attempt);
	const ttl =
		options?.ttlSeconds === undefined ? undefined : formatNodemavenTtl(options.ttlSeconds);
	const sticky = input.session
		? input.session.kind === "sticky"
		: isStickyProxyPolicy(input.policy);
	const sid = deriveProxySessionId({
		sticky,
		affinityKey: input.affinityKey,
		windowEpoch: input.windowEpoch,
		attempt: input.attempt,
	});
	const gateway = input.gateway
		? formatProxyGatewayEndpoint(input.gateway)
		: `${NODEMAVEN_GATEWAY_HOST}:${selectPort(input.protocol, sid, input.attempt)}`;
	const lifetimeMinutes = nodemavenLifetimeMinutes(input.policy, input.session?.lifetimeMinutes);

	const country = slugifyGeo(input.country ?? input.policy.geo?.country);
	const region = slugifyGeo(input.policy.geo?.subdivision);
	const city = slugifyGeo(input.policy.geo?.city);

	// Documented order: country, region, city, isp, type, ipv4, sid, ttl, filter.
	const tokens = [username];
	if (country) tokens.push("country", country);
	if (region) tokens.push("region", region);
	if (city) tokens.push("city", city);
	if (isp) tokens.push("isp", isp);
	if (connectionType === "mobile") tokens.push("type", "mobile");
	tokens.push("ipv4", "true");
	tokens.push("sid", sid);
	if (ttl) tokens.push("ttl", ttl);
	if (filter) tokens.push("filter", filter);
	const proxyUsername = tokens.join("-");

	// Username tokens are [a-z0-9_-] only (carrier slugs add `_`), which survive
	// URL encoding unchanged.
	const url = `${input.protocol}://${proxyUsername}:${encodeURIComponent(password)}@${gateway}`;

	return {
		url,
		protocol: input.protocol,
		sticky,
		sessionId: sid,
		lifetimeMinutes,
		...(sticky
			? {
					expiresAt:
						input.expiresAt ??
						new Date((input.now ?? Date.now()) + lifetimeMinutes * 60_000).toISOString(),
				}
			: {}),
		diagnostics: {
			vendor: "nodemaven",
			protocol: input.protocol,
			sticky,
			type: connectionType,
			...(filter ? { filter } : {}),
			...(isp ? { isp } : {}),
			lifetimeMinutes,
			...(country ? { country } : {}),
		},
	};
}
