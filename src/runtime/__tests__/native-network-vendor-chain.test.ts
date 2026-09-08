import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type Server, Socket } from "node:net";

import { assertIsError } from "../../__tests__/test-utils.js";
import { clearProxyResolutionCache, SMARTPROXY_APP_KEY_ENV } from "../../config/loader.js";
import type { NativeNetworkConnection, ProviderProxyPolicy } from "../../types.js";
import {
	createNativeNetworkClient,
	type NativeGatewayProxy,
	type NativeGatewayProxyResolutionInput,
	type NativeGatewayProxySynthesizer,
	type NativeNetworkClientOptions,
	resolveNativeGatewayProxy,
	type VendorCredentialResolver,
} from "../native-network.js";
import { NativeTelemetryCollector } from "../native-telemetry.js";
import { NODEMAVEN_PASSWORD_ENV, NODEMAVEN_USERNAME_ENV } from "../proxy-nodemaven.js";
import { ProxyTelemetryCollector } from "../proxy-telemetry.js";

const originalFetch = globalThis.fetch;
const connections: NativeNetworkConnection[] = [];
const fixtures: Array<{ server: Server; sockets: Set<Socket> }> = [];

function createFetchDouble(
	implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
	return Object.assign(implementation, {
		preconnect(_url: string | URL): void {},
	});
}

afterEach(async () => {
	globalThis.fetch = originalFetch;
	clearProxyResolutionCache();
	for (const connection of connections.splice(0)) await connection.close();
	for (const fixture of fixtures.splice(0).reverse()) {
		for (const socket of fixture.sockets) socket.destroy();
		await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
	}
});

async function listen(server: Server): Promise<{ host: string; port: number }> {
	const sockets = new Set<Socket>();
	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
	fixtures.push({ server, sockets });
	return { host: "127.0.0.1", port: address.port };
}

function injectedCredentials(options: {
	smartproxy?: string;
	nodemaven?: { username: string; password: string };
}): VendorCredentialResolver {
	return (vendor) => {
		if (vendor === "smartproxy") {
			if (!options.smartproxy) {
				return { kind: "absent", missing: [SMARTPROXY_APP_KEY_ENV] };
			}
			const values: Record<string, string> = {
				[SMARTPROXY_APP_KEY_ENV]: options.smartproxy,
			};
			return { kind: "present", values };
		}
		if (vendor === "nodemaven") {
			if (!options.nodemaven) {
				return {
					kind: "absent",
					missing: [NODEMAVEN_USERNAME_ENV, NODEMAVEN_PASSWORD_ENV],
				};
			}
			const values: Record<string, string> = {
				[NODEMAVEN_USERNAME_ENV]: options.nodemaven.username,
				[NODEMAVEN_PASSWORD_ENV]: options.nodemaven.password,
			};
			return { kind: "present", values };
		}
		return { kind: "absent", missing: [] };
	};
}

