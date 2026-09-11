import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { registerDiagnosticValue, withDiagnosticEnv } from "../runtime/diagnostic-env.js";
import { createDiagnosticRedactor } from "../runtime/diagnostic-redactor.js";
import { createOpenAiCompatibleOcrClient } from "../runtime/ocr.js";
import { bindOcrTelemetry, OcrTelemetryCollector } from "../runtime/ocr-telemetry.js";
import { RequestTelemetry } from "../runtime/request-telemetry.js";
import { createCloudflareWorkersAiSttClient } from "../runtime/stt.js";
import { bindSttTelemetry, SttTelemetryCollector } from "../runtime/stt-telemetry.js";
import { createTraceContext } from "../runtime/trace.js";
import { createServerApp, type ProviderServerLogEvent } from "../server/serve.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

const spanIndex = { spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 };
const sentinel = "SENTINEL1234";
const payload = "raw-request-payload-DO-NOT-RETAIN";
const data = Buffer.from(payload).toString("base64");
const signed = "https://files.example.test/image?X-Amz-Signature=runtime-signature-secret";
const token = "runtime-upstream-api-secret";

describe("OCR/STT redaction and retained storage", () => {
	for (const cap of ["ocr", "stt"] as const) {
		const Collector = cap === "ocr" ? OcrTelemetryCollector : SttTelemetryCollector;
		it(`${cap}: dictionary sentinel, runtime authorization echo, signed URL and payload absent in diagnostics/log/header`, async () => {
			expect(sentinel).toHaveLength(12);
			const registry = createDiagnosticRedactor();
			const collector = new Collector({ redact: registry.redact });
			let authorization = "";
			let upstreamBody = "";
			let calls = 0;
			const fakeFetch = Object.assign(
				async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
					calls++;
					authorization = new Headers(init?.headers).get("authorization") ?? "";
					upstreamBody = String(init?.body);
					const error = `${sentinel} echo ${authorization} ${signed} ${data} ${payload}`;
					return cap === "ocr"
						? new Response(error, { status: 403 })
						: Response.json({ error }, { status: 403 });
				},
				fetch,
			);
			await withDiagnosticEnv(
				{ finished: false, observe: () => {}, register: registry.add },
				async () => {
					registerDiagnosticValue(sentinel);
					if (cap === "ocr" && collector instanceof OcrTelemetryCollector) {
						const client = bindOcrTelemetry(
							createOpenAiCompatibleOcrClient({
								baseUrl: "https://ocr.test",
								apiKey: token,
								model: "caller model",
								fetch: fakeFetch,
							}),
							collector,
						);
						await expect(client.recognize({ image: { kind: "base64", data } })).rejects.toThrow(
							"OCR upstream request failed",
						);
					} else if (collector instanceof SttTelemetryCollector) {
						const client = bindSttTelemetry(
							createCloudflareWorkersAiSttClient({
								accountId: "account",
								apiToken: token,
								fetch: fakeFetch,
							}),
							collector,
						);
						await expect(client.transcribe({ audio: { kind: "base64", data } })).rejects.toThrow(
							"STT upstream request failed",
						);
					}
				},
			);
			expect(calls).toBe(1);
			expect(authorization).toBe(`Bearer ${token}`);
			expect(upstreamBody).toContain(data);
			const log = collector.toLogPayload(spanIndex);
			expect(log?.diagnostics?.[0]).toContain("[REDACTED]");
			expect(log?.status).toBe(403);
			expect(
				cap === "ocr" && log && "bytesIn" in log
					? log.bytesIn
					: log && "audioBytes" in log
						? log.audioBytes
						: undefined,
			).toBe(Buffer.byteLength(payload));
			const ledger = new RequestTelemetry(createTraceContext());
			if (collector instanceof OcrTelemetryCollector) ledger.register(collector);
			else ledger.register(collector);
			const header = JSON.parse(Buffer.from(ledger.toHeaderValue() ?? "", "base64url").toString());
			for (const retained of [
				JSON.stringify(log?.diagnostics),
				JSON.stringify(log),
				JSON.stringify(header),
			]) {
				for (const secret of [
					sentinel,
					authorization,
					token,
					signed,
					"runtime-signature-secret",
					payload,
					data,
				])
					expect(retained).not.toContain(secret);
			}
			expect(header[cap]).not.toHaveProperty("diagnostics");
		});
		it(`${cap}: redacts before the 300-unit bound, detaches UTF-16 and fails closed`, () => {
			const seen: string[] = [];
			const collector = new Collector({
				redact: (value) => {
					seen.push(value);
					return value.replaceAll(sentinel, "[REDACTED]");
				},
			});
			const diagnostic = "-".repeat(299) + sentinel + "\ud800";
			collector.record({
				backend: "custom",
				engine: "custom",
				ms: 1,
				model: sentinel + " model",
				diagnostics: diagnostic,
			});
			const log = collector.toLogPayload(spanIndex);
			expect(seen).toContain(diagnostic);
			expect(log?.diagnostics?.[0]).toHaveLength(300);
			expect(log?.model).toBe("[REDACTED] model");
			const throwing = new Collector({
				redact: () => {
					throw new Error("redactor broke");
				},
			});
			throwing.record({
				backend: "custom",
				engine: "custom",
				ms: 0,
				model: "free model",
				diagnostics: "body",
			});
			expect(throwing.toLogPayload(spanIndex)).toMatchObject({
				model: "[REDACTION_FAILED]",
				diagnostics: ["[REDACTION_FAILED]"],
			});
			const utf16 = new Collector({ redact: (value) => value });
			utf16.record({
				backend: "custom",
				engine: "custom",
				ms: 0,
				diagnostics: "-".repeat(299) + "\ud800tail",
			});
			expect(utf16.toLogPayload(spanIndex)?.diagnostics?.[0]?.charCodeAt(299)).toBe(0xd800);
		});
		it(`${cap}: free model is redacted log-only, typed numbers never visit redactor`, () => {
			const seen: string[] = [];
			const collector = new Collector({
				redact: (value) => {
					seen.push(value);
					return value.replaceAll(sentinel, "[REDACTED]");
				},
			});
			collector.record({
				backend: "custom",
				engine: "custom",
				ms: 42,
				model: `private ${sentinel} model`,
			});
			const log = collector.toLogPayload(spanIndex)!;
			expect(log.model).toBe("private [REDACTED] model");
			expect(seen).toEqual([`private ${sentinel} model`]);
			const ledger = new RequestTelemetry(createTraceContext());
			if (collector instanceof OcrTelemetryCollector) ledger.register(collector);
			else ledger.register(collector);
			expect(
				JSON.parse(Buffer.from(ledger.toHeaderValue()!, "base64url").toString())[cap],
			).not.toHaveProperty("model");
		});
		it(`${cap}: structural credential stripping works without a request dictionary`, () => {
			const collector = new Collector();
			collector.record({
				backend: "custom",
				engine: "custom",
				ms: 1,
				diagnostics: `Authorization: Bearer ${token}\nCookie: sid=runtime-cookie\n${signed}`,
			});
			const log = JSON.stringify(collector.toLogPayload(spanIndex));
			for (const value of [token, "runtime-cookie", "runtime-signature-secret"])
				expect(log).not.toContain(value);
		});
		it(`${cap}: 24 samples cap preserves all aggregates and saturates safely`, () => {
			const collector = new Collector();
			for (let i = 0; i < 30; i++)
				collector.record({ backend: "custom", engine: "custom", ms: 1, warnings: 2 });
			expect(collector.toLogPayload(spanIndex)).toMatchObject({
				ms: 30,
				warnings: 60,
				samplesDropped: 6,
			});
			expect(collector.toLogPayload(spanIndex)?.samples).toHaveLength(24);
			collector.record({
				backend: "custom",
				engine: "custom",
				ms: Number.MAX_SAFE_INTEGER,
				warnings: Number.MAX_SAFE_INTEGER,
			});
			expect(collector.toLogPayload(spanIndex)).toMatchObject({
				ms: Number.MAX_SAFE_INTEGER,
				warnings: Number.MAX_SAFE_INTEGER,
			});
		});
		it(`${cap}: GC heap retention matches the P3 2 MiB allowance`, async () => {
			const probe = Bun.spawn({
				cmd: [
					process.execPath,
					new URL("./fixtures/ocr-stt-telemetry-retention.mjs", import.meta.url).pathname,
					new URL(`../runtime/${cap}-telemetry.ts`, import.meta.url).href,
					cap,
				],
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(probe.stdout).text(),
				new Response(probe.stderr).text(),
				probe.exited,
			]);
			expect(code).toBe(0);
			expect(stderr).toBe("");
			const result = JSON.parse(stdout);
			expect(result.lengths).toEqual(Array(25).fill(300));
			expect(result.retainedHeapDelta).toBeLessThan(2 * 1024 * 1024);
		}, 20_000);
	}
	it("runtime registration has a four-character floor and no process-global side effects", () => {
		const registry = createDiagnosticRedactor();
		withDiagnosticEnv({ finished: false, observe: () => {}, register: registry.add }, () => {
			registerDiagnosticValue("abc");
			registerDiagnosticValue("abcd");
		});
		expect(registry.redact("abc abcd")).toBe("abc [REDACTED]");
		registerDiagnosticValue("unscoped-runtime-credential");
		expect(createDiagnosticRedactor().redact("unscoped-runtime-credential")).toBe(
			"unscoped-runtime-credential",
		);
	});
	it("server error echo is absent from every emitted field and decoded header", async () => {
		const original = globalThis.fetch;
		const events: ProviderServerLogEvent[] = [];
		const provider = createProviderDefinitionDouble({
			id: "p6a-echo",
			ocr: { mode: "optional" },
			stt: { mode: "optional" },
			operations: {
				probe: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					handler: async (ctx) => {
						registerDiagnosticValue(sentinel);
						await Promise.allSettled([
							ctx.ocr.recognize({ image: { kind: "url", url: signed } }),
							ctx.stt.transcribe({ audio: { kind: "base64", data } }),
						]);
						throw new Error("upstream failed");
					},
				},
			},
		});
		try {
			globalThis.fetch = Object.assign(
				async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
					Response.json(
						{
							error: `${sentinel} ${new Headers(init?.headers).get("authorization")} ${signed} ${data} ${payload}`,
						},
						{ status: 503 },
					),
				original,
			);
			const app = createServerApp(provider, {
				logger: (event) => events.push(event),
				ocr: createOpenAiCompatibleOcrClient({
					baseUrl: "https://ocr.test",
					model: "private model",
					apiKey: token,
				}),
				stt: createCloudflareWorkersAiSttClient({ accountId: "account", apiToken: token }),
			});
			const response = await app.request("/v1/probe", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "echo-probe", input: {} }),
			});
			expect(response.status).toBe(500);
			const event = events.find((e) => e.event === "provider_request_failed");
			expect(event).toHaveProperty("ocr");
			expect(event).toHaveProperty("stt");
			const header = JSON.parse(
				Buffer.from(response.headers.get("X-ApiFuse-Provider-Telemetry")!, "base64url").toString(),
			);
			expect(header.ocr.status).toBe(503);
			expect(header.stt.status).toBe(503);
			for (const value of [sentinel, token, signed, payload, data]) {
				expect(JSON.stringify(event)).not.toContain(value);
				expect(JSON.stringify(header)).not.toContain(value);
			}
		} finally {
			globalThis.fetch = original;
		}
	});
});
