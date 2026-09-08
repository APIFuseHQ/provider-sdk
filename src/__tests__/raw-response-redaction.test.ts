import { afterEach, expect, it, spyOn } from "bun:test";
import { z } from "zod";
import type { AuthTurn } from "../auth-turn/index.js";
import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";
import * as diagnosticRedactor from "../runtime/diagnostic-redactor.js";
import {
	createServerApp,
	ERROR_OBSERVABILITY_HEADER,
	type ProviderServerLogEvent,
} from "../server/serve.js";
import { statefulSignedHeaders } from "../stateful-signing.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

const SECRET = "orchardgrove";
const savedEnvironment = { ...process.env };
afterEach(() => {
	for (const key of Object.keys(process.env))
		if (!(key in savedEnvironment)) delete process.env[key];
	Object.assign(process.env, savedEnvironment);
});

for (const route of [
	"operation",
	"stream",
	"stateful",
	"start",
	"continue",
	"poll",
	"refresh",
	"disconnect",
] as const) {
	it(`preserves the ${route} contract and redacts raw error status text`, async () => {
		process.env.P4_RAW_RESPONSE_SECRET = SECRET;
		const events: ProviderServerLogEvent[] = [];
		const raw = () => {
			// Provider body bytes remain untouched across transport chunks.
			const bytes = new TextEncoder().encode(
				JSON.stringify({ error: { code: "UPSTREAM_ERROR", message: `failed ${SECRET}` } }),
			);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes.slice(0, bytes.length - 8));
						controller.enqueue(bytes.slice(bytes.length - 8));
						controller.close();
					},
				}),
				{
					status: 503,
					statusText: `Unavailable ${SECRET}`,
					headers: {
						"content-type": "application/json",
						"content-length": String(bytes.length),
						[ERROR_OBSERVABILITY_HEADER]: JSON.stringify({ category: SECRET }),
					},
				},
			);
		};
		const handler = async () => raw();
		const rawAuthHandler = async (): Promise<AuthTurn> => {
			// @ts-expect-error test-invalid: Exercise the legacy raw Response auth path retained by the server.
			return raw();
		};
		const provider = createProviderDefinitionDouble({
			secrets: [{ name: "P4_RAW_RESPONSE_SECRET" }],
			operations: {
				inspect: {
					riskClass: "read",
					input: z.object({}),
					output: z.unknown(),
					handler,
					...(route === "stream"
						? { transport: { kind: "http-stream" as const, contentType: "application/json" } }
						: {}),
				},
			},
			auth: {
				mode: "credentials",
				flow: {
					start: rawAuthHandler,
					continue: rawAuthHandler,
					poll: rawAuthHandler,
					refresh: rawAuthHandler,
					abort: rawAuthHandler,
				},
			},
		});
		const signingSecret = "forwarding-signing-key";
		const app = createServerApp(provider, {
			logger: (event) => events.push(event),
			...(route === "stateful"
				? {
						statefulForwarding: { secret: signingSecret, validateOwnerFence: async () => true },
						internalOperationExecutor: handler,
					}
				: {}),
		});
		const timestamp = new Date().toISOString();
		const path =
			route === "stateful"
				? "/__apifuse/stateful/operations"
				: ["operation", "stream"].includes(route)
					? "/v1/inspect"
					: `/auth/${route}`;
		const body = JSON.stringify(
			route === "stateful"
				? {
						requestId: "raw-request",
						providerId: provider.id,
						operationId: "inspect",
						sessionKey: "session",
						connectionId: "connection",
						serviceAccountId: "account",
						ownerPodId: "owner",
						generation: 1,
						sourcePodId: "source",
						forwardedAt: timestamp,
						operationRequest: { requestId: "raw-request", input: {} },
					}
				: { requestId: "raw-request", flowId: "flow", input: {} },
		);
		const response = await app.request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(route === "stateful"
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
		if (route === "stateful") {
			// Internal executors return data, and the stateful route always wraps it.
			// A Response is not a raw HTTP result on this route (including on #275).
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('{"data":{}}');
			expect(response.headers.get(ERROR_OBSERVABILITY_HEADER)).toBeNull();
			expect(events).toHaveLength(1);
			expect(JSON.stringify(events)).not.toContain(SECRET);
			return;
		}
		expect(response.status).toBe(503);
		expect(response.statusText).toBe("Unavailable [REDACTED]");
		expect(response.headers.get("content-length")).toBe(
			String(
				JSON.stringify({ error: { code: "UPSTREAM_ERROR", message: `failed ${SECRET}` } }).length,
			),
		);
		expect(await response.json()).toEqual({
			error: { code: "UPSTREAM_ERROR", message: `failed ${SECRET}` },
		});
		expect(JSON.parse(response.headers.get(ERROR_OBSERVABILITY_HEADER) ?? "null")).toEqual({
			category: "upstream_http",
			taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			retryable: true,
		});
		expect(events).toHaveLength(1);
		expect(events[0]?.event).toBe("provider_request_completed");
		if (events[0]?.event !== "provider_request_completed")
			throw new Error("Missing request completion");
		expect(events[0].status).toBe(503);
		expect(JSON.stringify(events)).not.toContain(SECRET);
	});
}

