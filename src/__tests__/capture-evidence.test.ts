import { describe, expect, it } from "bun:test";

import {
	buildCaptureEvidence,
	CAPTURE_EVIDENCE_VERSION,
	type CaptureEvidenceOptions,
	maskSensitivePaths,
	type UpstreamCaptureSource,
} from "../capture-evidence.js";
import type { JsonValue } from "../contract-json.js";
import {
	REDACTED_FIXTURE_VALUE,
	sanitizeCaptureEvidenceString,
	sanitizeFixtureString,
} from "../fixture-sanitization.js";
import { createDiagnosticRedactor } from "../runtime/diagnostic-redactor.js";

function source(overrides: Partial<UpstreamCaptureSource> = {}): UpstreamCaptureSource {
	return {
		url: "https://upstream.example/api/review/v1/shops/shop-1/reviews?page=1&token=abc",
		status: 200,
		contentType: "application/json; charset=utf-8",
		body: { items: [{ id: "review-1", content: { text: "good" } }] },
		...overrides,
	};
}

function options(
	overrides: Partial<CaptureEvidenceOptions> & { registeredSecrets?: readonly string[] } = {},
): CaptureEvidenceOptions {
	const { registeredSecrets = [], ...rest } = overrides;
	return { redactKnownSecrets: createDiagnosticRedactor(registeredSecrets).redact, ...rest };
}

function evidenceBody(body: JsonValue, overrides: Parameters<typeof options>[0] = {}): JsonValue {
	return buildCaptureEvidence(source({ body }), options(overrides)).body;
}

