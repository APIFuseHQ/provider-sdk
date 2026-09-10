import { describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";
import {
	ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES,
	ENGINE_OWNED_RESOLVER_CREDENTIAL_ENV_NAMES,
} from "../engine.js";
import { ProviderError } from "../errors.js";
import * as browserRuntime from "../runtime/browser.js";
import * as diagnosticRedactor from "../runtime/diagnostic-redactor.js";
import { wrapWithInstrumentation } from "../runtime/instrumentation.js";
import { registerResolverTelemetryBinding } from "../runtime/resolver-shared.js";
import { createMemoryProviderRuntimeState } from "../runtime/state.js";
import { getTraceRecorder, type Span, type TraceContext } from "../runtime/trace.js";
import {
	PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_ENV,
	PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_PREVIOUS_ENV,
} from "../server/self-test-token.js";
import {
	DIAGNOSTIC_SENSITIVE_SOURCE_KINDS,
	type DiagnosticSensitiveSourceKind,
} from "../server/sensitive-values.js";
import { createServerApp, type ProviderServerLogEvent } from "../server/serve.js";
import * as traceOutput from "../server/trace-output.js";
import { event } from "../stream.js";
import type { FlowContext, ProviderContext, ResolverContext } from "../types.js";
import {
	createBrowserClientDouble,
	createBrowserPageDouble,
	createProviderDefinitionDouble,
} from "./test-utils.js";

type SourceKind = DiagnosticSensitiveSourceKind;
type RegistryFixture = { source: SourceKind; env?: string; value: string };
type Shape = "dictionary" | "uuid" | "hex";
const SOURCE_FIXTURE: ReadonlyArray<{ source: SourceKind; env?: string }> = [
	{ source: "selfTestMasterSecrets", env: PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_ENV },
	{ source: "selfTestMasterSecrets", env: PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_PREVIOUS_ENV },
	{ source: "providerSecrets", env: "P4_PROVIDER_SECRET" },
	{ source: "healthProbeSecrets", env: "P4_PROBE_REQUIRED" },
	{ source: "healthProbeSecrets", env: "P4_PROBE_CREDENTIAL" },
	{ source: "requestCredentials" },
	...ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES.map((env) => ({
		source: "engineProxyCredentials" as const,
		env,
	})),
	...ENGINE_OWNED_RESOLVER_CREDENTIAL_ENV_NAMES.map((env) => ({
		source: "engineSolverKeys" as const,
		env,
	})),
	{ source: "engineCeremonyLeaseCredentials", env: "APIFUSE__ENGINE__CEREMONY_LEASE_KEY" },
	{ source: "engineClientCredentials", env: "APIFUSE__ENGINE__API_KEY" },
	{ source: "ocrCredentials", env: "APIFUSE__OCR__CLOUDFLARE_API_TOKEN" },
	{ source: "ocrCredentials", env: "APIFUSE__OCR__API_KEY" },
	{ source: "sttCredentials", env: "APIFUSE__STT__CLOUDFLARE_API_TOKEN" },
	{ source: "cdpCredentials", env: "APIFUSE__CDP_POOL__URL" },
	{ source: "statefulForwardingSecret" },
	{ source: "redisCredentials", env: "APIFUSE__REDIS__URL" },
	{ source: "otlpHeaders", env: "OTEL_EXPORTER_OTLP_HEADERS" },
	{ source: "cacheKeyPepper", env: "APIFUSE__CACHE__KEY_PEPPER" },
	{ source: "sensitiveParams" },
];
function registryFixture(shape: Shape): RegistryFixture[] {
	return SOURCE_FIXTURE.map((entry, index) => ({
		...entry,
		value:
			shape === "dictionary"
				? `hrfcokey${1234 + index}`
				: shape === "uuid"
					? `c839a012-fb3a-4cde-8123-${String(123456789100 + index)}`
					: `d41d8cd98f00b204e9800998${String(1234567890 + index)}`,
	}));
}

function hasRuntimeSpans(trace: ProviderContext["trace"]): trace is TraceContext {
	return "getSpans" in trace && typeof trace.getSpans === "function";
}

/** A real provider handler drives the scope; only external browser/vendor I/O is replaced. */
async function exerciseServer(shape: Shape, throwing = false): Promise<void> {
	const fixtures = registryFixture(shape);
	expect([...new Set(fixtures.map((entry) => entry.source))]).toEqual([
		...DIAGNOSTIC_SENSITIVE_SOURCE_KINDS,
	]);
	const secrets = fixtures.map(({ value }) => value);
	const text = secrets.join(" ");
	// Distinct static/request matches suppress the whole field to cover overlapping credentials.
	const bySource = (source: SourceKind) => fixtures.find((entry) => entry.source === source)!.value;
	const env = Object.fromEntries(
		fixtures
			.filter((entry) => entry.env)
			.map((entry) => [
				entry.env!,
				// Runtime-owned credential readers trim env values before using them.
				entry.source === "cdpCredentials"
					? `ws://localhost/${entry.value}`
					: entry.source === "redisCredentials"
						? `redis://:${entry.value}@localhost:6379`
						: entry.source === "otlpHeaders"
							? `authorization=${entry.value}`
							: [
										"selfTestMasterSecrets",
										"engineProxyCredentials",
										"engineSolverKeys",
										"engineCeremonyLeaseCredentials",
									].includes(entry.source)
								? `\t${entry.value}\n`
								: entry.value,
			]),
	);
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries({
		...env,
		APIFUSE__TRACE__ENABLED: "true",
		APIFUSE__TRACE__EXPORTER: "json",
	})) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}
	const surfaces: Record<string, string[]> = {
		getSpans: [],
		onSpan: [],
		json: [],
		console: [],
		failed: [],
		completed: [],
		resolver: [],
		causeChain: [],
		sse: [],
	};
	const traceRefs: TraceContext[] = [];
	let exporter = "json";
	const originalTraceOptions = traceOutput.resolveServerTraceContextOptions;
	const hook = spyOn(traceOutput, "resolveServerTraceContextOptions").mockImplementation(
		(...args) => {
			const options = originalTraceOptions(...args);
			return {
				...options,
				onSpan: (span: Span) => {
					surfaces.onSpan!.push(JSON.stringify(span));
					options.onSpan?.(span);
				},
			};
		},
	);
	const print = spyOn(console, "log").mockImplementation((value) => {
		surfaces[exporter]!.push(String(value));
	});
	const throwingSpy = throwing
		? spyOn(diagnosticRedactor, "createDiagnosticRedactor").mockReturnValue({
				redact: () => {
					throw new Error(text);
				},
				add: () => {},
				has: () => false,
				suppress: () => {},
				suppressed: false,
				redactStructured: () => {
					throw new Error(text);
				},
				redactCritical: () => {
					throw new Error(text);
				},
			})
		: undefined;
	const navigations: string[] = [];
	const page = createBrowserPageDouble({
		goto: async (url) => {
			navigations.push(url);
		},
		click: async (selector) => {
			navigations.push(selector);
		},
	});
	const browser = spyOn(browserRuntime.BrowserClient.prototype, "newPage").mockImplementation(
		async () => page,
	);
	const upstream = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
	const resolver: ResolverContext = {
		async solve() {
			return { form: "token", token: "solved" };
		},
	};
	registerResolverTelemetryBinding(resolver, (sink) => ({
		async solve(challenge) {
			sink.recordVendorAttempt({
				vendor: "custom",
				phase: "create_task",
				outcome: "error",
				ms: 1,
				vendorErrorDescription: `vendor ${text}`,
				diagnostics: { cause: { name: "Error", message: `vendor cause ${text}` } },
			});
			sink.recordOutcome({ outcome: "solved", solveMs: 1, challengeKind: challenge.kind });
			return { form: "token", token: "solved" };
		},
	}));
	const observe = async (ctx: ProviderContext | FlowContext) => {
		if (!hasRuntimeSpans(ctx.trace)) throw new Error("request scope trace has no getSpans");
		traceRefs.push(ctx.trace);
		// Registers the existing per-call sensitiveParams before its path attribute is recorded.
		await ctx.http.get(`${upstream.url}path/${secrets.join("/")}`, {
			sensitiveParams: { ordinary: bySource("sensitiveParams") },
		});
		const browserContext =
			"browser" in ctx
				? ctx
				: wrapWithInstrumentation({
						trace: ctx.trace,
						browser: createBrowserClientDouble({ newPage: async () => page }),
					});
		const currentPage = await browserContext.browser.newPage();
		await currentPage.goto(`https://example.test/page/${secrets.join("/")}`);
		await currentPage.click(`[data-reference="${text}"]`);
		const state = ctx.state!.namespace("redaction", {
			defaultTtl: "1m",
			maxTtl: "1m",
			maxEntries: 8,
			maxValueBytes: 1024,
		});
		await state.set(`entry/${secrets.join("/")}`, { ok: true });
		await state.set("operator-readable-key", { ok: true });
		await ctx.resolver.solve({
			kind: "recaptcha_v2",
			pageUrl: "https://example.test",
			siteKey: "public-site",
		});
		await getTraceRecorder(ctx.trace)!
			.runSpan(
				"provider.diagnostic",
				async () => {
					throw new Error(`trace ${text}`);
				},
				{ attributes: { diagnostic: `detail ${text}` } },
			)
			.catch(() => undefined);
	};
	const failure = () =>
		new ProviderError(`failed ${text}`, {
			code: "UPSTREAM_ERROR",
			cause: new Error(`cause ${text}`),
		});
	const provider = createProviderDefinitionDouble({
		runtime: "browser",
		browser: { engine: "playwright-stealth" },
		http: {},
		cache: {},
		state: {},
		resolver: { kinds: ["recaptcha_v2"] },
		secrets: [{ name: "P4_PROVIDER_SECRET", required: true }],
		healthProbe: {
			requiredSecrets: ["P4_PROBE_REQUIRED"],
			credentialInputs: { password: "P4_PROBE_CREDENTIAL" },
		},
		credential: { keys: ["password"] },
		auth: {
			mode: "credentials",
			flow: {
				async start() {
					return { kind: "form", turnId: "p4" };
				},
				async continue(ctx) {
					await observe(ctx);
					throw failure();
				},
			},
		},
		operations: {
			fail: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async (ctx) => {
					await observe(ctx);
					throw failure();
				},
			},
			complete: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async (ctx) => {
					await observe(ctx);
					return { ok: true };
				},
			},
			stream: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				transport: { kind: "sse", events: { ready: z.object({ ok: z.boolean() }) } },
				async *handler(ctx) {
					await observe(ctx);
					yield event("ready", { ok: true });
					throw failure();
				},
			},
		},
	});
	const events: ProviderServerLogEvent[] = [];
	try {
		for (const selectedExporter of ["json", "console"]) {
			exporter = selectedExporter;
			process.env.APIFUSE__TRACE__EXPORTER = selectedExporter;
			const app = createServerApp(provider, {
				state: createMemoryProviderRuntimeState(),
				resolver,
				logger: (entry) => events.push(entry),
				statefulForwarding: {
					secret: bySource("statefulForwardingSecret"),
					validateOwnerFence: () => true,
				},
				internalOperationExecutor: async () => ({ ok: true }),
			});
			for (const operation of ["fail", "complete", "stream"]) {
				const response = await app.request(`/v1/${operation}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						requestId: `p4-${selectedExporter}-${operation}`,
						input: {},
						connection: {
							id: "p4-connection",
							mode: "credentials",
							secrets: { password: bySource("requestCredentials") },
							metadata: {},
							externalRef: "p4-external",
						},
					}),
				});
				const body = await response.text();
				expect(response.status, body).toBe(operation === "fail" ? 502 : 200);
				if (operation === "stream") {
					expect(body).toContain('"code":"stream_error"');
					surfaces.sse!.push(body);
				}
			}
			// Auth input is the second entry branch of requestCredentials; no connection is supplied.
			const authResponse = await app.request("/auth/continue", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: `p4-${selectedExporter}-auth`,
					flowId: "p4-auth",
					input: { password: bySource("requestCredentials") },
				}),
			});
			expect(authResponse.status).toBe(502);
			await authResponse.text();
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		for (const trace of traceRefs) surfaces.getSpans!.push(JSON.stringify(trace.getSpans()));
		for (const entry of events) {
			if (
				entry.event === "provider_request_failed" ||
				entry.event === "provider_request_completed"
			) {
				surfaces[entry.event === "provider_request_failed" ? "failed" : "completed"]!.push(
					JSON.stringify(entry),
				);
				const resolverPayload = Object.getOwnPropertyDescriptor(entry, "resolver")?.value;
				if (resolverPayload) {
					surfaces.resolver!.push(JSON.stringify(resolverPayload));
					expect(resolverPayload).toMatchObject({
						lastVendorErrorDescription: throwing ? "[REDACTION_FAILED]" : "[REDACTED]",
					});
				}
				if (entry.event === "provider_request_failed") {
					surfaces.causeChain!.push(JSON.stringify(entry.causeChain));
					expect(entry.message).toBe(throwing ? "[REDACTION_FAILED]" : "[REDACTED]");
					expect(entry.causeChain?.[0]?.message).toBe(
						throwing ? "[REDACTION_FAILED]" : "[REDACTED]",
					);
				}
			}
		}
		for (const [surface, values] of Object.entries(surfaces)) {
			expect(values.length, `${surface} must be exercised`).toBeGreaterThan(0);
			const serialized = values.join("\n");
			expect(serialized, `${surface} includes the redaction marker`).toContain(
				throwing ? "[REDACTION_FAILED]" : "[REDACTED]",
			);
			for (const secret of secrets) expect(serialized, surface).not.toContain(secret);
		}
		expect(navigations.some((value) => value.includes(secrets[0]!))).toBe(true);
		if (!throwing) {
			const spans = traceRefs[0]!.getSpans();
			for (const name of [
				"http.get",
				"browser.page.goto",
				"browser.page.click",
				"state.set",
				"provider.diagnostic",
			])
				expect(
					spans.find((span) => span.name === name),
					name,
				).toBeDefined();
			expect(
				spans.some(
					(span) => span.name === "state.set" && span.attributes.key === "operator-readable-key",
				),
			).toBe(true);
		}
		if (process.env.APIFUSE_P4_EVIDENCE === "1") {
			for (const source of [...new Set(fixtures.map((entry) => entry.source))]) {
				const sourceSecrets = fixtures
					.filter((entry) => entry.source === source)
					.map((entry) => entry.value);
				process.stdout.write(
					`P4 ${throwing ? "throwing" : shape} ${source} (${sourceSecrets.length} values): ${Object.entries(
						surfaces,
					)
						.map(
							([surface, values]) =>
								`${surface}=${values.filter((value) => sourceSecrets.some((secret) => value.includes(secret))).length}`,
						)
						.join(" ")}\n`,
				);
			}
		}
	} finally {
		upstream.stop(true);
		browser.mockRestore();
		print.mockRestore();
		hook.mockRestore();
		throwingSpy?.mockRestore();
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe("request-scoped diagnostic redaction", () => {
	it.each([
		"dictionary",
		"uuid",
		"hex",
	] as const)("scrubs every resolved source through real provider handlers and all surfaces: %s", (shape) =>
		exerciseServer(shape));
	it("fails closed when the request redactor throws at every server surface", () =>
		exerciseServer("dictionary", true));
});
