/**
 * Assembled health-monitor capture tests (ADR-0013): the server app built the way
 * `serve()` builds it (`createServerAppAsync`, in-process engine), a provider
 * declared with the SDK's `defineProvider`, handlers that call the real `ctx.http`
 * against a local `Bun.serve` upstream, and directives shaped exactly as the
 * Gateway builds them.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { REDACTED_FIXTURE_VALUE } from "../fixture-sanitization.js";
import { defineProvider, ProviderError, sensitive } from "../provider.js";
import {
	CAPTURE_DIRECTIVE_MAX_TTL_MS,
	type CaptureDirective,
	type CaptureDirectiveInactiveReason,
	createServerAppAsync,
	type ExecutableOperationRequest,
	type OperationCaptureOutcome,
	type ProviderServerLogEvent,
} from "../server/index.js";
import { event } from "../stream.js";
import type { CredentialContext, HttpClient } from "../types.js";

const PROVIDER_ID = "capture-assembled";
const ACCESS_TOKEN = `tok${randomBytes(16).toString("hex")}`;
const SESSION_COOKIE = `ck${randomBytes(16).toString("hex")}`;
const QUERY_SECRET = `qs${randomBytes(12).toString("hex")}`;
const PROFILE = {
	name: "Kim Tester",
	displayName: "tester-kim",
	email: "tester@example.com",
	phone: "010-1234-5678",
	grade: "gold",
};

type UpstreamSeen = { authorization: string | null; cookie: string | null; url: string };
const upstreamSeen: UpstreamSeen[] = [];
let upstream: ReturnType<typeof Bun.serve>;
let upstreamOrigin = "";

beforeAll(() => {
	upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			const authorization = request.headers.get("authorization");
			const cookie = request.headers.get("cookie");
			upstreamSeen.push({ authorization, cookie, url: request.url });
			if (url.pathname === "/api/big") {
				return new Response(JSON.stringify({ blob: "x".repeat(1_100_000) }), {
					headers: { "content-type": "application/json" },
				});
			}
			// The vendor echoes the request's credentials and URL back under
			// neutral keys, and sets a session cookie.
			return Response.json(
				{
					data: {
						...PROFILE,
						note: `presented ${authorization ?? ""}`,
						visitor: (cookie ?? "").replace(/^sid=/, ""),
						selfLink: request.url,
					},
				},
				{
					headers: {
						"set-cookie": `sid=${SESSION_COOKIE}; Path=/; HttpOnly`,
						"content-type": "application/json; charset=utf-8",
					},
				},
			);
		},
	});
	upstreamOrigin = `http://127.0.0.1:${upstream.port}`;
});

afterAll(() => {
	upstream.stop(true);
});

type HandlerContext = { readonly http: HttpClient; readonly credential: CredentialContext };

async function fetchProfile(ctx: HandlerContext): Promise<typeof PROFILE> {
	const response = await ctx.http.get(`${upstreamOrigin}/api/me`, {
		params: { apiKey: QUERY_SECRET, page: "2" },
		headers: {
			authorization: `Bearer ${ctx.credential.get("accessToken") ?? ""}`,
			cookie: `sid=${ctx.credential.get("sessionCookie") ?? ""}`,
		},
	});
	return (await response.json<{ data: typeof PROFILE }>()).data;
}

const handlerTraces: string[] = [];

const UPSTREAM_PATHS = ["data.name", "data.displayName", "data.email", "data.phone"];
const OUTPUT_PATHS = ["display_name"];
const ProfileOutput = z.object({
	display_name: sensitive(z.string(), "personal_data"),
	grade: z.string(),
});

const buildProvider = defineProvider({
	id: PROVIDER_ID,
	version: "1.0.0",
	runtime: "standard",
	http: true,
	allowedHosts: ["127.0.0.1"],
	credential: { keys: ["accessToken", "sessionCookie"] },
	meta: { displayName: "Capture Assembled", descriptionKey: "meta.description", category: "test" },
});

const provider = buildProvider({
	operations: {
		profile: {
			riskClass: "read",
			input: z.object({}),
			output: ProfileOutput,
			observability: { sensitive: { output: OUTPUT_PATHS, upstream: UPSTREAM_PATHS } },
			healthCheckUnsupported: { reason: "Assembled test operation against a local upstream." },
			handler: async (ctx, input) => {
				handlerTraces.push(
					JSON.stringify({
						contextKeys: Object.keys(ctx).sort(),
						request: (ctx as { request?: unknown }).request,
						input,
					}),
				);
				const row = await fetchProfile(ctx);
				return { display_name: row.displayName, grade: row.grade };
			},
		},
		"profile-strict": {
			riskClass: "read",
			input: z.object({}),
			output: ProfileOutput,
			observability: { sensitive: { output: OUTPUT_PATHS, upstream: UPSTREAM_PATHS } },
			healthCheckUnsupported: { reason: "Assembled test operation against a local upstream." },
			handler: async (ctx) => {
				await fetchProfile(ctx);
				throw new ProviderError("The authenticated profile shape is not the expected one.", {
					code: "UPSTREAM_SCHEMA_ERROR",
				});
			},
		},
		"profile-undeclared": {
			riskClass: "read",
			input: z.object({}),
			output: ProfileOutput,
			observability: { sensitive: { output: OUTPUT_PATHS } },
			healthCheckUnsupported: { reason: "Assembled test operation against a local upstream." },
			handler: async (ctx) => {
				const row = await fetchProfile(ctx);
				return { display_name: row.displayName, grade: row.grade };
			},
		},
		offline: {
			riskClass: "read",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			observability: { sensitive: { upstream: [] } },
			healthCheckUnsupported: { reason: "Assembled test operation without an upstream call." },
			handler: async () => ({ ok: true }),
		},
		big: {
			riskClass: "read",
			input: z.object({}),
			output: z.object({ size: z.number() }),
			observability: { sensitive: { upstream: [] } },
			healthCheckUnsupported: { reason: "Assembled test operation against a local upstream." },
			handler: async (ctx) => {
				const response = await ctx.http.get(`${upstreamOrigin}/api/big`);
				return { size: JSON.stringify(response.data).length };
			},
		},
		"raw-forged": {
			riskClass: "read",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			observability: { sensitive: { upstream: UPSTREAM_PATHS } },
			healthCheckUnsupported: { reason: "Assembled test operation against a local upstream." },
			// Served through a host operation executor below, which can return a raw Response.
			handler: async () => ({ ok: true }),
		},
		feed: {
			riskClass: "read",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			observability: { sensitive: { upstream: [] } },
			transport: { kind: "sse", events: { ready: z.object({ ok: z.boolean() }) } },
			healthCheckUnsupported: { reason: "Assembled streaming test operation." },
			async *handler(ctx) {
				await fetchProfile(ctx);
				yield event("ready", { ok: true });
			},
		},
	},
});

function nonce(): string {
	return randomBytes(16).toString("hex");
}

function directive(
	overrides: Partial<CaptureDirective> & { requestId: string; operationId: string },
) {
	return {
		version: 1,
		nonce: nonce(),
		providerId: PROVIDER_ID,
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		...overrides,
	};
}

function envelope(requestId: string, engine?: unknown): string {
	return JSON.stringify({
		requestId,
		input: {},
		connection: {
			id: "con-assembled",
			mode: "credentials",
			secrets: { accessToken: ACCESS_TOKEN, sessionCookie: SESSION_COOKIE },
			metadata: {},
			externalRef: "ext-assembled",
		},
		...(engine === undefined ? {} : { engine }),
	});
}

type App = Awaited<ReturnType<typeof createServerAppAsync>>;

async function call(app: App, operation: string, requestId: string, engine?: unknown) {
	const response = await app.request(`/v1/${operation}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: envelope(requestId, engine),
	});
	const text = await response.text();
	return { status: response.status, contentType: response.headers.get("content-type"), text };
}

function captureOf(text: string): OperationCaptureOutcome | undefined {
	const body = JSON.parse(text) as { engine?: { capture?: OperationCaptureOutcome } };
	return body.engine?.capture;
}

function expectNoCredentialBytes(text: string): void {
	expect(text).not.toContain(ACCESS_TOKEN);
	expect(text).not.toContain(SESSION_COOKIE);
	expect(text).not.toContain(QUERY_SECRET);
	expect(text).not.toContain("apiKey=");
	expect(text).not.toContain("page=2");
}

const events: ProviderServerLogEvent[] = [];
let app: App;

beforeAll(async () => {
	app = await createServerAppAsync(provider, { logger: (entry) => events.push(entry) });
});

describe("capture directive on the assembled operation route", () => {
	it("attaches masked evidence on the success path and leaves data unchanged", async () => {
		const baseline = await call(app, "profile", "req-success");
		const captured = await call(app, "profile", "req-success", {
			capture: directive({ requestId: "req-success", operationId: "profile" }),
		});

		expect(captured.status).toBe(200);
		const baselineBody = JSON.parse(baseline.text) as Record<string, unknown>;
		const capturedBody = JSON.parse(captured.text) as Record<string, unknown>;
		expect(Object.keys(capturedBody)).toEqual([...Object.keys(baselineBody), "engine"]);
		expect(capturedBody.data).toEqual(baselineBody.data);
		expect(capturedBody.data).toEqual({ display_name: PROFILE.displayName, grade: "gold" });

		const capture = captureOf(captured.text);
		expect(capture?.version).toBe(1);
		expect(capture?.outcome).toBe("captured");
		if (capture?.outcome !== "captured") throw new Error("expected captured evidence");
		expect(capture.evidence.upstreamStatus).toBe(200);
		expect(capture.evidence.upstreamContentType).toBe("application/json");
		expect(capture.evidence.requestPath).toBe("/api/me");
		const data = (capture.evidence.body as { data: Record<string, unknown> }).data;
		expect(data.name).toBe(REDACTED_FIXTURE_VALUE);
		expect(data.displayName).toBe(REDACTED_FIXTURE_VALUE);
		expect(data.email).toBe(REDACTED_FIXTURE_VALUE);
		expect(data.phone).toBe(REDACTED_FIXTURE_VALUE);
		expect(data.grade).toBe("gold");
		expect(data.selfLink).toBe(`${upstreamOrigin}/api/me?${REDACTED_FIXTURE_VALUE}`);

		// The upstream really received the credentials and the query values.
		const seen = upstreamSeen.at(-1);
		expect(seen?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
		expect(seen?.cookie).toBe(`sid=${SESSION_COOKIE}`);
		expect(seen?.url).toContain(`apiKey=${QUERY_SECRET}`);
		// None of them, nor the declared personal data, leaves in the response.
		expectNoCredentialBytes(captured.text);
		expect(captured.text).not.toContain(PROFILE.email);
		expect(captured.text).not.toContain(PROFILE.name);
		expect(captured.text).not.toContain(PROFILE.phone);
	});

	it("keeps the fail-closed error envelope unchanged and attaches evidence beside it", async () => {
		const baseline = await call(app, "profile-strict", "req-fail-closed");
		const captured = await call(app, "profile-strict", "req-fail-closed", {
			capture: directive({ requestId: "req-fail-closed", operationId: "profile-strict" }),
		});

		expect(baseline.status).toBe(502);
		expect(captured.status).toBe(502);
		const baselineBody = JSON.parse(baseline.text) as { error: { code: string } };
		const capturedBody = JSON.parse(captured.text) as { error: unknown; engine: unknown };
		expect(baselineBody.error.code).toBe("UPSTREAM_SCHEMA_ERROR");
		expect(Object.keys(capturedBody)).toEqual(["error", "engine"]);
		expect(JSON.stringify(capturedBody.error)).toBe(JSON.stringify(baselineBody.error));

		const capture = captureOf(captured.text);
		expect(capture?.outcome).toBe("captured");
		if (capture?.outcome !== "captured") throw new Error("expected captured evidence");
		expect((capture.evidence.body as { data: { grade: string } }).data.grade).toBe("gold");
		expectNoCredentialBytes(captured.text);
		expect(captured.text).not.toContain(PROFILE.email);
	});

	it("answers byte-for-byte like no directive when the directive is rejected", async () => {
		const requestId = "req-rejected";
		const baseline = await call(app, "profile", requestId);
		expect(captureOf(baseline.text)).toBeUndefined();

		const accepted = directive({ requestId, operationId: "profile" });
		expect(
			captureOf((await call(app, "profile", requestId, { capture: accepted })).text)?.outcome,
		).toBe("captured");
		const rejected: Array<[CaptureDirectiveInactiveReason, unknown]> = [
			["nonce_replayed", accepted],
			["operation_mismatch", directive({ requestId, operationId: "profile-strict" })],
			["request_id_mismatch", directive({ requestId: "req-other", operationId: "profile" })],
			[
				"expired",
				directive({
					requestId,
					operationId: "profile",
					expiresAt: new Date(Date.now() - 1).toISOString(),
				}),
			],
			[
				"expires_too_far",
				directive({
					requestId,
					operationId: "profile",
					expiresAt: new Date(Date.now() + CAPTURE_DIRECTIVE_MAX_TTL_MS + 60_000).toISOString(),
				}),
			],
			["provider_mismatch", directive({ requestId, operationId: "profile", providerId: "other" })],
			["nonce_malformed", directive({ requestId, operationId: "profile", nonce: "ABC" })],
			["unsupported_version", { ...directive({ requestId, operationId: "profile" }), version: 2 }],
			["malformed", "not-a-directive"],
		];
		for (const [reason, capture] of rejected) {
			events.length = 0;
			const response = await call(app, "profile", requestId, { capture });
			expect({ reason, status: response.status, text: response.text }).toEqual({
				reason,
				status: baseline.status,
				text: baseline.text,
			});
			expect(response.contentType).toBe(baseline.contentType);
			const line = events.find((entry) => entry.event === "provider_capture_directive");
			expect(line).toEqual({
				level: "info",
				event: "provider_capture_directive",
				providerId: PROVIDER_ID,
				operationId: "profile",
				requestId,
				result: "inactive",
				reason,
			});
			if (typeof capture === "object" && capture && "nonce" in capture) {
				expect(JSON.stringify(events)).not.toContain(String(capture.nonce));
			}
		}
		// A malformed `engine` value itself is ignored too.
		expect((await call(app, "profile", requestId, "engine-as-a-string")).text).toBe(baseline.text);
	});

	it("answers the skip reason and no body for an operation without upstream paths", async () => {
		const response = await call(app, "profile-undeclared", "req-undeclared", {
			capture: directive({ requestId: "req-undeclared", operationId: "profile-undeclared" }),
		});
		expect(response.status).toBe(200);
		expect(captureOf(response.text)).toEqual({
			version: 1,
			outcome: "skipped",
			reason: "upstream_sensitive_paths_undeclared",
		});
		expect(response.text).not.toContain(PROFILE.email);
		expect(response.text).not.toContain("selfLink");
	});

	it("answers no_upstream_exchange and upstream_body_too_large", async () => {
		const offline = await call(app, "offline", "req-offline", {
			capture: directive({ requestId: "req-offline", operationId: "offline" }),
		});
		expect(captureOf(offline.text)).toEqual({
			version: 1,
			outcome: "skipped",
			reason: "no_upstream_exchange",
		});
		const big = await call(app, "big", "req-big", {
			capture: directive({ requestId: "req-big", operationId: "big" }),
		});
		expect(big.status).toBe(200);
		expect(captureOf(big.text)).toEqual({
			version: 1,
			outcome: "skipped",
			reason: "upstream_body_too_large",
		});
	});

	it("replaces an engine key an executor wrote into a raw JSON Response", async () => {
		// The default executor validates the declared output, so a raw Response reaches the
		// route only through a host operation executor; it still calls the real ctx.http.
		const rawApp = await createServerAppAsync(provider, {
			logger: () => {},
			operationExecutor: async ({ ctx }) => {
				await fetchProfile(ctx);
				return new Response(
					JSON.stringify({
						data: { ok: true },
						engine: { capture: { version: 1, outcome: "captured", evidence: "forged" } },
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});
		const plain = await call(rawApp, "raw-forged", "req-raw");
		expect(JSON.parse(plain.text)).toEqual({
			data: { ok: true },
			engine: { capture: { version: 1, outcome: "captured", evidence: "forged" } },
		});
		const captured = await call(rawApp, "raw-forged", "req-raw", {
			capture: directive({ requestId: "req-raw", operationId: "raw-forged" }),
		});
		expect(JSON.parse(captured.text).data).toEqual({ ok: true });
		const capture = captureOf(captured.text);
		expect(capture?.outcome).toBe("captured");
		expect(captured.text).not.toContain("forged");
		expectNoCredentialBytes(captured.text);
	});

	it("stays inactive on a streaming transport", async () => {
		events.length = 0;
		const response = await call(app, "feed", "req-feed", {
			capture: directive({ requestId: "req-feed", operationId: "feed" }),
		});
		expect(response.status).toBe(200);
		expect(response.text).toContain("event: ready");
		expect(response.text).not.toContain("engine");
		expect(events).toContainEqual(
			expect.objectContaining({
				event: "provider_capture_directive",
				result: "inactive",
				reason: "streaming_transport",
			}),
		);
	});

	it("never shows the directive to handler code or an operation executor", async () => {
		const capture = directive({ requestId: "req-hidden", operationId: "profile" });
		handlerTraces.length = 0;
		await call(app, "profile", "req-hidden", { capture });
		const trace = handlerTraces.at(-1) ?? "";
		expect(trace).not.toContain(capture.nonce);
		expect(trace).not.toContain("engine");
		expect(trace).not.toContain("capture");

		let received: ExecutableOperationRequest | undefined;
		const executorApp = await createServerAppAsync(provider, {
			logger: () => {},
			operationExecutor: async (input) => {
				received = input.request;
				return { display_name: "x", grade: "gold" };
			},
		});
		const second = directive({ requestId: "req-executor", operationId: "profile" });
		await call(executorApp, "profile", "req-executor", { capture: second });
		expect(received).toBeDefined();
		expect(Object.hasOwn(received ?? {}, "engine")).toBe(false);
		expect(JSON.stringify(received)).not.toContain(second.nonce);
	});

	it("logs the outcome of an accepted directive without values", async () => {
		events.length = 0;
		const capture = directive({ requestId: "req-log", operationId: "profile" });
		await call(app, "profile", "req-log", { capture });
		const line = events.find((entry) => entry.event === "provider_capture_directive");
		expect(line).toEqual({
			level: "info",
			event: "provider_capture_directive",
			providerId: PROVIDER_ID,
			operationId: "profile",
			requestId: "req-log",
			result: "captured",
		});
		expect(JSON.stringify(events)).not.toContain(capture.nonce);
		expect(JSON.stringify(events)).not.toContain(PROFILE.email);
	});
});
