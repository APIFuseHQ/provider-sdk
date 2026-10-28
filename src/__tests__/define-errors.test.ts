import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { extractProviderContract } from "../contract.js";
import {
	defineErrors,
	isProviderErrorFactory,
	type ProviderErrorFactory,
	providerErrorDeclaration,
	sdkErrors,
	validateProviderErrorLocaleKeys,
} from "../define-errors.js";
import { defineOperation, defineProvider } from "../define.js";
import { isProviderError, ProviderError, ValidationError } from "../errors.js";
import {
	createServerApp,
	ERROR_OBSERVABILITY_HEADER,
	type ProviderServerLogEvent,
} from "../server/serve.js";
import type { OperationRiskClass, ProviderDefinition } from "../types.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

const READ_RISK_CLASS: OperationRiskClass = "read";

const errors = defineErrors({
	UPSTREAM_SCHEMA_ERROR: sdkErrors.UPSTREAM_SCHEMA_ERROR,
	RATE_LIMITED: sdkErrors.RATE_LIMITED,
	ITEM_NOT_FOUND: {
		status: 404,
		category: "upstream_rejected",
		description: "The shop has no item with this id.",
		messageKey: "errors.itemNotFound.message",
	},
	SHOP_UNAVAILABLE: {
		status: 502,
		category: "upstream_http",
		description: "The shop answered with a server failure.",
	},
	SHOP_CLOSED: {
		status: 502,
		category: "upstream_http",
		retryable: false,
		description: "The shop is closed for the season.",
	},
});

