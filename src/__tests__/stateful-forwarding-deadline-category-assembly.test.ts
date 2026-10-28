import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { z } from "zod";

import { defineProvider } from "../define.js";
import {
	categoryForStatus,
	isRetryableCategory,
	PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
} from "../observability.js";
import { executeOperation } from "../runtime/executor.js";
import {
	ERROR_OBSERVABILITY_HEADER,
	type ProviderServerHandle,
	type ProviderServerLogEvent,
	serve,
} from "../server/serve.js";
import {
	buildSessionKey,
	createStatefulOwnerFenceValidator,
	HttpStatefulOwnerForwarder,
	InMemorySessionOwnerRegistry,
	type SessionKey,
	type SessionOwnerRecord,
	StatefulOwnerForwardingError,
} from "../stateful/index.js";

// A stateful owner pod and its source pod over real HTTP. The owner is the
// provider served by serve() on a loopback listener, with signed forwarding,
// the SDK's owner-fence validator over an owner registry, and an internal
// executor that runs the operation through executeOperation. The source is
// the SDK's HttpStatefulOwnerForwarder posting a signed envelope to it; its
// fetch is a tap that records what the owner put on the wire and hands the
// same response back. The forwarded deadline expires on the two paths the
// owner route already guards: before execution, and while the owner-fence
// lookup is still waiting on the registry. A plain operation on the same
// listener times out its own upstream read, so the deadline category and the
// ordinary timeout category are read off the same served pod.

const PROVIDER_ID = "stateful-deadline-category";
const FORWARDING_SECRET = "stateful-deadline-category-secret";
const DEADLINE_CODE = "STATEFUL_FORWARDING_DEADLINE_EXPIRED";
// Categories the deadline was, or could be mistaken for: timeout before this
// taxonomy, upstream_http before the owner route classified it at all (and
// what a gateway that does not know this taxonomy records from the bare 504,
// since the body carries no category), unclassified for an error no category
// claims, and client_cancelled for an inbound request that went away.
const NOT_THE_DEADLINE_CATEGORIES = [
	"timeout",
	"unclassified",
	"upstream_http",
	"client_cancelled",
];

const WireErrorSchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		requestId: z.string().optional(),
		retryable: z.boolean(),
		source: z.string(),
	}),
});
const ObservabilitySchema = z.object({
	category: z.string(),
	taxonomyVersion: z.string(),
	retryable: z.boolean(),
	upstreamStatus: z.number().optional(),
});

type Wire = {
	readonly status: number;
	readonly observability: z.infer<typeof ObservabilitySchema>;
	readonly body: z.infer<typeof WireErrorSchema>;
};

// The upstream: /hold never answers, so a read of it stays in flight until
// its own timeout fires.
const upstream = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(): Promise<Response> {
		return new Promise<Response>(() => {});
	},
});
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;

afterAll(() => {
	upstream.stop(true);
});

const operation = {
	riskClass: "read" as const,
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	upstream: { baseUrl: upstreamOrigin },
	healthCheckUnsupported: { reason: "stateful deadline category fixture" },
};

const provider = defineProvider({
	allowedHosts: ["example.com"],
	reviewed: "community",
	id: PROVIDER_ID,
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Stateful Deadline Category",
		descriptionKey: "stateful-deadline-category.description",
		category: "test",
	},
	http: {},
})({
	operations: {
		"forwarded-read": {
			...operation,
			async handler() {
				return { ok: true };
			},
		},
		// Its own upstream read times out: the ordinary timeout path.
		"upstream-timeout": {
			...operation,
			async handler(ctx) {
				await ctx.http.get("/hold", { timeout: 100, retry: false });
				return { ok: true };
			},
		},
	},
});

/**
 * The SDK's in-memory owner registry, except that while `stalled` its resolve
 * waits like a control plane that stopped answering: it only returns, by
 * throwing the caller's abort reason, when the caller's signal aborts.
 */
class StallableOwnerRegistry extends InMemorySessionOwnerRegistry {
	stalled = false;
	readonly stalledResolveSignals: AbortSignal[] = [];

	override async resolve(
		sessionKey: SessionKey,
		now?: Date,
		signal?: AbortSignal,
	): Promise<SessionOwnerRecord | null> {
		if (this.stalled) {
			if (!signal) throw new Error("A stalled resolve needs a signal to ever return");
			this.stalledResolveSignals.push(signal);
			await new Promise<never>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}
		return super.resolve(sessionKey, now, signal);
	}
}

