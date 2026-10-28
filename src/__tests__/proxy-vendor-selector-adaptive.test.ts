import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { resolveProxyConfigAsync } from "../config/loader.js";
import { NODEMAVEN_PASSWORD_ENV, NODEMAVEN_USERNAME_ENV } from "../runtime/proxy-nodemaven.js";
import { SMARTPROXY_PASSWORD_ENV, SMARTPROXY_USERNAME_ENV } from "../runtime/proxy-smartproxy.js";
import {
	ADAPTIVE_PROXY_VENDOR_SELECTOR_DEFAULTS,
	classifyProxyVendorAttemptOutcome,
	createAdaptiveProxyVendorSelector,
	type ProxyVendorStateTransition,
	resolveProxyVendorSelectionMode,
} from "../runtime/proxy-vendor-selector-adaptive.js";
import {
	PROXY_ATTEMPTS_PER_VENDOR,
	type ProxyAttemptOutcome,
	type ProxyAttemptRequest,
	staticOrderProxyVendorSelector,
} from "../runtime/proxy-vendor-selector.js";
import type { ProviderProxyPolicy } from "../types.js";

const policy: ProviderProxyPolicy = {
	mode: "required",
	providers: ["smartproxy", "nodemaven"],
	geo: { country: "KR" },
	session: { affinity: "connection", lifetimeMinutes: 120 },
};
const chain = ["smartproxy", "nodemaven"] as const;
const T0 = 1_800_000_000_000;
const { baseOpenMs, maxOpenMs, consecutiveFailureThreshold, ejectionDecayIntervalMs } =
	ADAPTIVE_PROXY_VENDOR_SELECTOR_DEFAULTS;

function request(attempt: number, now: number): ProxyAttemptRequest {
	return {
		policy,
		chain,
		attempt,
		attemptCap: chain.length * PROXY_ATTEMPTS_PER_VENDOR,
		affinityKey: "af_con_1",
		now,
	};
}

function failure(
	vendor: "smartproxy" | "nodemaven",
	now: number,
	errorCode = "proxy_connect_failed",
): ProxyAttemptOutcome {
	return { vendor, phase: "transport", outcome: "error", errorCode, durationMs: 450, now };
}

function success(vendor: "smartproxy" | "nodemaven", now: number): ProxyAttemptOutcome {
	return { vendor, phase: "transport", outcome: "ok", status: 200, durationMs: 1_800, now };
}

function vendorsOf(
	selector: ReturnType<typeof createAdaptiveProxyVendorSelector>,
	attempt: number,
	now: number,
) {
	return selector.select(request(attempt, now)).map((directive) => directive.vendor);
}

