import { describe, expect, it, spyOn } from "bun:test";

import * as publicApi from "../index.js";
import {
	createRemoteProviderEngine,
	PROVIDER_ENGINE_PROTOCOL_VERSION,
	type ProviderEngineProtocolRequest,
	type ProviderEngineRemoteError,
	type ProviderEngineResponse,
	type ProviderEngineTransport,
	workspaceApiKeyFromEnv,
} from "../engine.js";
import {
	ProviderEgressDeniedError,
	ProviderEngineAuthenticationError,
	ProviderEngineProtocolVersionError,
	ProviderEngineUnavailableError,
} from "../errors.js";
import { renderEngineTraceStream } from "../dev.js";
import { serve } from "../server/serve.js";
import type { ProviderDefinition, TraceContext } from "../types.js";

const provider: ProviderDefinition = {
	id: "remote-engine-fixture",
	version: "1.0.0",
	runtime: "standard",
	runtimeTarget: "vanilla",
	http: {},
	allowedHosts: ["example.com"],
	meta: {
		displayName: "Remote engine fixture",
		descriptionKey: "remote-engine-fixture.description",
		category: "test",
	},
	operations: {},
};

const trace: TraceContext = { span: async (_name, run) => run() };

function response(
	request: ProviderEngineProtocolRequest,
	value:
		| { readonly ok: true; readonly result: unknown }
		| { readonly ok: false; readonly error: ProviderEngineRemoteError },
): ProviderEngineResponse {
	return {
		version: PROVIDER_ENGINE_PROTOCOL_VERSION,
		requestId: request.requestId,
		...value,
	} as ProviderEngineResponse;
}

