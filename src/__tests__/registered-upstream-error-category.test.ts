import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
	SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES,
	SDK_UPSTREAM_ERROR_CODE_REGISTRY,
} from "../error-resolution.js";
import { AuthError, ProviderError, type ProviderErrorOptions, ValidationError } from "../errors.js";
import {
	categoryForStatus,
	PROVIDER_ERROR_CATEGORIES,
	PROVIDER_ERROR_SOURCES,
	type ProviderErrorCategory,
	type ProviderErrorSource,
	sourceForCategory,
} from "../observability.js";
import {
	createServerApp,
	ERROR_OBSERVABILITY_HEADER,
	type ProviderServerLogEvent,
} from "../server/serve.js";
import type {
	OperationErrorCode,
	OperationRiskClass,
	ProviderDefinition,
	ProviderErrorStatus,
} from "../types.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

const READ_RISK_CLASS: OperationRiskClass = "read";

// The served contract for every registered upstream code thrown without a
// category, written out literally: a registry row that changes its category,
// or a new row, has to change this table too.
const EXPECTED_UPSTREAM_CODES: ReadonlyArray<{
	code: string;
	status: ProviderErrorStatus;
	category: ProviderErrorCategory;
	source: ProviderErrorSource;
}> = [
	{ code: "NOT_FOUND", status: 404, category: "upstream_http", source: "upstream_failure" },
	{ code: "not_found", status: 404, category: "upstream_http", source: "upstream_failure" },
	{ code: "NO_DATA", status: 404, category: "upstream_http", source: "upstream_failure" },
	{
		code: "RATE_LIMITED",
		status: 429,
		category: "upstream_rate_limited",
		source: "upstream_rule",
	},
	{
		code: "UPSTREAM_RATE_LIMIT",
		status: 429,
		category: "upstream_rate_limited",
		source: "upstream_rule",
	},
	{
		code: "LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR",
		status: 429,
		category: "upstream_rate_limited",
		source: "upstream_rule",
	},
	{
		code: "UPSTREAM_REJECTED",
		status: 409,
		category: "upstream_rejected",
		source: "upstream_rule",
	},
	{ code: "UPSTREAM_ERROR", status: 502, category: "upstream_http", source: "upstream_failure" },
	{ code: "BLOCKED", status: 502, category: "anti_bot_blocked", source: "upstream_failure" },
	{
		code: "UPSTREAM_AUTH_ERROR",
		status: 400,
		category: "upstream_auth",
		source: "upstream_failure",
	},
	{
		code: "UPSTREAM_SCHEMA_ERROR",
		status: 502,
		category: "upstream_schema_drift",
		source: "upstream_failure",
	},
];

const ObservabilityHeaderSchema = z.object({
	category: z.enum(PROVIDER_ERROR_CATEGORIES),
	taxonomyVersion: z.string(),
	retryable: z.boolean(),
});

const ErrorBodySchema = z.object({
	error: z.object({
		code: z.string(),
		retryable: z.boolean(),
		source: z.enum(PROVIDER_ERROR_SOURCES),
	}),
});

type ServedError = {
	status: number;
	code: string;
	source: ProviderErrorSource;
	retryable: boolean;
	category: ProviderErrorCategory;
	headerRetryable: boolean;
	loggedCategory: unknown;
};

async function serveThrown(
	createError: () => Error,
	options: { errorCodes?: OperationErrorCode[] } = {},
): Promise<ServedError> {
	const events: ProviderServerLogEvent[] = [];
	const provider: ProviderDefinition = createProviderDefinitionDouble({
		operations: {
			probe: {
				riskClass: READ_RISK_CLASS,
				input: z.object({ value: z.string() }),
				output: z.object({ ok: z.boolean() }),
				...(options.errorCodes ? { errorCodes: options.errorCodes } : {}),
				handler: async () => {
					throw createError();
				},
			},
		},
	});
	const app = createServerApp(provider, { logger: (event) => events.push(event) });
	const response = await app.request("/v1/probe", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: "req_probe", input: { value: "x" } }),
	});
	const body = ErrorBodySchema.parse(await response.json());
	const header = ObservabilityHeaderSchema.parse(
		JSON.parse(response.headers.get(ERROR_OBSERVABILITY_HEADER) ?? "null"),
	);
	const failure = events.find((event) => event.event === "provider_request_failed");
	return {
		status: response.status,
		code: body.error.code,
		source: body.error.source,
		retryable: body.error.retryable,
		category: header.category,
		headerRetryable: header.retryable,
		loggedCategory: failure?.errorCategory,
	};
}

function throwing(code: string, options: ProviderErrorOptions = {}): () => ProviderError {
	return () => new ProviderError(`probe ${code}`, { code, ...options });
}

