import { describe, expect, it } from "bun:test";

import {
	requestPathForFixture,
	sanitizeDiagnosticText,
	sanitizeFixture,
	sanitizeOrdinaryFixture,
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
		expect(sanitizeDiagnosticText(`request failed at ${url}`)).not.toContain(token);
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
});
