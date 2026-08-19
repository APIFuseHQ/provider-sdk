import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";

import { describe, expect, it } from "bun:test";

import { createBrowserClient } from "../../runtime/browser.js";

const PROXY_USER = "test-user";
const PROXY_PASSWORD = "test-pass";

function listen(server: ReturnType<typeof createServer>): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("local test server did not bind to a TCP port"));
				return;
			}
			resolve(address.port);
		});
	});
}

async function closeServer(server: { close(callback: (error?: Error) => void): void }): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

async function startOrigin(): Promise<{ close(): Promise<void>; url: string }> {
	const origin = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/html" });
		response.end("<!doctype html><title>proxy auth</title>");
	});
	const port = await listen(origin);
	return { close: () => closeServer(origin), url: `http://127.0.0.1:${port}/` };
}

async function startProxy(): Promise<{ close(): Promise<void>; url: string }> {
	const proxy = createServer((request, response) => {
		void forwardHttpRequest(request, response);
	});
	proxy.on("connect", (request, clientSocket, head) => {
		void forwardConnect(request, clientSocket, head);
	});
	const port = await listen(proxy);
	return {
		close: () => closeServer(proxy),
		url: `http://${PROXY_USER}:${PROXY_PASSWORD}@127.0.0.1:${port}`,
	};

	function hasCorrectCredentials(request: IncomingMessage): boolean {
		return request.headers["proxy-authorization"] ===
			`Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASSWORD}`).toString("base64")}`;
	}

	function rejectUnauthorized(response: ServerResponse): void {
		response.writeHead(407, { "proxy-authenticate": 'Basic realm="local-test"' });
		response.end();
	}

	async function forwardHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!hasCorrectCredentials(request)) {
			rejectUnauthorized(response);
			return;
		}
		const target = new URL(request.url ?? "");
		const forwardedHeaders = Object.fromEntries(
			Object.entries(request.headers).filter(
				([name, value]) => name !== "proxy-authorization" && value !== undefined,
			),
		);
		const upstream = httpRequest(
			{
				hostname: target.hostname,
				path: `${target.pathname}${target.search}`,
				port: Number(target.port) || 80,
				method: request.method,
				headers: { ...forwardedHeaders, host: target.host },
			},
			(upstreamResponse) => {
				response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
				upstreamResponse.pipe(response);
			},
		);
		upstream.on("error", () => response.destroy());
		request.pipe(upstream);
	}

	async function forwardConnect(
		request: IncomingMessage,
		clientSocket: Socket,
		head: Buffer,
	): Promise<void> {
		if (!hasCorrectCredentials(request)) {
			clientSocket.write("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n");
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
}

describe("authenticated proxy resource-policy interception", () => {
	it("completes navigation through a local authenticating proxy", async () => {
		const origin = await startOrigin();
		const proxy = await startProxy();
		const client = createBrowserClient({
			executablePath: "/usr/local/bin/chromium",
			extraArgs: ["--no-sandbox"],
			headless: true,
			proxy: proxy.url,
			stealth: false,
		});
		try {
			const page = await client.newPage();
			await page.withResourcePolicy(
				{ routes: [{ match: origin.url, handle: () => ({ action: "continue" }) }] },
				async () => {
					await page.goto(origin.url);
					expect(await page.title()).toBe("proxy auth");
				},
			);
			await page.close();
		} finally {
			await client.close();
			await proxy.close();
			await origin.close();
		}
	}, 15_000);

	it("wrong proxy credentials fail promptly instead of hanging", async () => {
		const origin = await startOrigin();
		const proxy = await startProxy();
		const client = createBrowserClient({
			executablePath: "/usr/local/bin/chromium",
			extraArgs: ["--no-sandbox"],
			headless: true,
			proxy: proxy.url.replace(PROXY_PASSWORD, "wrong-pass"),
			stealth: false,
		});
		try {
			const page = await client.newPage();
			const startedAt = Date.now();
			await expect(
				page.withResourcePolicy(
					{ routes: [{ match: origin.url, handle: () => ({ action: "continue" }) }] },
					() => page.goto(origin.url),
				),
			).rejects.toThrow();
			expect(Date.now() - startedAt).toBeLessThan(10_000);
			await page.close();
		} finally {
			await client.close();
			await proxy.close();
			await origin.close();
		}
	}, 15_000);
});
