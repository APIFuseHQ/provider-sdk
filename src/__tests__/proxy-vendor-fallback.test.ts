import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
	assertTunnelingScheme,
	clearProxyResolutionCache,
	mapFlatAttempt,
	ProxyResolutionError,
	type ProxyVendorFailoverTelemetryEvent,
	resolveProxyConfigAsync,
	resolveVendorChain,
} from "../config/loader.js";

const PROXY_ENV_KEYS = [
	"APIFUSE__PROXY__SMARTPROXY_APP_KEY",
	"APIFUSE__PROXY__NODEMAVEN_USERNAME",
	"APIFUSE__PROXY__NODEMAVEN_PASSWORD",
	"APIFUSE__PROXY__NODEMAVEN_FILTER",
	"APIFUSE__PROXY__PROTOCOL",
	"APIFUSE__PROXY__PROVIDER",
	"APIFUSE__PROXY__DEFAULT_COUNTRY",
	"APIFUSE__PROXY__DEFAULT_LIFETIME_MINUTES",
	"APIFUSE__PROXY__URL",
] as const;

function captureFailovers(): {
	events: ProxyVendorFailoverTelemetryEvent[];
	recordProxyResolution: () => void;
	recordProxyVendorFailover: (event: ProxyVendorFailoverTelemetryEvent) => void;
} {
	const events: ProxyVendorFailoverTelemetryEvent[] = [];
	return {
		events,
		recordProxyResolution: () => {},
		recordProxyVendorFailover: (event) => {
			events.push(event);
		},
	};
}

