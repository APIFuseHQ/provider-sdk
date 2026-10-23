// Serves a real provider app on a real local listener and has a real HTTP
// client call it. Each operation opens a ctx.native connection to a real local
// upstream through the real native client and aborts it with a `signal` the
// provider passed itself, or lets the native connect timeout fire. Prints what
// serve answered and logged for each scenario.
// serve-native-provider-abort-classification.test.ts spawns this file, the
// same way serve-client-cancelled-classification.test.ts spawns its wire.
import { createServer, type Socket } from "node:net";
import { z } from "zod";
import { defineProvider } from "../../define.js";
import {
	createServerApp,
	ERROR_OBSERVABILITY_HEADER,
	type ProviderServerLogEvent,
} from "../../server/serve.js";

type Waiter = { promise: Promise<void>; resolve: () => void };

function waiter(): Waiter {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// The upstream: accepts the connection and never answers, so a TLS handshake
// to it stays in flight until the provider's signal or the connect timeout
// ends it.
let holdAccepted = waiter();
let holdConnections = 0;
const held = new Set<Socket>();
const hold = createServer((socket) => {
	holdConnections += 1;
	held.add(socket);
	socket.on("error", () => undefined);
	socket.on("close", () => held.delete(socket));
	holdAccepted.resolve();
});
await new Promise<void>((resolve) => hold.listen(0, "127.0.0.1", resolve));
const holdAddress = hold.address();
if (holdAddress === null || typeof holdAddress === "string") throw new Error("no hold port");
const holdPort = holdAddress.port;

const operation = {
	riskClass: "read" as const,
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	healthCheckUnsupported: { reason: "native abort fixture" },
};

const provider = defineProvider({
	id: "native-provider-abort-wire",
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Native Provider Abort Wire",
		descriptionKey: "native-provider-abort-wire.description",
		category: "test",
	},
	native: { network: { tcp: [{ host: "127.0.0.1", ports: [holdPort], tls: "allowed" }] } },
})({
	operations: {
		// The provider's own AbortSignal.timeout fires while the TLS handshake
		// with the upstream is in flight.
		"native-timeout-abort": {
			...operation,
			async handler(ctx) {
				await ctx.native.network.connectTls({
					host: "127.0.0.1",
					port: holdPort,
					serverName: "localhost",
					signal: AbortSignal.timeout(50),
				});
				return { ok: true };
			},
		},
		// The provider's AbortSignal.timeout has already fired when it connects.
		"native-timeout-abort-before-connect": {
			...operation,
			async handler(ctx) {
				const signal = AbortSignal.timeout(1);
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
				await ctx.native.network.connectTcp({ host: "127.0.0.1", port: holdPort, signal });
				return { ok: true };
			},
		},
		// The provider aborts its own controller while the TLS handshake with
		// the upstream is in flight.
		"native-provider-abort": {
			...operation,
			async handler(ctx) {
				const controller = new AbortController();
				const attempt = ctx.native.network.connectTls({
					host: "127.0.0.1",
					port: holdPort,
					serverName: "localhost",
					signal: controller.signal,
				});
				// Abort once the upstream holds the connection; an attempt that
				// fails before reaching it must not wedge the fixture.
				await Promise.race([holdAccepted.promise, attempt.catch(() => undefined)]);
				controller.abort();
				await attempt;
				return { ok: true };
			},
		},
		// The provider's own controller is already aborted when it connects.
		"native-provider-abort-before-connect": {
			...operation,
			async handler(ctx) {
				const controller = new AbortController();
				controller.abort();
				await ctx.native.network.connectTcp({
					host: "127.0.0.1",
					port: holdPort,
					signal: controller.signal,
				});
				return { ok: true };
			},
		},
		// The native client's own connect timeout, not a signal.
		"native-connect-timeout": {
			...operation,
			async handler(ctx) {
				await ctx.native.network.connectTls({
					host: "127.0.0.1",
					port: holdPort,
					serverName: "localhost",
					timeoutMs: 50,
				});
				return { ok: true };
			},
		},
	},
});

const events: ProviderServerLogEvent[] = [];
const app = createServerApp(provider, { logger: (event) => events.push(event) });

type Served = { status: number; observability: unknown; body: unknown };
const served = new Map<string, Served>();
const servedWaiters = new Map<string, Waiter>();
const inbound = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request): Promise<Response> {
		const response = await app.fetch(request);
		const operationId = new URL(request.url).pathname.split("/").at(-1) ?? "";
		served.set(operationId, {
			status: response.status,
			observability: JSON.parse(response.headers.get(ERROR_OBSERVABILITY_HEADER) ?? "null"),
			body: await response.clone().json(),
		});
		servedWaiters.get(operationId)?.resolve();
		return response;
	},
});

async function call(operationId: string) {
	holdAccepted = waiter();
	const connectionsBefore = holdConnections;
	const done = waiter();
	servedWaiters.set(operationId, done);
	const response = await fetch(`http://127.0.0.1:${inbound.port}/v1/${operationId}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: `request-${operationId}`, input: {} }),
	});
	await response.arrayBuffer();
	await done.promise;
	const failed = events.find(
		(event) =>
			event.event === "provider_request_failed" && event.requestId === `request-${operationId}`,
	);
	return {
		upstreamReached: holdConnections > connectionsBefore,
		served: served.get(operationId),
		log: failed,
	};
}

const results = {
	"native-timeout-abort": await call("native-timeout-abort"),
	"native-timeout-abort-before-connect": await call("native-timeout-abort-before-connect"),
	"native-provider-abort": await call("native-provider-abort"),
	"native-provider-abort-before-connect": await call("native-provider-abort-before-connect"),
	"native-connect-timeout": await call("native-connect-timeout"),
};

inbound.stop(true);
for (const socket of held) socket.destroy();
hold.close();
console.log(JSON.stringify(results));
