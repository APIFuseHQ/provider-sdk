import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";

import { assertIsError } from "../../__tests__/test-utils.js";
import { clearProxyResolutionCache, SMARTPROXY_APP_KEY_ENV } from "../../config/loader.js";
import {
	createNativeNetworkClient,
	resolveNativeGatewayProxy,
	type VendorCredentialResolver,
} from "../native-network.js";
import { NODEMAVEN_PASSWORD_ENV, NODEMAVEN_USERNAME_ENV } from "../proxy-nodemaven.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearProxyResolutionCache();
});

function injectedCredentials(options: {
	smartproxy?: string;
	nodemaven?: { username: string; password: string };
}): VendorCredentialResolver {
	return (vendor) => {
		if (vendor === "smartproxy") {
			return options.smartproxy
				? {
						kind: "present",
						values: { [SMARTPROXY_APP_KEY_ENV]: options.smartproxy },
					}
				: { kind: "absent", missing: [SMARTPROXY_APP_KEY_ENV] };
		}
		if (vendor === "nodemaven") {
			return options.nodemaven
				? {
						kind: "present",
						values: {
							[NODEMAVEN_USERNAME_ENV]: options.nodemaven.username,
							[NODEMAVEN_PASSWORD_ENV]: options.nodemaven.password,
						},
					}
				: {
						kind: "absent",
						missing: [NODEMAVEN_USERNAME_ENV, NODEMAVEN_PASSWORD_ENV],
					};
		}
		return { kind: "absent", missing: [] };
	};
}

describe("native vendor chain", () => {
	it("honors declared order and resolves smartproxy before nodemaven", async () => {
		let allocations = 0;
		globalThis.fetch = (async () => {
			allocations += 1;
			return new Response("127.0.0.1:18080", { status: 200 });
		}) as typeof fetch;
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
		globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
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
		globalThis.fetch = (async () => {
			throw new Error(`allocator rejected ${appKey}`);
		}) as typeof fetch;
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
		globalThis.fetch = (async () => {
			allocations += 1;
			return new Response(`127.0.0.${allocations}:8080`, { status: 200 });
		}) as typeof fetch;
		const policy = {
			mode: "required",
			providers: ["smartproxy"],
			session: { affinity: "connection", poolSize: 1 },
		} as const;
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
