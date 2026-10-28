// A real provider app served on a real local listener, called over real HTTP
// on its ordinary operation route and, as a stateful owner pod, by the SDK's
// HttpStatefulOwnerForwarder posting signed envelopes. The operations read a
// real local upstream through ctx.http and cancel that read with a `signal`
// of their own: an AbortSignal.timeout, a bare abort(), or an abort with an
// arbitrary reason, while the request is in flight, while the retry policy is
// backing off, and while a streamed body is being consumed. One operation lets
// ctx.native's own connect deadline expire against a silent TCP peer, for
// comparison with the two ctx.http timeouts. Prints, for each
// scenario, what serve answered and logged, what the source pod's forwarder
// received, and whether the caller or the served request's own signal had
// aborted.
// serve-provider-timeout-cancellation.test.ts spawns this file so module mocks
// in other test files cannot replace the transports.
import { createServer, type Socket } from "node:net";
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

const PROVIDER_ID = "provider-timeout-cancellation-wire";
const FORWARDING_SECRET = "provider-timeout-cancellation-wire-secret";

// The upstream: /hold never answers, /status-503 always answers 503 and
// counts its hits, /drip sends its headers and a first chunk at once and then
// holds the body open.
let holdStarted = waiter();
let status503Hits = 0;
const upstream = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request): Response | Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === "/status-503") {
			status503Hits += 1;
			return new Response("unavailable", { status: 503 });
		}
		if (path === "/drip") {
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("first chunk"));
					},
				}),
				{ headers: { "content-type": "application/octet-stream" } },
			);
		}
		holdStarted.resolve();
		return new Promise<Response>(() => {});
	},
});
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;

// A TCP peer that accepts and then stays silent: a TLS client never gets a
// ServerHello from it.
const silentSockets = new Set<Socket>();
const silent = createServer((socket) => {
	silentSockets.add(socket);
	socket.on("close", () => silentSockets.delete(socket));
});
await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
const silentAddress = silent.address();
if (silentAddress === null || typeof silentAddress === "string") throw new Error("no tcp port");
const silentPort = silentAddress.port;

// Resolved by the listener when the served request's own signal aborts.
let inboundAborted = waiter();
// Resolved by the cleanup operation once its own time limit cancelled the read.
let readCancelled = waiter();
// Bytes of the streamed body the provider had read before its signal fired.
let streamedBytesBeforeAbort = 0;

const operation = {
	riskClass: "read" as const,
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	upstream: { baseUrl: upstreamOrigin },
	healthCheckUnsupported: { reason: "provider timeout cancellation fixture" },
};

const provider = defineProvider({
	allowedHosts: ["example.com"],
	reviewed: "community",
	id: PROVIDER_ID,
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Provider Timeout Cancellation Wire",
		descriptionKey: "provider-timeout-cancellation-wire.description",
		category: "test",
	},
	http: {},
	native: {
		network: { tcp: [{ host: "127.0.0.1", ports: [silentPort], tls: "allowed" }] },
	},
})({
	operations: {
		// The provider bounds its own read with AbortSignal.timeout.
		"timeout-signal": {
			...operation,
			async handler(ctx) {
				await ctx.http.get("/hold", { signal: AbortSignal.timeout(50), retry: false });
				return { ok: true };
			},
		},
		// The same limit through the transport's own `timeout` option.
		"timeout-option": {
			...operation,
			async handler(ctx) {
				await ctx.http.get("/hold", { timeout: 50, retry: false });
				return { ok: true };
			},
		},
		// ctx.native's own connect deadline expires during the TLS handshake:
		// native_connection_timeout, ctx.native's counterpart of transport_timeout.
		"native-connect-timeout": {
			...operation,
			async handler(ctx) {
				await ctx.native.network.connectTls({
					host: "127.0.0.1",
					port: silentPort,
					serverName: "localhost",
					timeoutMs: 50,
				});
				return { ok: true };
			},
		},
		// The provider aborts its read with a bare abort(): an AbortError reason.
		"bare-abort": {
			...operation,
			async handler(ctx) {
				const controller = new AbortController();
				const read = ctx.http.get("/hold", { signal: controller.signal, retry: false });
				await holdStarted.promise;
				controller.abort();
				await read;
				return { ok: true };
			},
		},
		// The provider aborts its read with an arbitrary Error as the reason.
		"reason-abort": {
			...operation,
			async handler(ctx) {
				const controller = new AbortController();
				const read = ctx.http.get("/hold", { signal: controller.signal, retry: false });
				await holdStarted.promise;
				controller.abort(new Error("provider gave up"));
				await read;
				return { ok: true };
			},
		},
		// The upstream answers 503 at once and the retry policy backs off far
		// longer than the provider's own limit, so the limit fires mid-backoff.
		"timeout-signal-during-backoff": {
			...operation,
			async handler(ctx) {
				await ctx.http.get("/status-503", {
					signal: AbortSignal.timeout(1_000),
					retry: {
						attempts: 3,
						statusCodes: [503],
						delayStrategy: "fixed",
						baseDelayMs: 20_000,
						maxDelayMs: 20_000,
						jitter: "none",
					},
				});
				return { ok: true };
			},
		},
		// The headers and a first chunk arrive, then the provider's own limit
		// fires while it waits for the rest of the streamed body.
		"timeout-signal-during-body": {
			...operation,
			async handler(ctx) {
				const response = await ctx.http.stream("/drip", {
					signal: AbortSignal.timeout(1_000),
					retry: false,
				});
				const reader = response.body.getReader();
				const first = await reader.read();
				streamedBytesBeforeAbort = first.value?.byteLength ?? 0;
				await reader.read();
				return { ok: true };
			},
		},
		// A provider limit far longer than the caller stays: the caller leaves.
		"long-timeout-signal": {
			...operation,
			async handler(ctx) {
				await ctx.http.get("/hold", { signal: AbortSignal.timeout(30_000), retry: false });
				return { ok: true };
			},
		},
		// The provider's own limit cancels the read first, and the failure is
		// rethrown only after the caller has also gone.
		"timeout-signal-then-caller-leaves": {
			...operation,
			async handler(ctx) {
				try {
					await ctx.http.get("/hold", { signal: AbortSignal.timeout(50), retry: false });
				} catch (error) {
					readCancelled.resolve();
					await inboundAborted.promise;
					throw error;
				}
				return { ok: true };
			},
		},
		// Reads /hold with no signal of its own: only a deadline can stop it.
		hold: {
			...operation,
			async handler(ctx) {
				await ctx.http.get("/hold", { retry: false });
				return { ok: true };
			},
		},
		"upstream-503": {
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

type Served = {
	status: number;
	observability: unknown;
	body: unknown;
	inboundAborted: boolean;
};
const served = new Map<string, Served>();
const servedWaiters = new Map<string, Waiter>();
const listener = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request): Promise<Response> {
		request.signal.addEventListener("abort", () => inboundAborted.resolve(), { once: true });
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
			inboundAborted: request.signal.aborted,
		});
		servedWaiters.get(requestId)?.resolve();
		return response;
	},
});
const endpoint = `http://127.0.0.1:${listener.port}`;

