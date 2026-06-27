import { SDKError } from "../errors";
import type { StealthPlatform, StealthProfile } from "../types";

type StealthProfileDefinition = Omit<StealthProfile, "name" | "platform"> & {
	platform: StealthPlatform;
};

const CHROMIUM_HEADER_ORDER = [
	":method",
	":authority",
	":scheme",
	":path",
	"user-agent",
	"accept",
	"accept-encoding",
	"accept-language",
	"cache-control",
	"pragma",
	"cookie",
	"sec-ch-ua",
	"sec-ch-ua-mobile",
	"sec-ch-ua-platform",
];

const FIREFOX_HEADER_ORDER = [
	":method",
	":path",
	":authority",
	":scheme",
	"user-agent",
	"accept",
	"accept-language",
	"accept-encoding",
	"referer",
	"cookie",
	"upgrade-insecure-requests",
	"sec-fetch-dest",
	"sec-fetch-mode",
	"sec-fetch-site",
	"sec-fetch-user",
];

const SAFARI_HEADER_ORDER = [
	":method",
	":scheme",
	":path",
	":authority",
	"accept",
	"user-agent",
	"accept-language",
	"accept-encoding",
	"cookie",
	"upgrade-insecure-requests",
];

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
	HEADER_TABLE_SIZE: 4096,
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

function createProfile(
	name: string,
	definition: StealthProfileDefinition,
): StealthProfile {
	return {
		name,
		platform: definition.platform,
		version: definition.version,
		userAgent: definition.userAgent,
		tlsClientIdentifier: definition.tlsClientIdentifier,
		ja3: definition.ja3,
		ja4: definition.ja4,
		h2Settings: definition.h2Settings
			? { ...definition.h2Settings }
			: undefined,
		headerOrder: definition.headerOrder
			? [...definition.headerOrder]
			: undefined,
	};
}

function extractBrowserMajorVersion(profile: StealthProfile): string {
	const chromeVersion = profile.userAgent.match(/Chrome\/(\d+)/)?.[1];
	if (chromeVersion) {
		return chromeVersion;
	}

	const identifierVersion =
		profile.tlsClientIdentifier?.match(/(\d+)(?!.*\d)/)?.[1];
	if (identifierVersion) {
		return identifierVersion;
	}

	return profile.version.split(".")[0] ?? profile.version;
}

function toPlatformHeaderValue(platform: StealthPlatform): string {
	switch (platform) {
		case "macos":
			return '"macOS"';
		case "windows":
			return '"Windows"';
		case "linux":
			return '"Linux"';
		case "android":
			return '"Android"';
		case "ios":
			return '"iOS"';
	}
}

export function generateLayer2Headers(
	profile: StealthProfile,
): Record<string, string> {
	const headers: Record<string, string> = {
		"Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
	};

	const identifier = profile.tlsClientIdentifier?.toLowerCase() ?? "";
	const majorVersion = extractBrowserMajorVersion(profile);

	if (identifier.startsWith("chrome_") || identifier.startsWith("edge_")) {
		const isEdge =
			identifier.startsWith("edge_") || /\bEdg\//.test(profile.userAgent);
		headers["Sec-Ch-Ua"] = isEdge
			? `"Chromium";v="${majorVersion}", "Microsoft Edge";v="${majorVersion}", "Not)A;Brand";v="99"`
			: `"Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}", "Not)A;Brand";v="99"`;
		headers["Sec-Ch-Ua-Platform"] = toPlatformHeaderValue(profile.platform);
		headers["Sec-Ch-Ua-Mobile"] =
			profile.platform === "android" || profile.platform === "ios"
				? "?1"
				: "?0";
	}

	return headers;
}

const STEALTH_PROFILE_ALIASES: Record<string, string> = {
	"chrome-desktop": "chrome-146",
};