describe("defineErrors", () => {
	it("returns one factory per code carrying the resolved declaration", () => {
		expect(Object.keys(errors).sort()).toEqual(
			[
				"ITEM_NOT_FOUND",
				"RATE_LIMITED",
				"SHOP_CLOSED",
				"SHOP_UNAVAILABLE",
				"UPSTREAM_SCHEMA_ERROR",
			].sort(),
		);
		expect(errors.ITEM_NOT_FOUND.code).toBe("ITEM_NOT_FOUND");
		expect(errors.ITEM_NOT_FOUND.declaration).toEqual({
			code: "ITEM_NOT_FOUND",
			status: 404,
			category: "upstream_rejected",
			retryable: false,
			description: "The shop has no item with this id.",
			messageKey: "errors.itemNotFound.message",
		});
		expect(isProviderErrorFactory(errors.ITEM_NOT_FOUND)).toBe(true);
		expect(isProviderErrorFactory(() => undefined)).toBe(false);
	});

	it("derives retryable from the category unless the declaration states it", () => {
		expect(errors.SHOP_UNAVAILABLE.declaration.retryable).toBe(true);
		expect(errors.SHOP_CLOSED.declaration.retryable).toBe(false);
		expect(errors.ITEM_NOT_FOUND.declaration.retryable).toBe(false);
	});

	it("takes status, category, retryable and description from the SDK for a registered code", () => {
		expect(errors.UPSTREAM_SCHEMA_ERROR.declaration).toEqual({
			code: "UPSTREAM_SCHEMA_ERROR",
			status: 502,
			category: "upstream_schema_drift",
			retryable: false,
			description: sdkErrors.UPSTREAM_SCHEMA_ERROR.description,
		});
		expect(errors.RATE_LIMITED.declaration.retryable).toBe(true);
	});

	it("builds a ProviderError with the code, the declared keys and the throw's own fields", () => {
		const cause = new Error("socket closed");
		const error = errors.ITEM_NOT_FOUND({ details: { itemId: "x1" }, cause, params: { id: "x1" } });

		expect(error).toBeInstanceOf(ProviderError);
		expect(isProviderError(error)).toBe(true);
		expect(error.code).toBe("ITEM_NOT_FOUND");
		expect(error.message).toBe("The shop has no item with this id.");
		expect(error.details).toEqual({ itemId: "x1" });
		expect(error.cause).toBe(cause);
		expect(error.options).toEqual({
			code: "ITEM_NOT_FOUND",
			messageKey: "errors.itemNotFound.message",
			details: { itemId: "x1" },
			cause,
			params: { id: "x1" },
		});
		expect(providerErrorDeclaration(error)).toBe(errors.ITEM_NOT_FOUND.declaration);
		expect(providerErrorDeclaration(new ProviderError("plain", { code: "ITEM_NOT_FOUND" }))).toBe(
			undefined,
		);
	});

	it("lets a throw override the English message and fix without touching the contract", () => {
		const error = errors.SHOP_CLOSED({
			message: "Closed until March.",
			fix: "Try again in spring.",
		});

		expect(error.message).toBe("Closed until March.");
		expect(error.fix).toBe("Try again in spring.");
		expect(providerErrorDeclaration(error)?.retryable).toBe(false);
	});

	it("types the code of a factory-made error as its literal", () => {
		const error = errors.ITEM_NOT_FOUND();
		const code: "ITEM_NOT_FOUND" | undefined = error.code;
		expect(code).toBe("ITEM_NOT_FOUND");

		function throwsEither(flag: boolean): ProviderError<"ITEM_NOT_FOUND" | "SHOP_CLOSED"> {
			return flag ? errors.ITEM_NOT_FOUND() : errors.SHOP_CLOSED();
		}
		expect(throwsEither(false).code).toBe("SHOP_CLOSED");
	});

	it("rejects restating or overriding an SDK-registered code at the type level", () => {
		const probes = {
			restated: () =>
				defineErrors({
					// @ts-expect-error test-invalid: a registered code must be its sdkErrors reference
					UPSTREAM_ERROR: { status: 502, category: "upstream_http", description: "x" },
				}),
			overridden: () =>
				defineErrors({
					// @ts-expect-error test-invalid: the registry's retryable is literal; overriding it is a type error
					UPSTREAM_ERROR: { ...sdkErrors.UPSTREAM_ERROR, retryable: false },
				}),
			uncategorized: () =>
				defineErrors({
					// @ts-expect-error test-invalid: a provider declaration needs a category
					ITEM_GONE: { status: 404, description: "x" },
				}),
		};
		expect(Object.keys(probes)).toHaveLength(3);
	});

	it("accepts factories from another map, keyed by their own code", () => {
		const common = defineErrors({ BLOCKED: sdkErrors.BLOCKED });
		const composed = defineErrors({
			...common,
			...errors,
			SHOP_GONE: { status: 410, category: "upstream_rejected", description: "Gone." },
		});

		expect(composed.BLOCKED.declaration).toBe(common.BLOCKED.declaration);
		expect(composed.ITEM_NOT_FOUND.declaration).toBe(errors.ITEM_NOT_FOUND.declaration);
		expect(composed.SHOP_GONE.declaration.status).toBe(410);
		expect(() =>
			defineErrors({
				GONE: errors.ITEM_NOT_FOUND as never /* test-invalid: the type rejects this; the runtime check is under test */,
			}),
		).toThrow(/"GONE" is assigned the factory for "ITEM_NOT_FOUND"/);
	});

	it("rejects an SDK-registered code redeclared by the provider at runtime", () => {
		expect(() =>
			defineErrors({
				UPSTREAM_ERROR: {
					status: 502,
					category: "upstream_http",
					description: "x",
				} as never, // test-invalid: the type rejects this; the runtime check is under test
			}),
		).toThrow(/"UPSTREAM_ERROR" is an SDK-registered code and cannot be redeclared/);
	});

	it("rejects an sdkErrors reference keyed under another code", () => {
		expect(() =>
			defineErrors({
				GONE: sdkErrors.NO_DATA as never /* test-invalid: the type rejects this; the runtime check is under test */,
			}),
		).toThrow(/"GONE" is assigned sdkErrors\.NO_DATA/);
	});

	it("rejects an SDK-runtime code declared by the provider", () => {
		expect(() =>
			defineErrors({
				MISSING_SECRET: { status: 400, category: "credential_unavailable", description: "x" },
			}),
		).toThrow(/"MISSING_SECRET" is owned by the SDK runtime/);
	});

	it("rejects an invalid status, category, retryable, description or locale key", () => {
		const base = { status: 404, category: "upstream_rejected", description: "x" } as const;
		expect(() =>
			defineErrors({
				A: {
					...base,
					status:
						418 as never /* test-invalid: the type rejects this; the runtime check is under test */,
				},
			}),
		).toThrow(/"A" has invalid status 418/);
		expect(() =>
			defineErrors({
				A: {
					...base,
					category:
						"nope" as never /* test-invalid: the type rejects this; the runtime check is under test */,
				},
			}),
		).toThrow(/"A" has invalid category nope/);
		expect(() =>
			defineErrors({
				A: {
					...base,
					retryable:
						"yes" as never /* test-invalid: the type rejects this; the runtime check is under test */,
				},
			}),
		).toThrow(/"A" has non-boolean retryable yes/);
		expect(() => defineErrors({ A: { ...base, description: " " } })).toThrow(
			/"A" has no description/,
		);
		expect(() => defineErrors({ A: { ...base, messageKey: "errors..bad" } })).toThrow(
			/"A" has a malformed messageKey "errors\.\.bad"/,
		);
		expect(() => defineErrors({ A: base })).not.toThrow();
		let thrown: unknown;
		try {
			defineErrors({
				A: {
					...base,
					status:
						418 as never /* test-invalid: the type rejects this; the runtime check is under test */,
				},
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ValidationError);
		expect((thrown as ValidationError).code).toBe("ERROR_DECLARATION_INVALID");
	});
});

describe("validateProviderErrorLocaleKeys", () => {
	const operations = {
		lookup: { errors: [errors.ITEM_NOT_FOUND, errors.SHOP_CLOSED] },
		list: { errors: [errors.ITEM_NOT_FOUND] },
	};

	it("passes when every declared key resolves to non-empty text in en", () => {
		expect(
			validateProviderErrorLocaleKeys({
				operations,
				catalog: { errors: { itemNotFound: { message: "No such item." } } },
			}),
		).toEqual([]);
	});

	it("reports each missing or empty key once, naming the code and the derived fallback", () => {
		const problems = validateProviderErrorLocaleKeys({
			operations,
			catalog: { errors: { itemNotFound: { message: "  " } } },
		});

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('errors.ITEM_NOT_FOUND.messageKey "errors.itemNotFound.message"');
		expect(problems[0]).toContain('"errors.ITEM_NOT_FOUND.message"');
	});
});

describe("defineOperation errors", () => {
	function provider(errorsList: readonly ProviderErrorFactory[], errorCodes?: unknown) {
		return defineProvider({
			id: "shop",
			version: "1.0.0",
			runtime: "standard",
			allowedHosts: ["shop.example"],
			reviewed: "community",
			auth: { mode: "none" },
			meta: {
				displayName: "Shop",
				descriptionKey: "meta.description",
				category: "test",
			},
		})({
			operations: {
				lookup: defineOperation()({
					connectionMode: "none",
					riskClass: READ_RISK_CLASS,
					descriptionKey: "operations.lookup.description",
					input: z.object({ id: z.string() }),
					output: z.object({ ok: z.boolean() }),
					errors: errorsList,
					...(errorCodes === undefined
						? {}
						: {
								errorCodes:
									errorCodes as never /* test-invalid: the type rejects this; the runtime check is under test */,
							}),
					healthCheckUnsupported: { reason: "test double" },
					handler: async () => ({ ok: true }),
				}),
			},
		});
	}

	it("publishes the declarations as contract errorCodes rows", () => {
		const contract = extractProviderContract(
			provider([errors.ITEM_NOT_FOUND, errors.UPSTREAM_SCHEMA_ERROR]),
		);

		expect(contract.operations[0]?.errorCodes).toEqual([
			{
				code: "ITEM_NOT_FOUND",
				status: 404,
				description: "The shop has no item with this id.",
				retryable: false,
				messageKey: "errors.itemNotFound.message",
			},
			{
				code: "UPSTREAM_SCHEMA_ERROR",
				status: 502,
				description: sdkErrors.UPSTREAM_SCHEMA_ERROR.description,
				retryable: false,
			},
		]);
	});

	it("rejects a non-factory entry and a duplicate code at defineProvider time", () => {
		expect(() =>
			provider([
				{
					code: "X",
				} as never /* test-invalid: a legacy row is not a factory; the runtime check is under test */,
			]),
		).toThrow(/operations\.lookup\.errors\[0\]: expected a defineErrors factory/);
		expect(() => provider([errors.ITEM_NOT_FOUND, errors.ITEM_NOT_FOUND])).toThrow(
			/errors\[1\]: error code "ITEM_NOT_FOUND" is listed twice/,
		);
		expect(() =>
			provider(
				[errors.ITEM_NOT_FOUND],
				[{ code: "ITEM_NOT_FOUND", status: 404, description: "dup" }],
			),
		).toThrow(/errorCodes\[0\]: error code "ITEM_NOT_FOUND" is also declared/);
	});
});

type Served = {
	status: number;
	body: { error: { code: string; retryable: boolean; source: string; message: string } };
	header: { category: string; retryable: boolean; taxonomyVersion: string };
	events: ProviderServerLogEvent[];
};

async function serve(
	createError: () => Error,
	operation: { errors?: readonly ProviderErrorFactory[]; errorCodes?: unknown } = {},
): Promise<Served> {
	const events: ProviderServerLogEvent[] = [];
	const definition: ProviderDefinition = createProviderDefinitionDouble({
		id: "define-errors-test",
		operations: {
			probe: {
				riskClass: READ_RISK_CLASS,
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				...(operation.errors ? { errors: operation.errors } : {}),
				...(operation.errorCodes
					? {
							errorCodes:
								operation.errorCodes as never /* test-invalid: the type rejects this; the runtime check is under test */,
						}
					: {}),
				handler: async () => {
					throw createError();
				},
			},
		},
	});
	const app = createServerApp(definition, { logger: (event) => events.push(event) });
	const response = await app.request("/v1/probe", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: "req_probe", input: { value: "x" } }),
	});
	return {
		status: response.status,
		body: (await response.json()) as Served["body"],
		header: JSON.parse(
			response.headers.get(ERROR_OBSERVABILITY_HEADER) ?? "null",
		) as Served["header"],
		events,
	};
}

