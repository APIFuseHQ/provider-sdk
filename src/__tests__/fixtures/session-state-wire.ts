// Serves real provider apps that declare `sessionState` and runs them on the
// real wreq-js stealth transport and the real native ctx.http transport against
// a local origin. The origin answers a stay read without a valid edge cookie
// with the recorded block page and a fresh cookie, the way the measured
// upstream did, and serves the read once a cookie it issued comes back. Prints
// what the origin and serve saw. session-state-assembly.test.ts spawns this
// file so the wreq-js module mock in other test files cannot replace the
// stealth transport. Nothing leaves the machine.
import { z } from "zod";

import { defineProvider } from "../../define.js";
import { ProviderError } from "../../errors.js";
import { sessionStatePresets } from "../../runtime/session-state-presets.js";
import { createServerApp, type ProviderServerLogEvent } from "../../server/serve.js";
import type { ProviderSessionState, StealthClient } from "../../types.js";

// Recorded upstream 403 (2026-10-22, a KR stay-detail read), trimmed as in
// nodemaven-operation-scope-wire.ts: the status, the headers a block-page check
// reads and the body markers are kept; the brand, the exit IP and the cookie are not.
const RECORDED_BLOCK_PAGE = {
	status: 403,
	headers: {
		"content-type": "text/html; charset=UTF-8",
		"cache-control":
			"private, max-age=0, no-store, no-cache, must-revalidate, post-check=0, pre-check=0",
		"referrer-policy": "same-origin",
		"x-frame-options": "SAMEORIGIN",
		server: "cloudflare",
		"cf-ray": "a4e864499984d1cd-ICN",
	},
	body: [
		"<html>",
		'<head><meta charset="utf-8"><title>Temporarily unavailable</title></head>',
		"<body><center>",
		"<h1>일시적으로 서비스를 이용하실 수 없습니다.</h1>",
		"<table><tr><td>IP</td><td>203.0.113.7</td></tr><tr><td>RayID</td><td>a4e864499984d1cd</td></tr></table>",
		"</center>",
		"<script>window.__CF$cv$params={r:'a4e864499984d1cd'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);</script>",
		"</body></html>",
	].join("\n"),
};

type Hit = {
	app: string;
	path: string;
	method: string;
	status: number;
	edgeCookie: string | null;
	authorization: string | null;
	cookie: string | null;
	headerNames: string[];
};

const hits: Hit[] = [];
const issuedEdgeCookies = new Set<string>();
const everyIssuedValue: string[] = [];
const issuedTokens = new Set<string>();
let blockEverything = false;
let sequence = 0;

function readCookie(header: string | null, name: string): string | null {
	for (const part of (header ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return null;
}

function mint(prefix: string): string {
	sequence += 1;
	const value = `${prefix}-${sequence}-${crypto.randomUUID()}`;
	everyIssuedValue.push(value);
	return value;
}

function edgeCookieHeader(): string {
	const value = mint("edge");
	issuedEdgeCookies.add(value);
	// Like the measured edge, the cookie states a short expiry (there Date + 30
	// minutes, here one second) that the origin itself never enforces.
	return `__cf_bm=${value}; Path=/; Expires=${new Date(Date.now() + 1_000).toUTCString()}; HttpOnly`;
}

const origin = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);
		const cookie = request.headers.get("cookie");
		const edgeCookie = readCookie(cookie, "__cf_bm");
		const respond = (response: Response): Response => {
			hits.push({
				app: request.headers.get("x-wire-app") ?? url.searchParams.get("app") ?? "",
				path: url.pathname,
				method: request.method,
				status: response.status,
				edgeCookie,
				authorization: request.headers.get("authorization"),
				cookie,
				headerNames: [...request.headers.keys()],
			});
			return response;
		};
		if (url.pathname.startsWith("/stays/") && url.pathname !== "/stays/search") {
			if (!blockEverything && edgeCookie && issuedEdgeCookies.has(edgeCookie)) {
				// A served read renews the cookie too, as the measured upstream did.
				return respond(
					Response.json({ name: url.pathname }, { headers: { "set-cookie": edgeCookieHeader() } }),
				);
			}
			return respond(
				new Response(RECORDED_BLOCK_PAGE.body, {
					status: RECORDED_BLOCK_PAGE.status,
					headers: { ...RECORDED_BLOCK_PAGE.headers, "set-cookie": edgeCookieHeader() },
				}),
			);
		}
		if (url.pathname === "/stays/search") return respond(Response.json({ name: "search" }));
		if (url.pathname === "/guest/token" && request.method === "POST") {
			const token = mint("guest");
			issuedTokens.add(token);
			return respond(Response.json({ data: { accessToken: token, expiresIn: 600 } }));
		}
		if (url.pathname === "/api/items") {
			const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
			return respond(
				issuedTokens.has(token)
					? Response.json({ items: ["a"] })
					: Response.json({ error: "unauthorized" }, { status: 401 }),
			);
		}
		if (url.pathname === "/member/profile") {
			return respond(
				readCookie(cookie, "member_session") === "member-session-ok"
					? Response.json({ member: true })
					: Response.json({ error: "session expired" }, { status: 401 }),
			);
		}
		return respond(new Response("not found", { status: 404 }));
	},
});
const originUrl = `http://127.0.0.1:${origin.port}`;
const HOST = "127.0.0.1";
const STAY_READS = ["get-stay-detail", "hold-stay", "get-stay-detail-unpooled"];

