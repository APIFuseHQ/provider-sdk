import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";

import { ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES } from "../engine.js";
import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";
import { PROVIDER_TELEMETRY_HEADER, ProxyTelemetryCollector } from "../runtime/proxy-telemetry.js";
import {
	type AdaptiveProxyVendorSelector,
	installProcessProxyVendorSelector,
	observeProxyVendorSelections,
	PROXY_VENDOR_SELECTION_ENV,
	type ProxyVendorSelectionObservation,
	type ProxyVendorStateTransition,
} from "../runtime/proxy-vendor-selector-adaptive.js";
import {
	getProxyVendorSelector,
	PROXY_ATTEMPTS_PER_VENDOR,
	type ProxyAttemptRequest,
	type ProxyVendorSelector,
	setProxyVendorSelector,
	staticOrderProxyVendorSelector,
} from "../runtime/proxy-vendor-selector.js";
import { isGatewayIngestible } from "../runtime/request-telemetry.js";
import { type ProviderServerLogEvent, serve } from "../server/serve.js";
import type { ProviderDefinition, ProviderProxyPolicy } from "../types.js";

const policy: ProviderProxyPolicy = { mode: "optional", providers: ["smartproxy", "nodemaven"] };
const chain = ["smartproxy", "nodemaven"] as const;

function attemptRequest(attempt: number, now = Date.now()): ProxyAttemptRequest {
	return {
		policy,
		chain,
		attempt,
		attemptCap: chain.length * PROXY_ATTEMPTS_PER_VENDOR,
		now,
	};
}

function asAdaptive(selector: ProxyVendorSelector): AdaptiveProxyVendorSelector {
	if (!("kind" in selector) || selector.kind !== "adaptive") {
		throw new Error("expected the adaptive selector");
	}
	return selector as AdaptiveProxyVendorSelector;
}

/** Open smartproxy the way five tunnels that never opened would. */
function openSmartproxy(selector: ProxyVendorSelector, now: number): void {
	for (let index = 0; index < 5; index += 1) {
		selector.report({
			vendor: "smartproxy",
			phase: "transport",
			outcome: "error",
			errorCode: "proxy_connect_failed",
			now,
		});
	}
}

afterEach(() => {
	setProxyVendorSelector(undefined);
});

describe("process proxy vendor selector installation", () => {
	it("installs the adaptive selector by default and restores the static order on release", () => {
		const installed = installProcessProxyVendorSelector({ env: {} });
		expect(installed.mode).toBe("adaptive");
		expect(getProxyVendorSelector()).toBe(installed.selector);
		expect(asAdaptive(installed.selector).kind).toBe("adaptive");

		installed.release();
		installed.release();
		expect(getProxyVendorSelector()).toBe(staticOrderProxyVendorSelector);
	});

	it("keeps the static order when the environment says ordered", () => {
		const installed = installProcessProxyVendorSelector({
			env: { [PROXY_VENDOR_SELECTION_ENV]: " Ordered " },
		});
		expect(installed.mode).toBe("ordered");
		expect(installed.selector).toBe(staticOrderProxyVendorSelector);
		expect(getProxyVendorSelector()).toBe(staticOrderProxyVendorSelector);
		installed.release();
		expect(getProxyVendorSelector()).toBe(staticOrderProxyVendorSelector);
	});

	it("falls back to the adaptive default for an unrecognised value", () => {
		const installed = installProcessProxyVendorSelector({
			env: { [PROXY_VENDOR_SELECTION_ENV]: "weighted" },
		});
		expect(installed.mode).toBe("adaptive");
		expect(asAdaptive(getProxyVendorSelector()).kind).toBe("adaptive");
		installed.release();
	});

	it("never replaces a selector the host registered", () => {
		const hostSelector: ProxyVendorSelector = {
			select: (request) => staticOrderProxyVendorSelector.select(request),
			report: () => {},
		};
		setProxyVendorSelector(hostSelector);
		const installed = installProcessProxyVendorSelector({ env: {} });
		expect(installed.selector).toBe(hostSelector);
		installed.release();
		expect(getProxyVendorSelector()).toBe(hostSelector);
	});

	it("shares one selector across servers, logs transitions to each and keeps it until the last release", () => {
		const first: ProxyVendorStateTransition[] = [];
		const second: ProxyVendorStateTransition[] = [];
		const a = installProcessProxyVendorSelector({
			env: {},
			onTransition: (event) => first.push(event),
		});
		const b = installProcessProxyVendorSelector({
			env: {},
			onTransition: (event) => second.push(event),
		});
		expect(b.selector).toBe(a.selector);

		openSmartproxy(a.selector, 1_000);
		expect(first.map((event) => [event.vendor, event.from, event.to, event.reason])).toEqual([
			["smartproxy", "closed", "open", "failure_threshold"],
		]);
		expect(second).toEqual(first);

		a.release();
		expect(getProxyVendorSelector()).toBe(b.selector);
		// The released server no longer receives transitions.
		asAdaptive(b.selector).snapshot(1_000 + 30_000);
		expect(first).toHaveLength(1);
		expect(second.map((event) => event.reason)).toEqual(["failure_threshold", "open_elapsed"]);

		b.release();
		expect(getProxyVendorSelector()).toBe(staticOrderProxyVendorSelector);
	});
});

