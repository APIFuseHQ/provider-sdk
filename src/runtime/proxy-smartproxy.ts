import type { ProviderProxyPolicy } from "../types.js";
import {
	formatProxyGatewayEndpoint,
	type ProxyGatewayEndpoint,
	type ProxyProtocol,
} from "./proxy-nodemaven.js";
import {
	deriveProxySessionId,
	isStickyProxyPolicy,
	type ProxySessionDirective,
	type ProxySessionWindow,
	proxySessionWindow,
} from "./proxy-session-id.js";

// "smartproxy" is the vendor behind api.smartproxy.org / www.smartproxy.ai (the
// site redirects there). It is NOT the company formerly named Smartproxy
// (smartproxy.com, now Decodo). The vendor offers two acquisition modes; the
// SDK uses the gateway ("User&Pass Auth") mode: a sub-account username and
// password authenticate against one gateway host and the session is encoded in
// the username, exactly as NodeMaven does. The IP-extraction API (app_key) is
// no longer used by the SDK.
export const SMARTPROXY_USERNAME_ENV = "APIFUSE__PROXY__SMARTPROXY_USERNAME";
export const SMARTPROXY_PASSWORD_ENV = "APIFUSE__PROXY__SMARTPROXY_PASSWORD";

/**
 * Gateway endpoint shown by the vendor dashboard for the "Smart Region" proxy
 * server (user guide screenshots, 2026-08: `Proxy Server: proxy.smartproxy.net`,
 * `Port: 3120`). The same port is used for SOCKS5 until the vendor confirms a
 * separate one.
 */
export const SMARTPROXY_GATEWAY_HOST = "proxy.smartproxy.net";
export const SMARTPROXY_GATEWAY_PORT = 3120;

/** HTTP CONNECT: the only protocol ctx.http can use, and a tie for stealth in the KR benchmarks. */
export const SMARTPROXY_DEFAULT_PROTOCOL: ProxyProtocol = "http";

/**
 * Sticky lifetime bounds in whole minutes. The dashboard's shortest sticky
 * option is 5 minutes and the vendor FAQ states "Most plans allow 5-120 min
 * stickiness; exceeding that limit will force rotation". A declared lifetime
 * outside the range is clamped and reported in `diagnostics.lifetimeClamped`.
 */
export const SMARTPROXY_MIN_LIFETIME_MINUTES = 5;
export const SMARTPROXY_MAX_LIFETIME_MINUTES = 120;
export const SMARTPROXY_DEFAULT_LIFETIME_MINUTES = 30;

export type SmartproxyCredentials = {
	readonly username: string;
	readonly password: string;
};

/**
 * Sticky lifetime in whole minutes: `session.lifetimeMinutes`, else the
 * platform default, clamped to the vendor's sticky range.
 */
export function smartproxyLifetimeMinutes(
	policy: ProviderProxyPolicy,
	fallbackMinutes = SMARTPROXY_DEFAULT_LIFETIME_MINUTES,
	lifetimeOverride?: number,
): number {
	const configured = lifetimeOverride ?? policy.session?.lifetimeMinutes;
	const minutes =
		typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0
			? fallbackMinutes
			: configured;
	return Math.min(
		SMARTPROXY_MAX_LIFETIME_MINUTES,
		Math.max(SMARTPROXY_MIN_LIFETIME_MINUTES, Math.floor(minutes)),
	);
}

/** Stable wall-clock window shared by every process deriving the same sticky session id. */
export function smartproxySessionWindow(
	policy: ProviderProxyPolicy,
	now = Date.now(),
	fallbackMinutes = SMARTPROXY_DEFAULT_LIFETIME_MINUTES,
	lifetimeOverride?: number,
): ProxySessionWindow {
	return proxySessionWindow(
		smartproxyLifetimeMinutes(policy, fallbackMinutes, lifetimeOverride),
		now,
	);
}

export type SmartproxySynthesisInput = {
	readonly policy: ProviderProxyPolicy;
	/** Explicit credentials; synthesis never reads process-global state. */
	readonly credentials: SmartproxyCredentials;
	readonly affinityKey: string | undefined;
	readonly protocol: ProxyProtocol;
	/** Zero-based attempt within this vendor's share of the request's attempt budget. */
	readonly attempt: number;
	/** Sticky session window epoch (`smartproxySessionWindow`); ignored for rotating policies. */
	readonly windowEpoch: number;
	/** Session kind and lifetime chosen by the vendor selector; absent means the policy's own. */
	readonly session?: ProxySessionDirective;
	/** ISO 3166-1 alpha-2, already resolved by the caller (policy geo or platform default). */
	readonly country?: string;
	/** Platform default lifetime when the policy declares none. */
	readonly defaultLifetimeMinutes?: number;
	/** Clock injection used by sticky-expiry lifecycle tests. */
	readonly now?: number;
	/** Stable caller-owned hard expiry when the window epoch is wall-clock-derived. */
	readonly expiresAt?: string;
	/** Fixed gateway endpoint in place of `proxy.smartproxy.net:3120`. */
	readonly gateway?: ProxyGatewayEndpoint;
};

