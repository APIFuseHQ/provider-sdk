import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { lintProvider } from "../lint.js";

function withDescriptionKey<T extends z.ZodType>(schema: T, key: string): T {
	return schema.describe(key) as T;
}

function lintWithOperations(
	operationIds: readonly string[],
	authMode: "credentials" | "oauth2" | "oauth2_proxied" | "none" = "credentials",
) {
	return lintProvider({
		id: "demo-provider",
		allowedHosts: ["api.example.com"],
		reviewed: "first-party",
		auth: {
			mode: authMode,
			flow: { continue: async () => ({ kind: "complete", turnId: "1" }) },
		},
		credential: {
			keys: ["session_cookie"],
			justification: "Session cookie is required for private operations.",
		},
		operations: Object.fromEntries(
			operationIds.map((operationId) => [
				operationId,
				{
					descriptionKey: `operations.${operationId}.description`,
					input: withDescriptionKey(
						z.object({}),
						`operations.${operationId}.input.description`,
					),
					output: withDescriptionKey(
						z.object({
							ok: withDescriptionKey(
								z.boolean(),
								`operations.${operationId}.fields.ok.description`,
							),
						}),
						`operations.${operationId}.output.description`,
					),
					fixtures: { request: {}, response: { ok: true } },
				},
			]),
		),
	});
}

function authViolations(diagnostics: ReturnType<typeof lintProvider>): string[] {
	return diagnostics
		.filter((diagnostic) => diagnostic.rule === "auth-operation-unsupported")
		.map((diagnostic) => diagnostic.field ?? "");
}

describe("auth lifecycle operation lint", () => {
	it("rejects entry and exit operations regardless of the domain prefix", () => {
		const ids = [
			"logout",
			"shop-logout",
			"account-signout",
			"user-sign-out-everywhere",
			"login",
			"account-login",
			"partner-signin",
			"session-authenticate",
			"device-reauth",
			"auth-status",
			"refresh-auth",
		];
		expect(authViolations(lintWithOperations(ids)).sort()).toEqual(
			ids.map((id) => `operations.${id}`).sort(),
		);
	});

	it("recognises underscore-separated ids, which are valid operation ids", () => {
		const ids = ["shop_logout", "shop_sign_out", "account_sign_in", "user_sign_up", "shop-log-out", "member_log_in"];
		expect(authViolations(lintWithOperations(ids)).sort()).toEqual(
			ids.map((id) => `operations.${id}`).sort(),
		);
	});

	it("treats credential verbs as auth only when they are the whole operation id", () => {
		const bare = ["authorize", "revoke", "unlink", "disconnect"];
		expect(authViolations(lintWithOperations(bare)).sort()).toEqual(
			bare.map((id) => `operations.${id}`).sort(),
		);
	});

	it("does not flag domain operations that reuse a credential verb", () => {
		const ids = [
			"authorize-payment",
			"authorize-hold",
			"revoke-invitation",
			"revoke-coupon",
			"unlink-record",
			"disconnect-device",
			"register-webhook-callback",
			"activity-log-export",
			"audit-log-in-range",
			"change-log-out-of-band",
			"shop-return-exchange-info",
			"get-session-times",
			"list-connected-venues",
			"search-tokens",
			"password-reset-policy-info",
			"otp-delivery-options",
			"credential-requirements",
		];
		expect(authViolations(lintWithOperations(ids))).toEqual([]);
	});

	it("keeps the legacy anchored token-plumbing vocabulary on its original modes", () => {
		const ids = ["exchange-code", "callback", "refresh", "continue-session"];
		expect(authViolations(lintWithOperations(ids, "credentials")).sort()).toEqual(
			ids.map((id) => `operations.${id}`).sort(),
		);
		expect(authViolations(lintWithOperations(ids, "oauth2")).sort()).toEqual(
			ids.map((id) => `operations.${id}`).sort(),
		);
	});

	it("does not widen the legacy anchored pattern to proxied oauth providers", () => {
		// These domain ids matched the legacy pattern only because it is anchored
		// and broad. Proxied providers were never subject to it, so adding them to
		// the rule must not start flagging ordinary domain operations.
		const ids = ["exchange-rates", "refresh-catalog", "continue-watching"];
		expect(authViolations(lintWithOperations(ids, "oauth2_proxied"))).toEqual([]);
	});

	it("covers oauth2_proxied providers, which were previously exempt", () => {
		expect(authViolations(lintWithOperations(["shop-logout"], "oauth2_proxied"))).toEqual([
			"operations.shop-logout",
		]);
	});

	it("covers oauth2 providers", () => {
		expect(authViolations(lintWithOperations(["account-logout"], "oauth2"))).toEqual([
			"operations.account-logout",
		]);
	});

	it("stays silent for providers without an authenticated mode", () => {
		expect(authViolations(lintWithOperations(["shop-logout", "login"], "none"))).toEqual([]);
	});

	it("explains where the behavior belongs instead of only rejecting it", () => {
		const diagnostic = lintWithOperations(["shop-logout"]).find(
			(entry) => entry.rule === "auth-operation-unsupported",
		);
		expect(diagnostic?.level).toBe("error");
		expect(diagnostic?.message).toContain("auth.flow.abort");
		expect(diagnostic?.message).toContain("/auth/disconnect");
	});
});
