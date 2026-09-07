import { describe, expect, it, spyOn } from "bun:test";

import { ProviderError } from "../../errors.js";
import { ResolverTelemetryCollector } from "../resolver-telemetry.js";
import type { ProviderChallenge } from "../../types.js";
import { createResolverClient } from "../resolver.js";
import { createHypersolutionsResolverVendorAdapter } from "../resolver-vendors/hypersolutions.js";
import type {
	ResolverVendorTransport,
	ResolverVendorUnavailableReason,
} from "../resolver-vendors/types.js";

const API_KEY = "hyper-test-key";
const PAGE_URL = "https://shop.example.com/products/sku-1";
const HARD_SCRIPT_URL =
	"https://shop.example.com/.well-known/sbsd?v=dcc78710-14fe-3835-cc6e-b9b5ea3b6010&t=99543528";
const HYPER_SBSD_URL = "https://akm.hypersolutions.co/sbsd";
const HYPER_IP_URL = "https://ip.hypersolutions.co/ip";
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

type DirectCall = { readonly url: string; readonly init: RequestInit | undefined };

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

/** Direct egress stub for the Hyper payload POST; anything else is a routing mutant. */
function createDirectFetch(
	respond: (call: DirectCall, callNumber: number) => Response = (_call, callNumber) =>
		Response.json({ payload: `payload-${callNumber}` }),
): { readonly fetchImpl: typeof fetch; readonly calls: DirectCall[] } {
	const calls: DirectCall[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const call = { url, init };
		calls.push(call);
		if (url !== HYPER_SBSD_URL) throw new Error(`direct egress reached ${url}`);
		return respond(call, calls.length);
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function createProtocolTransport(
	stateCookieName: "sbsd_o" | "bm_so" = "sbsd_o",
	options: { readonly rotateStateCookie?: boolean } = {},
): {
	readonly transport: ResolverVendorTransport;
	readonly calls: TransportCall[];
} {
	const calls: TransportCall[] = [];
	const jar = new Map<string, string>();
	let postNumber = 0;
	const transport: ResolverVendorTransport = {
		sessionHeaders: SESSION_HEADERS,
		getCookie(name) {
			return jar.get(name);
		},
		async fetch(url, init) {
			calls.push({ url, init });
			if (url === HYPER_IP_URL) {
				return response('{"ip":"203.0.113.42"}');
			}
			if (url.includes("/.well-known/sbsd?v=")) {
				jar.set(stateCookieName, "script-established-state");
				return response(SCRIPT_BODY);
			}
			if (url.includes("/.well-known/sbsd")) {
				postNumber += 1;
				if (options.rotateStateCookie === false) return response("");
				jar.set(stateCookieName, `rotated-state-${postNumber}`);
				return response("", {
					cookies: [
						{
							name: stateCookieName,
							value: `rotated-state-${postNumber}`,
							expires: 2_000_000_000,
							httpOnly: true,
							secure: true,
						},
					],
				});
			}
			throw new Error(`unexpected bound transport destination ${url}`);
		},
	};
	return { transport, calls };
}

function observedResolver(options: Parameters<typeof createResolverClient>[0]) {
	const telemetry = new ResolverTelemetryCollector();
	return Object.assign(createResolverClient({ ...options, telemetry }), { telemetry });
}

async function expectExhausted(
	resolver: ReturnType<typeof observedResolver>,
	challenge: ProviderChallenge,
	expected: {
		readonly vendor: "hypersolutions";
		readonly reason: ResolverVendorUnavailableReason;
		readonly missingFields?: readonly string[];
		readonly phase?: string;
		readonly round?: number;
	},
) {
	const error: unknown = await resolver.solve(challenge).catch((cause: unknown) => cause);
	expect(error).toBeInstanceOf(ProviderError);
	if (!(error instanceof ProviderError)) throw error;
	expect(error.code).toBe("RESOLVER_CHAIN_EXHAUSTED");
	expect(error.details).toEqual({
		challengeKind: "akamai_sbsd",
		attempts: 1,
		outcome: "exhausted",
		retryable: false,
	});
	const log = resolver.telemetry.toLogPayload()!;
	const attempt = log.attemptSamples?.[0];
	expect(log.attempts).toBe(1);
	expect(attempt?.v).toBe(expected.vendor);
	expect(attempt?.e).toBe(expected.reason);
	if (expected.missingFields !== undefined) {
		expect(attempt?.diagnostics?.missingFields).toEqual(expected.missingFields);
	}
	if (expected.phase !== undefined) expect(attempt?.diagnostics?.phase).toBe(expected.phase);
	if (expected.round !== undefined) expect(attempt?.diagnostics?.round).toBe(expected.round);
}

function createResolver(
	transport?: ResolverVendorTransport,
	fetchImpl: typeof fetch = createDirectFetch().fetchImpl,
) {
	return observedResolver({
		adapters: [
			createHypersolutionsResolverVendorAdapter({
				apiKey: API_KEY,
				allowedHosts: ["shop.example.com"],
				fetchImpl,
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
	it("runs the measured hard SBSD envelope: upstream and /ip bound, Hyper /sbsd direct", async () => {
		const { transport, calls } = createProtocolTransport();
		const direct = createDirectFetch();
		const globalFetch = spyOn(globalThis, "fetch");
		try {
			await expect(
				createResolver(transport, direct.fetchImpl).solve(HARD_CHALLENGE),
			).resolves.toEqual({
				form: "cookie_state",
				kind: "akamai_sbsd",
				outcome: "payload_accepted",
				verified: false,
				stateCookieName: "sbsd_o",
				expires: 2_000_000_000,
			});
			expect(globalFetch).not.toHaveBeenCalled();
		} finally {
			globalFetch.mockRestore();
		}

		expect(calls.map(({ url }) => url)).toEqual([
			HYPER_IP_URL,
			HARD_SCRIPT_URL,
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

		expect(direct.calls.map(({ url }) => url)).toEqual([HYPER_SBSD_URL]);
		const hyperCall = direct.calls[0]!;
		expect(hyperCall.init?.method).toBe("POST");
		expect(hyperCall.init?.redirect).toBe("error");
		expect(hyperCall.init?.headers).toEqual({
			accept: "application/json",
			"content-type": "application/json",
			"x-api-key": API_KEY,
		});
		expect(JSON.parse(String(hyperCall.init?.body))).toEqual({
			index: 0,
			uuid: "dcc78710-14fe-3835-cc6e-b9b5ea3b6010",
			o: "script-established-state",
			pageUrl: PAGE_URL,
			userAgent: USER_AGENT,
			script: SCRIPT_BODY,
			ip: "203.0.113.42",
			acceptLanguage: ACCEPT_LANGUAGE,
		});
		const postCall = calls[2]!;
		expect(postCall.init.body).toBe('{"body":"payload-1"}');
		expect(postCall.init.headers).toEqual({
			...SESSION_HEADERS,
			"content-type": "application/json",
			Referer: PAGE_URL,
		});
	});

	it("uses indices 0 and 1 for the passive v-only variant and no post query", async () => {
		const { transport, calls } = createProtocolTransport("bm_so");
		const direct = createDirectFetch();
		const passiveChallenge = {
			...HARD_CHALLENGE,
			scriptUrl: "https://shop.example.com/.well-known/sbsd?v=dcc78710-14fe-3835-cc6e-b9b5ea3b6010",
			stateCookieName: "bm_so",
		} satisfies ProviderChallenge;

		await expect(
			createResolver(transport, direct.fetchImpl).solve(passiveChallenge),
		).resolves.toMatchObject({
			kind: "akamai_sbsd",
			outcome: "payload_accepted",
			verified: false,
			stateCookieName: "bm_so",
		});
		const hyperBodies = direct.calls.map(({ init }) => JSON.parse(String(init?.body)));
		expect(hyperBodies.map(({ index }) => index)).toEqual([0, 1]);
		expect(
			calls.filter(
				({ url, init }) =>
					url === "https://shop.example.com/.well-known/sbsd" && init.method === "POST",
			),
		).toHaveLength(2);
	});

	it("keeps a remembered v-only script separate from a later cpr_chlge token", async () => {
		const { transport, calls } = createProtocolTransport();
		const direct = createDirectFetch();
		const rememberedChallenge = {
			...HARD_CHALLENGE,
			scriptUrl: "https://shop.example.com/.well-known/sbsd?v=dcc78710-14fe-3835-cc6e-b9b5ea3b6010",
			challengeToken: "298133469",
		} satisfies ProviderChallenge;

		await expect(
			createResolver(transport, direct.fetchImpl).solve(rememberedChallenge),
		).resolves.toMatchObject({
			kind: "akamai_sbsd",
			stateCookieName: "sbsd_o",
			verified: false,
		});
		expect(calls.map(({ url }) => url)).toEqual([
			HYPER_IP_URL,
			"https://shop.example.com/.well-known/sbsd?v=dcc78710-14fe-3835-cc6e-b9b5ea3b6010",
			"https://shop.example.com/.well-known/sbsd?t=298133469",
		]);
		expect(JSON.parse(String(direct.calls[0]?.init?.body)).index).toBe(0);
	});

	it("reports payload_accepted even when the state cookie did not rotate", async () => {
		// The measured source and Hyper's docs verify only through the next protected
		// GET; a non-rotating cookie is not a failure signal (Phase 2 refetch decides).
		const { transport } = createProtocolTransport("sbsd_o", { rotateStateCookie: false });
		await expect(createResolver(transport).solve(HARD_CHALLENGE)).resolves.toEqual({
			form: "cookie_state",
			kind: "akamai_sbsd",
			outcome: "payload_accepted",
			verified: false,
			stateCookieName: "sbsd_o",
		});
	});

	it("fails with missing_transport before any egress: the upstream is never fetched directly", async () => {
		const direct = createDirectFetch();
		const globalFetch = spyOn(globalThis, "fetch");
		globalFetch.mockRejectedValue(new Error("direct egress mutant reached global fetch"));
		try {
			await expectExhausted(createResolver(undefined, direct.fetchImpl), HARD_CHALLENGE, {
				vendor: "hypersolutions",
				reason: "missing_transport",
			});
			expect(globalFetch).not.toHaveBeenCalled();
			expect(direct.calls).toHaveLength(0);
		} finally {
			globalFetch.mockRestore();
		}
	});

	it("admits only provider-declared upstream hosts plus Hyper's exact /ip host", async () => {
		const { transport, calls } = createProtocolTransport();
		expect(
			createHypersolutionsResolverVendorAdapter({ apiKey: API_KEY, allowedHosts: [] })
				.transportAllowedHosts,
		).toEqual(["ip.hypersolutions.co"]);
		await expect(
			createResolver(transport).solve({
				...HARD_CHALLENGE,
				scriptUrl: HARD_SCRIPT_URL.replace("shop.example.com", "attacker.example"),
			}),
		).rejects.toMatchObject({ code: "RESOLVER_HOST_NOT_ALLOWED" });
		expect(calls).toHaveLength(0);
	});

	it("rejects a script URL from another declared origin as incomplete challenge input", async () => {
		const { transport, calls } = createProtocolTransport();
		const resolver = observedResolver({
			adapters: [
				createHypersolutionsResolverVendorAdapter({
					apiKey: API_KEY,
					allowedHosts: ["shop.example.com", "cdn.example.com"],
				}),
			],
			kinds: ["akamai_sbsd"],
			clientProfile: "safari17_0",
			allowedHosts: ["shop.example.com", "cdn.example.com"],
			createTransport: () => transport,
		});
		await expectExhausted(
			resolver,
			{
				...HARD_CHALLENGE,
				scriptUrl: HARD_SCRIPT_URL.replace("shop.example.com", "cdn.example.com"),
			},
			{
				vendor: "hypersolutions",
				reason: "missing_challenge_input",
				missingFields: ["scriptUrl"],
			},
		);
		expect(calls).toHaveLength(0);
	});

	it("keeps the validated script host when its pathname is a network-path reference", async () => {
		// `//ip.hypersolutions.co/...` passes the host allowlist and the same-origin check
		// as shop.example.com; rebuilding the URL from `pathname` + `origin` would have
		// swapped the host to one the restricted transport admits for `/ip`.
		const calls: string[] = [];
		const transport: ResolverVendorTransport = {
			sessionHeaders: SESSION_HEADERS,
			getCookie: () => "script-established-state",
			async fetch(url) {
				calls.push(url);
				return response(url === HYPER_IP_URL ? '{"ip":"203.0.113.42"}' : SCRIPT_BODY);
			},
		};
		const scriptUrl = HARD_SCRIPT_URL.replace("/.well-known/sbsd", "//ip.hypersolutions.co/sbsd");
		expect(new URL(scriptUrl).pathname).toBe("//ip.hypersolutions.co/sbsd");

		await expect(
			createResolver(transport).solve({ ...HARD_CHALLENGE, scriptUrl }),
		).resolves.toMatchObject({ form: "cookie_state", outcome: "payload_accepted" });

		expect(calls).toEqual([
			HYPER_IP_URL,
			scriptUrl,
			"https://shop.example.com//ip.hypersolutions.co/sbsd?t=99543528",
		]);
		for (const url of calls.slice(1)) expect(new URL(url).host).toBe("shop.example.com");
	});

	it("propagates a caller abort instead of classifying it as transport_failure", async () => {
		const controller = new AbortController();
		const transport: ResolverVendorTransport = {
			sessionHeaders: SESSION_HEADERS,
			getCookie: () => "unreached-state",
			async fetch(_url, init) {
				controller.abort();
				throw init.signal.reason;
			},
		};
		const adapter = createHypersolutionsResolverVendorAdapter({
			apiKey: API_KEY,
			allowedHosts: ["shop.example.com"],
		});
		const rejection: unknown = await adapter
			.solve(HARD_CHALLENGE, undefined, controller.signal, undefined, transport)
			.catch((error: unknown) => error);
		expect(rejection).toBe(controller.signal.reason);
	});

	it("requires the resolver declaration's Akamai client profile", async () => {
		const { transport } = createProtocolTransport();
		const resolver = observedResolver({
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

		const error: unknown = await resolver.solve(HARD_CHALLENGE).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(ProviderError);
		if (!(error instanceof ProviderError)) throw error;
		expect(error.code).toBe("RESOLVER_CHAIN_EXHAUSTED");
		expect(error.details).toEqual({
			challengeKind: "akamai_sbsd",
			attempts: 0,
			outcome: "exhausted",
			retryable: false,
		});
		expect(resolver.telemetry.toLogPayload()).toEqual({
			outcome: "exhausted",
			challengeKind: "akamai_sbsd",
			identitySource: "none",
			identityFailure: "missing_client_profile",
			solveMs: expect.any(Number),
			attempts: 0,
			failovers: 0,
			vendorChain: [],
			pollCount: 0,
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

		await expectExhausted(createResolver(transport), HARD_CHALLENGE, {
			vendor: "hypersolutions",
			reason: "missing_client_profile",
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

		await expectExhausted(createResolver(transport), HARD_CHALLENGE, {
			vendor: "hypersolutions",
			reason: "missing_transport",
		});
		expect(calls).toHaveLength(0);
	});

	it("rejects an arbitrary SBSD state-cookie name at runtime", async () => {
		const { transport, calls } = createProtocolTransport();
		await expectExhausted(
			createResolver(transport),
			{
				...HARD_CHALLENGE,
				// @ts-expect-error test-invalid: runtime validation must reject arbitrary cookie names.
				stateCookieName: "evil",
			},
			{
				vendor: "hypersolutions",
				reason: "missing_challenge_input",
				missingFields: ["stateCookieName"],
			},
		);
		expect(calls).toHaveLength(0);
	});

	it.each([
		[401, "missing_credentials"],
		[503, "transport_failure"],
	] as const)("classifies a %i from Hyper's /ip reflector as %s", async (status, reason) => {
		const calls: string[] = [];
		const transport: ResolverVendorTransport = {
			sessionHeaders: SESSION_HEADERS,
			getCookie: () => "unreached-state",
			async fetch(url) {
				calls.push(url);
				return response("", { status });
			},
		};
		await expectExhausted(createResolver(transport), HARD_CHALLENGE, {
			vendor: "hypersolutions",
			reason,
			phase: "measure_ip",
		});
		expect(calls).toEqual([HYPER_IP_URL]);
	});

	it("classifies a failed Hyper payload generation as transport_failure without posting upstream", async () => {
		const { transport, calls } = createProtocolTransport();
		const direct = createDirectFetch(() => new Response("upstream busy", { status: 502 }));
		await expectExhausted(createResolver(transport, direct.fetchImpl), HARD_CHALLENGE, {
			vendor: "hypersolutions",
			reason: "transport_failure",
			phase: "generate_payload",
		});
		expect(direct.calls).toHaveLength(1);
		expect(calls.map(({ url }) => url)).toEqual([HYPER_IP_URL, HARD_SCRIPT_URL]);
	});

	it("classifies a Hyper 2xx without a payload field as transport_failure", async () => {
		const { transport } = createProtocolTransport();
		const direct = createDirectFetch(() => Response.json({ error: "no payload" }));
		await expectExhausted(createResolver(transport, direct.fetchImpl), HARD_CHALLENGE, {
			vendor: "hypersolutions",
			reason: "transport_failure",
			phase: "generate_payload",
			round: 1,
		});
	});

	it("reports an upstream refusal of the script GET as a solve verdict, not a transport fault", async () => {
		const transport: ResolverVendorTransport = {
			sessionHeaders: SESSION_HEADERS,
			getCookie: () => "state",
			async fetch(url) {
				return url === HYPER_IP_URL ? response("203.0.113.42") : response("", { status: 403 });
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
		await expectExhausted(createResolver(transport), HARD_CHALLENGE, {
			vendor: "hypersolutions",
			reason: "transport_failure",
			phase: "measure_ip",
		});
		expect(calls).toBe(1);
	});

	it("classifies a Hyper body that fails mid-read as transport_failure", async () => {
		const { transport, calls } = createProtocolTransport();
		const direct = createDirectFetch(
			() =>
				new Response(
					new ReadableStream({
						pull(controller) {
							controller.error(new Error("connection reset while reading"));
						},
					}),
					{ status: 200 },
				),
		);
		await expectExhausted(createResolver(transport, direct.fetchImpl), HARD_CHALLENGE, {
			vendor: "hypersolutions",
			reason: "transport_failure",
			phase: "generate_payload",
		});
		expect(calls.filter(({ init }) => init.method === "POST")).toHaveLength(0);
	});

	it("cancels a Hyper response whose declared length exceeds the bound", async () => {
		const { transport } = createProtocolTransport();
		let cancelled = false;
		const direct = createDirectFetch(
			() =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
					{ status: 200, headers: { "content-length": "1000001" } },
				),
		);
		await expectExhausted(createResolver(transport, direct.fetchImpl), HARD_CHALLENGE, {
			vendor: "hypersolutions",
			reason: "transport_failure",
			phase: "generate_payload",
		});
		expect(cancelled).toBe(true);
	});

	it("rejects an over-limit Hyper payload response", async () => {
		const { transport, calls } = createProtocolTransport();
		const direct = createDirectFetch(
			() => new Response(`{"payload":"${"x".repeat(1_000_000)}"}`, { status: 200 }),
		);
		await expectExhausted(createResolver(transport, direct.fetchImpl), HARD_CHALLENGE, {
			vendor: "hypersolutions",
			reason: "transport_failure",
			phase: "generate_payload",
		});
		expect(calls.filter(({ init }) => init.method === "POST")).toHaveLength(0);
	});
});
