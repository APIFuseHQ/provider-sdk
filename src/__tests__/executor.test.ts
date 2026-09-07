import { describe, expect, it, mock } from "bun:test";

import { z } from "zod";

import {
	isSessionExpiredError,
	type ProviderError,
	SessionExpiredError,
	TransportError,
} from "../errors.js";
import { createProviderContextDouble } from "./test-utils.js";

// A query-qualified specifier forces Bun to evaluate errors.ts a second time,
// producing a genuinely separate module identity (distinct constructors) that
// models the packaged src/* vs a provider's dist/* SDK entrypoint split. Mirrors
// the pattern proven in error-identity.test.ts.
const duplicateSdkSpecifier: string = "../errors.ts?duplicate-sdk-instance";
const duplicateSdk: Promise<typeof import("../errors.js")> = import(duplicateSdkSpecifier);
import { createProviderCache } from "../runtime/cache.js";
import { createTestProviderChoiceContext } from "../runtime/choice.js";
import { executeOperation } from "../runtime/executor.js";
import { createUnsupportedProviderRuntimeState } from "../runtime/state.js";
import type { DeclarativeStealthResponse, ProviderContext, ProviderDefinition } from "../types.js";

function createStealthResponse(value: unknown, status: number): DeclarativeStealthResponse {
	const body = JSON.stringify(value);
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: {},
		rawHeaders: [],
		body,
		cookies: {
			get: () => undefined,
			getAll: () => ({}),
			toString: () => "",
		},
		async json<T>(): Promise<T> {
			return JSON.parse(body);
		},
		async arrayBuffer() {
			return await new Blob([body]).arrayBuffer();
		},
		async bytes() {
			return new TextEncoder().encode(body);
		},
	};
}

function createMockCtx(fetchResponse: unknown, status = 200): ProviderContext {
	return createProviderContextDouble({
		env: {
			get: mock(() => undefined),
		},
		credential: {
			mode: "none",
			get: mock(() => undefined),
			getAll: mock(() => ({})),
			getAccessToken: mock(() => undefined),
			getScopes: mock(() => []),
		},
		stealth: {
			...createProviderContextDouble().stealth,
			fetch: mock(async () => createStealthResponse(fetchResponse, status)),
		},
		cache: createProviderCache({ providerId: "test-provider" }),
		state: createUnsupportedProviderRuntimeState(),
		trace: {
			span: async <T>(_name: string, fn: () => Promise<T>) => fn(),
		},
		auth: {
			requestField: mock(async () => ""),
		},
		choice: createTestProviderChoiceContext({ providerId: "test-provider" }),
	});
}

function createMockProvider(options?: {
	handler?: ProviderDefinition["operations"][string]["handler"];
	auth?: ProviderDefinition["auth"];
}): ProviderDefinition {
	return {
		id: "test-provider",
		version: "1.0.0",
		runtime: "standard",
		auth: options?.auth,
		meta: {
			displayName: "Test Provider",
			descriptionKey: "test-provider.description",
			category: "test",
		},
		operations: {
			search: {
				riskClass: "read",
				descriptionKey: "operations.search.description",
				input: z.object({ query: z.string() }),
				output: z.object({ results: z.array(z.string()) }),
				handler:
					options?.handler ??
					(async (_ctx: ProviderContext, input: unknown) => {
						const parsed = z.object({ query: z.string() }).parse(input);

						return {
							results: [parsed.query],
						};
					}),
			},
		},
	};
}

