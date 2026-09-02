import { describe, expect, it, spyOn } from "bun:test";

import type { ProviderChallenge } from "../../types.js";
import { createResolverClient } from "../resolver.js";
import { createHypersolutionsResolverVendorAdapter } from "../resolver-vendors/hypersolutions.js";
import type { ResolverVendorTransport } from "../resolver-vendors/types.js";

const API_KEY = "hyper-test-key";
const PAGE_URL = "https://shop.example.com/products/sku-1";
const HARD_SCRIPT_URL =
	"https://shop.example.com/.well-known/sbsd?v=dcc78710-14fe-3835-cc6e-b9b5ea3b6010&t=99543528";
const SCRIPT_BODY = "/* measured SBSD script */";

const HARD_CHALLENGE = {
	kind: "akamai_sbsd",
	pageUrl: PAGE_URL,
	scriptUrl: HARD_SCRIPT_URL,
	stateCookieName: "sbsd_o",
	stateCookieValue: "state-cookie-value",
	acceptLanguage: "ja,en-US;q=0.9,en;q=0.8",
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

function createProtocolTransport(): {
	readonly transport: ResolverVendorTransport;
	readonly calls: TransportCall[];
} {
	const calls: TransportCall[] = [];
	let payloadNumber = 0;
	const transport: ResolverVendorTransport = {
		async fetch(url, init) {
			calls.push({ url, init });
			if (url === "https://ip.hypersolutions.co/ip") {
				return response('{"ip":"203.0.113.42"}');
			}
			if (url.includes("/.well-known/sbsd?v=")) return response(SCRIPT_BODY);
			if (url === "https://akm.hypersolutions.co/sbsd") {
				payloadNumber += 1;
				return response(JSON.stringify({ payload: `payload-${payloadNumber}` }));
			}
			if (url.includes("/.well-known/sbsd")) {
				return response("", {
					cookies: [
						{
							name: "sbsd_o",
							value: `rotated-state-${payloadNumber}`,
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
		allowedHosts: ["shop.example.com"],
		identity: {
			proxyUrl: "http://proxy.invalid:8080",
			userAgent: "Mozilla/5.0 measured-agent",
		},
		...(transport ? { transport } : {}),
	});
}

describe("hypersolutions resolver vendor", () => {
	it("runs the measured hard SBSD envelope entirely on the bound transport", async () => {
		const { transport, calls } = createProtocolTransport();
		const directFetch = spyOn(globalThis, "fetch");
		try {
			await expect(createResolver(transport).solve(HARD_CHALLENGE)).resolves.toEqual({
				form: "cookies",
				cookies: { sbsd_o: "rotated-state-1" },
				userAgent: "Mozilla/5.0 measured-agent",
				outcome: "payload_accepted_cookies_updated",
				verified: false,
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
			o: "state-cookie-value",
			pageUrl: PAGE_URL,
			userAgent: "Mozilla/5.0 measured-agent",
			script: SCRIPT_BODY,
			ip: "203.0.113.42",
			acceptLanguage: "ja,en-US;q=0.9,en;q=0.8",
		});
		const postCall = calls[3]!;
		expect(postCall.init.body).toBe('{"body":"payload-1"}');
		expect(postCall.init.headers).toEqual({
			"content-type": "application/json",
			Referer: PAGE_URL,
		});
	});

	it("uses indices 0 and 1 for the passive v-only variant and no post query", async () => {
		const { transport, calls } = createProtocolTransport();
		const passiveChallenge = {
			...HARD_CHALLENGE,
			scriptUrl: "https://shop.example.com/.well-known/sbsd?v=dcc78710-14fe-3835-cc6e-b9b5ea3b6010",
			stateCookieName: "bm_so",
		} satisfies ProviderChallenge;

		await expect(createResolver(transport).solve(passiveChallenge)).resolves.toMatchObject({
			cookies: { sbsd_o: "rotated-state-2" },
			outcome: "payload_accepted_cookies_updated",
			verified: false,
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
	});

	it("fails with missing_transport and never falls back to direct egress", async () => {
		const directFetch = spyOn(globalThis, "fetch");
		try {
			await expect(createResolver().solve(HARD_CHALLENGE)).rejects.toMatchObject({
				code: "RESOLVER_CHAIN_EXHAUSTED",
				details: [{ vendor: "hypersolutions", reason: "missing_transport" }],
			});
			expect(directFetch).not.toHaveBeenCalled();
		} finally {
			directFetch.mockRestore();
		}
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

	it("does not report the payload POST as solved when no state cookie was updated", async () => {
		const transport: ResolverVendorTransport = {
			async fetch(url) {
				if (url === "https://ip.hypersolutions.co/ip") return response("203.0.113.42");
				if (url === "https://akm.hypersolutions.co/sbsd") {
					return response('{"payload":"payload"}');
				}
				if (url.includes("?v=")) return response(SCRIPT_BODY);
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
