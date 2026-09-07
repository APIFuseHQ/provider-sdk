import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";

import { ProviderError } from "../errors.js";
import * as browserRuntime from "../runtime/browser.js";
import * as diagnosticRedactor from "../runtime/diagnostic-redactor.js";
import { registerResolverTelemetryBinding } from "../runtime/resolver-shared.js";
import { createMemoryProviderRuntimeState } from "../runtime/state.js";
import { createServerApp, type ProviderServerLogEvent } from "../server/serve.js";
import { statefulSignedHeaders } from "../stateful-signing.js";
import { event } from "../stream.js";
import type { ProviderContext, ResolverContext } from "../types.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

const SECRET = "orchardgrove";
const CONTENT_TYPE = { "content-type": "application/json" };
const savedEnvironment = { ...process.env };

afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in savedEnvironment)) delete process.env[key];
	}
	Object.assign(process.env, savedEnvironment);
});

function failedEvent(
	events: ProviderServerLogEvent[],
): Extract<ProviderServerLogEvent, { event: "provider_request_failed" }> {
	const event = events.find((candidate) => candidate.event === "provider_request_failed");
	expect(event).toBeDefined();
	return event as Extract<ProviderServerLogEvent, { event: "provider_request_failed" }>;
}

function malformedConnection() {
	return {
		id: "connection",
		mode: "credentials",
		metadata: {},
		externalRef: "external",
		secrets: { password: SECRET, [SECRET]: 17 },
	};
}

describe("server request credential redaction", () => {
	it("uses a low-entropy dictionary secret below the heuristic length threshold", () => {
		expect(SECRET).toHaveLength(12);
	});

	it("harvests connection values and keys before operation validation", async () => {
		const events: ProviderServerLogEvent[] = [];
		const provider = createProviderDefinitionDouble({
			operations: {
				inspect: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					handler: async () => ({}),
				},
			},
		});
		const response = await createServerApp(provider, {
			logger: (event) => events.push(event),
		}).request("/v1/inspect", {
			method: "POST",
			headers: CONTENT_TYPE,
			body: JSON.stringify({
				requestId: "request",
				input: {},
				connection: malformedConnection(),
			}),
		});

		const responseBody = await response.text();
		expect(response.status).toBe(400);
		expect(JSON.parse(responseBody).error.details).toEqual([
			{
				path: "connection.secrets.[REDACTED]",
				code: "invalid_type",
				message: "Invalid input: expected string, received number",
			},
		]);
		const event = failedEvent(events);
		expect(event.issues).toEqual([
			{
				path: "connection.secrets.[REDACTED]",
				code: "invalid_type",
				message: "Invalid input: expected string, received number",
			},
		]);
		expect(event.message).toContain('"[REDACTED]"');
		expect(JSON.stringify({ event, body: responseBody })).not.toContain(SECRET);
	});

	it("harvests credentials before validation on all five auth routes", async () => {
		const events: ProviderServerLogEvent[] = [];
		const app = createServerApp(createProviderDefinitionDouble(), {
			logger: (event) => events.push(event),
		});
		const routes = [
			["/auth/start", "start"],
			["/auth/continue", "continue"],
			["/auth/poll", "poll"],
			["/auth/refresh", "refresh"],
			["/auth/disconnect", "disconnect"],
		] as const;

		for (const [path] of routes) {
			const response = await app.request(path, {
				method: "POST",
				headers: CONTENT_TYPE,
				body: JSON.stringify({
					requestId: `request-${path}`,
					flowId: "flow",
					input: { password: SECRET },
					connection: malformedConnection(),
				}),
			});
			expect(response.status, path).toBe(400);
			expect(JSON.stringify(await response.json()), path).not.toContain(SECRET);
		}

		const failures = events.filter((event) => event.event === "provider_request_failed");
		expect(failures.map((event) => event.route)).toEqual(routes.map(([, route]) => route));
		for (const event of failures) {
			expect(event.issues).toEqual([
				{
					path: "connection.secrets.[REDACTED]",
					code: "invalid_type",
					message: "Invalid input: expected string, received number",
				},
			]);
			expect(JSON.stringify(event)).not.toContain(SECRET);
		}
	});

	it("harvests forwarded connection credentials before stateful envelope validation", async () => {
		const signingSecret = "forwarding-signing-key";
		const events: ProviderServerLogEvent[] = [];
		const provider = createProviderDefinitionDouble();
		const timestamp = new Date().toISOString();
		const route = "/__apifuse/stateful/operations";
		const body = JSON.stringify({
			requestId: "forwarded-request",
			providerId: provider.id,
			operationId: "inspect",
			sessionKey: "session",
			connectionId: "connection",
			serviceAccountId: "account",
			ownerPodId: "owner",
			generation: 1,
			sourcePodId: "source",
			forwardedAt: timestamp,
			operationRequest: {
				requestId: "forwarded-request",
				input: {},
				connection: malformedConnection(),
			},
		});
		const app = createServerApp(provider, {
			logger: (event) => events.push(event),
			statefulForwarding: { secret: signingSecret, validateOwnerFence: async () => true },
			internalOperationExecutor: async () => ({}),
		});
		const response = await app.request(route, {
			method: "POST",
			headers: {
				...CONTENT_TYPE,
				"x-apifuse-stateful-source-pod": "source",
				...statefulSignedHeaders({
					secret: signingSecret,
					timestamp,
					rawBody: body,
					method: "POST",
					path: route,
				}),
			},
			body,
		});
		const responseBody = await response.text();

		expect(response.status).toBe(500);
		expect(JSON.parse(responseBody).error.details).toEqual([
			{
				path: "operationRequest.connection.secrets.[REDACTED]",
				code: "invalid_type",
				message: "Invalid input: expected string, received number",
			},
		]);
		expect(JSON.stringify({ events, responseBody })).not.toContain(SECRET);
	});

	it("scrubs a registered provider error code in the operator log", async () => {
		process.env.P4_SERVER_FIELD_SECRET = SECRET;
		const events: ProviderServerLogEvent[] = [];
		const provider = createProviderDefinitionDouble({
			secrets: [{ name: "P4_SERVER_FIELD_SECRET" }],
			operations: {
				inspect: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					handler: async () => {
						throw new ProviderError("safe", { code: SECRET });
					},
				},
			},
		});
		const response = await createServerApp(provider, {
			logger: (event) => events.push(event),
		}).request("/v1/inspect", {
			method: "POST",
			headers: CONTENT_TYPE,
			body: JSON.stringify({ requestId: "request", input: {} }),
		});
		await response.text();

		expect(failedEvent(events).code).toBe("[REDACTED]");
	});
});

