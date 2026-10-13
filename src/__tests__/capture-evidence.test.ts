import { describe, expect, it } from "bun:test";

import {
	buildCaptureEvidence,
	CAPTURE_EVIDENCE_VERSION,
	maskSensitivePaths,
	type UpstreamCaptureSource,
} from "../capture-evidence.js";
import { REDACTED_FIXTURE_VALUE } from "../fixture-sanitization.js";

function source(overrides: Partial<UpstreamCaptureSource> = {}): UpstreamCaptureSource {
	return {
		url: "https://upstream.example/api/review/v1/shops/shop-1/reviews?page=1&token=abc",
		status: 200,
		contentType: "application/json; charset=utf-8",
		body: { items: [{ id: "review-1", content: { text: "good" } }] },
		...overrides,
	};
}

describe("buildCaptureEvidence", () => {
	it("reduces the request URL to a query-free scrubbed path", () => {
		const evidence = buildCaptureEvidence(source());
		expect(evidence.requestPath).toBe("/api/review/v1/shops/shop-1/reviews");
		expect(JSON.stringify(evidence)).not.toContain("token=abc");
		expect(JSON.stringify(evidence)).not.toContain("page=1");
	});

	it("retains the upstream status, media type, and version", () => {
		const evidence = buildCaptureEvidence(source());
		expect(evidence.version).toBe(CAPTURE_EVIDENCE_VERSION);
		expect(evidence.upstreamStatus).toBe(200);
		expect(evidence.upstreamContentType).toBe("application/json; charset=utf-8");
	});

	it("omits the media type key when the source has none", () => {
		const evidence = buildCaptureEvidence(source({ contentType: undefined }));
		expect(Object.hasOwn(evidence, "upstreamContentType")).toBe(false);
	});

	it("preserves non-sensitive body shape for fixture authoring", () => {
		const evidence = buildCaptureEvidence(source());
		expect(evidence.body).toEqual({ items: [{ id: "review-1", content: { text: "good" } }] });
	});

	it("masks a provider-declared output sensitive path (wildcard array element)", () => {
		const evidence = buildCaptureEvidence(
			source({
				body: {
					items: [
						{ id: "r1", paymentUrl: "https://pay.example/xyz" },
						{ id: "r2", paymentUrl: "https://pay.example/abc" },
					],
				},
			}),
			{ sensitiveOutputPaths: ["items.*.paymentUrl"] },
		);
		const items = (evidence.body as { items: Array<Record<string, unknown>> }).items;
		expect(items[0]?.paymentUrl).toBe(REDACTED_FIXTURE_VALUE);
		expect(items[1]?.paymentUrl).toBe(REDACTED_FIXTURE_VALUE);
		expect(items[0]?.id).toBe("r1");
	});

	it("masks credential-named keys and high-entropy secrets anywhere", () => {
		const evidence = buildCaptureEvidence(
			source({
				body: {
					profile: { name: "tester", sessionId: "s3cr3t-session-value" },
					authorization: "Bearer QWxhZGRpbjpvcGVuc2VzYW1lZXh0cmFsb25ndG9rZW4",
					cookie: "SID=abcdef; path=/",
				},
			}),
		);
		const text = JSON.stringify(evidence.body);
		expect(text).not.toContain("s3cr3t-session-value");
		expect(text).not.toContain("Aladdin");
		expect(text).not.toContain("QWxhZGRpbjpvcGVuc2VzYW1l");
		expect(text).toContain("tester");
	});

	it("never leaks an authorization token even without a declared path", () => {
		const evidence = buildCaptureEvidence(
			source({
				body: { note: "Authorization: Bearer sk-live-abcdef0123456789abcdef0123456789" },
			}),
		);
		expect(JSON.stringify(evidence)).not.toContain("sk-live-abcdef0123456789");
	});

	it("emits evidence for a successful and a failed-upstream response alike", () => {
		const ok = buildCaptureEvidence(source({ status: 200 }));
		const bad = buildCaptureEvidence(source({ status: 409, body: { reason: "login required" } }));
		expect(ok.upstreamStatus).toBe(200);
		expect(bad.upstreamStatus).toBe(409);
		expect(bad.body).toEqual({ reason: "login required" });
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