describe("remote provider engine", () => {
	async function runWithoutKey(entry: string): Promise<{ exitCode: number; stderr: string }> {
		const environment = { ...process.env };
		delete environment.APIFUSE__ENGINE__API_KEY;
		const child = Bun.spawn({
			cmd: [process.execPath, entry, "/path-that-must-not-be-read"],
			cwd: new URL("../..", import.meta.url).pathname,
			env: environment,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		return { exitCode, stderr };
	}

	it("fails closed with actionable workspace-key guidance", () => {
		expect(() => workspaceApiKeyFromEnv({})).toThrow(ProviderEngineAuthenticationError);
		try {
			workspaceApiKeyFromEnv({ APIFUSE__ENGINE__API_KEY: " " });
		} catch (error) {
			expect(error).toMatchObject({
				code: "PROVIDER_ENGINE_AUTHENTICATION_FAILED",
				fix: expect.stringContaining("bounty dashboard"),
			});
		}
	});

	it("carries the workspace key on the versioned attachment handshake", async () => {
		let captured: ProviderEngineProtocolRequest | undefined;
		const transport: ProviderEngineTransport = {
			async request(request) {
				captured = request;
				return response(request, { ok: true, result: {} });
			},
		};
		const engine = createRemoteProviderEngine({ provider, apiKey: "workspace-secret", transport });
		await engine.ready?.();

		expect(captured).toMatchObject({
			version: "provider-engine.v1",
			lane: "request",
			providerId: provider.id,
			capability: "attachment",
			method: "attach",
			authentication: { scheme: "workspace-api-key", credential: "workspace-secret" },
			payload: { runtimeTarget: "vanilla", capabilities: ["http"] },
		});
	});

	it("surfaces authentication rejection as its own typed error", async () => {
		const transport: ProviderEngineTransport = {
			async request(request) {
				return response(request, {
					ok: false,
					error: { code: "PROVIDER_ENGINE_AUTHENTICATION_FAILED", message: "key revoked" },
				});
			},
		};
		const engine = createRemoteProviderEngine({ provider, apiKey: "revoked", transport });
		await expect(engine.ready?.()).rejects.toBeInstanceOf(ProviderEngineAuthenticationError);
	});

	it("surfaces protocol mismatch separately from authentication rejection", async () => {
		const transport: ProviderEngineTransport = {
			async request(request) {
				return {
					version: "provider-engine.v2",
					requestId: request.requestId,
					ok: true,
					result: {},
				};
			},
		};
		const engine = createRemoteProviderEngine({ provider, apiKey: "workspace-key", transport });
		await expect(engine.ready?.()).rejects.toBeInstanceOf(ProviderEngineProtocolVersionError);
	});

	it("fails unreachable engine calls without an in-process fallback", async () => {
		const transport: ProviderEngineTransport = {
			async request() {
				throw new Error("connection refused");
			},
		};
		const engine = createRemoteProviderEngine({ provider, apiKey: "workspace-key", transport });
		await expect(engine.ready?.()).rejects.toBeInstanceOf(ProviderEngineUnavailableError);
	});

	it("maps an allowlist refusal to the typed SDK provider error", async () => {
		const transport: ProviderEngineTransport = {
			async request(request) {
				if (request.capability === "attachment") {
					return response(request, { ok: true, result: {} });
				}
				return response(request, {
					ok: false,
					error: {
						code: "PROVIDER_EGRESS_DENIED",
						message: "Egress to denied.example is outside allowedHosts",
						details: { host: "denied.example" },
					},
				});
			},
		};
		const engine = createRemoteProviderEngine({ provider, apiKey: "workspace-key", transport });
		const context = engine.attach({ provider, bindings: { trace } });

		await expect(context.http.get("https://denied.example/data")).rejects.toMatchObject({
			name: "ProviderEgressDeniedError",
			code: "PROVIDER_EGRESS_DENIED",
			details: { host: "denied.example" },
		});
		expect(ProviderEgressDeniedError.prototype).toBeInstanceOf(Error);
	});

	it("keeps inline choice local and routes server-mode choice remotely", async () => {
		const choiceProvider = { ...provider, choice: {} } as ProviderDefinition;
		let choiceRequests = 0;
		const transport: ProviderEngineTransport = {
			async request(request) {
				if (request.capability === "choice") {
					choiceRequests += 1;
					return response(request, { ok: true, result: "remote-choice-token" });
				}
				return response(request, { ok: true, result: {} });
			},
		};
		const engine = createRemoteProviderEngine({
			provider: choiceProvider,
			apiKey: "workspace-key",
			transport,
		});
		const context = engine.attach({ provider: choiceProvider, bindings: { trace } });

		const inline = context.choice.issue({
			prefix: "pick_",
			purpose: "fixture",
			payload: { id: "one" },
			ttlMs: 60_000,
		});
		expect(typeof inline).toBe("string");
		expect(choiceRequests).toBe(0);

		const remote = await context.choice.issue({
			prefix: "pick_",
			purpose: "fixture",
			payload: { id: "two" },
			ttlMs: 60_000,
			storage: {
				mode: "server",
				namespace: "fixture",
				maxEntries: 10,
				maxValueBytes: 1_024,
			},
		});
		expect(remote).toBe("remote-choice-token");
		expect(choiceRequests).toBe(1);
	});

	it("does not expose the in-process engine constructor from the package API", () => {
		expect("createInProcessProviderEngine" in publicApi).toBe(false);
		expect("createInternalTestProviderEngine" in publicApi).toBe(false);
	});

	it("opens the additive trace method on the authenticated stream lane", async () => {
		let captured: ProviderEngineProtocolRequest | undefined;
		const transport: ProviderEngineTransport = {
			async request(request) {
				return response(request, { ok: true, result: {} });
			},
			async openStream(request) {
				captured = request;
				return new ReadableStream({
					start(controller) {
						controller.close();
					},
				});
			},
		};
		const engine = createRemoteProviderEngine({ provider, apiKey: "trace-key", transport });
		await engine.openTraceStream?.();
		expect(captured).toMatchObject({
			version: "provider-engine.v1",
			lane: "stream",
			capability: "trace",
			method: "trace.subscribe",
			authentication: { scheme: "workspace-api-key", credential: "trace-key" },
		});
	});

	it("renders request and response trace metadata in dev", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			const event = {
				type: "provider-engine.trace",
				requestId: "req-trace",
				phase: "response",
				capability: "http",
				method: "get",
				host: "example.com",
				path: "/items",
				status: 200,
				durationMs: 12,
				requestBytes: 4,
				responseBytes: 42,
			};
			const bytes = new TextEncoder().encode(`${JSON.stringify(event)}\n`);
			await renderEngineTraceStream(
				new ReadableStream({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					},
				}),
			);
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("http.get example.com/items status=200 duration=12ms bytes=4/42"),
			);
		} finally {
			log.mockRestore();
		}
	});

	it("fails dev and record closed before loading a provider when the key is absent", async () => {
		const [dev, record] = await Promise.all([
			runWithoutKey("bin/apifuse-dev.ts"),
			runWithoutKey("bin/apifuse-record.ts"),
		]);
		for (const result of [dev, record]) {
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("APIFUSE__ENGINE__API_KEY is required");
			expect(result.stderr).toContain("workspace API key");
		}
	});

	it("fails serve closed before opening a listener when the key is absent", async () => {
		const previous = process.env.APIFUSE__ENGINE__API_KEY;
		delete process.env.APIFUSE__ENGINE__API_KEY;
		try {
			await expect(
				serve(provider, { port: 0, shutdown: { signals: false } }),
			).rejects.toMatchObject({ code: "PROVIDER_ENGINE_AUTHENTICATION_FAILED" });
		} finally {
			if (previous === undefined) delete process.env.APIFUSE__ENGINE__API_KEY;
			else process.env.APIFUSE__ENGINE__API_KEY = previous;
		}
	});
});
