import { describe, expect, it, mock } from "bun:test";

import { z } from "zod";

import {
	isSessionExpiredError,
	SessionExpiredError,
	TransportError,
} from "../errors";

// A query-qualified specifier forces Bun to evaluate errors.ts a second time,
// producing a genuinely separate module identity (distinct constructors) that
// models the packaged src/* vs a provider's dist/* SDK entrypoint split. Mirrors
// the pattern proven in error-identity.test.ts.
const duplicateSdk = import("../errors.ts?duplicate-sdk-instance") as Promise<
	typeof import("../errors")
>;
import { createProviderCache } from "../runtime/cache";
import { createTestProviderChoiceContext } from "../runtime/choice";
import { executeOperation } from "../runtime/executor";
import { createUnsupportedProviderRuntimeState } from "../runtime/state";
import type { ProviderContext, ProviderDefinition } from "../types";

function createMockCtx(fetchResponse: unknown, status = 200): ProviderContext {
	return {
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
			fetch: mock(async (_url: string, _opts?: unknown) => ({
				status,
				ok: status >= 200 && status < 300,
				headers: {},
				rawHeaders: [],
				body: "",
				cookies: {
					get: () => undefined,
					getAll: () => ({}),
					toString: () => "",
				},
				json: async <T>() => fetchResponse as T,
			})),
			createSession: mock(() => ({
				fetch: async () => ({
					status,
					ok: status >= 200 && status < 300,
					headers: {},
					rawHeaders: [] as [string, string][],
					body: "",
					cookies: {
						get: () => undefined,
						getAll: () => ({}),
						toString: () => "",
					},
					json: async <T>() => ({}) as T,
				}),
				close: () => {},
			})),
		},
		http: {} as ProviderContext["http"],
		cache: createProviderCache({ providerId: "test-provider" }),
		state: createUnsupportedProviderRuntimeState(),
		browser: {} as ProviderContext["browser"],
		trace: {
			span: async <T>(_name: string, fn: () => Promise<T>) => fn(),
		},
		auth: {
			requestField: mock(async () => ""),
		},
		choice: createTestProviderChoiceContext({ providerId: "test-provider" }),
	};
}

function createMockProvider(options?: {
	handler?: ProviderDefinition["operations"][string]["handler"];
	auth?: ProviderDefinition["auth"];
	retryOnAuthRefresh?: boolean;
}): ProviderDefinition {
	return {
		id: "test-provider",
		version: "1.0.0",
		runtime: "standard",
		auth: options?.auth,
		meta: {
			displayName: "Test Provider",
			category: "test",
		},
		operations: {
			search: {
				description: "Search",
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
				...(options?.retryOnAuthRefresh === undefined
					? {}
					: { retryOnAuthRefresh: options.retryOnAuthRefresh }),
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

	it("throws ProviderError when operation not found", async () => {
		const ctx = createMockCtx({});
		const provider = createMockProvider();

		await expect(
			executeOperation(provider, "nonexistent", ctx, {}),
		).rejects.toThrow("nonexistent");
	});

	it("throws ProviderError when operation has no handler", async () => {
		const ctx = createMockCtx({});
		const provider: ProviderDefinition = {
			...createMockProvider(),
			operations: {
				search: {
					description: "No upstream",
					input: z.object({ query: z.string() }),
					output: z.object({ results: z.array(z.string()) }),
					handler: undefined as never,
				},
			},
		};

		await expect(
			executeOperation(provider, "search", ctx, { query: "test" }),
		).rejects.toThrow(TypeError);
	});

	it("propagates 401 errors without legacy auto-refresh", async () => {
		let callCount = 0;
		const ctx: ProviderContext = {
			...createMockCtx({}),
			stealth: {
				fetch: mock(async () => {
					callCount++;
					const responseStatus = callCount === 1 ? 401 : 200;
					return {
						status: responseStatus,
						ok: responseStatus >= 200 && responseStatus < 300,
						headers: {},
						rawHeaders: [],
						body: "",
						cookies: {
							get: () => undefined,
							getAll: () => ({}),
							toString: () => "",
						},
						json: async <T>() => ({ items: [] }) as T,
					};
				}),
				createSession: mock(() => ({
					fetch: async () => ({
						status: 200,
						ok: true,
						headers: {},
						rawHeaders: [] as [string, string][],
						body: "",
						cookies: {
							get: () => undefined,
							getAll: () => ({}),
							toString: () => "",
						},
						json: async <T>() => ({}) as T,
					}),
					close: () => {},
				})),
			},
		};

		const provider = createMockProvider({
			auth: {
				mode: "credentials",
				flow: {
					start: async () => ({ kind: "message" }),
					continue: async () => ({ kind: "complete" }),
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

	it("surfaces SessionExpiredError as retryable for opt-in operations (no in-process retry)", async () => {
		const ctx = createMockCtx({});
		let calls = 0;
		const provider = createMockProvider({
			retryOnAuthRefresh: true,
			handler: async () => {
				calls++;
				throw new SessionExpiredError();
			},
		});

		// The SDK does NOT retry in-process (it cannot refresh ctx.credential).
		// It surfaces the expiry as retryable so Credential Service refreshes and
		// re-drives the operation with a fresh credential. Handler runs exactly once.
		await expect(
			executeOperation(provider, "search", ctx, { query: "test" }),
		).rejects.toMatchObject({
			name: "SessionExpiredError",
			options: { retryable: true },
		});
		expect(calls).toBe(1);
	});

	it("upgrades a duplicate-module SessionExpiredError to retryable for opt-in operations", async () => {
		const Dup = await duplicateSdk;
		expect(Dup.SessionExpiredError).not.toBe(SessionExpiredError);

		const ctx = createMockCtx({});
		let calls = 0;
		const provider = createMockProvider({
			retryOnAuthRefresh: true,
			handler: async () => {
				calls++;
				// A correctly branded SessionExpiredError thrown from a handler
				// loaded through a duplicate/published SDK module: its constructor
				// identity differs from the source executor's, so `instanceof`
				// misses it and the retryable upgrade is silently skipped.
				throw new Dup.SessionExpiredError();
			},
		});

		let caught: unknown;
		try {
			await executeOperation(provider, "search", ctx, { query: "test" });
		} catch (error) {
			caught = error;
		}

		// The executor must recognize the cross-module error via the branded guard
		// and upgrade it to retryable so Credential Service re-drives the operation.
		expect(isSessionExpiredError(caught)).toBe(true);
		expect((caught as SessionExpiredError).options?.retryable).toBe(true);
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

	it("never re-runs the handler in-process on session expiry", async () => {
		const ctx = createMockCtx({});
		let calls = 0;
		const provider = createMockProvider({
			retryOnAuthRefresh: true,
			handler: async () => {
				calls++;
				throw new SessionExpiredError();
			},
		});

		await expect(
			executeOperation(provider, "search", ctx, { query: "test" }),
		).rejects.toThrow(SessionExpiredError);
		expect(calls).toBe(1);
	});
});
