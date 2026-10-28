import { readDiagnosticEnv } from "../runtime/diagnostic-env.js";
import { existsSync } from "node:fs";
import path from "node:path";

import type { ProviderProxyPolicy, ProviderProxyProvider, TraceConfig } from "../types.js";
import {
	NODEMAVEN_DEFAULT_PROTOCOL,
	NODEMAVEN_FILTER_ENV,
	NODEMAVEN_PASSWORD_ENV,
	NODEMAVEN_USERNAME_ENV,
	type ProxyGatewayEndpoint,
	type ProxyProtocol,
	nodemavenSessionWindow,
	synthesizeNodemavenProxy,
} from "../runtime/proxy-nodemaven.js";
import {
	SMARTPROXY_DEFAULT_LIFETIME_MINUTES,
	SMARTPROXY_DEFAULT_PROTOCOL,
	SMARTPROXY_PASSWORD_ENV,
	SMARTPROXY_USERNAME_ENV,
	smartproxySessionWindow,
	synthesizeSmartproxyProxy,
} from "../runtime/proxy-smartproxy.js";
import {
	getProxyVendorSelector,
	PROXY_ATTEMPTS_PER_VENDOR,
	type ProxyAttemptRecord,
	type ProxySessionDirective,
	type ProxyVendorSelector,
} from "../runtime/proxy-vendor-selector.js";

export type { ProxyGatewayEndpoint, ProxyProtocol } from "../runtime/proxy-nodemaven.js";
export {
	getProxyVendorSelector,
	mapAttemptToVendor,
	PROXY_ATTEMPTS_PER_VENDOR,
	type ProxyAttemptOutcome,
	type ProxyAttemptRecord,
	type ProxyAttemptRequest,
	type ProxyAttemptSlot,
	type ProxySessionDirective,
	type ProxyVendorDirective,
	type ProxyVendorSelector,
	setProxyVendorSelector,
	staticOrderProxyVendorSelector,
} from "../runtime/proxy-vendor-selector.js";

/**
 * Proxy vendors with SDK-managed resolution. Both are gateway vendors: the SDK
 * synthesizes `<protocol>://<user-with-session-tokens>:<password>@<gateway>`
 * locally and the vendor owns the session→IP mapping. There is no allocation
 * API call, no shared pool, no cache and no lock on this path.
 */
export type ProxyVendorName = "smartproxy" | "nodemaven";

// "smartproxy" here is the vendor behind api.smartproxy.org / www.smartproxy.ai
// (gateway proxy.smartproxy.net). It is NOT the company formerly named
// Smartproxy (smartproxy.com), which rebranded to Decodo in 2025 and is
// modelled separately as the deprecated `decodo` vendor. Do not conflate them.
export const DEFAULT_PROXY_PROVIDER_ENV = "APIFUSE__PROXY__PROVIDER";
export const DEFAULT_PROXY_COUNTRY_ENV = "APIFUSE__PROXY__DEFAULT_COUNTRY";
export const DEFAULT_PROXY_LIFETIME_ENV = "APIFUSE__PROXY__DEFAULT_LIFETIME_MINUTES";
export const PROVIDER_CACHE_REDIS_URL_ENV = "APIFUSE__PROVIDER__CACHE_REDIS_URL";
export const PROVIDER_STATE_REDIS_URL_ENV = "APIFUSE__PROVIDER__STATE_REDIS_URL";
export const REDIS_URL_ENV = "APIFUSE__REDIS__URL";

export type BrowserConfig = {
	executablePath?: string;
	headless?: boolean;
};

export type SessionConfig = {
	storage?: "sqlite" | "supabase";
	path?: string;
};

export type ApiFuseConfig = {
	browser?: BrowserConfig;
	session?: SessionConfig;
	trace?: TraceConfig;
	credentials?: Record<string, Record<string, string>>;
};

