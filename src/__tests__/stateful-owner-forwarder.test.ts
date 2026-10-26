import { describe, expect, it } from "bun:test";

import type { SessionOwnerRecord } from "../stateful/index.js";

const builtStatefulSpecifier: string = "../../dist/stateful/index.js";
const builtStateful: Promise<typeof import("../stateful/index.js")> = import(
	builtStatefulSpecifier
);
const {
	buildSessionKey,
	HttpStatefulOwnerForwarder,
	statefulForwardingContextFromProviderRequest,
	StatefulOwnerForwardingError,
} = await builtStateful;

const builtServerSpecifier: string = "../../dist/server/index.js";
const builtServer: Promise<typeof import("../server/index.js")> = import(builtServerSpecifier);
const { OperationErrorResponseSchema } = await builtServer;

const sessionKey = buildSessionKey({
	providerId: "test-provider",
	serviceAccountId: "account-a",
	connectionId: "connection-a",
	dimensions: {},
});

function owner(ownerEndpoint: string): SessionOwnerRecord {
	return {
		sessionKey,
		ownerPodId: "pod-owner",
		ownerEndpoint,
		generation: 1,
		leaseExpiresAt: "2026-08-01T00:00:00.000Z",
		status: "connected",
		lastUsedAt: "2026-07-28T00:00:00.000Z",
	};
}

const request = {
	requestId: "request-a",
	sessionKey,
	providerId: "test-provider",
	operationId: "read",
	connectionId: "connection-a",
	serviceAccountId: "account-a",
	input: {},
	runtimeContext: {
		forwarding: {
			operationRequest: {
				requestId: "request-a",
				connection: {
					id: "connection-a",
					mode: "none",
					secrets: {},
					metadata: {},
					externalRef: "external-a",
				},
			},
		},
	},
};

type ForwardingErrorLike = Error & { code: string; status?: number; cause?: unknown };

function isForwardingError(value: unknown): value is ForwardingErrorLike {
	return value instanceof StatefulOwnerForwardingError;
}

async function capturedForwardingError(
	operation: Promise<unknown>,
): Promise<ForwardingErrorLike> {
	try {
		await operation;
		throw new Error("Expected forwarding to fail");
	} catch (cause: unknown) {
		if (isForwardingError(cause)) return cause;
		throw cause;
	}
}

