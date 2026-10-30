import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { extractProviderContract } from "../contract.js";
import { defineHealthAccount, defineProvider, type ProviderDeclaration } from "../define.js";
import { ValidationError } from "../errors.js";
import * as rootEntry from "../index.js";
import * as providerEntry from "../provider.js";
import type {
	EmailOtpReceipt,
	HealthAccountDeclaration,
	OtpMedium,
	OtpReceipt,
	OperationRiskClass,
} from "../types.js";

// The Weverse example from the healthAccounts design (decision #1146), placeholder values as written.
const weverseAccount = defineHealthAccount({
	persona: "default",
	destinations: { email: "email" },
	wait: { timeout: "PT3M", rationale: { measuredOtpValidity: "PT5M", source: "task 1.3 측정" } },
	otp: [
		{
			medium: "email",
			id: "account-otp",
			sender: { domains: ["weverse.io"] },
			subject: { includesAny: ["verification code", "인증번호"] },
			code: {
				kind: "regex",
				pattern: { engine: "re2", pattern: "\\b([0-9]{6})\\b", flags: "" },
				capture: 1,
			},
			maxAge: "PT10M",
		},
	],
});

const weverseReceipt: EmailOtpReceipt = weverseAccount.otp[0];

const meta = {
	displayName: "Account OTP Proof",
	descriptionKey: "providers.accountOtpProof.description",
	category: "test",
};

const READ_RISK_CLASS: OperationRiskClass = "read";

const baseDeclaration = {
	allowedHosts: ["example.com"],
	reviewed: "community",
	id: "health-accounts-proof",
	version: "1.0.0",
	runtime: "standard",
	meta,
} as const satisfies ProviderDeclaration;

function declarationWithAccounts(healthAccounts: unknown): ProviderDeclaration {
	const declaration: ProviderDeclaration = { ...baseDeclaration };
	return Object.assign(declaration, { healthAccounts });
}

function accountWith(overrides: Record<string, unknown>): Record<string, unknown> {
	return { ...weverseAccount, ...overrides };
}

function receiptWith(overrides: Record<string, unknown>): Record<string, unknown> {
	return { ...weverseReceipt, ...overrides };
}

function expectRejected(healthAccounts: unknown, message: string): void {
	const declaration = declarationWithAccounts(healthAccounts);
	expect(() => defineProvider(declaration)).toThrow(ValidationError);
	expect(() => defineProvider(declaration)).toThrow(message);
}

function buildWeverseProvider(healthAccounts?: readonly HealthAccountDeclaration[]) {
	return defineProvider({
		allowedHosts: ["example.com"],
		reviewed: "community",
		id: "weverse-health-accounts",
		version: "1.0.0",
		runtime: "standard",
		meta,
		...(healthAccounts === undefined ? {} : { healthAccounts }),
	})({
		operations: {
			profile: {
				riskClass: READ_RISK_CLASS,
				descriptionKey: "operations.profile.description",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				healthCheckUnsupported: { reason: "health accounts assembly fixture" },
				async handler() {
					return { ok: true };
				},
			},
		},
	});
}

