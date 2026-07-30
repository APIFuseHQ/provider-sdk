import { describe, expect, it } from "bun:test";

import {
	requestPathForFixture,
	sanitizeDiagnosticText,
	sanitizeFixture,
	sanitizeUrlForLogs,
} from "../fixture-sanitization.js";

describe("fixture sanitization", () => {
	it("redacts credential keys beyond authorization and API tokens", () => {
		expect(
			sanitizeFixture({
				password: "secret-password",
				cookie: "session=secret",
				client_secret: "secret-client-value",
				public: "retained",
			}),
		).toEqual({
			password: "[REDACTED]",
			cookie: "[REDACTED]",
			client_secret: "[REDACTED]",
			public: "retained",
		});
	});

	it("removes path-embedded credentials from provenance and diagnostics", () => {
		const token = "bot123456789:AAE9c8QvL1nX7wZ2rP6sT4uY5iO0aB3c";
		const url = `https://user:password@example.test/${token}/download?access_token=live`;
		expect(requestPathForFixture(url)).toBe("/[REDACTED]/download");
		expect(sanitizeUrlForLogs(url)).toBe("https://example.test/[REDACTED]/download?[REDACTED]");
		expect(sanitizeDiagnosticText(`request failed at ${url}`)).not.toContain(token);
	});

	it("redacts values following a credential-like path key", () => {
		expect(requestPathForFixture("/password/short-secret/download?ignored=yes")).toBe(
			"/[REDACTED]/[REDACTED]/download",
		);
	});
});
