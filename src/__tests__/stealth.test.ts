import { describe, expect, it } from "bun:test";

import { SDKError } from "../errors.js";
import { getStealthProfile, listStealthProfiles } from "../stealth/profiles.js";

describe("stealth profiles", () => {
	it("returns the chrome-146 profile without unverified ja4", () => {
		const profile = getStealthProfile("chrome-146");

		expect(profile.platform).toBe("macos");
		expect(profile.tlsClientIdentifier).toBe("chrome_146");
		expect(profile.ja4).toBeUndefined();
	});

	it("maps chrome-desktop to the canonical chrome-146 profile", () => {
		const profile = getStealthProfile("chrome-desktop");

		expect(profile.name).toBe("chrome-146");
		expect(profile.tlsClientIdentifier).toBe("chrome_146");
	});

	it("returns the firefox-147 profile", () => {
		const profile = getStealthProfile("firefox-147");

		expect(profile.platform).toBe("macos");
		expect(profile.tlsClientIdentifier).toBe("firefox_147");
	});

	it("returns the ios-safari-26 profile", () => {
		const profile = getStealthProfile("ios-safari-26");

		expect(profile.platform).toBe("ios");
		expect(profile.tlsClientIdentifier).toBe("safari_ios_26_0");
	});

	it("throws SDKError for unknown profiles", () => {
		expect(() => getStealthProfile("unknown-profile")).toThrow(SDKError);
		expect(() => getStealthProfile("unknown-profile")).toThrow(
			"Unknown stealth profile: unknown-profile",
		);
	});

	it("throws SDKError for removed Chrome and Edge profiles", () => {
		for (const profile of ["chrome-129", "chrome-130", "chrome-131", "edge-131"]) {
			expect(() => getStealthProfile(profile)).toThrow(SDKError);
		}
		expect(() => getStealthProfile("chrome-131")).toThrow("Unknown stealth profile: chrome-131");
	});

	it("lists the canonical Chrome profile, alias, and non-Chrome profiles", () => {
		const profiles = listStealthProfiles();

		expect(profiles).toEqual(
			expect.arrayContaining(["chrome-146", "chrome-desktop", "firefox-147", "ios-safari-26"]),
		);
		expect(profiles).not.toContain("chrome-129");
		expect(profiles).not.toContain("chrome-130");
		expect(profiles).not.toContain("chrome-131");
		expect(profiles).not.toContain("edge-131");
	});
});
