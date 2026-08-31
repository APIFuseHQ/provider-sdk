import { createRequire } from "node:module";

import type { BrowserProfile, EmulationOS } from "wreq-js";

import { SDKError } from "../errors.js";
import type { StealthPlatform, StealthProfile } from "../types.js";

type StealthProfileDefinition = Omit<StealthProfile, "name" | "platform"> & {
	platform: StealthPlatform;
};

type WreqProfileApi = Pick<typeof import("wreq-js"), "getEmulationHeaders" | "getProfiles">;

const requireModule = createRequire(import.meta.url);
let wreqProfileApi: WreqProfileApi | undefined;

function getWreqProfileApi(): WreqProfileApi {
	wreqProfileApi ??= requireModule("wreq-js") as WreqProfileApi;
	return wreqProfileApi;
}

const CHROMIUM_H2_SETTINGS = {
	HEADER_TABLE_SIZE: 65536,
	ENABLE_PUSH: 0,
	INITIAL_WINDOW_SIZE: 6291456,
	MAX_HEADER_LIST_SIZE: 262144,
};

const FIREFOX_H2_SETTINGS = {
	HEADER_TABLE_SIZE: 65536,
	INITIAL_WINDOW_SIZE: 131072,
	MAX_FRAME_SIZE: 16384,
	MAX_HEADER_LIST_SIZE: 65536,
};

const SAFARI_H2_SETTINGS = {
	// Safari 17 also sends a connection-level WINDOW_UPDATE increment of 10485760.
	ENABLE_PUSH: 0,
	INITIAL_WINDOW_SIZE: 4194304,
	MAX_CONCURRENT_STREAMS: 100,
};

const CHROMIUM_JA3 =
	"771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-65037,29-23-24,0";
const FIREFOX_JA3 =
	"771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-28-27-43-45-51,29-23-24-25,0";
const SAFARI_JA3 =
	"771,4865-4866-4867-49196-49195-52393-49200-49199-49188-49192-159-158-107-103-57-51-157-156-61-60-53-47-255,0-23-65281-10-11-16-5-13-18-51-45-43-27,29-23-24-25,0";

/** Resolve the newest Chromium build exposed by the exactly pinned wreq-js package. */
function resolveLatestChromiumProfile(): {
	readonly wreqName: BrowserProfile;
	readonly version: string;
} {
	const { getProfiles } = getWreqProfileApi();
	let newest: { name: BrowserProfile; version: number } | undefined;
	for (const name of getProfiles()) {
		const match = /^chrome_(\d+)$/.exec(name);
		if (!match) continue;
		const version = Number(match[1]);
		if (!newest || version > newest.version) newest = { name, version };
	}
	if (!newest) {
		throw new SDKError("wreq-js exposes no chrome_<version> emulation profile.", {
			code: "STEALTH_PROFILE_UNAVAILABLE",
		});
	}
	return { wreqName: newest.name, version: `${newest.version}.0.0.0` };
}

/** Read the identity wreq itself emits so the HTTP and transport layers cannot diverge. */
function chromiumUserAgent(
	latest: ReturnType<typeof resolveLatestChromiumProfile>,
	os: EmulationOS,
): string {
	for (const [name, value] of getWreqProfileApi().getEmulationHeaders(latest.wreqName, os)) {
		if (String(name).toLowerCase() === "user-agent") return String(value);
	}
	throw new SDKError(`wreq-js profile ${latest.wreqName} exposes no user-agent header.`, {
		code: "STEALTH_PROFILE_UNAVAILABLE",
	});
}

function createProfile(name: string, definition: StealthProfileDefinition): StealthProfile {
	return {
		name,
		platform: definition.platform,
		version: definition.version,
		userAgent: definition.userAgent,
		tlsClientIdentifier: definition.tlsClientIdentifier,
		ja3: definition.ja3,
		ja4: definition.ja4,
		h2Settings: definition.h2Settings ? { ...definition.h2Settings } : undefined,
	};
}

const PUBLIC_STEALTH_PROFILE_NAMES = [
	"chrome-desktop",
	"chrome-windows",
	"chrome-macos",
	"chrome-linux",
	"firefox-desktop",
	"safari-desktop",
	"safari-mobile",
	"generic-desktop",
	"generic-mobile",
] as const;

