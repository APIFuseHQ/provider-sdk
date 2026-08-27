import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { defineProvider } from "../define.js";
import factoredProvider from "./fixtures/capability-factored-provider.js";

const meta = {
	displayName: "Capability Context",
	descriptionKey: "capability-context.description",
	category: "test",
};

const operationSchemas = {
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	healthCheckUnsupported: { reason: "type fixture" },
};

describe("declaration-derived provider contexts", () => {
	it("contextually types inline handlers from the first phase", () => {
		const provider = defineProvider({
			id: "capability-inline",
			version: "1.0.0",
			runtime: "standard",
			http: true,
			meta,
		})({
			operations: {
				probe: {
					...operationSchemas,
					async handler(ctx) {
						void ctx.http;
						// @ts-expect-error test-invalid: http is declared, but cache is not.
						void ctx.cache;
						return { ok: true };
					},
				},
			},
		});

		expect(provider.id).toBe("capability-inline");
	});

	it("keeps only ambient members for a provider declaring no capabilities", () => {
		const provider = defineProvider({
			id: "capability-ambient",
			version: "1.0.0",
			runtime: "standard",
			meta,
		})({
			operations: {
				probe: {
					...operationSchemas,
					async handler(ctx) {
						void ctx.trace;
						void ctx.request?.headers;
						// @ts-expect-error test-invalid: native is not declared.
						void ctx.native;
						return { ok: true };
					},
				},
			},
		});

		expect(provider.id).toBe("capability-ambient");
	});

	it("exposes native directly when declared on a capable runtime", () => {
		const provider = defineProvider({
			id: "capability-native",
			version: "1.0.0",
			runtime: "standard",
			native: {},
			meta,
		})({
			operations: {
				probe: {
					...operationSchemas,
					async handler(ctx) {
						void ctx.native.network;
						return { ok: true };
					},
				},
			},
		});

		expect(provider.native).toEqual({});
	});

	it("composes a separately authored context-bound operation", () => {
		expect(factoredProvider.operations.factored).toBeDefined();
	});

	it("rejects misspelled and invented declaration capabilities", () => {
		defineProvider({
			id: "capability-typo",
			version: "1.0.0",
			runtime: "standard",
			meta,
			// @ts-expect-error test-invalid: misspelled capabilities are rejected in phase one.
			htpp: true,
		});
		defineProvider({
			id: "capability-invented",
			version: "1.0.0",
			runtime: "standard",
			meta,
			// @ts-expect-error test-invalid: invented capabilities are rejected in phase one.
			teleport: true,
		});
	});
});