function failureLog(requestId: string) {
	return events.find(
		(event) => event.event === "provider_request_failed" && event.requestId === requestId,
	);
}

function resetWaiters(requestId: string): Waiter {
	holdStarted = waiter();
	inboundAborted = waiter();
	readCancelled = waiter();
	const done = waiter();
	servedWaiters.set(requestId, done);
	return done;
}

// The ordinary operation route, called by a real HTTP client that stays
// connected unless the scenario says when it leaves.
async function call(input: {
	readonly operationId: string;
	readonly requestId: string;
	readonly callerLeaves?: "when-hold-starts" | "after-read-cancelled";
}) {
	const done = resetWaiters(input.requestId);
	const controller = new AbortController();
	const response = fetch(`${endpoint}/v1/${input.operationId}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: input.requestId, input: {} }),
		signal: controller.signal,
	}).catch((error: unknown) => (error instanceof Error ? error.name : String(error)));
	if (input.callerLeaves === "when-hold-starts") {
		await holdStarted.promise;
		controller.abort();
	}
	if (input.callerLeaves === "after-read-cancelled") {
		await readCancelled.promise;
		controller.abort();
	}
	const clientSaw = await response;
	await done.promise;
	return {
		clientAborted: typeof clientSaw === "string",
		served: served.get(input.requestId),
		log: failureLog(input.requestId),
	};
}

const sessionKey = buildSessionKey({
	providerId: PROVIDER_ID,
	serviceAccountId: "account-1",
	connectionId: "connection-1",
});
const { record: ownerRecord } = await registry.acquire({
	sessionKey,
	ownerPodId: "pod-owner",
	ownerEndpoint: endpoint,
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

// The stateful owner route, posted to by the source pod's real forwarder,
// which never cancels its own request here.
async function forward(input: {
	readonly operationId: string;
	readonly requestId: string;
	readonly deadlineInMs: number;
}) {
	const done = resetWaiters(input.requestId);
	const source = new AbortController();
	const saw = await forwarder
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
			(): SourceSaw => ({ errorClass: "none" }),
			(error: unknown) => sourceSaw(error),
		);
	await done.promise;
	return {
		clientAborted: source.signal.aborted,
		source: saw,
		served: served.get(input.requestId),
		log: failureLog(input.requestId),
	};
}

const results = {
	"timeout-signal": await call({ operationId: "timeout-signal", requestId: "timeout-signal" }),
	"timeout-option": await call({ operationId: "timeout-option", requestId: "timeout-option" }),
	"native-connect-timeout": await call({
		operationId: "native-connect-timeout",
		requestId: "native-connect-timeout",
	}),
	"bare-abort": await call({ operationId: "bare-abort", requestId: "bare-abort" }),
	"reason-abort": await call({ operationId: "reason-abort", requestId: "reason-abort" }),
	"timeout-signal-during-backoff": {
		...(await call({
			operationId: "timeout-signal-during-backoff",
			requestId: "timeout-signal-during-backoff",
		})),
		upstreamHits: status503Hits,
	},
	"timeout-signal-during-body": {
		...(await call({
			operationId: "timeout-signal-during-body",
			requestId: "timeout-signal-during-body",
		})),
		streamedBytesBeforeAbort,
	},
	"stateful-timeout-signal": await forward({
		operationId: "timeout-signal",
		requestId: "stateful-timeout-signal",
		deadlineInMs: 30_000,
	}),
	"stateful-deadline": await forward({
		operationId: "hold",
		requestId: "stateful-deadline",
		deadlineInMs: 400,
	}),
	"caller-leaves": await call({
		operationId: "long-timeout-signal",
		requestId: "caller-leaves",
		callerLeaves: "when-hold-starts",
	}),
	"timeout-signal-then-caller-leaves": await call({
		operationId: "timeout-signal-then-caller-leaves",
		requestId: "timeout-signal-then-caller-leaves",
		callerLeaves: "after-read-cancelled",
	}),
	"upstream-503": await call({ operationId: "upstream-503", requestId: "upstream-503" }),
};

listener.stop(true);
upstream.stop(true);
for (const socket of silentSockets) socket.destroy();
silent.close();
console.log(JSON.stringify(results));
