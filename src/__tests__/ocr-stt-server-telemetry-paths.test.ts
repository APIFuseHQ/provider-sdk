import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ProviderError } from "../errors.js";
import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";
import { registerDiagnosticValue } from "../runtime/diagnostic-env.js";
import { OcrTelemetryCollector, type OcrTelemetryLogPayload } from "../runtime/ocr-telemetry.js";
import { PROVIDER_TELEMETRY_HEADER } from "../runtime/request-telemetry.js";
import { SttTelemetryCollector, type SttTelemetryLogPayload } from "../runtime/stt-telemetry.js";
import type { TraceContext } from "../runtime/trace.js";
import {
	createServerApp,
	createServerAppAsync,
	type ProviderServerLogEvent,
} from "../server/serve.js";
import { statefulSignedHeaders } from "../stateful-signing.js";
import type { ProviderContext } from "../types.js";
import { assertNamedOcrCell } from "./helpers/ocr-stt-matrix.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

const paths = [
	"/v1/probe",
	"/auth/start",
	"/auth/continue",
	"/auth/poll",
	"/auth/disconnect",
	"/auth/refresh",
	"/__apifuse/stateful/operations",
] as const;
const secret = "p6a-stateful-signing-secret";
const models = { ocr: "operator free model SENTINEL1234", stt: "operator free model SENTINEL1234" };
type Outcome = "completed" | "failed" | "unused-completed" | "unused-failed";