describe("server redactor failure modes", () => {
	it.each([
		"undefined",
		"boxed",
		"object",
		"identity",
		"second",
		"late",
	] as const)("never emits the original when the callback returns %s", async (mode) => {
		process.env.P4_CALLBACK_SECRET = SECRET;
		const original = diagnosticRedactor.createDiagnosticRedactor;
		let registry: diagnosticRedactor.DiagnosticSensitiveRegistry | undefined;
		let calls = 0;
		const hook = spyOn(diagnosticRedactor, "createDiagnosticRedactor").mockImplementation(
			(...args) => {
				registry = original(...args);
				const normal = registry.redact;
				if (mode !== "late") {
					registry.redact = ((text: string) => {
						calls += 1;
						if (mode === "undefined") return undefined;
						if (mode === "boxed") return new String(text);
						if (mode === "object") return { text };
						if (mode === "identity") return text;
						if (mode === "second" && calls === 2) throw new Error(SECRET);
						return normal(text);
					}) as diagnosticRedactor.DiagnosticRedactor;
				}
				return registry;
			},
		);
		const events: ProviderServerLogEvent[] = [];
		const resolver: ResolverContext = {
			async solve() {
				return { form: "token", token: "safe" };
			},
		};
		registerResolverTelemetryBinding(resolver, (sink) => ({
			async solve() {
				sink.recordVendorAttempt({
					vendor: "custom",
					phase: "create_task",
					outcome: "error",
					ms: 1,
					vendorErrorDescription: `vendor ${SECRET}`,
				});
				return { form: "token", token: "safe" };
			},
		}));
		const browserClose = spyOn(browserRuntime.BrowserClient.prototype, "close").mockImplementation(
			async () => {
				throw Object.assign(new Error(`cleanup ${SECRET}`), { name: `class-${SECRET}` });
			},
		);
		const poisonLate = () => {
			if (mode !== "late") return;
			if (!registry) throw new Error("request registry was not created");
			registry.redact = () => {
				throw new Error(SECRET);
			};
		};
		const observe = async (ctx: ProviderContext) => {
			poisonLate();
			await ctx.resolver.solve({
				kind: "recaptcha_v2",
				pageUrl: "https://example.test",
				siteKey: "public",
			});
		};
		const failure = () =>
			new ProviderError(`failed ${SECRET}`, {
				code: SECRET,
				cause: Object.assign(new Error(`cause ${SECRET}`), {
					name: `class-${SECRET}`,
				}),
			});
		const provider = createProviderDefinitionDouble({
			runtime: "browser",
			browser: { engine: "playwright-stealth" },
			resolver: { kinds: ["recaptcha_v2"] },
			secrets: [{ name: "P4_CALLBACK_SECRET" }],
			operations: {
				complete: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					handler: async (ctx) => {
						await observe(ctx);
						return {};
					},
				},
				fail: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					handler: async (ctx) => {
						await observe(ctx);
						throw failure();
					},
				},
				stream: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					transport: { kind: "sse", events: { ready: z.object({}) } },
					handler: async function* (ctx) {
						await observe(ctx);
						yield event("ready", {});
						throw failure();
					},
				},
			},
		});
		try {
			const app = createServerApp(provider, {
				logger: (event) => events.push(event),
				resolver,
			});
			let streamBody = "";
			for (const operation of ["complete", "fail", "stream"]) {
				const response = await app.request(`/v1/${operation}`, {
					method: "POST",
					headers: CONTENT_TYPE,
					body: JSON.stringify({ requestId: `request-${operation}`, input: {} }),
				});
				const body = await response.text();
				if (operation === "stream") streamBody = body;
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
			const serialized = JSON.stringify({ events, streamBody });
			expect(serialized).not.toContain(SECRET);
			const failClosed = mode !== "second";
			const invalidForBenignText = ["undefined", "boxed", "object", "late"].includes(mode);
			const expectedSecretText = (prefix: string) =>
				failClosed ? "[REDACTION_FAILED]" : `${prefix}[REDACTED]`;
			const completed = events.find(
				(candidate) => candidate.event === "provider_request_completed",
			);
			expect(completed?.resolver?.lastVendorErrorDescription).toBe(expectedSecretText("vendor "));
			const failures = events.filter((candidate) => candidate.event === "provider_request_failed");
			expect(failures).toHaveLength(2);
			for (const failureEvent of failures) {
				expect(failureEvent.code).toBe(expectedSecretText(""));
				expect(failureEvent.errorClass).toBe(
					invalidForBenignText ? "[REDACTION_FAILED]" : "ProviderError",
				);
				expect(failureEvent.message).toBe(expectedSecretText("failed "));
				expect(failureEvent.causeChain).toEqual([
					{
						errorClass: expectedSecretText("class-"),
						message: expectedSecretText("cause "),
						messageLength: 18,
						messageFingerprint: expect.stringMatching(/^[a-f0-9]{12}$/),
					},
				]);
			}
			const cleanups = events.filter((candidate) => candidate.event === "provider_cleanup_failed");
			expect(cleanups).toHaveLength(3);
			for (const cleanup of cleanups) {
				expect(cleanup.errorClass).toBe(expectedSecretText("class-"));
				expect(cleanup.message).toBe(expectedSecretText("cleanup "));
			}
			expect(streamBody).toContain("event: apifuse.error");
			expect(streamBody).toContain(
				`data: ${JSON.stringify({
					code: "stream_error",
					message: expectedSecretText("failed "),
					requestId: "request-stream",
				})}`,
			);
		} finally {
			browserClose.mockRestore();
			hook.mockRestore();
		}
	});
});

