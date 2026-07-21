import { describe, expect, it } from "bun:test";
import {
	assertFreshProviderChoiceIssuedAt,
	createProviderChoiceToken,
	ProviderChoiceTokenError,
	parseProviderChoiceToken,
} from "../choice-token.js";
import { ProviderError } from "../errors.js";
import {
	checkResultCode,
	isEmptyResult,
	nullIfPlaceholder,
	unwrapGovEnvelope,
} from "../recipes/gov-api.js";
import { createTestProviderChoiceContext } from "../runtime/choice.js";
import type { CredentialContext } from "../types.js";
import { toISODate } from "../utils/date.js";
import { pivotByField, unwrapEnvelope } from "../utils/parse.js";
import { stripHtml, truncate } from "../utils/text.js";
import { toBoolean, toFloat, toInt, toNumber } from "../utils/transform.js";

describe("transform utils", () => {
	it("parses numbers and booleans", () => {
		expect(toNumber("1.5")).toBe(1.5);
		expect(toFloat("1.25", 1)).toBe(1.3);
		expect(toInt("38.7")).toBe(39);
		expect(toBoolean("true")).toBe(true);
		expect(toBoolean(0)).toBe(false);
	});
});

describe("date utils", () => {
	it("formats dates with timezone", () => {
		expect(toISODate("20230101", "Asia/Seoul")).toBe("2023-01-01T00:00:00+09:00");
	});
});

describe("text utils", () => {
	it("strips html and truncates text", () => {
		expect(stripHtml("<b>hello</b>")).toBe("hello");
		expect(truncate("hello world", 5)).toBe("hello...");
	});
});

describe("parse utils", () => {
	it("unwraps envelopes and pivots arrays", () => {
		expect(unwrapEnvelope({ a: { b: 1 } }, "a.b")).toBe(1);
		expect(pivotByField([{ k: "A", v: 1 }], "k", "v")).toEqual({ A: 1 });
	});
});

describe("choice token utils", () => {
	it("round-trips signed opaque provider choices", () => {
		const token = createProviderChoiceToken({
			prefix: "provider_choice_v1",
			payload: { choice_id: "A", issued_at_ms: 1234 },
			secret: "test-secret",
		});

		expect(token).toStartWith("provider_choice_v1.");
		expect(
			parseProviderChoiceToken({
				token,
				prefix: "provider_choice_v1",
				secret: "test-secret",
			}),
		).toEqual({ choice_id: "A", issued_at_ms: 1234 });
	});

	it("rejects tampered and stale choices", () => {
		const token = createProviderChoiceToken({
			prefix: "provider_choice_v1",
			payload: { choice_id: "A", issued_at_ms: 1000 },
			secret: "test-secret",
		});
		const tampered = token.replace(/.$/, (char) => (char === "a" ? "b" : "a"));

		expect(() =>
			parseProviderChoiceToken({
				token: tampered,
				prefix: "provider_choice_v1",
				secret: "test-secret",
			}),
		).toThrow(ProviderChoiceTokenError);
		expect(() => assertFreshProviderChoiceIssuedAt(1000, { ttlMs: 10, nowMs: 2000 })).toThrow(
			ProviderChoiceTokenError,
		);
		expect(() => assertFreshProviderChoiceIssuedAt(40_000, { ttlMs: 10, nowMs: 1_000 })).toThrow(
			ProviderChoiceTokenError,
		);
	});

	it("keeps provider-specific choice namespaces isolated for future facades", () => {
		const yogiyoChoice = createProviderChoiceToken({
			prefix: "yogiyo_menu_choice_v1",
			payload: { restaurant_id: "r1", menu_id: 101, issued_at_ms: 1000 },
			secret: "shared-secret",
		});
		const moduParkingChoice = createProviderChoiceToken({
			prefix: "modu_parking_pg_choice_v1",
			payload: { lot_id: "p1", pg_type: "nicepay", issued_at_ms: 1000 },
			secret: "shared-secret",
		});

		expect(
			parseProviderChoiceToken({
				token: yogiyoChoice,
				prefix: "yogiyo_menu_choice_v1",
				secret: "shared-secret",
			}),
		).toMatchObject({ restaurant_id: "r1", menu_id: 101 });
		expect(
			parseProviderChoiceToken({
				token: moduParkingChoice,
				prefix: "modu_parking_pg_choice_v1",
				secret: "shared-secret",
			}),
		).toMatchObject({ lot_id: "p1", pg_type: "nicepay" });
		const forgedPrefix = yogiyoChoice.replace(
			/^yogiyo_menu_choice_v1\./,
			"modu_parking_pg_choice_v1.",
		);
		expect(() =>
			parseProviderChoiceToken({
				token: yogiyoChoice,
				prefix: "modu_parking_pg_choice_v1",
				secret: "shared-secret",
			}),
		).toThrow(ProviderChoiceTokenError);
		expect(() =>
			parseProviderChoiceToken({
				token: forgedPrefix,
				prefix: "modu_parking_pg_choice_v1",
				secret: "shared-secret",
			}),
		).toThrow(ProviderChoiceTokenError);
	});
});