describe("native vendor chain", () => {
	it("honors declared order and resolves smartproxy before nodemaven", async () => {
		let allocations = 0;
		globalThis.fetch = createFetchDouble(async () => {
			allocations += 1;
			return new Response("127.0.0.1:18080", { status: 200 });
		});
		const resolved = await resolveNativeGatewayProxy({
			policy: {
				mode: "required",
				providers: ["smartproxy", "nodemaven"],
				session: { affinity: "connection", poolSize: 1 },
			},
			affinityKey: "account-a",
			credentials: injectedCredentials({
				smartproxy: "smart-key",
				nodemaven: { username: "node-user", password: "node-pass" },
			}),
		});

		expect(resolved).toMatchObject({
			vendor: "smartproxy",
			url: "http://127.0.0.1:18080",
			sticky: true,
		});
		expect(allocations).toBe(1);
	});

	it("falls through an allocation failure to nodemaven", async () => {
		globalThis.fetch = createFetchDouble(async () => new Response("unavailable", { status: 503 }));
		const resolved = await resolveNativeGatewayProxy({
			policy: {
				mode: "required",
				providers: ["smartproxy", "nodemaven"],
				session: { affinity: "connection", lifetimeMinutes: 60 },
			},
			affinityKey: "account-a",
			credentials: injectedCredentials({
				smartproxy: "smart-key",
				nodemaven: { username: "node-user", password: "node-pass" },
			}),
		});

		expect(resolved?.vendor).toBe("nodemaven");
		expect(resolved?.url).toMatch(/^http:\/\//);
	});

	it("reports every exhausted vendor reason and redacts allocation credentials", async () => {
		const appKey = `smart-key-${randomUUID()}`;
		globalThis.fetch = createFetchDouble(async () => {
			throw new Error(`allocator rejected ${appKey}`);
		});
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
			credentials: injectedCredentials({ smartproxy: appKey }),
		});

		let thrown: unknown;
		try {
			await client.connectTcp({ host: "127.0.0.1", port: 9, timeoutMs: 1_000 });
		} catch (error) {
			thrown = error;
		}
		assertIsError(thrown);
		const message = thrown.message;
		expect(thrown).toMatchObject({ code: "PROXY_REQUIRED" });
		expect(message).toContain("smartproxy: allocation failed");
		expect(message).toContain(
			`nodemaven: credentials absent (missing ${NODEMAVEN_USERNAME_ENV}, ${NODEMAVEN_PASSWORD_ENV})`,
		);
		expect(JSON.stringify(thrown)).not.toContain(appKey);
		expect(message).not.toContain(appKey);
	});

	it("reports unsupported protocol per vendor without invoking adapters", async () => {
		let called = 0;
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
			// test-invalid: runtime proxy validation must reject an unsupported protocol.
			proxyProtocol: "https" as never,
			gatewaySynthesizers: [
				() => {
					called += 1;
					return undefined;
				},
			],
		});

		await expect(
			client.connectTcp({ host: "127.0.0.1", port: 9, timeoutMs: 100 }),
		).rejects.toMatchObject({
			code: "PROXY_REQUIRED",
			message:
				"Native proxy egress is required but the vendor chain was exhausted: smartproxy: protocol https is unsupported; nodemaven: protocol https is unsupported.",
		});
		expect(called).toBe(0);
	});

	it("includes async adapter resolution in establishment timeout and cancellation", async () => {
		const synthesizer = () => new Promise<undefined>(() => undefined);
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [synthesizer],
		});
		await expect(
			client.connectTcp({ host: "127.0.0.1", port: 9, timeoutMs: 30 }),
		).rejects.toMatchObject({ code: "native_connection_timeout" });

		const controller = new AbortController();
		const attempt = client.connectTcp({
			host: "127.0.0.1",
			port: 9,
			timeoutMs: 5_000,
			signal: controller.signal,
		});
		controller.abort();
		await expect(attempt).rejects.toMatchObject({ code: "native_connection_aborted" });
	});

	it("separates Smartproxy allocation caches by injected credential", async () => {
		let allocations = 0;
		globalThis.fetch = createFetchDouble(async () => {
			allocations += 1;
			return new Response(`127.0.0.${allocations}:8080`, { status: 200 });
		});
		const policy: ProviderProxyPolicy = {
			mode: "required",
			providers: ["smartproxy"],
			session: { affinity: "connection", poolSize: 1 },
		};
		const first = await resolveNativeGatewayProxy({
			policy,
			affinityKey: "same-account",
			credentials: injectedCredentials({ smartproxy: "tenant-a-key" }),
		});
		const second = await resolveNativeGatewayProxy({
			policy,
			affinityKey: "same-account",
			credentials: injectedCredentials({ smartproxy: "tenant-b-key" }),
		});

		expect(first?.url).toBe("http://127.0.0.1:8080");
		expect(second?.url).toBe("http://127.0.0.2:8080");
		expect(allocations).toBe(2);
	});
});

type RecorderContext = {
	readonly telemetry?: ProxyTelemetryCollector;
	readonly nativeTelemetry?: NativeTelemetryCollector;
	readonly operations: string[];
};

type DifferentialScenario = {
	readonly name: string;
	run(context: RecorderContext): Promise<unknown>;
};

function normalizedProxy(proxy: NativeGatewayProxy | undefined): unknown {
	if (!proxy) return undefined;
	const url = new URL(proxy.url);
	return {
		vendor: proxy.vendor,
		protocol: url.protocol,
		host: url.hostname,
		port: url.port,
		sticky: proxy.sticky,
	};
}

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
	try {
		return { kind: "ok", value: await run() };
	} catch (error) {
		const normalized = error instanceof Error ? error : new Error(String(error));
		const code = Reflect.get(normalized, "code");
		return {
			kind: "error",
			name: normalized.name,
			message: normalized.message,
			...(typeof code === "string" ? { code } : {}),
		};
	}
}