export type ProxyResolutionOptions = {
	proxy?: string;
	upstream?: { proxy?: boolean | ProviderProxyPolicy };
	proxyPolicy?: ProviderProxyPolicy;
	affinityKey?: string;
	/**
	 * Zero-based transport attempt index. Every attempt resolves a different
	 * vendor session: a rotating policy mints a fresh random session id, a sticky
	 * policy derives `sid(affinityKey, window, attempt)`, so a retry leaves the
	 * egress IP that failed without any shared pool state.
	 */
	proxyAttempt?: number;
	/**
	 * Total transport attempts the caller may make for this request. The budget
	 * is split evenly across the policy's vendor chain in declaration order
	 * (`mapAttemptToVendor`), so every declared vendor is reached whenever the
	 * budget is at least the chain length. Defaults to
	 * `chain.length × PROXY_ATTEMPTS_PER_VENDOR`.
	 */
	proxyAttemptCap?: number;
	/**
	 * Tunnelling protocols the calling transport can use. When a resolved
	 * protocol is not in this set the resolver fails with
	 * `PROXY_PROTOCOL_UNSUPPORTED` instead of silently downgrading. Unset means
	 * permissive (both protocols allowed).
	 */
	transportProtocols?: readonly ProxyProtocol[];
	/**
	 * Explicit protocol override. Internal — for the verification harness and
	 * tests, or an advanced caller. Normal callers omit it and each vendor uses
	 * its own benchmarked default protocol (see VENDOR_DEFAULT_PROTOCOL). Not an
	 * env var and not a provider-policy field.
	 */
	protocol?: ProxyProtocol;
	/** Clock for the sticky session window. Tests inject it; callers omit it. */
	now?: number;
	/**
	 * Vendor selector for this call; defaults to the process selector
	 * (`getProxyVendorSelector`). The transports pin one selector per request
	 * and report every attempt's outcome to that same instance.
	 */
	vendorSelector?: ProxyVendorSelector;
	/**
	 * Identifier of the request this resolution serves, forwarded to the
	 * selector as `ProxyAttemptRequest.requestId` and on every outcome reported
	 * for it. The transports set it once per request; callers omit it.
	 */
	proxyRequestId?: string;
	/**
	 * Transport outcomes of the request's earlier attempts, oldest first,
	 * forwarded to the selector as `ProxyAttemptRequest.history`. The transports
	 * accumulate it across their retry loop; callers omit it.
	 */
	proxyAttemptHistory?: readonly ProxyAttemptRecord[];
	/**
	 * Gateway endpoint per vendor in place of the vendor's fixed gateway.
	 * Internal: for assembly tests and the verification harness that point a
	 * vendor at a loopback fake gateway. Not an env var and not a provider-policy
	 * field; the username grammar, session id and credentials are unchanged.
	 */
	gatewayOverrides?: ProxyGatewayOverrides;
	telemetry?: ProxyTelemetrySink;
	/** Engine-owned credential snapshot. Provider code must never populate this field. */
	engineCredentials?: Readonly<Record<string, string>>;
};

/** Gateway endpoint overrides keyed by vendor (`ProxyResolutionOptions.gatewayOverrides`). */
export type ProxyGatewayOverrides = Readonly<
	Partial<Record<ProxyVendorName, ProxyGatewayEndpoint>>
>;

/**
 * Gateway vendors synthesize the proxy URL locally, so no resolution is served
 * from a cache. The field stays on the telemetry wire (the gateway persists it
 * as `proxy_cache_status`) with its one remaining value.
 */
export type ProxyCacheStatus = "disabled";

export type ProxyUserAgentSource = "declared" | "defaulted";

export type ProxyResolutionTelemetryEvent = {
	provider: ProxyVendorName;
	/** Defaults to `"ok"` when omitted. */
	outcome?: "ok" | "error";
	userAgentSource?: ProxyUserAgentSource;
	protocol?: ProxyProtocol;
	cacheStatus: ProxyCacheStatus;
	cacheHit: boolean;
	resolutionMs: number;
	attempts: number;
};

export type ProxyAttemptTelemetryEvent = {
	provider: ProxyVendorName;
	attempt: number;
	/** Bounded hash of the resolved proxy URL; differs per vendor session, so it identifies the attempt's egress. */
	proxyHash?: string;
	/**
	 * An attempt whose exit the origin's admission layer refused (headerless 403
	 * or 5xx, `stealth.rotateExitOnAdmissionRefusal`) is `error` with
	 * `errorCode: "PROXY_EXIT_REFUSED"`; the request is then sent once more
	 * on the next attempt's vendor session.
	 */
	outcome: "ok" | "error";
	errorCode?: string;
	status?: number;
	durationMs?: number;
};

export type ProxyVendorFailoverTelemetryEvent = {
	/** Vendor that failed or was skipped. */
	vendor: ProxyVendorName;
	/** Vendor tried next, or undefined when the chain is exhausted. */
	nextVendor?: ProxyVendorName;
	phase: "resolution" | "transport";
	/**
	 * `allocation_failed`: the vendor could not synthesize a proxy for this
	 * attempt. `pool_exhausted`: the vendor's share of the attempt budget was
	 * spent at the transport. The names are kept as persisted by the gateway.
	 */
	reason: "no_credentials" | "allocation_failed" | "pool_exhausted" | "protocol_unsupported";
	attempt?: number;
};

export type ProxyTelemetrySink = {
	recordProxyResolution(event: ProxyResolutionTelemetryEvent): void;
	recordProxyAttempt?(event: ProxyAttemptTelemetryEvent): void;
	recordProxyVendorFailover?(event: ProxyVendorFailoverTelemetryEvent): void;
};

