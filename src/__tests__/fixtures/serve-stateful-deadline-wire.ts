// A stateful owner pod and its source pod, wired over real HTTP: the owner is
// the real provider app (signed forwarding, the SDK's owner-fence validator
// over an in-memory owner registry, an internal executor that runs the
// operation through executeOperation) served on a real local listener, and the
// source is the SDK's HttpStatefulOwnerForwarder posting a signed envelope to
// it. The operations read a real local upstream whose /hold route never
// answers, so the forwarded deadline, or a departing source, cancels ctx.http
// or ctx.stealth mid-read. Prints, for each scenario, what the owner served
// and logged and what the source's forwarder received.
// serve-stateful-deadline-classification.test.ts spawns this file so the
// wreq-js module mock in other test files cannot replace the stealth transport.
import { z } from "zod";
import { defineProvider } from "../../define.js";
import { executeOperation } from "../../runtime/executor.js";
import {
	createServerApp,
	ERROR_OBSERVABILITY_HEADER,
	type ProviderServerLogEvent,
} from "../../server/serve.js";
import {
	buildSessionKey,
	createStatefulOwnerFenceValidator,
	HttpStatefulOwnerForwarder,
	InMemorySessionOwnerRegistry,
	StatefulOwnerForwardingError,
	type SessionOwnerRecord,
} from "../../stateful/index.js";

type Waiter = { promise: Promise<void>; resolve: () => void };

function waiter(): Waiter {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const PROVIDER_ID = "stateful-deadline-wire";
const FORWARDING_SECRET = "stateful-deadline-wire-secret";

// The upstream: /first answers at once, /hold never answers, so a read of it
// stays in flight until its signal aborts. /status-503 is an ordinary
// upstream failure.
let holdStarted = waiter();
const upstream = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request): Response | Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === "/first") return Response.json({ ok: true });
		if (path === "/status-503") return new Response("unavailable", { status: 503 });
		holdStarted.resolve();
		return new Promise<Response>(() => {});
	},
});
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;

// Resolved by the owner listener when the source's connection goes away.
let ownerInboundAborted = waiter();
// Resolved by the cleanup operation once its upstream read was cancelled.
let readCancelled = waiter();

const operation = {
	riskClass: "read" as const,
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	upstream: { baseUrl: upstreamOrigin },
	healthCheckUnsupported: { reason: "stateful deadline fixture" },
};

const provider = defineProvider({
	id: PROVIDER_ID,
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Stateful Deadline Wire",
		descriptionKey: "stateful-deadline-wire.description",
		category: "test",
	},
	http: {},
	stealth: { browser: "chrome", os: "macos" },
})({
	operations: {
		// Two sequential upstream reads; the second is in flight when the
		// deadline or the source cancels it.
		"http-hold": {
			...operation,
			async handler(ctx) {
				await ctx.http.get("/first");
				await ctx.http.get("/hold");
				return { ok: true };
			},
		},
		"stealth-hold": {
			...operation,
			async handler(ctx) {
				await ctx.stealth.fetch("/first");
				await ctx.stealth.fetch("/hold");
				return { ok: true };
			},
		},
		// Rethrows the cancelled read only after the source has also gone, so
		// the owner classifies a deadline cancellation while its inbound
		// request is already aborted.
		"http-hold-then-cleanup": {
			...operation,
			async handler(ctx) {
				try {
					await ctx.http.get("/hold");
				} catch (error) {
					readCancelled.resolve();
					await ownerInboundAborted.promise;
					throw error;
				}
				return { ok: true };
			},
		},
		// The provider aborts its own read with a per-request signal: the same
		// transport_cancelled code, but neither the deadline nor the source.
		"http-provider-abort": {
			...operation,
			async handler(ctx) {
				await ctx.http.get("/hold", { signal: AbortSignal.timeout(50), retry: false });
				return { ok: true };
			},
		},
		"http-upstream-503": {
			...operation,
			async handler(ctx) {
				await ctx.http.get("/status-503", { retry: false });
				return { ok: true };
			},
		},
	},
});

const registry = new InMemorySessionOwnerRegistry();
const events: ProviderServerLogEvent[] = [];
const app = createServerApp(provider, {
	logger: (event) => events.push(event),
	statefulForwarding: {
		secret: FORWARDING_SECRET,
		validateOwnerFence: createStatefulOwnerFenceValidator(registry),
	},
	internalOperationExecutor: ({ provider: served, operationId, ctx, request }) =>
		executeOperation(served, operationId, ctx, request.input),
});