function observedCredentials(
	operations: string[],
	credentials: VendorCredentialResolver,
): VendorCredentialResolver {
	return (vendor) => {
		operations.push(`credentials:${vendor}`);
		return credentials(vendor);
	};
}

function fixedGateway(
	operations: string[],
	vendor: NonNullable<ProviderProxyPolicy["provider"]>,
	url = "http://proxy-user:proxy-password@127.0.0.1:18080",
): NativeGatewayProxySynthesizer {
	return (input) => {
		operations.push(`synthesize:${input.vendor}:${input.protocol}`);
		if (input.vendor !== vendor) return undefined;
		return { vendor, url, sticky: false };
	};
}

async function resolveScenario(
	context: RecorderContext,
	input: NativeGatewayProxyResolutionInput,
): Promise<unknown> {
	return await outcome(async () =>
		normalizedProxy(
			await resolveNativeGatewayProxy({
				...input,
				telemetry: context.telemetry,
				nativeTelemetry: context.nativeTelemetry,
			}),
		),
	);
}

async function connectFailureScenario(
	context: RecorderContext,
	options: Omit<NativeNetworkClientOptions, "telemetry" | "nativeTelemetry">,
	input: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown> {
	const client = createNativeNetworkClient({
		...options,
		telemetry: context.telemetry,
		nativeTelemetry: context.nativeTelemetry,
	});
	return await outcome(async () => {
		const connection = await client.connectTcp({
			host: "127.0.0.1",
			port: 9,
			timeoutMs: input.timeoutMs ?? 250,
			signal: input.signal,
		});
		connections.push(connection);
		return "connected";
	});
}

async function recordAllocatorRequest(
	operations: string[],
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
): Promise<void> {
	const request = new Request(input, init);
	operations.push(
		`fetch:${request.method}:${request.url}:${JSON.stringify([...request.headers].sort())}`,
	);
}

async function runHttpTunnelScenario(
	context: RecorderContext,
	vendor: ProviderProxyPolicy["provider"] = "nodemaven",
): Promise<unknown> {
	if (!vendor) throw new Error("Missing scenario vendor");
	const destinationBytes: string[] = [];
	const destination = await listen(
		createServer((socket) => {
			socket.on("data", (chunk: Buffer) => {
				destinationBytes.push(chunk.toString("hex"));
				socket.write(chunk);
			});
		}),
	);
	const connectRequests: string[] = [];
	const proxy = await listen(
		createServer((client) => {
			let buffered = Buffer.alloc(0);
			client.on("data", function onData(chunk: Buffer) {
				buffered = Buffer.concat([buffered, chunk]);
				const end = buffered.indexOf("\r\n\r\n");
				if (end < 0) return;
				client.off("data", onData);
				connectRequests.push(
					buffered
						.subarray(0, end)
						.toString("latin1")
						.replaceAll(`${destination.host}:${destination.port}`, "<destination>"),
				);
				const upstream = new Socket();
				upstream.once("error", () => client.destroy());
				upstream.connect(destination.port, destination.host, () => {
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					const remaining = buffered.subarray(end + 4);
					if (remaining.length > 0) upstream.write(remaining);
					client.pipe(upstream);
					upstream.pipe(client);
				});
			});
		}),
	);
	const synthesizer = fixedGateway(
		context.operations,
		vendor,
		`http://proxy-user:proxy-password@${proxy.host}:${proxy.port}`,
	);
	const client = createNativeNetworkClient({
		proxyPolicy: { mode: "required", providers: [vendor] },
		proxyProtocol: "socks5", // The override returns HTTP; telemetry must describe the actual tunnel.
		gatewaySynthesizers: [synthesizer],
		telemetry: context.telemetry,
		nativeTelemetry: context.nativeTelemetry,
	});
	return await outcome(async () => {
		const connection = await client.connectTcp({
			host: destination.host,
			port: destination.port,
			timeoutMs: 1_000,
		});
		connections.push(connection);
		const payload = new TextEncoder().encode("native-recorder-parity");
		await connection.write(payload);
		const echoed = await connection.read();
		await connection.close();
		if (context.nativeTelemetry) {
			expect(context.nativeTelemetry.toLogPayload()).toMatchObject({
				bytesIn: payload.byteLength,
				bytesOut: payload.byteLength,
				attemptSamples: [{ vendor }],
			});
		}
		if (context.telemetry && vendor === "nodemaven")
			expect(context.telemetry.toLogPayload()).toMatchObject({ protocol: "http" });
		return {
			echoed: echoed ? new TextDecoder().decode(echoed) : null,
			connectRequests,
			destinationBytes,
			operations: context.operations,
		};
	});
}

const DIFFERENTIAL_SCENARIOS: readonly DifferentialScenario[] = [
	{
		name: "disabled policy",
		run: (context) =>
			resolveScenario(context, {
				policy: { mode: "disabled" },
				gatewaySynthesizers: [fixedGateway(context.operations, "nodemaven")],
			}),
	},
	{
		name: "first adapter success",
		run: (context) =>
			resolveScenario(context, {
				policy: { mode: "required", providers: ["smartproxy"] },
				now: 1_700_000_000_000,
				gatewaySynthesizers: [fixedGateway(context.operations, "smartproxy")],
			}),
	},
	{
		name: "adapter fallthrough within one vendor",
		run: (context) =>
			resolveScenario(context, {
				policy: { mode: "required", providers: ["nodemaven"] },
				now: 1_700_000_000_000,
				gatewaySynthesizers: [
					(input) => {
						context.operations.push(`decline:${input.vendor}:${input.protocol}`);
						return undefined;
					},
					fixedGateway(context.operations, "nodemaven"),
				],
			}),
	},
	{
		name: "explicit credential skip then vendor success",
		run: (context) =>
			resolveScenario(context, {
				policy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
				now: 1_700_000_000_000,
				gatewaySynthesizers: [
					(input) => {
						context.operations.push(`synthesize:${input.vendor}:${input.protocol}`);
						if (input.vendor === "smartproxy") {
							return { kind: "skipped", reason: { kind: "credentials_absent", missing: ["KEY"] } };
						}
						return { vendor: "nodemaven", url: "http://127.0.0.1:18080", sticky: false };
					},
				],
			}),
	},
	{
		name: "allocation skip then vendor success",
		run: (context) =>
			resolveScenario(context, {
				policy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
				now: 1_700_000_000_000,
				gatewaySynthesizers: [
					(input) => {
						context.operations.push(`synthesize:${input.vendor}:${input.protocol}`);
						if (input.vendor === "smartproxy") {
							return {
								kind: "skipped",
								reason: { kind: "allocation_failed", cause: new Error("offline") },
							};
						}
						return { vendor: "nodemaven", url: "http://127.0.0.1:18080", sticky: false };
					},
				],
			}),
	},
	{
		name: "Smartproxy allocator success",
		async run(context) {
			globalThis.fetch = createFetchDouble(async (input, init) => {
				await recordAllocatorRequest(context.operations, input, init);
				return new Response("127.0.0.1:18080", { status: 200 });
			});
			return await resolveScenario(context, {
				policy: { mode: "required", providers: ["smartproxy"] },
				affinityKey: "recorder-parity",
				now: 1_700_000_000_000,
				credentials: observedCredentials(
					context.operations,
					injectedCredentials({ smartproxy: "recorder-parity-key" }),
				),
			});
		},
	},
	{
		name: "Smartproxy allocator failure falls through to NodeMaven",
		async run(context) {
			globalThis.fetch = createFetchDouble(async (input, init) => {
				await recordAllocatorRequest(context.operations, input, init);
				return new Response("unavailable", { status: 503 });
			});
			return await resolveScenario(context, {
				policy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					session: { affinity: "connection", poolSize: 1 },
				},
				affinityKey: "recorder-parity",
				now: 1_700_000_000_000,
				credentials: observedCredentials(
					context.operations,
					injectedCredentials({
						smartproxy: "recorder-parity-key",
						nodemaven: { username: "node-user", password: "node-password" },
					}),
				),
			});
		},
	},
	{
		name: "optional exhausted chain",
		run: (context) =>
			resolveScenario(context, {
				policy: { mode: "optional", providers: ["smartproxy", "nodemaven"] },
				now: 1_700_000_000_000,
				gatewaySynthesizers: [
					(input) => {
						context.operations.push(`synthesize:${input.vendor}:${input.protocol}`);
						return undefined;
					},
				],
			}),
	},
	{
		name: "required credentials absent",
		run: (context) =>
			connectFailureScenario(context, {
				proxyPolicy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
				credentials: observedCredentials(context.operations, injectedCredentials({})),
			}),
	},
	{
		name: "egress preflight rejects before proxy resolution",
		run: (context) =>
			connectFailureScenario(context, {
				proxyPolicy: { mode: "required", providers: ["nodemaven"] },
				egress: {},
				gatewaySynthesizers: [fixedGateway(context.operations, "nodemaven")],
			}),
	},
	{
		name: "required unsupported protocol",
		run: (context) =>
			connectFailureScenario(context, {
				proxyPolicy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
				// test-invalid: differential coverage for runtime rejection of an unsupported protocol.
				proxyProtocol: "https" as never,
				gatewaySynthesizers: [fixedGateway(context.operations, "smartproxy")],
			}),
	},
	{
		name: "required adapter unavailable",
		run: (context) =>
			connectFailureScenario(context, {
				proxyPolicy: { mode: "required", providers: ["nodemaven"] },
				gatewaySynthesizers: [
					(input) => {
						context.operations.push(`synthesize:${input.vendor}:${input.protocol}`);
						return undefined;
					},
				],
			}),
	},
	{
		name: "credential resolver throws",
		run: (context) =>
			connectFailureScenario(context, {
				proxyPolicy: { mode: "required", providers: ["nodemaven"] },
				credentials: observedCredentials(context.operations, () => {
					throw new Error("credential backend offline");
				}),
			}),
	},
	{
		name: "custom synthesizer throws",
		run: (context) =>
			connectFailureScenario(context, {
				proxyPolicy: { mode: "required", providers: ["nodemaven"] },
				gatewaySynthesizers: [
					(input) => {
						context.operations.push(`synthesize:${input.vendor}:${input.protocol}`);
						throw new Error("adapter offline");
					},
				],
			}),
	},
	{
		name: "custom synthesizer returns invalid proxy URL",
		run: (context) =>
			connectFailureScenario(context, {
				proxyPolicy: { mode: "required", providers: ["nodemaven"] },
				gatewaySynthesizers: [
					fixedGateway(context.operations, "nodemaven", "https://127.0.0.1:18080"),
				],
			}),
	},
	{
		name: "pending adapter times out",
		run: (context) =>
			connectFailureScenario(
				context,
				{
					proxyPolicy: { mode: "required", providers: ["nodemaven"] },
					gatewaySynthesizers: [
						(input) => {
							context.operations.push(`synthesize:${input.vendor}:${input.protocol}`);
							return new Promise<undefined>(() => undefined);
						},
					],
				},
				{ timeoutMs: 25 },
			),
	},
	{
		name: "pending adapter is aborted",
		async run(context) {
			const controller = new AbortController();
			const result = connectFailureScenario(
				context,
				{
					proxyPolicy: { mode: "required", providers: ["nodemaven"] },
					gatewaySynthesizers: [
						(input) => {
							context.operations.push(`synthesize:${input.vendor}:${input.protocol}`);
							return new Promise<undefined>(() => undefined);
						},
					],
				},
				{ signal: controller.signal, timeoutMs: 5_000 },
			);
			controller.abort();
			return await result;
		},
	},
	{
		name: "HTTP CONNECT request and tunneled bytes",
		run: runHttpTunnelScenario,
	},
];

