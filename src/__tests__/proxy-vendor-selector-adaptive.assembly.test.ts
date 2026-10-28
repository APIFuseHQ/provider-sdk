import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { z } from "zod";

import { ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES } from "../engine.js";
import { createHttpClient } from "../runtime/http.js";
import { NODEMAVEN_GATEWAY_HOST } from "../runtime/proxy-nodemaven.js";
import { SMARTPROXY_GATEWAY_HOST, SMARTPROXY_GATEWAY_PORT } from "../runtime/proxy-smartproxy.js";
import {
	ProxyTelemetryCollector,
	type ProxyTelemetryLogPayload,
} from "../runtime/proxy-telemetry.js";
import {
	type AdaptiveProxyVendorSelector,
	createAdaptiveProxyVendorSelector,
	observeProxyVendorSelections,
	PROXY_VENDOR_SELECTION_ENV,
	type ProxyVendorStateTransition,
} from "../runtime/proxy-vendor-selector-adaptive.js";
import {
	getProxyVendorSelector,
	setProxyVendorSelector,
	staticOrderProxyVendorSelector,
} from "../runtime/proxy-vendor-selector.js";
import { type ProviderServerLogEvent, serve } from "../server/serve.js";
import type { ProviderDefinition, ProviderProxyPolicy } from "../types.js";

// Operational assembly of the adaptive vendor fallback on ctx.http (Bun's
// native fetch): the real resolver, the real adaptive selector, the real
// transport retry loop and the real proxy telemetry collector, against two
// local stand-ins for the vendor gateways and a local origin. Nothing leaves the
// machine: the client-level harness points each vendor at its stand-in through
// `gatewayOverrides`; the served harness, which has no such option, reaches them
// through a hosts-file style rewrite of the two gateway hosts on fetch and
// refuses any other proxy host.

type StandInMode = "forward" | "refuse" | "stall";
type StandInHit = { mode: "forward" | "connect"; target: string; username: string };

type GatewayStandIn = {
	readonly port: number;
	readonly hits: StandInHit[];
	mode: StandInMode;
	close(): Promise<void>;
};

function proxyUsername(request: IncomingMessage): string {
	const header = request.headers["proxy-authorization"] ?? "";
	const encoded = header.startsWith("Basic ") ? header.slice("Basic ".length) : "";
	const decoded = Buffer.from(encoded, "base64").toString("utf8");
	const separator = decoded.indexOf(":");
	return separator < 0 ? decoded : decoded.slice(0, separator);
}

/**
 * A vendor gateway stand-in. `refuse` closes the tunnel before any answer (the
 * 2026-10-26 edge failure), `stall` never answers (a slow origin behind the
 * proxy), `forward` relays to the origin.
 */
async function startGatewayStandIn(): Promise<GatewayStandIn> {
	const hits: StandInHit[] = [];
	const sockets = new Set<Duplex>();
	const state: { mode: StandInMode } = { mode: "forward" };
	const forward = (request: IncomingMessage, response: ServerResponse): void => {
		const target = new URL(request.url ?? "");
		hits.push({ mode: "forward", target: target.pathname, username: proxyUsername(request) });
		if (state.mode === "refuse") {
			request.socket.destroy();
			return;
		}
		if (state.mode === "stall") return;
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
				headers: { ...headers, host: target.host },
			},
			(upstreamResponse) => {
				response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
				upstreamResponse.pipe(response);
			},
		);
		upstream.on("error", () => response.destroy());
		request.pipe(upstream);
	};
	const server = createServer(forward);
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("connect", (request: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
		hits.push({ mode: "connect", target: request.url ?? "", username: proxyUsername(request) });
		if (state.mode === "refuse") {
			clientSocket.destroy();
			return;
		}
		if (state.mode === "stall") return;
		const [host, rawPort] = (request.url ?? "").split(":");
		const upstream = connect(Number(rawPort) || 443, host);
		upstream.once("connect", () => {
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) upstream.write(head);
			clientSocket.pipe(upstream).pipe(clientSocket);
		});
		upstream.on("error", () => clientSocket.destroy());
	});
	const port = await new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("gateway stand-in did not bind to a TCP port"));
				return;
			}
			resolve(address.port);
		});
	});
	return {
		port,
		hits,
		get mode() {
			return state.mode;
		},
		set mode(next: StandInMode) {
			state.mode = next;
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

const PROXY_CREDENTIALS = {
	APIFUSE__PROXY__SMARTPROXY_USERNAME: "smart-HUHU123",
	APIFUSE__PROXY__SMARTPROXY_PASSWORD: "s3cret",
	APIFUSE__PROXY__NODEMAVEN_USERNAME: "acct123",
	APIFUSE__PROXY__NODEMAVEN_PASSWORD: "s3cret",
} as const;

const policy: ProviderProxyPolicy = {
	mode: "required",
	providers: ["smartproxy", "nodemaven"],
	geo: { country: "KR" },
};

let origin: ReturnType<typeof Bun.serve>;
let originUrl: string;
let smartproxy: GatewayStandIn;
let nodemaven: GatewayStandIn;

beforeAll(async () => {
	origin = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => Response.json({ path: new URL(request.url).pathname }),
	});
	originUrl = `http://127.0.0.1:${origin.port}`;
	smartproxy = await startGatewayStandIn();
	nodemaven = await startGatewayStandIn();
});

