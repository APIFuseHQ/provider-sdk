import { createRequire } from "node:module";

import type { BrowserProfile, EmulationOS } from "wreq-js";

import { SDKError } from "../errors.js";
import type {
	StealthBrowser,
	StealthProfile,
	StealthProfileDescriptor,
	StealthProfileSelection,
	StealthOS,
} from "../types.js";

type StealthProfileDefinition = Omit<StealthProfile, "browser" | "os">;
type WreqProfileApi = Pick<typeof import("wreq-js"), "getEmulationHeaders" | "getProfiles">;

const requireModule = createRequire(import.meta.url);
let wreqProfileApi: WreqProfileApi | undefined;

function getWreqProfileApi(): WreqProfileApi {
	wreqProfileApi ??= requireModule("wreq-js") as WreqProfileApi;
	return wreqProfileApi;
}

export const DEFAULT_STEALTH_BROWSER = "chrome" as const;
export const DEFAULT_STEALTH_OS = "macos" as const;

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

const SUPPORTED_STEALTH_PROFILES: readonly StealthProfileDescriptor[] = [
	{ browser: "chrome", os: "windows" },
	{ browser: "chrome", os: "macos" },
	{ browser: "chrome", os: "linux" },
	{ browser: "firefox", os: "windows" },
	{ browser: "firefox", os: "macos" },
	{ browser: "firefox", os: "linux" },
	{ browser: "safari", os: "macos" },
	{ browser: "safari", os: "ios" },
];

const DESKTOP_OSES = new Set<StealthOS>(["windows", "macos", "linux"]);

function structuredReplacement(browser: StealthBrowser, os: StealthOS): string {
	return `stealth: { browser: "${browser}", os: "${os}" }`;
}

/** Internal detector used to keep version-pinned string failures actionable. */
export function getVersionPinnedStealthReplacement(name: string): string | undefined {
	if (/^(?:chrome|chromium|edge)[-_]\d/i.test(name)) {
		return structuredReplacement("chrome", DEFAULT_STEALTH_OS);
	}
	if (/^firefox[-_]\d/i.test(name)) {
		return structuredReplacement("firefox", DEFAULT_STEALTH_OS);
	}
	if (/^(?:ios[-_]safari|safari[-_](?:ios|ipad))[-_]\d/i.test(name)) {
		return structuredReplacement("safari", "ios");
	}
	if (/^safari[-_]\d/i.test(name)) {
		return structuredReplacement("safari", DEFAULT_STEALTH_OS);
	}
	return undefined;
}

function rejectStringSelection(name: string): never {
	const replacement = getVersionPinnedStealthReplacement(name);
	if (replacement) {
		throw new SDKError(
			`Stealth profile "${name}" pins a browser version and is not supported. Use ${replacement}.`,
			{ code: "STEALTH_VERSION_PIN_UNSUPPORTED" },
		);
	}
	throw new SDKError(
		`Stealth profile names are no longer supported: "${name}". Use structured browser/os options.`,
		{ code: "STEALTH_PROFILE_NAME_UNSUPPORTED" },
	);
}

function assertSupportedDescriptor(browser: StealthBrowser, os: StealthOS): void {
	const supported =
		(browser === "chrome" && DESKTOP_OSES.has(os)) ||
		(browser === "firefox" && DESKTOP_OSES.has(os)) ||
		(browser === "safari" && (os === "macos" || os === "ios"));
	if (!supported) {
		throw new SDKError(
			`Unsupported stealth browser/OS combination: ${browser}/${os}. ` +
				"Chrome and Firefox support windows, macos, and linux; Safari supports macos and ios.",
			{ code: "STEALTH_PROFILE_UNAVAILABLE" },
		);
	}
}

