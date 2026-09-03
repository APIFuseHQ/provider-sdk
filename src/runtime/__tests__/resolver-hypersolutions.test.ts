import { describe, expect, it, spyOn } from "bun:test";

import type { ProviderChallenge } from "../../types.js";
import { createResolverClient } from "../resolver.js";
import { createHypersolutionsResolverVendorAdapter } from "../resolver-vendors/hypersolutions.js";
import type { ResolverVendorTransport } from "../resolver-vendors/types.js";
import { createTraceContext, getTraceRecorder } from "../trace.js";

const API_KEY = "hyper-test-key";
const PAGE_URL = "https://shop.example.com/products/sku-1";
const HARD_SCRIPT_URL =
	"https://shop.example.com/.well-known/sbsd?v=dcc78710-14fe-3835-cc6e-b9b5ea3b6010&t=99543528";
const SCRIPT_BODY = "/* measured SBSD script */";
const USER_AGENT = "Mozilla/5.0 measured-agent";
const ACCEPT_LANGUAGE = "ja,en-US;q=0.9,en;q=0.8";
const SESSION_HEADERS = {
	"User-Agent": USER_AGENT,
	"Accept-Language": ACCEPT_LANGUAGE,
} as const;

const HARD_CHALLENGE = {
	kind: "akamai_sbsd",
	pageUrl: PAGE_URL,
	scriptUrl: HARD_SCRIPT_URL,
	stateCookieName: "sbsd_o",
} satisfies ProviderChallenge;

type TransportCall = {
	readonly url: string;
	readonly init: Parameters<ResolverVendorTransport["fetch"]>[1];
};

function response(
	body: string,
	options: {
		readonly status?: number;
		readonly cookies?: Awaited<ReturnType<ResolverVendorTransport["fetch"]>>["cookies"];
	} = {},
): Awaited<ReturnType<ResolverVendorTransport["fetch"]>> {
	return {
		status: options.status ?? 200,
		headers: { "content-length": String(new TextEncoder().encode(body).byteLength) },
		body,
		cookies: options.cookies ?? [],
	};
}

function createProtocolTransport(stateCookieName: "sbsd_o" | "bm_so" = "sbsd_o"): {
	readonly transport: ResolverVendorTransport;
	readonly calls: TransportCall[];
} {
	const calls: TransportCall[] = [];
	const jar = new Map<string, string>();
	let payloadNumber = 0;
	const transport: ResolverVendorTransport = {
		sessionHeaders: SESSION_HEADERS,
		getCookie(name) {
			return jar.get(name);
		},
		async fetch(url, init) {
			calls.push({ url, init });
			if (url === "https://ip.hypersolutions.co/ip") {
				return response('{"ip":"203.0.113.42"}');
			}
			if (url.includes("/.well-known/sbsd?v=")) {
				jar.set(stateCookieName, "script-established-state");
				return response(SCRIPT_BODY);
			}
			if (url === "https://akm.hypersolutions.co/sbsd") {
				payloadNumber += 1;
				return response(JSON.stringify({ payload: `payload-${payloadNumber}` }));
			}
			if (url.includes("/.well-known/sbsd")) {
				jar.set(stateCookieName, `rotated-state-${payloadNumber}`);
				return response("", {
					cookies: [
						{
							name: stateCookieName,
							value: `rotated-state-${payloadNumber}`,
							expires: 2_000_000_000,
							httpOnly: true,
							secure: true,
						},
					],
				});
			}
			throw new Error("unexpected transport destination");
		},
	};
	return { transport, calls };
}

function createResolver(transport?: ResolverVendorTransport) {
	return createResolverClient({
		adapters: [
			createHypersolutionsResolverVendorAdapter({
				apiKey: API_KEY,
				allowedHosts: ["shop.example.com"],
			}),
		],
		kinds: ["akamai_sbsd"],
		clientProfile: "safari17_0",
		allowedHosts: ["shop.example.com"],
		identity: {
			proxyUrl: "http://proxy.invalid:8080",
			userAgent: "Mozilla/5.0 identity-must-not-win",
		},
		...(transport ? { createTransport: () => transport } : {}),
	});
}

