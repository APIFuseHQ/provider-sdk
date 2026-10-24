// Serves a real provider app whose NodeMaven mobile proxy policy is scoped to
// one operation, and runs it on the real wreq-js stealth transport against a
// local origin. A local proxy double stands in for the NodeMaven gateway: the
// proxy URL the SDK synthesizes for gate.nodemaven.com is pointed at the double
// before wreq-js opens it, the way a hosts-file entry would, so the username,
// password and request bytes the double receives are the ones the gateway
// would receive and nothing leaves the machine. Any other proxy host aborts
// the run. Prints what the origin, the double and serve saw.
// proxy-policy-scope.test.ts spawns this file so the wreq-js module mock in
// other test files cannot replace the stealth transport.
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

const GATEWAY_HOST = "gate.nodemaven.com";
const PROXY_USER = "acct123";
const PROXY_PASSWORD = "s3cret";

process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = PROXY_USER;
process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = PROXY_PASSWORD;
delete process.env.APIFUSE__PROXY__NODEMAVEN_FILTER;

// Recorded upstream 403 (2026-10-22, a KR stay-detail read through a NodeMaven
// residential exit), trimmed: the status, the headers a provider's block-page
// check reads and the body markers (`RayID`, the challenge-platform script) are
// kept; the brand, the inline image, the exit IP and the cookie are not.
const RECORDED_BLOCK_PAGE = {
	status: 403,
	headers: {
		"content-type": "text/html; charset=UTF-8",
		"cache-control":
			"private, max-age=0, no-store, no-cache, must-revalidate, post-check=0, pre-check=0",
		"referrer-policy": "same-origin",
		"x-frame-options": "SAMEORIGIN",
		server: "cloudflare",
		"cf-ray": "a4e864499984d1cd-ICN",
	},
	body: [
		"<html>",
		'<head><meta charset="utf-8"><title>Temporarily unavailable</title></head>',
		"<body><center>",
		"<h1>일시적으로 서비스를 이용하실 수 없습니다.</h1>",
		"<table><tr><td>IP</td><td>203.0.113.7</td></tr><tr><td>RayID</td><td>a4e864499984d1cd</td></tr></table>",
		"</center>",
		"<script>window.__CF$cv$params={r:'a4e864499984d1cd'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);</script>",
		"</body></html>",
	].join("\n"),
};

type OriginHit = { path: string; forwardedByDouble: boolean };
type DoubleHit = {
	mode: "forward" | "connect";
	target: string;
	username: string;
	password: string;
};
type GatewayRewrite = { host: string; port: number };

const originHits: OriginHit[] = [];
const doubleHits: DoubleHit[] = [];
const gatewayRewrites: GatewayRewrite[] = [];
let detailReads = 0;

const origin = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request): Response {
		const path = new URL(request.url).pathname;
		originHits.push({
			path,
			forwardedByDouble: request.headers.get("x-proxy-double") === "forwarded",
		});
		if (path === "/stays/1/detail") {
			detailReads += 1;
			// The first exit is blocked, the next one passes.
			if (detailReads === 1) {
				return new Response(RECORDED_BLOCK_PAGE.body, {
					status: RECORDED_BLOCK_PAGE.status,
					headers: RECORDED_BLOCK_PAGE.headers,
				});
			}
			return Response.json({ name: "stay-1" });
		}
		if (path === "/stays/search") return Response.json({ name: "search" });
		return new Response("not found", { status: 404 });
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

function forwardHttpRequest(request: IncomingMessage, response: ServerResponse): void {
	const target = new URL(request.url ?? "");
	doubleHits.push({ mode: "forward", target: target.pathname, ...readProxyAuthorization(request) });
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
			headers: { ...headers, host: target.host, "x-proxy-double": "forwarded" },
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
	doubleHits.push({
		mode: "connect",
		target: request.url ?? "",
		...readProxyAuthorization(request),
	});
	const [host, rawPort] = (request.url ?? "").split(":");
	const upstream = connect(Number(rawPort) || 443, host);
	upstream.once("connect", () => {
		clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head.length > 0) upstream.write(head);
		clientSocket.pipe(upstream).pipe(clientSocket);
	});
	upstream.on("error", () => clientSocket.destroy());
}

