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
import {
	AuthError,
	isProviderError,
	ProviderError,
	ProviderSecretError,
	SDKError,
	SessionExpiredError,
	TransportError,
	ValidationError,
} from "../errors.js";
import { HandleError } from "../handle.js";
import {
	PROVIDER_ERROR_SOURCES,
	PROVIDER_FAILURE_CATEGORIES,
	type ProviderFailureCategory,
} from "../observability.js";
import { isPerThrowOptionsRetiredError } from "../sdk-error-contract.js";
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

	it("lets a throw carry its own messageKey / fixKey over the declaration's, on a provider code and an SDK reference alike", () => {
		const keyed = errors.ITEM_NOT_FOUND({
			messageKey: "errors.itemNotFound.byId.message",
			fixKey: "errors.itemNotFound.byId.fix",
		});
		expect(keyed.options).toEqual({
			code: "ITEM_NOT_FOUND",
			messageKey: "errors.itemNotFound.byId.message",
			fixKey: "errors.itemNotFound.byId.fix",
		});
		// The declaration (and so the contract) is untouched by a per-throw key.
		expect(providerErrorDeclaration(keyed)).toBe(errors.ITEM_NOT_FOUND.declaration);
		expect(errors.ITEM_NOT_FOUND.declaration.messageKey).toBe("errors.itemNotFound.message");
		expect(errors.ITEM_NOT_FOUND().options?.messageKey).toBe("errors.itemNotFound.message");
		// An sdkErrors row cannot declare a key; the throw still can.
		const sdk = errors.UPSTREAM_SCHEMA_ERROR({ messageKey: "errors.upstreamSchema.rows.message" });
		expect(sdk.options).toEqual({
			code: "UPSTREAM_SCHEMA_ERROR",
			messageKey: "errors.upstreamSchema.rows.message",
		});
		expect(providerErrorDeclaration(sdk)).toBe(errors.UPSTREAM_SCHEMA_ERROR.declaration);
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

	it("rejects restating or overriding an SDK-registered code, or a platform-fault category, at the type level", () => {
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
			platformWord: () =>
				defineErrors({
					// @ts-expect-error test-invalid: a declared category is a provider-failure category, never a platform fault
					ITEM_GONE: { status: 502, category: "internal_error", description: "x" },
				}),
		};
		expect(Object.keys(probes)).toHaveLength(4);
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

	it("rejects an invalid status, category (a platform-fault word included), retryable, description or locale key", () => {
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
					category:
						"client_cancelled" as never /* test-invalid: the type rejects this; the runtime check is under test */,
				},
			}),
		).toThrow(
			/"A" declares the platform-fault category client_cancelled, which only the SDK reports/,
		);
		expect(() =>
			defineErrors({ A: { ...base, category: "credential_unavailable" } }),
		).not.toThrow();
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
	body: {
		error: { code: string; retryable: boolean; source: string; message: string; fix?: string };
	};
	header: { origin: string; category: string; retryable: boolean; taxonomyVersion: string };
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
				origin: "provider",
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
});

describe("per-throw category / retryable options are refused", () => {
	function construct(options: Record<string, unknown>): unknown {
		try {
			// test-invalid: the options were removed from the type; the runtime refusal is under test.
			new ProviderError("TableCheck rejected the cancellation request.", options as never);
		} catch (error) {
			return error;
		}
		return undefined;
	}

	it("throws an SDK-issued platform fault at construction that names the code and the options", () => {
		const error = construct({
			code: "UPSTREAM_ERROR",
			category: "upstream_http",
			retryable: false,
		});
		expect(error).toBeInstanceOf(SDKError);
		expect(error).not.toBeInstanceOf(ValidationError);
		const refusal = error as SDKError;
		expect(refusal.code).toBe("PER_THROW_ERROR_OPTIONS_RETIRED");
		expect(refusal.message).toContain(
			'new ProviderError(..., { code: "UPSTREAM_ERROR", category, retryable }) sets category and retryable per throw',
		);
		expect(refusal.details).toEqual({
			code: "UPSTREAM_ERROR",
			options: ["category", "retryable"],
		});
		// The author guidance is not on the error: it reaches the failure log, not
		// the caller's response body.
		expect(refusal.fix).toBeUndefined();
		// The fault travels on the error itself, so another SDK copy's server
		// can read it (serve-cross-copy-refusal.test.ts serves that case).
		expect(isPerThrowOptionsRetiredError(refusal)).toBe(true);
		expect(isPerThrowOptionsRetiredError(new SDKError("plain", { code: "X" }))).toBe(false);
	});

	it("refuses either option alone, on every provider-facing class, and names the missing code as CODE", () => {
		expect((construct({ code: "SHOP_CLOSED", retryable: true }) as SDKError).details).toEqual({
			code: "SHOP_CLOSED",
			options: ["retryable"],
		});
		expect((construct({ category: "upstream_http" }) as SDKError).message).toContain(
			'{ code: "CODE", category }',
		);
		// test-invalid: the options were removed from the type.
		expect(() => new AuthError("refused", { code: "LOGIN", retryable: false } as never)).toThrow(
			SDKError,
		);
		// test-invalid: the options were removed from the type.
		expect(
			() =>
				new ValidationError("bad", { code: "BAD_INPUT", category: "input_validation" } as never),
		).toThrow(SDKError);
	});

	it("accepts an option that is present but undefined, the shape a conditional spread leaves", () => {
		expect(
			construct({ code: "SHOP_CLOSED", category: undefined, retryable: undefined }),
		).toBeUndefined();
	});

	it("serves the refusal as a platform fault the SDK detected, not as the caller's input failure", async () => {
		const served = await serve(
			() =>
				new ProviderError(
					"TableCheck rejected the cancellation request.",
					{
						code: "UPSTREAM_SCHEMA_ERROR",
						category: "upstream_http",
						retryable: false,
					} as never /* test-invalid: removed options; the refusal is under test */,
				),
			{ errors: [errors.UPSTREAM_SCHEMA_ERROR] },
		);

		// The declared code, its 502 and the per-throw words never reach the
		// caller: the SDK refused the construction, and that is its own fault to
		// report, like OUTPUT_VALIDATION_FAILED.
		expect(served.status).toBe(500);
		expect(served.body.error).toMatchObject({
			code: "PER_THROW_ERROR_OPTIONS_RETIRED",
			source: "apifuse",
			retryable: false,
		});
		expect(served.body.error.fix).toBeUndefined();
		expect(served.header).toMatchObject({
			origin: "platform",
			category: "internal_error",
			retryable: false,
		});
		const failure = served.events.find((event) => event.event === "provider_request_failed");
		expect(failure).toMatchObject({
			status: 500,
			code: "PER_THROW_ERROR_OPTIONS_RETIRED",
			errorOrigin: "platform",
			errorCategory: "internal_error",
			signal: "per_throw_error_options_retired",
		});
		expect((failure as { signalFix?: string }).signalFix).toContain(
			"apifuse migrate --only errors-factory",
		);
	});

	it("leaves SDK-constructed errors their own contract (an SDK transport failure is not a provider code)", async () => {
		const served = await serve(
			() =>
				new TransportError("upstream closed the socket", {
					code: "transport_network_error",
					status: 0,
					category: "upstream_http",
					retryable: true,
				}),
		);

		expect(served.header).toMatchObject({ category: "upstream_http", retryable: true });
	});

	it("resolves a hand-thrown code from the listed defineErrors declaration", async () => {
		const served = await serve(() => new ProviderError("closed", { code: "SHOP_CLOSED" }), {
			errors: [errors.SHOP_CLOSED],
		});

		expect(served.status).toBe(502);
		expect(served.header).toMatchObject({ category: "upstream_http", retryable: false });
	});
});

