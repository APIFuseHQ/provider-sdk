import type { OcrContext, SttContext } from "../types.js";
import { describe, expect, it } from "bun:test";
import { wrapWithInstrumentation } from "../runtime/instrumentation.js";
import { bindOcrTelemetry, OcrTelemetryCollector } from "../runtime/ocr-telemetry.js";
import { RequestTelemetry } from "../runtime/request-telemetry.js";
import { bindSttTelemetry, SttTelemetryCollector } from "../runtime/stt-telemetry.js";
import { createTraceContext } from "../runtime/trace.js";

describe("ocr and stt telemetry", () => {
	it("records bounded redacted OCR failures and projects a closed header", () => {
		const collector = new OcrTelemetryCollector({
			redact: (text) => text.replaceAll("SECRET", "[x]"),
		});
		collector.record({
			backend: "custom",
			engine: "custom",
			ms: 2,
			diagnostics: "SECRET".repeat(100),
			errorCode: "other",
			finishReason: "error",
		});
		const log = collector.toLogPayload({
			spans: [],
			byName: new Map(),
			count: () => 0,
			durationMs: () => 0,
		});
		expect(log?.samples?.[0]?.ms).toBe(2);
		expect(log?.samples?.[0]).not.toHaveProperty("diagnostics");
		const telemetry = new RequestTelemetry(createTraceContext());
		telemetry.register(collector);
		const decoded = JSON.parse(
			Buffer.from(
				telemetry.toHeaderValue()!.replace(/-/g, "+").replace(/_/g, "/"),
				"base64",
			).toString(),
		);
		expect(decoded.ocr.backend).toBe("custom");
	});

	it("observes OCR and STT operations without changing results", async () => {
		const ocr = new OcrTelemetryCollector();
		const ocrContext = bindOcrTelemetry(
			{
				recognize: async () => ({ text: "ok", model: "m" }),
				extractCaptchaText: async () => ({
					text: "ok",
					candidates: [],
					satisfiesConstraints: true,
					model: "m",
				}),
			},
			ocr,
		);
		await ocrContext.recognize({ image: { kind: "base64", data: "aGVsbG8=" } });
		expect(
			ocr.toLogPayload({ spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 })
				?.bytesIn,
		).toBe(5);
		const stt = new SttTelemetryCollector();
		const sttContext = bindSttTelemetry(
			{
				transcribe: async () => ({
					text: "ok",
					durationMs: 10,
					usage: { audioBytes: 4, audioDurationMs: 10 },
				}),
				extractVerificationCode: () => ({ code: "1234", candidates: [], normalizedText: "1234" }),
			},
			stt,
		);
		await sttContext.transcribe({ audio: { kind: "base64", data: "aGVsbG8=" } });
		expect(
			stt.toLogPayload({ spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 })
				?.audioBytes,
		).toBe(4);
	});

	it("enrols OCR and STT namespaces in instrumentation", async () => {
		const spans: any[] = [];
		const trace = createTraceContext({ onSpan: (span) => spans.push(span) });
		const ctx = wrapWithInstrumentation<{
			trace: ReturnType<typeof createTraceContext>;
			ocr: OcrContext;
			stt: SttContext;
		}>({
			trace,
			ocr: {
				recognize: async () => ({ text: "ok", model: "m" }),
				extractCaptchaText: async () => ({
					text: "ok",
					candidates: [],
					satisfiesConstraints: true,
					model: "m",
				}),
			},
			stt: {
				transcribe: async () => ({ text: "ok" }),
				extractVerificationCode: () => ({ code: "1", candidates: [], normalizedText: "1" }),
			},
		});
		await ctx.ocr.recognize({ image: { kind: "url", url: "https://example.test/x" } });
		await ctx.stt.transcribe({ audio: { kind: "base64", data: "aGVsbG8=" } });
		expect(spans.some((span) => span.name === "ocr.recognize")).toBe(true);
		expect(spans.some((span) => span.name === "stt.transcribe")).toBe(true);
	});
});
