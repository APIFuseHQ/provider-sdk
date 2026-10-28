import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import type { ProviderProxyPolicy } from "../../types.js";
import {
	deriveProxySessionId,
	isStickyProxyPolicy,
	PROXY_SESSION_ID_LENGTH,
	proxySessionWindow,
} from "../proxy-session-id.js";
import {
	SMARTPROXY_GATEWAY_HOST,
	SMARTPROXY_GATEWAY_PORT,
	SMARTPROXY_MAX_LIFETIME_MINUTES,
	SMARTPROXY_MIN_LIFETIME_MINUTES,
	smartproxyLifetimeMinutes,
	smartproxySessionWindow,
	synthesizeSmartproxyProxy,
	type SmartproxySynthesisInput,
} from "../proxy-smartproxy.js";

const CREDENTIALS = { username: "smart-HUHU123", password: "p@ss:w/rd" };
const NOW = Date.parse("2026-10-28T05:10:00.000Z");

function synthesize(overrides: Partial<SmartproxySynthesisInput> = {}) {
	return synthesizeSmartproxyProxy({
		policy: { mode: "required", providers: ["smartproxy"] },
		credentials: CREDENTIALS,
		affinityKey: undefined,
		protocol: "http",
		attempt: 0,
		windowEpoch: 0,
		now: NOW,
		...overrides,
	});
}

function gatewayUsername(url: string): string {
	return decodeURIComponent(new URL(url).username);
}

function sha256Prefix(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, PROXY_SESSION_ID_LENGTH);
}

describe("proxy session ids", () => {
	it("treats only the default request affinity as rotating", () => {
		expect(isStickyProxyPolicy({ mode: "required" })).toBe(false);
		expect(isStickyProxyPolicy({ mode: "required", session: { affinity: "request" } })).toBe(false);
		for (const affinity of ["operation", "auth-flow", "connection"] as const) {
			expect(isStickyProxyPolicy({ mode: "required", session: { affinity } })).toBe(true);
		}
	});

	it("aligns the sticky window to the wall clock so every process derives the same epoch", () => {
		const window = proxySessionWindow(30, NOW);
		expect(window.windowEpoch).toBe(Math.floor(NOW / 1_800_000));
		expect(window.expiresAt).toBe("2026-10-28T05:30:00.000Z");
		expect(proxySessionWindow(0, NOW).windowEpoch).toBe(Math.floor(NOW / 60_000));
	});

	it("derives a sticky id from the affinity key, the window and the attempt", () => {
		const input = { sticky: true, affinityKey: "conn-1", windowEpoch: 42, attempt: 0 };
		expect(deriveProxySessionId(input)).toBe(sha256Prefix("conn-1:42:0"));
		expect(deriveProxySessionId(input)).toBe(deriveProxySessionId({ ...input }));
		// A retry leaves the session that failed; the next window starts a new one.
		expect(deriveProxySessionId({ ...input, attempt: 1 })).toBe(sha256Prefix("conn-1:42:1"));
		expect(deriveProxySessionId({ ...input, windowEpoch: 43 })).not.toBe(
			deriveProxySessionId(input),
		);
		expect(deriveProxySessionId({ ...input, attempt: Number.NaN })).toBe(
			sha256Prefix("conn-1:42:0"),
		);
	});

	it("mints a random id per call for rotating policies and for a sticky policy without a key", () => {
		const ids = new Set(
			Array.from({ length: 32 }, () =>
				deriveProxySessionId({ sticky: false, affinityKey: "conn-1", windowEpoch: 0, attempt: 0 }),
			),
		);
		expect(ids.size).toBe(32);
		for (const id of ids) expect(id).toMatch(/^[0-9a-f]{10}$/);
		const keyless = deriveProxySessionId({
			sticky: true,
			affinityKey: undefined,
			windowEpoch: 0,
			attempt: 0,
		});
		expect(keyless).toMatch(/^[0-9a-f]{10}$/);
	});
});

