import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { extractProviderContract } from "../contract.js";
import { ValidationError } from "../errors.js";
import {
	createSessionStateResponseView,
	matchesResponse,
	splitJoinedSetCookie,
	withoutCookieExpiry,
} from "../runtime/session-state.js";
import { SESSION_STATE_DEFAULTS } from "../runtime/session-state-defaults.js";
import { parseSessionStateDurationMs } from "../runtime/session-state-duration.js";
import { CLOUDFLARE_BLOCK_PAGE, sessionStatePresets } from "../runtime/session-state-presets.js";
import { createServerApp } from "../server/serve.js";
import type { HttpClient, OperationRiskClass, ProviderSessionState } from "../types.js";
import { defineTestProvider as defineProvider } from "./test-utils.js";

const READ_RISK_CLASS: OperationRiskClass = "read";
const Schema = z.object({ id: z.string() });

function operation() {
	return {
		riskClass: READ_RISK_CLASS,
		descriptionKey: "operations.operation.description",
		input: Schema,
		output: Schema,
		handler: async (_ctx: unknown, input: unknown) => Schema.parse(input),
		fixtures: { request: { id: "a" }, response: { id: "a" } },
		healthCheckUnsupported: { reason: "test fixture" },
	};
}

const HOST = "stays.example";
const baseConfig = {
	id: "session-state-unit",
	version: "1.0.0",
	runtime: "standard" as const,
	allowedHosts: [HOST, "api.example"],
	reviewed: "community" as const,
	meta: {
		displayName: "Session state unit",
		descriptionKey: "meta.description",
		category: "travel",
	},
	operations: {
		"get-stay-detail": operation(),
		"search-stays": operation(),
	},
};

const blockPageView = createSessionStateResponseView({
	url: `https://${HOST}/stays/1`,
	status: 403,
	headers: {
		Server: "cloudflare",
		"CF-Ray": "a4e864499984d1cd-ICN",
		"Content-Type": "text/html; charset=UTF-8",
	},
	body: "<table><tr><td>RayID</td><td>a4e8</td></tr></table>",
});

const preset = (
	overrides: Partial<Parameters<typeof sessionStatePresets.cloudflareBlockPage>[0]> = {},
) =>
	sessionStatePresets.cloudflareBlockPage({
		hosts: [HOST],
		operations: ["get-stay-detail"],
		ttl: "20m",
		...overrides,
	});

