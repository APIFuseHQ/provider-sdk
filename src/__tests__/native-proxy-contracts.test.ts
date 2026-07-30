import { describe, expect, it } from "bun:test";
import type {
	NativeNetworkConnection,
	NativeProxyEgressInfo,
	NativeProxyExpiringEvent,
	NativeTlsConnectOptions,
} from "../index.js";

describe("native proxy contracts", () => {
	it("exposes proxy egress metadata on a connection", () => {
		const info: NativeProxyEgressInfo = {
			vendor: "smartproxy",
			sticky: true,
			sessionId: "abc1234567",
			expiresAt: "2026-07-31T00:00:00.000Z",
		};
		expect(info.sticky).toBe(true);
	});

	it("types the expiring event with a drain acknowledgement", () => {
		const event: NativeProxyExpiringEvent = {
			expiresAt: "2026-07-31T00:00:00.000Z",
			leadSeconds: 60,
			reason: "sticky_expiry",
		};
		expect(event.reason).toBe("sticky_expiry");
	});

	it("keeps connect options structurally compatible", () => {
		const options: NativeTlsConnectOptions = { host: "h", port: 443 };
		expect(options.port).toBe(443);
	});

	it("keeps connections structurally compatible", () => {
		const connection: NativeNetworkConnection = {
			read: async () => null,
			write: async () => undefined,
			close: async () => undefined,
		};
		expect(connection.proxy).toBeUndefined();
	});
});
