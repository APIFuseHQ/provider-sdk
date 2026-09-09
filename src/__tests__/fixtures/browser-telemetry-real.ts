import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserClient } from "../../runtime/browser.js";
import { BrowserTelemetryCollector } from "../../runtime/browser-telemetry.js";
import { createDiagnosticRedactor } from "../../runtime/diagnostic-redactor.js";
import { withDiagnosticEnv } from "../../runtime/diagnostic-env.js";
import { wrapWithInstrumentation } from "../../runtime/instrumentation.js";
import { RequestTelemetry } from "../../runtime/request-telemetry.js";
import { createTraceContext } from "../../runtime/trace.js";
import { exportSpansOTLP, swapOTLPTransportForTests } from "../../runtime/otlp.js";
import { createBrowserClientDouble, createProviderContextDouble } from "../test-utils.js";
import { realBrowserAvailable, realBrowserExecutablePath } from "./real-browser-availability.js";

describe.skipIf(!realBrowserAvailable)("real Chromium browser telemetry", () => {
	it("recorder on/off preserves newPage, goto 404, click, fill, type, wait, evaluate, content, screenshot, cookies and isolated context", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: (request) =>
				new Response(
					'<!doctype html><input id="input"><button id="button" onclick="document.body.dataset.clicked=\'yes\'">click</button>',
					{
						status: new URL(request.url).pathname === "/404" ? 404 : 200,
						headers: { "content-type": "text/html" },
					},
				),
		});
		const run = async (record: boolean) => {
			const client = createBrowserClient({
				cdpUrl: "",
				stealth: false,
				executablePath: realBrowserExecutablePath,
				telemetry: record ? new BrowserTelemetryCollector() : undefined,
			});
			try {
				const page = await client.newPage();
				await page.goto(`http://127.0.0.1:${server.port}/404`);
				await page.fill("#input", "a");
				await page.type("#input", "b");
				await page.click("#button");
				await page.waitForSelector("#input");
				const result = {
					value: await page.evaluate("document.querySelector('#input').value"),
					content: await page.content(),
					screenshot: await page.screenshot(),
					cookies: await page.cookies(),
					isolated: await client.withIsolatedContext(async (isolated) => {
						await isolated.goto(`http://127.0.0.1:${server.port}/`);
						return isolated.title();
					}),
				};
				const error = await page
					.waitForSelector("#missing", { timeout: 20 })
					.catch((caught: unknown) => caught);
				return { result, error };
			} finally {
				await client.close();
			}
		};
		try {
			const off = await run(false);
			const on = await run(true);
			expect(on.result).toEqual(off.result);
			expect(on.error instanceof Error && on.error.constructor).toBe(
				off.error instanceof Error && off.error.constructor,
			);
			expect(on.error instanceof Error && on.error.message).toBe(
				off.error instanceof Error && off.error.message,
			);
		} finally {
			server.stop(true);
		}
	}, 30000);
	for (const engine of ["playwright", "cdp-pool"] as const)
		it(`${engine} Set-Cookie values are absent from error diagnostics, log, header, spans and OTLP`, async () => {
			const origin = Bun.serve({
				port: 0,
				fetch: () =>
					new Response("<!doctype html><body>page state sid=abcdef123456</body>", {
						headers: {
							"content-type": "text/html",
							"set-cookie": "sid=abcdef123456; Path=/; HttpOnly",
						},
					}),
			});
			let chrome: ReturnType<typeof Bun.spawn> | undefined;
			let directory: string | undefined;
			let pool: ReturnType<typeof Bun.serve> | undefined;
			let cdpUrl = "";
			if (engine === "cdp-pool") {
				directory = mkdtempSync(join(tmpdir(), "browser-telemetry-chrome-"));
				chrome = Bun.spawn(
					[
						realBrowserExecutablePath,
						"--headless",
						"--no-sandbox",
						"--disable-dev-shm-usage",
						"--remote-debugging-port=0",
						`--user-data-dir=${directory}`,
						"about:blank",
					],
					{ stdout: "ignore", stderr: "ignore" },
				);
				const activePort = join(directory, "DevToolsActivePort");
				let port = "";
				const deadline = Date.now() + 10000;
				while (!/^\d+$/.test(port) && Date.now() < deadline) {
					if (existsSync(activePort)) port = readFileSync(activePort, "utf8").split("\n")[0] ?? "";
					if (!/^\d+$/.test(port)) await new Promise((resolve) => setTimeout(resolve, 10));
				}
				const target = (await (
					await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
				).json()) as { id: string; webSocketDebuggerUrl: string };
				pool = Bun.serve({
					port: 0,
					fetch(request, server) {
						if (server.upgrade(request, { data: undefined })) return;
						return new Response("upgrade", { status: 400 });
					},
					websocket: {
						message(ws, raw) {
							const command = JSON.parse(String(raw));
							ws.send(
								JSON.stringify({
									jsonrpc: "2.0",
									id: command.id,
									result:
										command.method === "acquire"
											? { pageId: target.id, wsEndpoint: target.webSocketDebuggerUrl }
											: {},
								}),
							);
						},
					},
				});
				cdpUrl = `ws://127.0.0.1:${pool.port}`;
			}
			const registry = createDiagnosticRedactor();
			const collector = new BrowserTelemetryCollector({ redact: registry.redact });
			const client = createBrowserClient({
				cdpUrl,
				stealth: false,
				executablePath: realBrowserExecutablePath,
				telemetry: collector,
			});
			const onSpans: unknown[] = [];
			const trace = createTraceContext({
				redact: registry.redact,
				onSpan: (span) => onSpans.push(span),
			});
			const browser = createBrowserClientDouble({
				newPage: async () => {
					const page = await client.newPage();
					return new Proxy(page, {
						get(target, property) {
							if (property === "waitForSelector")
								return async (...args: Parameters<typeof page.waitForSelector>) => {
									try {
										await target.waitForSelector(...args);
									} catch (error) {
										const state = await target.evaluate<string>("document.body.textContent");
										throw new Error(
											`${state}; ${error instanceof Error ? error.message : String(error)}`,
										);
									}
								};
							const value = Reflect.get(target, property, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					});
				},
			});
			try {
				await withDiagnosticEnv(
					{ finished: false, observe() {}, register: (values) => registry.add(values) },
					async () => {
						const page = await wrapWithInstrumentation(
							createProviderContextDouble({ browser, trace }),
						).browser.newPage();
						await page.goto(`http://127.0.0.1:${origin.port}/`);
						// No cookies() read: the CDP case depends on responseReceivedExtraInfo registration.
						expect(registry.redact("page state sid=abcdef123456")).toBe(
							"page state sid=[REDACTED]",
						);
						await page.waitForSelector("#missing", { timeout: 30 }).catch(() => {});
					},
				);
				const telemetry = new RequestTelemetry(trace);
				telemetry.register(collector);
				const log = telemetry.toLogPayload();
				const encoded = telemetry.toHeaderValue();
				const decoded = JSON.parse(Buffer.from(encoded!, "base64url").toString());
				const exports: string[] = [];
				swapOTLPTransportForTests(
					Object.assign(
						async (_url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
							exports.push(String(options?.body));
							return new Response(null, { status: 200 });
						},
						{ preconnect: fetch.preconnect },
					),
				);
				await exportSpansOTLP(trace.getSpans(), { endpoint: "https://collector.test/v1/traces" });
				expect(exports).toHaveLength(1);
				for (const surface of [log, decoded, trace.getSpans(), onSpans, exports])
					expect(JSON.stringify(surface)).not.toContain("abcdef123456");
				expect(JSON.stringify(log)).toContain("page state sid=[REDACTED]");
				expect(
					decoded.browser.samples.some((sample: { status: string }) => sample.status === "error"),
				).toBe(true);
				console.log(
					`APIFUSE_BROWSER_COOKIE_PROBE: ${engine} valueOnly=page state sid=[REDACTED]; diagnostics/log/header/getSpans/onSpan/OTLP=absent`,
				);
			} finally {
				swapOTLPTransportForTests();
				await client.close();
				pool?.stop(true);
				chrome?.kill();
				if (chrome) await chrome.exited;
				if (directory) rmSync(directory, { recursive: true, force: true });
				origin.stop(true);
			}
		}, 30000);
});
