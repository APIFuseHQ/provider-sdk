import net from "node:net";
import { describe, expect, it } from "bun:test";

import { ContextAccessError, CredentialModeError } from "../errors";
import { createFlowContext, createScratchpad } from "../runtime/auth-flow";
import { createCredentialContext } from "../runtime/credential";
import { createEnvContext } from "../runtime/env";
import { createNativeNetworkClient } from "../runtime/native-network";
import type { HttpClient, NativeContext, StealthClient } from "../types";

const stealthStub: StealthClient = {
	fetch: async () => {
		throw new Error("stealth unsupported in runtime context test client");
	},
	createSession: () => {
		throw new Error("stealth session unsupported in runtime context test client");
	},
};

describe("runtime contexts", () => {
	it("createEnvContext respects the allowlist", () => {
		process.env.TEST_ALLOWED_ENV = "allowed";
		process.env.TEST_BLOCKED_ENV = "blocked";

		const env = createEnvContext(["TEST_ALLOWED_ENV"]);

		expect(env.get("TEST_ALLOWED_ENV")).toBe("allowed");
		expect(env.get("TEST_BLOCKED_ENV")).toBeUndefined();
	});

	it("createCredentialContext enforces declared keys and oauth helpers", () => {
		const credential = createCredentialContext({
			allowedKeys: ["access_token", "refresh_token"],
			mode: "oauth2",
			values: {
				access_token: "token-123",
				refresh_token: "refresh-456",
				scope: "read write",
				cookie: "sid=secret",
			},
		});

		expect(credential.get("access_token")).toBe("token-123");
		expect(credential.get("cookie")).toBeUndefined();
		expect(credential.getAll()).toEqual({
			access_token: "token-123",
			refresh_token: "refresh-456",
		});
		expect(credential.getAccessToken()).toBe("token-123");
		expect(credential.getScopes()).toEqual(["read", "write"]);
	});

	it("createCredentialContext returns empty oauth helpers for non-oauth modes", () => {
		const credential = createCredentialContext({
			allowedKeys: ["cookie"],
			mode: "credentials",
			values: { access_token: "token-123", cookie: "sid=secret" },
		});

		expect(() => credential.getAccessToken()).toThrow(CredentialModeError);
		expect(() => credential.getScopes()).toThrow(CredentialModeError);
	});

	it("createScratchpad only allows declared keys", () => {
		const scratchpad = createScratchpad(["state"], { state: "pending" });

		expect(scratchpad.get("state")).toBe("pending");
		scratchpad.set("state", "complete");
		expect(scratchpad.toJSON()).toEqual({ state: "complete" });
		expect(() => scratchpad.get("missing")).toThrow(ContextAccessError);
		expect(() => scratchpad.set("missing", true)).toThrow(ContextAccessError);
	});

	it("createFlowContext wires runtime dependencies and scratchpad", async () => {
		const bodyBytes = new Uint8Array();
		const response = async () => ({
			status: 200,
			ok: true,
			headers: {},
			data: {},
			json: async <T = unknown>() => ({}) as T,
			text: async () => "",
			arrayBuffer: async () => bodyBytes.buffer.slice(0),
			bytes: async () => bodyBytes.slice(0),
		});
		const http = {
			request: response,
			get: response,
			post: response,
			put: response,
			delete: response,
			stream: async () => {
				throw new Error("stream unsupported in runtime context test client");
			},
			sse: async () => {
				throw new Error("sse unsupported in runtime context test client");
			},
		} satisfies HttpClient;

		const context = createFlowContext({
			http,
			stealth: stealthStub,
			env: createEnvContext(),
			tenantId: "tenant-1",
			providerId: "demo-provider",
			connectionId: "conn-1",
			externalRef: "user-1",
			allowedKeys: ["state"],
			initialContext: { state: "draft" },
		});

		expect(context.http).toBe(http);
		await expect(
			context.native.network.connectTcp({
				host: "127.0.0.1",
				port: 1,
			}),
		).rejects.toThrow("Native network runtime is not available");
		expect(context.tenantId).toBe("tenant-1");
		expect(context.providerId).toBe("demo-provider");
		expect(context.context.get("state")).toBe("draft");
	});

	it("createFlowContext accepts an injected native network client", () => {
		const native: NativeContext = {
			network: createNativeNetworkClient([{ host: "127.0.0.1", ports: [65535], tls: "disabled" }]),
		};
		const http = {
			request: async () => {
				throw new Error("unused");
			},
			get: async () => {
				throw new Error("unused");
			},
			post: async () => {
				throw new Error("unused");
			},
			put: async () => {
				throw new Error("unused");
			},
			delete: async () => {
				throw new Error("unused");
			},
			stream: async () => {
				throw new Error("unused");
			},
			sse: async () => {
				throw new Error("unused");
			},
		} as HttpClient;

		const context = createFlowContext({
			http,
			native,
			stealth: stealthStub,
			env: createEnvContext(),
			tenantId: "tenant-1",
			providerId: "demo-provider",
			allowedKeys: [],
		});

		expect(context.native).toBe(native);
	});

	it("native network denies undeclared TCP egress before opening a socket", async () => {
		const server = net.createServer((socket) => {
			socket.destroy(new Error("should not be reached"));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") {
				throw new Error("TCP server did not expose an address");
			}
			const client = createNativeNetworkClient();

			await expect(
				client.connectTcp({
					host: "127.0.0.1",
					port: address.port,
					timeoutMs: 100,
				}),
			).rejects.toThrow("not declared");
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("native network connects to declared TCP loopback and reads echoed bytes", async () => {
		const server = net.createServer((socket) => {
			socket.on("data", (chunk) => socket.write(chunk));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") {
				throw new Error("TCP server did not expose an address");
			}
			const client = createNativeNetworkClient([
				{ host: "127.0.0.1", ports: [address.port], tls: "disabled" },
			]);
			const connection = await client.connectTcp({
				host: "127.0.0.1",
				port: address.port,
				timeoutMs: 500,
			});

			await connection.write("ping");
			const chunk = await connection.read();
			await connection.close();

			expect(new TextDecoder().decode(chunk ?? new Uint8Array())).toBe("ping");
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("native network allows a bounded dynamic TCP grant then supports revocation", async () => {
		const server = net.createServer((socket) => {
			socket.on("data", (chunk) => socket.write(chunk));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") {
				throw new Error("TCP server did not expose an address");
			}
			const client = createNativeNetworkClient(
				[{ host: "source.example.com", ports: [995], tls: "disabled" }],
				[
					{
						sourceHost: "source.example.com",
						sourcePorts: [995],
						targetHostSuffixes: ["127.0.0.1"],
						targetPorts: [address.port],
						tls: "disabled",
						ttlMs: 5_000,
					},
				],
			);

			await expect(
				client.connectTcp({ host: "127.0.0.1", port: address.port, timeoutMs: 100 }),
			).rejects.toThrow("not declared");

			const grant = client.grantTcpEgress({
				sourceHost: "source.example.com",
				sourcePort: 995,
				host: "127.0.0.1",
				port: address.port,
				tls: "disabled",
			});
			const connection = await client.connectTcp({
				host: "127.0.0.1",
				port: address.port,
				timeoutMs: 500,
			});
			await connection.write("pong");
			const chunk = await connection.read();
			await connection.close();
			expect(new TextDecoder().decode(chunk ?? new Uint8Array())).toBe("pong");

			grant.revoke();
			await expect(
				client.connectTcp({ host: "127.0.0.1", port: address.port, timeoutMs: 100 }),
			).rejects.toThrow("not declared");
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("native network allows dynamic grants from source host suffixes", async () => {
		const server = net.createServer((socket) => {
			socket.on("data", (chunk) => socket.write(chunk));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") {
				throw new Error("TCP server did not expose an address");
			}
			const client = createNativeNetworkClient(
				[],
				[
					{
						sourceHostSuffixes: ["kakao.com"],
						sourcePortRanges: [{ start: 10_000, end: 20_000 }],
						targetHostSuffixes: ["127.0.0.1"],
						targetPorts: [address.port],
						tls: "disabled",
					},
				],
			);

			const grant = client.grantTcpEgress({
				sourceHost: "edge-loco.kakao.com",
				sourcePort: 10001,
				host: "127.0.0.1",
				port: address.port,
				tls: "disabled",
			});
			const connection = await client.connectTcp({
				host: "127.0.0.1",
				port: address.port,
				timeoutMs: 500,
			});
			await connection.write("suffix");
			const chunk = await connection.read();
			await connection.close();
			grant.revoke();

			expect(new TextDecoder().decode(chunk ?? new Uint8Array())).toBe("suffix");
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
