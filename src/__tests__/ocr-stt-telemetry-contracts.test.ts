import type { OcrContext, SttContext } from "../types.js";
import { describe, expect, it, spyOn } from "bun:test";
import { ProviderError } from "../errors.js";
import { createDiagnosticRedactor } from "../runtime/diagnostic-redactor.js";
import { wrapWithInstrumentation } from "../runtime/instrumentation.js";
import { createOcrClientFromEnv, createOpenAiCompatibleOcrClient } from "../runtime/ocr.js";
import {
	bindOcrTelemetry,
	OcrTelemetryCollector,
	type OcrTelemetryErrorCode,
} from "../runtime/ocr-telemetry.js";
import { closedEnum, HEADER_PRIORITY, RequestTelemetry } from "../runtime/request-telemetry.js";
import { createSttClientFromEnv } from "../runtime/stt.js";
import {
	bindSttTelemetry,
	SttTelemetryCollector,
	type SttTelemetryErrorCode,
} from "../runtime/stt-telemetry.js";
import { createTraceContext, type Span } from "../runtime/trace.js";
import { resolveServerTraceContextOptions } from "../server/trace-output.js";

const index = { spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 };
const image = { kind: "base64", data: "cGF5bG9hZA==" } as const;
const ocrHost = {
	recognize: async () => ({ text: "ok", model: "custom" }),
	extractCaptchaText: async () => ({
		text: "ok",
		model: "custom",
		candidates: [],
		satisfiesConstraints: true,
	}),
};
const sttHost = {
	transcribe: async () => ({ text: "ok" }),
	extractVerificationCode: () => ({ code: "1234", candidates: [], normalizedText: "1234" }),
};

