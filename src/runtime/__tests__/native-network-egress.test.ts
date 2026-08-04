import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";

import {
	classifyEgressTargetHost,
	ipv4InCidr,
	parseIpv4Cidr,
	parseStrictIpv4,
} from "../../native-ipv4.js";
import { parseNativeEgressPolicy } from "../../native-egress-policy.js";
import {
	createNativeNetworkClient,
	NATIVE_EGRESS_EXPIRED_EVIDENCE_LIMIT,
	NativeEgressGrantExpiredError,
	NativeEgressNotDeclaredError,
	NativeNetworkError,
	snapshotNativeConnectInput,
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

function captureNativeError(run: () => unknown): NativeNetworkError {
	try {
		run();
		throw new Error("Expected NativeNetworkError");
	} catch (error) {
		expect(error).toBeInstanceOf(NativeNetworkError);
		return error as NativeNetworkError;
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

describe("native IPv4 authorization parsing", () => {
	it("classifies canonical IPv4, resolver-numeric forms, and DNS names", () => {
		const cases = [
			["0.0.0.0", "ipv4"],
			["255.255.255.255", "ipv4"],
			["211.183.211.10", "ipv4"],
			["0211.183.211.10", "numeric-ambiguous"],
			["0177.0.0.1", "numeric-ambiguous"],
			["011.183.208.5", "numeric-ambiguous"],
			["1.2.3.04", "numeric-ambiguous"],
			["127.1", "numeric-ambiguous"],
			["10.0.1", "numeric-ambiguous"],
			["1.2.3.4.5", "numeric-ambiguous"],
			["2130706433", "numeric-ambiguous"],
			["0x7f.0.0.1", "numeric-ambiguous"],
			["0X7f.0.0.1", "numeric-ambiguous"],
			["::1", "numeric-ambiguous"],
			["[::1]", "numeric-ambiguous"],
			["loco.kakao.com", "dns"],
			["0211.example.com", "dns"],
		] as const;
		for (const [host, expected] of cases) expect(classifyEgressTargetHost(host)).toBe(expected);
	});

	it("parses and matches only canonical IPv4 and CIDR spellings", () => {
		expect(parseStrictIpv4("0.0.0.0")).toBe(0);
		expect(parseStrictIpv4("255.255.255.255")).toBe(0xffffffff);
		expect(parseStrictIpv4("1.2.3.04")).toBeUndefined();
		expect(parseIpv4Cidr("211.183.208.0/20")).toEqual({
			ok: true,
			network: 0xd3b7d000,
			prefix: 20,
		});
		expect(parseIpv4Cidr("211.183.211.10/20")).toEqual({
			ok: false,
			reason: "non-canonical-network",
		});
		expect(parseIpv4Cidr("211.183.208.0/020")).toEqual({
			ok: false,
			reason: "malformed",
		});
		const inside = parseStrictIpv4("211.183.211.10");
		const outside = parseStrictIpv4("211.183.192.1");
		expect(inside).toBeDefined();
		expect(outside).toBeDefined();
		expect(ipv4InCidr(inside as number, "211.183.208.0/20")).toBeTrue();
		expect(ipv4InCidr(outside as number, "211.183.208.0/20")).toBeFalse();
		expect(ipv4InCidr(0xffffffff, "0.0.0.0/0")).toBeTrue();
	});
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

	it("rejects reserved delimiters before grant or connect host canonicalization", async () => {
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["kakao.com"],
						targetPorts: [5223],
						tls: "disabled",
					},
				],
			},
		});
		const hosts = [
			"kakao.com\\@127.0.0.1",
			"kakao.com/@127.0.0.1",
			"kakao.com#@127.0.0.1",
			"kakao.com?@127.0.0.1",
			"kakao.com/../evil.com",
			"allowed.com@169.254.169.254",
			"kakao.com:8080@evil.com",
			"kakao.com[evil]",
			"kakao.com]evil",
			"kakao.com ",
			"%31%32%37.0.0.1",
			"%31%32%37%2e0%2e0%2e1",
			"%6b%61%6b%61%6f.com",
			"%41.kakao.com",
		];
		for (const host of hosts) {
			expectNativeCode(
				() =>
					client.grantTcpEgress({
						sourceHost: "bootstrap.example",
						sourcePort: 443,
						host,
						port: 5223,
						tls: "disabled",
					}),
				"native_egress_grant_invalid",
			);
			expectNativeCode(
				() =>
					client.grantTcpEgress({
						sourceHost: host,
						sourcePort: 443,
						host: "kakao.com",
						port: 5223,
						tls: "disabled",
					}),
				"native_egress_grant_invalid",
			);
			await expect(client.connectTcp({ host, port: 5223 })).rejects.toMatchObject({
				code: "native_egress_input_invalid",
			});
		}
	});

	it("authorizes ASCII and IDNA-mapped trailing root dots identically", () => {
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["kakao.com"],
						targetPorts: [5223],
						tls: "disabled",
					},
				],
			},
		});
		for (const host of ["node.kakao.com", "node.kakao.com.", "node.kakao.com。"]) {
			client
				.grantTcpEgress({
					sourceHost: "bootstrap.example",
					sourcePort: 443,
					host,
					port: 5223,
					tls: "disabled",
				})
				.revoke();
		}

		const declared = parseNativeEgressPolicy({
			dynamicTcp: [
				{
					sourceHost: "bootstrap.example。",
					sourceHostSuffixes: ["example。"],
					sourcePorts: [443],
					targetHostSuffixes: ["kakao.com。"],
					targetPorts: [5223],
					tls: "disabled",
				},
			],
		});
		expect(declared.dynamicRules[0]).toMatchObject({
			sourceHost: "bootstrap.example",
			sourceHostSuffixes: ["example"],
			targetHostSuffixes: ["kakao.com"],
		});
	});

	it("rejects bidi and format controls in every runtime host field without echoing them", async () => {
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["kakao.com"],
						targetPorts: [5223],
						tls: "disabled",
					},
				],
			},
		});
		for (const rawHost of ["::\u202eevil", "node\u200ekakao.com", "\uFEFFnode.kakao.com"]) {
			for (const input of [
				{
					sourceHost: "bootstrap.example",
					sourcePort: 443,
					host: rawHost,
					port: 5223,
					tls: "disabled" as const,
				},
				{
					sourceHost: rawHost,
					sourcePort: 443,
					host: "node.kakao.com",
					port: 5223,
					tls: "disabled" as const,
				},
			]) {
				const error = captureNativeError(() => client.grantTcpEgress(input));
				expect(error.code).toBe("native_egress_grant_invalid");
				expect(error.message).not.toContain(rawHost);
			}
			const connectError = await client
				.connectTcp({ host: rawHost, port: 5223 })
				.catch((error: unknown) => error);
			expect(connectError).toBeInstanceOf(NativeNetworkError);
			expect(connectError).toMatchObject({ code: "native_egress_input_invalid" });
			expect((connectError as Error).message).not.toContain(rawHost);

			const policyError = captureNativeError(() =>
				createNativeNetworkClient({
					egress: { tcp: [{ host: rawHost, ports: [443], tls: "disabled" }] },
				}),
			);
			expect(policyError.code).toBe("native_egress_policy_invalid");
			expect(policyError.message).not.toContain(rawHost);
		}
	});

	it("canonicalizes Unicode resolver spellings before suffix classification and grant storage", async () => {
		const client = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [() => undefined],
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["0.0.1", "kakao.com"],
						targetPorts: [5223],
						tls: "disabled",
					},
				],
			},
		});
		for (const host of ["０177.0.0.1", "１２７.0.0.1", "２１３０７０６４３３", "127．0．0．1"]) {
			try {
				client.grantTcpEgress({
					sourceHost: "bootstrap.example",
					sourcePort: 443,
					host,
					port: 5223,
					tls: "disabled",
				});
				throw new Error(`Expected ${host} to be denied`);
			} catch (error) {
				expect(error).toMatchObject({ code: "native_egress_not_declared" });
				expect((error as Error).message).toMatch(/target kind: (?:ipv4|numeric-ambiguous)/);
			}
		}

		client.grantTcpEgress({
			sourceHost: "bootstrap.example",
			sourcePort: 443,
			host: "evil。kakao.com",
			port: 5223,
			tls: "disabled",
		});
		await expect(client.connectTcp({ host: "evil.kakao.com", port: 5223 })).rejects.toMatchObject({
			code: "PROXY_REQUIRED",
		});
	});

	it("never stores a suffix grant for a Unicode numeric spelling", async () => {
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
		expectNativeCode(
			() =>
				client.grantTcpEgress({
					sourceHost: "bootstrap.example",
					sourcePort: 443,
					host: "０177.0.0.1",
					port: destination.port,
					tls: "disabled",
				}),
			"native_egress_not_declared",
		);
		await expect(client.connectTcp(destination)).rejects.toMatchObject({
			code: "native_egress_not_declared",
		});
		expect(destination.accepted()).toBe(0);
	});

	it("rejects unprocessable Unicode and IPv6 grant hosts with stable codes", () => {
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["0.0.1"],
						targetPorts: [5223],
						tls: "disabled",
					},
				],
			},
		});
		const grant = (host: string) =>
			client.grantTcpEgress({
				sourceHost: "bootstrap.example",
				sourcePort: 443,
				host,
				port: 5223,
				tls: "disabled",
			});
		expectNativeCode(() => grant("١٢٧.0.0.1"), "native_egress_grant_invalid");
		expectNativeCode(() => grant("::1"), "native_egress_not_declared");
		expectNativeCode(() => grant("[::1]"), "native_egress_grant_invalid");
	});

	it("round-trips IDN grants across Unicode and punycode spellings", async () => {
		const staticClient = createNativeNetworkClient({
			proxyPolicy: { mode: "required", providers: ["nodemaven"] },
			gatewaySynthesizers: [() => undefined],
			egress: { tcp: [{ host: "한글.kr", ports: [5223], tls: "disabled" }] },
		});
		await expect(
			staticClient.connectTcp({ host: "xn--bj0bj06e.kr", port: 5223 }),
		).rejects.toMatchObject({ code: "PROXY_REQUIRED" });

		const makeClient = (suffix: string) =>
			createNativeNetworkClient({
				proxyPolicy: { mode: "required", providers: ["nodemaven"] },
				gatewaySynthesizers: [() => undefined],
				egress: {
					dynamicTcp: [
						{
							sourceHost: "bootstrap.example",
							sourcePorts: [443],
							targetHostSuffixes: [suffix],
							targetPorts: [5223],
							tls: "disabled",
						},
					],
				},
			});
		const cases = [
			["xn--bj0bj06e.kr", "한글.kr"],
			["한글.kr", "xn--bj0bj06e.kr"],
		] as const;
		for (const [declaredSuffix, grantedHost] of cases) {
			const client = makeClient(declaredSuffix);
			client.grantTcpEgress({
				sourceHost: "bootstrap.example",
				sourcePort: 443,
				host: grantedHost,
				port: 5223,
				tls: "disabled",
			});
			await expect(
				client.connectTcp({ host: "xn--bj0bj06e.kr", port: 5223 }),
			).rejects.toMatchObject({ code: "PROXY_REQUIRED" });
		}
	});

	it("rejects declared and runtime hosts that canonicalize to empty", async () => {
		for (const emptyHost of ["١٢٧.0.0.1", ".", "...", "。。"]) {
			for (const egress of [
				{ tcp: [{ host: emptyHost, ports: [443], tls: "disabled" as const }] },
				{
					dynamicTcp: [
						{
							sourceHost: "bootstrap.example",
							sourcePorts: [443],
							targetHostSuffixes: [emptyHost],
							targetPorts: [5223],
							tls: "disabled" as const,
						},
					],
				},
			]) {
				expectNativeCode(
					() => createNativeNetworkClient({ egress }),
					"native_egress_policy_invalid",
				);
			}
			const client = createNativeNetworkClient({ egress: {} });
			expectNativeCode(
				() =>
					client.grantTcpEgress({
						sourceHost: "bootstrap.example",
						sourcePort: 443,
						host: emptyHost,
						port: 5223,
						tls: "disabled",
					}),
				"native_egress_grant_invalid",
			);
			await expect(client.connectTcp({ host: emptyHost, port: 5223 })).rejects.toMatchObject({
				code: "native_egress_input_invalid",
			});
		}
	});

	it("rejects reserved delimiters in every declared host selector", () => {
		const baseDynamic = {
			sourceHost: "bootstrap.example",
			sourcePorts: [443],
			targetHostSuffixes: ["kakao.com"],
			targetPorts: [5223],
			tls: "disabled" as const,
		};
		for (const delimiterHost of [
			"allowed.com/path",
			"allowed.com\\path",
			"allowed.com?query",
			"allowed.com#fragment",
			"allowed.com@127.0.0.1",
			"allowed.com[part",
			"allowed.com]part",
			"allowed.com ",
			"%31%32%37.0.0.1",
			"%31%32%37%2e0%2e0%2e1",
			"%6b%61%6b%61%6f.com",
			"%41.kakao.com",
		]) {
			for (const egress of [
				{ tcp: [{ host: delimiterHost, ports: [443], tls: "disabled" as const }] },
				{ dynamicTcp: [{ ...baseDynamic, sourceHost: delimiterHost }] },
				{
					dynamicTcp: [
						{ ...baseDynamic, sourceHost: undefined, sourceHostSuffixes: [delimiterHost] },
					],
				},
				{ dynamicTcp: [{ ...baseDynamic, targetHostSuffixes: [delimiterHost] }] },
			]) {
				expectNativeCode(
					() => createNativeNetworkClient({ egress }),
					"native_egress_policy_invalid",
				);
			}
		}
	});

	it("uses one canonicalization table for declarations and runtime inputs", () => {
		const cases = [
			["loco.kakao.com", "loco.kakao.com"],
			["LOCO.Kakao.COM", "loco.kakao.com"],
			["node.kakao.com.", "node.kakao.com"],
			["node.kakao.com。", "node.kakao.com"],
			["node.kakao.com..", "node.kakao.com."],
			["evil。kakao.com", "evil.kakao.com"],
			["0211.example.com", "0211.example.com"],
			["211.183.211.10", "211.183.211.10"],
			["0.0.0.0", "0.0.0.0"],
			["255.255.255.255", "255.255.255.255"],
			["０177.0.0.1", "0177.0.0.1"],
			["１２７.0.0.1", "127.0.0.1"],
			["２１３０７０６４３３", "2130706433"],
			["127．0．0．1", "127.0.0.1"],
			["0177.0.0.1", "0177.0.0.1"],
			["127.1", "127.1"],
			["2130706433", "2130706433"],
			["0x7f.0.0.1", "0x7f.0.0.1"],
			["1.2.3.04", "1.2.3.04"],
			["011.183.208.5", "011.183.208.5"],
			["::1", "::1"],
			["한글.kr", "xn--bj0bj06e.kr"],
			["xn--bj0bj06e.kr", "xn--bj0bj06e.kr"],
		] as const;
		for (const [spelling, expected] of cases) {
			const declared = parseNativeEgressPolicy({
				tcp: [{ host: spelling, ports: [443], tls: "disabled" }],
			});
			const runtime = snapshotNativeConnectInput({ host: spelling, port: 443 });
			expect(declared.staticRules[0]?.host).toBe(expected);
			expect(runtime.host).toBe(expected);
		}

		for (const spelling of [
			"%31%32%37.0.0.1",
			"%31%32%37%2e0%2e0%2e1",
			"%6b%61%6b%61%6f.com",
			"%41.kakao.com",
			"::\u202eevil",
			"node\u200ekakao.com",
			"\uFEFFnode.kakao.com",
			"...",
			"[::1]",
			"kakao.com\\@127.0.0.1",
		]) {
			expect(() =>
				parseNativeEgressPolicy({
					tcp: [{ host: spelling, ports: [443], tls: "disabled" }],
				}),
			).toThrow();
			expectNativeCode(
				() => snapshotNativeConnectInput({ host: spelling, port: 443 }),
				"native_egress_input_invalid",
			);
		}
	});

	it("rejects malformed, non-canonical, and duplicate IPv4 CIDRs with distinct messages", () => {
		const rule = {
			sourceHost: "bootstrap.example",
			sourcePorts: [443],
			targetPorts: [5223],
			tls: "disabled" as const,
		};
		for (const cidr of [
			"211.183.211.10",
			"211.183.208.0/",
			"211.183.208.0/+20",
			"211.183.208.0 /20",
			"211.183.208.0/ 20",
			"211.183.208.0/20 ",
			"211.183.208.0/33",
			"256.183.208.0/20",
			"011.183.208.0/20",
			"211.183.208.0/07",
		]) {
			try {
				createNativeNetworkClient({
					egress: { dynamicTcp: [{ ...rule, targetIpv4Cidrs: [cidr] }] },
				});
				throw new Error(`Expected ${cidr} to be rejected`);
			} catch (error) {
				expect(error).toBeInstanceOf(NativeNetworkError);
				expect(error).toMatchObject({ code: "native_egress_policy_invalid" });
				expect((error as Error).message).toContain("must be an IPv4 CIDR in a.b.c.d/nn form");
			}
		}
		for (const [targetIpv4Cidrs, message] of [
			[["121.53.93.47/20"], "must use the canonical network address with no host bits set"],
			[["211.183.208.0/20", "211.183.208.0/20"], "must not contain duplicate CIDRs"],
		] as const) {
			try {
				createNativeNetworkClient({
					egress: {
						dynamicTcp: [{ ...rule, targetIpv4Cidrs: [...targetIpv4Cidrs] }],
					},
				});
				throw new Error(`Expected ${targetIpv4Cidrs.join(",")} to be rejected`);
			} catch (error) {
				expect(error).toBeInstanceOf(NativeNetworkError);
				expect(error).toMatchObject({ code: "native_egress_policy_invalid" });
				expect((error as Error).message).toContain(message);
			}
		}
		expectNativeCode(
			() =>
				createNativeNetworkClient({
					egress: {
						dynamicTcp: [{ ...rule, targetIpv4Cidrs: [211_183_208_000] }],
					} as never,
				}),
			"native_egress_policy_invalid",
		);
	});

	it("uses the same accepted CIDR spelling in policy validation and runtime matching", () => {
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetIpv4Cidrs: ["211.183.208.0/20"],
						targetPorts: [5223],
						tls: "disabled",
					},
				],
			},
		});
		client
			.grantTcpEgress({
				sourceHost: "bootstrap.example",
				sourcePort: 443,
				host: "211.183.211.10",
				port: 5223,
				tls: "disabled",
			})
			.revoke();
	});

	it("accepts CIDR-only rules and rejects rules without a target selector", () => {
		const rule = {
			sourceHost: "bootstrap.example",
			sourcePorts: [443],
			targetPorts: [5223],
			tls: "disabled" as const,
		};
		expect(() =>
			createNativeNetworkClient({
				egress: { dynamicTcp: [{ ...rule, targetIpv4Cidrs: ["211.183.208.0/20"] }] },
			}),
		).not.toThrow();

		for (const targetSelectors of [{}, { targetHostSuffixes: [], targetIpv4Cidrs: [] }]) {
			try {
				createNativeNetworkClient({
					egress: { dynamicTcp: [{ ...rule, ...targetSelectors }] },
				});
				throw new Error("Expected missing target selectors to be rejected");
			} catch (error) {
				expect(error).toMatchObject({ code: "native_egress_policy_invalid" });
				expect((error as Error).message).toContain(
					"native.network.dynamicTcp[0] must declare a non-empty targetHostSuffixes or targetIpv4Cidrs list",
				);
			}
		}
	});

	it("keeps IPv4 CIDR and DNS suffix target selectors disjoint", () => {
		const source = {
			sourceHost: "bootstrap.example",
			sourcePorts: [443],
			targetPortRanges: [{ start: 5_200, end: 5_299 }],
			tls: "disabled" as const,
		};
		const grant = {
			sourceHost: "bootstrap.example",
			sourcePort: 443,
			port: 5223,
			tls: "disabled" as const,
		};
		const cidrOnly = createNativeNetworkClient({
			egress: {
				dynamicTcp: [{ ...source, targetIpv4Cidrs: ["211.183.208.0/20"] }],
			},
		});
		cidrOnly.grantTcpEgress({ ...grant, host: "211.183.211.10" }).revoke();
		expectNativeCode(
			() => cidrOnly.grantTcpEgress({ ...grant, host: "211.183.192.1" }),
			"native_egress_not_declared",
		);
		expectNativeCode(
			() => cidrOnly.grantTcpEgress({ ...grant, host: "evil.example.com" }),
			"native_egress_not_declared",
		);

		const suffixOnly = createNativeNetworkClient({
			egress: {
				dynamicTcp: [{ ...source, targetHostSuffixes: ["183.211.10"] }],
			},
		});
		expectNativeCode(
			() => suffixOnly.grantTcpEgress({ ...grant, host: "211.183.211.10" }),
			"native_egress_not_declared",
		);

		const anyIpv4 = createNativeNetworkClient({
			egress: {
				dynamicTcp: [{ ...source, targetIpv4Cidrs: ["0.0.0.0/0"] }],
			},
		});
		anyIpv4.grantTcpEgress({ ...grant, host: "203.0.113.7" }).revoke();
		// Resolver-numeric forms are not IPv4 to this matcher and must not be
		// widened into the all-IPv4 CIDR by resolver canonicalization.
		for (const host of [
			"0211.183.211.10",
			"0177.0.0.1",
			"011.183.208.5",
			"1.2.3.04",
			"127.1",
			"10.0.1",
			"1.2.3.4.5",
			"2130706433",
			"0x7f.0.0.1",
			"0X7f.0.0.1",
			"::1",
			"[::1]",
		]) {
			expectNativeCode(
				() => anyIpv4.grantTcpEgress({ ...grant, host }),
				host === "[::1]" ? "native_egress_grant_invalid" : "native_egress_not_declared",
			);
		}
	});

	it("rejects the exact leading-zero bypass when a rule has both target selector classes", () => {
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["183.211.10"],
						targetIpv4Cidrs: ["211.183.208.0/20"],
						targetPorts: [5223],
						tls: "disabled",
					},
				],
			},
		});
		const grant = {
			sourceHost: "bootstrap.example",
			sourcePort: 443,
			port: 5223,
			tls: "disabled" as const,
		};
		client.grantTcpEgress({ ...grant, host: "211.183.211.10" }).revoke();
		expectNativeCode(
			() => client.grantTcpEgress({ ...grant, host: "0211.183.211.10" }),
			"native_egress_not_declared",
		);
	});

	it("rejects every resolver-numeric target under a suffix-only rule", () => {
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["0.0.1"],
						targetPorts: [5223],
						tls: "disabled",
					},
				],
			},
		});
		for (const host of [
			"0211.183.211.10",
			"0177.0.0.1",
			"011.0.0.1",
			"011.183.208.5",
			"1.2.3.04",
			"127.1",
			"2130706433",
			"0x7f.0.0.1",
			"::1",
			"[::1]",
		]) {
			expectNativeCode(
				() =>
					client.grantTcpEgress({
						sourceHost: "bootstrap.example",
						sourcePort: 443,
						host,
						port: 5223,
						tls: "disabled",
					}),
				host === "[::1]" ? "native_egress_grant_invalid" : "native_egress_not_declared",
			);
		}
	});

	it("continues matching legitimate DNS names, including numeric-leading labels", () => {
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["kakao.com", "example.com"],
						targetPorts: [5223],
						tls: "disabled",
					},
				],
			},
		});
		for (const host of ["loco.kakao.com", "LOCO.Kakao.COM", "0211.example.com"]) {
			client
				.grantTcpEgress({
					sourceHost: "bootstrap.example",
					sourcePort: 443,
					host,
					port: 5223,
					tls: "disabled",
				})
				.revoke();
		}
	});

	it("diagnoses source-selector and target-selector grant denials", () => {
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["session.example"],
						targetPorts: [5223],
						tls: "disabled",
					},
				],
			},
		});
		for (const [sourceHost, sourcePort, host, details, absentDimension] of [
			[
				"wrong.example",
				443,
				"node.session.example",
				["target kind: dns", "source-matching rule indices: []", "rule 0: source-host"],
				"source-port",
			],
			[
				"bootstrap.example",
				444,
				"node.session.example",
				["target kind: dns", "source-matching rule indices: []", "rule 0: source-port"],
				"source-host",
			],
			[
				"bootstrap.example",
				443,
				"0177.0.0.1",
				[
					"target kind: numeric-ambiguous",
					"source-matching rule indices: [0]",
					"failed selector dimensions by rule: rule 0: target-host",
				],
				"source-host",
			],
		] as const) {
			try {
				client.grantTcpEgress({
					sourceHost,
					sourcePort,
					host,
					port: 5223,
					tls: "disabled",
				});
				throw new Error("Expected grant to be denied");
			} catch (error) {
				expect(error).toBeInstanceOf(NativeNetworkError);
				expect(error).toMatchObject({ code: "native_egress_not_declared" });
				const message = (error as Error).message;
				expect(message).toContain(`source ${sourceHost}:${sourcePort}`);
				for (const detail of details) expect((error as Error).message).toContain(detail);
				expect(message).not.toContain(`rule 0: ${absentDimension}`);
			}
		}
	});

	it("canonicalizes Unicode hosts before including them in denial diagnostics", async () => {
		const rawHost = "차단.example";
		const client = createNativeNetworkClient({ egress: {} });
		const error = await client
			.connectTcp({ host: rawHost, port: 443 })
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(NativeEgressNotDeclaredError);
		expect((error as Error).message).not.toContain(rawHost);
		expect((error as Error).message).toContain("xn--6j1bv29b.example:443");
	});

	it("reports target selector failures along each source-matching rule path", () => {
		const sourceAndTarget = {
			sourceHost: "bootstrap.example",
			sourcePorts: [443],
			targetHostSuffixes: ["session.example"],
		};
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{ ...sourceAndTarget, targetPorts: [5224], tls: "disabled" },
					{ ...sourceAndTarget, targetPorts: [5223], tls: "required" },
				],
			},
		});
		try {
			client.grantTcpEgress({
				sourceHost: "bootstrap.example",
				sourcePort: 443,
				host: "node.session.example",
				port: 5223,
				tls: "disabled",
			});
			throw new Error("Expected overlapping rules to deny the grant");
		} catch (error) {
			expect(error).toMatchObject({ code: "native_egress_not_declared" });
			const message = (error as Error).message;
			expect(message).toContain("source-matching rule indices: [0, 1]");
			expect(message).toContain(
				"failed selector dimensions by rule: rule 0: target-port; rule 1: tls",
			);
			expect(message).not.toContain("rule 0: tls");
			expect(message).not.toContain("rule 1: target-port");
			expect(message).not.toContain("5224");
			expect(message).not.toContain("required");
		}
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
		await expect(
			client.connectTcp({ host: baseline.host, port: baseline.port }),
		).rejects.toMatchObject({
			code: "PROXY_REQUIRED",
		});
		await expect(
			client.connectTls({ host: baseline.host, port: baseline.port }),
		).rejects.toMatchObject({
			code: "PROXY_REQUIRED",
		});
		for (const input of [
			{ ...baseline, sourceHost: "evilbootstrap.example" },
			{ ...baseline, sourcePort: 399 },
			{ ...baseline, port: 5_101 },
		]) {
			expectNativeCode(() => client.grantTcpEgress(input), "native_egress_not_declared");
		}
		const tlsOnly = client.grantTcpEgress({
			...baseline,
			host: "tls.session.example",
			tls: "required",
		});
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
						targetIpv4Cidrs: ["127.0.0.1/32"],
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
						targetIpv4Cidrs: ["127.0.0.1/32"],
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

	it("allows a CIDR-matched grant before expiry and denies it after expiry", async () => {
		const destination = await listen();
		const startedAt = new Date("2026-07-31T00:00:00.000Z");
		setSystemTime(startedAt);
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetIpv4Cidrs: ["127.0.0.1/32"],
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
		const connection = await client.connectTcp(destination);
		await connection.close();
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
		expect(destination.accepted()).toBe(1);
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

	it("binds CIDR-matched grants to the first rule without TTL or quota spill", async () => {
		const destination = await listen();
		const startedAt = new Date("2026-07-31T00:00:00.000Z");
		setSystemTime(startedAt);
		const selector = {
			sourceHost: "bootstrap.example",
			sourcePorts: [443],
			targetIpv4Cidrs: ["127.0.0.1/32"],
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
						targetIpv4Cidrs: ["127.0.0.1/32"],
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

	it("passes canonical source and target hosts to the deployment grant delegate", () => {
		let delegatedInput: unknown;
		const client = createNativeNetworkClient({
			egress: {
				dynamicTcp: [
					{
						sourceHost: "bootstrap.example",
						sourcePorts: [443],
						targetHostSuffixes: ["kakao.com"],
						targetPorts: [5223],
						tls: "disabled",
					},
				],
			},
			grantTcpEgress: (input) => {
				delegatedInput = input;
				return { revoke() {} };
			},
		});

		client.grantTcpEgress({
			sourceHost: "BOOTSTRAP.EXAMPLE。",
			sourcePort: 443,
			host: "Node.KAKAO.COM。",
			port: 5223,
			tls: "disabled",
		});
		expect(delegatedInput).toMatchObject({
			sourceHost: "bootstrap.example",
			host: "node.kakao.com",
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
			expectNativeCode(() => client.grantTcpEgress(input), "native_egress_authorization_failed");
			await expect(client.connectTcp({ host: input.host, port: input.port })).rejects.toMatchObject(
				{
					code: "native_egress_not_declared",
				},
			);
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

	it("reports safe field-specific native connect input rejection reasons", () => {
		const cases = [
			[{ host: "%41.kakao.com", port: 443 }, "host", "reserved-delimiter"],
			[{ host: "node\u200ekakao.com", port: 443 }, "host", "control-character"],
			[{ host: "...", port: 443 }, "host", "canonicalization-empty"],
			[{ host: "kakao.com", port: 0 }, "port", "port-range"],
		] as const;
		for (const [input, field, reason] of cases) {
			const error = captureNativeError(() => snapshotNativeConnectInput(input));
			expect(error.code).toBe("native_egress_input_invalid");
			expect(error.message).toContain(`field=${field}`);
			expect(error.message).toContain(`reason=${reason}`);
			expect(error.message).not.toContain(input.host);
		}

		for (const field of ["host", "port"] as const) {
			const input = Object.defineProperty({ host: "kakao.com", port: 443 }, field, {
				get: () => {
					throw new Error("raw getter failure");
				},
			}) as never;
			const error = captureNativeError(() => snapshotNativeConnectInput(input));
			expect(error.code).toBe("native_egress_input_invalid");
			expect(error.message).toContain(`field=${field}`);
			expect(error.message).toContain("reason=inspection-failure");
			expect(error.message).not.toContain("raw getter failure");
		}
	});
});