describe("adaptive proxy vendor selector", () => {
	it("starts cold on the declared order and matches the static selector directive for directive", () => {
		const selector = createAdaptiveProxyVendorSelector();
		for (let attempt = 0; attempt < chain.length * PROXY_ATTEMPTS_PER_VENDOR + 2; attempt += 1) {
			expect(selector.select(request(attempt, T0))).toEqual(
				staticOrderProxyVendorSelector.select(request(attempt, T0)),
			);
			expect(selector.lastSelectionReason()).toBe("chain_order");
		}
		expect(selector.snapshot(T0)).toEqual([
			{ vendor: "smartproxy", state: "closed", consecutiveFailures: 0, ejections: 0 },
			{ vendor: "nodemaven", state: "closed", consecutiveFailures: 0, ejections: 0 },
		]);
	});

	it("opens a vendor after the consecutive-failure threshold and routes the next attempt past it", () => {
		const transitions: ProxyVendorStateTransition[] = [];
		const selector = createAdaptiveProxyVendorSelector({
			onTransition: (event) => transitions.push(event),
		});
		for (let i = 0; i < consecutiveFailureThreshold - 1; i += 1) {
			selector.report(failure("smartproxy", T0 + i));
		}
		expect(vendorsOf(selector, 0, T0 + 10)).toEqual(["smartproxy", "nodemaven"]);
		expect(transitions).toEqual([]);

		selector.report(failure("smartproxy", T0 + 10));
		expect(transitions).toEqual([
			{
				vendor: "smartproxy",
				from: "closed",
				to: "open",
				reason: "failure_threshold",
				now: T0 + 10,
				consecutiveFailures: consecutiveFailureThreshold,
				ejections: 1,
				openUntil: T0 + 10 + baseOpenMs,
				errorCode: "proxy_connect_failed",
			},
		]);
		const directives = selector.select(request(0, T0 + 11));
		expect(directives.map((directive) => directive.vendor)).toEqual(["nodemaven"]);
		// The fallback vendor takes the whole budget from its first attempt.
		expect(directives[0]?.vendorAttempt).toBe(0);
		expect(selector.select(request(4, T0 + 12))[0]?.vendorAttempt).toBe(4);
		expect(directives[0]?.session).toEqual({ kind: "sticky", lifetimeMinutes: 120 });
		expect(selector.lastSelectionReason()).toBe("vendor_open");
		expect(selector.snapshot(T0 + 12)).toMatchObject([
			{ vendor: "smartproxy", state: "open", ejections: 1, openUntil: T0 + 10 + baseOpenMs },
			{ vendor: "nodemaven", state: "closed" },
		]);
	});

	it("probes once after the open period, closes on success and re-opens longer on failure", () => {
		const selector = createAdaptiveProxyVendorSelector();
		for (let i = 0; i < consecutiveFailureThreshold; i += 1) {
			selector.report(failure("smartproxy", T0));
		}
		const probeAt = T0 + baseOpenMs;
		expect(vendorsOf(selector, 0, probeAt - 1)).toEqual(["nodemaven"]);
		expect(vendorsOf(selector, 0, probeAt)).toEqual(["smartproxy", "nodemaven"]);
		expect(selector.lastSelectionReason()).toBe("half_open_probe");
		// A second request while the probe is in flight does not probe again.
		expect(vendorsOf(selector, 0, probeAt + 1)).toEqual(["nodemaven"]);
		expect(selector.lastSelectionReason()).toBe("vendor_open");

		selector.report(failure("smartproxy", probeAt + 2));
		expect(selector.snapshot(probeAt + 2)[0]).toMatchObject({
			vendor: "smartproxy",
			state: "open",
			consecutiveFailures: 0,
			ejections: 2,
			openUntil: probeAt + 2 + 2 * baseOpenMs,
		});

		const secondProbeAt = probeAt + 2 + 2 * baseOpenMs;
		expect(vendorsOf(selector, 0, secondProbeAt)).toEqual(["smartproxy", "nodemaven"]);
		selector.report(success("smartproxy", secondProbeAt + 1));
		expect(selector.snapshot(secondProbeAt + 1)[0]).toMatchObject({
			vendor: "smartproxy",
			state: "closed",
			consecutiveFailures: 0,
			ejections: 2,
		});
		expect(vendorsOf(selector, 0, secondProbeAt + 2)).toEqual(["smartproxy", "nodemaven"]);
		expect(selector.lastSelectionReason()).toBe("chain_order");
	});

	it("caps the open period and lets the multiplier decay while closed", () => {
		const selector = createAdaptiveProxyVendorSelector();
		let now = T0;
		for (let ejection = 1; ejection <= 12; ejection += 1) {
			if (ejection === 1) {
				for (let i = 0; i < consecutiveFailureThreshold; i += 1)
					selector.report(failure("smartproxy", now));
			} else {
				selector.report(failure("smartproxy", now));
			}
			const [entry] = selector.snapshot(now);
			expect(entry?.openUntil).toBe(now + Math.min(maxOpenMs, baseOpenMs * ejection));
			now = entry?.openUntil ?? now;
			// Probe (half-open) then fail again.
			expect(vendorsOf(selector, 0, now)[0]).toBe("smartproxy");
		}
		selector.report(success("smartproxy", now));
		expect(selector.snapshot(now)[0]).toMatchObject({ state: "closed", ejections: 12 });
		expect(selector.snapshot(now + 3 * ejectionDecayIntervalMs)[0]).toMatchObject({ ejections: 9 });
		expect(selector.snapshot(now + 100 * ejectionDecayIntervalMs)[0]).toMatchObject({
			ejections: 0,
		});
	});

	it("allows another probe when the first one never reports", () => {
		const selector = createAdaptiveProxyVendorSelector();
		for (let i = 0; i < consecutiveFailureThreshold; i += 1)
			selector.report(failure("smartproxy", T0));
		const probeAt = T0 + baseOpenMs;
		expect(vendorsOf(selector, 0, probeAt)[0]).toBe("smartproxy");
		expect(vendorsOf(selector, 0, probeAt + 1)[0]).toBe("nodemaven");
		const retryAt = probeAt + ADAPTIVE_PROXY_VENDOR_SELECTOR_DEFAULTS.probeTimeoutMs;
		expect(vendorsOf(selector, 0, retryAt)[0]).toBe("smartproxy");
	});

	it("fails open to the declared order when every vendor is open", () => {
		const selector = createAdaptiveProxyVendorSelector();
		for (let i = 0; i < consecutiveFailureThreshold; i += 1) {
			selector.report(failure("smartproxy", T0));
			selector.report(failure("nodemaven", T0));
		}
		expect(selector.select(request(1, T0 + 1))).toEqual(
			staticOrderProxyVendorSelector.select(request(1, T0 + 1)),
		);
		expect(selector.lastSelectionReason()).toBe("all_open");
	});

	it("does not count cancellation, timeouts or delivered upstream statuses against the vendor", () => {
		const selector = createAdaptiveProxyVendorSelector();
		for (let i = 0; i < 20; i += 1) {
			selector.report(failure("smartproxy", T0 + i, "transport_cancelled"));
			selector.report(failure("smartproxy", T0 + i, "transport_timeout"));
			selector.report(failure("smartproxy", T0 + i, "upstream_http_error"));
			selector.report({
				vendor: "smartproxy",
				phase: "transport",
				outcome: "error",
				status: 403,
				now: T0 + i,
			});
		}
		expect(selector.snapshot(T0 + 20)[0]).toMatchObject({
			state: "closed",
			consecutiveFailures: 0,
		});
		// A delivered response resets a partial failure streak.
		for (let i = 0; i < consecutiveFailureThreshold - 1; i += 1)
			selector.report(failure("smartproxy", T0 + 30));
		selector.report({
			vendor: "smartproxy",
			phase: "transport",
			outcome: "error",
			status: 503,
			now: T0 + 31,
		});
		selector.report(failure("smartproxy", T0 + 32));
		expect(selector.snapshot(T0 + 32)[0]).toMatchObject({
			state: "closed",
			consecutiveFailures: 1,
		});
	});

	it("counts a resolution failure of the vendor but not a missing credential", () => {
		const selector = createAdaptiveProxyVendorSelector({ consecutiveFailureThreshold: 2 });
		selector.report({
			vendor: "smartproxy",
			phase: "resolution",
			outcome: "error",
			errorCode: "no_credentials",
			now: T0,
		});
		selector.report({
			vendor: "smartproxy",
			phase: "resolution",
			outcome: "error",
			errorCode: "protocol_unsupported",
			now: T0,
		});
		expect(selector.snapshot(T0)[0]).toMatchObject({ state: "closed", consecutiveFailures: 0 });
		selector.report({
			vendor: "smartproxy",
			phase: "resolution",
			outcome: "error",
			errorCode: "PROXY_ALLOCATION_FAILED",
			now: T0,
		});
		selector.report({
			vendor: "smartproxy",
			phase: "resolution",
			outcome: "error",
			errorCode: "PROXY_ALLOCATION_FAILED",
			now: T0,
		});
		expect(selector.snapshot(T0)[0]).toMatchObject({ state: "open", ejections: 1 });
	});
});

