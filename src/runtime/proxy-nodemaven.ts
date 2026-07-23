import { createHash, randomBytes } from "node:crypto";

import type { ProviderProxyPolicy } from "../types.js";

export const NODEMAVEN_USERNAME_ENV = "APIFUSE__PROXY__NODEMAVEN_USERNAME";
export const NODEMAVEN_PASSWORD_ENV = "APIFUSE__PROXY__NODEMAVEN_PASSWORD";
export const NODEMAVEN_FILTER_ENV = "APIFUSE__PROXY__NODEMAVEN_FILTER";

export const NODEMAVEN_GATEWAY_HOST = "gate.nodemaven.com";

/** Both schemes tunnel bytes end-to-end, preserving the client TLS handshake. */
export type ProxyProtocol = "http" | "socks5";

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
const DEFAULT_NODEMAVEN_POOL_SIZE = 20;
export const NODEMAVEN_MAX_POOL_SIZE = 50;
/** NodeMaven sticky sessions persist up to 24h server-side, keyed by the sid. */
const NODEMAVEN_MAX_LIFETIME_MINUTES = 1440;
const SID_LENGTH = 10;

export function hasNodemavenCredentials(): boolean {
	return Boolean(readNodemavenUsername() && readNodemavenPassword());
}

function readNodemavenUsername(): string | undefined {
	return process.env[NODEMAVEN_USERNAME_ENV]?.trim() || undefined;
}

function readNodemavenPassword(): string | undefined {
	return process.env[NODEMAVEN_PASSWORD_ENV]?.trim() || undefined;
}

function resolveNodemavenFilter(): string {
	const raw = process.env[NODEMAVEN_FILTER_ENV]?.trim().toLowerCase();
	if (!raw) return DEFAULT_NODEMAVEN_FILTER;
	if (!NODEMAVEN_FILTERS.has(raw)) {
		throw new Error(`${NODEMAVEN_FILTER_ENV} must be "medium" or "high"`);
	}
	return raw;
}

export function nodemavenPoolSize(policy: ProviderProxyPolicy): number {
	return Math.min(
		NODEMAVEN_MAX_POOL_SIZE,
		Math.max(1, Math.floor(policy.session?.poolSize ?? DEFAULT_NODEMAVEN_POOL_SIZE)),
	);
}

function nodemavenLifetimeMinutes(policy: ProviderProxyPolicy): number {
	const configured = policy.session?.lifetimeMinutes;
	if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) {
		return NODEMAVEN_MAX_LIFETIME_MINUTES;
	}
	return Math.min(NODEMAVEN_MAX_LIFETIME_MINUTES, Math.max(1, Math.floor(configured)));
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

function isStickyAffinity(policy: ProviderProxyPolicy): boolean {
	return (policy.session?.affinity ?? "request") !== "request";
}

/**
 * A sticky sid is deterministic from the affinity key so every process serving
 * the same connection derives the same egress IP without shared storage. A
 * rotating sid is random per call (a fresh egress IP per request).
 */
function deriveSid(
	policy: ProviderProxyPolicy,
	affinityKey: string | undefined,
	poolIndex: number,
	refreshEpoch: number,
): string {
	if (!isStickyAffinity(policy) || !affinityKey) {
		return randomBytes(SID_LENGTH).toString("hex").slice(0, SID_LENGTH);
	}
	const digest = createHash("sha256")
		.update(`${affinityKey}:${refreshEpoch}:${poolIndex}`)
		.digest("hex");
	// hex digits are a subset of the allowed [a-z0-9] sid charset.
	return digest.slice(0, SID_LENGTH);
}

function selectPort(protocol: ProxyProtocol, sid: string, poolIndex: number): number {
	const { min, max } = NODEMAVEN_PORTS[protocol];
	const span = max - min + 1;
	const hashInt = Number.parseInt(
		createHash("sha256").update(`${sid}:${poolIndex}`).digest("hex").slice(0, 8),
		16,
	);
	return min + (hashInt % span);
}

export type NodemavenSynthesisInput = {
	policy: ProviderProxyPolicy;
	affinityKey: string | undefined;
	protocol: ProxyProtocol;
	poolIndex: number;
	refreshEpoch: number;
	/** ISO 3166-1 alpha-2, already resolved by the caller (falls back to env). */
	country?: string;
};

export type NodemavenSynthesis = {
	url: string;
	protocol: ProxyProtocol;
	diagnostics: Record<string, string | number | boolean>;
};

/**
 * Synthesize a NodeMaven gateway proxy URL locally from static credentials.
 * There is no allocation API — geo/session are encoded in the username.
 */
export function synthesizeNodemavenProxy(input: NodemavenSynthesisInput): NodemavenSynthesis {
	const username = readNodemavenUsername();
	const password = readNodemavenPassword();
	if (!username || !password) {
		throw new Error(
			`NodeMaven credentials missing: set ${NODEMAVEN_USERNAME_ENV} and ${NODEMAVEN_PASSWORD_ENV}.`,
		);
	}

	const filter = resolveNodemavenFilter();
	const sid = deriveSid(input.policy, input.affinityKey, input.poolIndex, input.refreshEpoch);
	const port = selectPort(input.protocol, sid, input.poolIndex);
	const lifetimeMinutes = nodemavenLifetimeMinutes(input.policy);

	const country = slugifyGeo(input.country ?? input.policy.geo?.country);
	const region = slugifyGeo(input.policy.geo?.subdivision);
	const city = slugifyGeo(input.policy.geo?.city);

	const tokens = [username];
	if (country) tokens.push("country", country);
	if (region) tokens.push("region", region);
	if (city) tokens.push("city", city);
	tokens.push("sid", sid);
	tokens.push("filter", filter);
	tokens.push("ipv4", "true");
	const proxyUsername = tokens.join("-");

	// Username tokens are [a-z0-9-] only, which survive URL encoding unchanged.
	const url = `${input.protocol}://${proxyUsername}:${encodeURIComponent(password)}@${NODEMAVEN_GATEWAY_HOST}:${port}`;

	return {
		url,
		protocol: input.protocol,
		diagnostics: {
			vendor: "nodemaven",
			protocol: input.protocol,
			sticky: isStickyAffinity(input.policy),
			filter,
			lifetimeMinutes,
			...(country ? { country } : {}),
		},
	};
}
