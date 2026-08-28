import { describe, expect, it } from "bun:test";

import {
	requestPathForFixture,
	sanitizeDiagnosticText,
	sanitizeFixture,
	sanitizeOrdinaryFixture,
	sanitizeUrlForLogs,
} from "../fixture-sanitization.js";

function diagnosticUrls(value: string): string[] {
	return value.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
}

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

	it("uses the shared key policy for ordinary JSON without primitive heuristics", () => {
		expect(
			sanitizeOrdinaryFixture({
				password: "hunter2",
				client_secret: "short-client-secret",
				client_secret_value: "ordinary-value",
				cookie: "session=ordinary-value",
				public_id: "0123456789abcdef0123456789abcdef",
				next: "https://example.test/items?page=2",
			}),
		).toEqual({
			password: "[REDACTED]",
			client_secret: "[REDACTED]",
			client_secret_value: "[REDACTED]",
			cookie: "[REDACTED]",
			public_id: "0123456789abcdef0123456789abcdef",
			next: "https://example.test/items?page=2",
		});
	});

	it("removes path-embedded credentials from provenance and diagnostics", () => {
		const token = "bot123456789:AAE9c8QvL1nX7wZ2rP6sT4uY5iO0aB3c";
		const url = `https://user:password@example.test/${token}/download?access_token=live`;
		expect(requestPathForFixture(url)).toBe("/[REDACTED]/download");
		expect(sanitizeUrlForLogs(url)).toBe("https://example.test/[REDACTED]/download?[REDACTED]");
		expect(sanitizeDiagnosticText(`request failed at ${url}`)).toBe(
			"request failed at https://example.test/[REDACTED]/download?[REDACTED]",
		);
	});

	it("redacts values following a credential-like path key", () => {
		expect(requestPathForFixture("/refreshToken/ordinary-value/download?ignored=yes")).toBe(
			"/[REDACTED]/[REDACTED]/download",
		);
		expect(requestPathForFixture("/password;format=raw/ordinary-value")).toBe(
			"/[REDACTED]/[REDACTED]",
		);
		expect(requestPathForFixture("/password%2Fordinary-value/download")).toBe(
			"/[REDACTED]/download",
		);
	});

	it("redacts heuristic-confirmed primitive string values under unrecognized keys", () => {
		// High-entropy token shape without matching any real vendor's secret
		// format (GitHub push protection rejects Stripe-like sk_live_ strings).
		const token = "tok_fake_Qj8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS";
		const privateKey =
			"-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
		expect(
			sanitizeFixture({
				value: token,
				download: `https://user:password@example.test/file?token=${token}`,
				attachment: privateKey,
				message: "short prose remains useful",
			}),
		).toEqual({
			value: "[REDACTED]",
			download: "https://example.test/file?[REDACTED]",
			attachment: "[REDACTED]",
			message: "short prose remains useful",
		});
	});

	it("anchors credential keys and safely formats diagnostic controls", () => {
		const requestId = "0123456789abcdef0123456789abcdef";
		expect(sanitizeFixture({ author: "Ada", sessionCount: 12 })).toEqual({
			author: "Ada",
			sessionCount: 12,
		});
		const diagnostic = sanitizeDiagnosticText(
			`service_key=abc123 request_id=${requestId}\n\u0000\u0007\b\f\u001b[31mspoof\u061c\u200e\u200f\u202e`,
		);
		expect(diagnostic).toContain("service_key=[REDACTED]");
		expect(diagnostic).toContain(`request_id=${requestId}`);
		expect(diagnostic).not.toContain("\n");
		expect(diagnostic).not.toContain("\u001b");
		expect(diagnostic).not.toContain("\u202e");
		expect(diagnostic).not.toContain("\u0000");
		expect(diagnostic).not.toContain("\u0007");
		expect(diagnostic).not.toContain("\b");
		expect(diagnostic).not.toContain("\f");
		expect(diagnostic).not.toContain("\u061c");
		expect(diagnostic).not.toContain("\u200e");
		expect(diagnostic).not.toContain("\u200f");
	});

	it("redacts email addresses while preserving surrounding diagnostic text", () => {
		expect(sanitizeDiagnosticText("lookup for person@example.com failed upstream")).toBe(
			"lookup for [REDACTED] failed upstream",
		);
	});

	it("does not restore a URL from the old plain-text placeholder", () => {
		const url = "https://api.example.com/v1/x?token=secret123456";
		const sanitizedUrl = "https://api.example.com/v1/x?[REDACTED]";
		const diagnostic = sanitizeDiagnosticText(`upstream said APIFUSEURL0X and ${url}`);

		expect(diagnostic).toBe(`upstream said APIFUSEURL0X and ${sanitizedUrl}`);
		expect(diagnosticUrls(diagnostic)).toEqual([sanitizedUrl]);
	});

	it("preserves genuine URL order without restoring fake plain-text placeholders", () => {
		const firstUrl = "https://a.test/p?k=aaa111bbb222";
		const secondUrl = "https://b.test/q?k=ccc333ddd444";
		const firstSanitizedUrl = "https://a.test/p?[REDACTED]";
		const secondSanitizedUrl = "https://b.test/q?[REDACTED]";
		const diagnostic = sanitizeDiagnosticText(
			`APIFUSEURL1X ${firstUrl} ${secondUrl} APIFUSEURL0X`,
		);

		expect(diagnostic).toBe(
			`APIFUSEURL1X ${firstSanitizedUrl} ${secondSanitizedUrl} APIFUSEURL0X`,
		);
		expect(diagnosticUrls(diagnostic)).toEqual([firstSanitizedUrl, secondSanitizedUrl]);
	});

	it("does not interpret an input containing the control-delimited URL sentinel", () => {
		const forgedSentinel = "\u0000APIFUSE_URL0\u0000";
		const url = "https://real.test/path?secret=hidden123456";
		const sanitizedUrl = "https://real.test/path?[REDACTED]";
		const diagnostic = sanitizeDiagnosticText(`upstream said ${forgedSentinel} and ${url}`);

		expect(diagnostic).toBe(
			`upstream said \\u0000APIFUSE_URL0\\u0000 and ${sanitizedUrl}`,
		);
		expect(diagnosticUrls(diagnostic)).toEqual([sanitizedUrl]);
	});

	it("preserves origin and path while redacting and ordering multiple genuine URLs", () => {
		const firstUrl = "https://first.test/v1/items?token=aaa111bbb222";
		const secondUrl = "http://second.test/v2/status?key=ccc333ddd444";
		const expectedUrls = [
			"https://first.test/v1/items?[REDACTED]",
			"http://second.test/v2/status?[REDACTED]",
		];
		const diagnostic = sanitizeDiagnosticText(`first ${firstUrl}; then ${secondUrl}`);

		expect(diagnosticUrls(diagnostic)).toEqual(expectedUrls);
	});
});