describe("adaptive selector within one request", () => {
	const cap = chain.length * PROXY_ATTEMPTS_PER_VENDOR;
	const withHistory = (
		attempt: number,
		history: ProxyAttemptRequest["history"],
	): ProxyAttemptRequest => ({ ...request(attempt, T0), history });

	it("moves the next attempt to another closed vendor after a failure of the vendor", () => {
		const selector = createAdaptiveProxyVendorSelector();
		const directives = selector.select(
			withHistory(1, [
				{ vendor: "smartproxy", outcome: "error", errorCode: "proxy_connect_failed" },
			]),
		);
		expect(directives.map((directive) => directive.vendor)).toEqual(["nodemaven", "smartproxy"]);
		// Past every static share index, so no session of the request is reused.
		expect(directives[0]?.vendorAttempt).toBe(cap + 1);
		expect(selector.lastSelectionReason()).toBe("retry_alternate");
		for (let attempt = 0; attempt < cap; attempt += 1) {
			for (const directive of staticOrderProxyVendorSelector.select(request(attempt, T0))) {
				expect(directive.vendorAttempt).toBeLessThan(cap);
			}
		}
	});

	it("stays on the baseline after a success or a failure that is not the vendor's", () => {
		const selector = createAdaptiveProxyVendorSelector();
		for (const last of [
			{ vendor: "smartproxy", outcome: "ok" },
			{ vendor: "smartproxy", outcome: "error", errorCode: "transport_timeout" },
			{ vendor: "smartproxy", outcome: "error", errorCode: "transport_cancelled" },
			{ vendor: "smartproxy", outcome: "error" },
		] as const) {
			expect(selector.select(withHistory(1, [last]))[0]).toMatchObject({
				vendor: "smartproxy",
				vendorAttempt: 1,
			});
			expect(selector.lastSelectionReason()).toBe("chain_order");
		}
	});

	it("keeps the failed vendor when no other vendor is closed", () => {
		const selector = createAdaptiveProxyVendorSelector();
		for (let i = 0; i < consecutiveFailureThreshold; i += 1)
			selector.report(failure("nodemaven", T0));
		const directives = selector.select(
			withHistory(1, [
				{ vendor: "smartproxy", outcome: "error", errorCode: "transport_network_error" },
			]),
		);
		expect(directives.map((directive) => directive.vendor)).toEqual(["smartproxy"]);
		expect(selector.lastSelectionReason()).toBe("chain_order");
	});

	it("leaves an alternate that is already the baseline head alone", () => {
		const selector = createAdaptiveProxyVendorSelector();
		// Attempt 3 is nodemaven's share; a smartproxy failure before it changes nothing.
		const directives = selector.select(
			withHistory(3, [
				{ vendor: "smartproxy", outcome: "error", errorCode: "proxy_connect_failed" },
			]),
		);
		expect(directives[0]).toMatchObject({ vendor: "nodemaven", vendorAttempt: 0 });
		expect(selector.lastSelectionReason()).toBe("chain_order");
	});
});

