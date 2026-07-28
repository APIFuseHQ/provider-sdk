import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { statefulSignedHeaders } from "../../dist/stateful/index.js";
import { createServerApp, type ProviderServerOperationExecutorInput } from "../server/serve.js";
import type { ProviderDefinition } from "../types.js";

const STATEFUL_ROUTE = "/__apifuse/stateful/operations";
const SIGNATURE_HEADER = "x-apifuse-stateful-signature";
const TIMESTAMP_HEADER = "x-apifuse-stateful-timestamp";
const FORWARDING_SECRET = "test-stateful-forwarding-secret";

function createTestProvider(state: { defaultExecutions: number }): ProviderDefinition {
	return {
		id: "stateful-test-provider",
		version: "1.0.0",
		runtime: "standard",
		meta: {
			displayName: "Stateful Test Provider",
			category: "test",
		},
		operations: {
			echo: {
				input: z.object({ value: z.string() }),
				output: z.object({ source: z.string(), value: z.string() }),
				handler: async (_ctx, input) => {
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
): asserts body is { error: { code: string; message: string } } {
	expect(body).toEqual({ error: { code, message } });
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
		const body = forwardingBody({ forwardedAt: timestamp });

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
		});
		expect(received?.internalStatefulForward).toEqual(JSON.parse(body));
		expect(received?.signal).toBeInstanceOf(AbortSignal);
	});

	it("rejects missing signature headers with a structured provider error", async () => {
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async () => ({ accepted: true }),
		});

		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: forwardingBody(),
		});
		const responseText = await response.text();

		expect(response.status).toBe(400);
		expectStructuredError(
			JSON.parse(responseText),
			"STATEFUL_FORWARDING_SIGNATURE_MISSING",
			"Stateful forwarding signature headers are missing.",
		);
		expect(responseText).not.toContain(FORWARDING_SECRET);
		expect(responseText).not.toContain("sensitive-envelope-material");
	});

	it("rejects an invalid signature without echoing secret material", async () => {
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: forwardingConfig(),
			internalOperationExecutor: async () => ({ accepted: true }),
		});
		const timestamp = new Date().toISOString();
		const body = forwardingBody({ forwardedAt: timestamp });

		const response = await app.request(STATEFUL_ROUTE, {
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
		const responseText = await response.text();

		expect(response.status).toBe(400);
		expectStructuredError(
			JSON.parse(responseText),
			"STATEFUL_FORWARDING_SIGNATURE_INVALID",
			"Stateful forwarding signature is invalid.",
		);
		expect(responseText).not.toContain(FORWARDING_SECRET);
		expect(responseText).not.toContain("sensitive-envelope-material");
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

		expect(response.status).toBe(400);
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

		expect(response.status).toBe(400);
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
		expect(replay.status).toBe(400);
		expectStructuredError(
			await replay.json(),
			"STATEFUL_FORWARDING_REPLAY_DETECTED",
			"Stateful forwarding nonce has already been used.",
		);
		expect(executions).toBe(1);
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
		expect(response.status).toBe(400);
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
		expect(missingFence.status).toBe(400);
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
		expect(mismatch.status).toBe(400);
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
		expect(unknownField.status).toBe(400);
		expect((await unknownField.json()).error.code).toBe("STATEFUL_FORWARDING_ENVELOPE_INVALID");
		expect(executions).toBe(0);
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

		expect(response.status).toBe(400);
		expect((await response.json()).error).toMatchObject({
			code: "STATEFUL_FORWARDING_OWNER_FENCE_INVALID",
			message: "Stateful forwarding owner fence is no longer current.",
			requestId: "req-stateful-forward",
		});
	});
});
