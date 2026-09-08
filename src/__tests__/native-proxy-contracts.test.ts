import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import { clearProxyResolutionCache, SMARTPROXY_APP_KEY_ENV } from "../config/loader.js";
import { TransportError } from "../errors.js";
import type {
	NativeNetworkConnection,
	NativeProxyEgressInfo,
	NativeProxyExpiringEvent,
	NativeTlsConnectOptions,
	ProviderContext,
	ProviderDefinition,
} from "../index.js";
import {
	createEnvVendorCredentialResolver,
	type NativeGatewayProxySynthesizer,
	NativeNetworkError,
	type VendorCredentialLookup,
} from "../runtime/native-network.js";
import type { NativeNetworkErrorCode } from "../runtime/native-network-errors.js";
import {
	NativeTelemetryCollector,
	type NativeTelemetryLogPayload,
} from "../runtime/native-telemetry.js";
import { PROVIDER_TELEMETRY_HEADER } from "../runtime/request-telemetry.js";
import {
	createServerApp,
	createServerAppAsync,
	ERROR_OBSERVABILITY_HEADER,
	type ProviderServerLogEvent,
} from "../server/serve.js";
import { statefulSignedHeaders } from "../stateful-signing.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

const originalFetch = globalThis.fetch;
const originalSmartproxyKey = process.env[SMARTPROXY_APP_KEY_ENV];

function fetchDouble(
	run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return Object.assign(run, { preconnect() {} });
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearProxyResolutionCache();
	if (originalSmartproxyKey === undefined) delete process.env[SMARTPROXY_APP_KEY_ENV];
	else process.env[SMARTPROXY_APP_KEY_ENV] = originalSmartproxyKey;
});

function decodeTelemetry(response: Response): Record<string, unknown> {
	const value = response.headers.get(PROVIDER_TELEMETRY_HEADER);
	expect(value).toBeTruthy();
	return JSON.parse(Buffer.from(value ?? "", "base64url").toString("utf8"));
}

function errorCategory(response: Response): string | undefined {
	const value = response.headers.get(ERROR_OBSERVABILITY_HEADER);
	expect(value).toBeTruthy();
	return JSON.parse(value ?? "{}").category;
}

function eventPayload(event: ProviderServerLogEvent | undefined, key: "proxy" | "native"): unknown {
	return event && Object.hasOwn(event, key) ? Reflect.get(event, key) : undefined;
}

type ConnectProxyFixture = {
	server: Server;
	sockets: Set<Socket>;
	port: number;
	connects: () => number;
	failNext: () => void;
};