describe("proxy vendor fallback", () => {
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of PROXY_ENV_KEYS) {
			saved.set(key, process.env[key]);
			delete process.env[key];
		}
		clearProxyResolutionCache();
	});

	afterEach(() => {
		for (const key of PROXY_ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		clearProxyResolutionCache();
	});

	describe("assertTunnelingScheme (No-MITM invariant)", () => {
		it("accepts http and socks5 tunnelling schemes", () => {
			expect(() => assertTunnelingScheme("http://1.2.3.4:8080")).not.toThrow();
			expect(() => assertTunnelingScheme("socks5://user:pass@gate.example.com:1080")).not.toThrow();
		});

		it("rejects non-tunnelling / intercepting schemes", () => {
			expect(() => assertTunnelingScheme("https://mitm.example.com:8443")).toThrow(
				/not a tunnelling scheme/,
			);
			expect(() => assertTunnelingScheme("not-a-url")).toThrow(/Malformed proxy URL/);
		});
	});

	describe("mapFlatAttempt", () => {
		it("concatenates vendor pool spaces in chain order", () => {
			expect(mapFlatAttempt(0, [20, 5])).toEqual({ vendorIndex: 0, poolIndex: 0 });
			expect(mapFlatAttempt(19, [20, 5])).toEqual({ vendorIndex: 0, poolIndex: 19 });
			expect(mapFlatAttempt(20, [20, 5])).toEqual({ vendorIndex: 1, poolIndex: 0 });
			expect(mapFlatAttempt(24, [20, 5])).toEqual({ vendorIndex: 1, poolIndex: 4 });
		});

		it("reduces to attempt % poolSize for a single vendor (backcompat invariant)", () => {
			for (const attempt of [0, 1, 19, 20, 21]) {
				expect(mapFlatAttempt(attempt % 20, [20])).toEqual({
					vendorIndex: 0,
					poolIndex: attempt % 20,
				});
			}
		});
	});

	describe("resolveVendorChain", () => {
		it("honors providers[] order and drops non-registry vendors", () => {
			expect(
				resolveVendorChain({ mode: "required", providers: ["smartproxy", "nodemaven"] }),
			).toEqual(["smartproxy", "nodemaven"]);
			expect(resolveVendorChain({ mode: "required", providers: ["custom", "nodemaven"] })).toEqual([
				"nodemaven",
			]);
			expect(resolveVendorChain({ mode: "required", providers: ["decodo"] })).toEqual([]);
		});

		it("falls back to the legacy singular provider", () => {
			expect(resolveVendorChain({ mode: "required", provider: "smartproxy" })).toEqual([
				"smartproxy",
			]);
		});

		it("dedupes repeated vendors", () => {
			expect(
				resolveVendorChain({ mode: "required", providers: ["smartproxy", "smartproxy"] }),
			).toEqual(["smartproxy"]);
		});
	});

	describe("nodemaven gateway synthesis", () => {
		beforeEach(() => {
			process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = "acct123";
			process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = "s3cret";
		});

		it("synthesizes a rotating http gateway URL with a fresh sid per call", async () => {
			const policy = { mode: "required", provider: "nodemaven", geo: { country: "US" } } as const;
			const first = await resolveProxyConfigAsync({ proxyPolicy: policy });
			const second = await resolveProxyConfigAsync({ proxyPolicy: policy });

			expect(first.source).toBe("nodemaven-gateway");
			expect(first.protocol).toBe("http");
			expect(first.url).toMatch(
				/^http:\/\/acct123-country-us-sid-[a-z0-9]{4,10}-filter-medium-ipv4-true:s3cret@gate\.nodemaven\.com:\d{4}$/,
			);
			const httpPort = Number(new URL(first.url as string).port);
			expect(httpPort).toBeGreaterThanOrEqual(8080);
			expect(httpPort).toBeLessThanOrEqual(9080);
			expect(first.url).not.toBe(second.url); // rotating: new sid each call
		});

		it("derives a deterministic sticky sid from the affinity key", async () => {
			const policy = {
				mode: "required",
				provider: "nodemaven",
				geo: { country: "KR" },
				session: { affinity: "connection" },
			} as const;
			const a1 = await resolveProxyConfigAsync({ proxyPolicy: policy, affinityKey: "conn-1" });
			const a2 = await resolveProxyConfigAsync({ proxyPolicy: policy, affinityKey: "conn-1" });
			const b = await resolveProxyConfigAsync({ proxyPolicy: policy, affinityKey: "conn-2" });

			expect(a1.url).toBe(a2.url); // sticky determinism
			expect(a1.url).not.toBe(b.url);
		});

		it("encodes region/city and a high filter tier from env", async () => {
			process.env.APIFUSE__PROXY__NODEMAVEN_FILTER = "high";
			const resolved = await resolveProxyConfigAsync({
				proxyPolicy: {
					mode: "required",
					provider: "nodemaven",
					geo: { country: "KR", subdivision: "Seoul", city: "Gangnam Gu" },
				},
			});
			expect(resolved.url).toContain("-country-kr-region-seoul-city-gangnamgu-");
			expect(resolved.url).toContain("-filter-high-");
		});

		it("uses the SOCKS5 scheme and port range when the protocol env requests it", async () => {
			process.env.APIFUSE__PROXY__PROTOCOL = "socks5";
			const resolved = await resolveProxyConfigAsync({
				proxyPolicy: { mode: "required", provider: "nodemaven", geo: { country: "US" } },
			});
			expect(resolved.protocol).toBe("socks5");
			expect(resolved.url).toMatch(/^socks5:\/\/acct123-.*@gate\.nodemaven\.com:\d{4}$/);
			const socksPort = Number(new URL(resolved.url as string).port);
			expect(socksPort).toBeGreaterThanOrEqual(1080);
			expect(socksPort).toBeLessThanOrEqual(2080);
		});

		it("rejects an invalid filter tier", async () => {
			process.env.APIFUSE__PROXY__NODEMAVEN_FILTER = "ultra";
			await expect(
				resolveProxyConfigAsync({
					proxyPolicy: { mode: "required", provider: "nodemaven" },
				}),
			).rejects.toThrow('APIFUSE__PROXY__NODEMAVEN_FILTER must be "medium" or "high"');
		});
	});

	describe("chain failover", () => {
		it("fails over to nodemaven at resolution time when smartproxy lacks credentials", async () => {
			process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = "acct123";
			process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = "s3cret";
			const telemetry = captureFailovers();

			const resolved = await resolveProxyConfigAsync({
				proxyPolicy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					geo: { country: "KR" },
				},
				telemetry,
			});

			expect(resolved.source).toBe("nodemaven-gateway");
			expect(telemetry.events).toContainEqual({
				vendor: "smartproxy",
				nextVendor: "nodemaven",
				phase: "resolution",
				reason: "no_credentials",
			});
		});

		it("fails closed listing every vendor when the whole chain lacks credentials", async () => {
			await expect(
				resolveProxyConfigAsync({
					proxyPolicy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
				}),
			).rejects.toMatchObject({
				code: "PROXY_REQUIRED",
				message: expect.stringContaining("APIFUSE__PROXY__NODEMAVEN_USERNAME"),
				vendorChain: ["smartproxy", "nodemaven"],
			});
		});

		it("warns instead of throwing for an optional chain with no credentials", async () => {
			const resolved = await resolveProxyConfigAsync({
				proxyPolicy: { mode: "optional", providers: ["smartproxy", "nodemaven"] },
			});
			expect(resolved.shouldWarn).toBe(true);
			expect(resolved.url).toBeUndefined();
		});
	});

	describe("protocol capability guard", () => {
		it("fails loudly when a socks5 policy meets an http-only transport", async () => {
			process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = "acct123";
			process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = "s3cret";
			process.env.APIFUSE__PROXY__PROTOCOL = "socks5";

			const rejection = resolveProxyConfigAsync({
				proxyPolicy: { mode: "required", provider: "nodemaven" },
				transportProtocols: ["http"],
			});
			await expect(rejection).rejects.toMatchObject({ code: "PROXY_PROTOCOL_UNSUPPORTED" });
			await expect(rejection).rejects.toBeInstanceOf(ProxyResolutionError);
		});

		it("rejects an unrecognized protocol env value", async () => {
			process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = "acct123";
			process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = "s3cret";
			process.env.APIFUSE__PROXY__PROTOCOL = "quic";
			await expect(
				resolveProxyConfigAsync({ proxyPolicy: { mode: "required", provider: "nodemaven" } }),
			).rejects.toThrow('APIFUSE__PROXY__PROTOCOL must be "http" or "socks5"');
		});
	});

	describe("smartproxy backcompat via providers[]", () => {
		it("resolves identically whether declared as provider or single-element providers", async () => {
			process.env.APIFUSE__PROXY__SMARTPROXY_APP_KEY = "redacted-test-key";
			const originalFetch = global.fetch;
			global.fetch = (async () =>
				new Response("5.78.24.25:31001", { status: 200 })) as typeof fetch;
			try {
				const viaProviders = await resolveProxyConfigAsync({
					proxyPolicy: { mode: "required", providers: ["smartproxy"], geo: { country: "KR" } },
				});
				expect(viaProviders).toMatchObject({
					source: "smartproxy-allocator",
					url: "http://5.78.24.25:31001",
				});
			} finally {
				global.fetch = originalFetch;
			}
		});
	});
});
