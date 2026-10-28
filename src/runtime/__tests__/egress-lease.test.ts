import { describe, expect, it } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

import { createDiagnosticRedactor } from "../diagnostic-redactor.js";
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
	proxyUrl: "http://user_area-KR_life-30_session-0a1b2c3d4e:password@proxy.smartproxy.net:3120",
	affinityKey: DEFAULT_SCOPE.affinityKey,
	sessionId: "0a1b2c3d4e",
	lifetimeMinutes: 30,
};

/**
 * A handle minted by the v1 encoder (before gateway sessions): the payload
 * carried the allocator-era `poolIndex` and `refreshEpoch`, the AAD and the
 * wire prefix carry version 1. Mirrors the SDK encoder byte for byte.
 */
function mintV1Handle(
	binding: {
		vendor: "smartproxy" | "nodemaven";
		proxyUrl: string;
		poolIndex: number;
		refreshEpoch: number;
		lifetimeMinutes: number;
	},
	mintedAtMs: number,
	scope: LeaseScope = DEFAULT_SCOPE,
): string {
	const key = createHash("sha256")
		.update("apifuse:ceremony-egress-lease:v1\0", "utf8")
		.update(KEY, "utf8")
		.digest();
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
	cipher.setAAD(
		Buffer.from(
			JSON.stringify({
				version: 1,
				tenantId: scope.tenantId,
				providerId: scope.providerId,
				flowId: scope.flowId,
				affinityKey: scope.affinityKey,
			}),
			"utf8",
		),
	);
	const payload = {
		version: 1,
		tenantId: scope.tenantId,
		providerId: scope.providerId,
		flowId: scope.flowId,
		vendor: binding.vendor,
		proxyUrl: binding.proxyUrl,
		poolIndex: binding.poolIndex,
		affinityKey: scope.affinityKey,
		refreshEpoch: binding.refreshEpoch,
		lifetimeMinutes: binding.lifetimeMinutes,
		mintedAtMs,
		expiresAtMs: mintedAtMs + binding.lifetimeMinutes * 60_000,
	};
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(payload), "utf8"),
		cipher.final(),
	]);
	return [
		"v1",
		nonce.toString("base64url"),
		ciphertext.toString("base64url"),
		cipher.getAuthTag().toString("base64url"),
	].join(".");
}

/** The binding a later attempt takes: the same gateway, the next vendor session. */
const NEXT_SESSION_BINDING: CeremonyEgressBinding = {
	...SMARTPROXY_BINDING,
	proxyUrl: "http://user_area-KR_life-30_session-5f6e7d8c9b:password@proxy.smartproxy.net:3120",
	sessionId: "5f6e7d8c9b",
};

