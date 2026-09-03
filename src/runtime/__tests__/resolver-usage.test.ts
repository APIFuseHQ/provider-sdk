import { describe, expect, it } from "bun:test";

import { recordPaidResolverCreate } from "../resolver-usage.js";
import { createTraceContext, getTraceRecorder } from "../trace.js";

function recorderFixture() {
	const trace = createTraceContext();
	const recorder = getTraceRecorder(trace);
	if (!recorder) throw new Error("Test trace context did not expose its recorder");
	return { trace, recorder };
}

describe("paid resolver usage telemetry", () => {
	it("records timeout at a paid create even when no task is returned", async () => {
		const { trace, recorder } = recorderFixture();
		const timeout = new DOMException("vendor create timed out", "TimeoutError");

		await expect(
			recordPaidResolverCreate({
				traceRecorder: recorder,
				vendor: "capsolver",
				kind: "turnstile",
				signal: new AbortController().signal,
				usage: { attemptIndex: 2, resolverIdentityScope: "scope-digest" },
				create: async () => {
					throw timeout;
				},
			}),
		).rejects.toBe(timeout);

		expect(trace.getSpans()).toHaveLength(1);
		expect(trace.getSpans()[0]).toMatchObject({
			name: "resolver.usage",
			status: "error",
			attributes: {
				vendor: "capsolver",
				challenge_kind: "turnstile",
				billable_units: 1,
				attempt_index: 2,
				resolver_identity_scope: "scope-digest",
				outcome: "timeout",
				duration_ms: expect.any(Number),
			},
		});
	});

	it("records an abandoned paid create separately from vendor failure", async () => {
		const { trace, recorder } = recorderFixture();
		const controller = new AbortController();
		const reason = new DOMException("caller stopped", "AbortError");
		controller.abort(reason);

		await expect(
			recordPaidResolverCreate({
				traceRecorder: recorder,
				vendor: "2captcha",
				kind: "recaptcha_v2",
				signal: controller.signal,
				create: async () => {
					throw reason;
				},
			}),
		).rejects.toBe(reason);

		expect(trace.getSpans()[0]?.attributes).toMatchObject({
			outcome: "abandoned",
			billable_units: 1,
		});
	});
});