const DetailOutput = z.object({
	status: z.number(),
	outcome: z.string().nullable(),
	attempts: z.number().nullable(),
});

/**
 * The provider half after the layer: one fetch, and a block page the layer
 * could not absorb becomes BLOCKED with the attempt count in details.
 */
function stayOperations(app: string) {
	const read = (path: string, extra: { sessionState?: false; method?: "POST" } = {}) => ({
		riskClass: "read" as const,
		descriptionKey: "operations.operation.description",
		input: z.object({}),
		output: DetailOutput,
		upstream: { baseUrl: originUrl },
		healthCheckUnsupported: { reason: "wire fixture" },
		async handler(ctx: { stealth: StealthClient }) {
			const response = await ctx.stealth.fetch(path, {
				throwOnHttpError: false,
				headers: { "x-wire-app": app },
				...(extra.method ? { method: extra.method, body: "{}" } : {}),
				...(extra.sessionState === false ? { sessionState: false } : {}),
			});
			if (response.sessionState?.outcome === "reacquire_exhausted") {
				throw new ProviderError("The upstream edge refused the stay read", {
					code: "BLOCKED",
					details: { egress_attempts: response.sessionState.attempts },
				});
			}
			return {
				status: response.status,
				outcome: response.sessionState?.outcome ?? null,
				attempts: response.sessionState?.attempts ?? null,
			};
		},
	});
	return {
		"get-stay-detail": read("/stays/1/detail"),
		"hold-stay": read("/stays/1/hold", { method: "POST" }),
		"get-stay-detail-unpooled": read("/stays/1/detail", { sessionState: false }),
		"search-stays": read("/stays/1/detail"),
	};
}

const meta = (id: string) => ({
	displayName: id,
	descriptionKey: `${id}.description`,
	category: "test",
});

function stayProvider(id: string, sessionState?: Record<string, ProviderSessionState>) {
	return defineProvider({
		id,
		version: "1.0.0",
		runtime: "standard",
		meta: meta(id),
		allowedHosts: [HOST],
		reviewed: "community",
		stealth: { browser: "chrome", os: "macos" },
		...(sessionState ? { sessionState } : {}),
		credential: { keys: ["account_id"] },
		auth: {
			mode: "credentials",
			flow: {
				async start(ctx) {
					await ctx.stealth.fetch("/stays/1/detail", {
						throwOnHttpError: false,
						headers: { "x-wire-app": id },
					});
					return {
						kind: "form",
						turnId: "turn_form",
						data: { title: "Sign in" },
						expectedInput: { schema: { type: "object", properties: {} } },
					};
				},
				async continue() {
					return { kind: "form", turnId: "turn_form", data: { title: "Sign in" } };
				},
			},
		},
	})({ operations: stayOperations(id) });
}

const PRESET_OPTIONS = { hosts: [HOST], operations: STAY_READS, ttl: "10m" } as const;
const presetDeclaration = sessionStatePresets.cloudflareBlockPage(PRESET_OPTIONS);
// The same declaration written by hand, without the preset.
const directDeclaration: ProviderSessionState = {
	acquire: { from: "response", capture: { cookies: ["__cf_bm"] } },
	carry: { as: "cookies" },
	validity: {
		ttl: "10m",
		invalidWhen: {
			status: 403,
			headers: { server: "cloudflare", "cf-ray": true, "content-type": { pattern: "^text/html" } },
			bodyIncludes: ["/cdn-cgi/challenge-platform/", "RayID"],
		},
		reacquire: 1,
	},
	distribute: { hosts: [HOST], operations: STAY_READS },
};

