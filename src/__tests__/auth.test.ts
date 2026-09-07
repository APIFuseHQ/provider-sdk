import { describe, expect, it } from "bun:test";

import { ProviderError } from "../errors.js";
import { DECLARATION_RULE_IDS } from "../declaration-validation.js";
import { credentialsAuthChallenge, defineCredentialsAuth } from "../provider.js";
import { createFlowContext as createRuntimeFlowContext } from "../runtime/auth-flow.js";
import type { FlowContext } from "../types.js";
import { createProviderContextDouble } from "./test-utils.js";

function createFlowContext(initialContext: Record<string, unknown> = {}): FlowContext {
	const base = createProviderContextDouble();
	return createRuntimeFlowContext({
		tenantId: "tenant-test",
		providerId: "provider-test",
		http: base.http,
		stealth: base.stealth,
		env: base.env,
		allowedKeys: ["__credentialsAuthChallenge"],
		initialContext,
	});
}

describe("defineCredentialsAuth", () => {
	it("rejects every half-declared challenge and accepts interactive, polling, and hybrid shapes", () => {
		let caught: unknown;
		try {
			defineCredentialsAuth({
				fields: { email: { type: "email" } },
				credentialKeys: ["cookie"] as const,
				login: async () => ({ credential: { cookie: "ok" } }),
				challenges: {
					missingVerify: { fields: { otp: { type: "otp" } } },
					missingFields: { verify: async () => ({ credential: { cookie: "ok" } }) },
					empty: {},
					fieldsPollNoVerify: {
						fields: { otp: { type: "otp" } },
						poll: async () => ({ credential: { cookie: "ok" } }),
					},
					verifyPollNoFields: {
						verify: async () => ({ credential: { cookie: "ok" } }),
						poll: async () => ({ credential: { cookie: "ok" } }),
					},
					emptyFieldsWithVerify: {
						fields: {},
						verify: async () => ({ credential: { cookie: "ok" } }),
					},
					emptyFieldsWithPoll: {
						fields: {},
						poll: async () => ({ credential: { cookie: "ok" } }),
					},
					// test-invalid: runtime validation must report every malformed challenge declaration.
				} as never,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ProviderError);
		const violations = (caught as ProviderError).details as {
			violations: Array<{ ruleId: string; path: string; fix: string }>;
		};
		expect(violations.violations).toHaveLength(7);
		for (const path of [
			"challenges.missingVerify",
			"challenges.missingFields",
			"challenges.empty",
			"challenges.fieldsPollNoVerify",
			"challenges.verifyPollNoFields",
			"challenges.emptyFieldsWithVerify",
			"challenges.emptyFieldsWithPoll",
		]) {
			expect(violations.violations).toContainEqual(
				expect.objectContaining({
					ruleId: DECLARATION_RULE_IDS.challengeShape,
					path,
				}),
			);
		}

		expect(() =>
			defineCredentialsAuth({
				fields: { email: { type: "email" } },
				credentialKeys: ["cookie"] as const,
				login: async () => ({ credential: { cookie: "ok" } }),
				challenges: {
					interactive: {
						fields: { otp: { type: "otp" } },
						verify: async () => ({ credential: { cookie: "ok" } }),
					},
					polling: { poll: async () => ({ credential: { cookie: "ok" } }) },
					hybrid: {
						fields: { otp: { type: "otp" } },
						verify: async () => ({ credential: { cookie: "ok" } }),
						poll: async () => ({ credential: { cookie: "ok" } }),
					},
				},
			}),
		).not.toThrow();
	});

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
			// test-invalid: runtime credential validation must reject a missing declared key.
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
			// test-invalid: runtime credential validation must reject a missing credential object.
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

	it("omits the refresh hook when the provider cannot re-mint a session", () => {
		// The hook's presence is the protocol signal for "this connection can be
		// re-established without the user", so it must not appear by default.
		const credentialsAuth = defineCredentialsAuth({
			fields: { email: { type: "email" } },
			credentialKeys: ["cookie"] as const,
			login: async () => ({ credential: { cookie: "session" } }),
		});

		expect(credentialsAuth.auth.flow?.refresh).toBeUndefined();
	});

	it("re-mints an expired session through refresh without user input", async () => {
		// Credential-auth upstreams routinely drop a session before the
		// advertised expiry; without this hook every operation stays broken
		// until a human repeats the interactive login.
		let loginCalls = 0;
		let refreshCalls = 0;
		const credentialsAuth = defineCredentialsAuth({
			fields: {
				email: { type: "email" },
				password: { type: "password" },
			},
			credentialKeys: ["cookie"] as const,
			login: async () => {
				loginCalls += 1;
				return { credential: { cookie: "session-1" } };
			},
			refresh: async (_ctx, input) => {
				refreshCalls += 1;
				// Absent fields are omitted rather than coerced to "", so a
				// refresh can tell "not supplied" from "supplied empty".
				expect(input).toEqual({});
				return { credential: { cookie: "session-2" } };
			},
		});

		expect(await credentialsAuth.auth.flow?.refresh?.(createFlowContext(), {})).toEqual({
			kind: "complete",
			turnId: "credentials.complete",
			data: { credential: { cookie: "session-2" } },
		});
		expect(refreshCalls).toBe(1);
		expect(loginCalls).toBe(0);
	});

	it("validates the refreshed credential like a login result", async () => {
		const credentialsAuth = defineCredentialsAuth({
			fields: { email: { type: "email" } },
			credentialKeys: ["cookie", "sessionId"] as const,
			login: async () => ({ credential: { cookie: "c", sessionId: "s" } }),
			// test-invalid: runtime refresh validation must reject a missing declared key.
			refresh: async () => ({ credential: { cookie: "c" } }) as never,
		});

		await expect(credentialsAuth.auth.flow?.refresh?.(createFlowContext(), {})).rejects.toThrow(
			/sessionId/,
		);
	});

	it("lets refresh raise a challenge when the upstream demands one", async () => {
		const ctx = createFlowContext();
		const credentialsAuth = defineCredentialsAuth({
			fields: { email: { type: "email" } },
			credentialKeys: ["cookie"] as const,
			login: async () => ({ credential: { cookie: "session" } }),
			refresh: async () => credentialsAuthChallenge("otp"),
			challenges: {
				otp: {
					fields: { otp: { type: "otp" } },
					verify: async (_ctx, input) => ({
						credential: { cookie: `refreshed:${input.otp}` },
					}),
				},
			},
		});

		expect(await credentialsAuth.auth.flow?.refresh?.(ctx, {})).toMatchObject({
			kind: "form",
			data: { challengeId: "otp" },
		});
		// The challenge raised by refresh is finishable on the same hook.
		expect(await credentialsAuth.auth.flow?.refresh?.(ctx, { otp: "123456" })).toEqual({
			kind: "complete",
			turnId: "credentials.complete",
			data: { credential: { cookie: "refreshed:123456" } },
		});
	});
});
