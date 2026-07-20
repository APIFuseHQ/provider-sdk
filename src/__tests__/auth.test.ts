import { describe, expect, it } from "bun:test";

import { ProviderError } from "../errors.js";
import { credentialsAuthChallenge, defineCredentialsAuth } from "../provider.js";
import { createScratchpad } from "../runtime/auth-flow.js";
import type { FlowContext } from "../types.js";

function createFlowContext(initialContext: Record<string, unknown> = {}): FlowContext {
	return {
		tenantId: "tenant-test",
		providerId: "provider-test",
		context: createScratchpad(["__credentialsAuthChallenge"], initialContext),
	} as FlowContext;
}

describe("defineCredentialsAuth", () => {
	it("creates the start form and complete credential turn from one login callback", async () => {
		const credentialsAuth = defineCredentialsAuth({
			fields: {
				email: { type: "email", labelKey: "auth.email.label" },
				password: { type: "password", labelKey: "auth.password.label" },
			},
			credentialKeys: ["cookie", "sessionId"] as const,
			storesReusableSecret: true,
			justification: "Session cookie is required for authenticated operations.",
			login: async (_ctx, input) => ({
				credential: {
					cookie: `session-for:${input.email}`,
					sessionId: "sid-123",
				},
			}),
		});

		expect(credentialsAuth.auth.mode).toBe("credentials");
		expect(credentialsAuth.credential.keys).toEqual(["cookie", "sessionId"]);
		expect(credentialsAuth.context.keys).toEqual(["__credentialsAuthChallenge"]);

		const start = await credentialsAuth.auth.flow?.start(createFlowContext());
		expect(start).toMatchObject({
			kind: "form",
			turnId: "credentials.start",
			expectedInput: {
				type: "object",
				required: ["email", "password"],
			},
		});
		expect(start?.expectedInput?.properties).toMatchObject({
			email: { type: "string", format: "email" },
			password: { type: "string", format: "password", sensitive: true },
		});

		const complete = await credentialsAuth.auth.flow?.continue(createFlowContext(), {
			email: "user@example.test",
			password: "secret",
		});
		expect(complete).toEqual({
			kind: "complete",
			turnId: "credentials.complete",
			data: {
				credential: {
					cookie: "session-for:user@example.test",
					sessionId: "sid-123",
				},
			},
		});
	});

	it("returns a retry turn before login when required fields are missing", async () => {
		let loginCalled = false;
		const credentialsAuth = defineCredentialsAuth({
			fields: {
				email: { type: "email" },
				password: { type: "password" },
			},
			credentialKeys: ["cookie"] as const,
			login: async () => {
				loginCalled = true;
				return { credential: { cookie: "session" } };
			},
		});

		const retry = await credentialsAuth.auth.flow?.continue(createFlowContext(), {
			email: "user@example.test",
		});

		expect(loginCalled).toBe(false);
		expect(retry).toMatchObject({
			kind: "retry",
			turnId: "credentials.retry",
			data: {
				fieldErrors: { password: "Required" },
				fieldErrorKeys: { password: "auth.credentials.fieldRequired" },
			},
		});
	});

	it("fails loudly when login omits a declared credential key", async () => {
		const credentialsAuth = defineCredentialsAuth({
			fields: { email: { type: "email" } },
			credentialKeys: ["cookie", "sessionId"] as const,
			login: async () => ({ credential: { cookie: "session" } as never }),
		});

		await expect(
			credentialsAuth.auth.flow?.continue(createFlowContext(), {
				email: "user@example.test",
			}),
		).rejects.toThrow(ProviderError);
		await expect(
			credentialsAuth.auth.flow?.continue(createFlowContext(), {
				email: "user@example.test",
			}),
		).rejects.toThrow(/sessionId/);
	});

	it("fails with provider error when login omits credential object", async () => {
		const credentialsAuth = defineCredentialsAuth({
			fields: { email: { type: "email" } },
			credentialKeys: ["cookie"] as const,
			login: async () => ({}) as never,
		});

		await expect(
			credentialsAuth.auth.flow?.continue(createFlowContext(), {
				email: "user@example.test",
			}),
		).rejects.toThrow(ProviderError);
		await expect(
			credentialsAuth.auth.flow?.continue(createFlowContext(), {
				email: "user@example.test",
			}),
		).rejects.toThrow(/credential object/);
	});

	it("models OTP challenges without hand-writing auth flow state turns", async () => {
		const ctx = createFlowContext();
		const credentialsAuth = defineCredentialsAuth({
			fields: {
				email: { type: "email" },
				password: { type: "password" },
			},
			credentialKeys: ["cookie"] as const,
			login: async () =>
				credentialsAuthChallenge("otp", {
					state: { transactionId: "txn-123" },
					hintKey: "auth.otp.prompt",
				}),
			challenges: {
				otp: {
					fields: {
						otp: { type: "otp", labelKey: "auth.otp.label" },
					},
					verify: async (_ctx, input, state) => ({
						credential: {
							cookie: `${state.transactionId}:${input.otp}`,
						},
					}),
				},
			},
		});

		const challenge = await credentialsAuth.auth.flow?.continue(ctx, {
			email: "user@example.test",
			password: "secret",
		});
		expect(challenge).toMatchObject({
			kind: "form",
			turnId: "credentials.otp",
			hintKey: "auth.otp.prompt",
			data: { challengeId: "otp" },
			expectedInput: {
				required: ["otp"],
				properties: { otp: { format: "otp", sensitive: true } },
			},
		});

		const complete = await credentialsAuth.auth.flow?.continue(ctx, { otp: "123456" });
		expect(complete).toEqual({
			kind: "complete",
			turnId: "credentials.complete",
			data: { credential: { cookie: "txn-123:123456" } },
		});
	});

	it("models manual HITL challenges through poll without provider-owned flow plumbing", async () => {
		const ctx = createFlowContext();
		let polls = 0;
		const credentialsAuth = defineCredentialsAuth({
			fields: {
				email: { type: "email" },
				password: { type: "password" },
			},
			credentialKeys: ["cookie"] as const,
			login: async () =>
				credentialsAuthChallenge("manualApproval", {
					state: { transactionId: "approve-123" },
					hintKey: "auth.manualApproval.openApp",
					timing: { suggestedPollIntervalMs: 3000, maxWaitMs: 120000 },
				}),
			challenges: {
				manualApproval: {
					hintKey: "auth.manualApproval.openApp",
					poll: async (_ctx, state) => {
						polls += 1;
						if (polls === 1) return null;
						return { credential: { cookie: `approved:${state.transactionId}` } };
					},
				},
			},
		});

		const challenge = await credentialsAuth.auth.flow?.continue(ctx, {
			email: "user@example.test",
			password: "secret",
		});
		expect(challenge).toMatchObject({
			kind: "pending",
			turnId: "credentials.manualApproval",
			hintKey: "auth.manualApproval.openApp",
			timing: { suggestedPollIntervalMs: 3000, maxWaitMs: 120000 },
			data: { challengeId: "manualApproval" },
		});

		expect(await credentialsAuth.auth.flow?.poll?.(ctx)).toMatchObject({
			kind: "pending",
			turnId: "credentials.manualApproval.pending",
			hintKey: "auth.manualApproval.openApp",
			timing: { suggestedPollIntervalMs: 3000, maxWaitMs: 120000 },
			data: { challengeId: "manualApproval" },
		});
		expect(await credentialsAuth.auth.flow?.poll?.(ctx)).toEqual({
			kind: "complete",
			turnId: "credentials.complete",
			data: { credential: { cookie: "approved:approve-123" } },
		});
	});
});
