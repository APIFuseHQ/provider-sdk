import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { createServer, type Server } from "node:http";

import type { BrowserClient } from "../../types.js";
import { createBrowserClient } from "../../runtime/browser.js";
import { createBrowserResolverVendorAdapter } from "../../runtime/resolver-vendors/browser.js";
import {
	realBrowserAvailable,
	realBrowserExecutablePath,
} from "./real-browser-availability.js";

const requestCounts = new Map<string, number>();
let origin = "";
let server: Server;
let sharedClient: ReturnType<typeof createBrowserClient>;

setDefaultTimeout(20_000);

function countRequest(pathname: string): void {
	requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
}

function requestCount(pathname: string): number {
	return requestCounts.get(pathname) ?? 0;
}

beforeAll(async () => {
	server = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", origin);
		countRequest(requestUrl.pathname);
		const targetOrigin = origin.replace("127.0.0.1", "localhost");

		switch (requestUrl.pathname) {
			case "/allowed-start":
				response.writeHead(302, { location: "/allowed-hop" });
				response.end();
				return;
			case "/allowed-hop":
				response.writeHead(307, {
					location: "/allowed-final",
					"set-cookie": "aws-waf-token=allowed-chain-token; Path=/; HttpOnly",
				});
				response.end();
				return;
			case "/allowed-final":
				response.writeHead(200, { "content-type": "text/html" });
				response.end("<!doctype html><title>allowed-final</title>");
				return;
			case "/blocked-start":
				response.writeHead(302, { location: `${targetOrigin}/metadata` });
				response.end();
				return;
			case "/metadata":
				response.writeHead(200, { "content-type": "text/html" });
				response.end(
					"<script>document.cookie='aws-waf-token=unauthorized-navigation; Path=/'</script>",
				);
				return;
			case "/subresource-page":
				response.writeHead(200, { "content-type": "text/html" });
				response.end(`<!doctype html><script>
					const image = new Image();
					image.onload = image.onerror = () => {
						document.cookie = "aws-waf-token=subresource-finished; Path=/";
					};
					image.src = "/subresource-hop";
				</script>`);
				return;
			case "/subresource-hop":
				response.writeHead(302, { location: `${targetOrigin}/metadata-image` });
				response.end();
				return;
			case "/metadata-image":
				response.writeHead(200, { "content-type": "image/gif" });
				response.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
				return;
			case "/popup-page":
				response.writeHead(200, { "content-type": "text/html" });
				response.end(`<!doctype html><script>
					window.open("${targetOrigin}/popup-target");
					setTimeout(() => {
						document.cookie = "aws-waf-token=popup-finished; Path=/";
					}, 100);
				</script>`);
				return;
			case "/popup-target":
				response.writeHead(200, { "content-type": "text/html" });
				response.end("<!doctype html><title>unauthorized popup</title>");
				return;
			case "/service-worker-page":
				response.writeHead(200, { "content-type": "text/html" });
				response.end(`<!doctype html><script>
					navigator.serviceWorker.register("/sw.js").finally(() => {
						document.cookie = "aws-waf-token=service-worker-finished; Path=/";
					});
				</script>`);
				return;
			case "/sw.js":
				response.writeHead(200, { "content-type": "application/javascript" });
				response.end("self.addEventListener('fetch', () => undefined)");
				return;
			default:
				response.writeHead(404);
				response.end("not found");
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Local redirect server has no port");
	origin = `http://127.0.0.1:${address.port}`;
	sharedClient = createBrowserClient({
		executablePath: realBrowserExecutablePath,
		headless: true,
		serviceWorkers: "block",
		stealth: false,
	});
});

afterAll(async () => {
	await sharedClient.close();
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
});

async function solve(pathname: string, timeoutMs = 10_000) {
	const adapter = createBrowserResolverVendorAdapter({
		allowedHosts: ["127.0.0.1"],
		createClient() {
			return {
				engine: sharedClient.engine,
				async close() {},
				newPage: () => sharedClient.newPage(),
				rawPage: () => sharedClient.rawPage(),
				solveChallenge: (request) => sharedClient.solveChallenge(request),
				withIsolatedContext: (handler) => sharedClient.withIsolatedContext(handler),
			} satisfies BrowserClient;
		},
		pollIntervalMs: 10,
		timeoutMs,
	});

	return await adapter.solve(
		{ kind: "aws_waf", pageUrl: `${origin}${pathname}` },
		{ proxyUrl: "http://resolver-identity.invalid", userAgent: "EgressPolicyTest/1.0" },
		new AbortController().signal,
	);
}

describe.skipIf(!realBrowserAvailable)("real resolver browser egress policy", () => {
	it("blocks an allowed navigation before dialing its undeclared redirect target", async () => {
		let error: unknown;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			requestCounts.delete("/blocked-start");
			requestCounts.delete("/metadata");
			error = await solve("/blocked-start", 5_000).catch((cause: unknown) => cause);
			if (requestCount("/blocked-start") > 0) break;
		}

		expect(error).toBeInstanceOf(Error);
		expect(requestCount("/blocked-start")).toBe(1);
		expect(requestCount("/metadata")).toBe(0);
	});

	it("allows an authorized multi-hop navigation and preserves its intermediate cookie", async () => {
		const result = await solve("/allowed-start");

		expect(result.cookies).toEqual({ "aws-waf-token": "allowed-chain-token" });
		expect(requestCount("/allowed-start")).toBe(1);
		expect(requestCount("/allowed-hop")).toBe(1);
		expect(requestCount("/allowed-final")).toBe(1);
	});

	it("blocks an undeclared subresource redirect target before it is dialed", async () => {
		const result = await solve("/subresource-page");

		expect(result.cookies).toEqual({ "aws-waf-token": "subresource-finished" });
		expect(requestCount("/subresource-hop")).toBe(1);
		expect(requestCount("/metadata-image")).toBe(0);
	});

	it("applies the context policy to a popup's first request", async () => {
		const result = await solve("/popup-page");

		expect(result.cookies).toEqual({ "aws-waf-token": "popup-finished" });
		expect(requestCount("/popup-target")).toBe(0);
	});

	it("blocks service workers in the resolver context", async () => {
		const result = await solve("/service-worker-page");

		expect(result.cookies).toEqual({ "aws-waf-token": "service-worker-finished" });
		expect(requestCount("/sw.js")).toBe(0);
	});
});