function runtime(
	options: Partial<LeaseScope> & {
		handle?: string;
		now?: () => number;
		onHandle?: (handle: string) => void;
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
	it("registers newly minted and restored handles before callers can emit them", () => {
		const mintedRegistry = createDiagnosticRedactor([]);
		const minted: string[] = [];
		const first = runtime({
			now: () => 1_000,
			onHandle(handle) {
				mintedRegistry.add([handle]);
				minted.push(handle);
			},
		});
		expect(minted).toEqual([]);
		first.bind(SMARTPROXY_BINDING);
		const handle = first.handle();
		if (!handle) throw new Error("fixture handle was not minted");
		expect(minted).toEqual([handle]);
		expect(mintedRegistry.redact(`lease ${handle}`)).toBe("lease [REDACTED]");

		const restoredRegistry = createDiagnosticRedactor([]);
		const restored: string[] = [];
		const next = runtime({
			handle,
			now: () => 1_001,
			onHandle(value) {
				restoredRegistry.add([value]);
				restored.push(value);
			},
		});
		expect(restored).toEqual([handle]);
		expect(next.handle()).toBe(handle);
		expect(restoredRegistry.redact(`lease ${next.handle()}`)).toBe("lease [REDACTED]");
	});

	it("mints and verifies an opaque exact NodeMaven binding", () => {
		const first = runtime({ now: () => 1_000 });
		first.bind({
			vendor: "nodemaven",
			proxyUrl: "http://account-sid-fixed:password@gate.nodemaven.com:8080",
			affinityKey: "connection-1",
			sessionId: "fixed",
			lifetimeMinutes: 30,
		});
		const handle = first.handle();
		expect(handle).toBeString();
		expect(String(handle).startsWith("v2.")).toBe(true);
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
			affinityKey: "connection-1",
			sessionId: "fixed",
			lifetimeMinutes: 30,
		});
	});

	it("verifies a v1 handle minted before the upgrade and binds it without the allocator fields", () => {
		// A ceremony in flight across the SDK upgrade keeps its egress: the v1 handle's
		// version is part of the AAD, and its poolIndex / refreshEpoch are not read.
		const v1Handle = mintV1Handle(
			{
				vendor: "smartproxy",
				proxyUrl: "http://203.0.113.9:31001",
				poolIndex: 4,
				refreshEpoch: 1,
				lifetimeMinutes: 30,
			},
			1_000,
		);
		const restored = runtime({ handle: v1Handle, now: () => 2_000 });
		expect(restored.binding).toEqual({
			vendor: "smartproxy",
			proxyUrl: "http://203.0.113.9:31001",
			affinityKey: DEFAULT_SCOPE.affinityKey,
			lifetimeMinutes: 30,
		});
		expect(restored.handle()).toBe(v1Handle);

		// The v1 AAD still binds the ceremony scope.
		expect(() => runtime({ handle: v1Handle, flowId: "other-flow", now: () => 2_000 })).toThrow(
			expect.objectContaining({ code: "EGRESS_LEASE_INVALID" }),
		);
		// A v1 payload relabelled as v2 fails authentication instead of verifying.
		expect(() => runtime({ handle: v1Handle.replace(/^v1\./u, "v2."), now: () => 2_000 })).toThrow(
			expect.objectContaining({ code: "EGRESS_LEASE_INVALID" }),
		);
		// An expired v1 handle is dropped like any other, never treated as a fault.
		const expired = runtime({ handle: v1Handle, now: () => 1_000 + 30 * 60_000 });
		expect(expired.binding).toBeUndefined();

		// The next bind after the upgrade mints a v2 handle.
		const rebound = runtime({ now: () => 3_000 });
		rebound.bind(SMARTPROXY_BINDING);
		expect(String(rebound.handle()).startsWith("v2.")).toBe(true);
	});

	it("rejects handle versions the engine never minted", () => {
		const handle = mintSmartproxyHandle();
		for (const version of ["v0", "v3", "v"]) {
			expect(() => runtime({ handle: handle.replace(/^v2/u, version), now: () => 1_001 })).toThrow(
				expect.objectContaining({ code: "EGRESS_LEASE_INVALID" }),
			);
		}
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

	it("rejects a key shorter than the documented 32 bytes before minting or verifying", () => {
		const thirtyOneBytes = "0123456789abcdef0123456789abcde";
		expect(() =>
			runtime({ environment: { [APIFUSE__ENGINE__CEREMONY_LEASE_KEY]: thirtyOneBytes } }),
		).toThrow(expect.objectContaining({ code: "EGRESS_LEASE_KEY_WEAK" }));
		const handle = mintSmartproxyHandle();
		expect(() =>
			runtime({
				handle,
				environment: { [APIFUSE__ENGINE__CEREMONY_LEASE_KEY]: thirtyOneBytes },
			}),
		).toThrow(expect.objectContaining({ code: "EGRESS_LEASE_KEY_WEAK" }));
		expect(
			runtime({ environment: { [APIFUSE__ENGINE__CEREMONY_LEASE_KEY]: `${thirtyOneBytes}f` } })
				.binding,
		).toBeUndefined();
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
			expect(observable).not.toContain("proxy.smartproxy.net");
			expect(observable).not.toContain("0a1b2c3d4e");
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
				environment: {
					[APIFUSE__ENGINE__CEREMONY_LEASE_KEY]: "rotated-engine-key-0123456789abcdef",
				},
			}),
		).toThrow(expect.objectContaining({ code: "EGRESS_LEASE_INVALID" }));
	});

	it("keeps a smartproxy gateway session binding for its `life` window and drops it after", () => {
		const handle = mintSmartproxyHandle(1_000);

		// The bound gateway URL, session id included, survives turns inside the
		// vendor session lifetime the URL asked for (`life-30`).
		const twentyNineMinutesLater = runtime({ handle, now: () => 1_000 + 29 * 60_000 });
		expect(twentyNineMinutesLater.binding).toEqual(SMARTPROXY_BINDING);
		expect(twentyNineMinutesLater.handle()).toBe(handle);

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
		expect(lease.binding?.sessionId).toBe("0a1b2c3d4e");

		now += 1;
		expect(lease.dropExpiredBinding()).toBe(true);
		expect(lease.binding).toBeUndefined();
		expect(lease.handle()).toBeUndefined();
		expect(lease.generation).toBe(1);
		expect(lease.dropExpiredBinding()).toBe(false);
		expect(lease.generation).toBe(1);

		lease.bind(NEXT_SESSION_BINDING);
		expect(lease.binding?.sessionId).toBe("5f6e7d8c9b");
		expect(lease.handle()).toBeString();
		expect(lease.handle()).not.toBe(firstHandle);
	});

	it("releases a binding on demand so the next attempt binds a fresh endpoint", () => {
		const lease = runtime({ now: () => 1_000 });
		expect(lease.dropBinding()).toBe(false);
		expect(lease.generation).toBe(0);
		lease.bind(SMARTPROXY_BINDING);
		const firstHandle = lease.handle();

		expect(lease.dropBinding()).toBe(true);
		expect(lease.binding).toBeUndefined();
		expect(lease.handle()).toBeUndefined();
		expect(lease.generation).toBe(1);
		expect(lease.dropBinding()).toBe(false);
		expect(lease.generation).toBe(1);

		// Rebinding does not count as a drop: sessions compare drops, not binds.
		lease.bind(NEXT_SESSION_BINDING);
		expect(lease.binding?.sessionId).toBe("5f6e7d8c9b");
		expect(lease.generation).toBe(1);
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
