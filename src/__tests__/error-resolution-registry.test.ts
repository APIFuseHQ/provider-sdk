import { describe, expect, it } from "bun:test";

import {
	resolveProviderErrorContract,
	SDK_ERROR_REGISTRY,
	SDK_ERROR_REGISTRY_BY_CODE,
	SDK_RUNTIME_OWNED_ERROR_CODES,
	SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES,
} from "../error-resolution.js";
import { isRetryableCategory } from "../observability.js";

const FLEET_CONSENSUS_CODES = [
	"UPSTREAM_AUTH_ERROR",
	"UPSTREAM_SCHEMA_ERROR",
	"INVALID_REQUEST",
] as const;

describe("SDK error registry", () => {
	it("maps each consensus code to its canonical status", () => {
		expect(SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.get("UPSTREAM_AUTH_ERROR")).toBe(400);
		expect(SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.get("UPSTREAM_SCHEMA_ERROR")).toBe(502);
		expect(SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.get("INVALID_REQUEST")).toBe(400);
	});

	it("keeps the consensus codes out of the runtime-owned set", () => {
		// Load-bearing: these codes are thrown by provider code, so a legacy
		// errorCodes declaration must keep winning at serve time; moving them
		// into the runtime-owned set would silently rewrite the status of every
		// provider that already declares one.
		for (const code of FLEET_CONSENSUS_CODES) {
			expect(SDK_RUNTIME_OWNED_ERROR_CODES.has(code)).toBe(false);
		}
	});

	it("does not register the minority spellings", () => {
		for (const code of ["UPSTREAM_SCHEMA_CHANGED", "INVALID_INPUT", "VALIDATION_ERROR"]) {
			expect(SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.has(code)).toBe(false);
			expect(SDK_ERROR_REGISTRY_BY_CODE.has(code)).toBe(false);
		}
	});

	it("feeds every registry row into the status map", () => {
		for (const [code, registration] of SDK_ERROR_REGISTRY_BY_CODE) {
			expect({ code, status: SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.get(code) }).toEqual({
				code,
				status: registration.status,
			});
		}
	});

	it("declares every consensus code non-retryable", () => {
		for (const code of FLEET_CONSENSUS_CODES) {
			expect(SDK_ERROR_REGISTRY[code].retryable).toBe(false);
		}
	});

	it("states retryability per row, with the category as the default and the exceptions named", () => {
		const exceptions = new Map<string, boolean>([
			["NOT_FOUND", false],
			["not_found", false],
			["NO_DATA", false],
		]);
		for (const [code, registration] of SDK_ERROR_REGISTRY_BY_CODE) {
			expect({ code, retryable: registration.retryable }).toEqual({
				code,
				retryable: exceptions.get(code) ?? isRetryableCategory(registration.category),
			});
		}
	});
});

describe("resolveProviderErrorContract", () => {
	it("lets the contract an SDK-constructed error carries win over a declaration and the registry", () => {
		// SDK-owned failures (transport, session expiry, output validation) state
		// their category and retryability where the SDK throws them; nothing a
		// provider declares describes them.
		expect(
			resolveProviderErrorContract({
				code: "UPSTREAM_ERROR",
				declaration: { status: 502, retryable: true },
				sdkContract: { retryable: false, category: "provider_error" },
			}),
		).toEqual({ status: 502, category: "provider_error", retryable: false });
	});

	it("answers from the declaration alone for a provider throw: there is no per-throw contract", () => {
		expect(
			resolveProviderErrorContract({
				code: "UPSTREAM_ERROR",
				declaration: { status: 502, retryable: false },
				sdkContract: {},
			}),
		).toEqual({ status: 502, category: "upstream_http", retryable: false });
	});

	it("answers from the declaration when the throw carries no per-throw option", () => {
		expect(
			resolveProviderErrorContract({
				code: "UPSTREAM_ERROR",
				declaration: { status: 502, category: "upstream_http", retryable: false },
				sdkContract: {},
			}),
		).toEqual({ status: 502, category: "upstream_http", retryable: false });
	});

	it("falls back to the SDK contract when the declaration is silent on a field", () => {
		expect(
			resolveProviderErrorContract({
				code: "SHOP_CLOSED",
				declaration: { status: 502 },
				sdkContract: { retryable: true, category: "upstream_rejected" },
			}),
		).toEqual({ status: 502, category: "upstream_rejected", retryable: true });
	});

	it("classes a declared rejection status as upstream_rejected ahead of the registry", () => {
		expect(
			resolveProviderErrorContract({
				code: "UPSTREAM_SCHEMA_ERROR",
				declaration: { status: 422 },
				sdkContract: {},
			}),
		).toEqual({ status: 422, category: "upstream_rejected", retryable: false });
	});

	it("answers from the registry when nothing declares the code", () => {
		expect(
			resolveProviderErrorContract({
				code: "RATE_LIMITED",
				declaration: undefined,
				sdkContract: {},
			}),
		).toEqual({ status: 429, category: "upstream_rate_limited", retryable: true });
	});

	it("leaves every field undefined for an unknown, undeclared code", () => {
		expect(
			resolveProviderErrorContract({
				code: "SOMETHING",
				declaration: undefined,
				sdkContract: {},
			}),
		).toEqual({ status: undefined, category: undefined, retryable: undefined });
	});
});