const gatewayDouble = createServer(forwardHttpRequest);
gatewayDouble.on("connect", forwardConnect);
const gatewayDoublePort = await new Promise<number>((resolve, reject) => {
	gatewayDouble.once("error", reject);
	gatewayDouble.listen(0, "127.0.0.1", () => {
		const address = gatewayDouble.address();
		if (!address || typeof address === "string") {
			reject(new Error("gateway double did not bind to a TCP port"));
			return;
		}
		resolve(address.port);
	});
});

function toGatewayDouble(proxyUrl: string): string {
	const url = new URL(proxyUrl);
	if (url.hostname !== GATEWAY_HOST) {
		throw new Error(`refusing to open a proxy other than ${GATEWAY_HOST}: ${url.hostname}`);
	}
	gatewayRewrites.push({ host: url.hostname, port: Number(url.port) });
	url.hostname = "127.0.0.1";
	url.port = String(gatewayDoublePort);
	return url.toString();
}

const realCreateSession = realWreq.createSession;
type CreateSessionOptions = NonNullable<Parameters<typeof realCreateSession>[0]>;
const wreqExports = { ...realWreq };
mock.module("wreq-js", () => ({
	...wreqExports,
	createSession(options?: CreateSessionOptions) {
		if (options?.proxy === undefined) return realCreateSession(options);
		return realCreateSession({ ...options, proxy: toGatewayDouble(options.proxy) });
	},
}));

const { defineProvider } = await import("../../define.js");
const { createServerApp } = await import("../../server/serve.js");
type ServerLogEvent = import("../../server/serve.js").ProviderServerLogEvent;

const Output = z.object({ name: z.string(), egressAttempts: z.number() });

function isRecordedBlockPage(response: { status: number; body: string }): boolean {
	return (
		response.status === 403 &&
		(response.body.includes("RayID") || response.body.includes("/cdn-cgi/challenge-platform/"))
	);
}

const provider = defineProvider({
	id: "nodemaven-scope-wire",
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "NodeMaven Scope Wire",
		descriptionKey: "nodemaven-scope-wire.description",
		category: "test",
	},
	stealth: { browser: "chrome", os: "macos" },
	proxy: {
		mode: "required",
		providers: ["nodemaven"],
		geo: { country: "KR" },
		nodemaven: { type: "mobile", isp: ["sk_telecom", "lg_uplus"] },
		operations: ["get-stay-detail"],
	},
})({
	operations: {
		// The caller-managed retry a provider writes for an upstream block page:
		// one more attempt on the next pool slot (new sid, next carrier).
		"get-stay-detail": {
			riskClass: "read",
			input: z.object({}),
			output: Output,
			upstream: { baseUrl: originUrl },
			healthCheckUnsupported: { reason: "wire fixture" },
			async handler(ctx) {
				const read = (proxyAttemptOffset?: number) =>
					ctx.stealth.fetch("/stays/1/detail", {
						throwOnHttpError: false,
						...(proxyAttemptOffset === undefined ? {} : { proxyAttemptOffset }),
					});
				let response = await read();
				let egressAttempts = 1;
				if (isRecordedBlockPage(response)) {
					response = await read(1);
					egressAttempts = 2;
				}
				const body = await response.json<{ name: string }>();
				return { name: body.name, egressAttempts };
			},
		},
		"search-stays": {
			riskClass: "read",
			input: z.object({}),
			output: Output,
			upstream: { baseUrl: originUrl },
			healthCheckUnsupported: { reason: "wire fixture" },
			async handler(ctx) {
				const response = await ctx.stealth.fetch("/stays/search");
				const body = await response.json<{ name: string }>();
				return { name: body.name, egressAttempts: 1 };
			},
		},
	},
});

const events: ServerLogEvent[] = [];
const app = createServerApp(provider, { logger: (event) => events.push(event) });

async function call(operationId: string) {
	const doubleBefore = doubleHits.length;
	const originBefore = originHits.length;
	const response = await app.request(`/v1/${operationId}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: `request-${operationId}`, input: {} }),
	});
	const completed = events.find(
		(event) =>
			event.event === "provider_request_completed" && event.requestId === `request-${operationId}`,
	);
	return {
		status: response.status,
		body: await response.json(),
		double: doubleHits.slice(doubleBefore),
		origin: originHits.slice(originBefore),
		logProxy: completed && "proxy" in completed ? completed.proxy : null,
	};
}

const results = {
	gatewayDoublePort,
	searchBefore: await call("search-stays"),
	detail: await call("get-stay-detail"),
	searchAfter: await call("search-stays"),
	gatewayRewrites,
};

gatewayDouble.close();
origin.stop(true);
console.log(JSON.stringify(results));
