import { describe, expect, it } from "bun:test";

import {
	APIFUSE__ENGINE__CEREMONY_LEASE_KEY,
	type CeremonyEgressBinding,
	createCeremonyEgressLeaseRuntime,
} from "../egress-lease.js";

const KEY = "fixture-engine-owned-ceremony-key";

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

const SMARTPROXY_BINDING: CeremonyEgressBinding = {
	vendor: "smartproxy",
	proxyUrl: "http://user:password@198.51.100.7:9000",
	poolIndex: 2,
	affinityKey: DEFAULT_SCOPE.affinityKey,
	refreshEpoch: 0,
	lifetimeMinutes: 30,
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
			[APIFUSE__ENGINE__CEREMONY_LEASE_KEY]: KEY,
			...(options.environment ?? {}),
		},
	});
}

function mintSmartproxyHandle(now = 1_000): string {
	const lease = runtime({ now: () => now });
	lease.bind(SMARTPROXY_BINDING);
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
				environment: { [APIFUSE__ENGINE__CEREMONY_LEASE_KEY]: KEY },
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

	it("rejects a handle whose key was rotated as invalid, never as expired", () => {
		const handle = mintSmartproxyHandle();
		expect(() =>
			runtime({
				handle,
				now: () => 1_001,
				environment: { [APIFUSE__ENGINE__CEREMONY_LEASE_KEY]: "rotated-engine-key" },
			}),
		).toThrow(expect.objectContaining({ code: "EGRESS_LEASE_INVALID" }));
	});

	it("keeps a Smartproxy binding for its session lifetime, not the 15 s extraction cache", () => {
		const handle = mintSmartproxyHandle(1_000);

		const twentySecondsLater = runtime({ handle, now: () => 21_000 });
		expect(twentySecondsLater.binding).toEqual(SMARTPROXY_BINDING);
		expect(twentySecondsLater.handle()).toBe(handle);

		const afterLifetime = runtime({ handle, now: () => 1_000 + 30 * 60_000 });
		expect(afterLifetime.binding).toBeUndefined();
		expect(afterLifetime.handle()).toBeUndefined();
	});

	it("drops an expired binding in place so the next attempt binds a fresh endpoint", () => {
		let now = 10_000;
		const lease = runtime({ now: () => now });
		lease.bind({ ...SMARTPROXY_BINDING, lifetimeMinutes: 1 });
		const firstHandle = lease.handle();
		now += 59_999;
		expect(lease.dropExpiredBinding()).toBe(false);
		expect(lease.binding?.poolIndex).toBe(2);

		now += 1;
		expect(lease.dropExpiredBinding()).toBe(true);
		expect(lease.binding).toBeUndefined();
		expect(lease.handle()).toBeUndefined();
		expect(lease.dropExpiredBinding()).toBe(false);

		lease.bind({ ...SMARTPROXY_BINDING, poolIndex: 5 });
		expect(lease.binding?.poolIndex).toBe(5);
		expect(lease.handle()).toBeString();
		expect(lease.handle()).not.toBe(firstHandle);
	});

	it("treats a second bind and an unrepresentable egress as engine faults, not caller faults", () => {
		const lease = runtime({ now: () => 1_000 });
		lease.bind(SMARTPROXY_BINDING);
		expect(() => lease.bind(SMARTPROXY_BINDING)).toThrow(
			expect.objectContaining({ code: "EGRESS_LEASE_BINDING_INVALID" }),
		);

		for (const binding of [
			{ ...SMARTPROXY_BINDING, affinityKey: "other-affinity" },
			{ ...SMARTPROXY_BINDING, lifetimeMinutes: 0 },
			{ ...SMARTPROXY_BINDING, proxyUrl: "" },
		]) {
			expect(() => runtime({ now: () => 1_000 }).bind(binding)).toThrow(
				expect.objectContaining({ code: "EGRESS_LEASE_BINDING_INVALID" }),
			);
		}
	});
});
