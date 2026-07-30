import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { type Server, Socket, createServer } from "node:net";

import {
	createNativeNetworkClient,
	createNativeNetworkConnection,
	NativeIdleTimeoutError,
} from "../native-network.js";

type Fixture = { server: Server; sockets: Set<Socket>; host: string; port: number };

const fixtures: Fixture[] = [];
const connections: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
	jest.useRealTimers();
});

afterEach(async () => {
	jest.useRealTimers();
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
	const fixture = { server, sockets, host: "127.0.0.1", port: address.port };
	fixtures.push(fixture);
	return fixture;
}

async function connect(fixture: Fixture, idleTimeoutMs?: number) {
	const connection = await createNativeNetworkClient({ proxyPolicy: { mode: "disabled" } }).connectTcp(
		{
			host: fixture.host,
			port: fixture.port,
			timeoutMs: 1_000,
			...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
		},
	);
	connections.push(connection);
	return connection;
}

describe("native network idle read timeout", () => {
	it("rejects a silent established peer with the typed idle error", async () => {
		const fixture = await listen(createServer(() => undefined));
		const connection = await connect(fixture, 30);

		const attempt = connection.read();
		await expect(attempt).rejects.toBeInstanceOf(NativeIdleTimeoutError);
		await expect(attempt).rejects.toMatchObject({ code: "native_connection_idle_timeout" });
		await expect(connection.read()).rejects.toBeInstanceOf(NativeIdleTimeoutError);
	});

	it("resets the idle window after every successful read", async () => {
		const fixture = await listen(
			createServer((socket) => {
				setTimeout(() => socket.write("one"), 40).unref();
				setTimeout(() => socket.write("two"), 80).unref();
			}),
		);
		const connection = await connect(fixture, 60);

		expect(new TextDecoder().decode(await connection.read())).toBe("one");
		expect(new TextDecoder().decode(await connection.read())).toBe("two");
		await connection.close();
	});

	it("leaves silent reads pending when idleTimeoutMs is absent", async () => {
		let peer: Socket | undefined;
		const fixture = await listen(
			createServer((socket) => {
				peer = socket;
			}),
		);
		const connection = await connect(fixture);
		const read = connection.read();

		expect(
			await Promise.race([
				read.then(() => "settled"),
				Bun.sleep(50).then(() => "pending"),
			]),
		).toBe("pending");
		peer?.end();
		await expect(read).resolves.toBeNull();
	});

	it("returns null when the peer ends before the idle window", async () => {
		const fixture = await listen(createServer((socket) => socket.end()));
		const connection = await connect(fixture, 1_000);

		await expect(connection.read()).resolves.toBeNull();
		expect(connection.closeReason).toBeUndefined();
	});

	it("keeps establishment timeout classification separate", async () => {
		const fixture = await listen(createServer(() => undefined));
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [() => ({
				url: `socks5://${fixture.host}:${fixture.port}`,
				vendor: "nodemaven",
				sticky: false,
			})],
		});

		await expect(
			client.connectTcp({
				host: "127.0.0.1",
				port: 9,
				timeoutMs: 30,
				idleTimeoutMs: 1,
			}),
		).rejects.toMatchObject({ code: "native_connection_timeout" });
	});

	it("clears its timer when the connection closes", async () => {
		const fixture = await listen(createServer(() => undefined));
		const socket = new Socket();
		await new Promise<void>((resolve, reject) => {
			socket.once("error", reject);
			socket.connect(fixture.port, fixture.host, () => {
				socket.off("error", reject);
				resolve();
			});
		});

		jest.useFakeTimers();
		const connection = createNativeNetworkConnection(socket, undefined, {}, 1_000);
		connections.push(connection);
		expect(jest.getTimerCount()).toBe(1);
		await connection.close();
		expect(jest.getTimerCount()).toBe(0);
	});
});
