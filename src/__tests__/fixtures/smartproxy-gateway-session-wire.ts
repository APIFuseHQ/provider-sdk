// Runs the smartproxy gateway session model on the real transports against a
// local stand-in for the vendor gateway: the real resolver and vendor selector,
// ctx.stealth on the real wreq-js transport, ctx.http on Bun's native fetch,
// and a real provider app served by createServerApp. Nothing leaves the
// machine: transport-level clients point the vendor at the stand-in through
// `ProxyResolutionOptions.gatewayOverrides`, and the served app (which has no
// such option) reaches it through a hosts-file style rewrite of
// proxy.smartproxy.net:3120 before wreq-js opens the proxy. Any other proxy
// host aborts the run. The stand-in records the Proxy-Authorization it
// receives and can refuse the next connections the way the vendor edge did in
// the 2026-10-26 outage (the tunnel closes immediately). Prints what the
// stand-in, the origin, the selector and serve saw.
// smartproxy-gateway-assembly.test.ts spawns this file so the wreq-js module
// mock in other test files cannot replace the stealth transport.
import { mock } from "bun:test";
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import * as realWreq from "wreq-js";
import { z } from "zod";

const GATEWAY_HOST = "proxy.smartproxy.net";
const GATEWAY_PORT = 3120;
const PROXY_USER = "smart-HUHU123";
const PROXY_PASSWORD = "s3cret";

process.env.APIFUSE__PROXY__SMARTPROXY_USERNAME = PROXY_USER;
process.env.APIFUSE__PROXY__SMARTPROXY_PASSWORD = PROXY_PASSWORD;
for (const name of [
	"APIFUSE__PROXY__SMARTPROXY_APP_KEY",
	"APIFUSE__PROXY__NODEMAVEN_USERNAME",
	"APIFUSE__PROXY__NODEMAVEN_PASSWORD",
	"APIFUSE__PROXY__PROVIDER",
	"APIFUSE__PROXY__DEFAULT_COUNTRY",
	"APIFUSE__PROXY__DEFAULT_LIFETIME_MINUTES",
]) {
	delete process.env[name];
}

type GatewayHit = {
	mode: "forward" | "connect";
	target: string;
	username: string;
	password: string;
	refused: boolean;
};
type GatewayRewrite = { host: string; port: number };

const gatewayHits: GatewayHit[] = [];
const gatewayRewrites: GatewayRewrite[] = [];
let refuseNext = 0;

const origin = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request): Response {
		return Response.json({
			path: new URL(request.url).pathname,
			viaGateway: request.headers.get("x-gateway-double") === "forwarded",
		});
	},
});
const originUrl = `http://127.0.0.1:${origin.port}`;