describe("session state: matchers", () => {
	it("CLOUDFLARE_BLOCK_PAGE accepts the recorded block page and rejects a JSON 403", () => {
		expect(matchesResponse(CLOUDFLARE_BLOCK_PAGE, blockPageView)).toBe(true);
		const json403 = createSessionStateResponseView({
			url: `https://${HOST}/stays/1`,
			status: 403,
			headers: { server: "cloudflare", "cf-ray": "x", "content-type": "application/json" },
			body: '{"error":"RayID"}',
		});
		expect(matchesResponse(CLOUDFLARE_BLOCK_PAGE, json403)).toBe(false);
		const served = createSessionStateResponseView({ ...blockPageView, status: 200 });
		expect(matchesResponse(CLOUDFLARE_BLOCK_PAGE, served)).toBe(false);
	});

	it("ANDs fields inside a matcher: status ranges, header presence and patterns, body regex, json paths", () => {
		const view = createSessionStateResponseView({
			url: "https://api.example/items",
			status: 401,
			headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
			body: '{"error":{"code":"TOKEN_EXPIRED","retry":false,"items":[{"id":7}]}}',
		});
		expect(matchesResponse({ status: { min: 400, max: 499 } }, view)).toBe(true);
		expect(
			matchesResponse({ status: [401, 403], headers: { "www-authenticate": true } }, view),
		).toBe(true);
		expect(
			matchesResponse({ headers: { "www-authenticate": { pattern: "invalid_token" } } }, view),
		).toBe(true);
		expect(matchesResponse({ bodyPattern: "TOKEN_[A-Z]+" }, view)).toBe(true);
		expect(
			matchesResponse(
				{ json: { "error.code": "TOKEN_EXPIRED", "error.retry": false, "error.items.0.id": 7 } },
				view,
			),
		).toBe(true);
		expect(matchesResponse({ json: { "error.code": { pattern: "^TOKEN_" } } }, view)).toBe(true);
		expect(matchesResponse({ status: 401, json: { "error.code": "OTHER" } }, view)).toBe(false);
		expect(matchesResponse({ status: 500 }, view)).toBe(false);
		const html = createSessionStateResponseView({ ...view, body: "<html>" });
		expect(matchesResponse({ json: { "error.code": "TOKEN_EXPIRED" } }, html)).toBe(false);
	});

	it("splits a joined Set-Cookie value without breaking an Expires date", () => {
		expect(
			splitJoinedSetCookie(
				"__cf_bm=abc; Expires=Tue, 27 Oct 2026 05:00:00 GMT; Path=/, other=1; HttpOnly",
			),
		).toEqual(["__cf_bm=abc; Expires=Tue, 27 Oct 2026 05:00:00 GMT; Path=/", "other=1; HttpOnly"]);
	});

	it("parses the shared duration grammar", () => {
		expect(parseSessionStateDurationMs("20m")).toBe(1_200_000);
		expect(parseSessionStateDurationMs("PT20M")).toBe(1_200_000);
		expect(parseSessionStateDurationMs("400ms")).toBe(400);
		expect(parseSessionStateDurationMs("0s")).toBeUndefined();
		expect(parseSessionStateDurationMs("soon")).toBeUndefined();
	});
});

describe("session state: presets are plain declarations", () => {
	it("cloudflareBlockPage returns the common shape with the SDK default re-acquisition count", () => {
		expect(preset({ qps: 2, idleTtl: "10m" })).toEqual({
			acquire: { from: "response", capture: { cookies: ["__cf_bm"] } },
			carry: { as: "cookies" },
			validity: {
				ttl: "20m",
				idleTtl: "10m",
				invalidWhen: CLOUDFLARE_BLOCK_PAGE,
				reacquire: SESSION_STATE_DEFAULTS.presetReacquire,
			},
			distribute: { hosts: [HOST], operations: ["get-stay-detail"], qps: 2 },
		});
		expect(preset({ reacquire: 0 }).validity.reacquire).toBe(0);
	});
});

