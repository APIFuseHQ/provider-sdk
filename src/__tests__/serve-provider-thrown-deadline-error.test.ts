import { afterAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import { defineProvider } from "../define.js";
import { executeOperation } from "../runtime/executor.js";
import { platformFaultOf } from "../sdk-issued-errors.js";
import {
	createServerApp,
	ERROR_OBSERVABILITY_HEADER,
	type ProviderServerLogEvent,
} from "../server/serve.js";
import {
	buildSessionKey,
	buildStatefulOperationRequest,
	createStatefulOwnerFenceValidator,
	HttpStatefulOwnerForwarder,
	InMemorySessionOwnerRegistry,
	type StatefulOperationExecutor,
	type StatefulOwnerForwarder,
	StatefulProviderRuntimeExecutor,
	StatefulRoutingDeadlineError,
	statefulForwardingContextFromProviderRequest,
	withStatefulLocalProviderContext,
} from "../stateful/index.js";

// `StatefulRoutingDeadlineError` is exported from the stateful entry point, so
// provider code can construct one and throw it, or hand it to the session
// router from a forwarder it supplies. Serve must answer such an error like
// any other error the provider threw, never with the forwarding deadline's
// APIFuse-owned outcome (504, STATEFUL_FORWARDING_DEADLINE_EXPIRED, source
// apifuse), which only a deadline the SDK itself detected may produce.
//
// The assembly: a real owner pod (the provider app with signed forwarding,
// the SDK's owner-fence validator over an in-memory owner registry, and an
// internal executor that runs the operation through executeOperation) and a
// real source pod (the provider app whose operation executor routes through
// the SDK's StatefulProviderRuntimeExecutor and HttpStatefulOwnerForwarder),
// each on its own local listener, called by a real HTTP client. The SDK's own
// deadline expiry runs through the same two apps as the control.

const PROVIDER_ID = "provider-thrown-deadline";
const FORWARDING_SECRET = "provider-thrown-deadline-secret";
const PLATFORM_DEADLINE_CODE = "STATEFUL_FORWARDING_DEADLINE_EXPIRED";

function futureDeadline(): string {
	return new Date(Date.now() + 30_000).toISOString();
}

function pastDeadline(): string {
	return new Date(Date.now() - 1_000).toISOString();
}

const operation = {
	riskClass: "read" as const,
	descriptionKey: "operations.operation.description",
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	healthCheckUnsupported: { reason: "provider-thrown deadline assembly" },
};

const provider = defineProvider({
	allowedHosts: ["example.com"],
	reviewed: "community",
	id: PROVIDER_ID,
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Provider Thrown Deadline",
		descriptionKey: "provider-thrown-deadline.description",
		category: "test",
	},
})({
	operations: {
		// The provider constructs the public class itself, with a deadline that
		// has already passed, the way a provider would to report its own
		// timeout as APIFuse's.
		"throws-deadline-class": {
			...operation,
			async handler() {
				throw new StatefulRoutingDeadlineError("provider-made", pastDeadline());
			},
		},
		// Any other error the provider throws: what the class above must be
		// served like.
		"throws-plain-error": {
			...operation,
			async handler() {
				throw new Error("The provider failed.");
			},
		},
		succeeds: {
			...operation,
			async handler() {
				return { ok: true };
			},
		},
	},
});

type Served = { status: number; observability: unknown; body: unknown };

function errorRequestId(body: unknown): string {
	return typeof body === "object" &&
		body !== null &&
		"error" in body &&
		typeof body.error === "object" &&
		body.error !== null &&
		"requestId" in body.error &&
		typeof body.error.requestId === "string"
		? body.error.requestId
		: "";
}

async function readServed(response: Response): Promise<Served> {
	return {
		status: response.status,
		observability: JSON.parse(response.headers.get(ERROR_OBSERVABILITY_HEADER) ?? "null"),
		body: await response.json(),
	};
}

// Serves `fetchApp` on a real listener and records the error response it built
// for each request id.
function recordingListener(fetchApp: (request: Request) => Response | Promise<Response>) {
	const served = new Map<string, Served>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request): Promise<Response> {
			const response = await fetchApp(request);
			const record = await readServed(response.clone());
			served.set(errorRequestId(record.body), record);
			return response;
		},
	});
	return { server, served, endpoint: `http://127.0.0.1:${server.port}` };
}

// Owner pod.
const ownerEvents: ProviderServerLogEvent[] = [];
const registry = new InMemorySessionOwnerRegistry();
const ownerApp = createServerApp(provider, {
	logger: (event) => ownerEvents.push(event),
	statefulForwarding: {
		secret: FORWARDING_SECRET,
		validateOwnerFence: createStatefulOwnerFenceValidator(registry),
	},
	internalOperationExecutor: ({ provider: servedProvider, operationId, ctx, request }) =>
		executeOperation(servedProvider, operationId, ctx, request.input),
});
const ownerPod = recordingListener((request) => ownerApp.fetch(request));