afterAll(async () => {
	await smartproxy.close();
	await nodemaven.close();
	origin.stop(true);
});

afterEach(() => {
	smartproxy.mode = "forward";
	nodemaven.mode = "forward";
	setProxyVendorSelector(undefined);
});

describe("operational assembly: adaptive vendor fallback on ctx.http", () => {
	const transitions: ProxyVendorStateTransition[] = [];
	let selector: AdaptiveProxyVendorSelector;

	beforeAll(() => {
		selector = createAdaptiveProxyVendorSelector({
			consecutiveFailureThreshold: 2,
			baseOpenMs: 200,
			onTransition: (event) => transitions.push(event),
		});
	});

	/** One request on a fresh client: the request's own proxy telemetry and stand-in hits. */
	async function read(path: string, timeout?: number) {
		const collector = new ProxyTelemetryCollector();
		const client = createHttpClient(originUrl, {
			upstream: { proxy: policy },
			engineCredentials: PROXY_CREDENTIALS,
			gatewayOverrides: {
				smartproxy: { host: "127.0.0.1", port: smartproxy.port },
				nodemaven: { host: "127.0.0.1", port: nodemaven.port },
			},
			vendorSelector: selector,
			telemetry: collector,
			warn: () => undefined,
		});
		const smartproxyStart = smartproxy.hits.length;
		const nodemavenStart = nodemaven.hits.length;
		const response = await observeProxyVendorSelections(collector, () =>
			client.get(path, timeout === undefined ? {} : { timeout }),
		);
		return {
			status: response.status,
			data: response.data,
			smartproxy: smartproxy.hits.slice(smartproxyStart),
			nodemaven: nodemaven.hits.slice(nodemavenStart),
			proxy: collector.toLogPayload() as ProxyTelemetryLogPayload | undefined,
		};
	}

	it("moves the next attempt of a request off a vendor whose tunnel closed", async () => {
		smartproxy.mode = "refuse";
		const first = await read("/first");
		expect(first.status).toBe(200);
		expect(first.data).toEqual({ path: "/first" });
		// One refused tunnel on smartproxy, then the same request moves to nodemaven
		// instead of spending the rest of smartproxy's share.
		expect(first.smartproxy).toHaveLength(1);
		expect(first.nodemaven).toHaveLength(1);
		expect(first.nodemaven[0]?.target).toBe("/first");
		expect(first.proxy).toMatchObject({
			kind: "resolved",
			provider: "nodemaven",
			selection: { kind: "adaptive", reason: "retry_alternate" },
			vendorStates: [
				{ v: "smartproxy", s: "closed", e: 0 },
				{ v: "nodemaven", s: "closed", e: 0 },
			],
		});
		expect(selector.snapshot()[0]).toMatchObject({
			vendor: "smartproxy",
			state: "closed",
			consecutiveFailures: 1,
		});
	});

	it("opens the vendor at the threshold and sends later requests straight to the next one", async () => {
		smartproxy.mode = "refuse";
		const second = await read("/second");
		expect(second.status).toBe(200);
		expect(second.smartproxy).toHaveLength(1);
		expect(second.nodemaven).toHaveLength(1);
		expect(transitions.map(({ vendor, from, to, reason }) => [vendor, from, to, reason])).toEqual([
			["smartproxy", "closed", "open", "failure_threshold"],
		]);
		expect(transitions[0]?.errorCode).toBe("transport_network_error");

		const third = await read("/third");
		expect(third.status).toBe(200);
		expect(third.smartproxy).toHaveLength(0);
		expect(third.nodemaven).toHaveLength(1);
		expect(third.proxy).toMatchObject({
			provider: "nodemaven",
			selection: { kind: "adaptive", reason: "vendor_open" },
			vendorStates: [
				{ v: "smartproxy", s: "open", e: 1 },
				{ v: "nodemaven", s: "closed", e: 0 },
			],
		});
	});

	it("probes the vendor once after the open period and returns it to the head of the chain", async () => {
		smartproxy.mode = "forward";
		await Bun.sleep(250);
		const probe = await read("/probe");
		expect(probe.status).toBe(200);
		expect(probe.smartproxy).toHaveLength(1);
		expect(probe.nodemaven).toHaveLength(0);
		expect(probe.proxy).toMatchObject({
			provider: "smartproxy",
			selection: { kind: "adaptive", reason: "half_open_probe" },
		});

		const recovered = await read("/recovered");
		expect(recovered.smartproxy).toHaveLength(1);
		expect(recovered.nodemaven).toHaveLength(0);
		expect(recovered.proxy).toMatchObject({
			provider: "smartproxy",
			selection: { kind: "adaptive", reason: "chain_order" },
			vendorStates: [
				{ v: "smartproxy", s: "closed", e: 1 },
				{ v: "nodemaven", s: "closed", e: 0 },
			],
		});
		expect(transitions.map(({ from, to, reason }) => [from, to, reason])).toEqual([
			["closed", "open", "failure_threshold"],
			["open", "half_open", "open_elapsed"],
			["half_open", "closed", "probe_succeeded"],
		]);
	});

	it("does not hold a stalled origin behind the proxy against the vendor", async () => {
		smartproxy.mode = "stall";
		const before = transitions.length;
		const stalled = await read("/stalled", 150);
		expect(stalled.status).toBe(200);
		// Timeouts are not the vendor's: the request walks its static share on
		// smartproxy, then the fallback, and the vendor stays closed.
		expect(stalled.smartproxy).toHaveLength(3);
		expect(stalled.nodemaven).toHaveLength(1);
		expect(transitions.length).toBe(before);
		expect(selector.snapshot()[0]).toMatchObject({
			vendor: "smartproxy",
			state: "closed",
			consecutiveFailures: 0,
		});
	});
});

