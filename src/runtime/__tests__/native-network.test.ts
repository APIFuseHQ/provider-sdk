import { afterEach, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer } from "node:tls";

import { assertIsError } from "../../__tests__/test-utils.js";
import { ProxyResolutionError } from "../../config/loader.js";
import { formatIpv6 } from "../../native-address.js";
import {
	createNativeNetworkClient,
	type NativeGatewayProxySynthesizer,
	resolveNativeGatewayProxy,
} from "../native-network.js";

type ListeningFixture = {
	host: string;
	port: number;
	server: Server;
	sockets: Set<Socket>;
};

const fixtures: ListeningFixture[] = [];
let tlsKey: Buffer;
let tlsCert: Buffer;

beforeAll(() => {
	const directory = mkdtempSync(join(tmpdir(), "apifuse-native-network-"));
	const keyPath = join(directory, "key.pem");
	const certPath = join(directory, "cert.pem");
	const generated = Bun.spawnSync([
		"openssl",
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		keyPath,
		"-out",
		certPath,
		"-days",
		"1",
		"-subj",
		"/CN=localhost",
	]);
	if (generated.exitCode !== 0) {
		throw new Error("Failed to create the local TLS test certificate");
	}
	tlsKey = readFileSync(keyPath);
	tlsCert = readFileSync(certPath);
	rmSync(directory, { recursive: true });
});

afterEach(async () => {
	setSystemTime();
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		for (const socket of fixture.sockets) socket.destroy();
		await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
	}
});

async function listen(server: Server): Promise<ListeningFixture> {
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
	const fixture = { host: "127.0.0.1", port: address.port, server, sockets };
	fixtures.push(fixture);
	return fixture;
}

function take(
	buffer: Buffer<ArrayBufferLike>,
	count: number,
): [Buffer<ArrayBufferLike>, Buffer<ArrayBufferLike>] | undefined {
	if (buffer.length < count) return undefined;
	return [buffer.subarray(0, count), buffer.subarray(count)];
}

async function readPayload(connection: {
	read(): Promise<Uint8Array<ArrayBufferLike> | null>;
}): Promise<Uint8Array<ArrayBufferLike>> {
	const payload = await connection.read();
	if (payload === null) throw new Error("Expected connection payload before EOF");
	return payload;
}

async function startSocks5Server(
	options: {
		stall?: boolean;
		onConnection?: () => void;
		replyCode?: number;
		upstreamHost?: string;
	} = {},
): Promise<ListeningFixture & { destinations: Array<{ host: string; port: number }> }> {
	const destinations: Array<{ host: string; port: number }> = [];
	const server = createServer((client) => {
		options.onConnection?.();
		if (options.stall) return;
		let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let state: "greeting" | "auth" | "request" | "tunnel" = "greeting";

		client.on("data", (chunk: Buffer) => {
			if (state === "tunnel") return;
			buffered = Buffer.concat([buffered, chunk]);
			while (true) {
				if (state === "greeting") {
					if (buffered.length < 2) return;
					const methods = buffered[1] ?? 0;
					const packet = take(buffered, 2 + methods);
					if (!packet) return;
					buffered = packet[1];
					client.write(Buffer.from([5, 2]));
					state = "auth";
					continue;
				}

				if (state === "auth") {
					if (buffered.length < 2) return;
					const usernameLength = buffered[1] ?? 0;
					if (buffered.length < 3 + usernameLength) return;
					const passwordLength = buffered[2 + usernameLength] ?? 0;
					const packet = take(buffered, 3 + usernameLength + passwordLength);
					if (!packet) return;
					buffered = packet[1];
					client.write(Buffer.from([1, 0]));
					state = "request";
					continue;
				}

				if (buffered.length < 5) return;
				const addressType = buffered[3];
				let offset = 4;
				let host: string;
				if (addressType === 1) {
					if (buffered.length < 10) return;
					host = Array.from(buffered.subarray(offset, offset + 4)).join(".");
					offset += 4;
				} else if (addressType === 3) {
					const length = buffered[offset] ?? 0;
					offset += 1;
					if (buffered.length < offset + length + 2) return;
					host = buffered.subarray(offset, offset + length).toString("utf8");
					offset += length;
				} else if (addressType === 4) {
					if (buffered.length < 22) return;
					host = formatIpv6(buffered.subarray(offset, offset + 16));
					offset += 16;
				} else {
					client.destroy(new Error("Unsupported SOCKS test address type"));
					return;
				}
				const packet = take(buffered, offset + 2);
				if (!packet) return;
				const port = packet[0].readUInt16BE(offset);
				buffered = packet[1];
				destinations.push({ host, port });
				if (options.replyCode !== undefined) {
					client.end(Buffer.from([5, options.replyCode, 0, 1, 0, 0, 0, 0, 0, 0]));
					state = "tunnel";
					return;
				}
				const upstream = new Socket();
				upstream.once("error", () => {
					client.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
					client.destroy();
				});
				upstream.connect(port, options.upstreamHost ?? host, () => {
					client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
					state = "tunnel";
					if (buffered.length > 0) upstream.write(buffered);
					client.pipe(upstream);
					upstream.pipe(client);
				});
				return;
			}
		});
	});
	return Object.assign(await listen(server), { destinations });
}