const events: ProviderServerLogEvent[] = [];
const logger = (event: ProviderServerLogEvent) => events.push(event);
const apps = {
	preset: createServerApp(stayProvider("wire-preset", { stayEdge: presetDeclaration }), {
		logger,
	}),
	direct: createServerApp(stayProvider("wire-direct", { stayEdge: directDeclaration }), {
		logger,
	}),
	ttl: createServerApp(
		stayProvider("wire-ttl", {
			stayEdge: sessionStatePresets.cloudflareBlockPage({ ...PRESET_OPTIONS, ttl: "400ms" }),
		}),
		{ logger },
	),
	idle: createServerApp(
		stayProvider("wire-idle", {
			stayEdge: sessionStatePresets.cloudflareBlockPage({
				hosts: [HOST],
				operations: STAY_READS,
				idleTtl: "400ms",
			}),
		}),
		{ logger },
	),
	uses: createServerApp(
		stayProvider("wire-uses", {
			stayEdge: sessionStatePresets.cloudflareBlockPage({
				hosts: [HOST],
				operations: STAY_READS,
				maxUses: 2,
			}),
		}),
		{ logger },
	),
	shared: createServerApp(stayProvider("wire-shared", { stayEdge: presetDeclaration }), {
		logger,
	}),
	share: createServerApp(
		stayProvider("wire-share", {
			stayEdge: sessionStatePresets.cloudflareBlockPage({ ...PRESET_OPTIONS, qps: 1 }),
		}),
		{ logger },
	),
	plain: createServerApp(stayProvider("wire-plain"), { logger }),
	header: createServerApp(
		defineProvider({
			id: "wire-header",
			version: "1.0.0",
			runtime: "standard",
			meta: meta("wire-header"),
			allowedHosts: [HOST],
			reviewed: "community",
			http: {},
			sessionState: {
				guest: {
					acquire: {
						from: "request",
						request: { url: `${originUrl}/guest/token`, method: "POST", client: "http" },
						capture: {
							json: { token: "data.accessToken" },
							expiresAt: { json: "data.expiresIn", unit: "seconds-from-now" },
						},
					},
					carry: { as: "header", name: "authorization", value: "token", format: "Bearer {value}" },
					validity: { invalidWhen: { status: 401 }, reacquire: 1 },
					distribute: { hosts: [HOST], operations: ["list-items"] },
				},
			},
		})({
			operations: {
				"list-items": {
					riskClass: "read",
					descriptionKey: "operations.listItems.description",
					input: z.object({}),
					output: z.object({ status: z.number(), outcome: z.string().nullable() }),
					healthCheckUnsupported: { reason: "wire fixture" },
					async handler(ctx) {
						const response = await ctx.http.get(`${originUrl}/api/items?app=wire-header`, {
							throwOnHttpError: false,
						});
						return { status: response.status, outcome: response.sessionState?.outcome ?? null };
					},
				},
			},
		}),
		{ logger },
	),
	member: createServerApp(
		defineProvider({
			id: "wire-member",
			version: "1.0.0",
			runtime: "standard",
			meta: meta("wire-member"),
			allowedHosts: [HOST],
			reviewed: "community",
			stealth: { browser: "chrome", os: "macos" },
			credential: {
				keys: ["cookie"],
				storesReusableSecret: true,
				justification: "wire fixture: the member session cookie is the credential",
			},
			sessionState: {
				member: {
					acquire: { from: "credential", capture: { credential: { cookie: "cookie" } } },
					carry: { as: "cookie-header", value: "cookie" },
					validity: { invalidWhen: { status: 401 } },
					distribute: { hosts: [HOST], scope: "connection" },
				},
			},
		})({
			operations: {
				"get-profile": {
					riskClass: "read",
					descriptionKey: "operations.getProfile.description",
					input: z.object({}),
					output: z.object({ status: z.number(), outcome: z.string().nullable() }),
					upstream: { baseUrl: originUrl },
					healthCheckUnsupported: { reason: "wire fixture" },
					async handler(ctx) {
						const response = await ctx.stealth.fetch("/member/profile", {
							throwOnHttpError: false,
							headers: { "x-wire-app": "wire-member" },
						});
						return { status: response.status, outcome: response.sessionState?.outcome ?? null };
					},
				},
			},
		}),
		{ logger },
	),
};

type AppName = keyof typeof apps;
let requestSequence = 0;

