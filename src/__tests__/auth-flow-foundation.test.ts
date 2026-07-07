import { describe, expect, it } from "bun:test";

import {
	combineCeremonies,
	createDeviceFlowCeremony,
	createFormCeremony,
	createMagicLinkCeremony,
	createOAuth2Ceremony,
	createSwitchCeremony,
	createWebAuthnCeremony,
	validateCeremonyOutput,
} from "../ceremonies";
import { TurnValidationError } from "../errors";
import { createFlowContext } from "../runtime/auth-flow";
import { createEnvContext } from "../runtime/env";
import { prevalidate } from "../runtime/prevalidate";
import type { HttpClient, HttpResponse } from "../types";

type RouteHandler = (body?: unknown) => Promise<unknown> | unknown;

function createHttpResponse(data: unknown): HttpResponse<unknown> {
	const body = JSON.stringify(data);
	const bodyBytes = new TextEncoder().encode(body);
	return {
		status: 200,
		ok: true,
		headers: {},
		data,
		json: async <U = unknown>() => data as U,
		text: async () => body,
		arrayBuffer: async () =>
			bodyBytes.buffer.slice(
				bodyBytes.byteOffset,
				bodyBytes.byteOffset + bodyBytes.byteLength,
			),
		bytes: async () => bodyBytes.slice(0),
	};
}

function createMockHttpClient(
	routes: Record<string, RouteHandler>,
): HttpClient {
	const invoke = async (method: string, url: string, body?: unknown) => {
		const route = routes[`${method} ${url}`];
		if (!route) {
			throw new Error(`Missing route: ${method} ${url}`);
		}

		return createHttpResponse(await route(body));
	};

	return {
		request: (url, options) => invoke(options?.method ?? "GET", url),
		get: (url) => invoke("GET", url),
		post: (url, body) => invoke("POST", url, body),
		put: (url, body) => invoke("PUT", url, body),
		delete: (url) => invoke("DELETE", url),
		stream: async () => {
			throw new Error("stream unsupported in auth flow test client");
		},
		sse: async () => {
			throw new Error("sse unsupported in auth flow test client");
		},
	};
}

function createTestContext(
	routes: Record<string, RouteHandler> = {},
	allowedKeys: string[] = [],
) {
	process.env.TEST_OAUTH_CLIENT_ID = "client-id";
	process.env.TEST_OAUTH_CLIENT_SECRET = "client-secret";

	return createFlowContext({
		http: createMockHttpClient(routes),
		env: createEnvContext(["TEST_OAUTH_CLIENT_ID", "TEST_OAUTH_CLIENT_SECRET"]),
		tenantId: "tenant-1",
		providerId: "demo-provider",
		allowedKeys,
	});
}

describe("prevalidate", () => {
	it("accepts valid payloads", () => {
		expect(
			prevalidate(
				{
					type: "object",
					required: ["email"],
					properties: {
						email: { type: "string", pattern: "^[^@]+@[^@]+$" },
					},
				},
				{ email: "demo@example.com" },
			),
		).toEqual({ valid: true });
	});

	it("returns structured errors for invalid data", () => {
		const result = prevalidate(
			{
				type: "object",
				required: ["email"],
				properties: {
					email: { type: "string", pattern: "^[^@]+@[^@]+$" },
				},
			},
			{ email: "demo" },
		);

		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ path: "$.email" }),
		);
	});

	it("rejects unsupported RE2 patterns", () => {
		const result = prevalidate(
			{ type: "string", pattern: "(cat|dog)\\1" },
			"catcat",
		);

		expect(result.valid).toBe(false);
		expect(result.errors?.[0]?.message).toContain("invalid escape sequence");
	});

	it("returns timeout errors", () => {
		const result = prevalidate({ type: "string" }, "ok", { timeoutMs: -1 });

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			{ path: "$", message: "Prevalidation timed out after -1ms" },
		]);
	});
});

describe("validateCeremonyOutput", () => {
	it("rejects malformed turns", () => {
		expect(() => validateCeremonyOutput({ kind: "form" })).toThrow(
			TurnValidationError,
		);
	});
});

