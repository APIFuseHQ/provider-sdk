import { describe, expect, it, test } from "bun:test";
import { z } from "zod";

import { ValidationError } from "../errors.js";
import {
	formatNodemavenTtl,
	NODEMAVEN_ISP_SLUG_PATTERN,
	NODEMAVEN_TTL_SECONDS_MAX,
	NODEMAVEN_TTL_SECONDS_MIN,
} from "../runtime/proxy-nodemaven.js";
import { resolveOperationProxyConfig } from "../server/serve-implementation.js";
import type {
	OperationRiskClass,
	ProviderDefinition,
	ProviderProxyNodemavenOptions,
	ProviderProxyPolicy,
} from "../types.js";
import { defineTestProvider as defineProvider } from "./test-utils.js";

const READ_RISK_CLASS: OperationRiskClass = "read";
const InputSchema = z.object({ id: z.string() });
const OutputSchema = z.object({ name: z.string() });

function operation() {
	return {
		riskClass: READ_RISK_CLASS,
		input: InputSchema,
		output: OutputSchema,
		handler: async (_ctx: unknown, input: unknown) => ({ name: InputSchema.parse(input).id }),
		fixtures: { request: { id: "a" }, response: { name: "a" } },
		healthCheckUnsupported: { reason: "test fixture" },
	};
}

const baseConfig = {
	id: "nol-like",
	version: "1.0.0",
	runtime: "standard" as const,
	meta: {
		displayName: "NOL-like stays",
		descriptionKey: "meta.description",
		category: "travel",
		tags: ["stays"],
	},
	operations: {
		"search-stays": operation(),
		"get-stay-detail": operation(),
		"list-room-rate-plans": operation(),
	},
};

const KR_MOBILE_DETAIL_ONLY: ProviderProxyPolicy = {
	mode: "required",
	providers: ["nodemaven"],
	geo: { country: "KR" },
	nodemaven: { type: "mobile", isp: ["sk_telecom", "lg_uplus"] },
	operations: ["get-stay-detail", "list-room-rate-plans"],
};

describe("proxy policy: operation scope and nodemaven options (contract)", () => {
	it("accepts a provider-level policy scoped to declared operations with nodemaven mobile tokens", () => {
		const provider = defineProvider({ ...baseConfig, proxy: KR_MOBILE_DETAIL_ONLY });
		expect(provider.proxy).toEqual(KR_MOBILE_DETAIL_ONLY);
	});

	it("rejects an operation id that is not a declared operation", () => {
		expect(() =>
			defineProvider({
				...baseConfig,
				proxy: { ...KR_MOBILE_DETAIL_ONLY, operations: ["get-stay-detail", "missing-op"] },
			}),
		).toThrow(/proxy\.operations.*"missing-op".*not a declared operation/);
	});

	it("rejects an empty or duplicated operations list", () => {
		expect(() =>
			defineProvider({ ...baseConfig, proxy: { ...KR_MOBILE_DETAIL_ONLY, operations: [] } }),
		).toThrow(ValidationError);
		expect(() =>
			defineProvider({
				...baseConfig,
				proxy: { ...KR_MOBILE_DETAIL_ONLY, operations: ["get-stay-detail", "get-stay-detail"] },
			}),
		).toThrow(/proxy\.operations.*duplicate/);
	});

	it("rejects the nodemaven block when nodemaven is not in the vendor chain", () => {
		expect(() =>
			defineProvider({
				...baseConfig,
				proxy: { mode: "required", providers: ["smartproxy"], nodemaven: { type: "mobile" } },
			}),
		).toThrow(/proxy\.nodemaven.*requires "nodemaven" in proxy\.providers/);
	});

	it("rejects unknown nodemaven fields, bad connection types, bad carrier slugs and out-of-range ttl", () => {
		const withNodemaven = (nodemaven: ProviderProxyNodemavenOptions) =>
			defineProvider({
				...baseConfig,
				proxy: { mode: "required", providers: ["nodemaven"], nodemaven },
			});
		expect(() =>
			// @ts-expect-error test-invalid: an unknown nodemaven field is rejected at runtime as well as by the type.
			withNodemaven({ carrier: "kt" }),
		).toThrow(/unknown field.*carrier/i);
		expect(() =>
			// @ts-expect-error test-invalid: an unknown connection type is rejected at runtime as well as by the type.
			withNodemaven({ type: "cellular" }),
		).toThrow(/proxy\.nodemaven\.type/);
		expect(() => withNodemaven({ isp: ["SK Telecom"] })).toThrow(/proxy\.nodemaven\.isp/);
		expect(() => withNodemaven({ isp: [] })).toThrow(/proxy\.nodemaven\.isp/);
		expect(() => withNodemaven({ ttlSeconds: 30 })).toThrow(/proxy\.nodemaven\.ttlSeconds/);
		expect(() => withNodemaven({ ttlSeconds: 90_000 })).toThrow(/proxy\.nodemaven\.ttlSeconds/);
		expect(() => withNodemaven({ ttlSeconds: 90.5 })).toThrow(/proxy\.nodemaven\.ttlSeconds/);
		expect(() =>
			withNodemaven({ type: "mobile", isp: ["sk_telecom", "lg_uplus", "kt"], ttlSeconds: 500 }),
		).not.toThrow();
	});

	it("keeps today's policies valid without the new fields", () => {
		expect(() =>
			defineProvider({
				...baseConfig,
				proxy: {
					mode: "required",
					providers: ["smartproxy", "nodemaven"],
					geo: { country: "KR" },
					session: { affinity: "connection", lifetimeMinutes: 120, poolSize: 6 },
				},
			}),
		).not.toThrow();
	});
});