describe("an SDK-contract error a provider built with a category outside the provider-failure domain", () => {
	// A provider can hand TransportError, SessionExpiredError, HandleError and
	// ProviderSecretError a category through a cast or from JavaScript. A
	// platform word or an unknown word there is no value: the failure is
	// classified as if none were set, served under origin provider with a
	// provider-failure category and a source, and the failure log names it.
	const rows: ReadonlyArray<{
		readonly name: string;
		readonly word: string;
		readonly create: () => Error;
		readonly derived?: ProviderFailureCategory;
	}> = [
		{
			name: "TransportError with a platform word",
			word: "internal_error",
			derived: "network",
			create: () =>
				new TransportError("upstream closed the socket", {
					code: "transport_network_error",
					status: 0,
					category: "internal_error" as never /* test-invalid: outside the domain */,
					retryable: true,
				}),
		},
		{
			name: "TransportError with an unknown word",
			word: "not_a_category",
			derived: "network",
			create: () =>
				new TransportError("upstream closed the socket", {
					code: "transport_network_error",
					status: 0,
					category: "not_a_category" as never /* test-invalid: outside the domain */,
				}),
		},
		{
			name: "SessionExpiredError with a platform word",
			word: "proxy_pool",
			derived: "credential_expired",
			create: () =>
				new SessionExpiredError("expired", {
					category: "proxy_pool" as never /* test-invalid: outside the domain */,
				}),
		},
		{
			name: "HandleError with a platform word",
			word: "client_cancelled",
			create: () =>
				new HandleError("HANDLE_EXPIRED", "handle expired", {
					category: "client_cancelled" as never /* test-invalid: outside the domain */,
				}),
		},
		{
			name: "ProviderSecretError with a platform word",
			word: "dependency_unavailable",
			create: () =>
				new ProviderSecretError("secret unreadable", {
					category: "dependency_unavailable" as never /* test-invalid: outside the domain */,
				}),
		},
	];

	for (const row of rows) {
		it(`never serves ${row.name} under origin provider with that word`, async () => {
			const served = await serve(row.create);

			expect(served.header.origin).toBe("provider");
			expect(served.header.category).not.toBe(row.word);
			expect(PROVIDER_FAILURE_CATEGORIES as readonly string[]).toContain(served.header.category);
			if (row.derived) expect(served.header.category).toBe(row.derived);
			expect(PROVIDER_ERROR_SOURCES as readonly string[]).toContain(served.body.error.source);
			expect(
				served.events.find((event) => event.event === "provider_request_failed"),
			).toMatchObject({
				errorOrigin: "provider",
				errorCategory: served.header.category,
				signal: "unknown_provider_error_category",
			});
		});
	}

	it("keeps an in-domain contract word as served", async () => {
		const served = await serve(
			() =>
				new SessionExpiredError("expired", {
					category: "credential_unavailable",
				}),
		);
		expect(served.header).toMatchObject({ origin: "provider", category: "credential_unavailable" });
		expect(
			served.events.find((event) => event.event === "provider_request_failed"),
		).not.toHaveProperty("signal");
	});
});