const STEALTH_PROFILES: Record<string, StealthProfile> = {
	"chrome-146": createProfile("chrome-146", {
		platform: "macos",
		version: "146.0.0.0",
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
		tlsClientIdentifier: "chrome_146",
		ja3: CHROMIUM_JA3,
		h2Settings: CHROMIUM_H2_SETTINGS,
		headerOrder: CHROMIUM_HEADER_ORDER,
	}),
	"firefox-147": createProfile("firefox-147", {
		platform: "macos",
		version: "147.0",
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0",
		tlsClientIdentifier: "firefox_147",
		ja3: FIREFOX_JA3,
		h2Settings: FIREFOX_H2_SETTINGS,
		headerOrder: FIREFOX_HEADER_ORDER,
	}),
	"firefox-135": createProfile("firefox-135", {
		platform: "macos",
		version: "135.0",
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0",
		tlsClientIdentifier: "firefox_135",
		ja3: FIREFOX_JA3,
		h2Settings: FIREFOX_H2_SETTINGS,
		headerOrder: FIREFOX_HEADER_ORDER,
	}),
	"firefox-133": createProfile("firefox-133", {
		platform: "macos",
		version: "133.0",
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
		tlsClientIdentifier: "firefox_133",
		ja3: FIREFOX_JA3,
		h2Settings: FIREFOX_H2_SETTINGS,
		headerOrder: FIREFOX_HEADER_ORDER,
	}),
	"firefox-132": createProfile("firefox-132", {
		platform: "macos",
		version: "132.0",
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
		tlsClientIdentifier: "firefox_132",
		ja3: FIREFOX_JA3,
		h2Settings: FIREFOX_H2_SETTINGS,
		headerOrder: FIREFOX_HEADER_ORDER,
	}),
	"safari-16": createProfile("safari-16", {
		platform: "macos",
		version: "16.0",
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15",
		tlsClientIdentifier: "safari_16_0",
		ja3: SAFARI_JA3,
		h2Settings: SAFARI_H2_SETTINGS,
		headerOrder: SAFARI_HEADER_ORDER,
	}),
	"safari-15": createProfile("safari-15", {
		platform: "macos",
		version: "15.6.1",
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.1 Safari/605.1.15",
		tlsClientIdentifier: "safari_15_6_1",
		ja3: SAFARI_JA3,
		h2Settings: SAFARI_H2_SETTINGS,
		headerOrder: SAFARI_HEADER_ORDER,
	}),
	"ios-safari-26": createProfile("ios-safari-26", {
		platform: "ios",
		version: "26.0",
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
		tlsClientIdentifier: "safari_ios_26_0",
		ja3: SAFARI_JA3,
		h2Settings: SAFARI_H2_SETTINGS,
		headerOrder: SAFARI_HEADER_ORDER,
	}),
	"ios-safari-18": createProfile("ios-safari-18", {
		platform: "ios",
		version: "18.0",
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
		tlsClientIdentifier: "safari_ios_18_0",
		ja3: SAFARI_JA3,
		h2Settings: SAFARI_H2_SETTINGS,
		headerOrder: SAFARI_HEADER_ORDER,
	}),
	"ios-safari-17": createProfile("ios-safari-17", {
		platform: "ios",
		version: "17.0",
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
		tlsClientIdentifier: "safari_ios_17_0",
		ja3: SAFARI_JA3,
		h2Settings: SAFARI_H2_SETTINGS,
		headerOrder: SAFARI_HEADER_ORDER,
	}),
	"generic-desktop": createProfile("generic-desktop", {
		platform: "macos",
		version: "146.0.0.0",
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
		tlsClientIdentifier: "chrome_146",
		ja3: CHROMIUM_JA3,
		h2Settings: CHROMIUM_H2_SETTINGS,
		headerOrder: CHROMIUM_HEADER_ORDER,
	}),
	"generic-mobile": createProfile("generic-mobile", {
		platform: "ios",
		version: "26.0",
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
		tlsClientIdentifier: "safari_ios_26_0",
		ja3: SAFARI_JA3,
		h2Settings: SAFARI_H2_SETTINGS,
		headerOrder: SAFARI_HEADER_ORDER,
	}),
};

export function getStealthProfile(name: string): StealthProfile {
	const canonicalName = STEALTH_PROFILE_ALIASES[name] ?? name;
	const profile = STEALTH_PROFILES[canonicalName];

	if (!profile) {
		throw new SDKError(`Unknown stealth profile: ${name}`);
	}

	return {
		...profile,
		h2Settings: profile.h2Settings ? { ...profile.h2Settings } : undefined,
		headerOrder: profile.headerOrder ? [...profile.headerOrder] : undefined,
	};
}

export function listStealthProfiles(): string[] {
	return [
		...Object.keys(STEALTH_PROFILES),
		...Object.keys(STEALTH_PROFILE_ALIASES),
	];
}