describe("serving a factory-made error", () => {
	it("serves the declared status, category and retryability whether or not the operation lists it", async () => {
		for (const listed of [true, false]) {
			const served = await serve(
				() => errors.ITEM_NOT_FOUND({ details: { id: "x" } }),
				listed ? { errors: [errors.ITEM_NOT_FOUND] } : {},
			);

			expect({ listed, status: served.status, ...served.header }).toEqual({
				listed,
				status: 404,
				taxonomyVersion: expect.any(String),
				category: "upstream_rejected",
				retryable: false,
			});
			expect(served.body.error).toMatchObject({
				code: "ITEM_NOT_FOUND",
				retryable: false,
				source: "upstream_rule",
			});
		}
	});

	it("serves an SDK reference from the registry", async () => {
		const served = await serve(() => errors.RATE_LIMITED());

		expect(served.status).toBe(429);
		expect(served.header).toMatchObject({ category: "upstream_rate_limited", retryable: true });
		expect(served.body.error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
	});

	it("serves the declaration of an error thrown by an auth flow, which lists no operation", async () => {
		const authErrors = defineErrors({
			LOGIN_REFUSED: {
				status: 401,
				category: "upstream_auth",
				description: "The shop refused the login.",
			},
		});
		const definition: ProviderDefinition = {
			...createProviderDefinitionDouble({ id: "define-errors-auth-test", operations: {} }),
			auth: {
				mode: "credentials",
				flow: {
					start: async () => {
						throw authErrors.LOGIN_REFUSED({ details: { reason: "bad password" } });
					},
					continue: async (ctx) => ctx.auth.nextPoll(),
				},
			},
		};
		const app = createServerApp(definition, { logger: () => {} });
		const response = await app.request("/auth/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_auth",
				flowId: "flow_auth",
				connectionId: "af_con_1234567890123456789012",
				externalRef: "external-1",
				tenantId: "tenant-1",
				providerId: "define-errors-auth-test",
			}),
		});

		expect(response.status).toBe(401);
		expect(JSON.parse(response.headers.get(ERROR_OBSERVABILITY_HEADER) ?? "null")).toMatchObject({
			category: "upstream_auth",
			retryable: false,
		});
		expect(((await response.json()) as Served["body"]).error).toMatchObject({
			code: "LOGIN_REFUSED",
			retryable: false,
		});
	});

	it("never logs the deprecated-options warning for a factory-made error", async () => {
		const served = await serve(() => errors.SHOP_CLOSED());

		expect(served.events.map((event) => event.event)).not.toContain(
			"provider_error_options_deprecated",
		);
	});
});