describe("synthesizeSmartproxyProxy", () => {
	it("encodes the dashboard username grammar against the vendor gateway", () => {
		// The caller resolves the country (policy geo or platform default) and passes it in.
		const synthesized = synthesize({ country: "KR" });
		const url = new URL(synthesized.url);

		expect(url.protocol).toBe("http:");
		expect(url.hostname).toBe(SMARTPROXY_GATEWAY_HOST);
		expect(Number(url.port)).toBe(SMARTPROXY_GATEWAY_PORT);
		expect(gatewayUsername(synthesized.url)).toBe(
			`smart-HUHU123_area-KR_life-30_session-${synthesized.sessionId}`,
		);
		expect(decodeURIComponent(url.password)).toBe(CREDENTIALS.password);
		expect(synthesized).toMatchObject({ sticky: false, lifetimeMinutes: 30, protocol: "http" });
		expect(synthesized.expiresAt).toBeUndefined();
		expect(synthesized.diagnostics).toEqual({
			vendor: "smartproxy",
			protocol: "http",
			sticky: false,
			lifetimeMinutes: 30,
			country: "KR",
		});
		expect(JSON.stringify(synthesized.diagnostics)).not.toContain("HUHU123");
	});

	it("omits area without a country, uppercases a lowercase one and keeps socks5 on the same gateway", () => {
		expect(gatewayUsername(synthesize().url)).toMatch(
			/^smart-HUHU123_life-30_session-[0-9a-f]{10}$/,
		);
		const lower = synthesize({ country: " kr " });
		expect(gatewayUsername(lower.url)).toStartWith("smart-HUHU123_area-KR_");
		const socks = new URL(synthesize({ protocol: "socks5" }).url);
		expect(socks.protocol).toBe("socks5:");
		expect(socks.host).toBe(`${SMARTPROXY_GATEWAY_HOST}:${SMARTPROXY_GATEWAY_PORT}`);
	});

	it("clamps the lifetime to the vendor's sticky range and reports the clamp", () => {
		const policy = (lifetimeMinutes: number): ProviderProxyPolicy => ({
			mode: "required",
			providers: ["smartproxy"],
			session: { affinity: "connection", lifetimeMinutes },
		});
		const short = synthesize({ policy: policy(1), affinityKey: "conn-1" });
		const long = synthesize({ policy: policy(1440), affinityKey: "conn-1" });
		const inside = synthesize({ policy: policy(45), affinityKey: "conn-1" });

		expect(short.lifetimeMinutes).toBe(SMARTPROXY_MIN_LIFETIME_MINUTES);
		expect(short.diagnostics.lifetimeClamped).toBe(true);
		expect(gatewayUsername(short.url)).toContain("_life-5_");
		expect(long.lifetimeMinutes).toBe(SMARTPROXY_MAX_LIFETIME_MINUTES);
		expect(long.diagnostics.lifetimeClamped).toBe(true);
		expect(inside.lifetimeMinutes).toBe(45);
		expect("lifetimeClamped" in inside.diagnostics).toBe(false);
		expect(smartproxyLifetimeMinutes({ mode: "required" }, 12)).toBe(12);
		expect(smartproxySessionWindow(policy(1440), NOW).windowEpoch).toBe(
			Math.floor(NOW / (120 * 60_000)),
		);
	});

	it("derives the sticky session from the affinity, window and attempt, and reports the expiry", () => {
		const policy: ProviderProxyPolicy = {
			mode: "required",
			providers: ["smartproxy"],
			session: { affinity: "connection", lifetimeMinutes: 30 },
		};
		const first = synthesize({
			policy,
			affinityKey: "conn-1",
			windowEpoch: 7,
			expiresAt: "2026-10-28T05:30:00.000Z",
		});
		const again = synthesize({ policy, affinityKey: "conn-1", windowEpoch: 7 });
		const retry = synthesize({ policy, affinityKey: "conn-1", windowEpoch: 7, attempt: 1 });

		expect(first.sticky).toBe(true);
		expect(first.sessionId).toBe(sha256Prefix("conn-1:7:0"));
		expect(again.sessionId).toBe(first.sessionId);
		expect(retry.sessionId).toBe(sha256Prefix("conn-1:7:1"));
		expect(first.expiresAt).toBe("2026-10-28T05:30:00.000Z");
		expect(again.expiresAt).toBe(new Date(NOW + 30 * 60_000).toISOString());
	});

	it("follows the selector's session directive over the policy's own", () => {
		const policy: ProviderProxyPolicy = {
			mode: "required",
			providers: ["smartproxy"],
			session: { affinity: "connection", lifetimeMinutes: 30 },
		};
		const rotating = synthesize({ policy, affinityKey: "conn-1", session: { kind: "rotating" } });
		const sticky = synthesize({
			affinityKey: "conn-1",
			windowEpoch: 3,
			session: { kind: "sticky", lifetimeMinutes: 10 },
		});

		expect(rotating.sticky).toBe(false);
		expect(rotating.expiresAt).toBeUndefined();
		expect(sticky.sticky).toBe(true);
		expect(sticky.sessionId).toBe(sha256Prefix("conn-1:3:0"));
		expect(gatewayUsername(sticky.url)).toContain("_life-10_");
	});

	it("rejects credentials and tokens the username grammar cannot carry", () => {
		expect(() => synthesize({ credentials: { username: "", password: "x" } })).toThrow(
			"smartproxy credentials missing: set APIFUSE__PROXY__SMARTPROXY_USERNAME and APIFUSE__PROXY__SMARTPROXY_PASSWORD.",
		);
		expect(() => synthesize({ credentials: { username: "smart_user", password: "x" } })).toThrow(
			'APIFUSE__PROXY__SMARTPROXY_USERNAME must not contain "_" (the username token separator)',
		);
		expect(() => synthesize({ country: "K_R" })).toThrow(
			'smartproxy username token "area" has an invalid value',
		);
	});

	it("points at a gateway override without changing the username or password", () => {
		const synthesized = synthesize({ gateway: { host: "127.0.0.1", port: 18_080 } });
		const url = new URL(synthesized.url);
		expect(url.host).toBe("127.0.0.1:18080");
		expect(gatewayUsername(synthesized.url)).toBe(
			`smart-HUHU123_life-30_session-${synthesized.sessionId}`,
		);
		expect(decodeURIComponent(url.password)).toBe(CREDENTIALS.password);
	});
});