describe("OCR/STT closed taxonomy and observer contract", () => {
	const ocrCodes: OcrTelemetryErrorCode[] = [
		"OCR_UNAVAILABLE",
		"UNSUPPORTED_OCR_BACKEND",
		"OCR_UPSTREAM_FAILED",
		"OCR_INCOMPLETE_RESPONSE",
		"transport_network_error",
		"transport_timeout",
	];
	const sttCodes: SttTelemetryErrorCode[] = [
		"STT_UNAVAILABLE",
		"UNSUPPORTED_STT_BACKEND",
		"STT_UPSTREAM_FAILED",
		"STT_AUDIO_TOO_LARGE",
		"UNSUPPORTED_STT_OPTION",
		"INVALID_STT_AUDIO",
		"INVALID_STT_VERIFICATION_CODE_OPTIONS",
		"NO_CODE_FOUND",
		"AMBIGUOUS_CODE",
		"transport_network_error",
		"transport_timeout",
	];
	for (const cap of ["ocr", "stt"] as const) {
		for (const code of cap === "ocr" ? ocrCodes : sttCodes)
			it(`${cap}: runtime error code ${code} never maps to other`, async () => {
				const error = new ProviderError("known failure", { code });
				const collector = cap === "ocr" ? new OcrTelemetryCollector() : new SttTelemetryCollector();
				if (collector instanceof OcrTelemetryCollector)
					await expect(
						bindOcrTelemetry(
							{
								...ocrHost,
								recognize: async () => {
									throw error;
								},
							},
							collector,
						).recognize({ image }),
					).rejects.toBe(error);
				else
					await expect(
						bindSttTelemetry(
							{
								...sttHost,
								transcribe: async () => {
									throw error;
								},
							},
							collector,
						).transcribe({ audio: image }),
					).rejects.toBe(error);
				expect(collector.toLogPayload(index)?.lastErrorCode).toBe(code);
				const ledger = new RequestTelemetry(createTraceContext());
				if (collector instanceof OcrTelemetryCollector) ledger.register(collector);
				else ledger.register(collector);
				expect(
					JSON.parse(Buffer.from(ledger.toHeaderValue()!, "base64url").toString())[cap]
						.lastErrorCode,
				).toBe(code);
			});
		it(`${cap}: unknown custom error is explicitly other`, async () => {
			const collector = cap === "ocr" ? new OcrTelemetryCollector() : new SttTelemetryCollector();
			const error = new Error("custom upstream failure");
			if (collector instanceof OcrTelemetryCollector)
				await expect(
					bindOcrTelemetry(
						{
							...ocrHost,
							recognize: async () => {
								throw error;
							},
						},
						collector,
					).recognize({ image }),
				).rejects.toBe(error);
			else
				await expect(
					bindSttTelemetry(
						{
							...sttHost,
							transcribe: async () => {
								throw error;
							},
						},
						collector,
					).transcribe({ audio: image }),
				).rejects.toBe(error);
			expect(collector.toLogPayload(index)).toMatchObject({
				backend: "custom",
				engine: "custom",
				lastErrorCode: "other",
			});
		});
		for (const mode of [
			"throw",
			"reject",
			"never-settle",
			"frozen",
			"species-throw",
			"thenable",
		] as const)
			it(`${cap}: ${mode} observer never changes operation or retries`, async () => {
				let failed = 0;
				let records = 0;
				let calls = 0;
				const record = () => {
					records++;
					if (mode === "throw") throw new Error("observer broke");
					if (mode === "reject") return Promise.reject(new Error("observer rejected"));
					if (mode === "never-settle") return new Promise(() => {});
					if (mode === "frozen") return Object.freeze(Promise.reject(new Error("frozen")));
					if (mode === "thenable")
						return {
							// biome-ignore lint/suspicious/noThenProperty: deliberately hostile observer return
							then: () => {
								throw new Error("must not call host thenable");
							},
						};
					const promise = Promise.reject(new Error("species rejection"));
					Object.defineProperty(promise, "constructor", {
						value: {
							get [Symbol.species]() {
								throw new Error("species trap");
							},
						},
						configurable: true,
					});
					return promise;
				};
				const sink = {
					record,
					markTelemetryFailed: () => {
						failed++;
					},
				};
				if (cap === "ocr") {
					const result = { text: "ok", model: "custom" };
					expect(
						await bindOcrTelemetry(
							{
								...ocrHost,
								recognize: async () => {
									calls++;
									return result;
								},
							},
							sink,
						).recognize({ image }),
					).toBe(result);
				} else {
					const result = { text: "ok" };
					expect(
						await bindSttTelemetry(
							{
								...sttHost,
								transcribe: async () => {
									calls++;
									return result;
								},
							},
							sink,
						).transcribe({ audio: image }),
					).toBe(result);
				}
				expect(calls).toBe(1);
				expect(records).toBe(1);
				expect(failed).toBe(1);
				const error = new Error("upstream failure identity");
				if (cap === "ocr")
					await expect(
						bindOcrTelemetry(
							{
								...ocrHost,
								recognize: async () => {
									calls++;
									throw error;
								},
							},
							sink,
						).recognize({ image }),
					).rejects.toBe(error);
				else
					await expect(
						bindSttTelemetry(
							{
								...sttHost,
								transcribe: async () => {
									calls++;
									throw error;
								},
							},
							sink,
						).transcribe({ audio: image }),
					).rejects.toBe(error);
				expect(calls).toBe(2);
				expect(records).toBe(2);
				expect(failed).toBe(2);
				await new Promise((resolve) => setImmediate(resolve));
			});
		for (const mode of ["missing", "unsupported"] as const)
			it(`${cap}: ${mode} runtime construction has unavailable backend`, async () => {
				const collector = cap === "ocr" ? new OcrTelemetryCollector() : new SttTelemetryCollector();
				if (collector instanceof OcrTelemetryCollector)
					await expect(
						bindOcrTelemetry(
							createOcrClientFromEnv(
								{ mode: "optional" },
								mode === "missing" ? {} : { APIFUSE__OCR__BACKEND: "not-supported" },
							),
							collector,
						).recognize({ image }),
					).rejects.toThrow();
				else
					await expect(
						bindSttTelemetry(
							createSttClientFromEnv(
								{ mode: "optional" },
								mode === "missing" ? {} : { APIFUSE__STT__BACKEND: "not-supported" },
							),
							collector,
						).transcribe({ audio: image }),
					).rejects.toThrow();
				expect(collector.toLogPayload(index)).toMatchObject({
					backend: "unavailable",
					engine: "custom",
					lastErrorCode:
						mode === "missing"
							? `${cap.toUpperCase()}_UNAVAILABLE`
							: `UNSUPPORTED_${cap.toUpperCase()}_BACKEND`,
				});
			});
	}
	for (const reason of [
		"stop",
		"length",
		"content_filter",
		"tool_calls",
		"function_call",
		"novel-vendor-reason",
	] as const)
		it(`OCR finish_reason=${reason} projects without hiding known values`, async () => {
			const collector = new OcrTelemetryCollector();
			const client = bindOcrTelemetry(
				createOpenAiCompatibleOcrClient({
					baseUrl: "https://ocr.test",
					model: "vision",
					fetch: Object.assign(
						async () =>
							Response.json({ choices: [{ finish_reason: reason, message: { content: "ok" } }] }),
						fetch,
					),
				}),
				collector,
			);
			await client.recognize({ image }).catch(() => undefined);
			expect(collector.toLogPayload(index)?.finishReason).toBe(
				reason === "novel-vendor-reason" ? "unknown" : reason,
			);
			expect(collector.toLogPayload(index)?.status).toBe(200);
			if (reason === "novel-vendor-reason")
				expect(collector.toLogPayload(index)?.diagnostics?.[0]).toContain(reason);
		});
	it("HEADER_PRIORITY slots are ocr=6/stt=7 and both drop before stealth", () => {
		expect(HEADER_PRIORITY.indexOf("ocr")).toBe(6);
		expect(HEADER_PRIORITY.indexOf("stt")).toBe(7);
		expect(HEADER_PRIORITY.indexOf("stealth")).toBeLessThan(HEADER_PRIORITY.indexOf("ocr"));
		const ledger = new RequestTelemetry(createTraceContext());
		const stealth = { samples: Array.from({ length: 28 }, () => closedEnum("x".repeat(60))) };
		ledger.register({
			key: "stealth",
			toLogPayload: () => stealth,
			toHeaderPayload: () => stealth,
		});
		const ocr = new OcrTelemetryCollector();
		const stt = new SttTelemetryCollector();
		for (let i = 0; i < 24; i++) {
			ocr.record({
				backend: "custom",
				engine: "custom",
				ms: 100,
				bytesIn: 100,
				bytesOut: 100,
				candidates: 3,
				warnings: 0,
			});
			stt.record({
				backend: "custom",
				engine: "custom",
				ms: 100,
				audioBytes: 100,
				durationMs: 100,
				usage: 100,
				warnings: 0,
			});
		}
		ledger.register(ocr);
		ledger.register(stt);
		const encoded = ledger.toHeaderValue()!;
		const header = JSON.parse(Buffer.from(encoded, "base64url").toString());
		expect(encoded.length).toBeLessThanOrEqual(4096);
		expect(header).toMatchObject({ v: 1, truncated: true, stealth });
		expect(header).not.toHaveProperty("ocr");
		expect(header).not.toHaveProperty("stt");
		expect(ledger.toLogPayload()).toHaveProperty("ocr");
		expect(ledger.toLogPayload()).toHaveProperty("stt");
	});
	it("P4 trace path redacts free model in getSpans/onSpan/export under the request root", async () => {
		const sentinel = "SENTINEL1234";
		const model = `caller ${sentinel} model`;
		const received: Span[] = [];
		const output: string[] = [];
		const print = spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
		const options = resolveServerTraceContextOptions({ enabled: true, exporter: "json" }, {});
		const trace = createTraceContext({
			...options,
			redact: createDiagnosticRedactor([sentinel]).redact,
			onSpan: (span) => {
				received.push(span);
				options.onSpan?.(span);
			},
		});
		const ctx = wrapWithInstrumentation<{
			trace: ReturnType<typeof createTraceContext>;
			ocr: OcrContext;
			stt: SttContext;
		}>({
			trace,
			ocr: { ...ocrHost, recognize: async () => ({ text: "ok", model }) },
			stt: { ...sttHost, transcribe: async () => ({ text: "ok", model }) },
		});
		try {
			await trace.span("request:operation:probe", async () => {
				await ctx.ocr.recognize({ image });
				await ctx.stt.transcribe({ audio: image });
			});
			const spans = trace.getSpans();
			const root = spans.find((s) => s.name === "request:operation:probe")!;
			for (const name of ["ocr.recognize", "stt.transcribe"]) {
				const span = spans.find((s) => s.name === name)!;
				expect(span.parentId).toBe(root.id);
				expect(span.attributes.model).toBe("caller [REDACTED] model");
			}
			expect(received).toHaveLength(3);
			expect(output).toHaveLength(3);
			for (const value of [JSON.stringify(spans), JSON.stringify(received), output.join("\n")]) {
				expect(value).not.toContain(sentinel);
				expect(value).not.toContain(model);
				expect(value).toContain("[REDACTED]");
			}
		} finally {
			print.mockRestore();
		}
	});
});