async function call(
	app: AppName,
	operationId: string,
	connection?: { id: string; secrets: Record<string, string> },
) {
	requestSequence += 1;
	const requestId = `request-${requestSequence}`;
	const before = hits.length;
	const response = await apps[app].request(`/v1/${operationId}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			requestId,
			input: {},
			...(connection
				? {
						connection: {
							id: connection.id,
							mode: "credentials",
							externalRef: "external",
							metadata: {},
							secrets: connection.secrets,
						},
					}
				: {}),
		}),
	});
	const text = await response.text();
	const completed = events.find(
		(event) =>
			(event.event === "provider_request_completed" || event.event === "provider_request_failed") &&
			event.requestId === requestId,
	) as Record<string, unknown> | undefined;
	const telemetryHeader = response.headers.get("x-apifuse-provider-telemetry");
	return {
		status: response.status,
		body: JSON.parse(text) as unknown,
		bodyText: text,
		telemetryHeader,
		hits: hits.slice(before),
		stealthLog: (completed?.stealth ?? null) as Record<string, unknown> | null,
		httpLog: (completed?.http ?? null) as Record<string, unknown> | null,
	};
}

async function authStart(app: AppName) {
	const before = hits.length;
	const response = await apps[app].request("/auth/start", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			requestId: "auth-start",
			flowId: "flow-1",
			connectionId: "af_con_1234567890123456789012",
			externalRef: "external-1",
			tenantId: "tenant-1",
			providerId: "wire-preset",
		}),
	});
	return { status: response.status, hits: hits.slice(before) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Three concurrent calls; the origin hits of all three, in arrival order. */
async function burst(app: AppName) {
	const before = hits.length;
	const calls = await Promise.all([
		call(app, "get-stay-detail"),
		call(app, "get-stay-detail"),
		call(app, "get-stay-detail"),
	]);
	return { calls, hits: hits.slice(before) };
}

// (a) first call acquires on the block page and re-sends once; the second call carries the pooled cookie.
const presetFirst = await call("preset", "get-stay-detail");
const presetSecond = await call("preset", "get-stay-detail");
// (d) outside the layer: an unlisted operation, sessionState: false, and an auth flow.
const unlisted = await call("preset", "search-stays");
const optedOut = await call("preset", "get-stay-detail-unpooled");
const authFlow = await authStart("preset");
// A POST in scope carries the pooled cookie; judged invalid, it is not re-sent.
const holdCarried = await call("preset", "hold-stay");
// (c) the carried cookie is refused: one re-acquisition absorbs it.
issuedEdgeCookies.clear();
const revoked = await call("preset", "get-stay-detail");
issuedEdgeCookies.clear();
const holdRevoked = await call("preset", "hold-stay");
// ... and when the re-acquired cookie is refused too, the provider gets the classification.
blockEverything = true;
const exhausted = await call("preset", "get-stay-detail");
blockEverything = false;
// (e) the same declaration written by hand.
const directFirst = await call("direct", "get-stay-detail");
const directSecond = await call("direct", "get-stay-detail");
// (b) ttl.
const ttlFirst = await call("ttl", "get-stay-detail");
const ttlSecond = await call("ttl", "get-stay-detail");
// idleTtl: each use restarts the clock.
const idleFirst = await call("idle", "get-stay-detail");
await sleep(150);
const idleSecond = await call("idle", "get-stay-detail");
await sleep(150);
const idleThird = await call("idle", "get-stay-detail");
await sleep(500);
const ttlExpired = await call("ttl", "get-stay-detail");
const idleExpired = await call("idle", "get-stay-detail");
// maxUses 2: the re-sent first read and the second call use the state up.
const usesFirst = await call("uses", "get-stay-detail");
const usesSecond = await call("uses", "get-stay-detail");
const usesThird = await call("uses", "get-stay-detail");
// (g) qps omitted: one state shared, concurrent calls wait for the one acquisition.
const sharedBurst = await burst("shared");
// qps 1: every state already used its share this second, so each concurrent call acquires its own.
const shareBurst = await burst("share");
await sleep(1_100);
const shareAfter = await call("share", "get-stay-detail");
// The preset pool's cookie was captured well over a second ago: past its own
// Expires, inside the declared ttl, so it is still carried.
const presetPastCookieExpiry = await call("preset", "get-stay-detail");
// A provider without sessionState and an unlisted operation send the same request.
const plainSearch = await call("plain", "search-stays");
// (f) header carry with a declared acquisition request on ctx.http.
const headerFirst = await call("header", "list-items");
const headerSecond = await call("header", "list-items");
issuedTokens.clear();
const headerRevoked = await call("header", "list-items");
// (f) cookie-header carry from the connection credential.
const memberOk = await call("member", "get-profile", {
	id: "connection-ok",
	secrets: { cookie: "member_session=member-session-ok; theme=dark" },
});
const memberStale = await call("member", "get-profile", {
	id: "connection-stale",
	secrets: { cookie: "member_session=member-session-stale" },
});
const memberNone = await call("member", "get-profile");

origin.stop(true);
console.log(
	JSON.stringify({
		presetFirst,
		presetSecond,
		unlisted,
		optedOut,
		authFlow,
		holdCarried,
		revoked,
		holdRevoked,
		exhausted,
		directFirst,
		directSecond,
		ttlFirst,
		ttlSecond,
		ttlExpired,
		idleFirst,
		idleSecond,
		idleThird,
		idleExpired,
		usesFirst,
		usesSecond,
		usesThird,
		sharedBurst,
		shareBurst,
		shareAfter,
		presetPastCookieExpiry,
		plainSearch,
		headerFirst,
		headerSecond,
		headerRevoked,
		memberOk,
		memberStale,
		memberNone,
		everyIssuedValue,
		logText: JSON.stringify(events),
		presetDeclaration,
		directDeclaration,
	}),
);
