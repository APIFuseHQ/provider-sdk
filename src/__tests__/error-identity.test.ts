import { describe, expect, it } from "bun:test";

// Namespace import so a missing guard surfaces as a focused per-test failure
// rather than aborting the whole module during the RED phase.
import * as SDK from "../errors";

// A query-qualified specifier forces Bun to evaluate errors.ts a second time,
// producing a genuinely separate module identity (distinct constructors) that
// models the packaged src/* vs dist/* entrypoint split proven in
// /tmp/provider-sdk-surgical-error-identity-research.md.
const duplicateSdk = import("../errors.ts?duplicate-sdk-instance") as Promise<
	typeof import("../errors")
>;

// Must match the versioned brand key defined in src/errors.ts.
const PROVIDER_ERROR_BRAND_KEY = "@apifuse/provider-sdk/error-brand@1";

describe("cross-module ProviderError brand guards", () => {
	it("recognizes a ProviderError created by a duplicate SDK module instance", async () => {
		const Dup = await duplicateSdk;
		expect(Dup.ProviderError).not.toBe(SDK.ProviderError);

		const err = new Dup.ProviderError("Missing provider service key", {
			code: "CONFIGURATION_ERROR",
			fix: "Set the provider service key.",
		});

		// instanceof splits across the duplicate module identity ...
		expect(err instanceof SDK.ProviderError).toBe(false);
		// ... but the branded guard recognizes it.
		expect(SDK.isProviderError(err)).toBe(true);
		expect(SDK.isSessionExpiredError(err)).toBe(false);
		expect(SDK.isTransportError(err)).toBe(false);
	});

	it("recognizes a SessionExpiredError created by a duplicate SDK module instance", async () => {
		const Dup = await duplicateSdk;
		const err = new Dup.SessionExpiredError();

		expect(err instanceof SDK.SessionExpiredError).toBe(false);
		expect(SDK.isProviderError(err)).toBe(true);
		expect(SDK.isSessionExpiredError(err)).toBe(true);
		expect(SDK.isTransportError(err)).toBe(false);
	});

	it("recognizes a TransportError created by a duplicate SDK module instance", async () => {
		const Dup = await duplicateSdk;
		const err = new Dup.TransportError("Request timed out", {
			code: "transport_timeout",
		});

		expect(err instanceof SDK.TransportError).toBe(false);
		expect(SDK.isProviderError(err)).toBe(true);
		expect(SDK.isTransportError(err)).toBe(true);
		expect(SDK.isSessionExpiredError(err)).toBe(false);
	});

	it("does not accept an unbranded name-only lookalike", () => {
		const lookalike = {
			name: "ProviderError",
			message: "Missing provider service key",
			code: "CONFIGURATION_ERROR",
			options: { code: "CONFIGURATION_ERROR" },
		};

		expect(SDK.isProviderError(lookalike)).toBe(false);
		expect(SDK.isSessionExpiredError(lookalike)).toBe(false);
		expect(SDK.isTransportError(lookalike)).toBe(false);
	});

	it("rejects an accessor-defined brand without invoking the getter", () => {
		let reads = 0;
		const hostile: Record<string | symbol, unknown> = {};
		Object.defineProperty(hostile, Symbol.for(PROVIDER_ERROR_BRAND_KEY), {
			enumerable: false,
			configurable: true,
			get() {
				reads += 1;
				return true;
			},
		});

		expect(SDK.isProviderError(hostile)).toBe(false);
		expect(reads).toBe(0);
	});

	it("rejects an inherited brand that is not an own property", () => {
		const branded = new SDK.ProviderError("real", { code: "X" });
		const descendant = Object.create(branded);
		expect(SDK.isProviderError(branded)).toBe(true);
		expect(SDK.isProviderError(descendant)).toBe(false);
	});
});