describe("server static credential sources", () => {
	it.each(
		(
			[
				{
					name: "OCR",
					env: {
						APIFUSE__OCR__BACKEND: "openai-compatible",
						APIFUSE__OCR__BASE_URL: "https://ocr.test",
						APIFUSE__OCR__API_KEY: SECRET,
						APIFUSE__OCR__MODEL: "plain",
					},
					invoke: (ctx: ProviderContext) =>
						ctx.ocr.recognize({ image: { kind: "url", url: "https://image.test/a" } }),
				},
				{
					name: "OCR Cloudflare",
					env: {
						APIFUSE__OCR__BACKEND: "cloudflare-workers-ai",
						APIFUSE__CLOUDFLARE__ACCOUNT_ID: "account",
						APIFUSE__OCR__CLOUDFLARE_API_TOKEN: SECRET,
						APIFUSE__OCR__MODEL: "plain",
					},
					invoke: (ctx: ProviderContext) =>
						ctx.ocr.recognize({ image: { kind: "url", url: "https://image.test/a" } }),
				},
				{
					name: "STT",
					env: {
						APIFUSE__STT__BACKEND: "cloudflare-workers-ai",
						APIFUSE__CLOUDFLARE__ACCOUNT_ID: "account",
						APIFUSE__STT__CLOUDFLARE_API_TOKEN: SECRET,
					},
					invoke: (ctx: ProviderContext) =>
						ctx.stt.transcribe({ audio: { kind: "base64", data: "YXVkaW8=" } }),
				},
			] as const
		).flatMap((entry) => [
			{ ...entry, rotate: false },
			{ ...entry, rotate: true },
		]),
	)("redacts an echoed $name transport credential, rotated=$rotate", async ({
		env,
		invoke,
		rotate,
	}) => {
		Object.assign(
			process.env,
			Object.fromEntries(
				Object.entries(env).map(([key, value]) => [
					key,
					rotate && value === SECRET ? "initialvalue" : value,
				]),
			),
		);
		const fetchHook = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_url: string | URL | Request, init?: RequestInit) => {
					const credential = new Headers(init?.headers)
						.get("authorization")
						?.replace("Bearer ", "");
					throw new Error(`upstream echoed ${credential}`);
				},
				{ preconnect: () => {} },
			),
		);
		const events: ProviderServerLogEvent[] = [];
		const provider = createProviderDefinitionDouble({
			ocr: { mode: "optional" },
			stt: { mode: "optional" },
			operations: {
				inspect: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					handler: async (ctx) => {
						await invoke(ctx);
						return {};
					},
				},
			},
		});
		try {
			const app = createServerApp(provider, { logger: (event) => events.push(event) });
			Object.assign(process.env, env);
			const response = await app.request("/v1/inspect", {
				method: "POST",
				headers: CONTENT_TYPE,
				body: JSON.stringify({ requestId: "request", input: {} }),
			});
			await response.text();
			const event = failedEvent(events);
			expect(event.causeChain?.[0]?.message).toBe("upstream echoed [REDACTED]");
			expect(JSON.stringify(event)).not.toContain(SECRET);
		} finally {
			fetchHook.mockRestore();
		}
	});

	it.each([
		false,
		true,
	])("redacts the credential path from a failed CDP endpoint, rotated=%s", async (rotate) => {
		process.env.APIFUSE__CDP_POOL__URL = `ws://127.0.0.1:1/${rotate ? "initialvalue" : SECRET}`;
		const events: ProviderServerLogEvent[] = [];
		const provider = createProviderDefinitionDouble({
			runtime: "browser",
			browser: { engine: "playwright-stealth" },
			operations: {
				inspect: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					handler: async (ctx) => {
						await ctx.browser.newPage();
						return {};
					},
				},
			},
		});
		const app = createServerApp(provider, { logger: (event) => events.push(event) });
		process.env.APIFUSE__CDP_POOL__URL = `ws://127.0.0.1:1/${SECRET}`;
		const response = await app.request("/v1/inspect", {
			method: "POST",
			headers: CONTENT_TYPE,
			body: JSON.stringify({ requestId: "request", input: {} }),
		});
		await response.text();
		const event = failedEvent(events);
		expect(event.message).toBe("Unable to connect to WebSocket endpoint: [REDACTED]");
		expect(JSON.stringify(event)).not.toContain(SECRET);
	});

	it("redacts the stateful forwarding signing secret from executor failures", async () => {
		const events: ProviderServerLogEvent[] = [];
		const provider = createProviderDefinitionDouble({
			operations: {
				inspect: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					handler: async () => ({}),
				},
			},
		});
		const timestamp = new Date().toISOString();
		const route = "/__apifuse/stateful/operations";
		const envelope = {
			requestId: "forwarded-request",
			providerId: provider.id,
			operationId: "inspect",
			sessionKey: "session",
			connectionId: "connection",
			serviceAccountId: "account",
			ownerPodId: "owner",
			generation: 1,
			sourcePodId: "source",
			forwardedAt: timestamp,
			operationRequest: { requestId: "forwarded-request", input: {} },
		};
		const body = JSON.stringify(envelope);
		const app = createServerApp(provider, {
			state: createMemoryProviderRuntimeState(),
			logger: (event) => events.push(event),
			statefulForwarding: { secret: SECRET, validateOwnerFence: async () => true },
			internalOperationExecutor: async () => {
				throw new Error(`owner failure ${SECRET}`);
			},
		});
		const response = await app.request(route, {
			method: "POST",
			headers: {
				...CONTENT_TYPE,
				"x-apifuse-stateful-source-pod": "source",
				...statefulSignedHeaders({
					secret: SECRET,
					timestamp,
					rawBody: body,
					method: "POST",
					path: route,
				}),
			},
			body,
		});
		await response.text();

		expect(failedEvent(events).message).toBe("owner failure [REDACTED]");
		expect(JSON.stringify(events)).not.toContain(SECRET);
	});
});