describe("proxy vendor selection telemetry", () => {
	it("routes each selection to the request scope that made it", () => {
		const installed = installProcessProxyVendorSelector({ env: {} });
		const selector = installed.selector;
		const before: ProxyVendorSelectionObservation[] = [];
		const after: ProxyVendorSelectionObservation[] = [];
		const now = 5_000;

		observeProxyVendorSelections({ recordProxyVendorSelection: (o) => before.push(o) }, () =>
			selector.select(attemptRequest(0, now)),
		);
		openSmartproxy(selector, now);
		observeProxyVendorSelections({ recordProxyVendorSelection: (o) => after.push(o) }, () =>
			selector.select(attemptRequest(0, now)),
		);
		// Outside any scope the selection is not observed and nothing throws.
		expect(selector.select(attemptRequest(0, now))[0]?.vendor).toBe("nodemaven");

		expect(before).toEqual([
			{
				kind: "adaptive",
				reason: "chain_order",
				vendorStates: [
					{ vendor: "smartproxy", state: "closed", ejections: 0 },
					{ vendor: "nodemaven", state: "closed", ejections: 0 },
				],
			},
		]);
		expect(after).toEqual([
			{
				kind: "adaptive",
				reason: "vendor_open",
				vendorStates: [
					{ vendor: "smartproxy", state: "open", ejections: 1 },
					{ vendor: "nodemaven", state: "closed", ejections: 0 },
				],
			},
		]);
		installed.release();
	});

	it("never lets a throwing sink fail the selection", () => {
		const installed = installProcessProxyVendorSelector({ env: {} });
		const directives = observeProxyVendorSelections(
			{
				recordProxyVendorSelection: () => {
					throw new Error("sink failed");
				},
			},
			() => installed.selector.select(attemptRequest(0)),
		);
		expect(directives[0]?.vendor).toBe("smartproxy");
		installed.release();
	});

	it("adds the selection, the vendor states and each attempt's vendor to the proxy log and header", () => {
		const collector = new ProxyTelemetryCollector();
		collector.recordProxyResolution({
			provider: "nodemaven",
			protocol: "http",
			cacheStatus: "disabled",
			cacheHit: false,
			resolutionMs: 0,
			attempts: 1,
		});
		collector.recordProxyAttempt({
			provider: "nodemaven",
			attempt: 1,
			outcome: "ok",
			status: 200,
			durationMs: 912,
		});
		collector.recordProxyVendorSelection({
			kind: "adaptive",
			reason: "vendor_open",
			vendorStates: [
				{ vendor: "smartproxy", state: "open", ejections: 1 },
				{ vendor: "nodemaven", state: "closed", ejections: 0 },
			],
		});

		const log = collector.toLogPayload();
		expect(log).toEqual({
			kind: "resolved",
			provider: "nodemaven",
			protocol: "http",
			cacheStatus: "disabled",
			cacheHit: false,
			resolutionMs: 0,
			attempts: 1,
			attemptSamples: [{ n: 1, a: 1, v: "nodemaven", o: "ok", s: 200, d: 912 }],
			selection: { kind: "adaptive", reason: "vendor_open" },
			vendorStates: [
				{ v: "smartproxy", s: "open", e: 1 },
				{ v: "nodemaven", s: "closed", e: 0 },
			],
		});
		const header = collector.toHeaderValue();
		expect(header).toBeTruthy();
		const envelope = JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"));
		expect(envelope).toEqual({
			v: 1,
			taxonomy: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			proxy: log,
		});
		expect(isGatewayIngestible(envelope.proxy)).toBe(true);
	});
});