describe("resolveOperationProxyConfig", () => {
	const definition = (proxy: ProviderDefinition["proxy"]) => ({ proxy });

	it("applies an unscoped policy to every operation", () => {
		const policy: ProviderProxyPolicy = { mode: "required", providers: ["nodemaven"] };
		expect(resolveOperationProxyConfig(definition(policy), "search-stays")).toBe(policy);
		expect(resolveOperationProxyConfig(definition(true), "search-stays")).toBe(true);
		expect(resolveOperationProxyConfig(definition(undefined), "search-stays")).toBeUndefined();
	});

	it("applies a scoped policy only to the listed operations", () => {
		const provider = definition(KR_MOBILE_DETAIL_ONLY);
		expect(resolveOperationProxyConfig(provider, "get-stay-detail")).toBe(KR_MOBILE_DETAIL_ONLY);
		expect(resolveOperationProxyConfig(provider, "list-room-rate-plans")).toBe(
			KR_MOBILE_DETAIL_ONLY,
		);
		expect(resolveOperationProxyConfig(provider, "search-stays")).toBeUndefined();
	});
});

describe("nodemaven token helpers", () => {
	it("accepts the measured KR carrier slugs and refuses spaces and uppercase", () => {
		for (const slug of ["sk_telecom", "lg_uplus", "kt"]) {
			expect(NODEMAVEN_ISP_SLUG_PATTERN.test(slug)).toBe(true);
		}
		for (const slug of ["SK Telecom", "lg-uplus", "", "LGU+"]) {
			expect(NODEMAVEN_ISP_SLUG_PATTERN.test(slug)).toBe(false);
		}
	});

	it("formats the sticky ttl as XmYs within the documented bounds", () => {
		expect(formatNodemavenTtl(500)).toBe("8m20s");
		expect(formatNodemavenTtl(NODEMAVEN_TTL_SECONDS_MIN)).toBe("1m0s");
		expect(formatNodemavenTtl(NODEMAVEN_TTL_SECONDS_MAX)).toBe("1440m0s");
	});
});

// Implementation-lane assertions this contract commits to (same branch, next change).
describe("nodemaven mobile egress: implementation-lane assertions", () => {
	test.todo("synthesizeNodemavenProxy encodes <user>-country-kr-isp-sk_telecom-type-mobile-ipv4-true-sid-<sid> for { type: mobile, isp: [sk_telecom] } with no -filter- token", () => {});
	test.todo("synthesizeNodemavenProxy picks isp[poolIndex % isp.length] so proxyAttemptOffset 1 moves to the next carrier", () => {});
	test.todo("synthesizeNodemavenProxy keeps today's residential token set (country, region, city, ipv4-true, sid, filter) and sid derivation; only -ipv4-true moves ahead of -sid-", () => {});
	test.todo("synthesizeNodemavenProxy encodes -ttl-8m20s for ttlSeconds 500 on sticky policies", () => {});
	test.todo("createProviderContext passes the scoped policy to ctx.stealth/ctx.http/resolver only for listed operations; unlisted operations and auth flows resolve no proxy", () => {});
	test.todo("operational assembly: real serve() provider with proxy.operations and a local CONNECT proxy double records the mobile username for the listed operation and sees no CONNECT for the unlisted one", () => {});
});