describe("healthAccounts declaration", () => {
	it("carries the design's Weverse declaration from defineProvider through finalizeProvider", () => {
		const provider = buildWeverseProvider([weverseAccount]);

		expect(provider.healthAccounts).toEqual([
			{
				persona: "default",
				destinations: { email: "email" },
				wait: {
					timeout: "PT3M",
					rationale: { measuredOtpValidity: "PT5M", source: "task 1.3 측정" },
				},
				otp: [
					{
						medium: "email",
						id: "account-otp",
						sender: { domains: ["weverse.io"] },
						subject: { includesAny: ["verification code", "인증번호"] },
						code: {
							kind: "regex",
							pattern: { engine: "re2", pattern: "\\b([0-9]{6})\\b", flags: "" },
							capture: 1,
						},
						maxAge: "PT10M",
					},
				],
			},
		]);
		expect(provider.healthAccounts?.[0]).toBe(weverseAccount);
	});

	it("leaves providers without healthAccounts unchanged", () => {
		const provider = buildWeverseProvider();

		expect(provider.healthAccounts).toBeUndefined();
	});

	it("keeps healthAccounts out of the provider contract snapshot", () => {
		const withAccounts = buildWeverseProvider([weverseAccount]);
		const withoutAccounts = buildWeverseProvider();

		expect(extractProviderContract(withAccounts)).toEqual(extractProviderContract(withoutAccounts));
		expect(JSON.stringify(extractProviderContract(withAccounts))).not.toContain('"healthAccounts"');
	});

	it("exports defineHealthAccount from the root and provider entry points", () => {
		expect(rootEntry.defineHealthAccount).toBe(defineHealthAccount);
		expect(providerEntry.defineHealthAccount).toBe(defineHealthAccount);
	});

	it("preserves the declared types through defineHealthAccount", () => {
		const account: HealthAccountDeclaration = defineHealthAccount(weverseAccount);
		const first: OtpReceipt = account.otp[0];
		const medium: OtpMedium = first.medium;
		const domains: readonly [string, ...string[]] = first.sender.domains;
		const emailDestination: string | undefined = account.destinations.email;

		expect(account).toBe(weverseAccount);
		expect([medium, domains[0], emailDestination]).toEqual(["email", "weverse.io", "email"]);

		const rejectedAtTypeLevel = () => [
			defineHealthAccount({
				...weverseAccount,
				// @ts-expect-error test-invalid: "sms" is not an OtpMedium yet.
				otp: [{ ...weverseReceipt, medium: "sms" }],
			}),
			defineHealthAccount({
				...weverseAccount,
				// @ts-expect-error test-invalid: otp is a non-empty tuple.
				otp: [],
			}),
			defineHealthAccount({
				...weverseAccount,
				// @ts-expect-error test-invalid: sender.domains is a non-empty tuple.
				otp: [{ ...weverseReceipt, sender: { domains: [] } }],
			}),
			defineHealthAccount({
				...weverseAccount,
				// @ts-expect-error test-invalid: destinations keys are OtpMedium members.
				destinations: { sms: "phone" },
			}),
		];
		void rejectedAtTypeLevel;
	});

	it("accepts an otp maxAge of exactly PT15M", () => {
		const declaration = declarationWithAccounts([
			accountWith({ otp: [receiptWith({ maxAge: "PT15M" })] }),
		]);

		expect(() => defineProvider(declaration)).not.toThrow();
	});

	it("rejects an otp medium outside OtpMedium", () => {
		expectRejected(
			[accountWith({ otp: [receiptWith({ medium: "sms" })] })],
			'Provider "health-accounts-proof" healthAccounts[0].otp[0].medium must be one of: email.',
		);
	});

	it("rejects an otp maxAge above PT15M", () => {
		expectRejected(
			[accountWith({ otp: [receiptWith({ maxAge: "PT16M" })] })],
			'Provider "health-accounts-proof" healthAccounts[0].otp[0].maxAge must be at most PT15M.',
		);
		expectRejected(
			[accountWith({ otp: [receiptWith({ maxAge: "P1D" })] })],
			'Provider "health-accounts-proof" healthAccounts[0].otp[0].maxAge must be at most PT15M.',
		);
	});

	it("rejects an empty otp list", () => {
		expectRejected(
			[accountWith({ otp: [] })],
			'Provider "health-accounts-proof" healthAccounts[0].otp must be a non-empty array.',
		);
	});

	it("rejects empty sender domains", () => {
		expectRejected(
			[accountWith({ otp: [receiptWith({ sender: { domains: [] } })] })],
			'Provider "health-accounts-proof" healthAccounts[0].otp[0].sender.domains must be a non-empty array of non-empty strings.',
		);
	});

	it("rejects destinations keyed by a medium outside OtpMedium", () => {
		expectRejected(
			[accountWith({ destinations: { email: "email", sms: "phone" } })],
			'Provider "health-accounts-proof" healthAccounts[0].destinations has unknown OTP medium "sms". Expected one of: email.',
		);
	});

	it("rejects missing required fields and non-ISO durations", () => {
		const { persona: _persona, ...withoutPersona } = weverseAccount;
		expectRejected(
			[withoutPersona],
			'Provider "health-accounts-proof" healthAccounts[0].persona must be a non-empty string.',
		);
		expectRejected(
			[accountWith({ wait: { timeout: "3m", rationale: weverseAccount.wait.rationale } })],
			'Provider "health-accounts-proof" healthAccounts[0].wait.timeout must be an ISO 8601 duration',
		);
		expectRejected(
			[
				accountWith({
					wait: { timeout: "PT3M", rationale: { measuredOtpValidity: "PT5M", source: "" } },
				}),
			],
			'Provider "health-accounts-proof" healthAccounts[0].wait.rationale.source must be a non-empty string.',
		);
	});

	it("rejects ISO 8601 durations whose time part is empty", () => {
		for (const value of ["P0DT", "P1DT", "PT"]) {
			expectRejected(
				[accountWith({ otp: [receiptWith({ maxAge: value })] })],
				'Provider "health-accounts-proof" healthAccounts[0].otp[0].maxAge must be an ISO 8601 duration for example PT8H or PT2M30S.',
			);
			expectRejected(
				[accountWith({ wait: { timeout: value, rationale: weverseAccount.wait.rationale } })],
				'Provider "health-accounts-proof" healthAccounts[0].wait.timeout must be an ISO 8601 duration for example PT8H or PT2M30S.',
			);
			expectRejected(
				[
					accountWith({
						wait: {
							timeout: "PT3M",
							rationale: { measuredOtpValidity: value, source: "measured" },
						},
					}),
				],
				'Provider "health-accounts-proof" healthAccounts[0].wait.rationale.measuredOtpValidity must be an ISO 8601 duration for example PT8H or PT2M30S.',
			);
		}
	});

	it("rejects zero-length ISO 8601 durations and keeps positive ones", () => {
		for (const value of ["PT0S", "P0D", "PT0.0S", "P0DT0H0M0S"]) {
			expectRejected(
				[accountWith({ otp: [receiptWith({ maxAge: value })] })],
				'Provider "health-accounts-proof" healthAccounts[0].otp[0].maxAge must be a positive duration.',
			);
			expectRejected(
				[accountWith({ wait: { timeout: value, rationale: weverseAccount.wait.rationale } })],
				'Provider "health-accounts-proof" healthAccounts[0].wait.timeout must be a positive duration.',
			);
			expectRejected(
				[
					accountWith({
						wait: {
							timeout: "PT3M",
							rationale: { measuredOtpValidity: value, source: "measured" },
						},
					}),
				],
				'Provider "health-accounts-proof" healthAccounts[0].wait.rationale.measuredOtpValidity must be a positive duration.',
			);
		}

		for (const value of ["PT0.5S", "PT0.0001S", "PT1S", "PT15M"]) {
			const account = defineHealthAccount({
				...weverseAccount,
				wait: { timeout: value, rationale: { measuredOtpValidity: value, source: "measured" } },
				otp: [{ ...weverseReceipt, maxAge: value }],
			});
			const provider = buildWeverseProvider([account]);

			expect(provider.healthAccounts?.[0]?.wait).toEqual({
				timeout: value,
				rationale: { measuredOtpValidity: value, source: "measured" },
			});
			expect(provider.healthAccounts?.[0]?.otp[0].maxAge).toBe(value);
		}
	});

	it("accepts complete ISO 8601 durations through defineProvider and finalizeProvider", () => {
		const account = defineHealthAccount({
			...weverseAccount,
			wait: { timeout: "P1DT2H", rationale: { measuredOtpValidity: "PT0.5S", source: "measured" } },
			otp: [{ ...weverseReceipt, maxAge: "PT15M" }],
		});
		const provider = buildWeverseProvider([account]);

		expect(provider.healthAccounts?.[0]?.wait).toEqual({
			timeout: "P1DT2H",
			rationale: { measuredOtpValidity: "PT0.5S", source: "measured" },
		});
		expect(provider.healthAccounts?.[0]?.otp[0].maxAge).toBe("PT15M");
	});

	it("rejects a code rule that is not an RE2 SafeRegex", () => {
		expectRejected(
			[
				accountWith({
					otp: [
						receiptWith({
							code: {
								kind: "regex",
								pattern: { engine: "re2", pattern: "(\\d)\\1", flags: "" },
								capture: 1,
							},
						}),
					],
				}),
			],
			'Provider "health-accounts-proof" has invalid healthAccounts[0].otp[0].code.pattern.pattern: backreferences are not supported by RE2.',
		);
		expectRejected(
			[accountWith({ otp: [receiptWith({ code: { ...weverseReceipt.code, kind: "glob" } })] })],
			'Provider "health-accounts-proof" healthAccounts[0].otp[0].code.kind must be "regex".',
		);
	});

	it("rejects unknown fields and a non-array healthAccounts", () => {
		expectRejected(
			[accountWith({ matcherId: "account-otp" })],
			'Unknown field "matcherId" on healthAccounts[0].',
		);
		expectRejected(
			{ default: weverseAccount },
			'Provider "health-accounts-proof" healthAccounts must be an array.',
		);
	});
});