describe("proxy vendor attempt outcome classification", () => {
	const transport = (errorCode?: string, outcome: "ok" | "error" = "error") =>
		classifyProxyVendorAttemptOutcome({
			phase: "transport",
			outcome,
			...(errorCode ? { errorCode } : {}),
		});

	it("classifies the transport codes the SDK emits", () => {
		expect(transport(undefined, "ok")).toBe("ok");
		expect(transport(undefined)).toBe("ok");
		expect(transport("upstream_http_error")).toBe("ok");
		for (const code of [
			"proxy_connect_failed",
			"PROXY_POOL_STALE",
			"PROXY_EDGE_AUTH_REJECTED",
			"PROXY_EDGE_TLS_REJECTED",
			"PROXY_AUTH_IP_DENIED",
			"PROXY_ALLOCATION_FAILED",
			"transport_network_error",
		]) {
			expect(transport(code)).toBe("vendor_failure");
		}
		for (const code of [
			"transport_cancelled",
			"transport_timeout",
			"response_too_large",
			"retry_exhausted",
		]) {
			expect(transport(code)).toBe("other_failure");
		}
	});

	it("classifies resolution outcomes", () => {
		const resolution = (errorCode: string) =>
			classifyProxyVendorAttemptOutcome({ phase: "resolution", outcome: "error", errorCode });
		expect(resolution("no_credentials")).toBe("other_failure");
		expect(resolution("protocol_unsupported")).toBe("other_failure");
		expect(resolution("PROXY_ALLOCATION_FAILED")).toBe("vendor_failure");
		expect(classifyProxyVendorAttemptOutcome({ phase: "resolution", outcome: "ok" })).toBe("ok");
	});
});

