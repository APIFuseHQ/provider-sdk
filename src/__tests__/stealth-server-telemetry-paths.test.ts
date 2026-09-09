import { beforeEach, describe, expect, it, mock } from "bun:test";
import { z } from "zod";

import { PROVIDER_TELEMETRY_HEADER } from "../runtime/request-telemetry.js";
import { swapResolverAdapterFactoryForTests } from "../runtime/resolver.js";
import {
	ResolverVendorUnavailableError,
	type ResolverVendorAdapter,
} from "../runtime/resolver-vendors/types.js";
import {
	StealthTelemetryCollector,
	type StealthTelemetryLogPayload,
} from "../runtime/stealth-telemetry.js";
import type { ProviderServerLogEvent } from "../server/serve.js";
import { statefulSignedHeaders } from "../stateful-signing.js";
import type { ProviderContext, ProviderDefinition, ResolverContext } from "../types.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

type QueuedWreqResult =
	| {
			readonly kind: "response";
			readonly status: number;
			readonly body: string;
			readonly url?: string;
	  }
	| { readonly kind: "error"; readonly error: Error };

const wreqState = {
	queue: [] as QueuedWreqResult[],
	calls: [] as Array<{ url: string; options?: Record<string, unknown> }>,
	clients: [] as Array<Record<string, unknown> | undefined>,
};

function emulationHeaders(profile: string, os = "macos") {
	const version = /^chrome_(\d+)$/u.exec(profile)?.[1] ?? "149";
	return new Map([
		["user-agent", `Mozilla/5.0 Chrome/${version}.0.0.0 Safari/537.36`],
		["sec-ch-ua", `"Google Chrome";v="${version}"`],
		["sec-ch-ua-mobile", "?0"],
		["sec-ch-ua-platform", os === "linux" ? '"Linux"' : '"macOS"'],
		["accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
		["accept-encoding", "gzip, deflate, br, zstd"],
		["accept-language", "en-US,en;q=0.9"],
		["sec-fetch-dest", "document"],
		["sec-fetch-mode", "navigate"],
		["sec-fetch-site", "none"],
		["priority", "u=0, i"],
	]);
}

function mockResponse(status: number, body: string, url: string) {
	const bytes = new TextEncoder().encode(body);
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: new Headers(
			status === 403 ? { "set-cookie": "sbsd_o=fixture-state; Path=/; Secure" } : {},
		),
		url,
		redirected: false,
		async arrayBuffer() {
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		},
		async text() {
			return body;
		},
		async json() {
			return JSON.parse(body);
		},
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
	};
}

class MockWreqSession {
	constructor(options?: Record<string, unknown>) {
		wreqState.clients.push(options);
	}

	async fetch(url: string, options?: Record<string, unknown>) {
		wreqState.calls.push({ url, options });
		const next = wreqState.queue.shift();
		if (!next) throw new Error(`No queued wreq result for ${url}`);
		if (next.kind === "error") throw next.error;
		return mockResponse(next.status, next.body, next.url ?? url);
	}

	async clearCookies() {}
	getCookies() {
		return {};
	}
	getAllCookies() {
		return [];
	}
	setCookie() {}
	async close() {}
}

mock.module("wreq-js", () => ({
	createSession: async (options?: Record<string, unknown>) => new MockWreqSession(options),
	getEmulationHeaders: emulationHeaders,
	getProfiles: () => ["chrome_149", "firefox_147", "safari_17.0", "safari_ios_18.1.1"],
}));

const terminalPaths = [
	"/v1/probe",
	"/auth/start",
	"/auth/continue",
	"/auth/poll",
	"/auth/disconnect",
	"/auth/refresh",
	"/__apifuse/stateful/operations",
] as const;
const STATEFUL_SECRET = "stealth-telemetry-stateful-secret";

function fetchStealth(ctx: Pick<ProviderContext, "stealth">) {
	return ctx.stealth.fetch("/telemetry", { retry: false });
}