async function createConnectProxy(): Promise<ConnectProxyFixture> {
	const sockets = new Set<Socket>();
	let connects = 0;
	let failNext = false;
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let established = false;
		socket.on("data", (chunk) => {
			if (!established) {
				expect(chunk.toString("latin1")).toStartWith("CONNECT ");
				connects++;
				established = true;
				if (failNext) {
					failNext = false;
					socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
					return;
				}
				socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				return;
			}
			socket.write(chunk);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("CONNECT proxy did not bind");
	return {
		server,
		sockets,
		port: address.port,
		connects: () => connects,
		failNext: () => {
			failNext = true;
		},
	};
}

async function closeConnectProxy(fixture: ConnectProxyFixture): Promise<void> {
	for (const socket of fixture.sockets) socket.destroy();
	await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
}

describe("native proxy contracts", () => {
	it("exposes proxy egress metadata on a connection", () => {
		const info: NativeProxyEgressInfo = {
			vendor: "smartproxy",
			sticky: true,
			sessionId: "abc1234567",
			expiresAt: "2026-07-31T00:00:00.000Z",
		};
		expect(info.sticky).toBe(true);
	});

	it("types the expiring event with a drain acknowledgement", () => {
		const event: NativeProxyExpiringEvent = {
			expiresAt: "2026-07-31T00:00:00.000Z",
			leadSeconds: 60,
			reason: "sticky_expiry",
		};
		expect(event.reason).toBe("sticky_expiry");
	});

	it("keeps connect options structurally compatible", () => {
		const options: NativeTlsConnectOptions = { host: "h", port: 443 };
		expect(options.port).toBe(443);
	});

	it("keeps connections structurally compatible", () => {
		const connection: NativeNetworkConnection = {
			read: async () => null,
			write: async () => undefined,
			close: async () => undefined,
		};
		expect(connection.proxy).toBeUndefined();
	});

	it("exports injected credential and async synthesizer contracts from the runtime subpath", async () => {
		const credentials = createEnvVendorCredentialResolver({
			get: (name) => (name.endsWith("USERNAME") ? "injected-user" : undefined),
		});
		const lookup: VendorCredentialLookup = credentials("nodemaven");
		const synthesizer: NativeGatewayProxySynthesizer = async (input) => {
			expect(input.credentials).toBe(credentials);
			expect(input.protocol).toBe("http");
			return undefined;
		};

		expect(lookup).toEqual({
			kind: "absent",
			missing: ["APIFUSE__PROXY__NODEMAVEN_PASSWORD"],
		});
		await expect(
			synthesizer({
				vendor: "nodemaven",
				policy: { mode: "required", providers: ["nodemaven"] },
				now: 0,
				protocol: "http",
				credentials,
			}),
		).resolves.toBeUndefined();
	});
});

const serverPaths = [
	"/v1/probe",
	"/auth/start",
	"/auth/continue",
	"/auth/poll",
	"/auth/disconnect",
	"/auth/refresh",
	"/__apifuse/stateful/operations",
] as const;

async function connectAndClose(ctx: Pick<ProviderContext, "native">, port: number): Promise<void> {
	const connection = await ctx.native.network.connectTcp({
		host: "127.0.0.1",
		port,
		timeoutMs: 2_000,
	});
	await connection.close();
}

function createNativeServerProvider(port: number): ProviderDefinition {
	const authProbe = async (ctx: { native?: ProviderContext["native"] }) => {
		if (!ctx.native) throw new Error("native context missing");
		await connectAndClose({ native: ctx.native }, port);
		return { kind: "complete", turnId: "native-complete" } as const;
	};
	return createProviderDefinitionDouble({
		id: "native-server-paths",
		http: {},
		stealth: { browser: "chrome", os: "macos" },
		native: {
			network: { tcp: [{ host: "127.0.0.1", ports: [port], tls: "disabled" }] },
		},
		proxy: { mode: "required", providers: ["smartproxy"] },
		auth: {
			mode: "credentials",
			flow: {
				start: authProbe,
				continue: authProbe,
				poll: authProbe,
				abort: authProbe,
				refresh: authProbe,
			},
		},
		operations: {
			probe: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				upstream: { baseUrl: "http://127.0.0.1" },
				handler: async (ctx) => {
					await connectAndClose(ctx, port);
					return { ok: true };
				},
			},
		},
	});
}

function nativeRequest(
	provider: ProviderDefinition,
	path: (typeof serverPaths)[number],
	requestId: string,
): { body: string; headers: Record<string, string> } {
	const timestamp = new Date().toISOString();
	const operationRequest = {
		requestId,
		...(path.startsWith("/auth/") ? { flowId: "native-flow" } : {}),
		input: {},
	};
	const stateful = path === "/__apifuse/stateful/operations";
	const body = JSON.stringify(
		stateful
			? {
					requestId,
					providerId: provider.id,
					operationId: "probe",
					sessionKey: "native-server-paths:account:connection",
					connectionId: "connection-1",
					serviceAccountId: "account-1",
					ownerPodId: "pod-owner",
					generation: 7,
					sourcePodId: "pod-source",
					forwardedAt: timestamp,
					operationRequest,
				}
			: operationRequest,
	);
	return {
		body,
		headers: {
			"content-type": "application/json",
			...(stateful
				? {
						"x-apifuse-stateful-source-pod": "pod-source",
						...statefulSignedHeaders({
							secret: "native-probe-secret",
							timestamp,
							rawBody: body,
							method: "POST",
							path,
						}),
					}
				: {}),
		},
	};
}

describe("native server telemetry construction paths", () => {
	for (const [factory, create] of [
		["sync", createServerApp],
		["async", createServerAppAsync],
	] as const) {
		it(`${factory} threads fresh proxy and native sinks through operation, auth, and signed stateful routes`, async () => {
			const proxy = await createConnectProxy();
			process.env[SMARTPROXY_APP_KEY_ENV] = "native-server-smartproxy-key";
			globalThis.fetch = fetchDouble(
				async () => new Response(`127.0.0.1:${proxy.port}`, { status: 200 }),
			);
			clearProxyResolutionCache();
			const provider = createNativeServerProvider(proxy.port);
			const events: ProviderServerLogEvent[] = [];
			try {
				const app = await create(provider, {
					logger: (event) => events.push(event),
					statefulForwarding: {
						secret: "native-probe-secret",
						validateOwnerFence: async () => true,
					},
					internalOperationExecutor: async ({ ctx }) => {
						await connectAndClose(ctx, proxy.port);
						return { ok: true };
					},
				});
				for (const [turn, path] of serverPaths.entries()) {
					for (const outcome of ["ok", "error"] as const) {
						if (outcome === "error") proxy.failNext();
						const requestId = `${factory}-native-${turn}-${outcome}`;
						const request = nativeRequest(provider, path, requestId);
						const response = await app.request(path, {
							method: "POST",
							headers: request.headers,
							body: request.body,
						});
						expect(response.status).toBe(outcome === "ok" ? 200 : 502);
						const terminalEvent =
							outcome === "ok" ? "provider_request_completed" : "provider_request_failed";
						const terminal = events.find(
							(event) => event.event === terminalEvent && event.requestId === requestId,
						);
						const native = eventPayload(terminal, "native") as NativeTelemetryLogPayload;
						const proxyLog = eventPayload(terminal, "proxy");
						expect(native).toMatchObject({
							attempts: 1,
							vendorSkips: 0,
							bytesIn: 0,
							bytesOut: 0,
							attemptSamples: [{ n: 1, kind: "tcp", outcome, proxyUsed: true }],
						});
						expect(proxyLog).toMatchObject({ provider: "smartproxy", kind: "resolved" });
						const decoded = decodeTelemetry(response);
						expect(decoded.v).toBe(1);
						expect(typeof decoded.taxonomy).toBe("string");
						expect(decoded.proxy).toEqual(proxyLog);
						expect(decoded.native).toEqual(new NativeTelemetryCollector().toHeaderPayload(native));
						expect((decoded.native as Record<string, unknown>).attemptSamples).toHaveLength(1);
					}
				}
				expect(proxy.connects()).toBe(serverPaths.length * 2);
			} finally {
				await closeConnectProxy(proxy);
			}
		});

		it(`${factory} omits native and proxy siblings when the declared transport is unused`, async () => {
			const events: ProviderServerLogEvent[] = [];
			const provider = createProviderDefinitionDouble({
				id: "native-unused",
				native: {},
				operations: {
					unused: {
						riskClass: "read",
						input: z.object({}),
						output: z.object({ ok: z.boolean() }),
						handler: async () => ({ ok: true }),
					},
				},
			});
			const app = await create(provider, { logger: (event) => events.push(event) });
			const response = await app.request("/v1/unused", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: `${factory}-unused`, input: {} }),
			});
			expect(response.status).toBe(200);
			expect(response.headers.get(PROVIDER_TELEMETRY_HEADER)).toBeNull();
			const completed = events.find((event) => event.event === "provider_request_completed");
			expect(eventPayload(completed, "native")).toBeUndefined();
			expect(eventPayload(completed, "proxy")).toBeUndefined();
		});
	}

	it("redacts request dictionary values from native vendor failures and keeps diagnostics out of the header", async () => {
		const sentinel = "orchidpetals";
		process.env[SMARTPROXY_APP_KEY_ENV] = "native-failure-smartproxy-key";
		globalThis.fetch = fetchDouble(async () => {
			throw new Error(`allocator rejected ${sentinel}`);
		});
		clearProxyResolutionCache();
		const provider = createNativeServerProvider(9);
		const events: ProviderServerLogEvent[] = [];
		const app = createServerApp(provider, { logger: (event) => events.push(event) });
		const response = await app.request("/v1/probe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "native-redaction",
				input: {},
				connection: {
					id: "native-redaction-connection",
					mode: "credentials",
					secrets: { password: sentinel },
					metadata: {},
					externalRef: "native-redaction-ref",
				},
			}),
		});
		expect(response.status).toBe(500);
		const failed = events.find((event) => event.event === "provider_request_failed");
		expect(eventPayload(failed, "proxy")).toBeDefined();
		expect(eventPayload(failed, "native")).toBeDefined();
		const decoded = decodeTelemetry(response);
		expect(decoded.proxy).toBeDefined();
		expect(decoded.native).toBeDefined();
		expect(JSON.stringify(failed)).not.toContain(sentinel);
		expect(JSON.stringify(decoded)).not.toContain(sentinel);
		expect(JSON.stringify(decoded.native)).not.toContain("diagnostics");
		expect(errorCategory(response)).toBe("proxy_pool");
	});
});

