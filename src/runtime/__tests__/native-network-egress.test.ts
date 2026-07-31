import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { type Server, type Socket, createServer } from "node:net";

import {
	NativeEgressGrantExpiredError,
	NativeEgressNotDeclaredError,
	NATIVE_EGRESS_EXPIRED_EVIDENCE_LIMIT,
	NativeNetworkError,
	createNativeNetworkClient,
} from "../native-network.js";

type Fixture = {
	host: string;
	port: number;
	server: Server;
	sockets: Set<Socket>;
	accepted: () => number;
};
const fixtures: Fixture[] = [];

function expectNativeCode(run: () => unknown, code: string): void {
	try {
		run();
		throw new Error(`Expected ${code}`);
	} catch (error) {
		expect(error).toBeInstanceOf(NativeNetworkError);
		expect(error).toMatchObject({ code });
	}
}

async function listen(): Promise<Fixture> {
	let accepted = 0;
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		accepted += 1;
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("data", (chunk) => socket.write(chunk));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture did not bind");
	const fixture = {
		host: "127.0.0.1",
		port: address.port,
		server,
		sockets,
		accepted: () => accepted,
	};
	server.on("close", () =>
		sockets.forEach((socket) => {
			socket.destroy();
		}),
	);
	fixtures.push(fixture);
	return fixture;
}

afterEach(async () => {
	setSystemTime();
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (!fixture) continue;
		for (const socket of fixture.sockets) socket.destroy();
		await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
	}
});