export type ProxyResolutionSource =
	| "explicit"
	| "env"
	| "config"
	| "smartproxy-gateway"
	| "nodemaven-gateway";

export type ResolvedProxyConfig = {
	shouldWarn: boolean;
	url?: string;
	/** SDK-native vendor that supplied the URL, when applicable. */
	vendor?: ProxyVendorName;
	source?: ProxyResolutionSource;
	protocol?: ProxyProtocol;
	/** True when the policy affinity is sticky and the URL carries a derived session id. */
	sticky?: boolean;
	/** Vendor session id carried in the URL's username; random per attempt for rotating policies. */
	sessionId?: string;
	/** Hard end of the sticky session window, ISO 8601. Absent for rotating policies. */
	expiresAt?: string;
	/** Vendor session lifetime in whole minutes after the vendor's clamp. */
	lifetimeMinutes?: number;
	diagnostics?: Record<string, string | number | boolean>;
};

export type ProxyResolutionErrorCode =
	| "PROXY_REQUIRED"
	| "PROXY_ALLOCATION_FAILED"
	| "PROXY_PROTOCOL_UNSUPPORTED";

export class ProxyResolutionError extends Error {
	readonly code: ProxyResolutionErrorCode;
	readonly telemetry?: ProxyResolutionTelemetryEvent;
	readonly vendor?: ProxyVendorName;
	readonly vendorChain?: ProxyVendorName[];
	readonly protocol?: ProxyProtocol;

	constructor(
		code: ProxyResolutionErrorCode,
		message: string,
		options?: {
			cause?: unknown;
			telemetry?: ProxyResolutionTelemetryEvent;
			vendor?: ProxyVendorName;
			vendorChain?: ProxyVendorName[];
			protocol?: ProxyProtocol;
		},
	) {
		super(message, options);
		this.name = "ProxyResolutionError";
		this.code = code;
		this.telemetry = options?.telemetry;
		this.vendor = options?.vendor;
		this.vendorChain = options?.vendorChain;
		this.protocol = options?.protocol;
	}
}

/** Env names that can supply a provider store's Redis URL. */
export type ProviderRedisUrlEnvName =
	| typeof PROVIDER_STATE_REDIS_URL_ENV
	| typeof PROVIDER_CACHE_REDIS_URL_ENV
	| typeof REDIS_URL_ENV;

/** Which env name supplied a store's Redis URL, alongside the URL itself. */
export type ProviderRedisUrlResolution = {
	readonly url: string;
	/** The env name that actually supplied `url`. */
	readonly envName: ProviderRedisUrlEnvName;
	/**
	 * True when `url` came from a shared fallback env rather than the store's
	 * own. A state store on `fallback: true` is sharing an instance that was
	 * provisioned for something else (apifuse#2144).
	 */
	readonly fallback: boolean;
};

// Precedence is declared once here so the URL accessors, the boot report and
// any future consumer can never disagree about which env wins.
const CACHE_REDIS_URL_PRECEDENCE = [PROVIDER_CACHE_REDIS_URL_ENV, REDIS_URL_ENV] as const;
const STATE_REDIS_URL_PRECEDENCE = [
	PROVIDER_STATE_REDIS_URL_ENV,
	PROVIDER_CACHE_REDIS_URL_ENV,
	REDIS_URL_ENV,
] as const;

function resolveRedisUrlFromEnv(
	precedence: readonly ProviderRedisUrlEnvName[],
): ProviderRedisUrlResolution | undefined {
	for (const [index, envName] of precedence.entries()) {
		const url = readDiagnosticEnv(envName)?.trim();
		if (url) return { url, envName, fallback: index > 0 };
	}
	return undefined;
}

export function providerCacheRedisResolutionFromEnv(): ProviderRedisUrlResolution | undefined {
	return resolveRedisUrlFromEnv(CACHE_REDIS_URL_PRECEDENCE);
}

export function providerStateRedisResolutionFromEnv(): ProviderRedisUrlResolution | undefined {
	return resolveRedisUrlFromEnv(STATE_REDIS_URL_PRECEDENCE);
}

export function providerCacheRedisUrlFromEnv(): string | undefined {
	return providerCacheRedisResolutionFromEnv()?.url;
}

export function providerStateRedisUrlFromEnv(): string | undefined {
	return providerStateRedisResolutionFromEnv()?.url;
}

function normalizeProxyUrl(url?: string): string | undefined {
	const normalized = url?.trim();
	return normalized || undefined;
}

export function resolveProxyConfig(options: ProxyResolutionOptions = {}): ResolvedProxyConfig {
	const explicitProxyUrl = normalizeProxyUrl(options.proxy);
	if (explicitProxyUrl) {
		return { shouldWarn: false, url: explicitProxyUrl };
	}

	const policy = resolvePolicy(options);
	if (policy?.mode === "disabled") {
		return { shouldWarn: false };
	}

	const legacyProxyRequested =
		options.upstream?.proxy === true || (!policy && options.upstream?.proxy);
	if (!legacyProxyRequested) {
		return { shouldWarn: false };
	}

	return { shouldWarn: true };
}

