import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { type Server, Socket, createServer } from "node:net";

import { createNativeNetworkConnection, NativeProxyExpiredError } from "../native-network.js";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");

type Fixture = { server: Server; sockets: Set<Socket>; host: string; port: number };
const fixtures: Fixture[] = [];
const connections: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
	jest.useRealTimers();
});

afterEach(async () => {
	for (const connection of connections.splice(0)) await connection.close();
	for (const fixture of fixtures.splice(0).reverse()) {
		for (const socket of fixture.sockets) socket.destroy();
		await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
	}
	jest.useRealTimers();
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

async function createStickyConnection(input?: {
	expiresInMs?: number;
	drainLeadSeconds?: number;
	warn?: (message: string) => void;
}) {
	const destination = await listen(createServer(() => undefined));
	const socket = new Socket();
	await new Promise<void>((resolve, reject) => {
		socket.once("error", reject);
		socket.connect(destination.port, destination.host, () => {
			socket.off("error", reject);
			resolve();
		});
	});

	jest.useFakeTimers({ now: NOW });
	const connection = createNativeNetworkConnection(
		socket,
		{
			url: "socks5://fixture.invalid:1080",
			vendor: "nodemaven",
			sticky: true,
			sessionId: "fixture-session",
			expiresAt: new Date(NOW + (input?.expiresInMs ?? 10_000)).toISOString(),
		},
		{
			proxyPolicy: {
				mode: "required",
				providers: ["nodemaven"],
				session: {
					affinity: "connection",
					drainLeadSeconds: input?.drainLeadSeconds ?? 3,
				},
			},
			warn: input?.warn,
		},
	);
	connections.push(connection);
	return connection;
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("native sticky proxy drain lifecycle", () => {
	it("invokes the registered handler once at the declared lead time", async () => {
		const connection = await createStickyConnection();
		const events: unknown[] = [];
		connection.onExpiring?.((event) => {
			events.push(event);
		});

		jest.advanceTimersByTime(6_999);
		await flushPromises();
		expect(events).toHaveLength(0);
		jest.advanceTimersByTime(1);
		await flushPromises();
		expect(events).toEqual([
			{
				expiresAt: "2026-07-30T12:00:10.000Z",
				leadSeconds: 3,
				reason: "sticky_expiry",
			},
		]);
		jest.advanceTimersByTime(500);
		await flushPromises();
		expect(events).toHaveLength(1);
	});

	it("cuts off a slow drain handler and surfaces typed expiry at hard expiry", async () => {
		const connection = await createStickyConnection();
		let handlerStarted = false;
		connection.onExpiring?.(
			() =>
				new Promise<void>(() => {
					handlerStarted = true;
				}),
		);

		jest.advanceTimersByTime(7_000);
		await flushPromises();
		expect(handlerStarted).toBe(true);
		jest.advanceTimersByTime(3_000);
		await flushPromises();
		expect(connection.closeReason).toBeInstanceOf(NativeProxyExpiredError);
		await expect(connection.read()).rejects.toMatchObject({ code: "native_proxy_expired" });
	});

	it("warns and still force-closes when no handler is registered", async () => {
		const warnings: string[] = [];
		const connection = await createStickyConnection({ warn: (message) => warnings.push(message) });

		jest.advanceTimersByTime(7_000);
		await flushPromises();
		expect(warnings).toEqual(["Native sticky proxy is expiring without a drain handler"]);
		jest.advanceTimersByTime(3_000);
		await flushPromises();
		expect(connection.closeReason).toBeInstanceOf(NativeProxyExpiredError);
	});

	it("clears lifecycle timers when the connection closes early", async () => {
		const warnings: string[] = [];
		const connection = await createStickyConnection({ warn: (message) => warnings.push(message) });
		expect(jest.getTimerCount()).toBe(2);
		await connection.close();
		expect(jest.getTimerCount()).toBe(0);

		jest.advanceTimersByTime(20_000);
		await flushPromises();
		expect(warnings).toEqual([]);
		expect(connection.closeReason).toBeUndefined();
	});

	it("fires immediately when the lead exceeds remaining lifetime", async () => {
		const connection = await createStickyConnection({
			expiresInMs: 2_000,
			drainLeadSeconds: 5,
		});
		let calls = 0;
		connection.onExpiring?.(() => {
			calls += 1;
		});

		jest.advanceTimersByTime(0);
		await flushPromises();
		expect(calls).toBe(1);
	});
});