describe("server redaction before diagnostic bounds", () => {
	it("removes a secret that straddles the 290/320 character boundary", async () => {
		const boundarySecret = "honeysuckle".repeat(3).slice(0, 29);
		const prefix = "a ".repeat(145);
		const diagnostic = `${prefix}${boundarySecret}z`;
		expect(prefix).toHaveLength(290);
		expect(diagnostic).toHaveLength(320);
		process.env.P4_BOUNDARY_SECRET = boundarySecret;

		const resolver: ResolverContext = {
			async solve() {
				return { form: "token", token: "safe" };
			},
		};
		registerResolverTelemetryBinding(resolver, (sink) => ({
			async solve() {
				sink.recordVendorAttempt({
					vendor: "custom",
					phase: "create_task",
					outcome: "error",
					ms: 1,
					vendorErrorDescription: diagnostic,
					diagnostics: {
						cause: { name: diagnostic, message: diagnostic },
						upstreamHost: diagnostic,
						missingFields: [diagnostic],
						phase: diagnostic,
					},
				});
				return { form: "token", token: "safe" };
			},
		}));
		const observe = (ctx: ProviderContext) =>
			ctx.resolver.solve({
				kind: "recaptcha_v2",
				pageUrl: "https://example.test",
				siteKey: "public",
			});
		const provider = createProviderDefinitionDouble({
			resolver: { kinds: ["recaptcha_v2"] },
			secrets: [{ name: "P4_BOUNDARY_SECRET" }],
			operations: {
				fail: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					handler: async (ctx) => {
						await observe(ctx);
						throw new ProviderError(diagnostic, {
							code: "UPSTREAM_ERROR",
							cause: new Error(diagnostic),
						});
					},
				},
				stream: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					transport: { kind: "sse", events: { ready: z.object({}) } },
					handler: async function* () {
						yield event("ready", {});
						throw new ProviderError(diagnostic, { code: "UPSTREAM_ERROR" });
					},
				},
			},
		});
		const events: ProviderServerLogEvent[] = [];
		const app = createServerApp(provider, {
			resolver,
			logger: (event) => events.push(event),
		});
		const failResponse = await app.request("/v1/fail", {
			method: "POST",
			headers: CONTENT_TYPE,
			body: JSON.stringify({ requestId: "request-fail", input: {} }),
		});
		await failResponse.text();
		const streamResponse = await app.request("/v1/stream", {
			method: "POST",
			headers: CONTENT_TYPE,
			body: JSON.stringify({ requestId: "request-stream", input: {} }),
		});
		const streamBody = await streamResponse.text();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const logEvent = events.find(
			(candidate) => candidate.event === "provider_request_failed" && candidate.route === "fail",
		) as Extract<ProviderServerLogEvent, { event: "provider_request_failed" }> | undefined;
		expect(logEvent?.message).toBe(`${prefix}[REDACTED]z`);
		expect(logEvent?.causeChain?.[0]?.message).toBe(`${prefix}[REDACTED]… [truncated]`);
		expect(logEvent?.resolver?.lastVendorErrorDescription).toBe(`${prefix}[REDACTED]`);
		expect(logEvent?.resolver?.attemptSamples?.[0]?.diagnostics).toEqual({
			cause: { name: `${prefix}[REDACTED]`, message: `${prefix}[REDACTED]` },
			upstreamHost: `${prefix}[REDACTED]`,
			missingFields: [`${prefix}[REDACTED]`],
			phase: `${prefix}[REDACTED]`,
		});
		expect(streamBody).toContain(
			`data: ${JSON.stringify({
				code: "stream_error",
				message: `${prefix}[REDACTED]z`,
				requestId: "request-stream",
			})}`,
		);
		expect(JSON.stringify({ events, streamBody })).not.toContain("honeysuck");
	});
});