describe("hypersolutions resolver vendor", () => {
	it("runs the measured hard SBSD envelope entirely on the bound transport", async () => {
		const { transport, calls } = createProtocolTransport();
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");
		const directFetch = spyOn(globalThis, "fetch");
		try {
			await expect(
				createResolver(transport).solve(HARD_CHALLENGE, new AbortController().signal, recorder),
			).resolves.toEqual({
				form: "cookies",
				kind: "akamai_sbsd",
				outcome: "payload_accepted_cookies_updated",
				verified: false,
				stateCookieName: "sbsd_o",
				expires: 2_000_000_000,
			});
			expect(directFetch).not.toHaveBeenCalled();
		} finally {
			directFetch.mockRestore();
		}

		expect(calls.map(({ url }) => url)).toEqual([
			"https://ip.hypersolutions.co/ip",
			HARD_SCRIPT_URL,
			"https://akm.hypersolutions.co/sbsd",
			"https://shop.example.com/.well-known/sbsd?t=99543528",
		]);
		const ipCall = calls[0]!;
		expect(ipCall.init.headers).toEqual({
			accept: "application/json, text/plain;q=0.9",
			"x-api-key": API_KEY,
		});
		expect(ipCall.init.redirect).toBe("manual");
		expect(ipCall.init.maxBodyBytes).toBe(4_096);
		expect(calls[1]?.init.headers).toEqual({ ...SESSION_HEADERS, Referer: PAGE_URL });

		const hyperCall = calls[2]!;
		expect(hyperCall.init.method).toBe("POST");
		expect(hyperCall.init.headers).toEqual({
			accept: "application/json",
			"content-type": "application/json",
			"x-api-key": API_KEY,
		});
		expect(JSON.parse(hyperCall.init.body ?? "")).toEqual({
			index: 0,
			uuid: "dcc78710-14fe-3835-cc6e-b9b5ea3b6010",
			o: "script-established-state",
			pageUrl: PAGE_URL,
			userAgent: USER_AGENT,
			script: SCRIPT_BODY,
			ip: "203.0.113.42",
			acceptLanguage: ACCEPT_LANGUAGE,
		});
		const postCall = calls[3]!;
		expect(postCall.init.body).toBe('{"body":"payload-1"}');
		expect(postCall.init.headers).toEqual({
			...SESSION_HEADERS,
			"content-type": "application/json",
			Referer: PAGE_URL,
		});
		const usageSpans = trace.getSpans().filter((span) => span.name === "resolver.usage");
		expect(usageSpans).toHaveLength(1);
		expect(usageSpans[0]?.attributes).toEqual({
			vendor: "hypersolutions",
			challenge_kind: "akamai_sbsd",
			billable_units: 1,
			attempt_index: 1,
			outcome: "success",
			duration_ms: expect.any(Number),
		});
	});

	it("uses indices 0 and 1 for the passive v-only variant and no post query", async () => {
		const { transport, calls } = createProtocolTransport("bm_so");
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");
		const passiveChallenge = {
			...HARD_CHALLENGE,
			scriptUrl: "https://shop.example.com/.well-known/sbsd?v=dcc78710-14fe-3835-cc6e-b9b5ea3b6010",
			stateCookieName: "bm_so",
		} satisfies ProviderChallenge;

		await expect(
			createResolver(transport).solve(passiveChallenge, new AbortController().signal, recorder),
		).resolves.toMatchObject({
			kind: "akamai_sbsd",
			outcome: "payload_accepted_cookies_updated",
			verified: false,
			stateCookieName: "bm_so",
		});
		const hyperBodies = calls
			.filter(({ url }) => url === "https://akm.hypersolutions.co/sbsd")
			.map(({ init }) => JSON.parse(init.body ?? ""));
		expect(hyperBodies.map(({ index }) => index)).toEqual([0, 1]);
		expect(
			calls.filter(
				({ url, init }) =>
					url === "https://shop.example.com/.well-known/sbsd" && init.method === "POST",
			),
		).toHaveLength(2);
		expect(trace.getSpans().filter((span) => span.name === "resolver.usage")).toHaveLength(2);
	});

	it("keeps a remembered v-only script separate from a later cpr_chlge token", async () => {
		const { transport, calls } = createProtocolTransport();
		const rememberedChallenge = {
			...HARD_CHALLENGE,
			scriptUrl: "https://shop.example.com/.well-known/sbsd?v=dcc78710-14fe-3835-cc6e-b9b5ea3b6010",
			challengeToken: "298133469",
		} satisfies ProviderChallenge;

		await expect(createResolver(transport).solve(rememberedChallenge)).resolves.toMatchObject({
			kind: "akamai_sbsd",
			stateCookieName: "sbsd_o",
			verified: false,
		});
		expect(calls.map(({ url }) => url)).toEqual([
			"https://ip.hypersolutions.co/ip",
			"https://shop.example.com/.well-known/sbsd?v=dcc78710-14fe-3835-cc6e-b9b5ea3b6010",
			"https://akm.hypersolutions.co/sbsd",
			"https://shop.example.com/.well-known/sbsd?t=298133469",
		]);
		expect(JSON.parse(calls[2]?.init.body ?? "").index).toBe(0);
	});

	it("fails with missing_transport and never falls back to direct egress", async () => {
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");
		const directFetch = spyOn(globalThis, "fetch");
		directFetch.mockRejectedValue(new Error("direct egress mutant reached global fetch"));
		try {
			await expect(
				createResolver().solve(HARD_CHALLENGE, new AbortController().signal, recorder),
			).rejects.toMatchObject({
				code: "RESOLVER_CHAIN_EXHAUSTED",
				details: [{ vendor: "hypersolutions", reason: "missing_transport" }],
			});
			expect(directFetch).not.toHaveBeenCalled();
		} finally {
			directFetch.mockRestore();
		}
		expect(trace.getSpans().filter((span) => span.name === "resolver.usage")).toHaveLength(0);
	});

	it("admits only provider-declared upstream hosts plus Hyper's two exact hosts", async () => {
		const { transport, calls } = createProtocolTransport();
		await expect(
			createResolver(transport).solve({
				...HARD_CHALLENGE,
				scriptUrl: HARD_SCRIPT_URL.replace("shop.example.com", "attacker.example"),
			}),
		).rejects.toMatchObject({ code: "RESOLVER_HOST_NOT_ALLOWED" });
		expect(calls).toHaveLength(0);
	});

	it("requires the resolver declaration's Akamai client profile", async () => {
		const { transport } = createProtocolTransport();
		const resolver = createResolverClient({
			adapters: [
				createHypersolutionsResolverVendorAdapter({
					apiKey: API_KEY,
					allowedHosts: ["shop.example.com"],
				}),
			],
			kinds: ["akamai_sbsd"],
			allowedHosts: ["shop.example.com"],
			createTransport: () => transport,
		});

		await expect(resolver.solve(HARD_CHALLENGE)).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "hypersolutions", reason: "missing_client_profile" }],
		});
	});

	it("fails typed when the bound transport omits its session headers", async () => {
		const calls: TransportCall[] = [];
		const transport: ResolverVendorTransport = {
			getCookie: () => "state",
			async fetch(url, init) {
				calls.push({ url, init });
				return response("");
			},
		};

		await expect(createResolver(transport).solve(HARD_CHALLENGE)).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "hypersolutions", reason: "missing_client_profile" }],
		});
		expect(calls).toHaveLength(0);
	});

	it("fails typed when the bound transport cannot read its cookie jar", async () => {
		const calls: TransportCall[] = [];
		const transport: ResolverVendorTransport = {
			sessionHeaders: SESSION_HEADERS,
			async fetch(url, init) {
				calls.push({ url, init });
				return response("");
			},
		};

		await expect(createResolver(transport).solve(HARD_CHALLENGE)).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "hypersolutions", reason: "missing_transport" }],
		});
		expect(calls).toHaveLength(0);
	});

	it("rejects an arbitrary SBSD state-cookie name at runtime", async () => {
		const { transport, calls } = createProtocolTransport();
		await expect(
			createResolver(transport).solve({
				...HARD_CHALLENGE,
				// @ts-expect-error test-invalid: runtime validation must reject arbitrary cookie names.
				stateCookieName: "evil",
			}),
		).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [
				{
					vendor: "hypersolutions",
					reason: "missing_challenge_input",
					missingFields: ["stateCookieName"],
				},
			],
		});
		expect(calls).toHaveLength(0);
	});

	it("does not report the payload POST as solved when no state cookie was updated", async () => {
		const jar = new Map<string, string>();
		const transport: ResolverVendorTransport = {
			sessionHeaders: SESSION_HEADERS,
			getCookie: (name) => jar.get(name),
			async fetch(url) {
				if (url === "https://ip.hypersolutions.co/ip") return response("203.0.113.42");
				if (url === "https://akm.hypersolutions.co/sbsd") {
					return response('{"payload":"payload"}');
				}
				if (url.includes("?v=")) {
					jar.set("sbsd_o", "unchanged-state");
					return response(SCRIPT_BODY);
				}
				return response("");
			},
		};
		await expect(createResolver(transport).solve(HARD_CHALLENGE)).rejects.toMatchObject({
			name: "ResolverChallengeVerdictError",
			reason: "solve_failed",
		});
	});

	it("rejects over-limit reflected-IP bodies", async () => {
		let calls = 0;
		const transport: ResolverVendorTransport = {
			sessionHeaders: SESSION_HEADERS,
			getCookie: () => "unreached-state",
			async fetch() {
				calls += 1;
				return response("x".repeat(4_097));
			},
		};
		await expect(createResolver(transport).solve(HARD_CHALLENGE)).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [{ vendor: "hypersolutions", reason: "transport_failure", phase: "measure_ip" }],
		});
		expect(calls).toBe(1);
	});
});
