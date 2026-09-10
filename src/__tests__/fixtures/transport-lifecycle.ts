import assert from "node:assert/strict";
import type { ServerWebSocket } from "bun";
import { createBrowserClient } from "../../runtime/browser.js";
import { createHttpClient } from "../../runtime/http.js";
import {
	HttpRetryJitter,
	HttpRetryPreset,
	type BrowserResourceDecision,
	type RequestOptions,
} from "../../types.js";

const scenario = process.argv[2];
// A watchdog fails the process; it never supplies a successful transport result.
const watchdog = setTimeout(() => {
	console.error(`Lifecycle event missing: ${scenario}`);
	process.exit(1);
}, 5_000);

async function cdp(): Promise<void> {
	const releasing = Promise.withResolvers<void>();
	const blocked = Promise.withResolvers<void>();
	const routeEntered = Promise.withResolvers<void>();
	const routeDecision = Promise.withResolvers<BrowserResourceDecision>();
	let acknowledgeRelease: (() => void) | undefined;
	let pageSocket: ServerWebSocket<{ pool: boolean }> | undefined;
	let released = false;
	let releaseCount = 0;
	let reconnects = 0;
	const commands: string[] = [];
	const server = Bun.serve<{ pool: boolean }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			const path = new URL(request.url).pathname;
			if (path === "/barrier") return new Response("ok");
			const pool = path === "/pool";
			if (!pool && released) {
				reconnects++;
				return new Response("Disposed", { status: 410 });
			}
			if (server.upgrade(request, { data: { pool } })) return;
			return new Response("WebSocket required", { status: 400 });
		},
		websocket: {
			open(socket) {
				if (!socket.data.pool) pageSocket = socket;
			},
			message(socket, message) {
				const command: { id: number; method: string; params: Record<string, unknown> } = JSON.parse(
					String(message),
				);
				const reply = (result: object = {}) =>
					socket.send(JSON.stringify({ id: command.id, result }));
				const fail = (message: string) =>
					socket.send(JSON.stringify({ id: command.id, error: { message } }));
				if (socket.data.pool) {
					if (command.method === "acquire")
						reply({
							pageId: "page",
							browserContextId: "context",
							wsEndpoint: `ws://127.0.0.1:${server.port}/page`,
						});
					else if (command.method === "release") {
						releaseCount++;
						assert.deepEqual(command.params, { pageId: "page", browserContextId: "context" });
						acknowledgeRelease = () => {
							released = true;
							reply();
						};
						releasing.resolve();
						if (scenario === "cdp-release-error") fail("release failed");
						else if (scenario !== "cdp-held-release") acknowledgeRelease();
					} else assert.fail(command.method);
					return;
				}
				commands.push(command.method);
				assert.equal(released, false, `Command after disposal: ${command.method}`);
				switch (command.method) {
					case "Page.enable":
					case "Runtime.enable":
					case "Fetch.enable":
						reply();
						break;
					case "Runtime.evaluate":
						reply({ result: {} });
						break;
					case "Fetch.disable":
						if (scenario === "cdp-disable-error") fail("disable failed");
						else reply();
						break;
					case "Fetch.failRequest":
						reply();
						blocked.resolve();
						break;
					case "Fetch.continueRequest":
						reply();
						break;
					default:
						assert.fail(command.method);
				}
			},
		},
	});
	const browser = createBrowserClient({ cdpUrl: `ws://127.0.0.1:${server.port}/pool` });
	const pause = () => {
		assert.ok(pageSocket);
		pageSocket.send(
			JSON.stringify({
				method: "Fetch.requestPaused",
				params: {
					requestId: "paused",
					resourceType: "Document",
					request: { url: "https://example.test/", method: "GET", headers: {} },
				},
			}),
		);
	};
	try {
		const original =
			scenario === "cdp-abort"
				? new DOMException("aborted", "AbortError")
				: new Error("callback failed");
		if (scenario === "cdp-held-release") {
			const page = await browser.newPage();
			let closeSettled = false;
			let operationSettled = false;
			const operation = page
				.withResourcePolicy({ routes: [] }, async () => {
					const first = page.close();
					const second = page.close().then(() => {
						closeSettled = true;
					});
					await releasing.promise;
					pause();
					await blocked.promise;
					assert.equal(closeSettled, false);
					assert.equal(commands.includes("Fetch.disable"), false);
					assert.ok(acknowledgeRelease);
					acknowledgeRelease();
					await Promise.all([first, second]);
					return "ok";
				})
				.then((value) => {
					operationSettled = true;
					return value;
				});
			await releasing.promise;
			assert.equal(operationSettled, false);
			assert.equal(await operation, "ok");
			await page.close();
		} else {
			const outcome = browser.withIsolatedContext((page) =>
				page.withResourcePolicy(
					{
						routes:
							scenario === "cdp-late-route"
								? [
										{
											match: () => true,
											handle: async () => {
												routeEntered.resolve();
												return await routeDecision.promise;
											},
										},
									]
								: [],
					},
					async () => {
						if (scenario === "cdp-open" || scenario === "cdp-disable-error") return "ok";
						if (scenario === "cdp-late-route") {
							pause();
							await routeEntered.promise;
						}
						await page.close();
						if (scenario === "cdp-error" || scenario === "cdp-abort") throw original;
						return "ok";
					},
				),
			);
			if (scenario === "cdp-release-error") await assert.rejects(outcome, /release failed/);
			else if (scenario === "cdp-disable-error") await assert.rejects(outcome, /disable failed/);
			else if (scenario === "cdp-error" || scenario === "cdp-abort")
				await assert.rejects(outcome, (error) => error === original);
			else assert.equal(await outcome, "ok");
			if (scenario === "cdp-late-route") {
				routeDecision.resolve({ action: "continue" });
				await routeDecision.promise;
				// Real I/O barrier after the continuation resumes; no polling or sleep.
				await (await fetch(new URL("/barrier", server.url))).text();
			}
		}
		assert.equal(releaseCount, 1);
		assert.equal(reconnects, 0);
		assert.equal(
			commands.includes("Fetch.disable"),
			scenario === "cdp-open" || scenario === "cdp-disable-error",
		);
	} finally {
		await browser.close();
		await server.stop(true);
	}
}