it("harvests engine lease handles before validation on every auth route", async () => {
	const events: ProviderServerLogEvent[] = [];
	const app = createServerApp(createProviderDefinitionDouble(), {
		logger: (event) => events.push(event),
	});
	for (const route of ["start", "continue", "poll", "refresh", "disconnect"]) {
		const response = await app.request(`/auth/${route}`, {
			method: "POST",
			headers: CONTENT_TYPE,
			body: JSON.stringify({
				requestId: "lease-request",
				flowId: "flow",
				engine: { egressLease: SECRET, [SECRET]: true },
			}),
		});
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error.details).toEqual([
			{ path: "engine", code: "unrecognized_keys", message: 'Unrecognized key: "[REDACTED]"' },
		]);
		expect(JSON.stringify(body)).not.toContain(SECRET);
	}
	const failures = events.filter((event) => event.event === "provider_request_failed");
	expect(failures).toHaveLength(5);
	for (const event of failures) {
		expect(event.issues).toEqual([
			{ path: "engine", code: "unrecognized_keys", message: 'Unrecognized key: "[REDACTED]"' },
		]);
	}
	expect(JSON.stringify(events)).not.toContain(SECRET);
});

// Adapted from review-round-2 probes.test.ts: nested input is valid auth input.
for (const shape of ["nested", "array", "key", "depth", "bytes"] as const) {
	it(`harvests nested auth input or suppresses exhausted ${shape} diagnostics`, async () => {
		const events: ProviderServerLogEvent[] = [];
		const nested: Record<string, unknown> = { credentials: { password: SECRET } };
		const input =
			shape === "array"
				? { credentials: [{ password: SECRET }] }
				: shape === "key"
					? { credentials: { [SECRET]: "ok" } }
					: shape === "depth"
						? JSON.parse(
								'{"credentials":' + '{"next":'.repeat(9) + `"${SECRET}"` + "}".repeat(9) + "}",
							)
						: shape === "bytes"
							? { credentials: { password: "x".repeat(65536), later: SECRET } }
							: nested;
		const app = createServerApp(
			createProviderDefinitionDouble({
				auth: {
					mode: "credentials",
					flow: {
						start: async () => {
							throw new Error(`vendor ${SECRET}`);
						},
						continue: async () => {
							throw new Error(`vendor ${SECRET}`);
						},
					},
				},
			}),
			{ logger: (event) => events.push(event) },
		);
		const response = await app.request("/auth/continue", {
			method: "POST",
			headers: CONTENT_TYPE,
			body: JSON.stringify({ requestId: "request", flowId: "flow", input }),
		});
		expect(response.status).toBe(500);
		expect(failedEvent(events).message).toBe(
			shape === "depth" || shape === "bytes" ? "[REDACTION_FAILED]" : "vendor [REDACTED]",
		);
		expect(JSON.stringify(events)).not.toContain(SECRET);
	});
}

