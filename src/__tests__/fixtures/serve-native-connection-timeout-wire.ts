// Serves a real provider app on a real local listener and has a real HTTP
// client call operations whose upstream work runs out of time: ctx.native's
// connect deadline (`timeoutMs`) against a peer that never finishes the TLS
// handshake, and ctx.http's `timeout` against an upstream that never answers.
// Prints what serve answered and logged for each scenario.
// serve-native-connection-timeout.test.ts spawns this file so a fetch or
// module mock left by another test file cannot replace the real transports.
import { createServer, type Socket } from "node:net";
import { z } from "zod";
import { defineProvider } from "../../define.js";
import {
	createServerApp,
	ERROR_OBSERVABILITY_HEADER,
	type ProviderServerLogEvent,
} from "../../server/serve.js";

// The upstream: /never never answers, /status-503 is an ordinary upstream
// failure.
const upstream = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request): Response | Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === "/status-503") return new Response("unavailable", { status: 503 });
		return new Promise<Response>(() => {});
	},
});
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;

// A TCP peer that accepts and then stays silent: a TLS client never gets a
// ServerHello from it, and a plain TCP reader never gets a byte.
const sockets = new Set<Socket>();
const silent = createServer((socket) => {
	sockets.add(socket);
	socket.on("close", () => sockets.delete(socket));
});
await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
const silentAddress = silent.address();
if (silentAddress === null || typeof silentAddress === "string") throw new Error("no tcp port");
const silentPort = silentAddress.port;

const CONNECT_TIMEOUT_MS = 100;

const operation = {
	riskClass: "read" as const,
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	upstream: { baseUrl: upstreamOrigin },
	healthCheckUnsupported: { reason: "timeout wire fixture" },
};

const provider = defineProvider({
	allowedHosts: ["example.com"],
	reviewed: "community",
	id: "native-connection-timeout-wire",
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Native Connection Timeout Wire",
		descriptionKey: "native-connection-timeout-wire.description",
		category: "test",
	},
	http: {},
	native: {
		network: { tcp: [{ host: "127.0.0.1", ports: [silentPort], tls: "allowed" }] },
	},
})({
	operations: {
		// ctx.native's own connect deadline expires during the TLS handshake.
		"native-connect-timeout": {
			...operation,
			async handler(ctx) {
				await ctx.native.network.connectTls({
					host: "127.0.0.1",
					port: silentPort,
					serverName: "localhost",
					timeoutMs: CONNECT_TIMEOUT_MS,
				});
				return { ok: true };
			},
		},
		// ctx.http's request timeout expires while the upstream never answers.
		"http-timeout": {
			...operation,
			async handler(ctx) {
				await ctx.http.get("/never", { timeout: CONNECT_TIMEOUT_MS, retry: false });
				return { ok: true };
			},
		},
		// The connection is established, then the peer stays silent past the
		// read idle window: a different timeout-category code, served as before.
		"native-idle-timeout": {
			...operation,
			async handler(ctx) {
				const connection = await ctx.native.network.connectTcp({
					host: "127.0.0.1",
					port: silentPort,
					timeoutMs: 5_000,
					idleTimeoutMs: CONNECT_TIMEOUT_MS,
				});
				try {
					await connection.read();
				} finally {
					await connection.close();
				}
				return { ok: true };
			},
		},
		// An upstream that answered 503: the upstream_http branch.
		"http-upstream-503": {
			...operation,
			async handler(ctx) {
				await ctx.http.get("/status-503", { retry: false });
				return { ok: true };
			},
		},
	},
});

const events: ProviderServerLogEvent[] = [];
const app = createServerApp(provider, { logger: (event) => events.push(event) });

const inbound = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request) => app.fetch(request),
});

async function call(operationId: string) {
	const startedAt = Date.now();
	const response = await fetch(`http://127.0.0.1:${inbound.port}/v1/${operationId}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: `request-${operationId}`, input: {} }),
	});
	const elapsedMs = Date.now() - startedAt;
	const failed = events.find(
		(event) =>
			event.event === "provider_request_failed" && event.requestId === `request-${operationId}`,
	);
	return {
		elapsedMs,
		served: {
			status: response.status,
			observability: JSON.parse(response.headers.get(ERROR_OBSERVABILITY_HEADER) ?? "null"),
			body: await response.json(),
		},
		log: failed,
	};
}

const results = {
	connectTimeoutMs: CONNECT_TIMEOUT_MS,
	"native-connect-timeout": await call("native-connect-timeout"),
	"http-timeout": await call("http-timeout"),
	"native-idle-timeout": await call("native-idle-timeout"),
	"http-upstream-503": await call("http-upstream-503"),
};

inbound.stop(true);
upstream.stop(true);
for (const socket of sockets) socket.destroy();
silent.close();
console.log(JSON.stringify(results));