describe("session state: defineProvider", () => {
	it("accepts the preset, a direct declaration and the four example shapes", () => {
		const direct: ProviderSessionState = {
			acquire: { from: "response", capture: { cookies: ["edge_session"] } },
			carry: { as: "cookies" },
			validity: {
				idleTtl: "10m",
				invalidWhen: { status: 429, headers: { "x-edge-denied": true } },
			},
			distribute: { hosts: [HOST], operations: ["get-stay-detail"] },
		};
		const guest: ProviderSessionState = {
			acquire: {
				from: "request",
				request: { url: "https://api.example/guest/token", method: "POST", client: "http" },
				capture: {
					json: { token: "data.accessToken" },
					expiresAt: { json: "data.expiresIn", unit: "seconds-from-now" },
				},
			},
			carry: { as: "header", name: "authorization", value: "token", format: "Bearer {value}" },
			validity: { invalidWhen: { status: 401 }, reacquire: 1 },
			distribute: { hosts: ["api.example"], qps: 5 },
		};
		const member: ProviderSessionState = {
			acquire: {
				from: "credential",
				capture: {
					credential: { session: "session", token: "access_token" },
					expiresAt: { credential: "expires_at", unit: "iso" },
				},
			},
			carry: [
				{ as: "cookie", name: "sid", value: "session" },
				{ as: "header", name: "x-session-token", value: "token" },
			],
			validity: { invalidWhen: (response) => response.status === 401 },
			distribute: { hosts: [HOST], scope: "connection" },
		};
		const provider = defineProvider({
			...baseConfig,
			credential: {
				keys: ["session", "access_token", "expires_at"],
				storesReusableSecret: true,
				justification: "unit fixture: the session is the stored credential",
			},
			sessionState: { stayEdge: preset(), other: direct, guest, member },
		});
		expect(Object.keys(provider.sessionState ?? {})).toEqual([
			"stayEdge",
			"other",
			"guest",
			"member",
		]);
	});

	it("leaves a provider without sessionState without the key", () => {
		expect("sessionState" in defineProvider(baseConfig)).toBe(false);
	});

	const rejects = (sessionState: unknown, pattern: RegExp, extra: Record<string, unknown> = {}) =>
		expect(() =>
			// test-invalid: the declarations below are deliberately malformed.
			defineProvider({ ...baseConfig, ...extra, sessionState } as never),
		).toThrow(pattern);

	it("rejects shapes the runtime cannot honour", () => {
		expect(() =>
			// test-invalid: an unknown field is the point of this declaration.
			defineProvider({ ...baseConfig, sessionState: { edge: { ...preset(), extra: 1 } } } as never),
		).toThrow(ValidationError);
		rejects({ edge: { ...preset(), extra: 1 } }, /unknown field "extra"/);
		rejects({}, /non-empty object/);
		rejects(
			{ edge: preset({ hosts: ["elsewhere.example"] }) },
			/"elsewhere\.example" is not in allowedHosts/,
		);
		rejects(
			{ edge: preset({ operations: ["get-stay-detail", "missing-op"] }) },
			/distribute\.operations.*"missing-op" is not a declared operation/,
		);
		rejects(
			{ edge: { ...preset(), validity: { reacquire: 1 } } },
			/must bound the state with ttl, idleTtl, maxUses, invalidWhen or capture\.expiresAt/,
		);
		rejects(
			{
				edge: {
					...preset(),
					carry: { as: "header", name: "authorization", value: "token" },
				},
			},
			/"token" is not a value the capture produces/,
		);
		rejects(
			{
				edge: {
					acquire: { from: "response", capture: { headers: { token: "x-token" } } },
					carry: { as: "header", name: "user-agent", value: "token" },
					validity: { ttl: "5m" },
					distribute: { hosts: [HOST] },
				},
			},
			/"user-agent" is a header the SDK owns/,
		);
		rejects(
			{ edge: { ...preset(), validity: { ttl: "5m", invalidWhen: { bodyPattern: "(" } } } },
			/bodyPattern: is not a valid regular expression/,
		);
		rejects(
			{ edge: { ...preset(), distribute: { hosts: [HOST], qps: 0 } } },
			/qps: must be a positive number/,
		);
	});

	it("keeps credential state connection-scoped and never re-acquired in-process", () => {
		const member = {
			acquire: { from: "credential", capture: { credential: { session: "session" } } },
			carry: { as: "cookie", name: "sid", value: "session" },
			validity: { invalidWhen: { status: 401 } },
			distribute: { hosts: [HOST] },
		};
		const credential = {
			credential: {
				keys: ["session"],
				storesReusableSecret: true,
				justification: "unit fixture: the session is the stored credential",
			},
		};
		rejects(
			{ member: { ...member, validity: { invalidWhen: { status: 401 }, reacquire: 1 } } },
			/reacquire: must be 0 or omitted/,
			credential,
		);
		rejects(
			{ member: { ...member, distribute: { hosts: [HOST], scope: "provider" } } },
			/scope: must be "connection"/,
			credential,
		);
		rejects({ member }, /needs a credential declaration/);
		rejects(
			{
				member: {
					...member,
					acquire: { from: "credential", capture: { credential: { session: "other" } } },
				},
			},
			/"other" is not in credential\.keys/,
			credential,
		);
	});
});

