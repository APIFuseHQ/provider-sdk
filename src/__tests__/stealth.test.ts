import { describe, expect, it } from "bun:test";

import { SDKError } from "../errors.js";
import { getStealthProfile, listStealthProfiles } from "../stealth/profiles.js";

describe("stealth profiles", () => {
	it("maps chrome-desktop to the current Chrome profile", () => {
		const profile = getStealthProfile("chrome-desktop");

		expect(profile.name).toBe("chrome-desktop");
		expect(profile.tlsClientIdentifier).toBe("chrome_149");
	});

	it("exposes explicit Chrome desktop operating-system intents", () => {
		expect(getStealthProfile("chrome-windows").platform).toBe("windows");
		expect(getStealthProfile("chrome-macos").platform).toBe("macos");
		expect(getStealthProfile("chrome-linux").platform).toBe("linux");
		expect(getStealthProfile("chrome-windows").userAgent).toContain("Windows NT");
		expect(getStealthProfile("chrome-linux").userAgent).toContain("X11; Linux");
	});

	it("maps browser-family intent aliases to the current registered profiles", () => {
		expect(getStealthProfile("firefox-desktop").tlsClientIdentifier).toBe("firefox_147");
		expect(getStealthProfile("safari-desktop").tlsClientIdentifier).toBe("safari_17_0");
		expect(getStealthProfile("safari-mobile").tlsClientIdentifier).toBe("safari_ios_26_0");
	});

	it("throws SDKError for unknown profiles", () => {
		expect(() => getStealthProfile("unknown-profile")).toThrow(SDKError);
		expect(() => getStealthProfile("unknown-profile")).toThrow(
			"Unknown stealth profile: unknown-profile",
		);
	});

	it("rejects every version-pinned browser profile with its intent replacement", () => {
		for (const profile of ["chrome-146", "firefox-147", "safari-17", "ios-safari-26"]) {
			expect(() => getStealthProfile(profile)).toThrow(SDKError);
		}
		expect(() => getStealthProfile("chrome-146")).toThrow(
			'Use the intent profile "chrome-desktop"',
		);
	});

	it("lists only intent-based profile names", () => {
		const profiles = listStealthProfiles();

		expect(profiles).toEqual([
			"chrome-desktop",
			"chrome-windows",
			"chrome-macos",
			"chrome-linux",
			"firefox-desktop",
			"safari-desktop",
			"safari-mobile",
			"generic-desktop",
			"generic-mobile",
		]);
		for (const versioned of [
			"chrome-149",
			"chrome-146",
			"firefox-147",
			"ios-safari-26",
			"safari-17",
		]) {
			expect(profiles).not.toContain(versioned);
		}
	});
});