type OwnerPod = {
	readonly handle: ProviderServerHandle;
	readonly endpoint: string;
	readonly registry: StallableOwnerRegistry;
	readonly events: ProviderServerLogEvent[];
	readonly executions: string[];
};

const startedPods: OwnerPod[] = [];

afterEach(async () => {
	const pods = startedPods.splice(0);
	await Promise.all(pods.map((pod) => pod.handle.close({ timeoutMs: 5_000 })));
});

async function startOwnerPod(): Promise<OwnerPod> {
	const registry = new StallableOwnerRegistry();
	const events: ProviderServerLogEvent[] = [];
	const executions: string[] = [];
	const handle = await serve(provider, {
		host: "127.0.0.1",
		port: 0,
		metricsPort: 0,
		logger: (event) => events.push(event),
		statefulForwarding: {
			secret: FORWARDING_SECRET,
			validateOwnerFence: createStatefulOwnerFenceValidator(registry),
		},
		internalOperationExecutor: ({ provider: served, operationId, ctx, request }) => {
			executions.push(request.requestId);
			return executeOperation(served, operationId, ctx, request.input);
		},
		shutdown: { signals: false },
	});
	const pod: OwnerPod = {
		handle,
		endpoint: `http://127.0.0.1:${handle.port}`,
		registry,
		events,
		executions,
	};
	startedPods.push(pod);
	return pod;
}

async function readWire(response: Response): Promise<Wire> {
	const header = response.headers.get(ERROR_OBSERVABILITY_HEADER);
	if (header === null) throw new Error(`${ERROR_OBSERVABILITY_HEADER} is missing`);
	return {
		status: response.status,
		observability: ObservabilitySchema.parse(JSON.parse(header)),
		body: WireErrorSchema.parse(await response.clone().json()),
	};
}

function failureLog(pod: OwnerPod, requestId: string) {
	const event = pod.events.find(
		(candidate) =>
			candidate.event === "provider_request_failed" && candidate.requestId === requestId,
	);
	if (event?.event !== "provider_request_failed") {
		throw new Error(`No provider_request_failed log for ${requestId}`);
	}
	return event;
}

/**
 * The source pod: the SDK forwarder posts a signed envelope for `requestId`
 * to the owner and reports what it received, while its fetch tap keeps the
 * owner's wire response.
 */
async function forwardFromSourcePod(
	owner: OwnerPod,
	input: {
		readonly requestId: string;
		readonly deadlineAt: string;
		/** Stall the owner registry once the owner holds the session. */
		readonly stallFenceLookup?: boolean;
	},
): Promise<{ readonly wire: Wire; readonly sourceError: StatefulOwnerForwardingError }> {
	const sessionKey = buildSessionKey({
		providerId: PROVIDER_ID,
		serviceAccountId: "account-1",
		connectionId: "connection-1",
	});
	const { record } = await owner.registry.acquire({
		sessionKey,
		ownerPodId: "pod-owner",
		ownerEndpoint: owner.endpoint,
		leaseDurationMs: 60_000,
	});
	if (input.stallFenceLookup) owner.registry.stalled = true;
	const wires: Wire[] = [];
	const forwarder = new HttpStatefulOwnerForwarder({
		currentPodId: "pod-source",
		secret: FORWARDING_SECRET,
		fetch: async (url, init) => {
			const response = await fetch(url, init);
			wires.push(await readWire(response));
			return response;
		},
	});
	const outcome = await forwarder
		.forward(
			record,
			{
				requestId: input.requestId,
				sessionKey,
				providerId: PROVIDER_ID,
				operationId: "forwarded-read",
				connectionId: "connection-1",
				serviceAccountId: "account-1",
				input: {},
				deadlineAt: input.deadlineAt,
				runtimeContext: {
					forwarding: { operationRequest: { requestId: input.requestId, headers: {} } },
				},
			},
			new AbortController().signal,
		)
		.then(
			(result) => result,
			(error: unknown) => error,
		);
	if (!(outcome instanceof StatefulOwnerForwardingError)) {
		throw new Error(
			`Expected the source to receive StatefulOwnerForwardingError, got ${String(outcome)}`,
		);
	}
	const [wire] = wires;
	if (wires.length !== 1 || wire === undefined) {
		throw new Error(`Expected one owner response on the wire, got ${wires.length}`);
	}
	return { wire, sourceError: outcome };
}