it("bounds depth-20000 and 1 MiB credential bodies without recursion or prototype mutation", async () => {
	const app = createServerApp(createProviderDefinitionDouble(), { logger: () => {} });
	for (const secrets of [
		'{"__proto__":"orchardgrove","constructor":"orchardgrove"}',
		'{"password":' + "[".repeat(20000) + "0" + "]".repeat(20000) + "}",
		JSON.stringify({ password: "x".repeat(1024 * 1024) }),
	]) {
		const response = await app.request("/v1/inspect", {
			method: "POST",
			headers: CONTENT_TYPE,
			body: '{"input":{},"connection":{"secrets":' + secrets + "}}",
		});
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain(SECRET);
	}
	expect(Object.getPrototypeOf({})).toBe(Object.prototype);
});

it("registers a rotated declared env credential on ctx.env access before use", async () => {
	process.env.P4_ROTATING_SECRET = "initialvalue";
	const events: ProviderServerLogEvent[] = [];
	const app = createServerApp(
		createProviderDefinitionDouble({
			env: {},
			secrets: [{ name: "P4_ROTATING_SECRET" }],
			operations: {
				inspect: {
					riskClass: "read",
					input: z.object({}),
					output: z.unknown(),
					handler: async (ctx) => {
						throw new Error(`vendor ${ctx.env.get("P4_ROTATING_SECRET")?.trim()}`);
					},
				},
			},
		}),
		{ logger: (event) => events.push(event) },
	);
	process.env.P4_ROTATING_SECRET = ` ${SECRET} `;
	const response = await app.request("/v1/inspect", {
		method: "POST",
		headers: CONTENT_TYPE,
		body: JSON.stringify({ requestId: "rotation", input: {} }),
	});
	expect(response.status).toBe(500);
	expect(failedEvent(events).message).toBe("vendor [REDACTED]");
});