describe("serving a legacy throw against a declaration", () => {
	it("keeps the per-throw retryable winning over the declaration, and warns once per code with both values", async () => {
		// A table row that says retryable: true (the fleet's UPSTREAM_ERROR
		// consensus) under a throw that says false for a deterministic refusal:
		// the server always served the throw site's value, and a bump keeps it.
		const legacyErrorCodes = [
			{
				code: "UPSTREAM_ERROR",
				status: 502,
				description: "Upstream HTTP failure.",
				retryable: true,
			},
		];
		const throwIt = () =>
			new ProviderError("TableCheck rejected the cancellation request.", {
				code: "UPSTREAM_ERROR",
				category: "upstream_http",
				retryable: false,
			});
		const first = await serve(throwIt, { errorCodes: legacyErrorCodes });
		const second = await serve(throwIt, { errorCodes: legacyErrorCodes });

		expect(first.status).toBe(502);
		expect(first.header).toMatchObject({ category: "upstream_http", retryable: false });
		expect(first.body.error.retryable).toBe(false);
		const warnings = [...first.events, ...second.events].filter(
			(event) => event.event === "provider_error_options_deprecated",
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({
			level: "warn",
			code: "UPSTREAM_ERROR",
			options: ["category", "retryable"],
			conflicts: [{ option: "retryable", thrown: false, declared: true }],
			fix: expect.stringContaining("Declare a distinct code for the non-retryable condition"),
		});
	});

	it("serves the declared retryable: false for a legacy throw that agrees with it, and warns without a conflict", async () => {
		// The buyee shape: the row says false and the helper's throw says false.
		const served = await serve(
			() =>
				new ProviderError("Buyee returned HTTP 404.", { code: "UPSTREAM_ERROR", retryable: false }),
			{
				errorCodes: [
					{
						code: "UPSTREAM_ERROR",
						status: 502,
						description: "Buyee returned a non-retryable upstream HTTP failure.",
						retryable: false,
					},
				],
			},
		);

		expect(served.status).toBe(502);
		expect(served.header).toMatchObject({ category: "upstream_http", retryable: false });
		expect(served.body.error.retryable).toBe(false);
		const warning = served.events.find(
			(event) => event.event === "provider_error_options_deprecated",
		);
		expect(warning).toMatchObject({ options: ["retryable"] });
		expect(warning).not.toHaveProperty("conflicts");
		expect(warning).toMatchObject({
			fix: expect.stringContaining(
				"defineErrors({ UPSTREAM_ERROR: { status, category, description } })",
			),
		});
	});

	it("honors a per-throw retryable when nothing declares the code", async () => {
		const served = await serve(
			() => new ProviderError("gone", { code: "SOMETHING_ELSE", retryable: true }),
		);

		expect(served.status).toBe(500);
		expect(served.header.retryable).toBe(true);
	});

	it("resolves a hand-thrown code from the listed defineErrors declaration", async () => {
		const served = await serve(() => new ProviderError("closed", { code: "SHOP_CLOSED" }), {
			errors: [errors.SHOP_CLOSED],
		});

		expect(served.status).toBe(502);
		expect(served.header).toMatchObject({ category: "upstream_http", retryable: false });
	});
});
