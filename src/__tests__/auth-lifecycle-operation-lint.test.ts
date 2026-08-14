import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { lintProvider } from "../lint";

function withDescriptionKey<T extends z.ZodType>(schema: T, key: string): T {
	return schema.describe(key) as T;
}

function operationStub(nameKey: string) {
	return {
		descriptionKey: `operations.${nameKey}.description`,
		input: withDescriptionKey(z.object({}), `operations.${nameKey}.input.description`),
		output: withDescriptionKey(
			z.object({
				ok: withDescriptionKey(z.boolean(), `operations.${nameKey}.fields.ok.description`),
			}),
			`operations.${nameKey}.output.description`,
		),
		fixtures: { request: {}, response: { ok: true } },
	};
}

function lintWithOperations(
	operationIds: readonly string[],
	authMode: "credentials" | "oauth2" | "oauth2_proxied" | "none" = "credentials",
) {
	const operations: Record<string, ReturnType<typeof operationStub>> = {};
	for (const id of operationIds) {
		operations[id] = operationStub(id.replace(/[-_]/g, ""));
	}
	return lintProvider({
		id: "demo-provider",
		allowedHosts: ["api.example.com"],
		reviewed: "first-party",
		...(authMode === "none"
			? {}
			: {
					auth: {
						mode: authMode,
						flow: { continue: async () => ({ kind: "complete", turnId: "1" }) },
					},
					credential: {
						keys: ["session_cookie"],
						storesReusableSecret: true,
						justification: "Session cookie is required for private operations.",
					},
				}),
		operations,
	} as never);
}

function authViolations(diagnostics: ReturnType<typeof lintProvider>): string[] {
	return diagnostics
		.filter((d) => d.rule === "auth-operation-unsupported")
		.map((d) => d.field ?? "");
}

describe("auth lifecycle operation lint", () => {
	it("rejects sign-out operations even behind a domain prefix", () => {
		// The regression that motivated this rule: `shop-logout` shipped on a
		// live credentials provider because the old pattern was anchored at the
		// start of the operation id.
		expect(authViolations(lintWithOperations(["shop-logout"]))).toEqual([
			"operations.shop-logout",
		]);
	});

	it("rejects the full entry and exit vocabulary regardless of position", () => {
		const ids = [
			"logout",
			"shop-logout",
			"account-signout",
			"user-sign-out-everywhere",
			"login",
			"account-login",
			"partner-signin",
			"session-authenticate",
			"oauth-authorize",
			"device-reauth",
			"connection-disconnect",
			"account-unlink",
			"token-revoke",
			"oauth-callback",
			"auth-status",
			"refresh-auth",
		];
		expect(authViolations(lintWithOperations(ids)).sort()).toEqual(
			ids.map((id) => `operations.${id}`).sort(),
		);
	});

	it("keeps the legacy anchored token-plumbing vocabulary", () => {
		const ids = ["exchange-code", "refresh", "continue-session", "auth-login-with-password"];
		expect(authViolations(lintWithOperations(ids)).sort()).toEqual(
			ids.map((id) => `operations.${id}`).sort(),
		);
	});

	it("does not flag domain operations that merely contain an auth-adjacent word", () => {
		// Measured against the live fleet (267 operations): these are real
		// operation ids whose vocabulary overlaps auth wording but which are
		// ordinary domain reads. Flagging them would be a false positive.
		const ids = [
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
		expect(authViolations(lintWithOperations(["shop-logout"], "none"))).toEqual([]);
	});

	it("explains where the behavior belongs instead of only rejecting it", () => {
		const [diagnostic] = lintWithOperations(["shop-logout"]).filter(
			(d) => d.rule === "auth-operation-unsupported",
		);
		expect(diagnostic?.level).toBe("error");
		expect(diagnostic?.message).toContain("auth.flow.abort");
		expect(diagnostic?.message).toContain("/auth/disconnect");
	});
});