function createStealthProvider(): ProviderDefinition {
	const authFetch = async (ctx: Pick<ProviderContext, "stealth">) => {
		await fetchStealth(ctx);
		return { kind: "complete", turnId: "complete" } as const;
	};
	return createProviderDefinitionDouble({
		id: "stealth-telemetry-paths",
		allowedHosts: ["example.com"],
		credential: { keys: ["password"] },
		stealth: { browser: "chrome", os: "macos" },
		auth: {
			mode: "credentials",
			flow: {
				start: authFetch,
				continue: authFetch,
				poll: authFetch,
				abort: authFetch,
				refresh: authFetch,
			},
		},
		operations: {
			probe: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ status: z.number() }),
				handler: async (ctx) => ({ status: (await fetchStealth(ctx)).status }),
			},
		},
	});
}

function operationRequest(requestId: string, sentinel?: string) {
	return {
		requestId,
		input: {},
		...(sentinel
			? {
					connection: {
						id: "connection-1",
						mode: "credentials",
						secrets: { password: sentinel },
						metadata: {},
						externalRef: "external-1",
					},
				}
			: {}),
	};
}

function authRequest(requestId: string) {
	return {
		requestId,
		flowId: "flow-1",
		providerId: "stealth-telemetry-paths",
		tenantId: "tenant-1",
		connectionId: "connection-1",
		context: {},
		input: {},
	};
}

function statefulBody(requestId: string): { readonly timestamp: string; readonly body: string } {
	const timestamp = new Date().toISOString();
	return {
		timestamp,
		body: JSON.stringify({
			requestId,
			providerId: "stealth-telemetry-paths",
			operationId: "probe",
			sessionKey: "stealth-telemetry-paths:account:connection",
			connectionId: "connection-1",
			serviceAccountId: "account-1",
			ownerPodId: "pod-owner",
			generation: 7,
			sourcePodId: "pod-source",
			forwardedAt: timestamp,
			operationRequest: operationRequest(requestId),
		}),
	};
}

async function postPath(
	app: { request(path: string, init: RequestInit): Response | Promise<Response> },
	path: (typeof terminalPaths)[number],
	requestId: string,
	operationSentinel?: string,
): Promise<Response> {
	let body: string;
	let signed: Record<string, string> = {};
	if (path === "/__apifuse/stateful/operations") {
		const stateful = statefulBody(requestId);
		body = stateful.body;
		signed = {
			"x-apifuse-stateful-source-pod": "pod-source",
			...statefulSignedHeaders({
				secret: STATEFUL_SECRET,
				timestamp: stateful.timestamp,
				rawBody: body,
				method: "POST",
				path,
			}),
		};
	} else {
		body = JSON.stringify(
			path === "/v1/probe"
				? operationRequest(requestId, operationSentinel)
				: authRequest(requestId),
		);
	}
	return await app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json", ...signed },
		body,
	});
}

function decodedHeader(response: Response): Record<string, unknown> {
	const encoded = response.headers.get(PROVIDER_TELEMETRY_HEADER);
	expect(encoded).toBeTruthy();
	return JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8"));
}

function terminalEvent(events: ProviderServerLogEvent[]) {
	const event = [...events]
		.reverse()
		.find(
			(candidate) =>
				candidate.event === "provider_request_completed" ||
				candidate.event === "provider_request_failed",
		);
	expect(event).toBeDefined();
	return event!;
}

function assertStealthProjection(
	event: ProviderServerLogEvent,
	response: Response,
	profileId = { browser: "chrome", os: "macos" },
	attempts = 1,
) {
	const log = (event as ProviderServerLogEvent & { stealth?: StealthTelemetryLogPayload }).stealth;
	expect(log).toMatchObject({
		attempts,
		profileId,
		proxyUsed: false,
	});
	expect(log?.ms).toBeNumber();
	expect(log?.attemptSamples).toHaveLength(attempts);
	if (!log) throw new Error("Terminal event did not include stealth telemetry");
	const envelope = decodedHeader(response);
	expect(envelope).toMatchObject({ v: 1, taxonomy: expect.any(String) });
	expect(envelope.stealth).toEqual(new StealthTelemetryCollector().toHeaderPayload(log));
	return { log, header: envelope.stealth };
}

