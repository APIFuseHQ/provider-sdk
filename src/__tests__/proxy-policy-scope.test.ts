import { describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";

import { resolveProxyConfigAsync } from "../config/loader.js";
import { ValidationError } from "../errors.js";
import {
	formatNodemavenTtl,
	NODEMAVEN_ISP_SLUG_PATTERN,
	NODEMAVEN_TTL_SECONDS_MAX,
	NODEMAVEN_TTL_SECONDS_MIN,
	nodemavenSessionWindow,
	synthesizeNodemavenProxy,
} from "../runtime/proxy-nodemaven.js";
import {
	createServerApp,
	type ProviderServerLogEvent,
	resolveAuthFlowProxyConfig,
	resolveOperationProxyConfig,
} from "../server/serve.js";
import type {
	OperationRiskClass,
	ProviderDefinition,
	ProviderProxyNodemavenOptions,
	ProviderProxyPolicy,
} from "../types.js";
import {
	createProviderDefinitionDouble,
	defineTestProvider as defineProvider,
} from "./test-utils.js";

const READ_RISK_CLASS: OperationRiskClass = "read";
const InputSchema = z.object({ id: z.string() });
const OutputSchema = z.object({ name: z.string() });

function operation() {
	return {
		riskClass: READ_RISK_CLASS,
		input: InputSchema,
		output: OutputSchema,
		handler: async (_ctx: unknown, input: unknown) => ({ name: InputSchema.parse(input).id }),
		fixtures: { request: { id: "a" }, response: { name: "a" } },
		healthCheckUnsupported: { reason: "test fixture" },
	};
}

const baseConfig = {
	allowedHosts: ["example.com"],
	reviewed: "community",
	id: "nol-like",
	version: "1.0.0",
	runtime: "standard" as const,
	meta: {
		displayName: "NOL-like stays",
		descriptionKey: "meta.description",
		category: "travel",
		tags: ["stays"],
	},
	operations: {
		"search-stays": operation(),
		"get-stay-detail": operation(),
		"list-room-rate-plans": operation(),
	},
};

const KR_MOBILE_DETAIL_ONLY: ProviderProxyPolicy = {
	mode: "required",
	providers: ["nodemaven"],
	geo: { country: "KR" },
	nodemaven: { type: "mobile", isp: ["sk_telecom", "lg_uplus"] },
	operations: ["get-stay-detail", "list-room-rate-plans"],
};

describe("proxy policy: operation scope and nodemaven options (contract)", () => {
	it("accepts a provider-level policy scoped to declared operations with nodemaven mobile tokens", () => {
		const provider = defineProvider({ ...baseConfig, proxy: KR_MOBILE_DETAIL_ONLY });
		expect(provider.proxy).toEqual(KR_MOBILE_DETAIL_ONLY);
	});

	it("rejects an operation id that is not a declared operation", () => {
		expect(() =>
			defineProvider({
				...baseConfig,
				proxy: { ...KR_MOBILE_DETAIL_ONLY, operations: ["get-stay-detail", "missing-op"] },
			}),
		).toThrow(/proxy\.operations.*"missing-op".*not a declared operation/);
	});

	it("rejects an empty or duplicated operations list", () => {
		expect(() =>
			defineProvider({ ...baseConfig, proxy: { ...KR_MOBILE_DETAIL_ONLY, operations: [] } }),
		).toThrow(ValidationError);
		expect(() =>
			defineProvider({
				...baseConfig,
				proxy: { ...KR_MOBILE_DETAIL_ONLY, operations: ["get-stay-detail", "get-stay-detail"] },
			}),
		).toThrow(/proxy\.operations.*duplicate/);
	});

	it("rejects the nodemaven block when nodemaven is not in the vendor chain", () => {
		expect(() =>
			defineProvider({
				...baseConfig,
				proxy: { mode: "required", providers: ["smartproxy"], nodemaven: { type: "mobile" } },
			}),
		).toThrow(/proxy\.nodemaven.*requires "nodemaven" in proxy\.providers/);
	});

	it("rejects unknown nodemaven fields, bad connection types, bad carrier slugs and out-of-range ttl", () => {
		const withNodemaven = (nodemaven: ProviderProxyNodemavenOptions) =>
			defineProvider({
				...baseConfig,
				proxy: { mode: "required", providers: ["nodemaven"], nodemaven },
			});
		expect(() =>
			// @ts-expect-error test-invalid: an unknown nodemaven field is rejected at runtime as well as by the type.
			withNodemaven({ carrier: "kt" }),
		).toThrow(/unknown field.*carrier/i);
		expect(() =>
			// @ts-expect-error test-invalid: an unknown connection type is rejected at runtime as well as by the type.
			withNodemaven({ type: "cellular" }),
		).toThrow(/proxy\.nodemaven\.type/);
		expect(() => withNodemaven({ isp: ["SK Telecom"] })).toThrow(/proxy\.nodemaven\.isp/);
		expect(() => withNodemaven({ isp: [] })).toThrow(/proxy\.nodemaven\.isp/);
		expect(() => withNodemaven({ ttlSeconds: 30 })).toThrow(/proxy\.nodemaven\.ttlSeconds/);
		expect(() => withNodemaven({ ttlSeconds: 90_000 })).toThrow(/proxy\.nodemaven\.ttlSeconds/);
		expect(() => withNodemaven({ ttlSeconds: 90.5 })).toThrow(/proxy\.nodemaven\.ttlSeconds/);
		expect(() =>
			withNodemaven({ type: "mobile", isp: ["sk_telecom", "lg_uplus", "kt"], ttlSeconds: 500 }),
		).not.toThrow();
	});

	it("keeps today's policies valid without the new fields", () => {
		expect(() =>
			defineProvider({
				...baseConfig,
				proxy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					geo: { country: "KR" },
					session: { affinity: "connection", lifetimeMinutes: 120 },
				},
			}),
		).not.toThrow();
	});

	it("accepts the retired session.poolSize next to the live session fields for one release", () => {
		// The pool is gone (each attempt is its own vendor session). A pin bump
		// must still load the declaration: the field is kept, warned about once at
		// defineProvider, and never read by the runtime.
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const provider = defineProvider({
				...baseConfig,
				id: "pool-size-with-session-fields",
				proxy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					geo: { country: "KR" },
					session: {
						affinity: "connection",
						lifetimeMinutes: 120,
						poolSize: 6,
						drainLeadSeconds: 120,
					},
				},
			});
			const proxy = provider.proxy;
			if (!proxy || typeof proxy === "boolean") throw new Error("expected a proxy policy");
			expect(proxy.session).toEqual({
				affinity: "connection",
				lifetimeMinutes: 120,
				poolSize: 6,
				drainLeadSeconds: 120,
			});
			expect(
				warn.mock.calls.filter(
					(call) =>
						typeof call[0] === "string" &&
						call[0].includes(
							'Provider "pool-size-with-session-fields" declares proxy.session.poolSize (6)',
						),
				),
			).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("resolveOperationProxyConfig", () => {
	const definition = (proxy: ProviderDefinition["proxy"]) => ({ proxy });

	it("applies an unscoped policy to every operation", () => {
		const policy: ProviderProxyPolicy = { mode: "required", providers: ["nodemaven"] };
		expect(resolveOperationProxyConfig(definition(policy), "search-stays")).toBe(policy);
		expect(resolveOperationProxyConfig(definition(true), "search-stays")).toBe(true);
		expect(resolveOperationProxyConfig(definition(undefined), "search-stays")).toBeUndefined();
	});

	it("applies a scoped policy only to the listed operations", () => {
		const provider = definition(KR_MOBILE_DETAIL_ONLY);
		expect(resolveOperationProxyConfig(provider, "get-stay-detail")).toBe(KR_MOBILE_DETAIL_ONLY);
		expect(resolveOperationProxyConfig(provider, "list-room-rate-plans")).toBe(
			KR_MOBILE_DETAIL_ONLY,
		);
		expect(resolveOperationProxyConfig(provider, "search-stays")).toBeUndefined();
	});

	it("never hands a scoped policy to auth flows and keeps unscoped policies on them", () => {
		const unscoped: ProviderProxyPolicy = { mode: "required", providers: ["nodemaven"] };
		expect(resolveAuthFlowProxyConfig(definition(KR_MOBILE_DETAIL_ONLY))).toBeUndefined();
		expect(resolveAuthFlowProxyConfig(definition(unscoped))).toBe(unscoped);
		expect(resolveAuthFlowProxyConfig(definition(true))).toBe(true);
		expect(resolveAuthFlowProxyConfig(definition(undefined))).toBeUndefined();
	});
});

describe("nodemaven token helpers", () => {
	it("accepts the measured KR carrier slugs and refuses spaces and uppercase", () => {
		for (const slug of ["sk_telecom", "lg_uplus", "kt"]) {
			expect(NODEMAVEN_ISP_SLUG_PATTERN.test(slug)).toBe(true);
		}
		for (const slug of ["SK Telecom", "lg-uplus", "", "LGU+"]) {
			expect(NODEMAVEN_ISP_SLUG_PATTERN.test(slug)).toBe(false);
		}
	});

	it("formats the sticky ttl as XmYs within the documented bounds", () => {
		expect(formatNodemavenTtl(500)).toBe("8m20s");
		expect(formatNodemavenTtl(NODEMAVEN_TTL_SECONDS_MIN)).toBe("1m0s");
		expect(formatNodemavenTtl(NODEMAVEN_TTL_SECONDS_MAX)).toBe("1440m0s");
	});
});

const CREDENTIALS = { username: "acct123", password: "s3cret" } as const;
const ENGINE_CREDENTIALS = {
	APIFUSE__PROXY__NODEMAVEN_USERNAME: CREDENTIALS.username,
	APIFUSE__PROXY__NODEMAVEN_PASSWORD: CREDENTIALS.password,
};

function proxyUsername(url: string): string {
	return decodeURIComponent(new URL(url).username);
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("synthesizeNodemavenProxy: NodeMaven username tokens", () => {
	it("caps the sticky lifetime, expiry and session window at the gateway ttl", () => {
		const now = Date.parse("2026-10-24T00:00:00.000Z");
		const policy: ProviderProxyPolicy = {
			mode: "required",
			providers: ["nodemaven"],
			session: { affinity: "connection", lifetimeMinutes: 120 },
			nodemaven: { type: "mobile", ttlSeconds: 500 },
		};
		const synthesized = synthesizeNodemavenProxy({
			policy,
			credentials: CREDENTIALS,
			affinityKey: "af_con_1",
			protocol: "http",
			attempt: 0,
			windowEpoch: 0,
			now,
		});
		expect(proxyUsername(synthesized.url)).toContain("-ttl-8m20s");
		// 500 s rounds down to 8 whole minutes, inside the gateway's 8m20s.
		expect(synthesized.diagnostics.lifetimeMinutes).toBe(8);
		expect(synthesized.expiresAt).toBe(new Date(now + 8 * 60_000).toISOString());
		const window = nodemavenSessionWindow(policy, now);
		expect(window.windowEpoch).toBe(Math.floor(now / (8 * 60_000)));
		expect(Date.parse(window.expiresAt) - now).toBeLessThanOrEqual(8 * 60_000);

		// Without a ttl, or with a ttl longer than the session, the session lifetime stands.
		const { nodemaven: _ttl, ...withoutTtl } = policy;
		expect(nodemavenSessionWindow(withoutTtl, now).windowEpoch).toBe(
			Math.floor(now / (120 * 60_000)),
		);
		const longTtl = synthesizeNodemavenProxy({
			policy: { ...policy, nodemaven: { ttlSeconds: 86_400 } },
			credentials: CREDENTIALS,
			affinityKey: "af_con_1",
			protocol: "http",
			attempt: 0,
			windowEpoch: 0,
			now,
		});
		expect(longTtl.diagnostics.lifetimeMinutes).toBe(120);
	});

	it("rejects a drain lead that does not fit inside the ttl-capped lifetime", () => {
		const withDrain = (drainLeadSeconds: number) =>
			defineProvider({
				...baseConfig,
				proxy: {
					mode: "required",
					providers: ["nodemaven"],
					session: { affinity: "connection", lifetimeMinutes: 120, drainLeadSeconds },
					nodemaven: { ttlSeconds: 500 },
				},
			});
		expect(() => withDrain(480)).toThrow(/drainLeadSeconds \(480s\).*ttlSeconds allows \(8m\)/);
		expect(() => withDrain(120)).not.toThrow();
	});

	it("encodes the measured KR mobile shape for { type: mobile, isp: [sk_telecom] } with no filter token", () => {
		const synthesized = synthesizeNodemavenProxy({
			policy: {
				mode: "required",
				providers: ["nodemaven"],
				geo: { country: "KR" },
				nodemaven: { type: "mobile", isp: ["sk_telecom"] },
			},
			credentials: CREDENTIALS,
			affinityKey: undefined,
			protocol: "http",
			attempt: 0,
			windowEpoch: 0,
		});

		expect(proxyUsername(synthesized.url)).toMatch(
			/^acct123-country-kr-isp-sk_telecom-type-mobile-ipv4-true-sid-[0-9a-f]{10}$/,
		);
		expect(synthesized.url).not.toContain("-filter-");
		expect(new URL(synthesized.url).hostname).toBe("gate.nodemaven.com");
		expect(new URL(synthesized.url).password).toBe("s3cret");
		expect(synthesized.diagnostics).toMatchObject({
			vendor: "nodemaven",
			type: "mobile",
			isp: "sk_telecom",
		});
		expect("filter" in synthesized.diagnostics).toBe(false);
		expect(JSON.stringify(synthesized.diagnostics)).not.toContain("acct123");
	});

	it("adds a filter tier to a mobile username only when one is configured", () => {
		const synthesized = synthesizeNodemavenProxy({
			policy: { mode: "required", providers: ["nodemaven"], nodemaven: { type: "mobile" } },
			credentials: { ...CREDENTIALS, filter: "high" },
			affinityKey: undefined,
			protocol: "http",
			attempt: 0,
			windowEpoch: 0,
		});
		expect(proxyUsername(synthesized.url)).toMatch(
			/^acct123-type-mobile-ipv4-true-sid-[0-9a-f]{10}-filter-high$/,
		);
	});

	it("picks isp[attempt % isp.length], so proxyAttemptOffset 1 moves to the next carrier with a new sid", async () => {
		const policy: ProviderProxyPolicy = KR_MOBILE_DETAIL_ONLY;
		const resolve = (proxyAttempt: number) =>
			resolveProxyConfigAsync({
				proxyPolicy: policy,
				proxyAttempt,
				engineCredentials: ENGINE_CREDENTIALS,
			});
		const first = await resolve(0);
		const retry = await resolve(1);
		const third = await resolve(2);

		const firstUser = proxyUsername(first.url ?? "");
		const retryUser = proxyUsername(retry.url ?? "");
		expect(firstUser).toMatch(/-isp-sk_telecom-type-mobile-ipv4-true-sid-[0-9a-f]{10}$/);
		expect(retryUser).toMatch(/-isp-lg_uplus-type-mobile-ipv4-true-sid-[0-9a-f]{10}$/);
		expect(proxyUsername(third.url ?? "")).toContain("-isp-sk_telecom-");
		expect(firstUser.split("-sid-")[1]).not.toBe(retryUser.split("-sid-")[1]);
		expect(first.diagnostics).toMatchObject({ attempt: 0, isp: "sk_telecom", type: "mobile" });
		expect(retry.diagnostics).toMatchObject({ attempt: 1, isp: "lg_uplus", type: "mobile" });
	});

	it("keeps the residential token set, sid and port; only -ipv4-true moves ahead of -sid-", () => {
		const policy: ProviderProxyPolicy = {
			mode: "required",
			providers: ["smartproxy", "nodemaven"],
			geo: { country: "KR", subdivision: "Seoul" },
			session: { affinity: "connection", lifetimeMinutes: 120 },
		};
		const synthesized = synthesizeNodemavenProxy({
			policy,
			credentials: CREDENTIALS,
			affinityKey: "af_con_1",
			protocol: "http",
			attempt: 3,
			windowEpoch: 42,
		});

		// The sticky sid and port the earlier releases derived for the same inputs
		// (the window epoch and the attempt took the places of the refresh epoch and
		// the pool index in the same digest).
		const sid = sha256Hex("af_con_1:42:3").slice(0, 10);
		const port = 8080 + (Number.parseInt(sha256Hex(`${sid}:3`).slice(0, 8), 16) % 1001);
		const earlierUsername = `acct123-country-kr-region-seoul-sid-${sid}-filter-medium-ipv4-true`;
		const tokenPairs = (username: string) => {
			const parts = username.split("-").slice(1);
			const pairs: string[] = [];
			for (let index = 0; index < parts.length; index += 2) {
				pairs.push(`${parts[index]}=${parts[index + 1]}`);
			}
			return pairs.sort();
		};

		expect(proxyUsername(synthesized.url)).toBe(
			`acct123-country-kr-region-seoul-ipv4-true-sid-${sid}-filter-medium`,
		);
		expect(tokenPairs(proxyUsername(synthesized.url))).toEqual(tokenPairs(earlierUsername));
		expect(synthesized.sessionId).toBe(sid);
		expect(Number(new URL(synthesized.url).port)).toBe(port);
		expect(synthesized.diagnostics).toMatchObject({ type: "residential", filter: "medium" });
		expect("isp" in synthesized.diagnostics).toBe(false);
	});

	it("encodes -ttl-8m20s for ttlSeconds 500 and keeps every token in the documented order", () => {
		const policy: ProviderProxyPolicy = {
			mode: "required",
			providers: ["nodemaven"],
			geo: { country: "KR", subdivision: "Seoul", city: "Gangnam Gu" },
			session: { affinity: "connection" },
			nodemaven: { type: "mobile", isp: ["lg_uplus"], ttlSeconds: 500 },
		};
		const synthesized = synthesizeNodemavenProxy({
			policy,
			credentials: { ...CREDENTIALS, filter: "medium" },
			affinityKey: "af_con_1",
			protocol: "http",
			attempt: 0,
			windowEpoch: 0,
		});
		const sid = sha256Hex("af_con_1:0:0").slice(0, 10);

		expect(proxyUsername(synthesized.url)).toBe(
			`acct123-country-kr-region-seoul-city-gangnamgu-isp-lg_uplus-type-mobile-ipv4-true-sid-${sid}-ttl-8m20s-filter-medium`,
		);
		const residentialSticky = synthesizeNodemavenProxy({
			policy: { ...policy, nodemaven: { ttlSeconds: 500 } },
			credentials: CREDENTIALS,
			affinityKey: "af_con_1",
			protocol: "http",
			attempt: 0,
			windowEpoch: 0,
		});
		expect(proxyUsername(residentialSticky.url)).toEndWith(
			`-ipv4-true-sid-${sid}-ttl-8m20s-filter-medium`,
		);
	});
});

type FetchCall = { url: string; proxy: string | undefined };

function fetchDouble(calls: FetchCall[]): typeof fetch {
	const implementation = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(input instanceof Request ? input.url : input),
			proxy: (init as (RequestInit & { proxy?: string }) | undefined)?.proxy,
		});
		return Response.json({ name: "ok" });
	};
	return Object.assign(implementation, {
		preconnect: (
			_url: string | URL,
			_options?: { dns?: boolean; tcp?: boolean; http?: boolean },
		) => {},
	});
}

describe("createServerApp: proxy.operations scopes ctx.http, ctx.stealth and resolver egress", () => {
	const READ_UPSTREAM = "https://example.com/stays";

	function scopedProvider() {
		const readOperation = () => ({
			riskClass: READ_RISK_CLASS,
			input: z.object({}),
			output: OutputSchema,
			handler: async (ctx: { http: { get(url: string): Promise<unknown> } }) => {
				await ctx.http.get(READ_UPSTREAM);
				return { name: "ok" };
			},
			fixtures: { request: {}, response: { name: "ok" } },
			healthCheckUnsupported: { reason: "test fixture" },
		});
		const built = defineProvider({
			...baseConfig,
			allowedHosts: ["example.com"],
			http: {},
			proxy: KR_MOBILE_DETAIL_ONLY,
			operations: {
				"search-stays": readOperation(),
				"get-stay-detail": readOperation(),
				"list-room-rate-plans": readOperation(),
			},
		});
		// An auth flow on the same provider: flows are not operations.
		return createProviderDefinitionDouble({
			...built,
			auth: {
				mode: "credentials",
				flow: {
					async start(ctx) {
						await ctx.http.get(READ_UPSTREAM);
						return { kind: "form", turnId: "turn-start", data: {} };
					},
					async continue() {
						return { kind: "complete", turnId: "turn-complete", data: {} };
					},
				},
			},
		});
	}

	async function withEnvironment<T>(
		credentials: boolean,
		calls: FetchCall[],
		run: () => Promise<T>,
	): Promise<T> {
		const originalFetch = global.fetch;
		const saved = {
			username: process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME,
			password: process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD,
			filter: process.env.APIFUSE__PROXY__NODEMAVEN_FILTER,
		};
		const restore = (name: string, value: string | undefined) => {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		};
		if (credentials) {
			process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME = CREDENTIALS.username;
			process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD = CREDENTIALS.password;
		} else {
			delete process.env.APIFUSE__PROXY__NODEMAVEN_USERNAME;
			delete process.env.APIFUSE__PROXY__NODEMAVEN_PASSWORD;
		}
		delete process.env.APIFUSE__PROXY__NODEMAVEN_FILTER;
		global.fetch = fetchDouble(calls);
		try {
			return await run();
		} finally {
			global.fetch = originalFetch;
			restore("APIFUSE__PROXY__NODEMAVEN_USERNAME", saved.username);
			restore("APIFUSE__PROXY__NODEMAVEN_PASSWORD", saved.password);
			restore("APIFUSE__PROXY__NODEMAVEN_FILTER", saved.filter);
		}
	}

	function completedProxy(events: ProviderServerLogEvent[], requestId: string) {
		const completed = events.find(
			(event) => event.event === "provider_request_completed" && event.requestId === requestId,
		);
		expect(completed).toBeDefined();
		return completed && "proxy" in completed ? completed.proxy : undefined;
	}

	it("sends listed operations through the mobile policy and every other context directly", async () => {
		const calls: FetchCall[] = [];
		const events: ProviderServerLogEvent[] = [];
		await withEnvironment(true, calls, async () => {
			const app = createServerApp(scopedProvider(), { logger: (event) => events.push(event) });
			const invoke = (operationId: string) =>
				app.request(`/v1/${operationId}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ requestId: `req_${operationId}`, input: {} }),
				});

			expect((await invoke("get-stay-detail")).status).toBe(200);
			expect((await invoke("list-room-rate-plans")).status).toBe(200);
			expect((await invoke("search-stays")).status).toBe(200);
			const flow = await app.request("/auth/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					requestId: "req_flow",
					flowId: "flow_1",
					providerId: "nol-like",
					context: {},
				}),
			});
			expect(flow.status).toBe(200);
		});

		expect(calls.map((call) => call.url)).toEqual([
			READ_UPSTREAM,
			READ_UPSTREAM,
			READ_UPSTREAM,
			READ_UPSTREAM,
		]);
		const [detail, ratePlans, search, flow] = calls;
		for (const scoped of [detail, ratePlans]) {
			expect(scoped?.proxy).toMatch(
				/^http:\/\/acct123-country-kr-isp-sk_telecom-type-mobile-ipv4-true-sid-[0-9a-f]{10}:s3cret@gate\.nodemaven\.com:\d{4}$/,
			);
		}
		expect(search?.proxy).toBeUndefined();
		expect(flow?.proxy).toBeUndefined();
		expect(completedProxy(events, "req_get-stay-detail")).toMatchObject({
			kind: "resolved",
			provider: "nodemaven",
		});
		// Out of scope there is no proxy resolution at all, as for a provider without `proxy`.
		expect(completedProxy(events, "req_search-stays")).toBeUndefined();
		expect(completedProxy(events, "req_flow")).toBeUndefined();
	});

	it("keeps unlisted operations working when the required policy has no credentials", async () => {
		const calls: FetchCall[] = [];
		const events: ProviderServerLogEvent[] = [];
		await withEnvironment(false, calls, async () => {
			const app = createServerApp(scopedProvider(), { logger: (event) => events.push(event) });
			const invoke = (operationId: string) =>
				app.request(`/v1/${operationId}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ requestId: `req_${operationId}`, input: {} }),
				});

			expect((await invoke("search-stays")).status).toBe(200);
			expect((await invoke("get-stay-detail")).status).toBe(502);
		});
		// Only the unlisted read reached the network; the listed one failed closed.
		expect(calls).toEqual([{ url: READ_UPSTREAM, proxy: undefined }]);
		expect(completedProxy(events, "req_search-stays")).toBeUndefined();
		const failed = events.find(
			(event) =>
				event.event === "provider_request_failed" && event.requestId === "req_get-stay-detail",
		);
		expect(failed && "proxy" in failed ? failed.proxy : undefined).toEqual({
			kind: "unresolved",
			vendors: ["nodemaven"],
			failovers: [{ v: "nodemaven", p: "resolution", r: "no_credentials" }],
		});
	});
});