describe("executeOperation", () => {
	it("runs the handler and validates output", async () => {
		const ctx = createMockCtx({});
		const provider = createMockProvider();

		const result = await executeOperation(provider, "search", ctx, {
			query: "test",
		});

		expect(result).toEqual({ results: ["test"] });
	});

	it("passes through handler output parsing", async () => {
		const ctx = createMockCtx({});
		const provider = createMockProvider({
			handler: async () => ({ results: ["result1", "result2"] }),
		});

		const result = await executeOperation(provider, "search", ctx, {
			query: "test",
		});

		expect(result).toEqual({ results: ["result1", "result2"] });
	});

	it("marks handler output schema failures as output validation", async () => {
		const ctx = createMockCtx({});
		const provider = createMockProvider({
			handler: async () => ({ results: [42] }),
		});

		await expect(
			executeOperation(provider, "search", ctx, { query: "test" }),
		).rejects.toMatchObject({
			name: "ValidationError",
			options: {
				code: "OUTPUT_VALIDATION_FAILED",
				category: "output_validation",
				retryable: false,
			},
		});
	});

	it("preserves non-validation exceptions thrown by output schema logic", async () => {
		const ctx = createMockCtx({});
		const schemaError = new (await duplicateSdk).ProviderError("schema transform failed", {
			code: "SCHEMA_TRANSFORM_FAILED",
		});
		const base = createMockProvider();
		const provider = {
			...base,
			operations: {
				search: {
					...base.operations.search,
					output: z.object({ results: z.array(z.string()) }).transform(() => {
						throw schemaError;
					}),
				},
			},
		} as ProviderDefinition;

		await expect(executeOperation(provider, "search", ctx, { query: "test" })).rejects.toBe(
			schemaError,
		);
	});

	it("throws ProviderError when operation not found", async () => {
		const ctx = createMockCtx({});
		const provider = createMockProvider();

		await expect(executeOperation(provider, "nonexistent", ctx, {})).rejects.toThrow("nonexistent");
	});

	it("throws ProviderError when operation has no handler", async () => {
		const ctx = createMockCtx({});
		const provider: ProviderDefinition = {
			...createMockProvider(),
			operations: {
				search: {
					riskClass: "read",
					descriptionKey: "operations.search.description",
					input: z.object({ query: z.string() }),
					output: z.object({ results: z.array(z.string()) }),
					// @ts-expect-error test-invalid: operation deliberately omits its runtime handler
					handler: undefined,
				},
			},
		};

		await expect(executeOperation(provider, "search", ctx, { query: "test" })).rejects.toThrow(
			TypeError,
		);
	});

	it("propagates 401 errors without legacy auto-refresh", async () => {
		let callCount = 0;
		const baseCtx = createMockCtx({});
		const ctx: ProviderContext = {
			...baseCtx,
			stealth: {
				...baseCtx.stealth,
				fetch: mock(async () => {
					callCount++;
					const responseStatus = callCount === 1 ? 401 : 200;
					return createStealthResponse({ items: [] }, responseStatus);
				}),
			},
		};

		const provider = createMockProvider({
			auth: {
				mode: "credentials",
				flow: {
					start: async () => ({ kind: "message", turnId: "message" }),
					continue: async () => ({ kind: "complete", turnId: "complete" }),
				},
			},
			handler: async () => {
				callCount++;
				if (callCount === 1) {
					throw new TransportError("Unauthorized", { status: 401 });
				}

				return { results: [] };
			},
		});

		await expect(
			executeOperation(provider, "search", ctx, {
				query: "test",
			}),
		).rejects.toMatchObject({ status: 401 });
		expect(callCount).toBe(1);
	});

	it("passes SessionExpiredError through unchanged", async () => {
		const ctx = createMockCtx({});
		let calls = 0;
		const sessionExpired = new SessionExpiredError();
		const provider = createMockProvider({
			handler: async () => {
				calls++;
				throw sessionExpired;
			},
		});

		let caught: unknown;
		try {
			await executeOperation(provider, "search", ctx, { query: "test" });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(sessionExpired);
		expect(isSessionExpiredError(caught)).toBe(true);
		expect(calls).toBe(1);
	});

	it("surfaces SessionExpiredError as non-retryable for unmarked operations", async () => {
		const ctx = createMockCtx({});
		let calls = 0;
		const provider = createMockProvider({
			handler: async () => {
				calls++;
				throw new SessionExpiredError();
			},
		});

		await expect(
			executeOperation(provider, "search", ctx, { query: "test" }),
		).rejects.toMatchObject({
			name: "SessionExpiredError",
			options: { retryable: false },
		});
		expect(calls).toBe(1);
	});
});

describe("executeOperation SDK-owned secret enforcement", () => {
	const API_KEY = "APIFUSE__PROVIDER__TEST_PROVIDER__API_KEY";
	const SECOND_KEY = "APIFUSE__PROVIDER__TEST_PROVIDER__SECOND_KEY";

	function ctxWithEnv(values: Record<string, string | undefined>): ProviderContext {
		return {
			...createMockCtx({}),
			env: { get: (key: string) => values[key] },
		};
	}

	function providerWithSecrets(
		secrets: ProviderDefinition["secrets"],
		handler: () => Promise<{ results: string[] }>,
	): ProviderDefinition {
		return { ...createMockProvider({ handler }), secrets };
	}

	it("throws structured MISSING_SECRET before the handler when a required secret is unset", async () => {
		let calls = 0;
		const provider = providerWithSecrets(
			[{ name: API_KEY, issuer: "contributor", required: true }],
			async () => {
				calls++;
				return { results: [] };
			},
		);

		await expect(
			executeOperation(provider, "search", ctxWithEnv({}), { query: "test" }),
		).rejects.toMatchObject({
			name: "ProviderSecretError",
			message: `Missing required provider secret: ${API_KEY}`,
			options: {
				code: "MISSING_SECRET",
				category: "credential_unavailable",
				retryable: false,
			},
		});
		expect(calls).toBe(0);
	});

	it("names the missing secret in the fix so operators know what to provision", async () => {
		const provider = providerWithSecrets(
			[{ name: API_KEY, issuer: "contributor", required: true }],
			async () => ({ results: [] }),
		);

		let caught: unknown;
		try {
			await executeOperation(provider, "search", ctxWithEnv({}), { query: "test" });
		} catch (error) {
			caught = error;
		}

		expect((caught as ProviderError).fix).toContain(API_KEY);
	});

	it("gates before input validation so probes fail with MISSING_SECRET, not invalid input", async () => {
		const provider = providerWithSecrets(
			[{ name: API_KEY, issuer: "contributor", required: true }],
			async () => ({ results: [] }),
		);

		// Input violates the schema; the secret gate must still win.
		await expect(
			executeOperation(provider, "search", ctxWithEnv({}), { query: 42 }),
		).rejects.toMatchObject({ options: { code: "MISSING_SECRET" } });
	});

	it("treats whitespace-only values as missing", async () => {
		let calls = 0;
		const provider = providerWithSecrets(
			[{ name: API_KEY, issuer: "contributor", required: true }],
			async () => {
				calls++;
				return { results: [] };
			},
		);

		await expect(
			executeOperation(provider, "search", ctxWithEnv({ [API_KEY]: "   " }), { query: "test" }),
		).rejects.toMatchObject({ options: { code: "MISSING_SECRET" } });
		expect(calls).toBe(0);
	});

	it("lists every missing required secret in a single error", async () => {
		const provider = providerWithSecrets(
			[
				{ name: API_KEY, issuer: "contributor", required: true },
				{ name: SECOND_KEY, issuer: "contributor", required: true },
			],
			async () => ({ results: [] }),
		);

		await expect(
			executeOperation(provider, "search", ctxWithEnv({}), { query: "test" }),
		).rejects.toMatchObject({
			message: `Missing required provider secrets: ${API_KEY}, ${SECOND_KEY}`,
		});
	});

	it("runs the handler when the required secret is present", async () => {
		const provider = providerWithSecrets(
			[{ name: API_KEY, issuer: "contributor", required: true }],
			async () => ({ results: ["ok"] }),
		);

		const result = await executeOperation(provider, "search", ctxWithEnv({ [API_KEY]: "value" }), {
			query: "test",
		});

		expect(result).toEqual({ results: ["ok"] });
	});

	it("does not enforce optional or default-flag declarations", async () => {
		const provider = providerWithSecrets(
			[
				{ name: API_KEY, issuer: "contributor", required: false },
				{ name: SECOND_KEY, issuer: "contributor" },
			],
			async () => ({ results: ["ok"] }),
		);

		const result = await executeOperation(provider, "search", ctxWithEnv({}), { query: "test" });

		expect(result).toEqual({ results: ["ok"] });
	});

	it("leaves undeclared env reads untouched", async () => {
		// No secrets declared: handlers may still read ctx.env freely and the
		// gate never fires.
		const provider = createMockProvider({
			handler: async () => ({ results: ["no-secrets"] }),
		});

		const result = await executeOperation(provider, "search", ctxWithEnv({}), { query: "test" });

		expect(result).toEqual({ results: ["no-secrets"] });
	});
});
