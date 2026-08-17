import { describe, expect, it } from "bun:test";
import type {
	NativeNetworkConnection,
	NativeProxyEgressInfo,
	NativeProxyExpiringEvent,
	NativeTlsConnectOptions,
} from "../index.js";
import {
	createEnvVendorCredentialResolver,
	type NativeGatewayProxySynthesizer,
	type VendorCredentialLookup,
} from "../runtime/native-network.js";

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

	it("exports injected credential and async synthesizer contracts from the runtime subpath", async () => {
		const credentials = createEnvVendorCredentialResolver({
			get: (name) => (name.endsWith("USERNAME") ? "injected-user" : undefined),
		});
		const lookup: VendorCredentialLookup = credentials("nodemaven");
		const synthesizer: NativeGatewayProxySynthesizer = async (input) => {
			expect(input.credentials).toBe(credentials);
			expect(input.protocol).toBe("http");
			return undefined;
		};

		expect(lookup).toEqual({
			kind: "absent",
			missing: ["APIFUSE__PROXY__NODEMAVEN_PASSWORD"],
		});
		await expect(
			synthesizer({
				vendor: "nodemaven",
				policy: { mode: "required", providers: ["nodemaven"] },
				now: 0,
				protocol: "http",
				credentials,
			}),
		).resolves.toBeUndefined();
	});
});