describe("createOAuth2Ceremony", () => {
	it("handles happy path", async () => {
		const ctx = createTestContext(
			{
				"POST https://token.example.com": () => ({
					access_token: "access",
					refresh_token: "refresh",
				}),
			},
			["__oauth2_state", "__oauth2_pkce_verifier"],
		);
		const ceremony = createOAuth2Ceremony({
			authorizeUrl: "https://auth.example.com/authorize",
			tokenUrl: "https://token.example.com",
			clientIdEnvKey: "TEST_OAUTH_CLIENT_ID",
			clientSecretEnvKey: "TEST_OAUTH_CLIENT_SECRET",
			scopes: ["read"],
			usePKCE: true,
		});

		const startTurn = await ceremony.start(ctx);
		const continueTurn = await ceremony.continue(ctx, {
			code: "auth-code",
			state: String(ctx.context.get("__oauth2_state")),
		});

		expect(startTurn.kind).toBe("redirect");
		expect(startTurn.data?.url).toContain("client_id=client-id");
		expect(continueTurn.kind).toBe("complete");
		expect(continueTurn.data?.credential).toEqual({
			access_token: "access",
			refresh_token: "refresh",
		});
	});

	it("returns retry turn on invalid callback payload", async () => {
		const ctx = createTestContext({}, ["__oauth2_state"]);
		const ceremony = createOAuth2Ceremony({
			authorizeUrl: "https://auth.example.com/authorize",
			tokenUrl: "https://token.example.com",
			clientIdEnvKey: "TEST_OAUTH_CLIENT_ID",
			clientSecretEnvKey: "TEST_OAUTH_CLIENT_SECRET",
			scopes: [],
		});

		await ceremony.start(ctx);
		const turn = await ceremony.continue(ctx, { code: "bad", state: "wrong" });

		expect(turn.kind).toBe("retry");
	});

	it("aborts", async () => {
		const ceremony = createOAuth2Ceremony({
			authorizeUrl: "https://auth.example.com/authorize",
			tokenUrl: "https://token.example.com",
			clientIdEnvKey: "TEST_OAUTH_CLIENT_ID",
			clientSecretEnvKey: "TEST_OAUTH_CLIENT_SECRET",
			scopes: [],
		});

		const abortResult = await ceremony.abort?.(createTestContext());
		expect(abortResult).toBeDefined();
		expect(abortResult?.kind).toBe("abort");
	});
});

describe("createDeviceFlowCeremony", () => {
	it("handles happy path", async () => {
		const ctx = createTestContext(
			{
				"POST https://device.example.com": () => ({
					device_code: "device-code",
					user_code: "ABCD",
					verification_uri: "https://verify.example.com",
				}),
				"POST https://token.example.com": () => ({ access_token: "access" }),
			},
			["__device_flow"],
		);
		const ceremony = createDeviceFlowCeremony({
			deviceCodeUrl: "https://device.example.com",
			tokenUrl: "https://token.example.com",
			clientIdEnvKey: "TEST_OAUTH_CLIENT_ID",
			scopes: ["read"],
		});

		expect((await ceremony.start(ctx)).kind).toBe("message");
		expect((await ceremony.poll?.(ctx))?.kind).toBe("complete");
	});

	it("returns abort turn when state expires", async () => {
		const ctx = createTestContext({}, ["__device_flow"]);
		const ceremony = createDeviceFlowCeremony({
			deviceCodeUrl: "https://device.example.com",
			tokenUrl: "https://token.example.com",
			clientIdEnvKey: "TEST_OAUTH_CLIENT_ID",
			scopes: [],
		});

		expect((await ceremony.poll?.(ctx))?.kind).toBe("abort");
	});

	it("aborts", async () => {
		const ceremony = createDeviceFlowCeremony({
			deviceCodeUrl: "https://device.example.com",
			tokenUrl: "https://token.example.com",
			clientIdEnvKey: "TEST_OAUTH_CLIENT_ID",
			scopes: [],
		});

		const abortResult = await ceremony.abort?.(createTestContext());
		expect(abortResult).toBeDefined();
		expect(abortResult?.kind).toBe("abort");
	});
});

describe("createWebAuthnCeremony", () => {
	it("handles happy path", async () => {
		const ctx = createTestContext(
			{ "POST https://verify.example.com": () => ({ ok: true }) },
			["__webauthn_challenge"],
		);
		const ceremony = createWebAuthnCeremony({
			rpId: "example.com",
			verifyUrl: "https://verify.example.com",
		});

		expect((await ceremony.start(ctx)).kind).toBe("challenge");
		expect(
			(
				await ceremony.continue(ctx, {
					attestation: { id: "credential-id" },
				})
			).kind,
		).toBe("complete");
	});

	it("returns retry turn when attestation is missing", async () => {
		const ctx = createTestContext({}, ["__webauthn_challenge"]);
		const ceremony = createWebAuthnCeremony({ rpId: "example.com" });

		await ceremony.start(ctx);
		expect((await ceremony.continue(ctx, {})).kind).toBe("retry");
	});

	it("aborts", async () => {
		const ceremony = createWebAuthnCeremony({ rpId: "example.com" });
		const abortResult = await ceremony.abort?.(createTestContext());
		expect(abortResult).toBeDefined();
		expect(abortResult?.kind).toBe("abort");
	});
});

