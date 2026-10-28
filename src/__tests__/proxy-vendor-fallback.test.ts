import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
	assertTunnelingScheme,
	mapAttemptToVendor,
	PROXY_ATTEMPTS_PER_VENDOR,
	type ProxyAttemptOutcome,
	type ProxyAttemptRequest,
	ProxyResolutionError,
	type ProxyVendorFailoverTelemetryEvent,
	type ProxyVendorSelector,
	getProxyVendorSelector,
	resolveProxyConfigAsync,
	resolveVendorChain,
	setProxyVendorSelector,
	staticOrderProxyVendorSelector,
} from "../config/loader.js";

const PROXY_ENV_KEYS = [
	"APIFUSE__PROXY__SMARTPROXY_APP_KEY",
	"APIFUSE__PROXY__SMARTPROXY_USERNAME",
	"APIFUSE__PROXY__SMARTPROXY_PASSWORD",
	"APIFUSE__PROXY__NODEMAVEN_USERNAME",
	"APIFUSE__PROXY__NODEMAVEN_PASSWORD",
	"APIFUSE__PROXY__NODEMAVEN_FILTER",
	"APIFUSE__PROXY__PROVIDER",
	"APIFUSE__PROXY__DEFAULT_COUNTRY",
	"APIFUSE__PROXY__DEFAULT_LIFETIME_MINUTES",
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
	});

	afterEach(() => {
		for (const key of PROXY_ENV_KEYS) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		setProxyVendorSelector(undefined);
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

	describe("mapAttemptToVendor", () => {
		it("splits the attempt budget evenly across the chain in declaration order", () => {
			const slots = [0, 1, 2, 3, 4, 5].map((attempt) => mapAttemptToVendor(attempt, 2, 6));
			expect(slots).toEqual([
				{ vendorIndex: 0, vendorAttempt: 0 },
				{ vendorIndex: 0, vendorAttempt: 1 },
				{ vendorIndex: 0, vendorAttempt: 2 },
				{ vendorIndex: 1, vendorAttempt: 0 },
				{ vendorIndex: 1, vendorAttempt: 1 },
				{ vendorIndex: 1, vendorAttempt: 2 },
			]);
		});

		it("reaches every vendor whenever the budget is at least the chain length", () => {
			// An explicit `attempts: 2` on a two-vendor chain still reaches the fallback.
			expect(mapAttemptToVendor(1, 2, 2)).toEqual({ vendorIndex: 1, vendorAttempt: 0 });
			// An odd budget gives the remainder to the last vendor.
			expect([0, 1, 2].map((attempt) => mapAttemptToVendor(attempt, 2, 3))).toEqual([
				{ vendorIndex: 0, vendorAttempt: 0 },
				{ vendorIndex: 0, vendorAttempt: 1 },
				{ vendorIndex: 1, vendorAttempt: 0 },
			]);
		});

		it("keeps attempts past the cap on the last vendor and every attempt on a single vendor", () => {
			expect(mapAttemptToVendor(9, 2, 6)).toEqual({ vendorIndex: 1, vendorAttempt: 6 });
			for (const attempt of [0, 1, 7, 20]) {
				expect(mapAttemptToVendor(attempt, 1, 3)).toEqual({
					vendorIndex: 0,
					vendorAttempt: attempt,
				});
			}
			expect(mapAttemptToVendor(Number.NaN, 2, 6)).toEqual({ vendorIndex: 0, vendorAttempt: 0 });
		});
	});

	describe("vendor selector seam", () => {
		function recordingSelector(
			requests: ProxyAttemptRequest[],
			outcomes: ProxyAttemptOutcome[],
		): ProxyVendorSelector {
			return {
				select(request) {
					requests.push(request);
					return staticOrderProxyVendorSelector.select(request);
				},
				report(outcome) {
					outcomes.push(outcome);
				},
			};
		}

		beforeEach(() => {
			process.env.APIFUSE__PROXY__SMARTPROXY_USERNAME = "smart-user";
			process.env.APIFUSE__PROXY__SMARTPROXY_PASSWORD = "smart-pass";
			process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = "acct123";
			process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = "s3cret";
		});

		it("names the vendor, the attempt within it and the policy's session for each attempt", () => {
			const directives = staticOrderProxyVendorSelector.select({
				policy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					session: { affinity: "connection", lifetimeMinutes: 45 },
				},
				chain: ["smartproxy", "nodemaven"],
				attempt: 4,
				attemptCap: 6,
				now: 0,
			});
			expect(directives).toEqual([
				{
					vendor: "nodemaven",
					vendorAttempt: 1,
					session: { kind: "sticky", lifetimeMinutes: 45 },
				},
			]);
			const rotating = staticOrderProxyVendorSelector.select({
				policy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
				chain: ["smartproxy", "nodemaven"],
				attempt: 1,
				attemptCap: 6,
				now: 0,
			});
			// The vendors after the attempt's own are resolution-time fallbacks starting at attempt 0.
			expect(rotating).toEqual([
				{ vendor: "smartproxy", vendorAttempt: 1, session: { kind: "rotating" } },
				{ vendor: "nodemaven", vendorAttempt: 0, session: { kind: "rotating" } },
			]);
		});

		it("asks the injected selector with the request id and history, and reports back to that instance", async () => {
			const globalOutcomes: ProxyAttemptOutcome[] = [];
			setProxyVendorSelector(recordingSelector([], globalOutcomes));
			const requests: ProxyAttemptRequest[] = [];
			const outcomes: ProxyAttemptOutcome[] = [];
			const injected = recordingSelector(requests, outcomes);
			const history = [{ vendor: "smartproxy" as const, outcome: "error" as const }];

			const resolved = await resolveProxyConfigAsync({
				proxyPolicy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
				proxyAttempt: 1,
				proxyAttemptCap: 6,
				vendorSelector: injected,
				proxyRequestId: "request-1",
				proxyAttemptHistory: history,
				now: 1_000,
			});

			expect(resolved.source).toBe("smartproxy-gateway");
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				chain: ["smartproxy", "nodemaven"],
				attempt: 1,
				attemptCap: 6,
				now: 1_000,
				requestId: "request-1",
				history,
			});
			expect(outcomes).toEqual([
				{
					vendor: "smartproxy",
					phase: "resolution",
					outcome: "ok",
					attempt: 1,
					vendorAttempt: 1,
					sessionId: resolved.sessionId,
					now: 1_000,
					requestId: "request-1",
				},
			]);
			expect(globalOutcomes).toEqual([]);
		});

		it("uses the process selector when none is injected and moves to the directive fallback", async () => {
			delete process.env.APIFUSE__PROXY__SMARTPROXY_USERNAME;
			const requests: ProxyAttemptRequest[] = [];
			const outcomes: ProxyAttemptOutcome[] = [];
			const processSelector = recordingSelector(requests, outcomes);
			setProxyVendorSelector(processSelector);
			expect(getProxyVendorSelector()).toBe(processSelector);

			const resolved = await resolveProxyConfigAsync({
				proxyPolicy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
				now: 1_000,
			});

			expect(resolved.source).toBe("nodemaven-gateway");
			expect(requests[0]?.attemptCap).toBe(2 * PROXY_ATTEMPTS_PER_VENDOR);
			expect(
				outcomes.map(({ vendor, outcome, errorCode }) => [vendor, outcome, errorCode]),
			).toEqual([
				["smartproxy", "error", "no_credentials"],
				["nodemaven", "ok", undefined],
			]);
			setProxyVendorSelector(undefined);
			expect(getProxyVendorSelector()).toBe(staticOrderProxyVendorSelector);
		});

		it("lets a selector name the vendor regardless of the declared order", async () => {
			const reversed: ProxyVendorSelector = {
				select: (request) =>
					[...request.chain].reverse().map((vendor) => ({
						vendor,
						vendorAttempt: 0,
						session: { kind: "rotating" as const },
					})),
				report() {},
			};
			const resolved = await resolveProxyConfigAsync({
				proxyPolicy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
				vendorSelector: reversed,
			});
			expect(resolved.source).toBe("nodemaven-gateway");
		});

		it("does not let a throwing report fail the resolution", async () => {
			const resolved = await resolveProxyConfigAsync({
				proxyPolicy: { mode: "required", providers: ["smartproxy"] },
				vendorSelector: {
					select: staticOrderProxyVendorSelector.select,
					report() {
						throw new Error("observer failed");
					},
				},
			});
			expect(resolved.source).toBe("smartproxy-gateway");
		});
	});

	describe("gateway overrides", () => {
		beforeEach(() => {
			process.env.APIFUSE__PROXY__SMARTPROXY_USERNAME = "smart-user";
			process.env.APIFUSE__PROXY__SMARTPROXY_PASSWORD = "smart-pass";
			process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = "acct123";
			process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = "s3cret";
		});

		it("points each vendor at the given endpoint and keeps the username and password", async () => {
			const gatewayOverrides = {
				smartproxy: { host: "127.0.0.1", port: 18_001 },
				nodemaven: { host: "localhost", port: 18_002 },
			};
			const smart = await resolveProxyConfigAsync({
				proxyPolicy: { mode: "required", providers: ["smartproxy"], geo: { country: "KR" } },
				gatewayOverrides,
			});
			const node = await resolveProxyConfigAsync({
				proxyPolicy: { mode: "required", providers: ["nodemaven"], geo: { country: "KR" } },
				gatewayOverrides,
			});

			expect(smart.url).toBe(
				`http://smart-user_area-KR_life-30_session-${smart.sessionId}:smart-pass@127.0.0.1:18001`,
			);
			expect(node.url).toBe(
				`http://acct123-country-kr-ipv4-true-sid-${node.sessionId}-filter-medium:s3cret@localhost:18002`,
			);
		});

		it("rejects an override that could rewrite the URL around it", async () => {
			for (const host of ["evil.example@127.0.0.1", "127.0.0.1/x", ""]) {
				await expect(
					resolveProxyConfigAsync({
						proxyPolicy: { mode: "required", providers: ["smartproxy"] },
						gatewayOverrides: { smartproxy: { host, port: 18_001 } },
					}),
				).rejects.toThrow("Proxy gateway override host must be a hostname or IPv4 address");
			}
			await expect(
				resolveProxyConfigAsync({
					proxyPolicy: { mode: "required", providers: ["smartproxy"] },
					gatewayOverrides: { smartproxy: { host: "127.0.0.1", port: 70_000 } },
				}),
			).rejects.toThrow("Proxy gateway override port must be an integer between 1 and 65535");
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

	describe("deprecated-only policies", () => {
		it("fails closed for a required singular deprecated provider", async () => {
			await expect(
				resolveProxyConfigAsync({
					proxyPolicy: { mode: "required", provider: "custom" },
				}),
			).rejects.toThrow(
				/Required proxy policy.*provider id\(s\): "custom".*Deprecated vendor\(s\): "custom".*smartproxy.*nodemaven/,
			);
		});

		it("fails closed and names every vendor in a required all-deprecated chain", async () => {
			await expect(
				resolveProxyConfigAsync({
					proxyPolicy: { mode: "required", providers: ["decodo", "custom"] },
				}),
			).rejects.toMatchObject({ code: "PROXY_REQUIRED" });
			await expect(
				resolveProxyConfigAsync({
					proxyPolicy: { mode: "required", providers: ["decodo", "custom"] },
				}),
			).rejects.toThrow(/"decodo", "custom".*Use "smartproxy" or "nodemaven"/);
		});

		it("keeps optional deprecated-only policies warning-only", async () => {
			await expect(
				resolveProxyConfigAsync({
					proxyPolicy: { mode: "optional", providers: ["decodo", "custom"] },
				}),
			).resolves.toEqual({ shouldWarn: true });
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
				/^http:\/\/acct123-country-us-ipv4-true-sid-[a-z0-9]{4,10}-filter-medium:s3cret@gate\.nodemaven\.com:\d{4}$/,
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
			expect(resolved.url).toContain("-filter-high:");
		});

		it("defaults nodemaven to the http protocol", async () => {
			const resolved = await resolveProxyConfigAsync({
				proxyPolicy: { mode: "required", provider: "nodemaven", geo: { country: "US" } },
			});
			expect(resolved.protocol).toBe("http");
			expect(resolved.url).toMatch(/^http:\/\//);
		});

		it("uses the SOCKS5 scheme and port range when the protocol override requests it", async () => {
			const resolved = await resolveProxyConfigAsync({
				proxyPolicy: { mode: "required", provider: "nodemaven", geo: { country: "US" } },
				protocol: "socks5",
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

		it("fails closed listing every missing credential when the whole chain lacks them", async () => {
			process.env.APIFUSE__PROXY__SMARTPROXY_USERNAME = "smart-user";
			await expect(
				resolveProxyConfigAsync({
					proxyPolicy: { mode: "required", providers: ["smartproxy", "nodemaven"] },
				}),
			).rejects.toMatchObject({
				code: "PROXY_REQUIRED",
				message:
					"Proxy egress is required but no vendor credentials are configured. Missing: APIFUSE__PROXY__SMARTPROXY_PASSWORD (smartproxy), APIFUSE__PROXY__NODEMAVEN_USERNAME and APIFUSE__PROXY__NODEMAVEN_PASSWORD (nodemaven).",
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
		it("fails loudly when a socks5 protocol meets an http-only transport", async () => {
			process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = "acct123";
			process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = "s3cret";

			const rejection = resolveProxyConfigAsync({
				proxyPolicy: { mode: "required", provider: "nodemaven" },
				protocol: "socks5",
				transportProtocols: ["http"],
			});
			await expect(rejection).rejects.toMatchObject({ code: "PROXY_PROTOCOL_UNSUPPORTED" });
			await expect(rejection).rejects.toBeInstanceOf(ProxyResolutionError);
		});

		it("allows the http default on an http-only transport", async () => {
			process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = "acct123";
			process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = "s3cret";
			const resolved = await resolveProxyConfigAsync({
				proxyPolicy: { mode: "required", provider: "nodemaven" },
				transportProtocols: ["http"],
			});
			expect(resolved.protocol).toBe("http");
			expect(resolved.source).toBe("nodemaven-gateway");
		});
	});

	describe("smartproxy backcompat via providers[]", () => {
		it("resolves identically whether declared as provider or single-element providers", async () => {
			process.env.APIFUSE__PROXY__SMARTPROXY_USERNAME = "smart-user";
			process.env.APIFUSE__PROXY__SMARTPROXY_PASSWORD = "smart-pass";
			const session = { affinity: "connection", lifetimeMinutes: 60 } as const;
			const common = { affinityKey: "conn-1", now: Date.parse("2026-10-28T05:10:00.000Z") };
			const viaProviders = await resolveProxyConfigAsync({
				...common,
				proxyPolicy: {
					mode: "required",
					providers: ["smartproxy"],
					geo: { country: "KR" },
					session,
				},
			});
			const viaProvider = await resolveProxyConfigAsync({
				...common,
				proxyPolicy: { mode: "required", provider: "smartproxy", geo: { country: "KR" }, session },
			});
			expect(viaProviders).toMatchObject({ source: "smartproxy-gateway", sticky: true });
			expect(viaProvider).toEqual(viaProviders);
		});
	});
});