export async function resolveProxyConfigAsync(
	options: ProxyResolutionOptions = {},
): Promise<ResolvedProxyConfig> {
	const explicitProxyUrl = normalizeProxyUrl(options.proxy);
	if (explicitProxyUrl) {
		return { shouldWarn: false, url: explicitProxyUrl, source: "explicit" };
	}

	const policy = resolvePolicy(options);
	if (!policy) {
		return resolveProxyConfig(options);
	}
	if (policy.mode === "disabled") {
		return { shouldWarn: false };
	}

	const chain = resolveVendorChain(policy);
	if (chain.length === 0) {
		const declared = declaredVendorChain(policy);
		const deprecated = declared.filter((vendor) => vendor === "decodo" || vendor === "custom");
		if (policy.mode === "required") {
			const providerIds =
				declared.length > 0 ? declared.map((vendor) => `"${vendor}"`).join(", ") : "none";
			const deprecatedDetail =
				deprecated.length > 0
					? ` Deprecated vendor(s): ${deprecated.map((vendor) => `"${vendor}"`).join(", ")}.`
					: "";
			throw new ProxyResolutionError(
				"PROXY_REQUIRED",
				`Required proxy policy has no SDK-managed adapter for provider id(s): ${providerIds}.${deprecatedDetail} Use "smartproxy" or "nodemaven".`,
			);
		}
		// Deprecated decodo/custom providers have no SDK-managed adapter. Optional
		// policies preserve the warning-only behavior and may continue directly.
		return resolveProxyConfig({
			...options,
			upstream: { proxy: true },
		});
	}

	// Protocol is chosen per vendor (each vendor's benchmarked-best), with an
	// optional explicit override for the harness/tests. Both are tunnelling
	// schemes. transportProtocols is what the calling transport can actually use.
	const transportProtocols = options.transportProtocols ?? (["http", "socks5"] as const);

	const attempt = normalizeAttemptIndex(options.proxyAttempt);
	const attemptCap = normalizeAttemptCap(options.proxyAttemptCap, chain.length);
	const now = options.now ?? Date.now();
	// The selector decides which vendor serves this attempt and with which
	// session; the resolver only walks its directives and reports back.
	const selector = options.vendorSelector ?? getProxyVendorSelector();
	const directives = selector.select({
		policy,
		chain,
		attempt,
		attemptCap,
		...(options.affinityKey === undefined ? {} : { affinityKey: options.affinityKey }),
		now,
		...(options.proxyRequestId ? { requestId: options.proxyRequestId } : {}),
		...(options.proxyAttemptHistory ? { history: [...options.proxyAttemptHistory] } : {}),
	});
	const reportResolution = (
		vendor: ProxyVendorName,
		vendorAttempt: number,
		outcome: "ok" | "error",
		detail: { sessionId?: string; errorCode?: string } = {},
	): void => {
		try {
			selector.report({
				vendor,
				phase: "resolution",
				outcome,
				attempt,
				vendorAttempt,
				...(detail.sessionId ? { sessionId: detail.sessionId } : {}),
				...(detail.errorCode ? { errorCode: detail.errorCode } : {}),
				now,
				...(options.proxyRequestId ? { requestId: options.proxyRequestId } : {}),
			});
		} catch {
			// A selector cannot fail the resolution it observes.
		}
	};

	let lastError: unknown;
	let blockedProtocol: ProxyProtocol | undefined;
	for (const [index, directive] of directives.entries()) {
		const vendor = directive.vendor;
		const nextVendor = directives[index + 1]?.vendor;
		const vendorAttempt = directive.vendorAttempt;
		const protocol = options.protocol ?? VENDOR_DEFAULT_PROTOCOL[vendor];

		if (!vendorHasCredentials(vendor, options.engineCredentials)) {
			reportResolution(vendor, vendorAttempt, "error", { errorCode: "no_credentials" });
			options.telemetry?.recordProxyVendorFailover?.({
				vendor,
				nextVendor,
				phase: "resolution",
				reason: "no_credentials",
			});
			continue;
		}

		// The calling transport must be able to use this vendor's protocol; if not,
		// fail over to the next vendor rather than silently downgrading.
		if (!transportProtocols.includes(protocol)) {
			blockedProtocol = protocol;
			reportResolution(vendor, vendorAttempt, "error", { errorCode: "protocol_unsupported" });
			options.telemetry?.recordProxyVendorFailover?.({
				vendor,
				nextVendor,
				phase: "resolution",
				reason: "protocol_unsupported",
			});
			continue;
		}

		try {
			const resolved = await resolveWithVendor(vendor, policy, options, {
				protocol,
				attempt: vendorAttempt,
				now,
				session: directive.session,
				credentials: options.engineCredentials,
			});
			reportResolution(vendor, vendorAttempt, "ok", {
				...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}),
			});
			return resolved;
		} catch (error) {
			// Config/programming errors (invalid filter, etc.) are not vendor
			// outages — propagate them rather than failing over.
			if (!(error instanceof ProxyResolutionError)) {
				throw error;
			}
			if (error.telemetry) {
				options.telemetry?.recordProxyResolution(error.telemetry);
			}
			lastError = error;
			reportResolution(vendor, vendorAttempt, "error", { errorCode: error.code });
			options.telemetry?.recordProxyVendorFailover?.({
				vendor,
				nextVendor,
				phase: "resolution",
				reason: "allocation_failed",
			});
		}
	}

	if (policy.mode === "required") {
		if (lastError) {
			throw lastError instanceof ProxyResolutionError
				? lastError
				: new ProxyResolutionError(
						"PROXY_ALLOCATION_FAILED",
						`All proxy vendors [${chain.join(", ")}] failed for required proxy egress.`,
						{ cause: lastError, vendorChain: chain },
					);
		}
		if (blockedProtocol) {
			throw new ProxyResolutionError(
				"PROXY_PROTOCOL_UNSUPPORTED",
				`No proxy vendor in [${chain.join(", ")}] could serve a protocol supported by this transport (supports: ${transportProtocols.join(", ")}; vendor wanted "${blockedProtocol}"). Route this provider through the stealth transport.`,
				{ protocol: blockedProtocol, vendorChain: chain },
			);
		}
		throw new ProxyResolutionError(
			"PROXY_REQUIRED",
			`Proxy egress is required but no vendor credentials are configured. Missing: ${chain
				.map(
					(vendor) =>
						`${missingCredentialEnvNames(vendor, options.engineCredentials).join(" and ")} (${vendor})`,
				)
				.join(", ")}.`,
			{ vendorChain: chain },
		);
	}
	return { shouldWarn: true };
}

