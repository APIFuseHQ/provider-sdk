import { describe, expect, it } from "bun:test";
import { getEmulationHeaders } from "wreq-js";

import { SDKError } from "../errors.js";
import {
	DEFAULT_STEALTH_BROWSER,
	DEFAULT_STEALTH_OS,
	getStealthProfile,
	listStealthProfiles,
} from "../stealth/profiles.js";

describe("stealth profiles", () => {
	it("resolves the named browser and OS defaults explicitly", () => {
		const profile = getStealthProfile();

		expect(profile.browser).toBe(DEFAULT_STEALTH_BROWSER);
		expect(profile.os).toBe(DEFAULT_STEALTH_OS);
	});

	it("reads every Chrome desktop OS identity from wreq", () => {
		for (const os of ["windows", "macos", "linux"] as const) {
			const profile = getStealthProfile({ browser: "chrome", os });
			const headers = new Map(
				getEmulationHeaders(
					profile.tlsClientIdentifier as Parameters<typeof getEmulationHeaders>[0],
					os,
				),
			);

			expect(profile.os).toBe(os);
			expect(profile.userAgent).toBe(headers.get("user-agent")!);
		}
	});

	it("models Firefox desktop OSes and Safari macOS/iOS as supported pairs", () => {
		expect(getStealthProfile({ browser: "firefox", os: "windows" }).os).toBe("windows");
		expect(getStealthProfile({ browser: "firefox", os: "linux" }).os).toBe("linux");
		expect(getStealthProfile({ browser: "safari", os: "macos" }).tlsClientIdentifier).toBe(
			"safari_17.0",
		);
		expect(getStealthProfile({ browser: "safari", os: "ios" }).tlsClientIdentifier).toBe(
			"safari_ios_26",
		);
		// test-invalid: runtime validation must reject unsupported structured pairs.
		expect(() => getStealthProfile({ browser: "safari", os: "windows" } as never)).toThrow(
			"Unsupported stealth browser/OS combination: safari/windows",
		);
	});

	it("rejects removed string profile names", () => {
		for (const name of [
			"chrome-desktop",
			"chrome-windows",
			"chrome-macos",
			"chrome-linux",
			"firefox-desktop",
			"safari-desktop",
			"safari-mobile",
			"generic-desktop",
			"generic-mobile",
		]) {
			// test-invalid: legacy JavaScript callers can still pass removed string names.
			expect(() => getStealthProfile(name as never)).toThrow(SDKError);
			// test-invalid: legacy JavaScript callers can still pass removed string names.
			expect(() => getStealthProfile(name as never)).toThrow(
				"Stealth profile names are no longer supported",
			);
		}
	});

	it("rejects version-pinned names with the structured replacement", () => {
		for (const name of ["chrome-146", "firefox-147", "safari-17", "ios-safari-26"]) {
			// test-invalid: version-pinned strings remain a guarded JavaScript input.
			expect(() => getStealthProfile(name as never)).toThrow(SDKError);
		}
		// test-invalid: version-pinned strings remain a guarded JavaScript input.
		expect(() => getStealthProfile("chrome-146" as never)).toThrow(
			'stealth: { browser: "chrome", os: "macos" }',
		);
	});

	it("lists structured supported descriptors", () => {
		expect(listStealthProfiles()).toEqual([
			{ browser: "chrome", os: "windows" },
			{ browser: "chrome", os: "macos" },
			{ browser: "chrome", os: "linux" },
			{ browser: "firefox", os: "windows" },
			{ browser: "firefox", os: "macos" },
			{ browser: "firefox", os: "linux" },
			{ browser: "safari", os: "macos" },
			{ browser: "safari", os: "ios" },
		]);
	});
});
