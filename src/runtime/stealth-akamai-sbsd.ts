import type { ChallengeSolution, ProviderChallenge, StealthResponse } from "../types.js";
import { normalizedResolverHostname } from "./resolver-vendors/hosts.js";
import type { ResolverVendorTransport } from "./resolver-vendors/types.js";
import type { StealthCookieJar } from "./stealth-cookies.js";

export type AkamaiSbsdChallenge = Extract<ProviderChallenge, { readonly kind: "akamai_sbsd" }>;

/**
 * SDK-owned response detection and solve wiring derived from the provider declaration.
 * The server attaches it to the stealth client options it builds; it is deliberately not
 * part of the public `StealthClientOptions` type.
 */
export type StealthChallengeRuntime = {
	readonly akamaiSbsd?: {
		readonly allowedHosts: readonly string[];
		/** Resolver-declared client profile; must name the initiating session's browser family. */
		readonly clientProfile?: string;
		readonly solve?: (
			challenge: AkamaiSbsdChallenge,
			transport: ResolverVendorTransport,
			signal: AbortSignal,
		) => Promise<ChallengeSolution>;
	};
};

export type AkamaiSbsdSessionState = {
	/**
	 * Latest v-only script for this session; Phase 2 deliberately has no wall-clock TTL.
	 * Challenge-state expiry belongs to the Phase 3 ceremony/solve lease handle
	 * (ADR-0010 v1.1), not to the stealth session.
	 */
	rememberedScript?: URL;
	/** In-flight solves keyed by akamaiSbsdChallengeKey; an entry leaves only when it settles. */
	readonly transactions: Map<
		string,
		{
			readonly result: Promise<
				{ readonly solved: true } | { readonly solved: false; error: unknown }
			>;
		}
	>;
};

/**
 * Live SBSD `<script src>` paths are per-site obfuscated (zozo.jp captures, 2026-08-28:
 * `/EdTyEb8Lyxqf/9iGcpl/GmKux0/DXObrkm53w/B1p4AQ/ZCF5f/VoJN08X?v=<uuid>` on the
 * `Access Denied` shape, `/SHO9K/...?v=<uuid>&t=<token>` on the behavioral-tile hard shape).
 * `/.well-known/sbsd` is only the POST endpoint string inside the deobfuscated
 * script, never the page's script path. The stable shape is a same-origin script whose `v`
 * is a UUID; cache-busted bundles (`?v=abc123`, hashes, semver) never match it.
 */
const SBSD_SCRIPT_VERSION = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const SBSD_INTERSTITIAL_MAX_BYTES = 4_000;
const SBSD_SCRIPT_DISCOVERY_MAX_BYTES = 4 * 1_024 * 1_024;
const SBSD_CHALLENGE_TOKEN_MAX_BYTES = 1_024;
const SBSD_INTERSTITIAL_MARKER =
	/sec-bc-tile-container|Access Denied|Reference #\d|Pardon Our Interruption|cpr_chlge/iu;

function htmlAttribute(value: string): string {
	return value.replace(/&amp;/giu, "&");
}

function isDeclaredHost(url: URL, allowedHosts: readonly string[]): boolean {
	const hostname = normalizedResolverHostname(url.hostname);
	return allowedHosts.some((host) => normalizedResolverHostname(host) === hostname);
}

export function findAkamaiSbsdScript(body: string, page: URL): URL | undefined {
	// Only markup carries the script tag; JSON and binary bodies skip the scan entirely.
	if (!/^\s*</u.test(body) || Buffer.byteLength(body) > SBSD_SCRIPT_DISCOVERY_MAX_BYTES) {
		return undefined;
	}
	let passiveScript: URL | undefined;
	for (const match of body.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)) {
		let script: URL;
		try {
			// Relative sources resolve against the page URL, as the browser would.
			script = new URL(htmlAttribute(match[1]!), page);
		} catch {
			continue;
		}
		const version = script.searchParams.get("v")?.trim();
		if (script.origin !== page.origin || !version || !SBSD_SCRIPT_VERSION.test(version)) {
			continue;
		}
		if (script.searchParams.get("t")?.trim()) return script;
		passiveScript ??= script;
	}
	return passiveScript;
}

function isAkamaiSbsdInterstitial(body: string): boolean {
	return (
		Buffer.byteLength(body) < SBSD_INTERSTITIAL_MAX_BYTES && SBSD_INTERSTITIAL_MARKER.test(body)
	);
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

export function detectAkamaiSbsdChallenge(
	response: Pick<StealthResponse, "url" | "body">,
	pageUrl: string,
	jar: Pick<StealthCookieJar, "has">,
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
	const stateCookieName = jar.has("sbsd_o", page.toString())
		? "sbsd_o"
		: jar.has("bm_so", page.toString())
			? "bm_so"
			: undefined;
	const interstitial = isAkamaiSbsdInterstitial(response.body);
	// Without the state cookie (the jar already holds the Set-Cookie of this very response;
	// the live capture sets bm_so on the page that carries the script) or an interstitial,
	// nothing here is Akamai's: do not scan, and do not let an unrelated UUID-versioned
	// bundle become the remembered script.
	if (!stateCookieName && !interstitial) return undefined;
	const currentScript = findAkamaiSbsdScript(response.body, page);
	if (currentScript) {
		const version = currentScript.searchParams.get("v")?.trim();
		if (version) {
			// Clone rather than re-parse the pathname: a `//x` path would re-parse as a host.
			const rememberedScript = new URL(currentScript);
			rememberedScript.search = "";
			rememberedScript.hash = "";
			rememberedScript.searchParams.set("v", version);
			state.rememberedScript = rememberedScript;
		}
	}
	if (!stateCookieName) return undefined;

	const laterToken = parseAkamaiSbsdChallengeToken(response.body);
	const rememberedScript = state.rememberedScript;
	if (laterToken && rememberedScript && rememberedScript.origin === page.origin) {
		return {
			kind: "akamai_sbsd",
			pageUrl: page.toString(),
			scriptUrl: rememberedScript.toString(),
			stateCookieName,
			challengeToken: laterToken,
		};
	}
	if (!currentScript || !interstitial) return undefined;
	return {
		kind: "akamai_sbsd",
		pageUrl: page.toString(),
		scriptUrl: currentScript.toString(),
		stateCookieName,
	};
}

/**
 * One in-flight solve per session, challenge, and bound identity: requests on one session
 * may still pick a different wreq browser/OS or proxy, and a solve is only valid for the
 * identity that ran it.
 */
export function akamaiSbsdChallengeKey(
	challenge: AkamaiSbsdChallenge,
	identity: {
		readonly wreqBrowser: string;
		readonly wreqOs: string;
		readonly proxyUrl: string | undefined;
	},
): string {
	return JSON.stringify([
		new URL(challenge.scriptUrl).toString(),
		challenge.challengeToken ?? "",
		challenge.stateCookieName,
		identity.wreqBrowser,
		identity.wreqOs,
		identity.proxyUrl ?? "",
	]);
}