describe("HttpStatefulOwnerForwarder transport failures", () => {
	it("accepts an older owner error without loosening the emitted response schema", async () => {
		const olderOwnerError = {
			error: {
				code: "reauth_required",
				message: "Provider session expired",
			},
		};
		expect(OperationErrorResponseSchema.safeParse(olderOwnerError).success).toBe(false);

		const forwarder = new HttpStatefulOwnerForwarder({
			currentPodId: "pod-source",
			secret: "secret",
			fetch: async () => Response.json(olderOwnerError, { status: 401 }),
		});
		const error = await capturedForwardingError(
			forwarder.forward(owner("http://pod-owner"), request, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(StatefulOwnerForwardingError);
		expect(error).toMatchObject({
			code: "reauth_required",
			message: "Provider session expired",
			status: 401,
		});
	});

	it("wraps URL construction errors", async () => {
		const forwarder = new HttpStatefulOwnerForwarder({
			currentPodId: "pod-source",
			secret: "secret",
		});
		const error = await capturedForwardingError(
			forwarder.forward(owner("not a URL"), request, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(StatefulOwnerForwardingError);
		expect(error.code).toBe("STATEFUL_FORWARDING_REQUEST_FAILED");
	});

	it("wraps fetch transport errors", async () => {
		const forwarder = new HttpStatefulOwnerForwarder({
			currentPodId: "pod-source",
			secret: "secret",
			fetch: async () => {
				throw new TypeError("network down");
			},
		});
		const error = await capturedForwardingError(
			forwarder.forward(owner("http://pod-owner"), request, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(StatefulOwnerForwardingError);
		expect(error.code).toBe("STATEFUL_FORWARDING_REQUEST_FAILED");
		expect(error.cause).toBeInstanceOf(TypeError);
	});

	// A real loopback owner that sends its response headers and the start of
	// an error body, then holds the rest of the body until the test ends.
	function ownerHoldingResponseBody(status: number) {
		const encoder = new TextEncoder();
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(
					new ReadableStream<Uint8Array>({
						async start(controller) {
							controller.enqueue(encoder.encode('{"error":{"code":"STATEFUL_FORWARDING_'));
							await held;
							controller.close();
						},
					}),
					{ status, headers: { "content-type": "application/json" } },
				),
		});
		return {
			endpoint: `http://127.0.0.1:${server.port}`,
			/** Ends the body where it is, before it is valid JSON. */
			endBody: release,
			stop: () => {
				release();
				server.stop(true);
			},
		};
	}

	it("fails a response whose body the forwarding signal cancelled like an aborted request, with the signal's reason", async () => {
		const ownerPod = ownerHoldingResponseBody(504);
		const controller = new AbortController();
		const reason = new DOMException(
			"Stateful operation request request-a deadline has expired.",
			"AbortError",
		);
		const forwarder = new HttpStatefulOwnerForwarder({
			currentPodId: "pod-source",
			secret: "secret",
			// The real fetch; the signal aborts once the owner's headers arrived,
			// while the body is still being read.
			fetch: async (input, init) => {
				const response = await fetch(input, init);
				controller.abort(reason);
				return response;
			},
		});
		try {
			const error = await capturedForwardingError(
				forwarder.forward(owner(ownerPod.endpoint), request, controller.signal),
			);
			expect(error).toMatchObject({ code: "STATEFUL_FORWARDING_REQUEST_FAILED", status: 504 });
			expect(error.cause).toBe(reason);
		} finally {
			ownerPod.stop();
		}
	});

	it("keeps a response body that cannot be parsed while the signal is live a bad response", async () => {
		const ownerPod = ownerHoldingResponseBody(504);
		const forwarder = new HttpStatefulOwnerForwarder({
			currentPodId: "pod-source",
			secret: "secret",
			// Nothing aborts; the owner ends the body before it is valid JSON.
			fetch: async (input, init) => {
				const response = await fetch(input, init);
				ownerPod.endBody();
				return response;
			},
		});
		try {
			const error = await capturedForwardingError(
				forwarder.forward(owner(ownerPod.endpoint), request, new AbortController().signal),
			);
			expect(error).toMatchObject({ code: "STATEFUL_FORWARDING_BAD_RESPONSE", status: 504 });
			expect(error.cause).toBeUndefined();
		} finally {
			ownerPod.stop();
		}
	});

	it("propagates the operation deadline into the signed forwarding envelope", async () => {
		let envelope: Record<string, unknown> | undefined;
		const deadlineAt = "2026-08-01T00:00:15.000Z";
		const forwarder = new HttpStatefulOwnerForwarder({
			currentPodId: "pod-source",
			secret: "secret",
			fetch: async (_url, init) => {
				envelope = JSON.parse(String(init?.body));
				return Response.json({ data: { forwarded: true } });
			},
		});

		await forwarder.forward(
			owner("http://pod-owner"),
			{ ...request, deadlineAt },
			new AbortController().signal,
		);
		expect(envelope?.deadlineAt).toBe(deadlineAt);
	});

	it("propagates the gateway-asserted tenant scope into the signed forwarding envelope", async () => {
		let envelope: { operationRequest?: Record<string, unknown> } | undefined;
		const forwarder = new HttpStatefulOwnerForwarder({
			currentPodId: "pod-source",
			secret: "secret",
			fetch: async (_url, init) => {
				envelope = JSON.parse(String(init?.body));
				return Response.json({ data: { forwarded: true } });
			},
		});
		const forwardingContext = statefulForwardingContextFromProviderRequest({
			requestId: "request-a",
			connection: request.runtimeContext.forwarding.operationRequest.connection,
			tenantId: "org_forwarded_tenant",
		});
		expect(forwardingContext.operationRequest?.tenantId).toBe("org_forwarded_tenant");
		// Absent stays absent: the owner must not see an empty principal scope.
		expect(
			"tenantId" in
				(statefulForwardingContextFromProviderRequest({ requestId: "request-a" })
					.operationRequest ?? {}),
		).toBe(false);

		await forwarder.forward(
			owner("http://pod-owner"),
			{ ...request, runtimeContext: { forwarding: forwardingContext } },
			new AbortController().signal,
		);
		expect(envelope?.operationRequest?.tenantId).toBe("org_forwarded_tenant");
	});

	it("rejects a malformed tenant scope at the source instead of at the owner", async () => {
		// runtimeContext is consumer-supplied and only its requestId is guarded,
		// so a non-string principal scope must fail here: the owner validates the
		// envelope and would fail the whole forwarded operation instead.
		let forwarded = 0;
		const forwarder = new HttpStatefulOwnerForwarder({
			currentPodId: "pod-source",
			secret: "secret",
			fetch: async () => {
				forwarded += 1;
				return Response.json({ data: { forwarded: true } });
			},
		});
		const malformed = {
			...request,
			runtimeContext: {
				forwarding: {
					operationRequest: {
						...request.runtimeContext.forwarding.operationRequest,
						tenantId: { org: "not-a-string" },
					},
				},
			},
		};

		const error = await capturedForwardingError(
			forwarder.forward(owner("http://pod-owner"), malformed, new AbortController().signal),
		);
		expect(error.code).toBe("STATEFUL_FORWARDING_CONTEXT_INVALID");
		expect(forwarded).toBe(0);
	});

	it("treats an empty tenant scope as absent rather than invalid", async () => {
		let envelope: { operationRequest?: Record<string, unknown> } | undefined;
		const forwarder = new HttpStatefulOwnerForwarder({
			currentPodId: "pod-source",
			secret: "secret",
			fetch: async (_url, init) => {
				envelope = JSON.parse(String(init?.body));
				return Response.json({ data: { forwarded: true } });
			},
		});

		await forwarder.forward(
			owner("http://pod-owner"),
			{
				...request,
				runtimeContext: {
					forwarding: {
						operationRequest: {
							...request.runtimeContext.forwarding.operationRequest,
							tenantId: "",
						},
					},
				},
			},
			new AbortController().signal,
		);
		expect("tenantId" in (envelope?.operationRequest ?? {})).toBe(false);
	});
});
