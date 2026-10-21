import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";

import { z } from "zod";

import { extractProviderContract } from "../contract.js";
import { defineProvider } from "../define.js";
import { ValidationError } from "../errors.js";
import { REDACTED_FIXTURE_VALUE } from "../fixture-sanitization.js";
import { createDiagnosticRedactor } from "../runtime/diagnostic-redactor.js";
import { normalizeResponse } from "../runtime/stealth.js";
import {
	activeUpstreamCaptureRecorder,
	CAPTURE_UPSTREAM_BODY_MAX_BYTES,
	runWithUpstreamCaptureRecorder,
	UpstreamCaptureRecorder,
} from "../runtime/upstream-capture-recorder.js";
import {
	CAPTURE_DIRECTIVE_CLOCK_SKEW_MS,
	CAPTURE_DIRECTIVE_MAX_TTL_MS,
	CAPTURE_EVIDENCE_MAX_BYTES,
	CaptureNonceLedger,
	evaluateCaptureDirective,
	openOperationCaptureSession,
} from "../server/upstream-capture.js";

const NOW = Date.parse("2026-10-21T09:00:00.000Z");

function nonce(): string {
	return randomBytes(16).toString("hex");
}

function directive(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		nonce: nonce(),
		providerId: "catchtable",
		operationId: "reviews",
		requestId: "req-1",
		expiresAt: new Date(NOW + 30_000).toISOString(),
		...overrides,
	};
}

function evaluate(value: unknown, ledger = new CaptureNonceLedger()) {
	return evaluateCaptureDirective({
		directive: value,
		providerId: "catchtable",
		operationId: "reviews",
		requestId: "req-1",
		nowMs: NOW,
		ledger,
	});
}

describe("evaluateCaptureDirective", () => {
	it("accepts a directive that passes every rule", () => {
		expect(evaluate(directive())).toEqual({ active: true });
	});

	it("rejects each failed rule with its reason", () => {
		const cases: Array<[string, unknown]> = [
			["malformed", null],
			["malformed", "directive"],
			["malformed", [directive()]],
			["malformed", directive({ nonce: undefined })],
			["malformed", directive({ requestId: 7 })],
			["unsupported_version", directive({ version: 2 })],
			["unsupported_version", directive({ version: "1" })],
			["provider_mismatch", directive({ providerId: "other" })],
			["operation_mismatch", directive({ operationId: "my-profile" })],
			["request_id_mismatch", directive({ requestId: "req-2" })],
			["nonce_malformed", directive({ nonce: "A".repeat(32) })],
			["nonce_malformed", directive({ nonce: "ab".repeat(15) })],
			["nonce_malformed", directive({ nonce: `${nonce()}0` })],
			["expires_at_malformed", directive({ expiresAt: "2026-10-21T09:00:30Z" })],
			["expires_at_malformed", directive({ expiresAt: "2026-10-21T18:00:30.000+09:00" })],
			["expires_at_malformed", directive({ expiresAt: "2026-13-45T09:00:30.000Z" })],
			["expired", directive({ expiresAt: new Date(NOW).toISOString() })],
			["expired", directive({ expiresAt: new Date(NOW - 1).toISOString() })],
			[
				"expires_too_far",
				directive({
					expiresAt: new Date(
						NOW + CAPTURE_DIRECTIVE_MAX_TTL_MS + CAPTURE_DIRECTIVE_CLOCK_SKEW_MS + 1,
					).toISOString(),
				}),
			],
		];
		for (const [reason, value] of cases) {
			expect({ reason, decision: evaluate(value) }).toEqual({
				reason,
				decision: { active: false, reason },
			});
		}
	});

	it("accepts the latest expiry the TTL and skew allow", () => {
		const expiresAt = new Date(
			NOW + CAPTURE_DIRECTIVE_MAX_TTL_MS + CAPTURE_DIRECTIVE_CLOCK_SKEW_MS,
		).toISOString();
		expect(evaluate(directive({ expiresAt }))).toEqual({ active: true });
	});

	it("accepts a nonce once, and a rejected directive never consumes one", () => {
		const ledger = new CaptureNonceLedger();
		const shared = nonce();
		expect(evaluate(directive({ nonce: shared, requestId: "req-2" }), ledger)).toEqual({
			active: false,
			reason: "request_id_mismatch",
		});
		expect(ledger.size).toBe(0);
		expect(evaluate(directive({ nonce: shared }), ledger)).toEqual({ active: true });
		expect(evaluate(directive({ nonce: shared }), ledger)).toEqual({
			active: false,
			reason: "nonce_replayed",
		});
	});

	it("forgets a nonce once its directive expired, and refuses new nonces when full", () => {
		const ledger = new CaptureNonceLedger(2);
		expect(ledger.claim("a".repeat(32), NOW + 10, NOW)).toBe("accepted");
		expect(ledger.claim("b".repeat(32), NOW + 10_000, NOW)).toBe("accepted");
		expect(ledger.claim("c".repeat(32), NOW + 10_000, NOW)).toBe("full");
		// The first entry expired: it is swept, so a new nonce fits again.
		expect(ledger.claim("c".repeat(32), NOW + 10_000, NOW + 10)).toBe("accepted");
		expect(ledger.claim("b".repeat(32), NOW + 10_000, NOW + 10)).toBe("replayed");
		expect(() => new CaptureNonceLedger(0)).toThrow(RangeError);
	});
});

