import { describe, expect, it } from "bun:test";

import { buildSessionKey, parseSessionKey } from "../../dist/stateful/index.js";

describe("stateful session keys", () => {
	it("round-trips required and open dimensions with reserved characters", () => {
		const parts = {
			providerId: "imap/provider",
			serviceAccountId: "account:primary",
			connectionId: "connection/one:two",
			dimensions: { persona: "work/personal", mailbox: "INBOX:Archive/2026" },
		};
		const key = buildSessionKey(parts);

		expect(parseSessionKey(key)).toEqual(parts);
		expect(key).toContain("imap%2Fprovider");
		expect(key).toContain("account%3Aprimary");
	});

	it("sorts extra dimensions deterministically", () => {
		const base = {
			providerId: "provider",
			serviceAccountId: "account",
			connectionId: "connection",
		};
		expect(buildSessionKey({ ...base, dimensions: { persona: "p", mailbox: "m" } })).toBe(
			buildSessionKey({ ...base, dimensions: { mailbox: "m", persona: "p" } }),
		);
	});

	it("names missing required dimensions in actionable errors", () => {
		expect(() =>
			buildSessionKey({
				providerId: "",
				serviceAccountId: "account",
				connectionId: "connection",
				dimensions: {},
			}),
		).toThrow('required dimension "providerId"');
		expect(() =>
			parseSessionKey("stateful:v1/providerId=provider/serviceAccountId=account/mailbox=INBOX"),
		).toThrow('missing required dimension "connectionId"');
	});
});
