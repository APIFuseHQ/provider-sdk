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

	it("leaves values outside the settled token grammar unchanged", () => {
		const input = ["+0d", "+366d", "+45days", "+45d:YYYY-MM-DD", "2026-08-01"];

		expect(resolveHealthCheckInputDateTokens(input, new Date("2026-07-29T16:00:00Z"))).toBe(input);
	});
});