describe("operational assembly: a served process at the default values", () => {
	const savedEnv = new Map<string, string | undefined>();
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		setSystemTime();
		globalThis.fetch = originalFetch;
		for (const [name, value] of savedEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		savedEnv.clear();
	});

	function setEnv(name: string, value: string | undefined): void {
		if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	/** Hosts-file style rewrite of the two vendor gateways; any other proxy host is refused. */
	function routeGatewaysToStandIns(): void {
		globalThis.fetch = Object.assign(
			(input: string | URL | Request, init?: RequestInit & { proxy?: string }) => {
				if (init?.proxy === undefined) return originalFetch(input, init);
				const proxy = new URL(init.proxy);
				if (
					proxy.hostname === SMARTPROXY_GATEWAY_HOST &&
					Number(proxy.port) === SMARTPROXY_GATEWAY_PORT
				) {
					proxy.hostname = "127.0.0.1";
					proxy.port = String(smartproxy.port);
				} else if (proxy.hostname === NODEMAVEN_GATEWAY_HOST) {
					proxy.hostname = "127.0.0.1";
					proxy.port = String(nodemaven.port);
				} else {
					throw new Error(`refusing to open a proxy other than the vendor gateways: ${proxy.host}`);
				}
				return originalFetch(input, { ...init, proxy: proxy.toString() } as RequestInit);
			},
			{ preconnect: () => {} },
		) as typeof fetch;
	}

	const ReadInput = z.object({ path: z.string() });

	function provider(): ProviderDefinition {
		return {
			id: "adaptive-fallback-served",
			version: "1.0.0",
			runtime: "standard",
			meta: {
				displayName: "Adaptive Fallback Served",
				descriptionKey: "providers.adaptiveFallbackServed.description",
				category: "test",
			},
			allowedHosts: ["127.0.0.1"],
			http: {},
			proxy: policy,
			operations: {
				read: {
					riskClass: "read",
					input: ReadInput,
					output: ReadInput,
					handler: async (ctx, input) => {
						const { path } = ReadInput.parse(input);
						return ReadInput.parse((await ctx.http.get(`${originUrl}${path}`)).data);
					},
				},
			},
		};
	}

	it("opens a vendor after five refused tunnels, routes around it and takes it back after one probe", async () => {
		for (const [name, value] of Object.entries(PROXY_CREDENTIALS)) setEnv(name, value);
		for (const name of ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES) {
			if (!(name in PROXY_CREDENTIALS)) setEnv(name, undefined);
		}
		setEnv(PROXY_VENDOR_SELECTION_ENV, undefined);
		routeGatewaysToStandIns();
		smartproxy.mode = "refuse";

		const events: ProviderServerLogEvent[] = [];
		const handle = await serve(provider(), {
			port: 0,
			host: "127.0.0.1",
			logger: (event) => events.push(event),
			shutdown: { signals: false },
		});
		const call = async (requestId: string, path: string) => {
			const smartproxyStart = smartproxy.hits.length;
			const nodemavenStart = nodemaven.hits.length;
			const response = await originalFetch(`http://127.0.0.1:${handle.port}/v1/read`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId, input: { path } }),
			});
			const completed = events.find(
				(event) => event.event === "provider_request_completed" && event.requestId === requestId,
			);
			return {
				status: response.status,
				body: await response.json(),
				smartproxy: smartproxy.hits.length - smartproxyStart,
				nodemaven: nodemaven.hits.length - nodemavenStart,
				proxy: completed && "proxy" in completed ? completed.proxy : undefined,
			};
		};
		const stateLines = () => events.filter((event) => event.event === "proxy_vendor_state");

		try {
			expect((getProxyVendorSelector() as AdaptiveProxyVendorSelector).kind).toBe("adaptive");
			for (let index = 1; index <= 5; index += 1) {
				const result = await call(`req_refused_${index}`, `/refused-${index}`);
				expect(result.status).toBe(200);
				expect(result.body).toMatchObject({
					data: { path: `/refused-${index}` },
					meta: { retry: { attempts: 2, lastErrorCode: "transport_network_error" } },
				});
				expect([result.smartproxy, result.nodemaven]).toEqual([1, 1]);
				// The fifth refusal opens smartproxy, so that request's second attempt
				// already finds it open.
				expect(result.proxy).toMatchObject({
					selection: { kind: "adaptive", reason: index < 5 ? "retry_alternate" : "vendor_open" },
				});
			}
			expect(stateLines()).toEqual([
				expect.objectContaining({
					level: "warn",
					event: "proxy_vendor_state",
					providerId: "adaptive-fallback-served",
					vendor: "smartproxy",
					from: "closed",
					to: "open",
					reason: "failure_threshold",
					consecutiveFailures: 5,
					ejections: 1,
					errorCode: "transport_network_error",
				}),
			]);

			const routed = await call("req_routed", "/routed");
			expect([routed.smartproxy, routed.nodemaven]).toEqual([0, 1]);
			expect(routed.proxy).toMatchObject({
				kind: "resolved",
				provider: "nodemaven",
				selection: { kind: "adaptive", reason: "vendor_open" },
				vendorStates: [
					{ v: "smartproxy", s: "open", e: 1 },
					{ v: "nodemaven", s: "closed", e: 0 },
				],
			});

			// The vendor recovered; the open period (30 s by default) elapses.
			smartproxy.mode = "forward";
			setSystemTime(new Date(Date.now() + 31_000));
			const probe = await call("req_probe", "/probe");
			expect([probe.smartproxy, probe.nodemaven]).toEqual([1, 0]);
			expect(probe.proxy).toMatchObject({
				provider: "smartproxy",
				selection: { kind: "adaptive", reason: "half_open_probe" },
			});
			expect(stateLines().map((event) => (event as { reason?: string }).reason)).toEqual([
				"failure_threshold",
				"open_elapsed",
				"probe_succeeded",
			]);

			const back = await call("req_back", "/back");
			expect([back.smartproxy, back.nodemaven]).toEqual([1, 0]);
			expect(back.proxy).toMatchObject({
				provider: "smartproxy",
				selection: { kind: "adaptive", reason: "chain_order" },
			});
		} finally {
			await handle.close();
		}
		expect(getProxyVendorSelector()).toBe(staticOrderProxyVendorSelector);
	});
});