beforeEach(() => {
	wreqState.queue.length = 0;
	wreqState.calls.length = 0;
	wreqState.clients.length = 0;
});

describe("stealth server terminal telemetry paths", () => {
	it("keeps resolver diagnostics intact after a prior stealth request sets cookies", async () => {
		const sentinelDescription = "SENTINEL vendor account diagnostics";
		const originalKey = process.env.APIFUSE__RESOLVER__CAPSOLVER__API_KEY;
		process.env.APIFUSE__RESOLVER__CAPSOLVER__API_KEY = "capsolver-regression-key";
		const adapter: ResolverVendorAdapter = {
			id: "capsolver",
			supports: () => true,
			async solve(_challenge, _identity, _signal, traceRecorder) {
				const fail = () => {
					throw new ResolverVendorUnavailableError("capsolver", "transport_failure", {
						upstreamHost: "sentinel.vendor.invalid",
						phase: "create_task",
					});
				};
				return traceRecorder
					? traceRecorder.runSpan("resolver.vendor.create_task", fail, {
							onError: () => ({
								vendor_error_code: "SENTINEL_ERROR",
								vendor_error_description: sentinelDescription,
							}),
						})
					: fail();
			},
		};
		const restoreAdapter = swapResolverAdapterFactoryForTests("capsolver", () => adapter);
		try {
			const provider = createStealthProvider();
			provider.resolver = { vendors: ["capsolver"], kinds: ["turnstile"] };
			provider.operations = {
				seed: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({ status: z.number() }),
					handler: async (ctx) => {
						const session = ctx.stealth.createSession();
						const response = await session.fetch("/seed", { retry: false });
						session.cookies.setFromCookieStrings(["sid=account; Path=/"]);
						return { status: response.status };
					},
				},
				solve: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					handler: async (ctx) => {
						await ctx.resolver.solve({
							kind: "turnstile",
							siteKey: "site-key",
							pageUrl: "https://example.com/challenge",
						});
						return { ok: true };
					},
				},
			};
			const events: ProviderServerLogEvent[] = [];
			const app = await (await import("../server/serve.js")).createServerAppAsync(provider, {
				logger: (event) => events.push(event),
			});
			wreqState.queue.push({ kind: "response", status: 200, body: "seed" });
			const seedResponse = await app.request("/v1/seed", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "cookie-seed", input: {} }),
			});
			expect(seedResponse.status).toBe(200);
			const solveResponse = await app.request("/v1/solve", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestId: "resolver-after-cookie", input: {} }),
			});
			expect(solveResponse.status).toBe(500);
			const failed = [...events].reverse().find((event) => event.event === "provider_request_failed");
			expect(failed?.resolver).toMatchObject({
				lastVendorErrorDescription: sentinelDescription,
			});
		} finally {
			restoreAdapter();
			if (originalKey === undefined) delete process.env.APIFUSE__RESOLVER__CAPSOLVER__API_KEY;
			else process.env.APIFUSE__RESOLVER__CAPSOLVER__API_KEY = originalKey;
		}
	});

	it.each(
		terminalPaths.flatMap((path) => [
			{ path, outcome: "completed" as const },
			{ path, outcome: "failed" as const },
		]),
	)("emits stealth on $outcome $path", async ({ path, outcome }) => {
		const { createServerAppAsync } = await import("../server/serve.js");
		const events: ProviderServerLogEvent[] = [];
		const app = await createServerAppAsync(createStealthProvider(), {
			logger: (event) => events.push(event),
			statefulForwarding: { secret: STATEFUL_SECRET, validateOwnerFence: async () => true },
			internalOperationExecutor: async ({ ctx }) => ({
				status: (await fetchStealth(ctx)).status,
			}),
		});
		if (outcome === "completed") {
			wreqState.queue.push({
				kind: "response",
				status: 204,
				body: "",
				url: "https://example.com/telemetry",
			});
		} else {
			wreqState.queue.push({ kind: "error", error: new Error("upstream transport failed") });
		}

		const response = await postPath(app, path, `${outcome}-${path}`);
		const event = terminalEvent(events);
		expect(event.event).toBe(`provider_request_${outcome}`);
		expect(outcome === "completed" ? response.status === 200 : response.status >= 400).toBe(true);
		const { log } = assertStealthProjection(event, response);
		if (path === "/v1/probe" && outcome === "completed") {
			expect(log).toEqual({
				attempts: 1,
				poolRefreshes: 0,
				redirectHops: 0,
				profileId: { browser: "chrome", os: "macos" },
				proxyUsed: false,
				requestClass: "navigation",
				safeRefetch: 0,
				lastStatus: 204,
				ms: expect.any(Number),
				attemptSamples: [{ n: 1, ms: expect.any(Number), status: 204, kind: "request" }],
			});
		}
		expect(wreqState.calls).toHaveLength(1);
	});

	it("omits the stealth sibling when a declared transport is unused", async () => {
		const { createServerAppAsync } = await import("../server/serve.js");
		const provider = createStealthProvider();
		provider.operations = {
			unused: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => ({ ok: true }),
			},
		};
		const events: ProviderServerLogEvent[] = [];
		const app = await createServerAppAsync(provider, { logger: (event) => events.push(event) });
		const response = await app.request("/v1/unused", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(operationRequest("unused")),
		});
		expect(response.status).toBe(200);
		expect(terminalEvent(events)).not.toHaveProperty("stealth");
		const encoded = response.headers.get(PROVIDER_TELEMETRY_HEADER);
		if (encoded) expect(decodedHeader(response)).not.toHaveProperty("stealth");
		expect(wreqState.calls).toEqual([]);
	});

	it("redacts a 12-character request-dictionary sentinel from retained transport diagnostics", async () => {
		const sentinel = "SENTINEL_123";
		const { createServerAppAsync } = await import("../server/serve.js");
		const events: ProviderServerLogEvent[] = [];
		const app = await createServerAppAsync(createStealthProvider(), {
			logger: (event) => events.push(event),
		});
		wreqState.queue.push({
			kind: "error",
			error: new Error(`vendor rejected dictionary value ${sentinel}`),
		});
		const response = await postPath(app, "/v1/probe", "redaction", sentinel);
		const event = terminalEvent(events);
		expect(event.event).toBe("provider_request_failed");
		const serializedLog = JSON.stringify(event);
		const serializedHeader = JSON.stringify(decodedHeader(response));
		expect(serializedLog).not.toContain(sentinel);
		expect(serializedHeader).not.toContain(sentinel);
		expect(serializedLog).toContain("[REDACTED]");
	});
});