describe("UpstreamCaptureRecorder", () => {
	it("keeps only the last exchange, as a path without origin, userinfo, or query", () => {
		const recorder = new UpstreamCaptureRecorder();
		recorder.record({
			url: "https://upstream.example/first?x=1",
			status: 200,
			contentType: "application/json",
			byteLength: 2,
			bodyText: "{}",
		});
		recorder.record({
			url: "https://user:pass@upstream.example/api/me?token=SECRET#frag",
			status: 409,
			contentType: undefined,
			byteLength: 5,
			bodyText: "nope!",
		});
		expect(recorder.last).toEqual({
			kind: "body",
			path: "/api/me",
			status: 409,
			bodyText: "nope!",
		});
		expect(JSON.stringify(recorder.last)).not.toContain("SECRET");
		expect(JSON.stringify(recorder.last)).not.toContain("pass");
	});

	it("keeps no text for a body over the cap", () => {
		const recorder = new UpstreamCaptureRecorder();
		recorder.record({
			url: "https://upstream.example/big",
			status: 200,
			contentType: "application/json",
			byteLength: CAPTURE_UPSTREAM_BODY_MAX_BYTES + 1,
			bodyText: "x",
		});
		expect(recorder.last).toEqual({
			kind: "too_large",
			path: "/big",
			status: 200,
			contentType: "application/json",
		});
	});

	it("reduces a non-http URL to the root path", () => {
		const recorder = new UpstreamCaptureRecorder();
		recorder.record({
			url: "user:secret@host/path",
			status: 200,
			contentType: undefined,
			byteLength: 0,
			bodyText: "",
		});
		expect(recorder.last?.path).toBe("/");
	});
});

describe("stealth response seam", () => {
	function realResponse(): Response {
		return new Response(JSON.stringify({ data: { email: "tester@example.com" } }), {
			status: 200,
			headers: {
				"content-type": "application/json",
				"set-cookie": "sid=SESSIONVALUE; Path=/",
			},
		});
	}

	it("records a normalized stealth response only inside a capture-active scope", async () => {
		expect(activeUpstreamCaptureRecorder()).toBeUndefined();
		await normalizeResponse(realResponse(), "https://upstream.example/api/me?token=Q");

		const recorder = new UpstreamCaptureRecorder();
		await runWithUpstreamCaptureRecorder(recorder, async () => {
			await Promise.resolve();
			expect(activeUpstreamCaptureRecorder()).toBe(recorder);
			await normalizeResponse(realResponse(), "https://upstream.example/api/me?token=Q");
		});
		expect(recorder.last).toEqual({
			kind: "body",
			path: "/api/me",
			status: 200,
			contentType: "application/json",
			bodyText: JSON.stringify({ data: { email: "tester@example.com" } }),
		});
		expect(JSON.stringify(recorder.last)).not.toContain("SESSIONVALUE");
		expect(JSON.stringify(recorder.last)).not.toContain("token=Q");
		expect(activeUpstreamCaptureRecorder()).toBeUndefined();
	});
});