describe("served process", () => {
	const savedEnv = new Map<string, string | undefined>();
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		for (const [name, value] of savedEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		savedEnv.clear();
	});

	function setEnv(name: string, value: string | undefined): void {
		if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	function provider(): ProviderDefinition {
		return {
			id: "proxy-selection-provider",
			version: "1.0.0",
			runtime: "standard",
			meta: {
				displayName: "Proxy Selection Provider",
				descriptionKey: "providers.proxySelection.description",
				category: "test",
			},
			allowedHosts: ["example.com"],
			http: {},
			proxy: policy,
			operations: {
				fetchDirect: {
					riskClass: "read",
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					handler: async (ctx) =>
						(await ctx.http.get("https://example.com/direct")).data as {
							ok: boolean;
						},
				},
			},
		};
	}

	async function call(port: number, requestId: string): Promise<Response> {
		return await fetch(`http://127.0.0.1:${port}/v1/fetchDirect`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId, input: {} }),
		});
	}

	function proxyOf(events: ProviderServerLogEvent[], requestId: string): unknown {
		const completed = events.find(
			(event) => event.event === "provider_request_completed" && event.requestId === requestId,
		);
		return completed && "proxy" in completed ? completed.proxy : undefined;
	}

	it("runs the adaptive selector, logs its transitions, tags each request and restores the static order on close", async () => {
		// No vendor credentials: the optional policy resolves no proxy and the
		// request goes direct, so the selection is observed without any egress.
		for (const name of ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES) setEnv(name, undefined);
		setEnv(PROXY_VENDOR_SELECTION_ENV, undefined);
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				if (url.hostname === "example.com") {
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				return await originalFetch(input, init);
			},
			{ preconnect: () => {} },
		) as typeof fetch;

		const events: ProviderServerLogEvent[] = [];
		const handle = await serve(provider(), {
			port: 0,
			host: "127.0.0.1",
			logger: (event) => events.push(event),
			shutdown: { signals: false },
		});
		try {
			const selector = asAdaptive(getProxyVendorSelector());

			const cold = await call(handle.port, "req_cold");
			expect(cold.status).toBe(200);
			const coldProxy = proxyOf(events, "req_cold");
			expect(coldProxy).toMatchObject({
				kind: "unresolved",
				selection: { kind: "adaptive", reason: "chain_order" },
				vendorStates: [
					{ v: "smartproxy", s: "closed", e: 0 },
					{ v: "nodemaven", s: "closed", e: 0 },
				],
			});
			const coldHeader = JSON.parse(
				Buffer.from(cold.headers.get(PROVIDER_TELEMETRY_HEADER) ?? "", "base64url").toString(
					"utf8",
				),
			);
			expect(coldHeader.proxy).toEqual(coldProxy);

			const openedAt = Date.now();
			openSmartproxy(selector, openedAt);
			const transition = events.find((event) => event.event === "proxy_vendor_state");
			expect(transition).toEqual({
				level: "warn",
				event: "proxy_vendor_state",
				providerId: "proxy-selection-provider",
				vendor: "smartproxy",
				from: "closed",
				to: "open",
				reason: "failure_threshold",
				consecutiveFailures: 5,
				ejections: 1,
				openUntil: new Date(openedAt + 30_000).toISOString(),
				errorCode: "proxy_connect_failed",
			});

			const warm = await call(handle.port, "req_after_open");
			expect(warm.status).toBe(200);
			// nodemaven serves; the open smartproxy stays the last resolution fallback.
			expect(proxyOf(events, "req_after_open")).toMatchObject({
				kind: "unresolved",
				vendors: ["nodemaven", "smartproxy"],
				selection: { kind: "adaptive", reason: "vendor_open" },
				vendorStates: [
					{ v: "smartproxy", s: "open", e: 1 },
					{ v: "nodemaven", s: "closed", e: 0 },
				],
			});
		} finally {
			await handle.close();
		}
		expect(getProxyVendorSelector()).toBe(staticOrderProxyVendorSelector);
	});

	it("keeps the static order and adds no selection fields when the environment says ordered", async () => {
		for (const name of ENGINE_OWNED_PROXY_CREDENTIAL_ENV_NAMES) setEnv(name, undefined);
		setEnv(PROXY_VENDOR_SELECTION_ENV, "ordered");
		globalThis.fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				if (url.hostname === "example.com") {
					return new Response(JSON.stringify({ ok: true }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				return await originalFetch(input, init);
			},
			{ preconnect: () => {} },
		) as typeof fetch;

		const events: ProviderServerLogEvent[] = [];
		const handle = await serve(provider(), {
			port: 0,
			host: "127.0.0.1",
			logger: (event) => events.push(event),
			shutdown: { signals: false },
		});
		try {
			expect(getProxyVendorSelector()).toBe(staticOrderProxyVendorSelector);
			const response = await call(handle.port, "req_ordered");
			expect(response.status).toBe(200);
			const proxy = proxyOf(events, "req_ordered") as Record<string, unknown> | undefined;
			expect(proxy?.kind).toBe("unresolved");
			expect(proxy).not.toHaveProperty("selection");
			expect(proxy).not.toHaveProperty("vendorStates");
		} finally {
			await handle.close();
		}
	});
});