describe("native egress enforcement", () => {
	it("preserves legacy unrestricted connects only when egress is absent", async () => {
		const destination = await listen();
		const legacy = createNativeNetworkClient({ proxyPolicy: { mode: "disabled" } });
		const connection = await legacy.connectTcp(destination);
		expect(destination.accepted()).toBe(1);
		await connection.close();

		const denied = createNativeNetworkClient({
			proxyPolicy: { mode: "disabled" },
			egress: {},
		});
		await expect(denied.connectTcp(destination)).rejects.toBeInstanceOf(
			NativeEgressNotDeclaredError,
		);
		expect(destination.accepted()).toBe(1);
	});

	it("refuses an undeclared destination before proxy resolution or socket construction", async () => {
		const destination = await listen();
		let proxyResolutions = 0;
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [
				() => {
					proxyResolutions += 1;
					return undefined;
				},
			],
			egress: { tcp: [{ host: "elsewhere.example", ports: [443], tls: "required" }] },
		});

		await expect(client.connectTcp(destination)).rejects.toMatchObject({
			code: "native_egress_not_declared",
			host: destination.host,
			port: destination.port,
			tls: "disabled",
		});
		expect(proxyResolutions).toBe(0);
		expect(destination.accepted()).toBe(0);
	});

	it("enforces exact static host, port, and TLS mode", async () => {
		const destination = await listen();
		const base = { host: destination.host, ports: [destination.port] } as const;
		const tcp = createNativeNetworkClient({
			proxyPolicy: { mode: "disabled" },
			egress: { tcp: [{ ...base, tls: "disabled" }] },
		});
		const connection = await tcp.connectTcp(destination);
		await connection.close();
		await expect(tcp.connectTls(destination)).rejects.toMatchObject({
			code: "native_egress_not_declared",
			tls: "required",
		});

		const tlsOnly = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [() => undefined],
			egress: { tcp: [{ ...base, tls: "required" }] },
		});
		await expect(tlsOnly.connectTcp(destination)).rejects.toMatchObject({
			code: "native_egress_not_declared",
			tls: "disabled",
		});
		await expect(tlsOnly.connectTls(destination)).rejects.toMatchObject({ code: "PROXY_REQUIRED" });

		const either = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [() => undefined],
			egress: { tcp: [{ ...base, tls: "allowed" }] },
		});
		await expect(either.connectTcp(destination)).rejects.toMatchObject({ code: "PROXY_REQUIRED" });
		await expect(either.connectTls(destination)).rejects.toMatchObject({ code: "PROXY_REQUIRED" });
	});

	it("snapshots declarations so later mutation cannot widen authorization", async () => {
		const destination = await listen();
		const rule = { host: "original.example", ports: [443], tls: "disabled" as const };
		const client = createNativeNetworkClient({ egress: { tcp: [rule] } });
		rule.host = destination.host;
		rule.ports[0] = destination.port;

		await expect(client.connectTcp(destination)).rejects.toMatchObject({
			code: "native_egress_not_declared",
		});
		expect(destination.accepted()).toBe(0);
	});

	it("uses label-boundary DNS suffixes and never wildcard syntax", () => {
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHostSuffixes: ["example"],
						sourcePorts: [443],
						targetHostSuffixes: ["kakao.com"],
						targetPorts: [443],
						tls: "allowed",
					},
				],
			},
		});
		client
			.grantTcpEgress({
				sourceHost: "bootstrap.example",
				sourcePort: 443,
				host: "LoCo.KAKAO.COM.",
				port: 443,
				tls: "required",
			})
			.revoke();
		expect(() =>
			client.grantTcpEgress({
				sourceHost: "bootstrap.example",
				sourcePort: 443,
				host: "evilkakao.com",
				port: 443,
				tls: "required",
			}),
		).toThrow(NativeNetworkError);
		expectNativeCode(
			() =>
			createNativeNetworkClient({
				egress: {
					dynamicTcp: [
						{
							sourceHost: "bootstrap.example",
							sourcePorts: [443],
							targetHostSuffixes: ["*.kakao.com"],
							targetPorts: [443],
							tls: "disabled",
						},
					],
				},
			}),
			"native_egress_policy_invalid",
		);
	});

	it("enforces dynamic source suffix, source port, target range, and TLS selectors", async () => {
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [() => undefined],
			egress: {
				dynamicTcp: [
					{
						sourceHostSuffixes: ["bootstrap.example"],
						sourcePortRanges: [{ start: 400, end: 499 }],
						targetHostSuffixes: ["session.example"],
						targetPortRanges: [{ start: 5_000, end: 5_100 }],
						tls: "allowed",
					},
				],
			},
		});
		const baseline = {
			sourceHost: "api.bootstrap.example",
			sourcePort: 443,
			host: "node.session.example",
			port: 5_050,
			tls: "allowed" as const,
		};
		client.grantTcpEgress(baseline);
		await expect(client.connectTcp({ host: baseline.host, port: baseline.port })).rejects.toMatchObject({
			code: "PROXY_REQUIRED",
		});
		await expect(client.connectTls({ host: baseline.host, port: baseline.port })).rejects.toMatchObject({
			code: "PROXY_REQUIRED",
		});
		for (const input of [
			{ ...baseline, sourceHost: "evilbootstrap.example" },
			{ ...baseline, sourcePort: 399 },
			{ ...baseline, port: 5_101 },
		]) {
			expectNativeCode(() => client.grantTcpEgress(input), "native_egress_not_declared");
		}
		const tlsOnly = client.grantTcpEgress({ ...baseline, host: "tls.session.example", tls: "required" });
		await expect(
			client.connectTcp({ host: "tls.session.example", port: baseline.port }),
		).rejects.toMatchObject({ code: "native_egress_not_declared", tls: "disabled" });
		tlsOnly.revoke();
	});

	it("makes a dynamic grant live, then revoke removes authorization", async () => {
		const destination = await listen();
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "disabled" },
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["0.0.1"],
						targetPorts: [destination.port],
						tls: "disabled",
					},
				],
			},
		});
		const grant = client.grantTcpEgress({
			sourceHost: "bootstrap.example",
			sourcePort: 443,
			host: destination.host,
			port: destination.port,
			tls: "disabled",
		});
		const connection = await client.connectTcp(destination);
		await connection.close();
		expect(destination.accepted()).toBe(1);
		grant.revoke();
		grant.revoke();
		await expect(client.connectTcp(destination)).rejects.toMatchObject({
			code: "native_egress_not_declared",
		});
		expect(destination.accepted()).toBe(1);
	});

	it("revalidates a grant after proxy resolution yields and before direct socket issuance", async () => {
		const destination = await listen();
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "disabled" },
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["0.0.1"],
						targetPorts: [destination.port],
						tls: "disabled",
					},
				],
			},
		});
		const grant = client.grantTcpEgress({
			sourceHost: "bootstrap.example",
			sourcePort: 443,
			host: destination.host,
			port: destination.port,
			tls: "disabled",
		});
		const attempt = client.connectTcp(destination);
		grant.revoke();
		await expect(attempt).rejects.toMatchObject({ code: "native_egress_not_declared" });
		expect(destination.accepted()).toBe(0);
	});

	it("distinguishes an expired grant from a destination that was never granted", async () => {
		const destination = await listen();
		const startedAt = new Date("2026-07-31T00:00:00.000Z");
		setSystemTime(startedAt);
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["0.0.1"],
						targetPortRanges: [{ start: 1, end: 65_535 }],
						tls: "disabled",
						ttlMs: 50,
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
		setSystemTime(new Date(startedAt.getTime() + 50));

		const expired = client.connectTcp(destination);
		await expect(expired).rejects.toBeInstanceOf(NativeEgressGrantExpiredError);
		await expect(expired).rejects.toMatchObject({
			code: "native_egress_grant_expired",
			expiresAt: "2026-07-31T00:00:00.050Z",
		});
		await expect(
			client.connectTcp({ host: destination.host, port: destination.port - 1 }),
		).rejects.toMatchObject({ code: "native_egress_not_declared" });
		expect(destination.accepted()).toBe(0);
	});

	it("bounds expiry evidence and degrades evicted history to not declared", async () => {
		const startedAt = new Date("2026-07-31T00:00:00.000Z");
		setSystemTime(startedAt);
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["session.example"],
						targetPortRanges: [{ start: 1, end: 65_535 }],
						tls: "disabled",
						ttlMs: 1,
					},
				],
			},
		});
		for (let index = 0; index <= NATIVE_EGRESS_EXPIRED_EVIDENCE_LIMIT; index += 1) {
			client.grantTcpEgress({
				sourceHost: "bootstrap.example",
				sourcePort: 443,
				host: `node-${index}.session.example`,
				port: 5228,
				tls: "disabled",
			});
		}
		setSystemTime(new Date(startedAt.getTime() + 1));
		await expect(
			client.connectTcp({
				host: `node-${NATIVE_EGRESS_EXPIRED_EVIDENCE_LIMIT}.session.example`,
				port: 5228,
			}),
		).rejects.toMatchObject({ code: "native_egress_grant_expired" });
		await expect(
			client.connectTcp({ host: "node-0.session.example", port: 5228 }),
		).rejects.toMatchObject({ code: "native_egress_not_declared" });
	});

	it("binds overlapping grants to the first matching rule without TTL or quota spill", async () => {
		const destination = await listen();
		const startedAt = new Date("2026-07-31T00:00:00.000Z");
		setSystemTime(startedAt);
		const selector = {
			sourceHost: "bootstrap.example",
			sourcePorts: [443],
			targetHostSuffixes: ["0.0.1"],
			targetPorts: [destination.port],
			tls: "disabled" as const,
		};
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{ ...selector, ttlMs: 10, maxGrants: 1 },
					{ ...selector, ttlMs: 1_000, maxGrants: 10 },
				],
			},
		});
		const input = {
			sourceHost: "bootstrap.example",
			sourcePort: 443,
			host: destination.host,
			port: destination.port,
			tls: "disabled" as const,
		};
		const first = client.grantTcpEgress(input);
		expectNativeCode(() => client.grantTcpEgress(input), "native_egress_grant_limit_exceeded");
		first.revoke();
		expectNativeCode(
			() => client.grantTcpEgress({ ...input, ttlMs: 100 }),
			"native_egress_grant_invalid",
		);
		client.grantTcpEgress(input);
		setSystemTime(new Date(startedAt.getTime() + 10));
		await expect(client.connectTcp(destination)).rejects.toMatchObject({
			code: "native_egress_grant_expired",
		});
	});

	it("composes the deployment authorizer and both revoke paths", async () => {
		const destination = await listen();
		let grants = 0;
		let revokes = 0;
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["0.0.1"],
						targetPorts: [destination.port],
						tls: "disabled",
					},
				],
			},
			grantTcpEgress: () => {
				grants += 1;
				return {
					revoke: () => {
						revokes += 1;
					},
				};
			},
		});
		const grant = client.grantTcpEgress({
			sourceHost: "bootstrap.example",
			sourcePort: 443,
			host: destination.host,
			port: destination.port,
			tls: "disabled",
		});
		expect(grants).toBe(1);
		grant.revoke();
		grant.revoke();
		expect(revokes).toBe(1);
		await expect(client.connectTcp(destination)).rejects.toMatchObject({
			code: "native_egress_not_declared",
		});
	});

	it("rolls back local authorization when the deployment delegate fails", async () => {
		const declaration = {
			dynamicTcp: [
				{
					sourceHost: "bootstrap.example",
					sourcePorts: [443],
					targetHostSuffixes: ["session.example"],
					targetPorts: [5228],
					tls: "disabled" as const,
				},
			],
		};
		const input = {
			sourceHost: "bootstrap.example",
			sourcePort: 443,
			host: "node.session.example",
			port: 5228,
			tls: "disabled" as const,
		};
		for (const grantTcpEgress of [
			() => {
				throw new Error("delegate failed");
			},
			() => ({}) as never,
		]) {
			const client = createNativeNetworkClient({ egress: declaration, grantTcpEgress });
			expectNativeCode(
				() => client.grantTcpEgress(input),
				"native_egress_authorization_failed",
			);
			await expect(client.connectTcp({ host: input.host, port: input.port })).rejects.toMatchObject({
				code: "native_egress_not_declared",
			});
		}
	});

	it("rejects unsafe inputs and policies with typed errors", async () => {
		expectNativeCode(
			() => createNativeNetworkClient({ egress: { surprise: true } as never }),
			"native_egress_policy_invalid",
		);
		expectNativeCode(
			() =>
				createNativeNetworkClient({
					egress: Object.defineProperty({}, "tcp", {
						get: () => [],
					}) as never,
				}),
			"native_egress_policy_invalid",
		);
		const client = createNativeNetworkClient({ egress: {} });
		await expect(client.connectTcp({ host: "bad\0.example", port: 443 })).rejects.toMatchObject({
			code: "native_egress_input_invalid",
		});
		await expect(
			client.connectTcp(
				Object.defineProperty({}, "host", {
					get: () => {
						throw new Error("boom");
					},
				}) as never,
			),
		).rejects.toMatchObject({ code: "native_egress_input_invalid" });
		expectNativeCode(
			() =>
				client.grantTcpEgress(
					Object.defineProperty({}, "sourceHost", {
						get: () => {
							throw new Error("boom");
						},
					}) as never,
				),
			"native_egress_input_invalid",
		);
	});
});
