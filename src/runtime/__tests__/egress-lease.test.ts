import { describe, expect, it } from "bun:test";

import {
	APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY,
	APIFUSE__ENGINE__CEREMONY_LEASE_NODEMAVEN_TTL_MS,
	APIFUSE__ENGINE__CEREMONY_LEASE_SMARTPROXY_TTL_MS,
	createCeremonyEgressLeaseRuntime,
} from "../egress-lease.js";

const KEY = "fixture-engine-owned-ceremony-hmac-key";

type LeaseScope = {
	tenantId: string;
	providerId: string;
	flowId: string;
	affinityKey: string;
};

const DEFAULT_SCOPE: LeaseScope = {
	tenantId: "tenant-1",
	providerId: "lease-provider",
	flowId: "flow-1",
	affinityKey: "connection-1",
};

function runtime(
	options: Partial<LeaseScope> & {
		handle?: string;
		now?: () => number;
		environment?: Record<string, string>;
	} = {},
) {
	return createCeremonyEgressLeaseRuntime({
		...DEFAULT_SCOPE,
		...options,
		...(options.handle ? { handle: options.handle } : {}),
		...(options.now ? { now: options.now } : {}),
		environment: {
			[APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY]: KEY,
			...(options.environment ?? {}),
		},
	});
}

function mintSmartproxyHandle(): string {
	const lease = runtime({ now: () => 1_000 });
	lease.bind({
		vendor: "smartproxy",
		proxyUrl: "http://user:password@198.51.100.7:9000",
		poolIndex: 2,
		affinityKey: DEFAULT_SCOPE.affinityKey,
		refreshEpoch: 0,
	});
	const handle = lease.handle();
	if (!handle) throw new Error("fixture handle was not minted");
	return handle;
}

function flipWirePart(handle: string, partIndex: 1 | 2 | 3): string {
	const parts = handle.split(".");
	const bytes = Buffer.from(parts[partIndex] ?? "", "base64url");
	bytes[0] = (bytes[0] ?? 0) ^ 1;
	parts[partIndex] = bytes.toString("base64url");
	return parts.join(".");
}

function capturedError(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("Expected fixture to throw");
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
		const adversaryViews = String(handle)
			.split(".")
			.map((part) => Buffer.from(part, "base64url").toString("utf8"));
		for (const view of adversaryViews) {
			expect(view).not.toContain("proxyUrl");
			expect(view).not.toContain("nodemaven");
			expect(view).not.toContain("account-sid-fixed");
			expect(view).not.toContain("password");
			expect(view).not.toContain("gate.nodemaven.com");
		}
		expect(() => JSON.parse(adversaryViews[0] ?? "")).toThrow();

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

	it("fails before binding when the engine key is missing", () => {
		expect(() =>
			createCeremonyEgressLeaseRuntime({
				tenantId: DEFAULT_SCOPE.tenantId,
				providerId: "lease-provider",
				flowId: "flow-1",
				affinityKey: "connection-1",
				environment: {},
			}),
		).toThrow(expect.objectContaining({ code: "EGRESS_LEASE_KEY_MISSING" }));
	});

	it("rejects a missing tenant before a lease can be minted", () => {
		expect(() =>
			createCeremonyEgressLeaseRuntime({
				providerId: DEFAULT_SCOPE.providerId,
				flowId: DEFAULT_SCOPE.flowId,
				affinityKey: DEFAULT_SCOPE.affinityKey,
				environment: { [APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY]: KEY },
			}),
		).toThrow(expect.objectContaining({ code: "EGRESS_LEASE_INVALID" }));
	});

	it("authenticates tenant, provider, flow, and affinity as ceremony-scope AAD", () => {
		const handle = mintSmartproxyHandle();
		const changedScopes = [
			{ tenantId: "tenant-2" },
			{ providerId: "other-provider" },
			{ flowId: "other-flow" },
			{ affinityKey: "other-affinity" },
		] satisfies ReadonlyArray<Partial<LeaseScope>>;

		for (const changedScope of changedScopes) {
			expect(() => runtime({ handle, ...changedScope, now: () => 1_001 })).toThrow(
				expect.objectContaining({ code: "EGRESS_LEASE_INVALID" }),
			);
		}
	});

	it("uses a distinct random GCM nonce and wire token for every mint", () => {
		const handles = Array.from({ length: 64 }, () => mintSmartproxyHandle());
		const nonces = handles.map((handle) => handle.split(".")[1]);

		expect(new Set(nonces).size).toBe(64);
		expect(new Set(handles).size).toBe(64);
	});

	it("rejects nonce, ciphertext, and tag tampering without exposing partial payload", () => {
		const handle = mintSmartproxyHandle();
		for (const partIndex of [1, 2, 3] as const) {
			const error = capturedError(() => runtime({ handle: flipWirePart(handle, partIndex) }));
			expect(error).toMatchObject({ code: "EGRESS_LEASE_INVALID", details: undefined });
			const observable = JSON.stringify(error);
			expect(observable).not.toContain("proxyUrl");
			expect(observable).not.toContain("198.51.100.7");
			expect(observable).not.toContain("password");
			expect(observable).not.toContain(DEFAULT_SCOPE.tenantId);
		}
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