async function startHttpConnectServer(options: { upstreamHost?: string } = {}): Promise<
	ListeningFixture & {
		destinations: Array<{ host: string; port: number }>;
		requests: string[];
	}
> {
	const destinations: Array<{ host: string; port: number }> = [];
	const requests: string[] = [];
	const server = createServer((client) => {
		let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		client.on("data", function onData(chunk: Buffer) {
			buffered = Buffer.concat([buffered, chunk]);
			const headerEnd = buffered.indexOf("\r\n\r\n");
			if (headerEnd < 0) return;
			client.off("data", onData);
			const request = buffered.subarray(0, headerEnd).toString("latin1");
			requests.push(request);
			const requestLine = request.split("\r\n")[0];
			const authority = requestLine?.split(" ")[1];
			if (!authority) {
				client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
				return;
			}
			const separator = authority.lastIndexOf(":");
			const host = authority.slice(0, separator).replace(/^\[|\]$/g, "");
			const port = Number(authority.slice(separator + 1));
			destinations.push({ host, port });
			const upstream = new Socket();
			upstream.once("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
			upstream.connect(port, options.upstreamHost ?? host, () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				const remaining = buffered.subarray(headerEnd + 4);
				if (remaining.length > 0) upstream.write(remaining);
				client.pipe(upstream);
				upstream.pipe(client);
			});
		});
	});
	return Object.assign(await listen(server), { destinations, requests });
}

function localSynthesizer(proxy: ListeningFixture): NativeGatewayProxySynthesizer {
	const password = randomUUID();
	return () => ({
		url: `socks5://fixture-user:${encodeURIComponent(password)}@${proxy.host}:${proxy.port}`,
		vendor: "nodemaven",
		sticky: false,
	});
}

function localHttpSynthesizer(proxy: ListeningFixture): NativeGatewayProxySynthesizer {
	const password = randomUUID();
	return () => ({
		url: `http://fixture-user:${encodeURIComponent(password)}@${proxy.host}:${proxy.port}`,
		vendor: "nodemaven",
		sticky: false,
	});
}

