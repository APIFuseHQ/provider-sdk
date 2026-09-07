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
	transaction?: {
		readonly key: string;
		readonly result: Promise<
			{ readonly solved: true } | { readonly solved: false; error: unknown }
		>;
	};
};

/** Akamai serves the SBSD script from this fixed path; cache-busted bundles never match it. */
const SBSD_SCRIPT_PATH = "/.well-known/sbsd";
const SBSD_INTERSTITIAL_MAX_BYTES = 4_000;
const SBSD_SCRIPT_DISCOVERY_MAX_BYTES = 4 * 1_024 * 1_024;
const SBSD_CHALLENGE_TOKEN_MAX_BYTES = 1_024;

function htmlAttribute(value: string): string {
	return value.replace(/&amp;/giu, "&");
}

function isDeclaredHost(url: URL, allowedHosts: readonly string[]): boolean {
	const hostname = normalizedResolverHostname(url.hostname);
	return allowedHosts.some((host) => normalizedResolverHostname(host) === hostname);
}

export function findAkamaiSbsdScript(body: string, page: URL): URL | undefined {
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
			script.pathname !== SBSD_SCRIPT_PATH ||
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
	const currentScript = findAkamaiSbsdScript(response.body, page);
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
	if (laterToken && rememberedScript && rememberedScript.origin === page.origin) {
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

/** One in-flight solve per session and challenge; the wreq profile is part of the identity. */
export function akamaiSbsdChallengeKey(
	challenge: AkamaiSbsdChallenge,
	wreqBrowser: string,
): string {
	return JSON.stringify([
		new URL(challenge.scriptUrl).toString(),
		challenge.challengeToken ?? "",
		challenge.stateCookieName,
		wreqBrowser,
	]);
}