/**
 * Resolve the proxy URL for a provider-owned consumer such as a CAPTCHA solver.
 * Vendor synthesis and failover remain owned by the SDK.
 */
export async function resolveProxy(
	options: ProxyResolutionOptions = {},
): Promise<ResolvedProxyConfig> {
	const resolved = await resolveProxyConfigAsync(options);
	const vendor = vendorFromResolvedSource(resolved.source);
	return vendor ? { ...resolved, vendor } : resolved;
}

/**
 * Each vendor's default egress protocol, chosen from live KR benchmarks. HTTP
 * CONNECT wins for nodemaven (socks5 adds ~500ms through the gateway) and ties
 * for smartproxy, and is the only protocol ctx.http (Bun native fetch) supports.
 * Override per call via ProxyResolutionOptions.protocol (harness/tests).
 */
export const VENDOR_DEFAULT_PROTOCOL: Readonly<Record<ProxyVendorName, ProxyProtocol>> = {
	smartproxy: SMARTPROXY_DEFAULT_PROTOCOL,
	nodemaven: NODEMAVEN_DEFAULT_PROTOCOL,
};

/**
 * Guard the No-MITM invariant: a resolved proxy URL must use a tunnelling scheme
 * (http CONNECT or socks5) so the client TLS handshake reaches the origin
 * end-to-end. Anything else would intercept TLS and break fingerprinting.
 */
export function assertTunnelingScheme(url: string): void {
	let scheme: string;
	try {
		scheme = new URL(url).protocol.replace(/:$/, "").toLowerCase();
	} catch {
		throw new ProxyResolutionError("PROXY_ALLOCATION_FAILED", `Malformed proxy URL: ${url}`);
	}
	if (scheme !== "http" && scheme !== "socks5") {
		throw new ProxyResolutionError(
			"PROXY_ALLOCATION_FAILED",
			`Resolved proxy scheme "${scheme}" is not a tunnelling scheme (expected http or socks5). Refusing to route TLS through a non-tunnelling proxy.`,
		);
	}
}

export type ProxyVendorResolutionContext = {
	readonly protocol: ProxyProtocol;
	/** Zero-based attempt within this vendor's share of the request's attempt budget. */
	readonly attempt: number;
	/** Clock for the sticky session window. */
	readonly now: number;
	/** Session kind and lifetime chosen by the vendor selector; absent means the policy's own. */
	readonly session?: ProxySessionDirective;
	/** Explicit vendor credentials. Omit only on the legacy ambient-env path. */
	readonly credentials?: Readonly<Record<string, string>>;
	/** Disable non-policy env defaults for deterministic injected adapters. */
	readonly ambientDefaults?: boolean;
};