describe("stealth server construction-path sink matrix", () => {
	it.each([
		"sync",
		"async",
	] as const)("threads the request sink through the %s eager capability builder and a session profile override", async (factory) => {
		const { createServerApp, createServerAppAsync } = await import("../server/serve.js");
		const provider = createStealthProvider();
		provider.operations = {
			probe: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ status: z.number() }),
				handler: async (ctx) => {
					const session = ctx.stealth.createSession({
						stealth: { browser: "firefox", os: "linux" },
					});
					return { status: (await session.fetch("/override", { retry: false })).status };
				},
			},
		};
		const events: ProviderServerLogEvent[] = [];
		const app = await (factory === "sync" ? createServerApp : createServerAppAsync)(provider, {
			logger: (event) => events.push(event),
		});
		wreqState.queue.push({ kind: "response", status: 200, body: "ok" });
		const response = await postPath(app, "/v1/probe", `${factory}-eager`);
		expect(response.status).toBe(200);
		const { log } = assertStealthProjection(terminalEvent(events), response, {
			browser: "firefox",
			os: "linux",
		});
		expect(log?.profileId).toEqual({ browser: "firefox", os: "linux" });
		expect(wreqState.clients[0]).toMatchObject({ browser: "firefox_147", os: "linux" });
	});

	it.each([
		"sync",
		"async",
	] as const)("threads the request sink through the %s lazy client and resolver-override SBSD bound transport", async (factory) => {
		const { createServerApp, createServerAppAsync } = await import("../server/serve.js");
		const provider = createStealthProvider();
		delete provider.stealth;
		provider.resolver = {
			vendors: ["hypersolutions"],
			kinds: ["akamai_sbsd"],
			clientProfile: "chrome149",
		};
		let resolverCalls = 0;
		const resolver = {
			async solve() {
				resolverCalls++;
				return {
					form: "cookie_state",
					kind: "akamai_sbsd",
					outcome: "payload_accepted",
					verified: false,
					stateCookieName: "sbsd_o",
				} as const;
			},
		} as ResolverContext;
		const events: ProviderServerLogEvent[] = [];
		const app = await (factory === "sync" ? createServerApp : createServerAppAsync)(provider, {
			resolver,
			logger: (event) => events.push(event),
		});
		wreqState.queue.push(
			{
				kind: "response",
				status: 403,
				body: '<div id="sec-bc-tile-container"></div><script src="/challenge?v=f2a6dfca-cc41-5685-7029-1dbc32e8fe77&t=fixture"></script>',
				url: "https://example.com/telemetry",
			},
			{ kind: "response", status: 200, body: "solved", url: "https://example.com/telemetry" },
		);
		const response = await postPath(app, "/auth/start", `${factory}-lazy-sbsd`);
		expect(response.status).toBe(200);
		expect(resolverCalls).toBe(1);
		const { log, header } = assertStealthProjection(
			terminalEvent(events),
			response,
			{ browser: "chrome", os: "macos" },
			2,
		);
		expect(log).toMatchObject({
			sbsdDetected: true,
			sbsdOutcome: "refetch_clear",
			safeRefetch: 1,
		});
		expect(log?.attemptSamples).toEqual([
			{
				n: 1,
				ms: expect.any(Number),
				status: 403,
				e: "upstream_http_error",
				kind: "request",
			},
			{ n: 2, ms: expect.any(Number), status: 200, kind: "request" },
		]);
		expect(header).toMatchObject({
			sbsdDetected: true,
			sbsdOutcome: log?.sbsdOutcome,
			safeRefetch: 1,
		});
		expect(wreqState.calls).toHaveLength(2);
	});
});

