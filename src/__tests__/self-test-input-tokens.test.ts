import { describe, expect, it } from "bun:test";

import { resolveHealthCheckInputDateTokens } from "../server/self-test-input-tokens.js";

describe("resolveHealthCheckInputDateTokens", () => {
	it("uses KST by default and supports an explicit UTC calendar", () => {
		const now = new Date("2026-07-29T16:00:00.000Z");
		const input = { departure: "+45d", nested: ["+1d:YYYYMMDD"] };

		expect(resolveHealthCheckInputDateTokens(input, now)).toEqual({
			departure: "2026-09-13",
			nested: ["20260731"],
		});
		expect(resolveHealthCheckInputDateTokens(input, now, "UTC")).toEqual({
			departure: "2026-09-12",
			nested: ["20260730"],
		});
	});

	it("resolves backward and same-day tokens for a window that ends today", () => {
		// 2026-07-30 01:00 KST, 2026-07-29 16:00 UTC.
		const now = new Date("2026-07-29T16:00:00.000Z");
		const input = {
			start_date: "-30d",
			end_date: "+0d",
			from: "-182d:YYYYMMDD",
			bounds: ["-365d", "+365d"],
		};

		expect(resolveHealthCheckInputDateTokens(input, now)).toEqual({
			start_date: "2026-06-30",
			end_date: "2026-07-30",
			from: "20260129",
			bounds: ["2025-07-30", "2027-07-30"],
		});
		expect(resolveHealthCheckInputDateTokens(input, now, "UTC")).toEqual({
			start_date: "2026-06-29",
			end_date: "2026-07-29",
			from: "20260128",
			bounds: ["2025-07-29", "2027-07-29"],
		});
	});

	it("reaches back across month ends, leap days, and year boundaries", () => {
		expect(resolveHealthCheckInputDateTokens("-1d", new Date("2024-03-01T03:00:00.000Z"))).toBe(
			"2024-02-29",
		);
		expect(resolveHealthCheckInputDateTokens("-1d", new Date("2026-03-01T03:00:00.000Z"))).toBe(
			"2026-02-28",
		);
		expect(resolveHealthCheckInputDateTokens("-30d", new Date("2026-01-15T00:00:00.000Z"))).toBe(
			"2025-12-16",
		);
	});

	it("leaves values outside the settled token grammar unchanged", () => {
		const input = ["30d", "-366d", "+366d", "+45days", "-30days", "+45d:YYYY-MM-DD", "2026-08-01"];

		expect(resolveHealthCheckInputDateTokens(input, new Date("2026-07-29T16:00:00Z"))).toBe(input);
	});
});
