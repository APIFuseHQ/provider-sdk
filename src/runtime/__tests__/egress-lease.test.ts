import { describe, expect, it } from "bun:test";

import {
	APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY,
	APIFUSE__ENGINE__CEREMONY_LEASE_NODEMAVEN_TTL_MS,
	APIFUSE__ENGINE__CEREMONY_LEASE_SMARTPROXY_TTL_MS,
	createCeremonyEgressLeaseRuntime,
} from "../egress-lease.js";

const KEY = "fixture-engine-owned-ceremony-hmac-key";

function runtime(
	options: { handle?: string; now?: () => number; environment?: Record<string, string> } = {},
) {
	return createCeremonyEgressLeaseRuntime({
		providerId: "lease-provider",
		flowId: "flow-1",
		affinityKey: "connection-1",
		...(options.handle ? { handle: options.handle } : {}),
		...(options.now ? { now: options.now } : {}),
		environment: {
			[APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY]: KEY,
			...(options.environment ?? {}),
		},
	});
}

describe("engine ceremony egress lease", () => {
	it("mints and verifies an opaque exact NodeMaven binding", () => {
		const first = runtime({ now: () => 1_000 });
		first.bind({
			vendor: "nodemaven",
			proxyUrl: "http://account-sid-fixed:password@gate.nodemaven.com:8080",
			poolIndex: 7,
			affinityKey: "connection-1",
			refreshEpoch: 3,
			lifetimeMinutes: 30,
		});
		const handle = first.handle();
		expect(handle).toBeString();
		expect(handle).not.toContain("gate.nodemaven.com");

		const next = runtime({ handle, now: () => 1_001 });
		expect(next.binding).toEqual({
			vendor: "nodemaven",
			proxyUrl: "http://account-sid-fixed:password@gate.nodemaven.com:8080",
			poolIndex: 7,
			affinityKey: "connection-1",
			refreshEpoch: 3,
			lifetimeMinutes: 30,
		});
	});

	it("rejects a tampered handle before returning any binding", () => {
		const first = runtime();
		first.bind({
			vendor: "smartproxy",
			proxyUrl: "http://user:password@198.51.100.7:9000",
			poolIndex: 2,
			affinityKey: "connection-1",
			refreshEpoch: 0,
		});
		const handle = first.handle();
		if (!handle) throw new Error("fixture handle was not minted");
		const separator = handle.indexOf(".");
		const signatureStart = separator + 1;
		const signatureFirst = handle[signatureStart];
		const tampered = `${handle.slice(0, signatureStart)}${signatureFirst === "A" ? "B" : "A"}${handle.slice(signatureStart + 1)}`;

		expect(() => runtime({ handle: tampered })).toThrow(
			expect.objectContaining({ code: "EGRESS_LEASE_INVALID" }),
		);
	});

	it("rejects an expired handle without silently minting another binding", () => {
		let now = 10_000;
		const first = runtime({
			now: () => now,
			environment: { [APIFUSE__ENGINE__CEREMONY_LEASE_SMARTPROXY_TTL_MS]: "25" },
		});
		first.bind({
			vendor: "smartproxy",
			proxyUrl: "http://user:password@198.51.100.8:9000",
			poolIndex: 1,
			affinityKey: "connection-1",
			refreshEpoch: 0,
		});
		now += 25;

		expect(() =>
			runtime({
				handle: first.handle(),
				now: () => now,
				environment: { [APIFUSE__ENGINE__CEREMONY_LEASE_SMARTPROXY_TTL_MS]: "25" },
			}),
		).toThrow(expect.objectContaining({ code: "EGRESS_LEASE_EXPIRED" }));
	});

	it("uses engine-only per-vendor expiry overrides", () => {
		let now = 5_000;
		const first = runtime({
			now: () => now,
			environment: { [APIFUSE__ENGINE__CEREMONY_LEASE_NODEMAVEN_TTL_MS]: "50" },
		});
		first.bind({
			vendor: "nodemaven",
			proxyUrl: "http://account-sid-fixed:password@gate.nodemaven.com:8080",
			poolIndex: 0,
			affinityKey: "connection-1",
			refreshEpoch: 0,
		});
		now += 49;
		expect(
			runtime({
				handle: first.handle(),
				now: () => now,
				environment: { [APIFUSE__ENGINE__CEREMONY_LEASE_NODEMAVEN_TTL_MS]: "50" },
			}).binding?.poolIndex,
		).toBe(0);
	});
});