const PUBLIC_STEALTH_PROFILE_NAME_SET = new Set<string>(PUBLIC_STEALTH_PROFILE_NAMES);

type StealthProfileCatalog = Record<string, StealthProfile>;

let stealthProfileCatalog: StealthProfileCatalog | undefined;

function getStealthProfileCatalog(): StealthProfileCatalog {
	if (stealthProfileCatalog) return stealthProfileCatalog;

	const latest = resolveLatestChromiumProfile();
	const chromeProfile = (name: string, platform: "windows" | "macos" | "linux") =>
		createProfile(name, {
			platform,
			version: latest.version,
			userAgent: chromiumUserAgent(latest, platform),
			tlsClientIdentifier: latest.wreqName,
			ja3: CHROMIUM_JA3,
			h2Settings: CHROMIUM_H2_SETTINGS,
		});
	const chromeMacos = chromeProfile("chrome-macos", "macos");

	stealthProfileCatalog = {
		"chrome-desktop": createProfile("chrome-desktop", chromeMacos),
		"chrome-windows": chromeProfile("chrome-windows", "windows"),
		"chrome-macos": chromeMacos,
		"chrome-linux": chromeProfile("chrome-linux", "linux"),
		"firefox-desktop": createProfile("firefox-desktop", {
			platform: "macos",
			version: "147.0",
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0",
			tlsClientIdentifier: "firefox_147",
			ja3: FIREFOX_JA3,
			h2Settings: FIREFOX_H2_SETTINGS,
		}),
		"safari-desktop": createProfile("safari-desktop", {
			platform: "macos",
			version: "17.0",
			userAgent:
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
			tlsClientIdentifier: "safari_17_0",
			ja3: SAFARI_JA3,
			h2Settings: SAFARI_H2_SETTINGS,
		}),
		"safari-mobile": createProfile("safari-mobile", {
			platform: "ios",
			version: "26.0",
			userAgent:
				"Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
			tlsClientIdentifier: "safari_ios_26_0",
			ja3: SAFARI_JA3,
			h2Settings: SAFARI_H2_SETTINGS,
		}),
		"generic-desktop": createProfile("generic-desktop", chromeMacos),
		"generic-mobile": createProfile("generic-mobile", {
			platform: "ios",
			version: "26.0",
			userAgent:
				"Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
			tlsClientIdentifier: "safari_ios_26_0",
			ja3: SAFARI_JA3,
			h2Settings: SAFARI_H2_SETTINGS,
		}),
	};
	return stealthProfileCatalog;
}

export function getStealthProfile(name: string): StealthProfile {
	const intentAlias = getStealthProfileIntentAlias(name);
	if (intentAlias) {
		throw new SDKError(
			`Stealth profile "${name}" pins a browser version and is not supported. Use the intent profile "${intentAlias}".`,
			{ code: "STEALTH_VERSION_PIN_UNSUPPORTED" },
		);
	}

	const profile = getStealthProfileCatalog()[name];
	if (!profile) throw new SDKError(`Unknown stealth profile: ${name}`);

	return {
		...profile,
		h2Settings: profile.h2Settings ? { ...profile.h2Settings } : undefined,
	};
}

/** Returns the intent alias that replaces a version-pinned profile name. */
export function getStealthProfileIntentAlias(name: string): string | undefined {
	if (PUBLIC_STEALTH_PROFILE_NAME_SET.has(name)) return undefined;
	if (/^(?:chrome|chromium|edge)[-_]\d/i.test(name)) return "chrome-desktop";
	if (/^firefox[-_]\d/i.test(name)) return "firefox-desktop";
	if (/^(?:ios[-_]safari|safari[-_](?:ios|ipad))[-_]\d/i.test(name)) return "safari-mobile";
	if (/^safari[-_]\d/i.test(name)) return "safari-desktop";
	return undefined;
}

/** Internal compatibility catalog used by transport-parity tests. */
export function listRegisteredStealthProfiles(): string[] {
	return Object.keys(getStealthProfileCatalog());
}

export function listStealthProfiles(): string[] {
	return [...PUBLIC_STEALTH_PROFILE_NAMES];
}