it("rechecks the already-started root and completed log metadata after harvest", async () => {
	let trace: import("../runtime/trace.js").TraceContext | undefined;
	const events: ProviderServerLogEvent[] = [];
	const app = createServerApp(
		createProviderDefinitionDouble({
			operations: {
				[SECRET]: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({}),
					handler: async (ctx) => {
						trace = ctx.trace as typeof trace;
						return {};
					},
				},
			},
		}),
		{ logger: (event) => events.push(event) },
	);
	const response = await app.request(`/v1/${SECRET}`, {
		method: "POST",
		headers: CONTENT_TYPE,
		body: JSON.stringify({
			requestId: `req-${SECRET}`,
			input: {},
			connection: {
				id: "connection",
				mode: "credentials",
				metadata: {},
				externalRef: "ext",
				secrets: { password: SECRET },
			},
		}),
	});
	expect(response.status).toBe(200);
	expect(trace?.getSpans()[0].name).toBe("request:operation:[REDACTED]");
	if (events[0].event !== "provider_request_completed") throw new Error("Missing completion");
	expect(events[0].route).toBe("[REDACTED]");
	expect(events[0].requestId).toBe("req-[REDACTED]");
	expect(JSON.stringify({ spans: trace?.getSpans(), events })).not.toContain(SECRET);
});

it("does not quote malformed JSON on any of the seven parsing routes", async () => {
	const signingSecret = "forwarding-signing-key";
	const events: ProviderServerLogEvent[] = [];
	const app = createServerApp(createProviderDefinitionDouble(), {
		logger: (entry) => events.push(entry),
		internalOperationExecutor: async () => ({}),
		statefulForwarding: { secret: signingSecret, validateOwnerFence: async () => true },
	});
	for (const path of [
		"/v1/inspect",
		"/auth/start",
		"/auth/continue",
		"/auth/poll",
		"/auth/refresh",
		"/auth/disconnect",
		"/__apifuse/stateful/operations",
	]) {
		const body = `{"connection":{"secrets":{"password":"${SECRET}"}}, broken`;
		const timestamp = new Date().toISOString();
		const stateful = path.startsWith("/__");
		const response = await app.request(path, {
			method: "POST",
			headers: {
				...CONTENT_TYPE,
				...(stateful
					? {
							"x-apifuse-stateful-source-pod": "source",
							...statefulSignedHeaders({
								secret: signingSecret,
								timestamp,
								rawBody: body,
								method: "POST",
								path,
							}),
						}
					: {}),
			},
			body,
		});
		expect(response.status).toBe(stateful ? 500 : 400);
		const output = await response.json();
		expect(output.error.code).toBe(
			stateful ? "STATEFUL_FORWARDING_ENVELOPE_INVALID" : "invalid_request",
		);
		expect(JSON.stringify({ output, events })).not.toContain(SECRET);
	}
});