function expectServedAsDeadline(
	owner: OwnerPod,
	requestId: string,
	forwarded: { readonly wire: Wire; readonly sourceError: StatefulOwnerForwardingError },
): void {
	const { wire, sourceError } = forwarded;
	expect(wire.status).toBe(504);
	expect(wire.observability).toEqual({
		category: "stateful_forwarding_deadline",
		taxonomyVersion: "2026-10-23",
		retryable: false,
	});
	expect(wire.body).toEqual({
		error: {
			code: DEADLINE_CODE,
			message: "Stateful forwarding deadline expired.",
			requestId,
			retryable: false,
			source: "apifuse",
		},
	});

	const log = failureLog(owner, requestId);
	expect({
		status: log.status,
		code: log.code,
		errorClass: log.errorClass,
		errorCategory: log.errorCategory,
		taxonomyVersion: log.taxonomyVersion,
		retryable: log.retryable,
	}).toEqual({
		status: 504,
		code: DEADLINE_CODE,
		errorClass: "StatefulRoutingDeadlineError",
		errorCategory: "stateful_forwarding_deadline",
		taxonomyVersion: "2026-10-23",
		retryable: false,
	});

	for (const category of NOT_THE_DEADLINE_CATEGORIES) {
		expect(wire.observability.category).not.toBe(category);
		expect(log.errorCategory).not.toBe(category);
	}

	// The source pod receives the deadline's own code and status.
	expect({ code: sourceError.code, status: sourceError.status }).toEqual({
		code: DEADLINE_CODE,
		status: 504,
	});
	expect(owner.executions).toEqual([]);
}

beforeAll(() => {
	// Every expectation below pins the wire literally; this keeps the literal
	// and the emitted constant from drifting apart silently.
	expect(PROVIDER_OBSERVABILITY_TAXONOMY_VERSION).toBe("2026-10-23");
});

describe("stateful forwarding deadline category on a served owner pod", () => {
	it("serves a deadline that expired before execution as stateful_forwarding_deadline", async () => {
		const owner = await startOwnerPod();
		const requestId = "deadline-before-execution";

		const forwarded = await forwardFromSourcePod(owner, {
			requestId,
			deadlineAt: new Date(Date.now() - 1).toISOString(),
		});

		expectServedAsDeadline(owner, requestId, forwarded);
		// Rejected before the owner fence was looked up.
		expect(owner.registry.stalledResolveSignals).toEqual([]);
	});

	it("serves a deadline that expired during the owner-fence lookup as stateful_forwarding_deadline", async () => {
		const owner = await startOwnerPod();
		const requestId = "deadline-during-fence";

		const forwarded = await forwardFromSourcePod(owner, {
			requestId,
			deadlineAt: new Date(Date.now() + 1_000).toISOString(),
			stallFenceLookup: true,
		});

		expectServedAsDeadline(owner, requestId, forwarded);
		// The lookup was in flight and the deadline aborted it.
		expect(owner.registry.stalledResolveSignals).toHaveLength(1);
		expect(owner.registry.stalledResolveSignals[0]?.aborted).toBe(true);
	});

	it("keeps an ordinary upstream timeout on the same pod as timeout", async () => {
		const owner = await startOwnerPod();
		const requestId = "ordinary-upstream-timeout";

		const response = await fetch(`${owner.endpoint}/v1/upstream-timeout`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId, input: {} }),
		});
		const wire = await readWire(response);

		expect(wire.status).toBe(504);
		expect(wire.observability).toEqual({
			category: "timeout",
			taxonomyVersion: "2026-10-23",
			retryable: true,
		});
		expect(wire.body.error.source).toBe("upstream_failure");
		const log = failureLog(owner, requestId);
		expect({
			status: log.status,
			code: log.code,
			errorCategory: log.errorCategory,
			retryable: log.retryable,
		}).toEqual({
			status: 504,
			code: "transport_timeout",
			errorCategory: "timeout",
			retryable: true,
		});
		// A bare 504 still classifies as timeout, and timeout stays retryable;
		// only the deadline error instance carries the deadline category.
		expect(categoryForStatus(504)).toBe("timeout");
		expect(isRetryableCategory("timeout")).toBe(true);
		expect(isRetryableCategory("stateful_forwarding_deadline")).toBe(false);
	});
});