describe("registered upstream error code registry", () => {
	it("pins every registry row to the literal served contract", () => {
		expect([...SDK_UPSTREAM_ERROR_CODE_REGISTRY.keys()].sort()).toEqual(
			EXPECTED_UPSTREAM_CODES.map((entry) => entry.code).sort(),
		);
		for (const expected of EXPECTED_UPSTREAM_CODES) {
			expect({
				code: expected.code,
				...SDK_UPSTREAM_ERROR_CODE_REGISTRY.get(expected.code),
			}).toEqual({
				code: expected.code,
				status: expected.status,
				category: expected.category,
			});
		}
	});

	it("feeds each row's status into the status map, so the served status is unchanged", () => {
		for (const [code, registration] of SDK_UPSTREAM_ERROR_CODE_REGISTRY) {
			expect({ code, status: SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.get(code) }).toEqual({
				code,
				status: registration.status,
			});
		}
	});

	it("attributes every row to the upstream", () => {
		// The table is for codes that name what the upstream did. A caller-side
		// or APIFuse-side code here would be misattributed to the upstream.
		for (const [code, { category }] of SDK_UPSTREAM_ERROR_CODE_REGISTRY) {
			expect({ code, source: sourceForCategory(category) }).toEqual({
				code,
				source: expect.stringMatching(/^upstream_(rule|failure)$/),
			});
		}
	});

	it("uses the status's category unless the code names a narrower class", () => {
		const narrower = new Map<string, ProviderErrorCategory>([
			["UPSTREAM_SCHEMA_ERROR", "upstream_schema_drift"],
			["BLOCKED", "anti_bot_blocked"],
			["UPSTREAM_AUTH_ERROR", "upstream_auth"],
		]);
		for (const [code, registration] of SDK_UPSTREAM_ERROR_CODE_REGISTRY) {
			expect({ code, category: registration.category }).toEqual({
				code,
				category: narrower.get(code) ?? categoryForStatus(registration.status),
			});
		}
	});
});

describe("serving a registered upstream code thrown without a category", () => {
	for (const expected of EXPECTED_UPSTREAM_CODES) {
		it(`serves ${expected.code} with source ${expected.source} and category ${expected.category}`, async () => {
			const served = await serveThrown(throwing(expected.code));

			expect(served).toEqual({
				status: expected.status,
				code: expected.code,
				source: expected.source,
				// Retryability does not follow the derived category: an
				// undeclared throw stays non-retryable, as before.
				retryable: false,
				category: expected.category,
				headerRetryable: false,
				loggedCategory: expected.category,
			});
		});
	}

	it("derives the category for ProviderError subclasses too", async () => {
		const served = await serveThrown(
			() => new AuthError("platform key refused", { code: "UPSTREAM_AUTH_ERROR" }),
		);

		expect(served).toMatchObject({
			status: 400,
			source: "upstream_failure",
			category: "upstream_auth",
		});
	});

	it("derives the category for a ValidationError carrying a registered upstream code", async () => {
		// The registered status already applies to validation errors; the
		// category follows the same code, not the input_validation default.
		const served = await serveThrown(
			() =>
				new ValidationError("Upstream payload failed the response schema", {
					code: "UPSTREAM_SCHEMA_ERROR",
				}),
		);

		expect(served).toMatchObject({
			status: 502,
			source: "upstream_failure",
			category: "upstream_schema_drift",
			retryable: false,
		});
	});

	it("keeps ValidationError defaults for unregistered codes and explicit categories", async () => {
		const cases = [
			{
				createError: () => new ValidationError("bad input", { code: "BAD_DATE" }),
				errorCodes: undefined,
				expected: { status: 400, category: "input_validation", source: "client" },
			},
			{
				createError: () => new ValidationError("bad upstream row", { code: "ROW_INVALID" }),
				errorCodes: [{ code: "ROW_INVALID", status: 502, description: "Row invalid" }],
				expected: { status: 502, category: "provider_error", source: "apifuse" },
			},
			{
				createError: () =>
					new ValidationError("bad input", {
						code: "UPSTREAM_SCHEMA_ERROR",
						category: "input_validation",
					}),
				errorCodes: undefined,
				expected: { status: 502, category: "input_validation", source: "client" },
			},
		] as const;
		for (const testCase of cases) {
			const served = await serveThrown(
				testCase.createError,
				testCase.errorCodes ? { errorCodes: [...testCase.errorCodes] } : {},
			);

			expect({
				status: served.status,
				category: served.category,
				source: served.source,
			}).toEqual(testCase.expected);
		}
	});

	it("keeps a declared retryability while deriving the category", async () => {
		const served = await serveThrown(throwing("UPSTREAM_SCHEMA_ERROR"), {
			errorCodes: [
				{
					code: "UPSTREAM_SCHEMA_ERROR",
					status: 502,
					description: "Upstream schema changed",
					retryable: true,
				},
			],
		});

		expect(served).toMatchObject({
			status: 502,
			source: "upstream_failure",
			category: "upstream_schema_drift",
			retryable: true,
			headerRetryable: true,
		});
	});

	it("keeps an operation-declared rejection status ahead of the code's category", async () => {
		const served = await serveThrown(throwing("UPSTREAM_SCHEMA_ERROR"), {
			errorCodes: [
				{ code: "UPSTREAM_SCHEMA_ERROR", status: 422, description: "Upstream refused the order" },
			],
		});

		expect(served).toMatchObject({
			status: 422,
			source: "upstream_rule",
			category: "upstream_rejected",
		});
	});
});