export type SmartproxySynthesis = {
	readonly url: string;
	readonly protocol: ProxyProtocol;
	readonly sticky: boolean;
	readonly sessionId: string;
	readonly expiresAt?: string;
	readonly lifetimeMinutes: number;
	readonly diagnostics: Record<string, string | number | boolean>;
};

/** Username tokens are `_`-separated `key-value` pairs; keys and values must not contain `_`. */
const SMARTPROXY_TOKEN_VALUE = /^[A-Za-z0-9-]+$/;

function assertTokenValue(name: string, value: string): string {
	if (!SMARTPROXY_TOKEN_VALUE.test(value)) {
		throw new Error(`smartproxy username token "${name}" has an invalid value`);
	}
	return value;
}

/**
 * Synthesize a smartproxy gateway proxy URL locally from static credentials.
 * There is no allocation API call: geo and session ride in the username.
 *
 * Username grammar (vendor dashboard "User&Pass Auth" generator, rotating
 * residential product), tokens joined with `_`, key and value joined with `-`:
 *
 *   <user>_area-<CC>_life-<minutes>_session-<id>
 *
 * e.g. `smart-HUHU123_area-RU_life-5_session-ICUItQ0g4e`. `area` is omitted when
 * no country is known (the dashboard's "Random"). The dashboard also offers
 * state and city; their token names are not documented in text and are not
 * encoded until verified against a generated string. A rotating policy still
 * carries `life` and a random `session` so every attempt is its own vendor
 * session and the resolved URL differs per attempt.
 */
export function synthesizeSmartproxyProxy(input: SmartproxySynthesisInput): SmartproxySynthesis {
	const username = input.credentials.username.trim();
	const password = input.credentials.password.trim();
	if (!username || !password) {
		throw new Error(
			`smartproxy credentials missing: set ${SMARTPROXY_USERNAME_ENV} and ${SMARTPROXY_PASSWORD_ENV}.`,
		);
	}
	if (username.includes("_")) {
		throw new Error(
			`${SMARTPROXY_USERNAME_ENV} must not contain "_" (the username token separator)`,
		);
	}

	const sticky = input.session
		? input.session.kind === "sticky"
		: isStickyProxyPolicy(input.policy);
	const declaredLifetime = input.session?.lifetimeMinutes ?? input.policy.session?.lifetimeMinutes;
	const lifetimeMinutes = smartproxyLifetimeMinutes(
		input.policy,
		input.defaultLifetimeMinutes,
		input.session?.lifetimeMinutes,
	);
	const lifetimeClamped =
		typeof declaredLifetime === "number" &&
		Number.isFinite(declaredLifetime) &&
		Math.floor(declaredLifetime) !== lifetimeMinutes;
	const sessionId = deriveProxySessionId({
		sticky,
		affinityKey: input.affinityKey,
		windowEpoch: input.windowEpoch,
		attempt: input.attempt,
	});
	const country = input.country?.trim().toUpperCase() || undefined;

	const tokens = [username];
	if (country) tokens.push(`area-${assertTokenValue("area", country)}`);
	tokens.push(`life-${lifetimeMinutes}`);
	tokens.push(`session-${assertTokenValue("session", sessionId)}`);
	const proxyUsername = tokens.join("_");

	const gateway = input.gateway
		? formatProxyGatewayEndpoint(input.gateway)
		: `${SMARTPROXY_GATEWAY_HOST}:${SMARTPROXY_GATEWAY_PORT}`;
	const url = `${input.protocol}://${encodeURIComponent(proxyUsername)}:${encodeURIComponent(password)}@${gateway}`;

	return {
		url,
		protocol: input.protocol,
		sticky,
		sessionId,
		lifetimeMinutes,
		...(sticky
			? {
					expiresAt:
						input.expiresAt ??
						new Date((input.now ?? Date.now()) + lifetimeMinutes * 60_000).toISOString(),
				}
			: {}),
		diagnostics: {
			vendor: "smartproxy",
			protocol: input.protocol,
			sticky,
			lifetimeMinutes,
			...(lifetimeClamped ? { lifetimeClamped: true } : {}),
			...(country ? { country } : {}),
		},
	};
}