describe("session state: contract snapshot", () => {
	it("lists sessionState with provider functions recorded as true, and nothing when undeclared", () => {
		const provider = defineProvider({
			...baseConfig,
			sessionState: {
				stayEdge: preset(),
				guest: {
					acquire: {
						from: "request",
						request: async () => ({
							url: "https://api.example/token",
							status: 200,
							headers: {},
							body: "{}",
							json: () => ({}),
						}),
						capture: { json: { token: "token" }, expiresAt: () => undefined },
					},
					carry: { as: "query", name: "token", value: "token" },
					validity: { invalidWhen: () => false },
					distribute: { hosts: ["api.example"] },
				},
			},
		});
		const contract = extractProviderContract(provider);
		expect(contract.sessionState).toEqual({
			guest: {
				acquire: {
					from: "request",
					request: true,
					capture: { json: { token: "token" }, expiresAt: true },
				},
				carry: { as: "query", name: "token", value: "token" },
				validity: { invalidWhen: true },
				distribute: { hosts: ["api.example"] },
			},
			stayEdge: {
				acquire: { from: "response", capture: { cookies: ["__cf_bm"] } },
				carry: { as: "cookies" },
				validity: {
					ttl: "20m",
					invalidWhen: {
						status: 403,
						headers: {
							server: "cloudflare",
							"cf-ray": true,
							"content-type": { pattern: "^text/html" },
						},
						bodyIncludes: ["/cdn-cgi/challenge-platform/", "RayID"],
					},
					reacquire: 1,
				},
				distribute: { hosts: [HOST], operations: ["get-stay-detail"] },
			},
		});
		expect("sessionState" in extractProviderContract(defineProvider(baseConfig))).toBe(false);
	});
});

describe("session state: cookie lifetime", () => {
	it("stores a captured cookie without its own Expires and Max-Age; validity alone decides", () => {
		expect(
			withoutCookieExpiry(
				"__cf_bm=abc; Path=/; Expires=Tue, 27 Oct 2026 05:30:00 GMT; Max-Age=1800; HttpOnly; Secure; SameSite=None",
			),
		).toBe("__cf_bm=abc; Path=/; HttpOnly; Secure; SameSite=None");
		expect(withoutCookieExpiry("__cf_bm=abc; Path=/")).toBe("__cf_bm=abc; Path=/");
	});
});

describe("session state: acquisition failures settle the pool", () => {
	it("a throwing expiry function fails the acquisition and the next call acquires again", async () => {
		let tokenRequests = 0;
		const origin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/token") {
					tokenRequests += 1;
					return Response.json({ token: `token-${tokenRequests}-value` });
				}
				return Response.json({ ok: true });
			},
		});
		try {
			const provider = defineProvider({
				...baseConfig,
				allowedHosts: ["127.0.0.1"],
				http: {},
				sessionState: {
					guest: {
						acquire: {
							from: "request",
							request: { url: `http://127.0.0.1:${origin.port}/token`, method: "POST" },
							capture: {
								json: { token: "token" },
								expiresAt: () => {
									throw new Error("expiry parser failed");
								},
							},
						},
						carry: { as: "header", name: "x-token", value: "token" },
						validity: { ttl: "5m" },
						distribute: { hosts: ["127.0.0.1"] },
					},
				},
				operations: {
					"get-stay-detail": {
						...operation(),
						handler: async (ctx: { http: HttpClient }, input: unknown) => {
							await ctx.http.get(`http://127.0.0.1:${origin.port}/items`);
							return Schema.parse(input);
						},
					},
					"search-stays": operation(),
				},
			});
			const app = createServerApp(provider, { logger: () => {} });
			const call = () =>
				app.request("/v1/get-stay-detail", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ requestId: "r", input: { id: "a" } }),
				});
			const first = await call();
			const second = await call();
			expect(first.status).toBe(500);
			expect(second.status).toBe(500);
			expect(tokenRequests).toBe(2);
		} finally {
			origin.stop(true);
		}
	}, 5_000);
});