function readCredential(
	name: string,
	credentials: Readonly<Record<string, string>> | undefined,
): string | undefined {
	return (credentials === undefined ? readDiagnosticEnv(name) : credentials[name])?.trim();
}

/**
 * Synthesize one vendor's proxy URL for one attempt. Both vendors are gateway
 * vendors: the result is a pure function of the policy, the credentials, the
 * affinity key, the attempt and the clock.
 */
export async function resolveWithVendor(
	vendor: ProxyVendorName,
	policy: ProviderProxyPolicy,
	options: ProxyResolutionOptions,
	context: ProxyVendorResolutionContext,
): Promise<ResolvedProxyConfig> {
	const startedAt = Date.now();
	const ambientDefaults = context.ambientDefaults !== false;
	const country = resolveProxyCountry(policy, ambientDefaults);

	if (vendor === "nodemaven") {
		const username = readCredential(NODEMAVEN_USERNAME_ENV, context.credentials);
		const password = readCredential(NODEMAVEN_PASSWORD_ENV, context.credentials);
		const filter =
			context.credentials === undefined
				? process.env[NODEMAVEN_FILTER_ENV]
				: context.credentials[NODEMAVEN_FILTER_ENV];
		if (!username || !password) {
			throw new ProxyResolutionError(
				"PROXY_ALLOCATION_FAILED",
				`NodeMaven credentials missing: set ${NODEMAVEN_USERNAME_ENV} and ${NODEMAVEN_PASSWORD_ENV}.`,
				{ vendor: "nodemaven" },
			);
		}
		const window = nodemavenSessionWindow(policy, context.now, context.session?.lifetimeMinutes);
		const synthesized = synthesizeNodemavenProxy({
			policy,
			credentials: {
				username,
				password,
				...(filter ? { filter } : {}),
			},
			affinityKey: options.affinityKey,
			protocol: context.protocol,
			attempt: context.attempt,
			windowEpoch: window.windowEpoch,
			...(context.session ? { session: context.session } : {}),
			country,
			now: context.now,
			expiresAt: window.expiresAt,
			...(options.gatewayOverrides?.nodemaven
				? { gateway: options.gatewayOverrides.nodemaven }
				: {}),
		});
		options.telemetry?.recordProxyResolution({
			provider: "nodemaven",
			protocol: synthesized.protocol,
			cacheStatus: "disabled",
			cacheHit: false,
			resolutionMs: Math.max(0, Date.now() - startedAt),
			attempts: 1,
		});
		assertTunnelingScheme(synthesized.url);
		return {
			shouldWarn: false,
			url: synthesized.url,
			source: "nodemaven-gateway",
			protocol: synthesized.protocol,
			sticky: synthesized.sticky,
			sessionId: synthesized.sessionId,
			...(synthesized.expiresAt ? { expiresAt: synthesized.expiresAt } : {}),
			lifetimeMinutes: synthesized.lifetimeMinutes,
			diagnostics: {
				...synthesized.diagnostics,
				attempt: context.attempt,
			},
		};
	}

	const username = readCredential(SMARTPROXY_USERNAME_ENV, context.credentials);
	const password = readCredential(SMARTPROXY_PASSWORD_ENV, context.credentials);
	if (!username || !password) {
		// Guarded by vendorHasCredentials; treated as a vendor-internal failure.
		throw new ProxyResolutionError(
			"PROXY_ALLOCATION_FAILED",
			`smartproxy credentials missing: set ${SMARTPROXY_USERNAME_ENV} and ${SMARTPROXY_PASSWORD_ENV}.`,
			{ vendor: "smartproxy" },
		);
	}
	const defaultLifetimeMinutes = resolveDefaultLifetimeMinutes(ambientDefaults);
	const window = smartproxySessionWindow(
		policy,
		context.now,
		defaultLifetimeMinutes,
		context.session?.lifetimeMinutes,
	);
	const synthesized = synthesizeSmartproxyProxy({
		policy,
		credentials: { username, password },
		affinityKey: options.affinityKey,
		protocol: context.protocol,
		attempt: context.attempt,
		windowEpoch: window.windowEpoch,
		...(context.session ? { session: context.session } : {}),
		country,
		defaultLifetimeMinutes,
		now: context.now,
		expiresAt: window.expiresAt,
		...(options.gatewayOverrides?.smartproxy
			? { gateway: options.gatewayOverrides.smartproxy }
			: {}),
	});
	options.telemetry?.recordProxyResolution({
		provider: "smartproxy",
		protocol: synthesized.protocol,
		cacheStatus: "disabled",
		cacheHit: false,
		resolutionMs: Math.max(0, Date.now() - startedAt),
		attempts: 1,
	});
	assertTunnelingScheme(synthesized.url);
	return {
		shouldWarn: false,
		url: synthesized.url,
		source: "smartproxy-gateway",
		protocol: synthesized.protocol,
		sticky: synthesized.sticky,
		sessionId: synthesized.sessionId,
		...(synthesized.expiresAt ? { expiresAt: synthesized.expiresAt } : {}),
		lifetimeMinutes: synthesized.lifetimeMinutes,
		diagnostics: {
			...synthesized.diagnostics,
			attempt: context.attempt,
		},
	};
}