describe("native network runtime", () => {
	it("establishes a TCP tunnel to the requested host and port", async () => {
		const destination = await listen(
			createServer((socket) => socket.on("data", (chunk) => socket.write(chunk))),
		);
		const proxy = await startSocks5Server();
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [localSynthesizer(proxy)],
		});

		const connection = await client.connectTcp({
			host: destination.host,
			port: destination.port,
			timeoutMs: 1_000,
		});
		await connection.write(new TextEncoder().encode("hello"));
		expect(new TextDecoder().decode(await readPayload(connection))).toBe("hello");
		expect(proxy.destinations).toEqual([{ host: destination.host, port: destination.port }]);
		expect(connection.proxy).toMatchObject({ vendor: "nodemaven", sticky: false });
		await connection.close();
	});

	it("negotiates TLS on top of the SOCKS tunnel", async () => {
		const destination = await listen(
			createTlsServer({ key: tlsKey, cert: tlsCert }, (socket) => {
				socket.on("data", (chunk) => socket.write(chunk));
			}),
		);
		const proxy = await startSocks5Server();
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [localSynthesizer(proxy)],
		});

		const connection = await client.connectTls({
			host: destination.host,
			port: destination.port,
			serverName: "localhost",
			rejectUnauthorized: false,
			timeoutMs: 1_000,
		});
		await connection.write(new TextEncoder().encode("secure"));
		expect(new TextDecoder().decode(await readPayload(connection))).toBe("secure");
		expect(proxy.destinations[0]).toEqual({ host: destination.host, port: destination.port });
		await connection.close();
	});

	it("negotiates origin TLS on top of an HTTP CONNECT tunnel", async () => {
		const destination = await listen(
			createTlsServer({ key: tlsKey, cert: tlsCert }, (socket) => {
				socket.on("data", (chunk) => socket.write(chunk));
			}),
		);
		const proxy = await startHttpConnectServer();
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [localHttpSynthesizer(proxy)],
		});

		const connection = await client.connectTls({
			host: destination.host,
			port: destination.port,
			serverName: "localhost",
			rejectUnauthorized: false,
			timeoutMs: 1_000,
		});
		await connection.write(new TextEncoder().encode("connect-secure"));
		expect(new TextDecoder().decode(await readPayload(connection))).toBe("connect-secure");
		expect(proxy.destinations).toEqual([{ host: destination.host, port: destination.port }]);
		await connection.close();
	});

	it("fails closed with a typed error when required proxy credentials do not resolve", async () => {
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [() => undefined],
		});

		const attempt = client.connectTcp({ host: "127.0.0.1", port: 9, timeoutMs: 50 });
		await expect(attempt).rejects.toBeInstanceOf(ProxyResolutionError);
		await expect(attempt).rejects.toMatchObject({ code: "PROXY_REQUIRED" });
	});

	it("connects directly when proxy mode is disabled", async () => {
		const destination = await listen(
			createServer((socket) => socket.on("data", (chunk) => socket.write(chunk))),
		);
		const client = createNativeNetworkClient({ proxyPolicy: { mode: "disabled" } });
		const connection = await client.connectTcp({
			host: destination.host,
			port: destination.port,
			timeoutMs: 1_000,
		});
		await connection.write(new TextEncoder().encode("direct"));
		expect(new TextDecoder().decode(await readPayload(connection))).toBe("direct");
		expect(connection.proxy).toBeUndefined();
		await connection.close();
	});

	it("sends the canonical authorized host to direct, SOCKS5, and HTTP CONNECT sinks", async () => {
		const destination = await listen(
			createServer((socket) => socket.on("data", (chunk) => socket.write(chunk))),
		);
		const suppliedHost = "１２７．０．０．１。";
		const egress = {
			tcp: [{ host: destination.host, ports: [destination.port], tls: "disabled" as const }],
		};

		const direct = createNativeNetworkClient({ proxyPolicy: { mode: "disabled" }, egress });
		const directConnection = await direct.connectTcp({
			host: suppliedHost,
			port: destination.port,
			timeoutMs: 1_000,
		});
		await directConnection.close();

		const socksProxy = await startSocks5Server();
		const socks = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [localSynthesizer(socksProxy)],
			egress,
		});
		const socksConnection = await socks.connectTcp({
			host: suppliedHost,
			port: destination.port,
			timeoutMs: 1_000,
		});
		expect(socksProxy.destinations).toEqual([{ host: destination.host, port: destination.port }]);
		await socksConnection.close();

		const httpProxy = await startHttpConnectServer();
		const http = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [localHttpSynthesizer(httpProxy)],
			egress,
		});
		const httpConnection = await http.connectTcp({
			host: suppliedHost,
			port: destination.port,
			timeoutMs: 1_000,
		});
		const authority = `${destination.host}:${destination.port}`;
		expect(httpProxy.requests).toHaveLength(1);
		expect(httpProxy.requests[0]).toContain(`CONNECT ${authority} HTTP/1.1`);
		expect(httpProxy.requests[0]).toContain(`\r\nHost: ${authority}\r\n`);
		expect(httpProxy.requests[0]).not.toContain(suppliedHost);
		await httpConnection.close();
	});

	it("sends canonical IPv6 unbracketed to SOCKS5 and bracketed to HTTP CONNECT", async () => {
		const destination = await listen(
			createServer((socket) => socket.on("data", (chunk) => socket.write(chunk))),
		);
		const suppliedHost = "2404:4600:0009:02DC:0000:0000:0000:0228";
		const canonicalHost = "2404:4600:9:2dc::228";
		const egress = {
			tcp: [{ host: canonicalHost, ports: [destination.port], tls: "disabled" as const }],
		};

		const socksProxy = await startSocks5Server({ upstreamHost: destination.host });
		const socks = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [localSynthesizer(socksProxy)],
			egress,
		});
		const socksConnection = await socks.connectTcp({
			host: suppliedHost,
			port: destination.port,
			timeoutMs: 1_000,
		});
		expect(socksProxy.destinations).toEqual([{ host: canonicalHost, port: destination.port }]);
		await socksConnection.close();

		const httpProxy = await startHttpConnectServer({ upstreamHost: destination.host });
		const http = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [localHttpSynthesizer(httpProxy)],
			egress,
		});
		const httpConnection = await http.connectTcp({
			host: suppliedHost,
			port: destination.port,
			timeoutMs: 1_000,
		});
		const authority = `[${canonicalHost}]:${destination.port}`;
		expect(httpProxy.requests).toHaveLength(1);
		expect(httpProxy.requests[0]).toContain(`CONNECT ${authority} HTTP/1.1`);
		expect(httpProxy.requests[0]).toContain(`\r\nHost: ${authority}\r\n`);
		expect(httpProxy.requests[0]).not.toContain(suppliedHost);
		await httpConnection.close();
	});

	it("round-trips IPv6 grants across equivalent spellings", async () => {
		const destination = await listen(
			createServer((socket) => socket.on("data", (chunk) => socket.write(chunk))),
		);
		const proxy = await startSocks5Server({ upstreamHost: destination.host });
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [localSynthesizer(proxy)],
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetIpv6Cidrs: ["2404:4600:9:2dc::/64"],
						targetPorts: [destination.port],
						tls: "disabled",
					},
				],
			},
		});
		client.grantTcpEgress({
			sourceHost: "bootstrap.example",
			sourcePort: 443,
			host: "2404:4600:0009:02dc:0000:0000:0000:0228",
			port: destination.port,
			tls: "disabled",
		});
		const connection = await client.connectTcp({
			host: "2404:4600:9:2DC::0.0.2.40",
			port: destination.port,
			timeoutMs: 1_000,
		});
		expect(proxy.destinations).toEqual([{ host: "2404:4600:9:2dc::228", port: destination.port }]);
		await connection.close();
		await expect(
			client.connectTcp({ host: "2404:4600:9:2dc::229", port: destination.port }),
		).rejects.toMatchObject({ code: "native_egress_not_declared" });
	});

	it("round-trips Unicode and punycode grant spellings through the canonical SOCKS sink", async () => {
		const destination = await listen(
			createServer((socket) => socket.on("data", (chunk) => socket.write(chunk))),
		);
		const proxy = await startSocks5Server({ upstreamHost: destination.host });
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [localSynthesizer(proxy)],
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["한글.kr"],
						targetPorts: [destination.port],
						tls: "disabled",
					},
				],
			},
		});
		client.grantTcpEgress({
			sourceHost: "bootstrap.example",
			sourcePort: 443,
			host: "한글.kr",
			port: destination.port,
			tls: "disabled",
		});
		for (const host of ["한글.kr", "xn--bj0bj06e.kr"]) {
			const connection = await client.connectTcp({
				host,
				port: destination.port,
				timeoutMs: 1_000,
			});
			await connection.write(new TextEncoder().encode("idn"));
			expect(new TextDecoder().decode(await readPayload(connection))).toBe("idn");
			await connection.close();
		}
		expect(proxy.destinations).toEqual([
			{ host: "xn--bj0bj06e.kr", port: destination.port },
			{ host: "xn--bj0bj06e.kr", port: destination.port },
		]);
	});

	it("preserves a refused direct connect as the native failure cause", async () => {
		const closed = await listen(createServer());
		const { host, port } = closed;
		fixtures.pop();
		await new Promise<void>((resolve) => closed.server.close(() => resolve()));
		const client = createNativeNetworkClient({ proxyPolicy: { mode: "disabled" } });

		let thrown: unknown;
		try {
			await client.connectTcp({ host, port, timeoutMs: 1_000 });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({ code: "native_connection_failed" });
		assertIsError(thrown);
		expect(thrown.cause).toMatchObject({ code: "ECONNREFUSED" });
	});

	it("preserves a proxy rejection reply and redacts proxy credentials", async () => {
		const proxy = await startSocks5Server({ replyCode: 0x02 });
		const username = `fixture-user-${randomUUID()}`;
		const password = `fixture-password-${randomUUID()}`;
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [
				() => ({
					url: `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${proxy.host}:${proxy.port}`,
					vendor: "nodemaven",
					sticky: false,
				}),
			],
		});

		let thrown: unknown;
		try {
			await client.connectTcp({ host: "blocked.example", port: 995, timeoutMs: 1_000 });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({ code: "native_connection_failed" });
		assertIsError(thrown);
		expect(thrown.cause).toMatchObject({
			message: "Socks5 proxy rejected connection - NotAllowed",
			socks5ReplyCode: 0x02,
		});
		const serialized = JSON.stringify(thrown);
		expect(serialized).not.toContain(username);
		expect(serialized).not.toContain(password);
		expect(serialized).toContain("[REDACTED]");
	});

	it("connects directly when an optional vendor chain does not resolve", async () => {
		const destination = await listen(createServer((socket) => socket.end("optional-direct")));
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "optional", providers: ["smartproxy", "nodemaven"] },
			gatewaySynthesizers: [() => undefined],
		});
		const connection = await client.connectTcp({
			host: destination.host,
			port: destination.port,
			timeoutMs: 1_000,
		});
		expect(new TextDecoder().decode(await readPayload(connection))).toBe("optional-direct");
		expect(connection.proxy).toBeUndefined();
		await connection.close();
	});

	it("aborts a stalled SOCKS handshake", async () => {
		const proxy = await startSocks5Server({ stall: true });
		const controller = new AbortController();
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [localSynthesizer(proxy)],
		});
		const attempt = client.connectTcp({
			host: "127.0.0.1",
			port: 9,
			timeoutMs: 5_000,
			signal: controller.signal,
		});
		controller.abort();
		await expect(attempt).rejects.toMatchObject({ code: "native_connection_aborted" });
	});

	it("applies timeoutMs to the SOCKS negotiation phase", async () => {
		const proxy = await startSocks5Server({ stall: true });
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [localSynthesizer(proxy)],
		});
		const startedAt = Date.now();
		await expect(
			client.connectTcp({ host: "127.0.0.1", port: 9, timeoutMs: 30 }),
		).rejects.toMatchObject({ code: "native_connection_timeout" });
		expect(Date.now() - startedAt).toBeLessThan(500);
	});

	it("revalidates an expiring grant after the proxy socket connects and before SOCKS CONNECT", async () => {
		const destination = await listen(createServer());
		const startedAt = new Date("2026-07-31T00:00:00.000Z");
		setSystemTime(startedAt);
		const proxy = await startSocks5Server({
			onConnection: () => setSystemTime(new Date(startedAt.getTime() + 10)),
		});
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [localSynthesizer(proxy)],
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetIpv4Cidrs: ["127.0.0.1/32"],
						targetPorts: [destination.port],
						tls: "disabled",
						ttlMs: 10,
					},
				],
			},
		});
		client.grantTcpEgress({
			sourceHost: "bootstrap.example",
			sourcePort: 443,
			host: destination.host,
			port: destination.port,
			tls: "disabled",
		});

		await expect(
			client.connectTcp({ host: destination.host, port: destination.port, timeoutMs: 1_000 }),
		).rejects.toMatchObject({ code: "native_egress_grant_expired" });
		expect(proxy.destinations).toEqual([]);
	});

	it("defaults NodeMaven native connections to CONNECT and allows a SOCKS5 override", async () => {
		const usernameBefore = process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME;
		const passwordBefore = process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD;
		process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = `fixture-${randomUUID()}`;
		process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = randomUUID();
		try {
			const resolved = await resolveNativeGatewayProxy({
				policy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					session: { affinity: "connection", lifetimeMinutes: 60 },
				},
				affinityKey: "hashed-account-identity",
			});
			expect(resolved?.vendor).toBe("nodemaven");
			expect(resolved?.url).toMatch(/^http:\/\//);
			const port = Number(new URL(resolved?.url ?? "").port);
			expect(port).toBeGreaterThanOrEqual(8080);
			expect(port).toBeLessThanOrEqual(9080);

			const socks = await resolveNativeGatewayProxy({
				policy: { mode: "required", providers: ["nodemaven"] },
				affinityKey: "hashed-account-identity",
				protocol: "socks5",
			});
			expect(socks?.url).toMatch(/^socks5:\/\//);
		} finally {
			if (usernameBefore === undefined) delete process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME;
			else process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = usernameBefore;
			if (passwordBefore === undefined) delete process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD;
			else process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = passwordBefore;
		}
	});
});
