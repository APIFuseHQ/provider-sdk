import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type {
	ProxyProtocol,
	ProxyResolutionOptions,
	ProxyResolutionSource,
	ProxyVendorName,
	ResolvedProxyConfig,
} from "../index.js";
import { createFetchDouble } from "./test-utils.js";

const builtSpecifier: string = "@apifuse/provider-sdk";
const built: Promise<typeof import("../index.js")> = import(builtSpecifier);
const { resolveProxy } = await built;

const PROXY_ENV_KEYS = [
	"APIFUSE__PROXY__SMARTPROXY_APP_KEY",
	"APIFUSE__PROXY__SMARTPROXY_USERNAME",
	"APIFUSE__PROXY__SMARTPROXY_PASSWORD",
	"APIFUSE__PROXY__NODEMAVEN_USERNAME",
	"APIFUSE__PROXY__NODEMAVEN_PASSWORD",
	"APIFUSE__PROXY__PROVIDER",
] as const;

const typeWitness = {
	options: { proxyPolicy: { mode: "disabled" } } satisfies ProxyResolutionOptions,
	protocol: "http" as ProxyProtocol,
	result: undefined as ResolvedProxyConfig | undefined,
	source: "smartproxy-gateway" as ProxyResolutionSource,
	vendor: "smartproxy" as ProxyVendorName,
};

describe("public proxy resolver", () => {
	const savedEnv = new Map<string, string | undefined>();
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = global.fetch;
		for (const key of PROXY_ENV_KEYS) {
			savedEnv.set(key, process.env[key]);
			delete process.env[key];
		}
	});

	afterEach(() => {
		global.fetch = originalFetch;
		for (const key of PROXY_ENV_KEYS) {
			const value = savedEnv.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("is reachable with its consumer types from the package root", () => {
		expect(typeof resolveProxy).toBe("function");
		expect(typeWitness.options.proxyPolicy.mode).toBe("disabled");
		expect(typeWitness.protocol).toBe("http");
		expect(typeWitness.result).toBeUndefined();
		expect(typeWitness.source).toBe("smartproxy-gateway");
		expect(typeWitness.vendor).toBe("smartproxy");
	});

	it("prefers an explicit URL over policy resolution", async () => {
		const resolved = await resolveProxy({
			proxy: "http://proxy.example:8080",
			proxyPolicy: { mode: "disabled" },
		});

		expect(resolved).toEqual({
			shouldWarn: false,
			source: "explicit",
			url: "http://proxy.example:8080",
		});
	});

	it("returns no proxy for a disabled policy", async () => {
		const allocator = mock(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response("192.0.2.1:8080", { status: 200 }),
		);
		global.fetch = createAllocatorFetch(allocator);

		await expect(resolveProxy({ proxyPolicy: { mode: "disabled" } })).resolves.toEqual({
			shouldWarn: false,
		});
		expect(allocator).not.toHaveBeenCalled();
	});

	it("synthesizes a vendor-chain gateway proxy and reports its vendor and source", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_USERNAME = "test-user";
		process.env.APIFUSE__PROXY__SMARTPROXY_PASSWORD = "test-password";
		const allocator = mock(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response("192.0.2.10:31001", { status: 200 }),
		);
		global.fetch = createAllocatorFetch(allocator);

		const resolved = await resolveProxy({
			proxyPolicy: {
				mode: "required",
				providers: ["smartproxy"],
				geo: { country: "KR" },
				session: { affinity: "connection", lifetimeMinutes: 10 },
			},
			affinityKey: "public-resolver",
		});

		expect(resolved).toMatchObject({
			shouldWarn: false,
			vendor: "smartproxy",
			source: "smartproxy-gateway",
			protocol: "http",
			sticky: true,
			lifetimeMinutes: 10,
		});
		expect(resolved.url).toBe(
			`http://test-user_area-KR_life-10_session-${resolved.sessionId}:test-password@proxy.smartproxy.net:3120`,
		);
		expect(resolved.expiresAt).toBeString();
		// The gateway is synthesized locally: no allocation API call.
		expect(allocator).not.toHaveBeenCalled();
	});

	it("fails a required smartproxy policy that only has the retired app key, naming the gateway pair", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "retired-extraction-key";

		await expect(
			resolveProxy({ proxyPolicy: { mode: "required", providers: ["smartproxy"] } }),
		).rejects.toMatchObject({
			code: "PROXY_REQUIRED",
			message:
				"Proxy egress is required but no vendor credentials are configured. Missing: APIFUSE__PROXY__SMARTPROXY_USERNAME and APIFUSE__PROXY__SMARTPROXY_PASSWORD (smartproxy).",
		});
	});
});

function createAllocatorFetch(
	implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return createFetchDouble(
		Object.assign(implementation, {
			preconnect(_url: string | URL): void {},
		}),
	);
}
