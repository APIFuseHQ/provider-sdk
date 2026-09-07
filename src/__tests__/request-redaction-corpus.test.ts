import { expect, it, spyOn } from "bun:test";
import { z } from "zod";
import { ProviderError } from "../errors.js";
import { createDiagnosticRedactor, REDACTION_FAILED } from "../runtime/diagnostic-redactor.js";
import { resetOTLPExportForTests, swapOTLPTransportForTests } from "../runtime/otlp.js";
import { ResolverTelemetryCollector } from "../runtime/resolver-telemetry.js";
import { getTraceRecorder, type TraceContext } from "../runtime/trace.js";
import { createServerApp } from "../server/serve.js";
import * as traceOutput from "../server/trace-output.js";
import { event } from "../stream.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

// Review-round-2 corpus.test.ts workload, retained with exact non-leak policy pins.
it("preserves critical fields and base64 cursors across 200 realistic secret-free requests", async () => {
	const savedEnvironment = { ...process.env };
	const counts: Array<Record<string, number>> = [];
	try {
		process.env.APIFUSE__TRACE__ENABLED = "true";
		process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test/v1/traces";
		for (const secrets of [[], ["true", "1234", "read", "mail"]]) {
			const surfaces: Record<string, string[]> = {
				getSpans: [],
				onSpan: [],
				json: [],
				console: [],
				otlp: [],
				logs: [],
				resolver: [],
				causeChain: [],
				body: [],
				headers: [],
				sse: [],
			};
			let exporter = "json";
			const traces: TraceContext[] = [];
			const original = traceOutput.resolveServerTraceContextOptions;
			const hook = spyOn(traceOutput, "resolveServerTraceContextOptions").mockImplementation(
				(...args) => {
					const options = original(...args);
					return {
						...options,
						onSpan: (span) => {
							surfaces.onSpan.push(JSON.stringify(span));
							options.onSpan?.(span);
						},
					};
				},
			);
			const print = spyOn(console, "log").mockImplementation((line) => {
				surfaces[exporter].push(String(line));
			});
			swapOTLPTransportForTests(
				Object.assign(
					async (_url: string | URL | Request, init?: RequestInit) => {
						surfaces.otlp.push(String(init?.body));
						return new Response(null, { status: 200 });
					},
					{ preconnect: global.fetch.preconnect },
				),
			);
			for (let i = 0; i < secrets.length; i++) process.env[`CORPUS_SECRET_${i}`] = secrets[i];
			const provider = createProviderDefinitionDouble({
				id: "catalog-provider",
				secrets: secrets.map((_, i) => ({ name: `CORPUS_SECRET_${i}` })),
				operations: {
					inspect: {
						riskClass: "read",
						input: z.object({ index: z.number() }),
						output: z.unknown(),
						handler: async (ctx, input) => {
							traces.push(ctx.trace as TraceContext);
							const i = z.object({ index: z.number() }).parse(input).index;
							await getTraceRecorder(ctx.trace)!.runSpan("catalog.lookup", () => {}, {
								attributes: {
									"http.method": "GET",
									"http.status_code": i % 4 === 0 ? 503 : 200,
									"http.url": "https://catalog.example/orders?page=2",
									duration_ms: 1234,
									available: true,
									cursor: "dHJ1ZQ==",
									message: "Cannot read mailbox; retry after 30 seconds",
									rows: 20,
								},
							});
							if (i % 4 === 0)
								throw new ProviderError("Cannot read mailbox; retry after 30 seconds", {
									code: "mail_unavailable",
									cause: new Error("Cannot read mailbox"),
								});
							if (i % 4 === 1)
								return new Response("cursor=dHJ1ZQ==; Cannot read mailbox", { status: 503 });
							return { rows: 20, cursor: "dHJ1ZQ==", available: true };
						},
					},
				},
			});
			const baseOperation = provider.operations.inspect;
			provider.operations.stream = {
				...baseOperation,
				transport: { kind: "sse", events: { ready: z.object({ rows: z.number() }) } },
				handler: async function* (ctx) {
					await baseOperation.handler(ctx, { index: 2 });
					yield event("ready", { rows: 20 });
					throw new Error("Cannot read mailbox");
				},
			};
			try {
				const app = createServerApp(provider, {
					logger: (entry) => {
						surfaces.logs.push(JSON.stringify(entry));
						if (entry.event === "provider_request_failed" && entry.causeChain)
							surfaces.causeChain.push(JSON.stringify(entry.causeChain));
					},
				});
				for (let i = 0; i < 200; i++) {
					exporter = ["json", "console", "otlp"][i % 3];
					process.env.APIFUSE__TRACE__EXPORTER = exporter;
					const stream = i % 5 === 4;
					const response = await app.request(stream ? "/v1/stream" : "/v1/inspect", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ requestId: `req-1234-${i}`, input: { index: i } }),
					});
					const text = await response.text();
					surfaces.body.push(text);
					if (stream) surfaces.sse.push(text);
					await Bun.sleep(1);
					surfaces.headers.push(JSON.stringify([...response.headers]));
				}
				await Bun.sleep(1);
				for (const trace of traces) surfaces.getSpans.push(JSON.stringify(trace.getSpans()));
				const registry = createDiagnosticRedactor(secrets);
				for (let i = 0; i < 200; i++) {
					const collector = new ResolverTelemetryCollector({ redact: registry.redact });
					collector.recordVendorAttempt({
						vendor: "custom",
						phase: "create_task",
						outcome: "error",
						ms: 1234,
						vendorErrorDescription: "Cannot read mailbox",
					});
					surfaces.resolver.push(JSON.stringify(collector.toLogPayload()));
				}
				for (const line of [...surfaces.onSpan, ...surfaces.json, ...surfaces.console]) {
					const span = JSON.parse(line);
					if (span.attributes.request_id !== undefined)
						expect(span.attributes.request_id).toMatch(/^req-1234-\d+$/);
					if (span.attributes.cursor !== undefined) expect(span.attributes.cursor).toBe("dHJ1ZQ==");
					if (span.name === "catalog.lookup") {
						expect(span.attributes.duration_ms).toBe(1234);
						expect(typeof span.attributes["http.status_code"]).toBe("number");
						expect(span.attributes.available).toBe(true);
					}
				}
				for (const line of surfaces.otlp) {
					for (const resource of JSON.parse(line).resourceSpans) {
						const requestId = resource.resource.attributes.find(
							(attribute: { key: string }) => attribute.key === "request_id",
						);
						expect(requestId.value.stringValue).toMatch(/^req-1234-\d+$/);
						for (const scope of resource.scopeSpans)
							for (const span of scope.spans) {
								expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
								expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
								const cursor = span.attributes.find(
									(attribute: { key: string }) => attribute.key === "cursor",
								);
								if (cursor) expect(cursor.value.stringValue).toBe("dHJ1ZQ==");
							}
					}
				}
				for (const line of surfaces.logs) {
					const entry = JSON.parse(line);
					expect(entry.requestId).toMatch(/^req-1234-\d+$/);
					if (entry.code !== undefined)
						expect(entry.code).toBe(
							entry.route === "stream" ? "internal_error" : "mail_unavailable",
						);
				}
				expect(traces).toHaveLength(200);
				counts.push(
					Object.fromEntries(
						Object.entries(surfaces).map(([name, lines]) => [
							name,
							lines.join("\n").match(/\[REDACTED\]/g)?.length ?? 0,
						]),
					),
				);
			} finally {
				hook.mockRestore();
				print.mockRestore();
				swapOTLPTransportForTests();
				resetOTLPExportForTests();
			}
		}
		expect(counts).toEqual([
			{
				getSpans: 0,
				onSpan: 0,
				json: 67,
				console: 67,
				otlp: 66,
				logs: 0,
				resolver: 0,
				causeChain: 0,
				body: 0,
				headers: 0,
				sse: 0,
			},
			{
				getSpans: 320,
				onSpan: 320,
				json: 175,
				console: 174,
				otlp: 132,
				logs: 120,
				resolver: 200,
				causeChain: 40,
				body: 40,
				headers: 0,
				sse: 40,
			},
		]);
	} finally {
		for (const key of Object.keys(process.env))
			if (!(key in savedEnvironment)) delete process.env[key];
		Object.assign(process.env, savedEnvironment);
	}
}, 10000);

// Count benign decode-budget suppression explicitly; zero matches does not imply zero loss.
it("pins benign-percent suppression counts for empty, short-only and percent-encodable inventories", () => {
	const fixtures = [
		"https://example.test/path/%25",
		"50% done",
		"https://example.test/path/%2520space",
		"https://example.test/path/%25252525",
		"50%25252525 done",
	];
	const inventories = [[], ["read", "1234"], ["orchardgrove"], ["orchard yard"]];
	const counts = inventories.map((values) => {
		const registry = createDiagnosticRedactor(values);
		const outputs = fixtures.map(registry.redact);
		expect(outputs).toEqual(
			values.some((value) => value.length >= 8)
				? [...fixtures.slice(0, 3), REDACTION_FAILED, REDACTION_FAILED]
				: fixtures,
		);
		return outputs.filter((value) => value === REDACTION_FAILED).length;
	});
	expect(counts).toEqual([0, 0, 2, 2]);
});