type WireHit = { mode: "forward" | "connect"; target: string; username: string; password: string };
type WireCall = {
	status: number;
	body: { data?: { name: string; egressAttempts: number } };
	double: WireHit[];
	origin: { path: string; forwardedByDouble: boolean }[];
	logProxy: {
		kind?: string;
		provider?: string;
		attemptSamples?: { a?: number; h?: string; s?: number }[];
	} | null;
};
type Wire = {
	gatewayDoublePort: number;
	searchBefore: WireCall;
	detail: WireCall;
	searchAfter: WireCall;
	gatewayRewrites: { host: string; port: number }[];
};

// A real provider app on the real wreq-js transport, a local stand-in for the
// NodeMaven gateway and a local origin that answers the first stay-detail read
// with a recorded 403 block page. Run in a subprocess so the wreq-js module
// mock in other test files cannot replace the stealth transport.
async function runOperationScopeWire(): Promise<Wire> {
	const subprocess = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("./fixtures/nodemaven-operation-scope-wire.ts", import.meta.url).pathname,
		],
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`nodemaven operation-scope wire fixture failed: ${stderr}`);
	return JSON.parse(stdout);
}

describe("operational assembly: operation-scoped NodeMaven mobile egress on the real transport", () => {
	it("retries a blocked stay-detail read on the next carrier and leaves the unlisted search direct", async () => {
		const wire = await runOperationScopeWire();

		// In scope: two gateway requests, carrier and sid change on the retry.
		expect(wire.detail.status).toBe(200);
		expect(wire.detail.body.data).toEqual({ name: "stay-1", egressAttempts: 2 });
		expect(wire.detail.double).toHaveLength(2);
		const [blocked, passed] = wire.detail.double;
		expect(blocked?.username).toMatch(
			/^acct123-country-kr-isp-sk_telecom-type-mobile-ipv4-true-sid-[0-9a-f]{10}$/,
		);
		expect(passed?.username).toMatch(
			/^acct123-country-kr-isp-lg_uplus-type-mobile-ipv4-true-sid-[0-9a-f]{10}$/,
		);
		expect(blocked?.username.split("-sid-")[1]).not.toBe(passed?.username.split("-sid-")[1]);
		for (const hit of wire.detail.double) {
			expect(hit.password).toBe("s3cret");
			expect(hit.target).toContain("/stays/1/detail");
			expect(hit.username).not.toContain("-filter-");
		}
		expect(wire.detail.origin).toEqual([
			{ path: "/stays/1/detail", forwardedByDouble: true },
			{ path: "/stays/1/detail", forwardedByDouble: true },
		]);
		expect(wire.detail.logProxy).toMatchObject({ kind: "resolved", provider: "nodemaven" });
		// Two fetches of one attempt each; their sessions, and so their URL hashes, differ.
		const samples = wire.detail.logProxy?.attemptSamples ?? [];
		expect(samples.map((sample) => [sample.a, sample.s])).toEqual([
			[1, 403],
			[1, 200],
		]);
		expect(samples[0]?.h).toBeString();
		expect(samples[0]?.h).not.toBe(samples[1]?.h);
		for (const rewrite of wire.gatewayRewrites) {
			expect(rewrite.host).toBe("gate.nodemaven.com");
			expect(rewrite.port).toBeGreaterThanOrEqual(8080);
			expect(rewrite.port).toBeLessThanOrEqual(9080);
		}
		expect(wire.gatewayRewrites).toHaveLength(2);

		// Out of scope, before and after the scoped call: straight to the origin.
		for (const search of [wire.searchBefore, wire.searchAfter]) {
			expect(search.status).toBe(200);
			expect(search.body.data).toEqual({ name: "search", egressAttempts: 1 });
			expect(search.double).toEqual([]);
			expect(search.origin).toEqual([{ path: "/stays/search", forwardedByDouble: false }]);
			expect(search.logProxy).toBeNull();
		}
	}, 30_000);
});