describe("managed choice context", () => {
	function createManagedChoiceFixture(options?: {
		readonly providerId?: string;
		readonly connectionId?: string;
		readonly credentialValues?: Record<string, string>;
	}) {
		const credentialValues = options?.credentialValues ?? { userId: "u1" };
		const credential = {
			mode: "credentials",
			get: (key: string) => credentialValues[key],
			getAll: () => credentialValues,
			getAccessToken: () => undefined,
			getScopes: () => [],
		} satisfies CredentialContext;
		const request = {
			connectionId: options?.connectionId ?? "af_con_test",
			headers: {},
		};
		return createTestProviderChoiceContext({
			providerId: options?.providerId ?? "provider-a",
			request,
			credential,
		});
	}

	it("round-trips managed provider choices", () => {
		const choice = createManagedChoiceFixture();
		const token = choice.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: 60_000,
			nowMs: 1_000,
			bind: { connection: true, credentialKeys: ["userId"] },
		});

		expect(token).toStartWith("provider_choice_v2.v1.");
		expect(
			choice.parse({
				token,
				prefix: "provider_choice_v2",
				purpose: "reservation",
				ttlMs: 60_000,
				nowMs: 2_000,
				bind: { connection: true, credentialKeys: ["userId"] },
			}),
		).toEqual({ choice_id: "A" });
	});

	it("rejects tampered and stale managed choices", () => {
		const choice = createManagedChoiceFixture();
		const token = choice.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: 10,
			nowMs: 1_000,
		});
		const tampered = token.replace(/.$/, (char) => (char === "a" ? "b" : "a"));

		expect(() =>
			choice.parse({
				token: tampered,
				prefix: "provider_choice_v2",
				purpose: "reservation",
				ttlMs: 10,
				nowMs: 1_001,
			}),
		).toThrow(ProviderChoiceTokenError);
		expect(() =>
			choice.parse({
				token,
				prefix: "provider_choice_v2",
				purpose: "reservation",
				ttlMs: 10,
				nowMs: 2_000,
			}),
		).toThrow(ProviderChoiceTokenError);
	});

	it("clamps parse ttlMs to the envelope issuer ttl_ms", () => {
		// Issue with a short TTL (10 ms); the token is stale by nowMs=2_000.
		const choice = createManagedChoiceFixture();
		const token = choice.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: 10,
			nowMs: 1_000,
		});
		// Passing a larger ttlMs to parse must not extend validity past the
		// issuer's envelope ttl_ms.
		expect(() =>
			choice.parse({
				token,
				prefix: "provider_choice_v2",
				purpose: "reservation",
				ttlMs: 100_000,
				nowMs: 2_000,
			}),
		).toThrow(ProviderChoiceTokenError);
		// A parse ttlMs smaller than the envelope value still restricts validity.
		const freshToken = choice.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload: { choice_id: "B" },
			ttlMs: 60_000,
			nowMs: 1_000,
		});
		expect(() =>
			choice.parse({
				token: freshToken,
				prefix: "provider_choice_v2",
				purpose: "reservation",
				ttlMs: 500,
				nowMs: 2_000,
			}),
		).toThrow(ProviderChoiceTokenError);
	});

	it("rejects managed choices when required credential bindings are missing", () => {
		const issuer = createManagedChoiceFixture({
			credentialValues: { userId: "u1" },
		});
		expect(() =>
			issuer.issue({
				prefix: "provider_choice_v2",
				purpose: "reservation",
				payload: { choice_id: "A" },
				ttlMs: 60_000,
				nowMs: 1_000,
				bind: { credentialKeys: ["userId", "phone"] },
			}),
		).toThrow(ProviderError);

		const token = issuer.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: 60_000,
			nowMs: 1_000,
			bind: { credentialKeys: ["userId"] },
		});
		const parser = createManagedChoiceFixture({ credentialValues: {} });

		expect(() =>
			parser.parse({
				token,
				prefix: "provider_choice_v2",
				purpose: "reservation",
				ttlMs: 60_000,
				nowMs: 2_000,
				bind: { credentialKeys: ["userId"] },
			}),
		).toThrow(ProviderError);
	});

	it("rejects managed choices across connection and credential bindings", () => {
		const issuer = createManagedChoiceFixture({
			connectionId: "af_con_a",
			credentialValues: { userId: "u1", phone: "0101" },
		});
		const token = issuer.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: 60_000,
			nowMs: 1_000,
			bind: { connection: true, credentialKeys: ["userId", "phone"] },
		});

		const otherConnection = createManagedChoiceFixture({
			connectionId: "af_con_b",
			credentialValues: { userId: "u1", phone: "0101" },
		});
		const otherCredential = createManagedChoiceFixture({
			connectionId: "af_con_a",
			credentialValues: { userId: "u1", phone: "0102" },
		});
		for (const choice of [otherConnection, otherCredential]) {
			expect(() =>
				choice.parse({
					token,
					prefix: "provider_choice_v2",
					purpose: "reservation",
					ttlMs: 60_000,
					nowMs: 2_000,
					bind: { connection: true, credentialKeys: ["userId", "phone"] },
				}),
			).toThrow(ProviderChoiceTokenError);
		}
	});

	it("isolates managed choices by provider and purpose", () => {
		const choice = createManagedChoiceFixture({ providerId: "provider-a" });
		const token = choice.issue({
			prefix: "provider_choice_v2",
			purpose: "reservation",
			payload: { choice_id: "A" },
			ttlMs: 60_000,
			nowMs: 1_000,
		});

		expect(() =>
			createManagedChoiceFixture({ providerId: "provider-b" }).parse({
				token,
				prefix: "provider_choice_v2",
				purpose: "reservation",
				ttlMs: 60_000,
				nowMs: 2_000,
			}),
		).toThrow(ProviderChoiceTokenError);
		expect(() =>
			choice.parse({
				token,
				prefix: "provider_choice_v2",
				purpose: "waiting",
				ttlMs: 60_000,
				nowMs: 2_000,
			}),
		).toThrow(ProviderChoiceTokenError);
	});
});

describe("gov-api recipe", () => {
	it("checks result code and placeholder values", () => {
		expect(checkResultCode({ resultCode: "00" })).toBe(true);
		expect(nullIfPlaceholder("-", ["-"])).toBeNull();
	});

	it("unwraps gov envelope and detects empty results", () => {
		expect(
			unwrapGovEnvelope({
				response: { body: { items: { item: [{ id: 1 }] } } },
			}),
		).toEqual([{ id: 1 }]);
		expect(isEmptyResult({ response: { header: { resultCode: "03" } } })).toBe(true);
	});
});