async function http(): Promise<void> {
	const local = new AbortController();
	const ambient = new AbortController();
	const received = Promise.withResolvers<void>();
	const disconnected = Promise.withResolvers<void>();
	const headersReceived = Promise.withResolvers<void>();
	const backoffStarted = Promise.withResolvers<void>();
	const siblingStarted = Promise.withResolvers<void>();
	const siblingResponse = Promise.withResolvers<Response>();
	let requests = 0;
	let endBody: (() => void) | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request): Response | Promise<Response> {
			if (new URL(request.url).pathname === "/sibling") {
				siblingStarted.resolve();
				return siblingResponse.promise;
			}
			requests++;
			received.resolve();
			if (scenario === "http-headers")
				return new Promise<Response>((resolve) => {
					request.signal.addEventListener(
						"abort",
						() => {
							disconnected.resolve();
							resolve(new Response());
						},
						{ once: true },
					);
				});
			if (scenario === "http-backoff") return new Response("retry", { status: 503 });
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("first"));
						endBody = () => {
							controller.enqueue(new TextEncoder().encode("last"));
							controller.close();
						};
					},
					cancel() {
						disconnected.resolve();
					},
				}),
				{ headers: { "content-type": "text/plain" } },
			);
		},
	});
	const url = server.url.href;
	const nativeFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (...args: Parameters<typeof fetch>) => {
			const response = await nativeFetch(...args);
				headersReceived.resolve();
			return response;
		},
		{ preconnect: nativeFetch.preconnect },
	);
	const nativeSetTimeout = globalThis.setTimeout;
	if (scenario === "http-backoff") {
		globalThis.setTimeout = Object.assign((...args: Parameters<typeof setTimeout>) => {
			const timer = nativeSetTimeout(...args);
			if (args[1] === 10_000) backoffStarted.resolve();
			return timer;
		}, nativeSetTimeout);
	}
	const options: RequestOptions = { signal: local.signal, retry: false };
	const client = createHttpClient(undefined, { signal: ambient.signal });
	const sibling =
		scenario !== "http-stream-ambient" && scenario !== "http-body-error"
			? client.get(new URL("/sibling", url).href)
			: undefined;
	try {
		if (sibling) await siblingStarted.promise;
		if (scenario === "http-pre-abort") {
			local.abort("local reason");
			await assert.rejects(client.get(url, options), { code: "transport_cancelled" });
			assert.equal(requests, 0);
		} else if (
			scenario === "http-headers" ||
			scenario === "http-buffered" ||
			scenario === "http-backoff"
		) {
			if (scenario === "http-backoff")
				options.retry = {
					preset: HttpRetryPreset.RateLimitAware,
					attempts: 3,
					statusCodes: [503],
					baseDelayMs: 10_000,
					maxDelayMs: 10_000,
					jitter: HttpRetryJitter.None,
				};
			const pending = client.get(url, options);
			const rejected = assert.rejects(pending, { code: "transport_cancelled" });
			await (scenario === "http-backoff"
				? backoffStarted.promise
				: scenario === "http-buffered"
					? headersReceived.promise
					: received.promise);
			local.abort(new Error("local deadline"));
			await rejected;
			if (scenario !== "http-backoff") await disconnected.promise;
			assert.equal(requests, 1);
		} else {
			const response = await client.stream(url, options);
			const reader = response.body.getReader();
			assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
			const pending = reader.read();
			if (scenario === "http-eof") {
				assert.ok(endBody);
				endBody();
				assert.equal(new TextDecoder().decode((await pending).value), "last");
				assert.equal((await reader.read()).done, true);
				local.abort();
				assert.equal((await reader.read()).done, true);
			} else if (scenario === "http-body-error") {
				const rejected = assert.rejects(pending);
				await server.stop(true);
				await rejected;
				local.abort();
			} else {
				const rejected = assert.rejects(pending, { code: "transport_cancelled" });
				(scenario === "http-stream-ambient" ? ambient : local).abort(
					new DOMException("deadline", "TimeoutError"),
				);
				await rejected;
			}
			if (scenario !== "http-eof" && scenario !== "http-body-error") await disconnected.promise;
			reader.releaseLock();
		}
		if (sibling) {
			assert.equal(ambient.signal.aborted, false);
			siblingResponse.resolve(new Response("sibling"));
			assert.equal(await (await sibling).text(), "sibling");
		}
	} finally {
		globalThis.fetch = nativeFetch;
		globalThis.setTimeout = nativeSetTimeout;
		ambient.abort();
		await server.stop(true);
	}
}

try {
	if (scenario?.startsWith("cdp-")) await cdp();
	else await http();
	console.log(`${scenario}: ok`);
} finally {
	clearTimeout(watchdog);
}
