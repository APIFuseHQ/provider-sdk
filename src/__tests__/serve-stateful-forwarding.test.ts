import { describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";

import { clearProxyResolutionCache } from "../config/loader.js";
import { ProviderError } from "../errors.js";
import {
	APIFUSE__TRACE__ENABLED,
	APIFUSE__TRACE__EXPORTER,
} from "../runtime/trace-config.js";
import {
	createServerApp,
	type ProviderServerLogEvent,
	type ProviderServerOperationExecutorInput,
} from "../server/serve.js";
import type { ProviderDefinition } from "../types.js";

const builtStatefulSpecifier: string = "../../dist/stateful/index.js";
const builtStateful: Promise<typeof import("../stateful/index.js")> = import(
	builtStatefulSpecifier
);
const { statefulSignedHeaders } = await builtStateful;

const STATEFUL_ROUTE = "/__apifuse/stateful/operations";
const SIGNATURE_HEADER = "x-apifuse-stateful-signature";
const TIMESTAMP_HEADER = "x-apifuse-stateful-timestamp";
const FORWARDING_SECRET = "test-stateful-forwarding-secret";

function createLocalFetchDouble(
	implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return Object.assign(implementation, { preconnect: () => {} });
}

function createTestProvider(state: { defaultExecutions: number }): ProviderDefinition {
	return {
		id: "stateful-test-provider",
		version: "1.0.0",
		runtime: "standard",
		meta: {
			displayName: "Stateful Test Provider",
			descriptionKey: "stateful-test-provider.description",
			category: "test",
		},
		operations: {
			echo: {
				riskClass: "read",
				input: z.object({ value: z.string() }),
				output: z.object({ source: z.string(), value: z.string() }),
				handler: async (_ctx, input: { value: string }) => {
					state.defaultExecutions += 1;
					return { source: "default", value: input.value };
				},
			},
		},
	};
}

function operationBody(): string {
	return JSON.stringify({
		requestId: "req-operation-executor",
		input: { value: "hello" },
		headers: { "x-request-source": "test" },
	});
}

function forwardingEnvelope(overrides: Record<string, unknown> = {}) {
	return {
		requestId: "req-stateful-forward",
		providerId: "stateful-test-provider",
		operationId: "echo",
		sessionKey: "stateful-test-provider:account:connection",
		connectionId: "connection-1",
		serviceAccountId: "account-1",
		ownerPodId: "pod-owner",
		generation: 7,
		sourcePodId: "pod-source",
		forwardedAt: new Date().toISOString(),
		operationRequest: {
			requestId: "req-stateful-forward",
			input: { value: "forwarded" },
			headers: { "x-request-source": "forwarder" },
		},
		...overrides,
	};
}

function forwardingBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify(forwardingEnvelope(overrides));
}

function forwardingConfig(overrides: Record<string, unknown> = {}) {
	return {
		secret: FORWARDING_SECRET,
		validateOwnerFence: async () => true,
		...overrides,
	};
}

function signedHeaders(
	secret: string,
	timestamp: string,
	body: string,
	input: { path?: string; nonce?: string } = {},
): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-apifuse-stateful-source-pod": "pod-source",
		...statefulSignedHeaders({
			secret,
			timestamp,
			rawBody: body,
			method: "POST",
			path: input.path ?? STATEFUL_ROUTE,
			...(input.nonce ? { nonce: input.nonce } : {}),
		}),
	};
}

function expectStructuredError(
	body: unknown,
	code: string,
	message: string,
): asserts body is { error: { code: string; message: string; retryable: boolean } } {
	expect(body).toEqual({ error: { code, message, retryable: false, source: "apifuse" } });
}

describe("provider server operation executors", () => {
	it("routes operation requests through the configured executor", async () => {
		const state = { defaultExecutions: 0 };
		const provider = createTestProvider(state);
		let received: ProviderServerOperationExecutorInput | undefined;
		const app = createServerApp(provider, {
			logger: () => {},
			operationExecutor: async (input) => {
				received = input;
				return { source: "custom", value: input.request.input.value };
			},
		});

		const response = await app.request("/v1/echo", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: operationBody(),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: { source: "custom", value: "hello" },
		});
		expect(state.defaultExecutions).toBe(0);
		expect(received?.provider).toBe(provider);
		expect(received?.operationId).toBe("echo");
		expect(received?.ctx).toBeDefined();
		expect(received?.request).toMatchObject({
			requestId: "req-operation-executor",
			input: { value: "hello" },
			headers: { "x-request-source": "test" },
		});
	});

	it("uses the default executeOperation path when no executor is configured", async () => {
		const state = { defaultExecutions: 0 };
		const app = createServerApp(createTestProvider(state), { logger: () => {} });

		const response = await app.request("/v1/echo", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: operationBody(),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: { source: "default", value: "hello" },
		});
		expect(state.defaultExecutions).toBe(1);
	});
});