describe("operation capture session outcome", () => {
	const redact = createDiagnosticRedactor(["registered-secret-value"]).redact;

	function session(upstream: readonly string[] | undefined, output?: readonly string[]) {
		return openOperationCaptureSession({
			sensitiveUpstreamPaths: upstream,
			sensitiveOutputPaths: output,
			redact,
		});
	}

	it("skips without buffering when the operation declares no upstream paths", () => {
		const undeclared = session(undefined, ["email"]);
		expect(undeclared.recorder).toBeUndefined();
		expect(undeclared.outcome()).toEqual({
			version: 1,
			outcome: "skipped",
			reason: "upstream_sensitive_paths_undeclared",
		});
	});

	it("skips with no_upstream_exchange and upstream_body_too_large", () => {
		expect(session([]).outcome()).toEqual({
			version: 1,
			outcome: "skipped",
			reason: "no_upstream_exchange",
		});
		const big = session([]);
		big.recorder?.record({
			url: "https://upstream.example/big",
			status: 200,
			contentType: "application/json",
			byteLength: CAPTURE_UPSTREAM_BODY_MAX_BYTES + 1,
			bodyText: "",
		});
		expect(big.outcome()).toEqual({
			version: 1,
			outcome: "skipped",
			reason: "upstream_body_too_large",
		});
	});

	it("skips with evidence_too_large when the masked evidence is over the cap", () => {
		const large = session([]);
		const words = Array.from({ length: 60_000 }, (_, index) => `word ${index}`);
		const bodyText = JSON.stringify({ items: words });
		expect(Buffer.byteLength(bodyText)).toBeGreaterThan(CAPTURE_EVIDENCE_MAX_BYTES);
		expect(Buffer.byteLength(bodyText)).toBeLessThanOrEqual(CAPTURE_UPSTREAM_BODY_MAX_BYTES);
		large.recorder?.record({
			url: "https://upstream.example/list",
			status: 200,
			contentType: "application/json",
			byteLength: Buffer.byteLength(bodyText),
			bodyText,
		});
		expect(large.outcome()).toEqual({
			version: 1,
			outcome: "skipped",
			reason: "evidence_too_large",
		});
	});

	it("builds masked evidence from a JSON body, and keeps a non-JSON body as a string", () => {
		const json = session(["data.displayName"], ["display_name"]);
		json.recorder?.record({
			url: "https://upstream.example/api/users/registered-secret-value?token=Q",
			status: 200,
			contentType: "application/json; charset=utf-8",
			byteLength: 10,
			bodyText: JSON.stringify({
				data: { displayName: "tester", note: "by registered-secret-value", grade: "gold" },
			}),
		});
		expect(json.outcome()).toEqual({
			version: 1,
			outcome: "captured",
			evidence: {
				version: 1,
				upstreamStatus: 200,
				upstreamContentType: "application/json",
				requestPath: `/api/users/${REDACTED_FIXTURE_VALUE}`,
				body: {
					data: {
						displayName: REDACTED_FIXTURE_VALUE,
						note: `by ${REDACTED_FIXTURE_VALUE}`,
						grade: "gold",
					},
				},
			},
		});
		// Built once: the same object on every call.
		expect(json.outcome()).toBe(json.outcome());

		const html = session([]);
		html.recorder?.record({
			url: "https://upstream.example/page",
			status: 403,
			contentType: "text/html",
			byteLength: 20,
			bodyText: "<p>blocked</p>",
		});
		const outcome = html.outcome();
		expect(outcome.outcome === "captured" ? outcome.evidence.body : undefined).toBe(
			"<p>blocked</p>",
		);
	});
});

describe("observability.sensitive.upstream declaration", () => {
	function declare(upstream: unknown) {
		return defineProvider({
			id: "upstream-paths",
			version: "1.0.0",
			runtime: "standard",
			meta: { displayName: "Upstream Paths", descriptionKey: "meta.description", category: "test" },
		})({
			operations: {
				profile: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					// test-invalid: malformed declarations are the subject of this test.
					observability: { sensitive: { upstream } } as never,
					healthCheckUnsupported: { reason: "Declaration-only test operation." },
					handler: async () => ({ ok: true }),
				},
			},
		});
	}

	it("accepts upstream paths and carries them verbatim in the contract", () => {
		const provider = declare(["data.displayName", "data.members.*.email", "items.0.phone"]);
		const operation = extractProviderContract(provider).operations.find(
			(entry) => entry.id === "profile",
		);
		expect(operation?.observability).toEqual({
			sensitive: { upstream: ["data.displayName", "data.members.*.email", "items.0.phone"] },
		});
		expect(declare([]).operations.profile?.observability).toEqual({ sensitive: { upstream: [] } });
	});

	it("rejects a malformed upstream path or a non-array value", () => {
		for (const upstream of [["data..name"], [" data.name"], ["data[0]"], [7], "data.name"]) {
			expect(() => declare(upstream)).toThrow(ValidationError);
		}
		expect(() => declare(["data[0]"])).toThrow(/observability\.sensitive\.upstream\[0\]/);
	});
});