describe("proxy vendor selection mode", () => {
	it("accepts the two modes case-insensitively and falls back otherwise", () => {
		expect(resolveProxyVendorSelectionMode("adaptive", "ordered")).toBe("adaptive");
		expect(resolveProxyVendorSelectionMode(" Ordered ", "adaptive")).toBe("ordered");
		expect(resolveProxyVendorSelectionMode(undefined, "ordered")).toBe("ordered");
		expect(resolveProxyVendorSelectionMode("", "adaptive")).toBe("adaptive");
		expect(resolveProxyVendorSelectionMode("weighted", "ordered")).toBe("ordered");
	});
});

describe("adaptive selector through the resolver", () => {
	const saved = new Map<string, string | undefined>();
	const keys = [
		SMARTPROXY_USERNAME_ENV,
		SMARTPROXY_PASSWORD_ENV,
		NODEMAVEN_USERNAME_ENV,
		NODEMAVEN_PASSWORD_ENV,
	];

	beforeEach(() => {
		for (const key of keys) {
			saved.set(key, process.env[key]);
		}
		process.env[SMARTPROXY_USERNAME_ENV] = "sp-user";
		process.env[SMARTPROXY_PASSWORD_ENV] = "sp-pass";
		process.env[NODEMAVEN_USERNAME_ENV] = "acct123";
		process.env[NODEMAVEN_PASSWORD_ENV] = "s3cret";
	});

	afterEach(() => {
		for (const key of keys) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("serves the first attempt from the fallback vendor once the primary is open", async () => {
		const selector = createAdaptiveProxyVendorSelector();
		const cold = await resolveProxyConfigAsync({
			proxyPolicy: policy,
			affinityKey: "af_con_1",
			proxyAttempt: 0,
			now: T0,
			vendorSelector: selector,
		});
		expect(cold.source).toBe("smartproxy-gateway");

		for (let i = 0; i < consecutiveFailureThreshold; i += 1)
			selector.report(failure("smartproxy", T0 + i));
		const ejected = await resolveProxyConfigAsync({
			proxyPolicy: policy,
			affinityKey: "af_con_1",
			proxyAttempt: 0,
			now: T0 + 10,
			vendorSelector: selector,
		});
		expect(ejected.source).toBe("nodemaven-gateway");
		expect(ejected.sticky).toBe(true);
		// The resolver reported the successful synthesis; the vendor stays closed.
		expect(selector.snapshot(T0 + 10)).toMatchObject([
			{ vendor: "smartproxy", state: "open" },
			{ vendor: "nodemaven", state: "closed", consecutiveFailures: 0 },
		]);
	});

	it("learns from the transport attempt, not from the synthesis the resolver reports before it", async () => {
		const selector = createAdaptiveProxyVendorSelector();
		// Each request: the resolver selects and reports a successful synthesis,
		// then the tunnel fails. The streak must survive the synthesis reports.
		for (let i = 0; i < consecutiveFailureThreshold; i += 1) {
			const resolved = await resolveProxyConfigAsync({
				proxyPolicy: policy,
				affinityKey: "af_con_1",
				proxyAttempt: 0,
				now: T0 + i,
				vendorSelector: selector,
			});
			expect(resolved.source).toBe("smartproxy-gateway");
			selector.report(failure("smartproxy", T0 + i));
		}
		expect(selector.snapshot(T0 + consecutiveFailureThreshold)[0]).toMatchObject({
			vendor: "smartproxy",
			state: "open",
			ejections: 1,
		});

		// The probe stays in flight through its own synthesis; the tunnel decides.
		const probeAt = T0 + baseOpenMs + consecutiveFailureThreshold;
		const probe = await resolveProxyConfigAsync({
			proxyPolicy: policy,
			affinityKey: "af_con_1",
			proxyAttempt: 0,
			now: probeAt,
			vendorSelector: selector,
		});
		expect(probe.source).toBe("smartproxy-gateway");
		expect(selector.lastSelectionReason()).toBe("half_open_probe");
		expect(selector.snapshot(probeAt)[0]).toMatchObject({
			state: "half_open",
			probeIssuedAt: probeAt,
		});
		selector.report(success("smartproxy", probeAt + 900));
		expect(selector.snapshot(probeAt + 900)[0]).toMatchObject({
			state: "closed",
			consecutiveFailures: 0,
		});
	});
});