describe("native server error classification", () => {
	it("ignores hostile code and cause descriptors while inspecting a transport cause chain", async () => {
		const hostileCause = new Proxy(new Error("hostile cause"), {
			getOwnPropertyDescriptor(target, property) {
				if (property === "code" || property === "cause") throw new Error("descriptor trap");
				return Reflect.getOwnPropertyDescriptor(target, property);
			},
		});
		const provider = createProviderDefinitionDouble({
			id: "hostile-cause-classification",
			operations: {
				probe: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					handler: async () => {
						throw new TransportError("Network error", {
							code: "transport_network_error",
							status: 0,
							cause: hostileCause,
						});
					},
				},
			},
		});
		const app = createServerApp(provider, { logger: () => undefined });
		const response = await app.request("/v1/probe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "hostile-cause", input: {} }),
		});
		expect(response.status).toBe(502);
		expect(errorCategory(response)).toBe("network");
	});

	it("classifies PROXY_REQUIRED as proxy_pool through real HTTP, stealth, and native paths", async () => {
		delete process.env[SMARTPROXY_APP_KEY_ENV];
		clearProxyResolutionCache();
		const operations = Object.fromEntries(
			(["http", "stealth", "native"] as const).map((transport) => [
				transport,
				{
					riskClass: "read" as const,
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					upstream: { baseUrl: "http://127.0.0.1:9" },
					handler: async (ctx: ProviderContext) => {
						if (transport === "http") await ctx.http.get("/");
						if (transport === "stealth") await ctx.stealth.fetch("/");
						if (transport === "native") {
							await ctx.native.network.connectTcp({ host: "127.0.0.1", port: 9 });
						}
						return { ok: true };
					},
				},
			]),
		);
		const provider = createProviderDefinitionDouble({
			id: "proxy-required-classification",
			http: {},
			stealth: { browser: "chrome", os: "macos" },
			native: {
				network: { tcp: [{ host: "127.0.0.1", ports: [9], tls: "disabled" }] },
			},
			proxy: { mode: "required", providers: ["smartproxy"] },
			operations,
		});
		const events: ProviderServerLogEvent[] = [];
		const app = createServerApp(provider, { logger: (event) => events.push(event) });
		for (const transport of ["http", "stealth", "native"] as const) {
			const response = await app.request(`/v1/${transport}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: `proxy-required-${transport}`, input: {} }),
			});
			expect(errorCategory(response)).toBe("proxy_pool");
			const failed = events.find(
				(event) =>
					event.event === "provider_request_failed" &&
					event.requestId === `proxy-required-${transport}`,
			);
			expect(failed).toMatchObject({
				event: "provider_request_failed",
				errorCategory: "proxy_pool",
			});
		}
	});

	it("classifies every native transport error code without falling through to upstream_http", async () => {
		const expected = {
			native_connection_aborted: "client_cancelled",
			native_connection_closed: "network",
			native_connection_failed: "network",
			native_connection_idle_timeout: "timeout",
			native_connection_timeout: "timeout",
			native_egress_authorization_failed: "provider_error",
			native_egress_grant_expired: "provider_error",
			native_egress_grant_invalid: "provider_error",
			native_egress_grant_limit_exceeded: "provider_error",
			native_egress_input_invalid: "provider_error",
			native_egress_not_declared: "provider_error",
			native_egress_policy_invalid: "provider_error",
			native_dynamic_egress_unsupported: "provider_error",
			native_proxy_expired: "proxy_pool",
			native_proxy_invalid: "proxy_pool",
		} as const satisfies Record<NativeNetworkErrorCode, string>;
		const operations = Object.fromEntries(
			(Object.keys(expected) as NativeNetworkErrorCode[]).map((code) => [
				code,
				{
					riskClass: "read" as const,
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					handler: async () => {
						throw new NativeNetworkError(`classified ${code}`, code);
					},
				},
			]),
		);
		const provider = createProviderDefinitionDouble({
			id: "native-code-classification",
			operations,
		});
		const app = createServerApp(provider, { logger: () => undefined });
		for (const [code, category] of Object.entries(expected)) {
			const response = await app.request(`/v1/${code}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: `request-${code}`, input: {} }),
			});
			expect(errorCategory(response)).toBe(category);
		}
	});
});