function resolvePolicy(options: ProxyResolutionOptions): ProviderProxyPolicy | undefined {
	if (options.proxyPolicy) {
		return options.proxyPolicy;
	}
	const upstreamProxy = options.upstream?.proxy;
	if (upstreamProxy && typeof upstreamProxy === "object") {
		return upstreamProxy;
	}
	return undefined;
}

function isRegistryVendor(name: string | undefined): name is ProxyVendorName {
	return name === "smartproxy" || name === "nodemaven";
}

function declaredVendorChain(policy: ProviderProxyPolicy): ProviderProxyProvider[] {
	const declared = policy.providers?.length
		? policy.providers
		: [policy.provider ?? envDefaultProvider()];
	return declared.filter((vendor): vendor is ProviderProxyProvider => vendor !== undefined);
}

/**
 * Ordered list of SDK-native proxy vendors declared by the policy. `providers`
 * takes precedence over the legacy singular `provider`; the platform default
 * env is the final fallback. Non-registry names (decodo/custom) are dropped so
 * an all-deprecated chain has no managed adapter.
 */
export function resolveVendorChain(policy: ProviderProxyPolicy): ProxyVendorName[] {
	const chain: ProxyVendorName[] = [];
	for (const name of declaredVendorChain(policy)) {
		if (isRegistryVendor(name) && !chain.includes(name)) {
			chain.push(name);
		}
	}
	return chain;
}

function envDefaultProvider(): ProviderProxyProvider | undefined {
	const raw = process.env[DEFAULT_PROXY_PROVIDER_ENV]?.trim().toLowerCase();
	return (raw as ProviderProxyProvider | undefined) ?? undefined;
}

const VENDOR_CREDENTIAL_ENV_NAMES: Readonly<Record<ProxyVendorName, readonly string[]>> = {
	smartproxy: [SMARTPROXY_USERNAME_ENV, SMARTPROXY_PASSWORD_ENV],
	nodemaven: [NODEMAVEN_USERNAME_ENV, NODEMAVEN_PASSWORD_ENV],
};

function vendorHasCredentials(
	vendor: ProxyVendorName,
	credentials?: Readonly<Record<string, string>>,
): boolean {
	return VENDOR_CREDENTIAL_ENV_NAMES[vendor].every((name) =>
		Boolean(readCredential(name, credentials)),
	);
}

/**
 * The credential names a vendor still lacks, so a required policy fails with
 * the exact secrets to provision. Smartproxy reads only the gateway sub-account
 * pair; the extraction `APIFUSE__PROXY__SMARTPROXY_APP_KEY` is not a substitute.
 */
function missingCredentialEnvNames(
	vendor: ProxyVendorName,
	credentials: Readonly<Record<string, string>> | undefined,
): readonly string[] {
	const names = VENDOR_CREDENTIAL_ENV_NAMES[vendor];
	const missing = names.filter((name) => !readCredential(name, credentials));
	return missing.length > 0 ? missing : names;
}

/**
 * Transport attempts a policy's vendor chain is entitled to when the caller did
 * not pin a retry policy: `chain.length × PROXY_ATTEMPTS_PER_VENDOR`. With one
 * vendor this is `PROXY_ATTEMPTS_PER_VENDOR`, each attempt on a new session.
 */
export function resolvePolicyProxyAttemptSpan(policy: ProviderProxyPolicy): number {
	return Math.max(1, resolveVendorChain(policy).length) * PROXY_ATTEMPTS_PER_VENDOR;
}

const UNSAFE_TRANSPORT_RETRY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE", "TRACE"]);

/**
 * True when a policy request is in *implicit chain-rotation* mode: successive
 * transport attempts take new vendor sessions and, past the primary vendor's
 * share of the attempt budget, move to the fallback vendor. This is the ONLY
 * mode in which the transport loop widens its attempt cap to the chain span.
 * It holds when ALL of the widening conditions hold:
 *  - the request is policy managed (not a caller-supplied proxy URL);
 *  - the caller did NOT pin an explicit retry policy — its `attempts` ceiling is
 *    the documented contract and must be honoured verbatim;
 *  - the method is safe/idempotent — an unsafe request is never duplicated;
 *  - the policy resolves a non-empty registry vendor chain (smartproxy /
 *    nodemaven). Deprecated vendors (custom / decodo) resolve no managed
 *    endpoint, so there is nothing to rotate.
 */