it.each([
	"throw",
	"undefined",
	"boxed",
	"object",
	"identity",
] as const)("fails closed on raw status text when the callback is %s", async (mode) => {
	process.env.P4_RAW_RESPONSE_SECRET = SECRET;
	const original = diagnosticRedactor.createDiagnosticRedactor;
	const hook = spyOn(diagnosticRedactor, "createDiagnosticRedactor").mockImplementation(
		(...args) => {
			const registry = original(...args);
			registry.redact = ((text: string) => {
				if (mode === "throw") throw new Error(SECRET);
				if (mode === "undefined") return undefined;
				if (mode === "boxed") return new String(text);
				if (mode === "object") return { text };
				return text;
			}) as diagnosticRedactor.DiagnosticRedactor;
			return registry;
		},
	);
	try {
		const app = createServerApp(
			createProviderDefinitionDouble({
				secrets: [{ name: "P4_RAW_RESPONSE_SECRET" }],
				operations: {
					inspect: {
						riskClass: "read",
						input: z.object({}),
						output: z.unknown(),
						handler: async () => new Response(SECRET, { status: 502, statusText: SECRET }),
					},
				},
			}),
			{ logger: () => {} },
		);
		const response = await app.request("/v1/inspect", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "raw-request", input: {} }),
		});
		expect(response.status).toBe(502);
		expect(response.statusText).toBe("[REDACTION_FAILED]");
		expect(await response.text()).toBe(SECRET);
	} finally {
		hook.mockRestore();
	}
});

for (const registered of [false, true]) {
	for (const encoding of ["binary", "gzip"] as const) {
		it(`passes through 503 ${encoding} bytes and length with registry=${registered}`, async () => {
			process.env.P4_RAW_RESPONSE_SECRET = SECRET;
			const payload = new Uint8Array([255, 0, ...new TextEncoder().encode(SECRET), 128]);
			const bytes = encoding === "gzip" ? Bun.gzipSync(payload) : payload;
			const app = createServerApp(
				createProviderDefinitionDouble({
					secrets: registered ? [{ name: "P4_RAW_RESPONSE_SECRET" }] : [],
					operations: {
						inspect: {
							riskClass: "read",
							input: z.object({}),
							output: z.unknown(),
							handler: async () =>
								new Response(bytes, {
									status: 503,
									headers: {
										"content-type": "application/octet-stream",
										"content-length": String(bytes.length),
										...(encoding === "gzip" ? { "content-encoding": "gzip" } : {}),
									},
								}),
						},
					},
				}),
				{ logger: () => {} },
			);
			const response = await app.request("/v1/inspect", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "raw-request", input: {} }),
			});
			expect(response.status).toBe(503);
			expect(response.headers.get("content-length")).toBe(String(bytes.length));
			expect(response.headers.get("content-encoding")).toBe(encoding === "gzip" ? "gzip" : null);
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
		});
	}
}

it("returns an open raw 503 stream without reading it to completion", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
	});
	const app = createServerApp(
		createProviderDefinitionDouble({
			operations: {
				inspect: {
					riskClass: "read",
					input: z.object({}),
					output: z.unknown(),
					handler: async () =>
						new Response(stream, { status: 503, headers: { "content-type": "text/event-stream" } }),
				},
			},
		}),
		{ logger: () => {} },
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const response = await Promise.race([
			app.request("/v1/inspect", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "raw-request", input: {} }),
			}),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("raw response buffered")), 1000);
			}),
		]);
		expect(response.status).toBe(503);
		controller.enqueue(new Uint8Array([255]));
		controller.close();
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255]));
	} finally {
		clearTimeout(timer);
	}
});

it("preserves secret-free FF bytes even when U+FFFD is registered", async () => {
	process.env.P4_RAW_RESPONSE_SECRET = "\uFFFD";
	const app = createServerApp(
		createProviderDefinitionDouble({
			secrets: [{ name: "P4_RAW_RESPONSE_SECRET" }],
			operations: {
				inspect: {
					riskClass: "read",
					input: z.object({}),
					output: z.unknown(),
					handler: async () =>
						new Response(new Uint8Array([255]), {
							status: 503,
							headers: { "content-type": "application/octet-stream", "content-length": "1" },
						}),
				},
			},
		}),
		{ logger: () => {} },
	);
	const response = await app.request("/v1/inspect", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: "ff-byte", input: {} }),
	});
	expect(response.status).toBe(503);
	expect(response.headers.get("content-length")).toBe("1");
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255]));
});