type Served = { status: number; observability: unknown; body: unknown };
const served = new Map<string, Served>();
const servedWaiters = new Map<string, Waiter>();
const owner = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request): Promise<Response> {
		request.signal.addEventListener("abort", () => ownerInboundAborted.resolve(), { once: true });
		const response = await app.fetch(request);
		const body: unknown = await response.clone().json();
		const requestId =
			typeof body === "object" &&
			body !== null &&
			"error" in body &&
			typeof body.error === "object" &&
			body.error !== null &&
			"requestId" in body.error &&
			typeof body.error.requestId === "string"
				? body.error.requestId
				: "";
		served.set(requestId, {
			status: response.status,
			observability: JSON.parse(response.headers.get(ERROR_OBSERVABILITY_HEADER) ?? "null"),
			body,
		});
		servedWaiters.get(requestId)?.resolve();
		return response;
	},
});
const ownerEndpoint = `http://127.0.0.1:${owner.port}`;

const sessionKey = buildSessionKey({
	providerId: PROVIDER_ID,
	serviceAccountId: "account-1",
	connectionId: "connection-1",
});
const { record: ownerRecord } = await registry.acquire({
	sessionKey,
	ownerPodId: "pod-owner",
	ownerEndpoint,
	leaseDurationMs: 60_000,
});
const ownerRecordForForwarder: SessionOwnerRecord = ownerRecord;
const forwarder = new HttpStatefulOwnerForwarder({
	currentPodId: "pod-source",
	secret: FORWARDING_SECRET,
});

type SourceSaw = { errorClass: string; code?: string; status?: number };

function sourceSaw(error: unknown): SourceSaw {
	if (error instanceof StatefulOwnerForwardingError) {
		return {
			errorClass: error.name,
			code: error.code,
			...(error.status !== undefined ? { status: error.status } : {}),
		};
	}
	return { errorClass: error instanceof Error ? error.name : String(error) };
}

function failureLog(requestId: string) {
	return events.find(
		(event) => event.event === "provider_request_failed" && event.requestId === requestId,
	);
}

async function forward(input: {
	readonly operationId: string;
	readonly requestId: string;
	readonly deadlineInMs: number;
	readonly sourceLeaves?: "when-hold-starts" | "after-read-cancelled";
}) {
	holdStarted = waiter();
	readCancelled = waiter();
	ownerInboundAborted = waiter();
	const done = waiter();
	servedWaiters.set(input.requestId, done);
	const source = new AbortController();
	const result = forwarder
		.forward(
			ownerRecordForForwarder,
			{
				requestId: input.requestId,
				sessionKey,
				providerId: PROVIDER_ID,
				operationId: input.operationId,
				connectionId: "connection-1",
				serviceAccountId: "account-1",
				input: {},
				deadlineAt: new Date(Date.now() + input.deadlineInMs).toISOString(),
				runtimeContext: {
					forwarding: { operationRequest: { requestId: input.requestId, headers: {} } },
				},
			},
			source.signal,
		)
		.then(
			() => ({ errorClass: "none" }),
			(error: unknown) => sourceSaw(error),
		);
	if (input.sourceLeaves === "when-hold-starts") {
		await holdStarted.promise;
		source.abort();
	}
	if (input.sourceLeaves === "after-read-cancelled") {
		await readCancelled.promise;
		source.abort();
	}
	const saw = await result;
	await done.promise;
	return {
		source: saw,
		served: served.get(input.requestId),
		log: failureLog(input.requestId),
	};
}

// The same operation on the ordinary route, its caller leaving mid-read: the
// classification a departing caller gets without stateful forwarding.
async function callDirectly(operationId: string, requestId: string) {
	holdStarted = waiter();
	const done = waiter();
	servedWaiters.set(requestId, done);
	const controller = new AbortController();
	const response = fetch(`${ownerEndpoint}/v1/${operationId}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId, input: {} }),
		signal: controller.signal,
	}).catch((error: unknown) => (error instanceof Error ? error.name : String(error)));
	await holdStarted.promise;
	controller.abort();
	await response;
	await done.promise;
	return { served: served.get(requestId), log: failureLog(requestId) };
}

const results = {
	"deadline-http": await forward({
		operationId: "http-hold",
		requestId: "deadline-http",
		deadlineInMs: 400,
	}),
	"deadline-stealth": await forward({
		operationId: "stealth-hold",
		requestId: "deadline-stealth",
		deadlineInMs: 400,
	}),
	"deadline-then-source-leaves": await forward({
		operationId: "http-hold-then-cleanup",
		requestId: "deadline-then-source-leaves",
		deadlineInMs: 400,
		sourceLeaves: "after-read-cancelled",
	}),
	"source-leaves-before-deadline": await forward({
		operationId: "http-hold",
		requestId: "source-leaves-before-deadline",
		deadlineInMs: 30_000,
		sourceLeaves: "when-hold-starts",
	}),
	"direct-caller-leaves": await callDirectly("http-hold", "direct-caller-leaves"),
	"provider-abort": await forward({
		operationId: "http-provider-abort",
		requestId: "provider-abort",
		deadlineInMs: 30_000,
	}),
	"upstream-503": await forward({
		operationId: "http-upstream-503",
		requestId: "upstream-503",
		deadlineInMs: 30_000,
	}),
};

owner.stop(true);
upstream.stop(true);
console.log(JSON.stringify(results));