it("redacts cookie material from retained stealth diagnostics", async () => {
	const { createServerAppAsync } = await import("../server/serve.js");
	const events: ProviderServerLogEvent[] = [];
	const base = createStealthProvider();
	const provider = createProviderDefinitionDouble({
		...base,
		operations: {
			probe: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ status: z.number() }),
				handler: async (ctx) => {
					await ctx.stealth.fetch("https://example.com/set", {
						retry: false,
						throwOnHttpError: false,
					});
					return {
						status: (await ctx.stealth.fetch("https://example.com/echo", { retry: false })).status,
					};
				},
			},
		},
	});
	const app = await createServerAppAsync(provider, { logger: (event) => events.push(event) });
	wreqState.queue.push(
		{ kind: "response", status: 403, body: "{}" },
		{
			kind: "error",
			error: new Error(
				"transport failed; Cookie: sbsd_o=fixture-state; Set-Cookie: sid=cookie12byte!",
			),
		},
	);
	const response = await app.request("/v1/probe", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(operationRequest("cookie-review")),
	});
	const terminal = terminalEvent(events);
	const log = (terminal as ProviderServerLogEvent & { stealth?: StealthTelemetryLogPayload })
		.stealth;
	const header = decodedHeader(response);
	expect(JSON.stringify(log)).not.toContain("fixture-state");
	expect(JSON.stringify(log)).not.toContain("cookie12byte!");
	expect(JSON.stringify(header)).not.toContain("fixture-state");
	expect(JSON.stringify(header)).not.toContain("cookie12byte!");
});
