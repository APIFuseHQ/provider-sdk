// Serves a real provider app on a real local listener, has a real HTTP client
// call it, and closes that client's connection while the operation is waiting
// on its upstream. Prints what serve answered and logged for each scenario.
// serve-client-cancelled-classification.test.ts spawns this file so the
// wreq-js module mock in other test files cannot replace the stealth transport.
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

// The upstream: /first answers at once, /second never answers, so a request
// to it stays in flight until the caller goes away. /status-503 is an
// ordinary upstream failure.
let secondStarted = waiter();
const upstream = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request): Response | Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === "/first") return Response.json({ ok: true });
		if (path === "/status-503") return new Response("unavailable", { status: 503 });
		secondStarted.resolve();
		return new Promise<Response>(() => {});
	},
});
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;

const operation = {
	riskClass: "read" as const,
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	upstream: { baseUrl: upstreamOrigin },
	healthCheckUnsupported: { reason: "cancellation fixture" },
};

const provider = defineProvider({
	allowedHosts: ["example.com"],
	reviewed: "community",
	id: "client-cancelled-wire",
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Client Cancelled Wire",
		descriptionKey: "client-cancelled-wire.description",
		category: "test",
	},
	http: {},
	stealth: { browser: "chrome", os: "macos" },
})({
	operations: {
		// Two sequential upstream reads, like provider-catchtable's shop: the
		// first returns, the caller leaves during the second.
		"http-sequential": {
			...operation,
			async handler(ctx) {
				await ctx.http.get("/first");
				await ctx.http.get("/second");
				return { ok: true };
			},
		},
		"stealth-sequential": {
			...operation,
			async handler(ctx) {
				await ctx.stealth.fetch("/first");
				await ctx.stealth.fetch("/second");
				return { ok: true };
			},
		},
		// The provider aborts its own upstream read with a per-request signal
		// while the caller stays connected: the same transport_cancelled code,
		// but nobody on the client side cancelled.
		"http-provider-abort": {
			...operation,
			async handler(ctx) {
				await ctx.http.get("/second", { signal: AbortSignal.timeout(50), retry: false });
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

async function call(operationId: string, closeDuringSecondRead: boolean) {
	secondStarted = waiter();
	const done = waiter();
	servedWaiters.set(operationId, done);
	const controller = new AbortController();
	const response = fetch(`http://127.0.0.1:${inbound.port}/v1/${operationId}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: `request-${operationId}`, input: {} }),
		signal: controller.signal,
	}).catch((error: unknown) => (error instanceof Error ? error.name : String(error)));
	if (closeDuringSecondRead) {
		await secondStarted.promise;
		controller.abort();
	}
	const clientSaw = await response;
	await done.promise;
	const failed = events.find(
		(event) =>
			event.event === "provider_request_failed" && event.requestId === `request-${operationId}`,
	);
	return {
		clientAborted: typeof clientSaw === "string",
		served: served.get(operationId),
		log: failed,
	};
}

const results = {
	"http-sequential": await call("http-sequential", true),
	"stealth-sequential": await call("stealth-sequential", true),
	"http-provider-abort": await call("http-provider-abort", false),
	"http-upstream-503": await call("http-upstream-503", false),
};

inbound.stop(true);
upstream.stop(true);
console.log(JSON.stringify(results));
