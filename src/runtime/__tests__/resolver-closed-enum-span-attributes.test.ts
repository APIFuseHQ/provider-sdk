import { describe, expect, it, spyOn } from "bun:test";

import { createProviderContextDouble } from "../../__tests__/test-utils.js";
import {
	compileProcessDiagnosticSensitiveValues,
	createDiagnosticRedactor,
	REDACTION_FAILED,
	registerProcessDiagnosticValues,
	withDiagnosticFallbackScope,
} from "../diagnostic-redactor.js";
import { wrapWithInstrumentation } from "../instrumentation.js";
import {
	APIFUSE__RESOLVER__2CAPTCHA__API_KEY,
	APIFUSE__RESOLVER__CAPSOLVER__API_KEY,
	createResolverClientFromEnvForTests,
} from "../resolver.js";
import { ResolverTelemetryCollector } from "../resolver-telemetry.js";
import { createCapsolverResolverVendorAdapter } from "../resolver-vendors/capsolver.js";
import { createTraceContext, getTraceRecorder, type Span } from "../trace.js";

const PAGE_URL = "https://shop.example.com/protected";

/** A fallback registry past its cap: every free-text diagnostic reads `[REDACTION_FAILED]`. */
function exhaustedRedactor() {
	const registry = createDiagnosticRedactor([], compileProcessDiagnosticSensitiveValues([]));
	registerProcessDiagnosticValues(
		Array.from({ length: 1_025 }, (_, index) => `fallback-registration-${index}`),
	);
	expect(registry.suppressed).toBe(true);
	return registry;
}

function capsolverAdapter(apiKey: string, timeoutMs: number, exhausted: boolean) {
	return createCapsolverResolverVendorAdapter({
		apiKey,
		timeoutMs,
		allowedHosts: ["shop.example.com"],
		pollIntervalMs: 1,
		fetchImpl: (async (input: string | URL | Request) => {
			const url = input instanceof Request ? input.url : String(input);
			if (exhausted) {
				return Response.json({
					errorId: 1,
					errorCode: "ERROR_ZERO_BALANCE",
					errorDescription: "Account balance is zero",
				});
			}
			return url.endsWith("/createTask")
				? Response.json({ errorId: 0, taskId: "task-1" })
				: Response.json({ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "t" } });
		}) as typeof fetch,
	});
}

async function solveWithFailover(registry: ReturnType<typeof exhaustedRedactor>): Promise<Span[]> {
	const trace = createTraceContext({ redact: registry.redact });
	const resolver = createResolverClientFromEnvForTests(
		{ kinds: ["recaptcha_v2"] },
		{
			[APIFUSE__RESOLVER__CAPSOLVER__API_KEY]: "capsolver-credential",
			[APIFUSE__RESOLVER__2CAPTCHA__API_KEY]: "second-vendor-credential",
		},
		{ telemetry: new ResolverTelemetryCollector({ redact: registry.redact }) },
		{
			capsolver: (configuration, timeoutMs) =>
				capsolverAdapter(configuration as string, timeoutMs, true),
			"2captcha": (configuration, timeoutMs) =>
				capsolverAdapter(configuration as string, timeoutMs, false),
		},
	);
	const context = wrapWithInstrumentation(createProviderContextDouble({ trace, resolver }));
	await context.resolver.solve({ kind: "recaptcha_v2", pageUrl: PAGE_URL, siteKey: "site-key" });
	return trace.getSpans();
}

function spans(all: Span[], name: string): Span[] {
	return all.filter((span) => span.name === name);
}

describe("resolver closed-enum span attributes in fail-closed redaction", () => {
	it("keeps declared closed-enum values on resolver spans and suppresses free text", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const recorded = await withDiagnosticFallbackScope(() =>
				solveWithFailover(exhaustedRedactor()),
			);

			expect(spans(recorded, "resolver.solve")[0]?.attributes).toMatchObject({
				challenge_kind: "recaptcha_v2",
			});
			const [failedAttempt] = spans(recorded, "resolver.vendor.attempt");
			expect(failedAttempt?.attributes).toMatchObject({
				vendor: "capsolver",
				challenge_kind: "recaptcha_v2",
				unavailability_reason: "allocation_exhausted",
				transport_phase: "create_task",
			});
			const [failedCreate] = spans(recorded, "resolver.vendor.create_task");
			expect(failedCreate?.attributes).toMatchObject({
				vendor: "capsolver",
				unavailability_reason: "allocation_exhausted",
				transport_phase: "create_task",
				// Vendor-supplied text is not an SDK closed enum.
				vendor_error_code: REDACTION_FAILED,
				vendor_error_description: REDACTION_FAILED,
			});
			// The metering record keeps its attribution under exhaustion.
			expect(spans(recorded, "resolver.usage").map((span) => span.attributes)).toEqual([
				expect.objectContaining({
					vendor: "capsolver",
					challenge_kind: "recaptcha_v2",
					endpoint: "capsolver:create_task",
					billing: "metered",
					outcome: "vendor_error",
				}),
				expect.objectContaining({
					vendor: "capsolver",
					challenge_kind: "recaptcha_v2",
					endpoint: "capsolver:create_task",
					billing: "metered",
					outcome: "success",
				}),
			]);
		} finally {
			warn.mockRestore();
		}
	});

	it("suppresses an undeclared value under a closed-enum key", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const attributes = await withDiagnosticFallbackScope(async () => {
				const trace = createTraceContext({ redact: exhaustedRedactor().redact });
				await getTraceRecorder(trace)?.runSpan("resolver.vendor.attempt", () => undefined, {
					attributes: {
						vendor: "free text naming a vendor",
						outcome: "free text outcome",
						transport_phase: "phase from an upstream body",
					},
				});
				return trace.getSpans()[0]?.attributes;
			});
			expect(attributes).toMatchObject({
				vendor: REDACTION_FAILED,
				outcome: REDACTION_FAILED,
				transport_phase: REDACTION_FAILED,
			});
		} finally {
			warn.mockRestore();
		}
	});

	it("still redacts a registered credential that equals a closed-enum literal", async () => {
		const registry = createDiagnosticRedactor(["capsolver:create_task"]);
		const trace = createTraceContext({ redact: registry.redact });
		await getTraceRecorder(trace)?.runSpan("resolver.usage", () => undefined, {
			attributes: { endpoint: "capsolver:create_task", vendor: "capsolver" },
		});
		expect(trace.getSpans()[0]?.attributes).toMatchObject({
			endpoint: "[REDACTED]",
			vendor: "capsolver",
		});
	});
});
