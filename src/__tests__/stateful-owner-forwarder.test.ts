import { describe, expect, it } from "bun:test";

import {
	buildSessionKey,
	HttpStatefulOwnerForwarder,
	StatefulOwnerForwardingError,
} from "../../dist/stateful/index.js";
import { OperationErrorResponseSchema } from "../../dist/server/index.js";

const sessionKey = buildSessionKey({
	providerId: "test-provider",
	serviceAccountId: "account-a",
	connectionId: "connection-a",
	dimensions: {},
});

function owner(ownerEndpoint: string) {
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
		const error = await forwarder
			.forward(owner("http://pod-owner"), request, new AbortController().signal)
			.catch((cause) => cause);

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
		const error = await forwarder
			.forward(owner("not a URL"), request, new AbortController().signal)
			.catch((cause) => cause);

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
		const error = await forwarder
			.forward(owner("http://pod-owner"), request, new AbortController().signal)
			.catch((cause) => cause);

		expect(error).toBeInstanceOf(StatefulOwnerForwardingError);
		expect(error.code).toBe("STATEFUL_FORWARDING_REQUEST_FAILED");
		expect(error.cause).toBeInstanceOf(TypeError);
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
});