describe("native recorder behavior differential", () => {
	it("records fallback success after an earlier adapter reported failure for the same vendor", async () => {
		const telemetry = new ProxyTelemetryCollector();
		const proxy = await resolveNativeGatewayProxy({
			policy: { mode: "required", providers: ["nodemaven"] },
			telemetry,
			gatewaySynthesizers: [
				(input) => {
					input.telemetry?.recordProxyResolution({
						provider: "nodemaven",
						outcome: "error",
						cacheStatus: "disabled",
						cacheHit: false,
						resolutionMs: 1,
						attempts: 1,
					});
					return {
						kind: "skipped",
						reason: { kind: "allocation_failed", cause: new Error("first adapter failed") },
					};
				},
				() => ({ vendor: "nodemaven", url: "http://127.0.0.1:8080", sticky: false }),
			],
		});
		expect(proxy?.vendor).toBe("nodemaven");
		expect(telemetry.toLogPayload()).toMatchObject({
			kind: "resolved",
			provider: "nodemaven",
			protocol: "http",
			attempts: 2,
		});
	});

	it.each([
		"custom",
		"decodo",
	] as const)("retains the selected %s override vendor on the actual connection", async (vendor) => {
		const nativeTelemetry = new NativeTelemetryCollector();
		await runHttpTunnelScenario({ operations: [], nativeTelemetry }, vendor);
		expect(nativeTelemetry.toLogPayload()?.attemptSamples?.[0]?.vendor).toBe(vendor);
	});

	it("preserves requests, bytes, ordering, results, and errors across all scenarios", async () => {
		expect(DIFFERENTIAL_SCENARIOS.length).toBeGreaterThanOrEqual(10);
		for (const scenario of DIFFERENTIAL_SCENARIOS) {
			globalThis.fetch = originalFetch;
			clearProxyResolutionCache();
			const withoutOperations: string[] = [];
			const without = await scenario.run({ operations: withoutOperations });

			globalThis.fetch = originalFetch;
			clearProxyResolutionCache();
			const withOperations: string[] = [];
			const withRecorders = await scenario.run({
				operations: withOperations,
				telemetry: new ProxyTelemetryCollector(),
				nativeTelemetry: new NativeTelemetryCollector(),
			});

			expect(
				{ outcome: withRecorders, operations: withOperations },
				`recorder changed native behavior for scenario: ${scenario.name}`,
			).toEqual({ outcome: without, operations: withoutOperations });
		}
	});

	it("threads the existing proxy sink through native Smartproxy resolution", async () => {
		globalThis.fetch = createFetchDouble(
			async () => new Response("127.0.0.1:18080", { status: 200 }),
		);
		const telemetry = new ProxyTelemetryCollector();
		const nativeTelemetry = new NativeTelemetryCollector();
		const resolved = await resolveNativeGatewayProxy({
			policy: { mode: "required", providers: ["smartproxy"] },
			affinityKey: "native-proxy-sink",
			credentials: injectedCredentials({ smartproxy: "native-proxy-sink-key" }),
			telemetry,
			nativeTelemetry,
		});

		expect(resolved?.vendor).toBe("smartproxy");
		expect(telemetry.toLogPayload()).toMatchObject({
			kind: "resolved",
			provider: "smartproxy",
			protocol: "http",
			cacheStatus: "allocator",
			cacheHit: false,
			attempts: 1,
		});
		expect(nativeTelemetry.toLogPayload()).toBeUndefined();
	});

	it("records every vendor skip once and keeps the closed reason", async () => {
		const nativeTelemetry = new NativeTelemetryCollector();
		await resolveNativeGatewayProxy({
			policy: { mode: "optional", providers: ["smartproxy", "nodemaven"] },
			gatewaySynthesizers: [() => undefined],
			nativeTelemetry,
		});

		expect(nativeTelemetry.toLogPayload()).toMatchObject({
			vendorSkips: 2,
			vendorSkipReasons: [{ reason: "adapter_unavailable", count: 2 }],
			vendorSkipSamples: [
				{ vendor: "smartproxy", reason: "adapter_unavailable" },
				{ vendor: "nodemaven", reason: "adapter_unavailable" },
			],
		});
	});

	it("records three connects as three samples and a rethrown failure once", async () => {
		const fixture = await listen(createServer((socket) => socket.end()));
		const nativeTelemetry = new NativeTelemetryCollector();
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "disabled" },
			nativeTelemetry,
		});
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const connection = await client.connectTcp({
				host: fixture.host,
				port: fixture.port,
				timeoutMs: 1_000,
			});
			connections.push(connection);
		}
		expect(nativeTelemetry.toLogPayload()).toMatchObject({
			attempts: 3,
			attemptSamples: [
				{ n: 1, kind: "tcp", outcome: "ok", proxyUsed: false },
				{ n: 2, kind: "tcp", outcome: "ok", proxyUsed: false },
				{ n: 3, kind: "tcp", outcome: "ok", proxyUsed: false },
			],
		});

		const failureTelemetry = new NativeTelemetryCollector();
		const failing = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [
				() => {
					throw new Error("adapter failed once");
				},
			],
			nativeTelemetry: failureTelemetry,
		});
		await expect(
			failing.connectTcp({ host: "127.0.0.1", port: 9, timeoutMs: 250 }),
		).rejects.toMatchObject({ code: "PROXY_REQUIRED" });
		expect(failureTelemetry.toLogPayload()).toMatchObject({
			attempts: 1,
			lastErrorCode: "PROXY_REQUIRED",
			attemptSamples: [{ n: 1, kind: "tcp", outcome: "error", errorCode: "PROXY_REQUIRED" }],
		});
	});
});