async function probe(
	path: (typeof paths)[number],
	outcome: Outcome,
	factory: "sync" | "async",
	source: "host" | "env",
) {
	const used = !outcome.startsWith("unused");
	const failed = outcome.endsWith("failed");
	const calls = { ocr: 0, stt: 0 };
	let requestTrace: TraceContext | undefined;
	const upstreamError = new ProviderError("fake upstream failed", { code: "FAKE_UPSTREAM" });
	async function invoke(ctx: Pick<ProviderContext, "ocr" | "stt" | "trace">) {
		requestTrace = ctx.trace as TraceContext;
		registerDiagnosticValue("SENTINEL1234");
		if (used) {
			// Both contributors must survive a request that eventually fails.
			const results = await Promise.allSettled([
				ctx.ocr.recognize({ image: { kind: "base64", data: "cGF5bG9hZA==" } }),
				ctx.stt.transcribe({ audio: { kind: "base64", data: "cGF5bG9hZA==" } }),
			]);
			if (failed) throw results.find((r) => r.status === "rejected")?.reason ?? upstreamError;
		}
		if (failed) throw upstreamError;
		return { ok: true };
	}
	const auth = async (ctx: Pick<ProviderContext, "ocr" | "stt" | "trace">) => {
		await invoke(ctx);
		return { kind: "complete", turnId: "done" } as const;
	};
	const provider = createProviderDefinitionDouble({
		id: "p6a-paths",
		ocr: { mode: "optional" },
		stt: { mode: "optional" },
		auth: {
			mode: "credentials",
			flow: { start: auth, continue: auth, poll: auth, abort: auth, refresh: auth },
		},
		operations: {
			probe: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: invoke,
			},
		},
	});
	const events: ProviderServerLogEvent[] = [];
	const originalFetch = globalThis.fetch;
	const environment = {
		APIFUSE__OCR__BACKEND: "openai-compatible",
		APIFUSE__OCR__MODEL: "zai-org/GLM-OCR",
		APIFUSE__OCR__BASE_URL: "https://ocr.example.test/v1",
		APIFUSE__STT__BACKEND: "cloudflare-workers-ai",
		APIFUSE__CLOUDFLARE__ACCOUNT_ID: "test-account",
		APIFUSE__STT__CLOUDFLARE_API_TOKEN: "test-stt-token",
	};
	const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
	try {
		if (source === "env") {
			Object.assign(process.env, environment);
			globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
				const cap = String(input).includes("ocr.example") ? "ocr" : "stt";
				calls[cap]++;
				return Response.json(
					failed
						? { error: "upstream unavailable" }
						: cap === "ocr"
							? { choices: [{ finish_reason: "stop", message: { content: "ok" } }] }
							: { result: { text: "ok", durationMs: 12 } },
					{ status: failed ? 503 : 200 },
				);
			}, originalFetch);
		}
		const app = await (factory === "sync" ? createServerApp : createServerAppAsync)(provider, {
			logger: (event) => events.push(event),
			statefulForwarding: { secret, validateOwnerFence: async () => true },
			internalOperationExecutor: async ({ ctx }) => invoke(ctx),
			...(source === "host"
				? {
						ocr: {
							recognize: async () => {
								calls.ocr++;
								if (failed) throw upstreamError;
								return { text: "ok", model: models.ocr };
							},
							extractCaptchaText: async () => {
								throw new Error("unused");
							},
						},
						stt: {
							transcribe: async () => {
								calls.stt++;
								if (failed) throw upstreamError;
								return { text: "ok", durationMs: 12 };
							},
							extractVerificationCode: () => ({
								code: "1234",
								candidates: [],
								normalizedText: "1234",
							}),
						},
					}
				: {}),
		});
		const requestId = `${factory}-${source}-${path}-${outcome}`;
		const operationRequest = { requestId, input: {} };
		const timestamp = new Date().toISOString();
		const body = JSON.stringify(
			path === "/__apifuse/stateful/operations"
				? {
						requestId,
						providerId: provider.id,
						operationId: "probe",
						sessionKey: "p6a:account:connection",
						connectionId: "connection-1",
						serviceAccountId: "account-1",
						ownerPodId: "owner",
						generation: 7,
						sourcePodId: "source",
						forwardedAt: timestamp,
						operationRequest,
					}
				: path === "/v1/probe"
					? operationRequest
					: {
							requestId,
							flowId: "flow-1",
							providerId: provider.id,
							tenantId: "tenant-1",
							connectionId: "connection-1",
							context: {},
							input: {},
						},
		);
		const response = await app.request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(path === "/__apifuse/stateful/operations"
					? {
							"x-apifuse-stateful-source-pod": "source",
							...statefulSignedHeaders({ secret, timestamp, rawBody: body, method: "POST", path }),
						}
					: {}),
			},
			body,
		});
		const terminal = events.filter(
			(e) => e.event === "provider_request_completed" || e.event === "provider_request_failed",
		);
		expect(terminal).toHaveLength(1);
		const event = terminal[0] as ProviderServerLogEvent & {
			ocr?: OcrTelemetryLogPayload;
			stt?: SttTelemetryLogPayload;
		};
		expect(event.event).toBe(`provider_request_${failed ? "failed" : "completed"}`);
		expect(failed ? response.status >= 400 : response.status === 200).toBe(true);
		const encoded = response.headers.get(PROVIDER_TELEMETRY_HEADER);
		const header = encoded ? JSON.parse(Buffer.from(encoded, "base64url").toString()) : {};
		expect(calls).toEqual({ ocr: used ? 1 : 0, stt: used ? 1 : 0 });
		if (used) {
			assertNamedOcrCell({ log: event, header }, `${factory}/${source}/${path}/${outcome}`);
			expect(event.stt, `STT sink missing: ${factory}/${source}/${path}/${outcome}`).toBeDefined();
			if (!event.ocr || !event.stt) throw new Error("Missing capability telemetry");
			const spans = requestTrace!.getSpans();
			const root = spans.find((s) => s.name.startsWith("request:"));
			expect(root).toBeDefined();
			for (const name of ["ocr.recognize", "stt.transcribe"]) {
				const span = spans.find((s) => s.name === name);
				expect(span?.parentId).toBe(root?.id);
				expect(JSON.stringify(span?.attributes)).not.toContain("SENTINEL1234");
			}
			expect(event.ocr.samples).toHaveLength(1);
			expect(event.stt.samples).toHaveLength(1);
			expect(header.v).toBe(1);
			expect(header.taxonomy).toBe(PROVIDER_OBSERVABILITY_TAXONOMY_VERSION);
			expect(header.ocr).toEqual(new OcrTelemetryCollector().toHeaderPayload(event.ocr));
			expect(header.stt).toEqual(new SttTelemetryCollector().toHeaderPayload(event.stt));
			expect(Object.keys(header).indexOf("ocr")).toBeLessThan(Object.keys(header).indexOf("stt"));
			expect(event.ocr.backend).toBe(source === "host" ? "custom" : "openai-compatible");
			expect(event.ocr.engine).toBe(source === "host" ? "custom" : "openai-compatible");
			expect(event.stt.backend).toBe(source === "host" ? "custom" : "cloudflare-workers-ai");
			if (source === "env") expect(header.ocr.status).toBe(failed ? 503 : 200);
			if (
				process.env.P6A_EVIDENCE === "1" &&
				factory === "sync" &&
				source === "env" &&
				path === "/v1/probe"
			)
				console.log(
					"P6A_SAMPLE",
					JSON.stringify({ event: event.event, ocr: event.ocr, stt: event.stt, header }),
				);
		} else {
			for (const key of ["ocr", "stt"]) {
				expect(event).not.toHaveProperty(key);
				expect(header).not.toHaveProperty(key);
			}
		}
	} finally {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
describe("OCR/STT construction-path sink matrix", () => {
	for (const factory of ["sync", "async"] as const)
		for (const source of ["host", "env"] as const)
			for (const path of paths)
				for (const outcome of [
					"completed",
					"failed",
					"unused-completed",
					"unused-failed",
				] as const) {
					it(`${factory}/${source} ${outcome} ${path}: emitted log and decoded header parity`, () =>
						probe(path, outcome, factory, source));
				}
});