describe("buildCaptureEvidence", () => {
	it("reduces the request URL to a query-free scrubbed path", () => {
		const evidence = buildCaptureEvidence(source(), options());
		expect(evidence.requestPath).toBe("/api/review/v1/shops/shop-1/reviews");
		expect(JSON.stringify(evidence)).not.toContain("token=abc");
		expect(JSON.stringify(evidence)).not.toContain("page=1");
	});

	it("retains the upstream status, bare media type, and version", () => {
		const evidence = buildCaptureEvidence(source(), options());
		expect(evidence.version).toBe(CAPTURE_EVIDENCE_VERSION);
		expect(evidence.upstreamStatus).toBe(200);
		expect(evidence.upstreamContentType).toBe("application/json");
	});

	it("omits the media type key when the source has none", () => {
		const evidence = buildCaptureEvidence(source({ contentType: undefined }), options());
		expect(Object.hasOwn(evidence, "upstreamContentType")).toBe(false);
	});

	it("drops every media-type parameter, including a URL-bearing profile", () => {
		const evidence = buildCaptureEvidence(
			source({ contentType: 'Application/JSON; profile="https://x/p?token=SECRET"' }),
			options(),
		);
		expect(evidence.upstreamContentType).toBe("application/json");
		expect(JSON.stringify(evidence)).not.toContain("SECRET");
		expect(JSON.stringify(evidence)).not.toContain("profile");
	});

	it("omits a media type that is not a bare RFC 9110 type/subtype", () => {
		for (const contentType of [
			"application/json\r\nSet-Cookie: sid=SECRET",
			"text/html\n",
			"not a media type",
			"application/",
			"",
		]) {
			const evidence = buildCaptureEvidence(source({ contentType }), options());
			expect(Object.hasOwn(evidence, "upstreamContentType")).toBe(false);
			expect(JSON.stringify(evidence)).not.toContain("SECRET");
		}
	});

	it("preserves non-sensitive body shape for fixture authoring", () => {
		expect(evidenceBody({ items: [{ id: "review-1", content: { text: "good" } }] })).toEqual({
			items: [{ id: "review-1", content: { text: "good" } }],
		});
	});

	it("masks a provider-declared output sensitive path (wildcard array element)", () => {
		const body = evidenceBody(
			{
				items: [
					{ id: "r1", paymentUrl: "https://pay.example/xyz" },
					{ id: "r2", paymentUrl: "https://pay.example/abc" },
				],
			},
			{ sensitiveOutputPaths: ["items.*.paymentUrl"] },
		);
		const items = (body as { items: Array<Record<string, unknown>> }).items;
		expect(items[0]?.paymentUrl).toBe(REDACTED_FIXTURE_VALUE);
		expect(items[1]?.paymentUrl).toBe(REDACTED_FIXTURE_VALUE);
		expect(items[0]?.id).toBe("r1");
	});

	it("masks reserved secret-like keys at any depth and keeps their siblings", () => {
		const body = evidenceBody({
			account: {
				phone: "010-0000-0000",
				phoneNumber: "+82-10-0000-0000",
				otp: "123456",
				otpCode: "654321",
				payment_url: "https://pay.example/session",
				nickname: "tester",
			},
			id: "r1",
		});
		expect(body).toEqual({
			account: {
				phone: REDACTED_FIXTURE_VALUE,
				phoneNumber: REDACTED_FIXTURE_VALUE,
				otp: REDACTED_FIXTURE_VALUE,
				otpCode: REDACTED_FIXTURE_VALUE,
				payment_url: REDACTED_FIXTURE_VALUE,
				nickname: "tester",
			},
			id: "r1",
		});
	});

	it("records the known miss: output paths do not match an upstream-shaped body", () => {
		// catchtable my-profile: declared output paths are output coordinates
		// (`name`, `display_name`, `phone`, `email`); the upstream body nests the
		// same data under `data` with vendor key names. Only `phone` is caught, by
		// the reserved-key set. Upstream-coordinate masking is an open item on
		// apifuse#2602 before the wiring PR; change this test when it lands.
		const body = evidenceBody(
			{
				data: {
					name: "Kim Tester",
					displayName: "tester-kim",
					phone: "010-0000-0000",
					email: "tester@example.com",
				},
			},
			{ sensitiveOutputPaths: ["name", "display_name", "phone", "email"] },
		);
		expect(body).toEqual({
			data: {
				name: "Kim Tester",
				displayName: "tester-kim",
				phone: REDACTED_FIXTURE_VALUE,
				email: "tester@example.com",
			},
		});
	});

	it("masks credential-named keys anywhere", () => {
		const text = JSON.stringify(
			evidenceBody({
				profile: { name: "tester", sessionId: "s3cr3t-session-value" },
				authorization: "Bearer QWxhZGRpbjpvcGVuc2VzYW1lZXh0cmFsb25ndG9rZW4",
				cookie: "SID=abcdef; path=/",
			}),
		);
		expect(text).not.toContain("s3cr3t-session-value");
		expect(text).not.toContain("QWxhZGRpbjpvcGVuc2VzYW1l");
		expect(text).not.toContain("abcdef");
		expect(text).toContain("tester");
	});

	it("masks a high-entropy secret under a neutral key", () => {
		expect(evidenceBody({ ref: "Zx8Qm2LkP7vR4tY9wB3nC6jH1fD5gS0a", id: "r1" })).toEqual({
			ref: REDACTED_FIXTURE_VALUE,
			id: "r1",
		});
	});

	it("never leaks an authorization token, keyed or keyless", () => {
		const text = JSON.stringify(
			evidenceBody({
				note: "Authorization: Bearer sk-live-abcdef0123456789abcdef0123456789",
				reason: "rejected Bearer abc123",
			}),
		);
		expect(text).not.toContain("sk-live-abcdef0123456789");
		expect(text).not.toContain("abc123");
	});

	it("redacts keyless auth-scheme tokens of any length in body strings", () => {
		expect(
			evidenceBody({
				a: "rejected Bearer abc123",
				b: "token expired: Bearer 9f8e7d6c5b4a",
				c: "bad creds Basic dTpw",
				d: "Basic dXNlcjpwdw==",
				e: "Negotiate YIIB",
				f: "the Basic plan failed to negotiate TLS",
			}),
		).toEqual({
			a: "rejected Bearer [REDACTED]",
			b: "token expired: Bearer [REDACTED]",
			c: "bad creds Basic [REDACTED]",
			d: "Basic [REDACTED]",
			e: "Negotiate [REDACTED]",
			f: "the Basic plan failed to negotiate TLS",
		});
	});

	it("redacts registered request secrets by exact value under neutral keys, keys, and the path", () => {
		const evidence = buildCaptureEvidence(
			source({
				url: "https://upstream.example/api/users/tester01/reviews?page=1",
				body: {
					loginId: "tester01",
					note: "signed in as tester01",
					byUser: { tester01: { count: 2 } },
					pin: 4821,
					id: "r1",
				},
			}),
			options({ registeredSecrets: ["tester01", "4821"] }),
		);
		const text = JSON.stringify(evidence);
		expect(text).not.toContain("tester01");
		expect(text).not.toContain("4821");
		expect(evidence.requestPath).toBe("/api/users/[REDACTED]/reviews");
		expect(evidence.body).toEqual({
			loginId: REDACTED_FIXTURE_VALUE,
			note: `signed in as ${REDACTED_FIXTURE_VALUE}`,
			byUser: { [REDACTED_FIXTURE_VALUE]: { count: 2 } },
			pin: REDACTED_FIXTURE_VALUE,
			id: "r1",
		});
	});

	it("strips query and fragment from relative, protocol-relative, and other-scheme URLs", () => {
		expect(
			evidenceBody({
				relative: "/cb?code=AbC123",
				dotted: "redirect to ../cb?code=AbC123 now",
				bare: "callback.php?code=AbC123",
				protocolRelative: "//cdn.example/cb?code=AbC123",
				otherScheme: "myapp://oauth/cb?code=AbC123#state=xyz",
				fragmentOnly: "/cb#access_token=AbC123",
				html: '<a href="/cb?code=AbC123">next</a>',
				absolute: "https://upstream.example/cb?code=AbC123",
			}),
		).toEqual({
			relative: "/cb?[REDACTED]",
			dotted: "redirect to ../cb?[REDACTED] now",
			bare: "callback.php?[REDACTED]",
			protocolRelative: "//cdn.example/cb?[REDACTED]",
			otherScheme: "myapp://oauth/cb?[REDACTED]",
			fragmentOnly: "/cb",
			html: '<a href="/cb?[REDACTED]">next</a>',
			absolute: "https://upstream.example/cb?[REDACTED]",
		});
	});

	it("keeps prose question marks and hashtags that are not URL-like", () => {
		const prose = "Open today? Really? See #2 and/or the #best menu.";
		expect(evidenceBody({ text: prose })).toEqual({ text: prose });
	});

	it("emits evidence for a successful and a failed-upstream response alike", () => {
		const ok = buildCaptureEvidence(source({ status: 200 }), options());
		const bad = buildCaptureEvidence(
			source({ status: 409, body: { reason: "login required" } }),
			options(),
		);
		expect(ok.upstreamStatus).toBe(200);
		expect(bad.upstreamStatus).toBe(409);
		expect(bad.body).toEqual({ reason: "login required" });
	});
});