function readProxyAuthorization(request: IncomingMessage): { username: string; password: string } {
	const header = request.headers["proxy-authorization"] ?? "";
	const encoded = header.startsWith("Basic ") ? header.slice("Basic ".length) : "";
	const decoded = Buffer.from(encoded, "base64").toString("utf8");
	const separator = decoded.indexOf(":");
	return separator < 0
		? { username: decoded, password: "" }
		: { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/** The vendor edge refusing a session: the tunnel closes before any answer. */
function takeRefusal(): boolean {
	if (refuseNext <= 0) return false;
	refuseNext -= 1;
	return true;
}

function forwardHttpRequest(request: IncomingMessage, response: ServerResponse): void {
	const target = new URL(request.url ?? "");
	const refused = takeRefusal();
	gatewayHits.push({
		mode: "forward",
		target: target.pathname,
		refused,
		...readProxyAuthorization(request),
	});
	if (refused) {
		request.socket.destroy();
		return;
	}
	const headers = Object.fromEntries(
		Object.entries(request.headers).filter(
			([name, value]) => name !== "proxy-authorization" && value !== undefined,
		),
	);
	const upstream = httpRequest(
		{
			hostname: target.hostname,
			port: Number(target.port) || 80,
			path: `${target.pathname}${target.search}`,
			method: request.method,
			headers: { ...headers, host: target.host, "x-gateway-double": "forwarded" },
		},
		(upstreamResponse) => {
			response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
			upstreamResponse.pipe(response);
		},
	);
	upstream.on("error", () => response.destroy());
	request.pipe(upstream);
}

function forwardConnect(request: IncomingMessage, clientSocket: Duplex, head: Buffer): void {
	const refused = takeRefusal();
	gatewayHits.push({
		mode: "connect",
		target: request.url ?? "",
		refused,
		...readProxyAuthorization(request),
	});
	if (refused) {
		clientSocket.destroy();
		return;
	}
	const [host, rawPort] = (request.url ?? "").split(":");
	const upstream = connect(Number(rawPort) || 443, host);
	upstream.once("connect", () => {
		clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head.length > 0) upstream.write(head);
		clientSocket.pipe(upstream).pipe(clientSocket);
	});
	upstream.on("error", () => clientSocket.destroy());
}

const gateway = createServer(forwardHttpRequest);
gateway.on("connect", forwardConnect);
const gatewayPort = await new Promise<number>((resolve, reject) => {
	gateway.once("error", reject);
	gateway.listen(0, "127.0.0.1", () => {
		const address = gateway.address();
		if (!address || typeof address === "string") {
			reject(new Error("gateway stand-in did not bind to a TCP port"));
			return;
		}
		resolve(address.port);
	});
});

// The served app has no gatewayOverrides option: rewrite the vendor gateway the
// way a hosts-file entry would, and refuse to open any other remote proxy.
function toGatewayStandIn(proxyUrl: string): string {
	const url = new URL(proxyUrl);
	if (url.hostname === "127.0.0.1" && Number(url.port) === gatewayPort) return proxyUrl;
	if (url.hostname !== GATEWAY_HOST || Number(url.port) !== GATEWAY_PORT) {
		throw new Error(
			`refusing to open a proxy other than ${GATEWAY_HOST}:${GATEWAY_PORT}: ${url.host}`,
		);
	}
	gatewayRewrites.push({ host: url.hostname, port: Number(url.port) });
	url.hostname = "127.0.0.1";
	url.port = String(gatewayPort);
	return url.toString();
}

const realCreateSession = realWreq.createSession;
type CreateSessionOptions = NonNullable<Parameters<typeof realCreateSession>[0]>;
const wreqExports = { ...realWreq };
mock.module("wreq-js", () => ({
	...wreqExports,
	createSession(options?: CreateSessionOptions) {
		if (options?.proxy === undefined) return realCreateSession(options);
		return realCreateSession({ ...options, proxy: toGatewayStandIn(options.proxy) });
	},
}));

const { createStealthClient } = await import("../../runtime/stealth.js");
const { createHttpClient } = await import("../../runtime/http.js");
const { staticOrderProxyVendorSelector } = await import("../../runtime/proxy-vendor-selector.js");
const { ProxyTelemetryCollector } = await import("../../runtime/proxy-telemetry.js");
type ProxyAttemptTelemetryEvent = import("../../config/loader.js").ProxyAttemptTelemetryEvent;
const { defineProvider } = await import("../../define.js");
const { createServerApp } = await import("../../server/serve.js");
type ProxyAttemptRequest = import("../../runtime/proxy-vendor-selector.js").ProxyAttemptRequest;
type ProxyAttemptOutcome = import("../../runtime/proxy-vendor-selector.js").ProxyAttemptOutcome;
type ProxyVendorSelector = import("../../runtime/proxy-vendor-selector.js").ProxyVendorSelector;
type ProviderProxyPolicy = import("../../types.js").ProviderProxyPolicy;
type ServerLogEvent = import("../../server/serve.js").ProviderServerLogEvent;

const gatewayOverrides = { smartproxy: { host: "127.0.0.1", port: gatewayPort } };

function hitsSince(start: number): GatewayHit[] {
	return gatewayHits.slice(start);
}

function recordingSelector(log: {
	selects: ProxyAttemptRequest[];
	reports: ProxyAttemptOutcome[];
}): ProxyVendorSelector {
	return {
		select(request) {
			log.selects.push({
				...request,
				...(request.history ? { history: [...request.history] } : {}),
			});
			return staticOrderProxyVendorSelector.select(request);
		},
		report(outcome) {
			log.reports.push(outcome);
		},
	};
}

const rotatingPolicy: ProviderProxyPolicy = {
	mode: "required",
	providers: ["smartproxy"],
	geo: { country: "KR" },
};

async function stealthRotatingRetry() {
	const selector = { selects: [] as ProxyAttemptRequest[], reports: [] as ProxyAttemptOutcome[] };
	const client = createStealthClient(originUrl, {
		upstream: { proxy: rotatingPolicy },
		gatewayOverrides,
		vendorSelector: recordingSelector(selector),
	});
	const start = gatewayHits.length;
	refuseNext = 1;
	const response = await client.fetch("/stealth-rotating");
	await client.close?.();
	return {
		status: response.status,
		body: await response.json(),
		hits: hitsSince(start),
		selects: selector.selects.map(({ requestId, attempt, attemptCap, history }) => ({
			requestId,
			attempt,
			attemptCap,
			history: history ?? null,
		})),
		reports: selector.reports.map(({ phase, outcome, attempt, requestId, sessionId }) => ({
			phase,
			outcome,
			attempt,
			requestId,
			sessionId,
		})),
	};
}

async function httpRotatingRetry() {
	const attempts: ProxyAttemptTelemetryEvent[] = [];
	const collector = new ProxyTelemetryCollector();
	const client = createHttpClient(originUrl, {
		upstream: { proxy: rotatingPolicy },
		gatewayOverrides,
		warn: () => undefined,
		telemetry: {
			recordProxyResolution(event) {
				collector.recordProxyResolution(event);
			},
			recordProxyAttempt(event) {
				attempts.push(event);
				collector.recordProxyAttempt(event);
			},
		},
	});
	const start = gatewayHits.length;
	refuseNext = 1;
	const response = await client.get("/http-rotating");
	return {
		status: response.status,
		body: response.data,
		hits: hitsSince(start),
		attempts: attempts.map(({ provider, attempt, proxyHash, outcome, errorCode, status }) => ({
			provider,
			attempt,
			proxyHash,
			outcome,
			errorCode,
			status,
		})),
		attemptSamples: collector.toLogPayload()?.attemptSamples ?? [],
	};
}

const STICKY_LIFETIME_MINUTES = 120;
const stickyPolicy: ProviderProxyPolicy = {
	mode: "required",
	providers: ["smartproxy"],
	geo: { country: "KR" },
	session: { affinity: "connection", lifetimeMinutes: STICKY_LIFETIME_MINUTES },
};

function windowEpoch(now: number): number {
	return Math.floor(now / (STICKY_LIFETIME_MINUTES * 60_000));
}

async function stickyAffinityOnce() {
	const epochBefore = windowEpoch(Date.now());
	const options = { upstream: { proxy: stickyPolicy }, gatewayOverrides };
	const first = createStealthClient(originUrl, { ...options, affinityKey: "acct-1" });
	const second = createStealthClient(originUrl, { ...options, affinityKey: "acct-1" });
	const other = createStealthClient(originUrl, { ...options, affinityKey: "acct-2" });
	const read = async (
		client: ReturnType<typeof createStealthClient>,
		path: string,
		refusals = 0,
	) => {
		const start = gatewayHits.length;
		refuseNext = refusals;
		const response = await client.fetch(path);
		return { status: response.status, hits: hitsSince(start) };
	};
	const reads = {
		firstClient: await read(first, "/sticky-1"),
		firstClientAgain: await read(first, "/sticky-2"),
		secondClient: await read(second, "/sticky-3"),
		otherAffinity: await read(other, "/sticky-4"),
		refusedThenRetried: await read(first, "/sticky-5", 1),
	};
	for (const client of [first, second, other]) await client.close?.();
	return { epochBefore, epochAfter: windowEpoch(Date.now()), reads };
}

async function stickyAffinity() {
	// A run that straddles a 120-minute window boundary derives two windows' ids;
	// run it once more so the same-window assertions read one window.
	const run = await stickyAffinityOnce();
	return run.epochBefore === run.epochAfter ? run : await stickyAffinityOnce();
}

const Output = z.object({
	path: z.string().optional(),
	viaGateway: z.boolean().optional(),
	errorCode: z.string().optional(),
	errorMessage: z.string().optional(),
});

function servedProvider(id: string) {
	return defineProvider({
		id,
		version: "1.0.0",
		runtime: "standard",
		meta: {
			displayName: "Smartproxy Gateway Wire",
			descriptionKey: `${id}.description`,
			category: "test",
		},
		allowedHosts: ["127.0.0.1"],
		reviewed: "community",
		stealth: { browser: "chrome", os: "macos" },
		proxy: {
			mode: "required",
			providers: ["smartproxy"],
			geo: { country: "KR" },
			session: { affinity: "request" },
		},
	})({
		operations: {
			"read-through-gateway": {
				riskClass: "read",
				input: z.object({}),
				output: Output,
				upstream: { baseUrl: originUrl },
				healthCheckUnsupported: { reason: "wire fixture" },
				async handler(ctx) {
					try {
						const response = await ctx.stealth.fetch("/served");
						return await response.json<{ path: string; viaGateway: boolean }>();
					} catch (error) {
						const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
						return {
							errorCode: typeof code === "string" ? code : "unknown",
							errorMessage: error instanceof Error ? error.message : String(error),
						};
					}
				},
			},
		},
	});
}

async function served(id: string) {
	const events: ServerLogEvent[] = [];
	const app = createServerApp(servedProvider(id), { logger: (event) => events.push(event) });
	const start = gatewayHits.length;
	const rewriteStart = gatewayRewrites.length;
	const response = await app.request("/v1/read-through-gateway", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: `request-${id}`, input: {} }),
	});
	const completed = events.find(
		(event) => event.event === "provider_request_completed" && event.requestId === `request-${id}`,
	);
	const body = (await response.json()) as { data?: z.infer<typeof Output> };
	return {
		status: response.status,
		data: body.data ?? null,
		hits: hitsSince(start),
		rewrites: gatewayRewrites.slice(rewriteStart),
		logProxy: completed && "proxy" in completed ? completed.proxy : null,
	};
}

async function servedWithoutGatewayCredentials() {
	// The deployment still projects the retired extraction key but not the pair.
	delete process.env.APIFUSE__PROXY__SMARTPROXY_USERNAME;
	delete process.env.APIFUSE__PROXY__SMARTPROXY_PASSWORD;
	process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "retired-extraction-key";
	try {
		return await served("smartproxy-gateway-missing");
	} finally {
		process.env.APIFUSE__PROXY__SMARTPROXY_USERNAME = PROXY_USER;
		process.env.APIFUSE__PROXY__SMARTPROXY_PASSWORD = PROXY_PASSWORD;
		delete process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY;
	}
}

const results = {
	gatewayPort,
	stealthRotating: await stealthRotatingRetry(),
	httpRotating: await httpRotatingRetry(),
	sticky: await stickyAffinity(),
	served: await served("smartproxy-gateway-served"),
	servedMissingCredentials: await servedWithoutGatewayCredentials(),
};

gateway.close();
origin.stop(true);
console.log(JSON.stringify(results));