describe("signed stateful operation forwarding", () => {
	it("dispatches a valid, fresh signed envelope to the internal executor", async () => {
		const provider = createTestProvider({ defaultExecutions: 0 });
		let received: ProviderServerOperationExecutorInput | undefined;
		const app = createServerApp(provider, {
			logger: () => {},
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async (input) => {
				received = input;
				return { accepted: true };
			},
		});
		const timestamp = new Date().toISOString();
		const deadlineAt = new Date(Date.now() + 30_000).toISOString();
		const body = forwardingBody({ forwardedAt: timestamp, deadlineAt });

		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body),
			body,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { accepted: true } });
		expect(received?.provider).toBe(provider);
		expect(received?.operationId).toBe("echo");
		expect(received?.ctx).toBeDefined();
		expect(received?.request).toEqual({
			requestId: "req-stateful-forward",
			input: { value: "forwarded" },
			headers: { "x-request-source": "forwarder" },
			deadlineAt,
		});
		expect(received?.internalStatefulForward).toEqual(JSON.parse(body));
		expect(received?.signal).toBeInstanceOf(AbortSignal);
	});

	it("logs proxy telemetry recorded by a forwarded operation", async () => {
		const originalFetch = global.fetch;
		const originalSmartproxyKey = process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		clearProxyResolutionCache();
		delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
		global.fetch = createLocalFetchDouble(async () => Response.json({ ok: true }));
		const baseProvider = createTestProvider({ defaultExecutions: 0 });
		const provider = {
			...baseProvider,
			http: {},
			allowedHosts: ["example.com"],
			proxy: { mode: "optional", providers: ["smartproxy"] },
		} satisfies ProviderDefinition;
		const events: ProviderServerLogEvent[] = [];
		const app = createServerApp(provider, {
			logger: (event) => events.push(event),
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async ({ ctx }) => {
				await ctx.http.get("https://example.com/forwarded");
				return { accepted: true };
			},
		});
		const timestamp = new Date().toISOString();
		const body = forwardingBody({ forwardedAt: timestamp });

		try {
			const response = await app.request(STATEFUL_ROUTE, {
				method: "POST",
				headers: signedHeaders(FORWARDING_SECRET, timestamp, body),
				body,
			});
			expect(response.status).toBe(200);
			const event = events.find((candidate) => candidate.event === "provider_request_completed");
			expect(event).toMatchObject({
				event: "provider_request_completed",
				route: "echo",
				connectionId: "connection-1",
				proxy: {
					kind: "unresolved",
					vendors: ["smartproxy"],
					failovers: [{ v: "smartproxy", p: "resolution", r: "no_credentials" }],
				},
			});
		} finally {
			global.fetch = originalFetch;
			if (originalSmartproxyKey === undefined) {
				delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
			} else {
				process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = originalSmartproxyKey;
			}
			clearProxyResolutionCache();
		}
	});

	it("logs the forwarded operation id when internal execution fails", async () => {
		const events: ProviderServerLogEvent[] = [];
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: (event) => events.push(event),
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async () => {
				throw new ProviderError("Forwarded operation failed", { code: "FORWARDED_FAILURE" });
			},
		});
		const timestamp = new Date().toISOString();
		const body = forwardingBody({ forwardedAt: timestamp });

		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body),
			body,
		});

		expect(response.status).toBe(500);
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "provider_request_failed",
				route: "echo",
				requestId: "req-stateful-forward",
				code: "FORWARDED_FAILURE",
			}),
		);
	});

	it("rejects an expired forwarded deadline without invoking the executor", async () => {
		let executions = 0;
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async () => {
				executions += 1;
				return { accepted: true };
			},
		});
		const timestamp = new Date().toISOString();
		const deadlineAt = new Date(Date.now() - 1).toISOString();
		const body = forwardingBody({ forwardedAt: timestamp, deadlineAt });

		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body),
			body,
		});

		expect(response.status).toBe(504);
		expect(await response.json()).toEqual({
			error: {
				code: "STATEFUL_FORWARDING_DEADLINE_EXPIRED",
				message: "Stateful forwarding deadline expired.",
				requestId: "req-stateful-forward",
				retryable: false,
				source: "apifuse",
			},
		});
		expect(executions).toBe(0);
	});

	it("bounds owner-fence validation by the forwarded deadline", async () => {
		let executions = 0;
		let validationSignal: AbortSignal | undefined;
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: forwardingConfig({
				validateOwnerFence: async (_fence: unknown, signal: AbortSignal) => {
					validationSignal = signal;
					await Bun.sleep(100);
					return true;
				},
			}),
			internalOperationExecutor: async () => {
				executions += 1;
				return { accepted: true };
			},
		});
		const timestamp = new Date().toISOString();
		const deadlineAt = new Date(Date.now() + 20).toISOString();
		const body = forwardingBody({ forwardedAt: timestamp, deadlineAt });

		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body),
			body,
		});

		expect(response.status).toBe(504);
		expect(await response.json()).toEqual({
			error: {
				code: "STATEFUL_FORWARDING_DEADLINE_EXPIRED",
				message: "Stateful forwarding deadline expired.",
				requestId: "req-stateful-forward",
				retryable: false,
				source: "apifuse",
			},
		});
		expect(validationSignal?.aborted).toBe(true);
		expect(executions).toBe(0);
	});

	it("passes a combined signal that aborts at the forwarded deadline", async () => {
		let signalAbortedAfterDeadline = false;
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async ({ signal }) => {
				await Bun.sleep(45);
				signalAbortedAfterDeadline = signal?.aborted === true;
				return { accepted: true };
			},
		});
		const timestamp = new Date().toISOString();
		const deadlineAt = new Date(Date.now() + 15).toISOString();
		const body = forwardingBody({ forwardedAt: timestamp, deadlineAt });

		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body),
			body,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { accepted: true } });
		expect(signalAbortedAfterDeadline).toBe(true);
	});

	it("rejects missing signature headers with a structured provider error", async () => {
		const events: ProviderServerLogEvent[] = [];
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: (event) => events.push(event),
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async () => ({ accepted: true }),
		});

		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: forwardingBody(),
		});
		const responseText = await response.text();

		expect(response.status).toBe(500);
		expectStructuredError(
			JSON.parse(responseText),
			"STATEFUL_FORWARDING_SIGNATURE_MISSING",
			"Stateful forwarding signature headers are missing.",
		);
		expect(responseText).not.toContain(FORWARDING_SECRET);
		expect(responseText).not.toContain("sensitive-envelope-material");
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "provider_request_failed",
				code: "STATEFUL_FORWARDING_SIGNATURE_MISSING",
			}),
		);
		expect(events).not.toContainEqual(
			expect.objectContaining({ signal: "unregistered_provider_error_code" }),
		);
	});

	it("rejects an invalid signature without echoing secret material", async () => {
		const previousEnabled = process.env[APIFUSE__TRACE__ENABLED];
		const previousExporter = process.env[APIFUSE__TRACE__EXPORTER];
		const traceOutput: string[] = [];
		const events: ProviderServerLogEvent[] = [];
		const originalLog = console.log;
		let executions = 0;
		process.env[APIFUSE__TRACE__ENABLED] = "true";
		process.env[APIFUSE__TRACE__EXPORTER] = "json";
		console.log = (...args: unknown[]) => traceOutput.push(args.map(String).join(" "));
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: (event) => events.push(event),
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async () => {
				executions += 1;
				return { accepted: true };
			},
		});
		const timestamp = new Date().toISOString();
		const body = forwardingBody({ forwardedAt: timestamp });

		let response!: Response;
		let responseText!: string;
		try {
			response = await app.request(STATEFUL_ROUTE, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-apifuse-stateful-nonce": "invalid-signature-nonce",
					"x-apifuse-stateful-source-pod": "pod-source",
					[SIGNATURE_HEADER]: "v1=invalid",
					[TIMESTAMP_HEADER]: timestamp,
				},
				body,
			});
			responseText = await response.text();
			await new Promise<void>((resolve) => setImmediate(resolve));
		} finally {
			console.log = originalLog;
			if (previousEnabled === undefined) delete process.env[APIFUSE__TRACE__ENABLED];
			else process.env[APIFUSE__TRACE__ENABLED] = previousEnabled;
			if (previousExporter === undefined) delete process.env[APIFUSE__TRACE__EXPORTER];
			else process.env[APIFUSE__TRACE__EXPORTER] = previousExporter;
		}

		expect(response.status).toBe(500);
		expectStructuredError(
			JSON.parse(responseText),
			"STATEFUL_FORWARDING_SIGNATURE_INVALID",
			"Stateful forwarding signature is invalid.",
		);
		expect(responseText).not.toContain(FORWARDING_SECRET);
		expect(responseText).not.toContain("sensitive-envelope-material");
		expect(executions).toBe(0);
		expect(events.filter((event) => event.event === "provider_request_failed")).toHaveLength(1);
		expect(events.filter((event) => event.event === "provider_request_completed")).toHaveLength(0);
		expect(traceOutput.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({
				name: "request:operation:stateful-internal",
				status: "error",
			}),
		]);
	});

	it("rejects a signed timestamp outside the configured skew", async () => {
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: forwardingConfig({ maxSkewMs: 1_000 }),
			internalOperationExecutor: async () => ({ accepted: true }),
		});
		const timestamp = new Date(Date.now() - 60_000).toISOString();
		const body = forwardingBody({ forwardedAt: timestamp });

		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body),
			body,
		});
		const responseText = await response.text();

		expect(response.status).toBe(500);
		expectStructuredError(
			JSON.parse(responseText),
			"STATEFUL_FORWARDING_TIMESTAMP_INVALID",
			"Stateful forwarding signature timestamp is outside the allowed skew.",
		);
		expect(responseText).not.toContain(FORWARDING_SECRET);
		expect(responseText).not.toContain("sensitive-envelope-material");
	});

	it("fails fast when the internal executor has no forwarding secret", () => {
		expect(() =>
			createServerApp(createTestProvider({ defaultExecutions: 0 }), {
				logger: () => {},
				internalOperationExecutor: async () => ({ accepted: true }),
			}),
		).toThrow("missing option statefulForwarding.secret");
	});

	it("fails fast when forwarding has no internal executor", () => {
		expect(() =>
			createServerApp(createTestProvider({ defaultExecutions: 0 }), {
				logger: () => {},
				statefulForwarding: forwardingConfig(),
			}),
		).toThrow("missing option internalOperationExecutor");
	});

	it("rejects a signed forwarding envelope that is not an object", async () => {
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async () => ({ accepted: true }),
		});
		const timestamp = new Date().toISOString();
		const body = JSON.stringify(["not-an-object"]);

		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body),
			body,
		});

		expect(response.status).toBe(500);
		const error = await response.json();
		expect(error.error).toMatchObject({
			code: "STATEFUL_FORWARDING_ENVELOPE_INVALID",
			message: "Stateful forwarding envelope is invalid.",
		});
	});

	it("rejects nonce replay inside the signature skew window", async () => {
		let executions = 0;
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async () => {
				executions += 1;
				return { accepted: true };
			},
		});
		const timestamp = new Date().toISOString();
		const body = forwardingBody({ forwardedAt: timestamp });
		const headers = signedHeaders(FORWARDING_SECRET, timestamp, body, {
			nonce: "one-use-nonce",
		});

		expect((await app.request(STATEFUL_ROUTE, { method: "POST", headers, body })).status).toBe(200);
		const replay = await app.request(STATEFUL_ROUTE, { method: "POST", headers, body });
		expect(replay.status).toBe(500);
		expectStructuredError(
			await replay.json(),
			"STATEFUL_FORWARDING_REPLAY_DETECTED",
			"Stateful forwarding nonce has already been used.",
		);
		expect(executions).toBe(1);
	});

	it("returns 503 with Retry-After when the replay cache is full", async () => {
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: forwardingConfig({ replayCacheMaxEntries: 1 }),
			internalOperationExecutor: async () => ({ accepted: true }),
		});
		const timestamp = new Date().toISOString();
		const body = forwardingBody({ forwardedAt: timestamp });
		const first = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body, { nonce: "capacity-one" }),
			body,
		});
		expect(first.status).toBe(200);
		const full = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body, { nonce: "capacity-two" }),
			body,
		});
		expect(full.status).toBe(503);
		expect(full.headers.get("retry-after")).toBe("10");
		expect((await full.json()).error.code).toBe("STATEFUL_FORWARDING_REPLAY_CACHE_FULL");
	});

	it("drops expired replay buckets and recovers capacity", async () => {
		let nowMs = 1_800_000_000_000;
		const dateNow = spyOn(Date, "now").mockImplementation(() => nowMs);
		try {
			const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
				logger: () => {},
				statefulForwarding: forwardingConfig({ replayCacheMaxEntries: 1, maxSkewMs: 1_000 }),
				internalOperationExecutor: async () => ({ accepted: true }),
			});
			const firstTimestamp = new Date(nowMs).toISOString();
			const firstBody = forwardingBody({ forwardedAt: firstTimestamp });
			expect(
				(
					await app.request(STATEFUL_ROUTE, {
						method: "POST",
						headers: signedHeaders(FORWARDING_SECRET, firstTimestamp, firstBody, {
							nonce: "expiring-one",
						}),
						body: firstBody,
					})
				).status,
			).toBe(200);

			nowMs += 20_000;
			const secondTimestamp = new Date(nowMs).toISOString();
			const secondBody = forwardingBody({ forwardedAt: secondTimestamp });
			const recovered = await app.request(STATEFUL_ROUTE, {
				method: "POST",
				headers: signedHeaders(FORWARDING_SECRET, secondTimestamp, secondBody, {
					nonce: "expiring-two",
				}),
				body: secondBody,
			});
			expect(recovered.status).toBe(200);
		} finally {
			dateNow.mockRestore();
		}
	});

	it("binds signatures to the HTTP method and route", async () => {
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async () => ({ accepted: true }),
		});
		const timestamp = new Date().toISOString();
		const body = forwardingBody({ forwardedAt: timestamp });
		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body, {
				path: "/v1/stateful/events",
			}),
			body,
		});
		expect(response.status).toBe(500);
		expectStructuredError(
			await response.json(),
			"STATEFUL_FORWARDING_SIGNATURE_INVALID",
			"Stateful forwarding signature is invalid.",
		);
	});

	it("rejects missing owner fences and provider mismatches before execution", async () => {
		let executions = 0;
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async () => {
				executions += 1;
				return { accepted: true };
			},
		});
		const missingFenceTimestamp = new Date().toISOString();
		const missingFenceEnvelope = forwardingEnvelope({ forwardedAt: missingFenceTimestamp });
		delete (missingFenceEnvelope as { generation?: number }).generation;
		const missingFenceBody = JSON.stringify(missingFenceEnvelope);
		const missingFence = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, missingFenceTimestamp, missingFenceBody),
			body: missingFenceBody,
		});
		expect(missingFence.status).toBe(500);
		expect((await missingFence.json()).error.code).toBe("STATEFUL_FORWARDING_ENVELOPE_INVALID");

		const mismatchTimestamp = new Date().toISOString();
		const mismatchBody = forwardingBody({
			providerId: "different-provider",
			forwardedAt: mismatchTimestamp,
		});
		const mismatch = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, mismatchTimestamp, mismatchBody),
			body: mismatchBody,
		});
		expect(mismatch.status).toBe(500);
		expect((await mismatch.json()).error.code).toBe("STATEFUL_FORWARDING_PROVIDER_MISMATCH");

		const unknownFieldTimestamp = new Date().toISOString();
		const unknownFieldBody = forwardingBody({
			forwardedAt: unknownFieldTimestamp,
			unexpected: true,
		});
		const unknownField = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, unknownFieldTimestamp, unknownFieldBody),
			body: unknownFieldBody,
		});
		expect(unknownField.status).toBe(500);
		expect((await unknownField.json()).error.code).toBe("STATEFUL_FORWARDING_ENVELOPE_INVALID");
		expect(executions).toBe(0);
	});

	it("rejects a malformed forwarded deadline", async () => {
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async () => ({ accepted: true }),
		});
		const timestamp = new Date().toISOString();
		const body = forwardingBody({ forwardedAt: timestamp, deadlineAt: "not-an-iso-date" });
		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body),
			body,
		});
		expect(response.status).toBe(500);
		expect((await response.json()).error.code).toBe("STATEFUL_FORWARDING_ENVELOPE_INVALID");
	});

	it("rejects a stale owner fence through the SDK-owned validation boundary", async () => {
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: forwardingConfig({ validateOwnerFence: async () => false }),
			internalOperationExecutor: async () => ({ accepted: true }),
		});
		const timestamp = new Date().toISOString();
		const body = forwardingBody({ forwardedAt: timestamp });
		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body),
			body,
		});

		expect(response.status).toBe(500);
		expect((await response.json()).error).toMatchObject({
			code: "STATEFUL_FORWARDING_OWNER_FENCE_INVALID",
			message: "Stateful forwarding owner fence is no longer current.",
			requestId: "req-stateful-forward",
		});
	});
});