export function policyRotatesTransportVendorChain(input: {
	policy: ProviderProxyPolicy | undefined;
	usesPolicyProxy: boolean;
	explicitRetry: boolean;
	method: string;
}): boolean {
	if (!input.usesPolicyProxy || !input.policy || input.explicitRetry) {
		return false;
	}
	if (UNSAFE_TRANSPORT_RETRY_METHODS.has(input.method.toUpperCase())) {
		return false;
	}
	return resolveVendorChain(input.policy).length > 0;
}

/**
 * Transport-retry attempt cap for a policy-managed request. In implicit
 * chain-rotation mode the cap widens from the retry budget to the chain's
 * attempt span so the fallback vendor is reached; an explicit retry policy,
 * an unsafe method or a non-registry vendor keeps the retry budget. The
 * resulting cap is what the transport passes as `proxyAttemptCap`, so the
 * resolver splits exactly the attempts that will be made.
 */
export function resolvePolicyTransportAttemptCap(input: {
	policy: ProviderProxyPolicy | undefined;
	usesPolicyProxy: boolean;
	retryAttempts: number;
	explicitRetry: boolean;
	method: string;
}): number {
	const budget = Math.max(1, Math.floor(input.retryAttempts));
	if (
		!policyRotatesTransportVendorChain({
			policy: input.policy,
			usesPolicyProxy: input.usesPolicyProxy,
			explicitRetry: input.explicitRetry,
			method: input.method,
		})
	) {
		return budget;
	}
	return Math.max(budget, resolvePolicyProxyAttemptSpan(input.policy as ProviderProxyPolicy));
}

/**
 * A registry vendor chain (smartproxy/nodemaven) resolves a *different* vendor
 * session per attempt, so a transport retry should advance to the next attempt
 * and, past the primary vendor's share, to the next vendor. Deprecated
 * custom/decodo policies have an empty registry chain and no managed endpoint,
 * so the transport loop has nothing to rotate.
 */
export function policyResolvesRegistryVendorChain(
	policy: ProviderProxyPolicy | undefined,
): boolean {
	return Boolean(policy) && resolveVendorChain(policy as ProviderProxyPolicy).length > 0;
}

/** Map a resolved proxy source label to the vendor that served it. */
export function vendorFromResolvedSource(
	source: ResolvedProxyConfig["source"],
): ProxyVendorName | undefined {
	if (source === "nodemaven-gateway") return "nodemaven";
	if (source === "smartproxy-gateway") return "smartproxy";
	return undefined;
}

function normalizeAttemptIndex(attempt: number | undefined): number {
	return Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt as number)) : 0;
}

function normalizeAttemptCap(cap: number | undefined, chainLength: number): number {
	if (Number.isFinite(cap) && (cap as number) >= 1) return Math.floor(cap as number);
	return Math.max(1, chainLength) * PROXY_ATTEMPTS_PER_VENDOR;
}

function resolveProxyCountry(
	policy: ProviderProxyPolicy,
	ambientDefaults = true,
): string | undefined {
	return (
		policy.geo?.country ??
		(ambientDefaults
			? process.env[DEFAULT_PROXY_COUNTRY_ENV]?.trim().toUpperCase() || undefined
			: undefined)
	);
}

function resolveDefaultLifetimeMinutes(ambientDefaults: boolean): number {
	return ambientDefaults
		? readPositiveNumberEnv(DEFAULT_PROXY_LIFETIME_ENV, SMARTPROXY_DEFAULT_LIFETIME_MINUTES)
		: SMARTPROXY_DEFAULT_LIFETIME_MINUTES;
}

function readPositiveNumberEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive number`);
	}
	return parsed;
}

export function defineConfig(config: ApiFuseConfig): ApiFuseConfig {
	return config;
}

async function importConfig(filePath: string): Promise<ApiFuseConfig | null> {
	try {
		const moduleUrl = new URL(`file://${encodeURI(filePath)}`);
		const mod = (await import(moduleUrl.href)) as { default?: ApiFuseConfig };
		if (mod.default && typeof mod.default === "object") {
			return mod.default;
		}
		console.warn(`[provider-sdk] Ignoring invalid config export: ${filePath}`);
		return {};
	} catch (error) {
		console.warn(`[provider-sdk] Failed to load config ${filePath}:`, error);
		return null;
	}
}

export async function loadApiFuseConfig(dir: string = process.cwd()): Promise<ApiFuseConfig> {
	const tsPath = path.resolve(dir, "apifuse.config.ts");
	if (existsSync(tsPath)) {
		const config = await importConfig(tsPath);
		return config ?? {};
	}

	const jsPath = path.resolve(dir, "apifuse.config.js");
	if (existsSync(jsPath)) {
		const config = await importConfig(jsPath);
		return config ?? {};
	}

	return {};
}
