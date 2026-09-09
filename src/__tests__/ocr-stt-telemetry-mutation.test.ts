import { expect, it } from "bun:test";
import { bindOcrTelemetry, OcrTelemetryCollector } from "../runtime/ocr-telemetry.js";
import { RequestTelemetry } from "../runtime/request-telemetry.js";
import { createTraceContext } from "../runtime/trace.js";
import { assertNamedOcrCell } from "./helpers/ocr-stt-matrix.js";

async function runFakeConstructionSite(ocrTelemetry: OcrTelemetryCollector | null) {
	const ledger = new RequestTelemetry(createTraceContext());
	if (ocrTelemetry) ledger.register(ocrTelemetry);
	const base = {
		recognize: async () => ({ text: "ok", model: "fixture" }),
		extractCaptchaText: async () => ({
			text: "ok",
			candidates: [],
			satisfiesConstraints: true,
			model: "fixture",
		}),
	};
	const ocr = ocrTelemetry ? bindOcrTelemetry(base, ocrTelemetry) : base;
	await ocr.recognize({ image: { kind: "base64", data: "aGVsbG8=" } });
	const encoded = ledger.toHeaderValue();
	return {
		log: ledger.toLogPayload(),
		header: encoded ? JSON.parse(Buffer.from(encoded, "base64url").toString()) : {},
	};
}

it("detects a null OCR sink in both projections at the named matrix cell", async () => {
	const cell = "sync/host//v1/probe/completed";
	assertNamedOcrCell(await runFakeConstructionSite(new OcrTelemetryCollector()), cell);
	const mutated = await runFakeConstructionSite(null);
	expect(() => assertNamedOcrCell(mutated, cell)).toThrow(`OCR sink missing: ${cell}`);
});
