import { describe, expect, it } from "bun:test";

import { defineProvider, type ProviderDeclaration } from "../define.js";
import { ProviderError, ValidationError } from "../errors.js";

const validDeclaration = {
	id: "phase-proof",
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Phase Proof",
		descriptionKey: "providers.phaseProof.description",
		category: "test",
	},
} as const satisfies ProviderDeclaration;

function invalidDeclaration(overrides: Record<string, unknown>): ProviderDeclaration {
	const declaration: ProviderDeclaration = { ...validDeclaration };
	return Object.assign(declaration, overrides);
}

describe("defineProvider validation phases", () => {
	it("rejects an invalid declaration before returning a builder", () => {
		const declaration = invalidDeclaration({
			auth: { mode: "oauth2_proxied", flow: {} },
		});

		expect(() => defineProvider(declaration)).toThrow(ValidationError);
		expect(() => defineProvider(declaration)).toThrow(
			'Provider "phase-proof" with auth.mode "oauth2_proxied" must declare auth.proxied.',
		);
	});

	it("preserves reserved proxied OAuth parameter validation", () => {
		const declaration = invalidDeclaration({
			auth: {
				mode: "oauth2_proxied",
				flow: {},
				proxied: {
					authorizeUrl: "https://example.com/oauth/authorize",
					tokenUrl: "https://example.com/oauth/token",
					customScheme: "phase-proof://oauth",
					rewriteProfile: "phase-proof",
					clientIdEnvKey: "APIFUSE__PHASE_PROOF_CLIENT_ID",
					authorizeParams: { state: "not-allowed" },
				},
			},
		});

		expect(() => defineProvider(declaration)).toThrow(
			'Provider "phase-proof" auth.proxied.authorizeParams cannot override reserved parameter "state".',
		);
	});

	it("returns a builder for a valid declaration and validates its implementation", () => {
		const buildProvider = defineProvider(validDeclaration);

		expect(buildProvider).toBeFunction();
		expect(() => buildProvider({ operations: {} })).toThrow(ProviderError);
		expect(() => buildProvider({ operations: {} })).toThrow(
			'Provider "phase-proof" must define at least one operation',
		);
	});
});