const sessionKey = buildSessionKey({
	providerId: PROVIDER_ID,
	serviceAccountId: "account-1",
	connectionId: "connection-1",
});
const { record: ownerRecord } = await registry.acquire({
	sessionKey,
	ownerPodId: "pod-owner",
	ownerEndpoint: ownerPod.endpoint,
	leaseDurationMs: 60_000,
});

// Source pod. Its "live" route forwards to the owner pod with the SDK's HTTP
// forwarder; its "provider-forwarder" route uses a forwarder the provider
// supplied, which throws the public deadline class.
const sourceNeverOwns: StatefulOperationExecutor = {
	async executeLocal() {
		throw new Error("The source pod never owns the session in this assembly.");
	},
};

const providerForwarder: StatefulOwnerForwarder = {
	async forward(_owner, request) {
		throw new StatefulRoutingDeadlineError(request.requestId, pastDeadline());
	},
};

function sourceRoute(forwarder: StatefulOwnerForwarder): StatefulProviderRuntimeExecutor {
	return new StatefulProviderRuntimeExecutor({
		currentPod: { podId: "pod-source", endpoint: "http://127.0.0.1:1" },
		registry,
		forwarder,
		executor: sourceNeverOwns,
		leaseDurationMs: 60_000,
	});
}

const sourceRoutes = new Map<string, StatefulProviderRuntimeExecutor>([
	[
		"live",
		sourceRoute(
			new HttpStatefulOwnerForwarder({ currentPodId: "pod-source", secret: FORWARDING_SECRET }),
		),
	],
	["provider-forwarder", sourceRoute(providerForwarder)],
]);

const sourceEvents: ProviderServerLogEvent[] = [];
// The error the source pod's session router threw for each request id, as
// serve received it.
const sourceRouteErrors = new Map<string, unknown>();
const sourceApp = createServerApp(provider, {
	logger: (event) => sourceEvents.push(event),
	// The README's stateful operation executor: route the operation through the
	// session router, which forwards it to the owner pod.
	operationExecutor: async ({ ctx, request, operationId }) => {
		const headers = request.headers ?? {};
		const route = sourceRoutes.get(headers["x-test-route"] ?? "");
		if (!route) throw new Error("unknown source route");
		try {
			const result = await route.invoke(
				buildStatefulOperationRequest({
					requestId: request.requestId,
					sessionKey,
					providerId: PROVIDER_ID,
					operationId,
					connectionId: "connection-1",
					serviceAccountId: "account-1",
					input: request.input,
					...(headers["x-test-deadline-at"] ? { deadlineAt: headers["x-test-deadline-at"] } : {}),
					runtimeContext: withStatefulLocalProviderContext(
						ctx,
						statefulForwardingContextFromProviderRequest(request),
					),
				}),
			);
			return result.output;
		} catch (error) {
			sourceRouteErrors.set(request.requestId, error);
			throw error;
		}
	},
});
const sourcePod = recordingListener((request) => sourceApp.fetch(request));

afterAll(() => {
	sourcePod.server.stop(true);
	ownerPod.server.stop(true);
});