describe("createMagicLinkCeremony", () => {
	it("handles happy path", async () => {
		const ctx = createTestContext(
			{
				"POST https://magic.example.com/send": () => ({ queued: true }),
				"POST https://magic.example.com/verify": () => ({
					completed: true,
					credential: { token: "magic-token" },
				}),
			},
			["__magic_link"],
		);
		const ceremony = createMagicLinkCeremony({
			sendUrl: "https://magic.example.com/send",
			verifyUrl: "https://magic.example.com/verify",
		});

		expect(
			(await ceremony.start(ctx, { email: "demo@example.com" })).kind,
		).toBe("message");
		expect((await ceremony.poll?.(ctx))?.kind).toBe("complete");
	});

	it("returns form turn when email is missing", async () => {
		const ceremony = createMagicLinkCeremony({
			sendUrl: "https://magic.example.com/send",
			verifyUrl: "https://magic.example.com/verify",
		});

		expect((await ceremony.start(createTestContext(), {})).kind).toBe("form");
	});

	it("returns abort when state expires", async () => {
		const ctx = createTestContext(
			{ "POST https://magic.example.com/send": () => ({ queued: true }) },
			["__magic_link"],
		);
		const ceremony = createMagicLinkCeremony({
			sendUrl: "https://magic.example.com/send",
			verifyUrl: "https://magic.example.com/verify",
			expiresInMs: -1,
		});

		await ceremony.start(ctx, { email: "demo@example.com" });
		expect((await ceremony.poll?.(ctx))?.kind).toBe("abort");
	});
});

describe("createFormCeremony", () => {
	it("handles happy path", async () => {
		const ceremony = createFormCeremony({
			schema: {
				type: "object",
				required: ["username"],
				properties: { username: { type: "string" } },
			},
		});

		expect((await ceremony.start(createTestContext())).kind).toBe("form");
		expect(
			(await ceremony.continue(createTestContext(), { username: "demo" })).kind,
		).toBe("complete");
	});

	it("preserves provider-declared form field order in expected input metadata", async () => {
		const ceremony = createFormCeremony({
			schema: {
				type: "object",
				required: ["phone", "password"],
				properties: {
					phone: { type: "string" },
					password: { type: "string" },
				},
			},
		});

		const turn = await ceremony.start(createTestContext());

		expect(turn.expectedInput?.["x-apifuse-field-order"]).toEqual([
			"phone",
			"password",
		]);
	});

	it("returns retry turn on validation failure", async () => {
		const ceremony = createFormCeremony({
			schema: {
				type: "object",
				required: ["username"],
				properties: { username: { type: "string" } },
			},
		});

		expect((await ceremony.continue(createTestContext(), {})).kind).toBe(
			"retry",
		);
	});

	it("aborts", async () => {
		const ceremony = createFormCeremony({ schema: { type: "object" } });
		const abortResult = await ceremony.abort?.(createTestContext());
		expect(abortResult).toBeDefined();
		expect(abortResult?.kind).toBe("abort");
	});
});

describe("combineCeremonies", () => {
	it("runs ceremonies sequentially", async () => {
		const ctx = createTestContext({}, ["__combined_stage"]);
		const ceremony = combineCeremonies(
			createFormCeremony({
				schema: {
					type: "object",
					required: ["username"],
					properties: { username: { type: "string" } },
				},
			}),
			createFormCeremony({
				schema: {
					type: "object",
					required: ["otp"],
					properties: { otp: { type: "string" } },
				},
			}),
		);

		expect((await ceremony.start(ctx)).kind).toBe("form");
		expect((await ceremony.continue(ctx, { username: "demo" })).kind).toBe(
			"form",
		);
		expect((await ceremony.continue(ctx, { otp: "123456" })).kind).toBe(
			"complete",
		);
	});

	it("returns retry when current stage cannot poll", async () => {
		const ctx = createTestContext({}, ["__combined_stage"]);
		const ceremony = combineCeremonies(
			createFormCeremony({ schema: { type: "object" } }),
		);

		await ceremony.start(ctx);
		expect((await ceremony.poll?.(ctx))?.kind).toBe("retry");
	});

	it("aborts", async () => {
		const ceremony = combineCeremonies(
			createFormCeremony({ schema: { type: "object" } }),
		);
		const abortResult = await ceremony.abort?.(
			createTestContext({}, ["__combined_stage"]),
		);
		expect(abortResult).toBeDefined();
		expect(abortResult?.kind).toBe("abort");
	});
});

describe("createSwitchCeremony", () => {
	it("dispatches to the selected sub-ceremony", async () => {
		const ctx = createTestContext({}, ["__switch_selection"]);
		const ceremony = createSwitchCeremony({
			choices: {
				email: createFormCeremony({ schema: { type: "object" } }),
				otp: createFormCeremony({ schema: { type: "object" } }),
			},
		});

		expect((await ceremony.start(ctx)).kind).toBe("multi_choice");
		expect((await ceremony.continue(ctx, { choice: "email" })).kind).toBe(
			"form",
		);
	});

	it("returns retry turn for invalid choice", async () => {
		const ctx = createTestContext({}, ["__switch_selection"]);
		const ceremony = createSwitchCeremony({
			choices: { email: createFormCeremony({ schema: { type: "object" } }) },
		});

		expect((await ceremony.continue(ctx, { choice: "sms" })).kind).toBe(
			"retry",
		);
	});

	it("aborts", async () => {
		const ceremony = createSwitchCeremony({
			choices: { email: createFormCeremony({ schema: { type: "object" } }) },
		});
		const abortResult = await ceremony.abort?.(
			createTestContext({}, ["__switch_selection"]),
		);
		expect(abortResult).toBeDefined();
		expect(abortResult?.kind).toBe("abort");
	});
});