describe("sanitizeCaptureEvidenceString", () => {
	it("leaves recorded fixture strings on the fixture rules", () => {
		// The capture rules are a separate entry point so fixture goldens keep their bytes.
		expect(sanitizeFixtureString("rejected Bearer abc123")).toBe("rejected Bearer abc123");
		expect(sanitizeCaptureEvidenceString("rejected Bearer abc123")).toBe(
			"rejected Bearer [REDACTED]",
		);
	});

	it("treats one unquoted run as one URL-like candidate, however many slashes it holds", () => {
		// Every `(/` is a possible relative-reference start; the run is scanned once, not per start.
		const run = `${"(/".repeat(50_000)}?code=AbC123`;
		const sanitized = sanitizeCaptureEvidenceString(run);
		expect(sanitized.endsWith(`?${REDACTED_FIXTURE_VALUE}`)).toBe(true);
		expect(sanitized).not.toContain("AbC123");
	});
});

describe("maskSensitivePaths", () => {
	it("redacts a top-level key path", () => {
		expect(maskSensitivePaths({ a: "x", b: "y" }, ["a"])).toEqual({
			a: REDACTED_FIXTURE_VALUE,
			b: "y",
		});
	});

	it("redacts a numeric array index path", () => {
		expect(maskSensitivePaths({ list: ["a", "b", "c"] }, ["list.1"])).toEqual({
			list: ["a", REDACTED_FIXTURE_VALUE, "c"],
		});
	});

	it("leaves the value unchanged when the path does not match", () => {
		const value = { a: { b: 1 } };
		expect(maskSensitivePaths(value, ["a.c", "x.*.y"])).toEqual({ a: { b: 1 } });
	});

	it("applies multiple paths", () => {
		expect(maskSensitivePaths({ a: "1", b: "2", c: "3" }, ["a", "c"])).toEqual({
			a: REDACTED_FIXTURE_VALUE,
			b: "2",
			c: REDACTED_FIXTURE_VALUE,
		});
	});
});
