// Serves real provider apps that declare an operation-scoped NodeMaven mobile
// proxy policy next to a `sessionState` declaration, on the real wreq-js
// stealth transport against a local origin. A local proxy double stands in for
// the NodeMaven gateway, as in nodemaven-operation-scope-wire.ts: the proxy URL
// the SDK synthesizes for gate.nodemaven.com is pointed at the double before
// wreq-js opens it, so the usernames the double receives are the ones the
// gateway would receive and nothing leaves the machine. Prints which exit
// (username) carried each read. session-state-assembly.test.ts spawns this file.
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

process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = "acct123";
process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = "s3cret";
delete process.env.APIFUSE__PROXY__NODEMAVEN_FILTER;

type DoubleHit = {
	mode: "forward" | "connect";
	target: string;
	username: string;
	password: string;
};
type OriginHit = { path: string; status: number; edgeCookie: string | null };

const doubleHits: DoubleHit[] = [];
const originHits: OriginHit[] = [];
const issued = new Set<string>();
let sequence = 0;

function readCookie(header: string | null, name: string): string | null {
	for (const part of (header ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return null;
}

const origin = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request): Response {
		const edgeCookie = readCookie(request.headers.get("cookie"), "__cf_bm");
		sequence += 1;
		const fresh = `edge-${sequence}-${crypto.randomUUID()}`;
		issued.add(fresh);
		const served = edgeCookie !== null && issued.has(edgeCookie);
		originHits.push({
			path: new URL(request.url).pathname,
			status: served ? 200 : 403,
			edgeCookie,
		});
		return served
			? Response.json({ name: "stay-1" }, { headers: { "set-cookie": `__cf_bm=${fresh}; Path=/` } })
			: new Response("<html>RayID /cdn-cgi/challenge-platform/</html>", {
					status: 403,
					headers: {
						server: "cloudflare",
						"cf-ray": "a4e864499984d1cd-ICN",
						"content-type": "text/html; charset=UTF-8",
						"set-cookie": `__cf_bm=${fresh}; Path=/`,
					},
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
const { sessionStatePresets } = await import("../../runtime/session-state-presets.js");

function stayApp(id: string, egress: "independent" | "pinned") {
	const edge = sessionStatePresets.cloudflareBlockPage({
		hosts: ["127.0.0.1"],
		operations: ["get-stay-detail"],
		ttl: "10m",
	});
	const provider = defineProvider({
		id,
		version: "1.0.0",
		runtime: "standard",
		meta: { displayName: id, descriptionKey: `${id}.description`, category: "test" },
		allowedHosts: ["127.0.0.1"],
		stealth: { browser: "chrome", os: "macos" },
		proxy: {
			mode: "required",
			providers: ["nodemaven"],
			geo: { country: "KR" },
			nodemaven: { type: "mobile", isp: ["sk_telecom", "lg_uplus"] },
			operations: ["get-stay-detail"],
		},
		sessionState: {
			stayEdge: { ...edge, distribute: { ...edge.distribute, egress } },
		},
	})({
		operations: {
			"get-stay-detail": {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ status: z.number() }),
				upstream: { baseUrl: originUrl },
				healthCheckUnsupported: { reason: "wire fixture" },
				async handler(ctx) {
					const response = await ctx.stealth.fetch("/stays/1/detail", { throwOnHttpError: false });
					return { status: response.status };
				},
			},
		},
	});
	return createServerApp(provider, { logger: () => {} });
}

async function call(app: ReturnType<typeof stayApp>, requestId: string) {
	const doubleBefore = doubleHits.length;
	const originBefore = originHits.length;
	const response = await app.request("/v1/get-stay-detail", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId, input: {} }),
	});
	return {
		status: response.status,
		body: await response.json(),
		exits: doubleHits.slice(doubleBefore).map((hit) => hit.username),
		origin: originHits.slice(originBefore),
	};
}

const independent = stayApp("egress-independent", "independent");
const pinned = stayApp("egress-pinned", "pinned");
const results = {
	independentFirst: await call(independent, "independent-1"),
	independentSecond: await call(independent, "independent-2"),
	pinnedFirst: await call(pinned, "pinned-1"),
	pinnedSecond: await call(pinned, "pinned-2"),
};

gatewayDouble.close();
origin.stop(true);
console.log(JSON.stringify(results));