/** Resolve omitted axes and validate that the resulting pair is supported. */
export function resolveStealthProfileSelection(
	selection: StealthProfileSelection | undefined,
	base?: StealthProfileDescriptor,
): StealthProfileDescriptor {
	if (typeof selection === "string") rejectStringSelection(selection);
	if (selection !== undefined && (typeof selection !== "object" || selection === null)) {
		throw new SDKError("Stealth profile selection must use structured browser/os options.");
	}
	const unsafeSelection = selection as
		| (Record<string, unknown> & { browser?: unknown; os?: unknown })
		| undefined;
	if (unsafeSelection && "profile" in unsafeSelection) {
		if (typeof unsafeSelection.profile === "string") rejectStringSelection(unsafeSelection.profile);
		throw new SDKError(
			"stealth.profile is no longer supported. Use stealth.browser and stealth.os.",
			{ code: "STEALTH_PROFILE_NAME_UNSUPPORTED" },
		);
	}

	const browser = unsafeSelection?.browser ?? base?.browser ?? DEFAULT_STEALTH_BROWSER;
	if (browser !== "chrome" && browser !== "firefox" && browser !== "safari") {
		throw new SDKError(`Unsupported stealth browser: ${String(browser)}`);
	}
	const browserChanged =
		base !== undefined && unsafeSelection?.browser !== undefined && browser !== base.browser;
	const os =
		unsafeSelection?.os ?? (browserChanged ? DEFAULT_STEALTH_OS : base?.os) ?? DEFAULT_STEALTH_OS;
	if (os !== "windows" && os !== "macos" && os !== "linux" && os !== "ios") {
		throw new SDKError(`Unsupported stealth OS: ${String(os)}`);
	}
	assertSupportedDescriptor(browser, os);
	return { browser, os } as StealthProfileDescriptor;
}

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

/** Read the identity wreq itself emits so the accessor and transport cannot diverge. */
function emulationUserAgent(profile: BrowserProfile, os: EmulationOS): string {
	for (const [name, value] of getWreqProfileApi().getEmulationHeaders(profile, os)) {
		if (String(name).toLowerCase() === "user-agent") return String(value);
	}
	throw new SDKError(`wreq-js profile ${profile} exposes no user-agent header.`, {
		code: "STEALTH_PROFILE_UNAVAILABLE",
	});
}

function createProfile(
	descriptor: StealthProfileDescriptor,
	definition: StealthProfileDefinition,
): StealthProfile {
	return {
		...descriptor,
		...definition,
		h2Settings: definition.h2Settings ? { ...definition.h2Settings } : undefined,
	};
}

function profileKey(descriptor: StealthProfileDescriptor): string {
	return `${descriptor.browser}:${descriptor.os}`;
}

let stealthProfileCatalog: Map<string, StealthProfile> | undefined;

function getStealthProfileCatalog(): Map<string, StealthProfile> {
	if (stealthProfileCatalog) return stealthProfileCatalog;

	const latestChrome = resolveLatestChromiumProfile();
	const definitions: Record<StealthBrowser, Omit<StealthProfileDefinition, "userAgent">> = {
		chrome: {
			version: latestChrome.version,
			tlsClientIdentifier: latestChrome.wreqName,
			ja3: CHROMIUM_JA3,
			h2Settings: CHROMIUM_H2_SETTINGS,
		},
		firefox: {
			version: "147.0",
			tlsClientIdentifier: "firefox_147",
			ja3: FIREFOX_JA3,
			h2Settings: FIREFOX_H2_SETTINGS,
		},
		safari: {
			version: "17.0",
			tlsClientIdentifier: "safari_17.0",
			ja3: SAFARI_JA3,
			h2Settings: SAFARI_H2_SETTINGS,
		},
	};

	stealthProfileCatalog = new Map();
	for (const descriptor of SUPPORTED_STEALTH_PROFILES) {
		const isMobileSafari = descriptor.browser === "safari" && descriptor.os === "ios";
		const definition = isMobileSafari
			? {
					version: "26.0",
					tlsClientIdentifier: "safari_ios_26" as BrowserProfile,
					ja3: SAFARI_JA3,
					h2Settings: SAFARI_H2_SETTINGS,
				}
			: definitions[descriptor.browser];
		const wreqName = definition.tlsClientIdentifier as BrowserProfile;
		stealthProfileCatalog.set(
			profileKey(descriptor),
			createProfile(descriptor, {
				...definition,
				userAgent: emulationUserAgent(wreqName, descriptor.os),
			}),
		);
	}
	return stealthProfileCatalog;
}

export function getStealthProfile(selection: StealthProfileSelection = {}): StealthProfile {
	const descriptor = resolveStealthProfileSelection(selection);
	const profile = getStealthProfileCatalog().get(profileKey(descriptor));
	if (!profile) {
		throw new SDKError(`Unknown stealth profile: ${descriptor.browser}/${descriptor.os}`);
	}
	return {
		...profile,
		h2Settings: profile.h2Settings ? { ...profile.h2Settings } : undefined,
	};
}

export function listStealthProfiles(): StealthProfileDescriptor[] {
	return SUPPORTED_STEALTH_PROFILES.map((profile) => ({ ...profile }));
}
