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

function forwardingBody(): string {
	return JSON.stringify({
		requestId: "req-stateful-forward",
		providerId: "stateful-test-provider",
		operationId: "echo",
		input: { value: "forwarded" },
		headers: { "x-request-source": "forwarder" },
		statefulToken: "sensitive-envelope-material",
	});
}

function signedHeaders(secret: string, timestamp: string, body: string): Record<string, string> {
	return {
		"content-type": "application/json",
		...statefulSignedHeaders({ secret, timestamp, rawBody: body }),
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
			statefulForwarding: { secret: FORWARDING_SECRET },
			internalOperationExecutor: async (input) => {
				received = input;
				return { accepted: true };
			},
		});
		const body = forwardingBody();
		const timestamp = new Date().toISOString();

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
			statefulForwarding: { secret: FORWARDING_SECRET },
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
			statefulForwarding: { secret: FORWARDING_SECRET },
			internalOperationExecutor: async () => ({ accepted: true }),
		});
		const body = forwardingBody();
		const timestamp = new Date().toISOString();

		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: {
				"content-type": "application/json",
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
			statefulForwarding: { secret: FORWARDING_SECRET, maxSkewMs: 1_000 },
			internalOperationExecutor: async () => ({ accepted: true }),
		});
		const body = forwardingBody();
		const timestamp = new Date(Date.now() - 60_000).toISOString();

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

	it("fails closed when stateful forwarding is not configured", async () => {
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			internalOperationExecutor: async () => ({ accepted: true }),
		});
		const body = forwardingBody();
		const timestamp = new Date().toISOString();

		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body),
			body,
		});
		const responseText = await response.text();

		expect(response.status).toBe(400);
		expectStructuredError(
			JSON.parse(responseText),
			"STATEFUL_FORWARDING_NOT_CONFIGURED",
			"Stateful forwarding is not configured.",
		);
		expect(responseText).not.toContain(FORWARDING_SECRET);
		expect(responseText).not.toContain("sensitive-envelope-material");
	});

	it("rejects a signed forwarding envelope that is not an object", async () => {
		const app = createServerApp(createTestProvider({ defaultExecutions: 0 }), {
			logger: () => {},
			statefulForwarding: { secret: FORWARDING_SECRET },
			internalOperationExecutor: async () => ({ accepted: true }),
		});
		const body = JSON.stringify(["not-an-object"]);
		const timestamp = new Date().toISOString();

		const response = await app.request(STATEFUL_ROUTE, {
			method: "POST",
			headers: signedHeaders(FORWARDING_SECRET, timestamp, body),
			body,
		});

		expect(response.status).toBe(400);
		expectStructuredError(
			await response.json(),
			"STATEFUL_FORWARDING_ENVELOPE_INVALID",
			"Stateful forwarding envelope must be an object.",
		);
	});
});
