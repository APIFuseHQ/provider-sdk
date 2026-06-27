import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { createServerApp } from "../server/serve";
import type { AuthTurn, ProviderDefinition } from "../types";

const JsonRecordSchema = z.record(z.string(), z.unknown());
const IsoDateTimeSchema = z.iso.datetime();

const AuthTurnShapeSchema = z
	.object({
		kind: z.string().min(1),
		turnId: z.string().min(1),
		expiresAt: IsoDateTimeSchema.optional(),
		data: JsonRecordSchema.optional(),
		expectedInput: JsonRecordSchema.optional(),
		hint: z.string().optional(),
		hintKey: z.string().optional(),
		timing: z
			.object({
				suggestedPollIntervalMs: z.number().positive().optional(),
				maxWaitMs: z.number().positive().optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

const DocumentedExpectedInputSchema = z.object({
	schema: z.object({ type: z.string() }).and(JsonRecordSchema),
	clientValidation: z.enum(["strict", "hint", "none"]).optional(),
	examples: z.array(z.unknown()).optional(),
});

const DocumentedAuthTurnShapeSchema = AuthTurnShapeSchema.extend({
	expectedInput: DocumentedExpectedInputSchema.optional(),
});

const expiresAt = "2027-01-01T00:00:00.000Z";

const turns = {
	webauthn: {
		kind: "webauthn",
		turnId: "turn_webauthn",
		expiresAt,
		data: { challenge: "base64url-challenge", rpId: "example.com" },
		expectedInput: {
			schema: {
				type: "object",
				required: ["attestation"],
				properties: { attestation: { type: "object" } },
			},
			clientValidation: "strict",
		},
		hint: "Complete the WebAuthn browser challenge.",
	},
	redirect: {
		kind: "redirect",
		turnId: "turn_redirect",
		expiresAt,
		data: { url: "https://auth.example.com/oauth/authorize?state=state-1" },
		expectedInput: {
			schema: {
				type: "object",
				required: ["code", "state"],
				properties: { code: { type: "string" }, state: { type: "string" } },
			},
			clientValidation: "strict",
		},
		hint: "Redirect to the provider authorization URL.",
	},
	oauth: {
		kind: "oauth",
		turnId: "turn_oauth",
		expiresAt,
		data: {
			authorizeUrl: "https://auth.example.com/oauth/authorize",
			clientId: "client-id",
			scopes: ["read", "write"],
			state: "state-2",
		},
		expectedInput: {
			schema: {
				type: "object",
				required: ["code", "state"],
				properties: { code: { type: "string" }, state: { type: "string" } },
			},
		},
		hint: "Complete the OAuth authorization ceremony.",
	},
	form: {
		kind: "form",
		turnId: "turn_form",
		expiresAt,
		data: { title: "Sign in" },
		expectedInput: {
			schema: {
				type: "object",
				required: ["username", "password"],
				properties: {
					username: { type: "string" },
					password: { type: "string", minLength: 8 },
				},
			},
			clientValidation: "strict",
			examples: [{ username: "demo@example.com", password: "correct horse" }],
		},
		hint: "Collect credential form fields.",
	},
	choice: {
		kind: "choice",
		turnId: "turn_choice",
		expiresAt,
		data: { choices: [{ id: "sms" }, { id: "email" }] },
		expectedInput: {
			schema: {
				type: "object",
				required: ["choice"],
				properties: { choice: { type: "string", enum: ["sms", "email"] } },
			},
			clientValidation: "strict",
		},
		hint: "Choose an authentication method.",
	},
	retry: {
		kind: "retry",
		turnId: "turn_retry",
		expiresAt,
		data: { code: "credentials_invalid", fieldErrors: { password: "wrong" } },
		expectedInput: {
			schema: {
				type: "object",
				required: ["password"],
				properties: { password: { type: "string" } },
			},
			clientValidation: "hint",
		},
		hint: "Fix the highlighted fields and submit again.",
	},
	error: {
		kind: "error",
		turnId: "turn_error",
		data: { code: "provider_unavailable", message: "Try again later" },
		hint: "Show a recoverable auth-flow error.",
	},
	complete: {
		kind: "complete",
		turnId: "turn_complete",
		data: {
			credential: {
				access_token: "access-token",
				refresh_token: "refresh-token",
			},
			metadata: { accountId: "acct_1" },
		},
		hint: "Persist the returned credential and finish the flow.",
	},
	abort: {
		kind: "abort",
		turnId: "turn_abort",
		data: { code: "user_cancelled", message: "The user cancelled the flow." },
		hint: "Terminate without persisting a connection.",
	},
} satisfies Record<string, AuthTurn>;

type TurnKind = keyof typeof turns;

function createProvider(): ProviderDefinition {
	return {
		id: "auth-contract-provider",
		version: "1.0.0",
		runtime: "standard",
		meta: { displayName: "Auth Contract Provider", category: "test" },
		auth: {
			mode: "credentials",
			flow: {
				start: async () => turns.webauthn,
				continue: async (_ctx, input) => {
					const kind = input?.kind;
					return typeof kind === "string" && kind in turns
						? turns[kind as TurnKind]
						: turns.error;
				},
				poll: async () => turns.retry,
				abort: async () => turns.abort,
			},
		},
		operations: {},
	};
}

function authRequest(input?: Record<string, unknown>) {
	return {
		requestId: "req_auth_contract",
		flowId: "flow_auth_contract",
		connectionId: "af_con_1234567890123456789012",
		externalRef: "external-1",
		tenantId: "tenant-1",
		providerId: "auth-contract-provider",
		...(input ? { input } : {}),
	};
}

async function requestTurn(kind: TurnKind): Promise<AuthTurn> {
	const app = createServerApp(createProvider(), { logger: () => {} });
	const response = await app.request("/auth/continue", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(authRequest({ kind })),
	});
	const body = (await response.json()) as { data: AuthTurn };

	expect(response.status).toBe(200);
	return body.data;
}

function assertAuthTurnContract(turn: AuthTurn): void {
	const parsed = AuthTurnShapeSchema.parse(turn);
	expect(parsed.turnId).toMatch(/^turn_/);
	expect(Object.keys(parsed)).not.toContain("turn_id");
	expect(Object.keys(parsed)).not.toContain("expires_at");
	DocumentedAuthTurnShapeSchema.parse(turn);
}

describe("auth-flow AuthTurn provider contract", () => {
	it("wraps auth-flow turns under the provider server data envelope", async () => {
		const app = createServerApp(createProvider(), { logger: () => {} });
		const response = await app.request("/auth/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(authRequest()),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: turns.webauthn });
	});

	it.each(
		Object.keys(turns) as TurnKind[],
	)("accepts %s AuthTurn JSON shape from a provider flow", async (kind) => {
		const turn = await requestTurn(kind);

		expect(turn).toEqual(turns[kind]);
		assertAuthTurnContract(turn);
	});

	it("requires expiresAt on interactive non-terminal turns", () => {
		for (const kind of [
			"webauthn",
			"redirect",
			"oauth",
			"form",
			"choice",
			"retry",
		] satisfies TurnKind[]) {
			expect(turns[kind].expiresAt).toBe(expiresAt);
		}

		expect(turns.complete.expiresAt).toBeUndefined();
		expect(turns.abort.expiresAt).toBeUndefined();
		expect(turns.error.expiresAt).toBeUndefined();
	});

	it("routes poll and disconnect to retry and abort AuthTurn shapes", async () => {
		const app = createServerApp(createProvider(), { logger: () => {} });
		const [pollResponse, disconnectResponse] = await Promise.all([
			app.request("/auth/poll", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(authRequest()),
			}),
			app.request("/auth/disconnect", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(authRequest()),
			}),
		]);

		expect(pollResponse.status).toBe(200);
		expect(disconnectResponse.status).toBe(200);
		expect(await pollResponse.json()).toEqual({ data: turns.retry });
		expect(await disconnectResponse.json()).toEqual({ data: turns.abort });
	});

	it("rejects AuthTurn values missing required fields", () => {
		expect(() => AuthTurnShapeSchema.parse({ kind: "form" })).toThrow(
			z.ZodError,
		);
		expect(() =>
			AuthTurnShapeSchema.parse({ turnId: "turn_missing_kind" }),
		).toThrow(z.ZodError);
	});

	it("rejects malformed documented expectedInput schema", () => {
		expect(() =>
			DocumentedAuthTurnShapeSchema.parse({
				kind: "form",
				turnId: "turn_bad_expected_input",
				expectedInput: { clientValidation: "strict" },
			}),
		).toThrow(z.ZodError);
	});

	it("returns a provider server schema error for malformed auth-flow requests", async () => {
		const app = createServerApp(createProvider(), { logger: () => {} });
		const response = await app.request("/auth/continue", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ flowId: "flow_missing_request_id" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: expect.objectContaining({
				code: "invalid_request",
				message: "Invalid request body",
				details: expect.arrayContaining([
					expect.objectContaining({ path: "requestId" }),
				]),
			}),
		});
	});
});