describe("serving an explicit category or an unregistered code", () => {
	it("leaves an explicit category untouched on every registered upstream code", async () => {
		for (const expected of EXPECTED_UPSTREAM_CODES) {
			const served = await serveThrown(throwing(expected.code, { category: "provider_error" }));

			expect({ code: expected.code, category: served.category }).toEqual({
				code: expected.code,
				category: "provider_error",
			});
		}
	});

	it("serves the source of an explicit category", async () => {
		const cases = [
			{ code: "UPSTREAM_SCHEMA_ERROR", category: "input_validation", source: "client" },
			{ code: "NOT_FOUND", category: "upstream_rejected", source: "upstream_rule" },
			{ code: "NO_DATA", category: "provider_error", source: "apifuse" },
			{ code: "UPSTREAM_RATE_LIMIT", category: "upstream_auth", source: "upstream_failure" },
			// UPSTREAM_ERROR and BLOCKED keep their code-level upstream
			// attribution under any explicit category, as before this table.
			{ code: "UPSTREAM_ERROR", category: "provider_error", source: "upstream_failure" },
			{ code: "BLOCKED", category: "internal_error", source: "upstream_failure" },
		] as const;
		for (const testCase of cases) {
			const served = await serveThrown(throwing(testCase.code, { category: testCase.category }));

			expect({ code: testCase.code, category: served.category, source: served.source }).toEqual({
				code: testCase.code,
				category: testCase.category,
				source: testCase.source,
			});
		}
	});

	it("keeps custom and non-upstream registered codes on their existing defaults", async () => {
		const cases = [
			{ code: "SOME_CUSTOM_CODE", status: 500, category: "provider_error", source: "apifuse" },
			{ code: "INVALID_REQUEST", status: 400, category: "provider_error", source: "apifuse" },
			{ code: "AUTH_REQUIRED", status: 401, category: "provider_error", source: "apifuse" },
			{
				code: "MISSING_SECRET",
				status: 400,
				category: "credential_unavailable",
				source: "apifuse",
			},
		] as const;
		for (const testCase of cases) {
			const served = await serveThrown(throwing(testCase.code));

			expect({
				code: testCase.code,
				status: served.status,
				category: served.category,
				source: served.source,
			}).toEqual(testCase);
		}
	});

	it("keeps a declared custom code on provider_error", async () => {
		const served = await serveThrown(throwing("SHOP_CLOSED"), {
			errorCodes: [{ code: "SHOP_CLOSED", status: 502, description: "Shop closed" }],
		});

		expect(served).toMatchObject({
			status: 502,
			source: "apifuse",
			category: "provider_error",
		});
	});
});

describe("SDK-originated not-found responses", () => {
	const app = createServerApp(createProviderDefinitionDouble(), { logger: () => undefined });

	it("keeps an unknown operation APIFuse-attributed", async () => {
		const response = await app.request("/v1/missing", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_missing", input: {} }),
		});

		expect(response.status).toBe(404);
		const body = ErrorBodySchema.parse(await response.json());
		expect(body.error).toMatchObject({ code: "NOT_FOUND", source: "apifuse" });
		expect(
			ObservabilityHeaderSchema.parse(
				JSON.parse(response.headers.get(ERROR_OBSERVABILITY_HEADER) ?? "null"),
			).category,
		).toBe("provider_error");
	});

	it("keeps an unknown route APIFuse-attributed", async () => {
		const response = await app.request("/missing");

		expect(response.status).toBe(404);
		const body = ErrorBodySchema.parse(await response.json());
		expect(body.error).toMatchObject({ code: "not_found", source: "apifuse" });
		expect(
			ObservabilityHeaderSchema.parse(
				JSON.parse(response.headers.get(ERROR_OBSERVABILITY_HEADER) ?? "null"),
			).category,
		).toBe("provider_error");
	});
});
