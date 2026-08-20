import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type Server, Socket } from "node:net";

import { assertIsError } from "../../__tests__/test-utils.js";
import {
	createNativeNetworkClient,
	type NativeGatewayProxySynthesizer,
	type NativeNetworkClientOptions,
} from "../native-network.js";

type Fixture = {
	readonly host: string;
	readonly port: number;
	readonly server: Server;
	readonly sockets: Set<Socket>;
};

type TunnelProtocol = "http" | "socks5";

const fixtures: Fixture[] = [];
const connections: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	for (const connection of connections.splice(0)) await connection.close();
	for (const fixture of fixtures.splice(0).reverse()) {
		for (const socket of fixture.sockets) socket.destroy();
		await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
	}
});

async function listen(server: Server): Promise<Fixture> {
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

function take(buffer: Buffer, count: number): [Buffer, Buffer] | undefined {
	if (buffer.length < count) return undefined;
	return [buffer.subarray(0, count), buffer.subarray(count)];
}

async function startSocksProxy(options: { stall?: boolean; replyCode?: number } = {}) {
	return await listen(
		createServer((client) => {
			if (options.stall) return;
			let buffered: Buffer = Buffer.alloc(0);
			let state: "greeting" | "auth" | "request" | "tunnel" = "greeting";
			client.on("data", (chunk: Buffer) => {
				if (state === "tunnel") return;
				buffered = Buffer.concat([buffered, chunk]);
				while (true) {
					if (state === "greeting") {
						if (buffered.length < 2) return;
						const packet = take(buffered, 2 + (buffered[1] ?? 0));
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

					if (buffered.length < 7) return;
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
					} else {
						client.destroy();
						return;
					}
					const packet = take(buffered, offset + 2);
					if (!packet) return;
					const port = packet[0].readUInt16BE(offset);
					buffered = packet[1];
					if (options.replyCode !== undefined) {
						client.end(Buffer.from([5, options.replyCode, 0, 1, 0, 0, 0, 0, 0, 0]));
						state = "tunnel";
						return;
					}
					const upstream = new Socket();
					upstream.once("error", () => client.destroy());
					upstream.connect(port, host, () => {
						client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
						state = "tunnel";
						if (buffered.length > 0) upstream.write(buffered);
						client.pipe(upstream);
						upstream.pipe(client);
					});
					return;
				}
			});
		}),
	);
}

async function startHttpProxy(options: { stall?: boolean; statusLine?: string } = {}) {
	return await listen(
		createServer((client) => {
			if (options.stall) return;
			let buffered: Buffer = Buffer.alloc(0);
			client.on("data", function onData(chunk: Buffer) {
				buffered = Buffer.concat([buffered, chunk]);
				const headerEnd = buffered.indexOf("\r\n\r\n");
				if (headerEnd < 0) return;
				client.off("data", onData);
				const requestLine = buffered.subarray(0, headerEnd).toString("latin1").split("\r\n")[0];
				const authority = requestLine?.split(" ")[1];
				const statusLine = options.statusLine ?? "HTTP/1.1 200 Connection Established";
				if (!/^HTTP\/1\.[01] 2[0-9]{2}(?: |$)/.test(statusLine) || !authority) {
					client.end(`${statusLine}\r\nProxy-Agent: conformance-fixture\r\n\r\n`);
					return;
				}
				const separator = authority.lastIndexOf(":");
				const host = authority.slice(0, separator).replace(/^\[|\]$/g, "");
				const port = Number(authority.slice(separator + 1));
				const upstream = new Socket();
				upstream.once("error", () => client.destroy());
				upstream.connect(port, host, () => {
					client.write(`${statusLine}\r\nProxy-Agent: conformance-fixture\r\n\r\n`);
					const remaining = buffered.subarray(headerEnd + 4);
					if (remaining.length > 0) upstream.write(remaining);
					client.pipe(upstream);
					upstream.pipe(client);
				});
			});
		}),
	);
}

async function startProxy(
	protocol: TunnelProtocol,
	options: { stall?: boolean; rejectedStatusLine?: string } = {},
): Promise<Fixture> {
	return protocol === "http"
		? await startHttpProxy({ stall: options.stall, statusLine: options.rejectedStatusLine })
		: await startSocksProxy({
				stall: options.stall,
				replyCode: options.rejectedStatusLine ? 2 : undefined,
			});
}

function clientFor(
	protocol: TunnelProtocol,
	proxy: Fixture,
	credentials: { username?: string; password?: string } = {},
	options: Partial<NativeNetworkClientOptions> = {},
) {
	const username = credentials.username ?? `fixture-user-${randomUUID()}`;
	const password = credentials.password ?? `fixture-password-${randomUUID()}`;
	const synthesizer: NativeGatewayProxySynthesizer = () => ({
		url: `${protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${proxy.host}:${proxy.port}`,
		vendor: "nodemaven",
		sticky: false,
	});
	return createNativeNetworkClient({
		proxyPolicy: { mode: "required", providers: ["nodemaven"] },
		gatewaySynthesizers: [synthesizer],
		...options,
	});
}

for (const protocol of ["socks5", "http"] as const) {
	describe(`${protocol} native tunnel conformance`, () => {
		it("establishes a byte tunnel", async () => {
			const destination = await listen(
				createServer((socket) => socket.on("data", (chunk) => socket.write(chunk))),
			);
			const proxy = await startProxy(protocol);
			const connection = await clientFor(protocol, proxy).connectTcp({
				host: destination.host,
				port: destination.port,
				timeoutMs: 1_000,
			});
			connections.push(connection);
			await connection.write(new TextEncoder().encode("conform"));
			const echoed = await connection.read();
			if (echoed === null) throw new Error("Tunnel closed before echoing fixture data");
			expect(new TextDecoder().decode(echoed)).toBe("conform");
		});

		it("applies one establishment deadline to negotiation", async () => {
			const proxy = await startProxy(protocol, { stall: true });
			const startedAt = Date.now();
			await expect(
				clientFor(protocol, proxy).connectTcp({ host: "127.0.0.1", port: 9, timeoutMs: 30 }),
			).rejects.toMatchObject({ code: "native_connection_timeout" });
			expect(Date.now() - startedAt).toBeLessThan(500);
		});

		it("cancels negotiation with AbortSignal", async () => {
			const proxy = await startProxy(protocol, { stall: true });
			const controller = new AbortController();
			const attempt = clientFor(protocol, proxy).connectTcp({
				host: "127.0.0.1",
				port: 9,
				timeoutMs: 5_000,
				signal: controller.signal,
			});
			controller.abort();
			await expect(attempt).rejects.toMatchObject({ code: "native_connection_aborted" });
		});

		it("leaves idle reads pending when idleTimeoutMs is absent", async () => {
			const destination = await listen(createServer(() => undefined));
			const proxy = await startProxy(protocol);
			const connection = await clientFor(protocol, proxy).connectTcp({
				host: destination.host,
				port: destination.port,
				timeoutMs: 1_000,
			});
			connections.push(connection);
			const read = connection.read();
			expect(
				await Promise.race([read.then(() => "settled"), Bun.sleep(50).then(() => "pending")]),
			).toBe("pending");
			for (const socket of destination.sockets) socket.end();
			await expect(read).resolves.toBeNull();
		});

		it("enforces the opt-in idle read timeout", async () => {
			const destination = await listen(createServer(() => undefined));
			const proxy = await startProxy(protocol);
			const connection = await clientFor(protocol, proxy).connectTcp({
				host: destination.host,
				port: destination.port,
				timeoutMs: 1_000,
				idleTimeoutMs: 30,
			});
			connections.push(connection);
			const outcome = await Promise.race([
				connection.read().then(
					() => ({ code: "read_settled" }),
					(error: unknown) => error,
				),
				Bun.sleep(200).then(() => ({ code: "idle_timeout_missing" })),
			]);
			expect(outcome).toMatchObject({
				code: "native_connection_idle_timeout",
			});
		});

		it("closes idempotently and tears down the peer", async () => {
			const destination = await listen(createServer(() => undefined));
			const proxy = await startProxy(protocol);
			const connection = await clientFor(protocol, proxy).connectTcp({
				host: destination.host,
				port: destination.port,
				timeoutMs: 1_000,
			});
			expect(destination.sockets.size).toBe(1);
			await connection.close();
			await connection.close();
			for (let attempt = 0; attempt < 20 && destination.sockets.size > 0; attempt += 1) {
				await Bun.sleep(5);
			}
			expect(destination.sockets.size).toBe(0);
		});

		it("classifies proxy refusal and preserves protocol diagnostics", async () => {
			const username = `fixture-user-${randomUUID()}`;
			const password = `fixture-password-${randomUUID()}`;
			const basic = Buffer.from(`${username}:${password}`).toString("base64");
			const rejectedStatusLine = `HTTP/1.1 614 ${username} ${password} ${basic}`;
			const proxy = await startProxy(protocol, { rejectedStatusLine });
			let thrown: unknown;
			try {
				await clientFor(protocol, proxy, { username, password }).connectTcp({
					host: "blocked.example",
					port: 995,
					timeoutMs: 1_000,
				});
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toMatchObject({ code: "native_connection_failed" });
			assertIsError(thrown);
			if (protocol === "http") {
				const cause = thrown.cause;
				assertIsError(cause);
				expect(cause).toMatchObject({
					connectStatusCode: 614,
					connectStatusLine: expect.stringContaining("HTTP/1.1 614"),
				});
				const causeText = String(cause);
				expect(causeText).toContain("HTTP/1.1 614");
				expect(causeText).not.toContain(username);
				expect(causeText).not.toContain(password);
				expect(causeText).not.toContain(basic);
			} else {
				expect(thrown.cause).toMatchObject({ socks5ReplyCode: 2 });
			}
			const serialized = JSON.stringify(thrown);
			expect(serialized).not.toContain(username);
			expect(serialized).not.toContain(password);
			expect(serialized).not.toContain(basic);
		});
	});
}
