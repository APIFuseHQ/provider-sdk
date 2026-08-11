import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { resolveProxy } from "@apifuse/provider-sdk";
import type {
	ProxyProtocol,
	ProxyResolutionOptions,
	ProxyResolutionSource,
	ProxyVendorName,
	ResolvedProxyConfig,
} from "@apifuse/provider-sdk";

const PROXY_ENV_KEYS = [
	"APIFUSE__PROXY__SMARTPROXY_APP_KEY",
	"APIFUSE__PROXY__NODEMAVEN_USERNAME",
	"APIFUSE__PROXY__NODEMAVEN_PASSWORD",
	"APIFUSE__PROXY__PROVIDER",
] as const;

const typeWitness = {
	options: { proxyPolicy: { mode: "disabled" } } satisfies ProxyResolutionOptions,
	protocol: "http" as ProxyProtocol,
	result: undefined as ResolvedProxyConfig | undefined,
	source: "smartproxy-allocator" as ProxyResolutionSource,
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
		expect(typeWitness.source).toBe("smartproxy-allocator");
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
		const allocator = mock(async () => new Response("192.0.2.1:8080", { status: 200 }));
		global.fetch = allocator as unknown as typeof fetch;

		await expect(resolveProxy({ proxyPolicy: { mode: "disabled" } })).resolves.toEqual({
			shouldWarn: false,
		});
		expect(allocator).not.toHaveBeenCalled();
	});

	it("allocates a vendor-chain proxy and reports its vendor and source", async () => {
		process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
		const allocator = mock(async () => new Response("192.0.2.10:31001", { status: 200 }));
		global.fetch = allocator as unknown as typeof fetch;

		const resolved = await resolveProxy({
			proxyPolicy: {
				mode: "required",
				providers: ["smartproxy"],
				geo: { country: "KR" },
				session: { poolSize: 1 },
			},
		});

		expect(resolved).toMatchObject({
			shouldWarn: false,
			url: "http://192.0.2.10:31001",
			vendor: "smartproxy",
			source: "smartproxy-allocator",
			protocol: "http",
		});
		expect(allocator).toHaveBeenCalledTimes(1);
		expect(String(allocator.mock.calls[0]?.[0])).toStartWith(
			"https://api.smartproxy.org/web_v1/ip/get-ip-v3?",
		);
	});
});