async function call(
	endpoint: string,
	operationId: string,
	requestId: string,
	headers: Record<string, string> = {},
): Promise<Served> {
	const response = await fetch(`${endpoint}/v1/${operationId}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId, input: {}, headers }),
	});
	return readServed(response);
}

// Sends one signed forwarding envelope straight to the owner pod, the way the
// source pod's router would, without the router's own deadline check.
async function forwardToOwner(operationId: string, requestId: string, deadlineAt: string) {
	const forwarder = new HttpStatefulOwnerForwarder({
		currentPodId: "pod-source",
		secret: FORWARDING_SECRET,
	});
	await forwarder
		.forward(
			ownerRecord,
			{
				requestId,
				sessionKey,
				providerId: PROVIDER_ID,
				operationId,
				connectionId: "connection-1",
				serviceAccountId: "account-1",
				input: {},
				deadlineAt,
				runtimeContext: { forwarding: { operationRequest: { requestId, headers: {} } } },
			},
			new AbortController().signal,
		)
		.catch(() => undefined);
	return ownerPod.served.get(requestId);
}

function failureLog(events: ProviderServerLogEvent[], requestId: string) {
	return events.find(
		(event) => event.event === "provider_request_failed" && event.requestId === requestId,
	);
}

// What serve answers for an error the provider threw that it does not
// recognize, with everything but the error class it names.
function providerFailureOutcome(served: Served | undefined) {
	return {
		status: served?.status,
		observability: served?.observability,
		body: served?.body,
	};
}

function maskedInternalError(requestId: string, errorClass: string): Served {
	return {
		status: 500,
		observability: expect.objectContaining({ category: "internal_error", retryable: false }),
		body: {
			error: {
				code: "internal_error",
				message: "Internal error",
				requestId,
				retryable: false,
				source: "apifuse",
				details: { retryable: false, category: "internal_error", errorClass },
			},
		},
	};
}

describe("a provider-constructed StatefulRoutingDeadlineError", () => {
	it("is served like any other provider error on the operation route", async () => {
		const lookalike = await call(ownerPod.endpoint, "throws-deadline-class", "direct-lookalike");
		const plain = await call(ownerPod.endpoint, "throws-plain-error", "direct-plain");

		expect(lookalike.status).not.toBe(504);
		expect(providerFailureOutcome(lookalike)).toEqual(
			maskedInternalError("direct-lookalike", "StatefulRoutingDeadlineError"),
		);
		expect(providerFailureOutcome(plain)).toEqual(maskedInternalError("direct-plain", "Error"));
		expect(lookalike.observability).toEqual(plain.observability);
		expect(failureLog(ownerEvents, "direct-lookalike")).toMatchObject({
			status: 500,
			code: "internal_error",
			errorClass: "StatefulRoutingDeadlineError",
			errorCategory: "internal_error",
		});
	});

	it("is served like any other provider error when a forwarded operation throws it on the owner pod", async () => {
		const caller = await call(sourcePod.endpoint, "throws-deadline-class", "owner-lookalike", {
			"x-test-route": "live",
			"x-test-deadline-at": futureDeadline(),
		});
		const owner = ownerPod.served.get("owner-lookalike");

		expect(providerFailureOutcome(owner)).toEqual(
			maskedInternalError("owner-lookalike", "StatefulRoutingDeadlineError"),
		);
		expect(failureLog(ownerEvents, "owner-lookalike")).toMatchObject({
			status: 500,
			code: "internal_error",
			errorClass: "StatefulRoutingDeadlineError",
		});
		// The source pod fails with the owner's relayed failure, not with a
		// forwarding deadline.
		expect(providerFailureOutcome(caller)).toEqual(
			maskedInternalError("owner-lookalike", "StatefulOwnerForwardingError"),
		);
		expect(failureLog(sourceEvents, "owner-lookalike")).toMatchObject({
			status: 500,
			code: "internal_error",
			errorClass: "StatefulOwnerForwardingError",
		});
	});

	it("is served like any other provider error when a provider-supplied forwarder throws it to the router", async () => {
		const caller = await call(sourcePod.endpoint, "succeeds", "forwarder-lookalike", {
			"x-test-route": "provider-forwarder",
			"x-test-deadline-at": futureDeadline(),
		});

		expect(providerFailureOutcome(caller)).toEqual(
			maskedInternalError("forwarder-lookalike", "StatefulRoutingDeadlineError"),
		);
		expect(failureLog(sourceEvents, "forwarder-lookalike")).toMatchObject({
			status: 500,
			code: "internal_error",
			errorClass: "StatefulRoutingDeadlineError",
		});
		// The router handed serve the provider's own instance, which carries
		// no platform fault.
		const thrown = sourceRouteErrors.get("forwarder-lookalike");
		expect(thrown).toBeInstanceOf(StatefulRoutingDeadlineError);
		expect(platformFaultOf(thrown)).toBeUndefined();
	});
});

// The same assembly still serves a deadline the SDK detected as the
// forwarding deadline, so the cases above are not served as provider errors
// merely because nothing is recognized any more.
describe("a deadline the SDK detects in the same assembly", () => {
	function expectPlatformDeadline(served: Served | undefined, requestId: string) {
		expect(served?.status).toBe(504);
		expect(served?.body).toEqual({
			error: {
				code: PLATFORM_DEADLINE_CODE,
				message: "Stateful forwarding deadline expired.",
				requestId,
				retryable: false,
				source: "apifuse",
			},
		});
		expect(served?.observability).not.toMatchObject({ category: "internal_error" });
		expect(served?.observability).toMatchObject({ retryable: false });
	}

	it("serves a forwarded deadline that expired before the owner pod executed", async () => {
		const owner = await forwardToOwner("succeeds", "owner-expired", pastDeadline());
		expectPlatformDeadline(owner, "owner-expired");
		expect(failureLog(ownerEvents, "owner-expired")).toMatchObject({
			status: 504,
			code: PLATFORM_DEADLINE_CODE,
			errorClass: "StatefulRoutingDeadlineError",
		});
	});

	it("serves a deadline that expired before the source pod's router forwarded", async () => {
		const caller = await call(sourcePod.endpoint, "succeeds", "source-expired", {
			"x-test-route": "live",
			"x-test-deadline-at": pastDeadline(),
		});
		expectPlatformDeadline(caller, "source-expired");
		expect(failureLog(sourceEvents, "source-expired")).toMatchObject({
			status: 504,
			code: PLATFORM_DEADLINE_CODE,
			errorClass: "StatefulRoutingDeadlineError",
		});
		// The router's check before routing issued its error as the deadline's
		// platform fault.
		expect(platformFaultOf(sourceRouteErrors.get("source-expired"))).toEqual({
			category: "stateful_forwarding_deadline",
			code: PLATFORM_DEADLINE_CODE,
			status: 504,
			retryable: false,
		});
	});
});
