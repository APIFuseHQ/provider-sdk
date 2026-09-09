import { describe, expect, it } from "bun:test";
import {
	capabilityText,
	inputBytes,
	registerCapabilityInput,
} from "../runtime/capability-telemetry.js";
import { withDiagnosticEnv } from "../runtime/diagnostic-env.js";
import { createDiagnosticRedactor, REDACTION_FAILED } from "../runtime/diagnostic-redactor.js";
import {
	createCloudflareWorkersAiOcrClient,
	createOpenAiCompatibleOcrClient,
} from "../runtime/ocr.js";
import { bindOcrTelemetry, OcrTelemetryCollector } from "../runtime/ocr-telemetry.js";
import { RequestTelemetry } from "../runtime/request-telemetry.js";
import { createCloudflareWorkersAiSttClient } from "../runtime/stt.js";
import { bindSttTelemetry, SttTelemetryCollector } from "../runtime/stt-telemetry.js";
import { createTraceContext } from "../runtime/trace.js";

const spans = { spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 };
const smallInput = Buffer.from("probe input").toString("base64");

describe("OCR/STT adversarial privacy regressions", () => {
	it("registers bare and header-shaped bearer secrets with P4 encoding variants", async () => {
		const token = "token-Secret+/89";
		const echoes = [
			token,
			`Bearer ${token}`,
			Buffer.from(token).toString("base64"),
			encodeURIComponent(token),
		];
		const factories = [
			{
				name: "OCR Cloudflare",
				make: (fetch: typeof globalThis.fetch) =>
					createCloudflareWorkersAiOcrClient({ accountId: "a", apiToken: token, fetch }),
			},
			{
				name: "OCR OpenAI compatible",
				make: (fetch: typeof globalThis.fetch) =>
					createOpenAiCompatibleOcrClient({
						baseUrl: "https://ocr.invalid",
						model: "model",
						apiKey: token,
						fetch,
					}),
			},
		];
		for (const factory of factories) {
			const registry = createDiagnosticRedactor();
			const collector = new OcrTelemetryCollector({ redact: registry.redact });
			const fetch = Object.assign(
				async () =>
					new Response(echoes.map((echo) => `denied ${echo}`).join("\n"), { status: 403 }),
				globalThis.fetch,
			);
			const client = factory.make(fetch);
			const inspected = bindOcrTelemetry(client, collector);
			await withDiagnosticEnv({ finished: false, observe: () => {}, register: registry.add }, () =>
				inspected.recognize({ image: { kind: "base64", data: smallInput } }).catch(() => {}),
			);
			const serialized = JSON.stringify(collector.toLogPayload(spans));
			expect(registry.has(token)).toBe(true);
			expect(registry.has(`Bearer ${token}`)).toBe(true);
			expect(serialized).toContain("denied [REDACTED]");
			for (const echo of echoes) expect(serialized, `${factory.name}: ${echo}`).not.toContain(echo);
			const ledger = new RequestTelemetry(createTraceContext());
			ledger.register(collector);
			const header = JSON.parse(Buffer.from(ledger.toHeaderValue()!, "base64url").toString());
			expect(header.ocr.status).toBe(403);
			for (const echo of echoes) expect(JSON.stringify(header)).not.toContain(echo);
		}

		const registry = createDiagnosticRedactor();
		const collector = new SttTelemetryCollector({ redact: registry.redact });
		const fetch = Object.assign(
			async () => new Response(echoes.map((echo) => `denied ${echo}`).join("\n"), { status: 403 }),
			globalThis.fetch,
		);
		const client = bindSttTelemetry(
			createCloudflareWorkersAiSttClient({ accountId: "a", apiToken: token, fetch }),
			collector,
		);
		await withDiagnosticEnv({ finished: false, observe: () => {}, register: registry.add }, () =>
			client.transcribe({ audio: { kind: "base64", data: smallInput } }).catch(() => {}),
		);
		const serialized = JSON.stringify(collector.toLogPayload(spans));
		expect(registry.has(token)).toBe(true);
		expect(registry.has(`Bearer ${token}`)).toBe(true);
		expect(serialized).toContain("denied [REDACTED]");
		for (const echo of echoes) expect(serialized, `STT: ${echo}`).not.toContain(echo);
		const ledger = new RequestTelemetry(createTraceContext());
		ledger.register(collector);
		const header = JSON.parse(Buffer.from(ledger.toHeaderValue()!, "base64url").toString());
		expect(header.stt.status).toBe(403);
		for (const echo of echoes) expect(JSON.stringify(header)).not.toContain(echo);
	});

	it("does not register a 5 MiB payload and keeps redaction lookup below 5 ms", () => {
		const raw = Buffer.alloc(5 * 1024 * 1024, 7);
		const data = raw.toString("base64");
		const registry = createDiagnosticRedactor();
		const registered: string[] = [];
		const started = performance.now();
		withDiagnosticEnv(
			{
				finished: false,
				observe: () => {},
				register: (values) => {
					registered.push(...values);
					registry.add(values);
				},
			},
			() => registerCapabilityInput({ kind: "base64", data }),
		);
		const registryMs = performance.now() - started;
		const redactStarted = performance.now();
		registry.redact("x".repeat(300));
		const redactMs = performance.now() - redactStarted;
		expect(registered).toHaveLength(0);
		expect(registry.has(data)).toBe(false);
		expect(registry.has(raw.toString("utf8"))).toBe(false);
		expect(inputBytes({ kind: "base64", data })).toBe(raw.length);
		expect(registryMs).toBeLessThan(50);
		expect(redactMs).toBeLessThan(5);
	});

	it("registers signed URLs only through the 2 KiB boundary", () => {
		const registered: string[] = [];
		withDiagnosticEnv(
			{ finished: false, observe: () => {}, register: (values) => registered.push(...values) },
			() => {
				registerCapabilityInput({ kind: "url", url: "s".repeat(2048) });
				registerCapabilityInput({ kind: "url", url: "l".repeat(2049) });
			},
		);
		expect(registered).toEqual(["s".repeat(2048)]);
	});

	it("strips data URLs and long base64 before redaction while retaining exact input bytes", async () => {
		const raw = Buffer.alloc(150, 11);
		const data = raw.toString("base64");
		for (const cap of ["ocr", "stt"] as const) {
			const seen: string[] = [];
			const redact = (text: string) => {
				seen.push(text);
				return text;
			};
			const collector =
				cap === "ocr"
					? new OcrTelemetryCollector({ redact })
					: new SttTelemetryCollector({ redact });
			const body = `fragment: ${data} image=data:image/png;base64,${data}`;
			const fetch = Object.assign(
				async () => new Response(body, { status: 403 }),
				globalThis.fetch,
			);
			if (collector instanceof OcrTelemetryCollector) {
				const client = bindOcrTelemetry(
					createOpenAiCompatibleOcrClient({ baseUrl: "https://ocr.invalid", model: "m", fetch }),
					collector,
				);
				await client.recognize({ image: { kind: "base64", data } }).catch(() => {});
				expect(collector.toLogPayload(spans)?.bytesIn).toBe(raw.length);
			} else {
				const client = bindSttTelemetry(
					createCloudflareWorkersAiSttClient({ accountId: "a", apiToken: "token", fetch }),
					collector,
				);
				await client.transcribe({ audio: { kind: "base64", data } }).catch(() => {});
				expect(collector.toLogPayload(spans)?.audioBytes).toBe(raw.length);
			}
			const diagnostic = seen.find((value) => value.includes("[BASE64_STRIPPED]"));
			expect(diagnostic, `${cap}: ${JSON.stringify(seen)}`).toBeDefined();
			expect(diagnostic?.match(/\[BASE64_STRIPPED\]/g)).toHaveLength(2);
			expect(diagnostic).toContain("fragment: [BASE64_STRIPPED]");
			expect(diagnostic).toContain("image=[BASE64_STRIPPED]");
			expect(diagnostic).not.toContain(data);
		}
	});

	it("fails closed for every malformed diagnostic redactor result", () => {
		for (const invalid of [undefined, null, 42, {}, Symbol("invalid")]) {
			// test-invalid: public JavaScript callers can return values outside the TypeScript contract.
			expect(capabilityText("secret", (() => invalid) as (text: string) => string)).toBe(
				REDACTION_FAILED,
			);
		}
		expect(
			capabilityText("secret", () => {
				throw new Error("redactor failed");
			}),
		).toBe(REDACTION_FAILED);
		expect(capabilityText("secret", () => "safe")).toBe("safe");
	});
});
