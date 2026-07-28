import { describe, expect, it } from "bun:test";

import { buildProviderEvent, redactProviderEventPayload } from "../../dist/stateful/index.js";

describe("provider event protocol-neutral envelope", () => {
	it("preserves legitimate device and UUID data while redacting credentials", () => {
		expect(
			redactProviderEventPayload({
				deviceScaleFactor: 2,
				mailbox_uuid: "mailbox-uuid",
				authorization: "Bearer secret",
			}),
		).toEqual({
			deviceScaleFactor: 2,
			mailbox_uuid: "mailbox-uuid",
			authorization: "[REDACTED]",
		});
	});

	it("supports provider-specific extra redaction patterns", () => {
		expect(redactProviderEventPayload({ imapPassphrase: "secret" }, [/passphrase/i])).toEqual({
			imapPassphrase: "[REDACTED]",
		});
	});

	it("does not require messaging subjects or upstream timestamps", () => {
		const event = buildProviderEvent({
			eventId: "event-1",
			providerId: "cdp",
			eventType: "context.storage.changed",
			observedAt: "2026-07-28T00:00:00.000Z",
			payload: { origin: "https://example.com" },
			session: { sessionKey: "context-1", generation: 1 },
		});

		expect(event.subject).toBeUndefined();
		expect(event.occurredAt).toBeUndefined();
		expect(event.connectionId).toBeUndefined();
		expect(event.serviceAccountId).toBeUndefined();
	});
});
