import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
	defineOperation,
	defineProvider,
	defineStreamOperation,
	type ProviderContextOf,
} from "../define.js";
import type { OperationDefinitionFor } from "../index.js";
import type { ProviderDefinitionFor } from "../provider.js";
import { executeOperation } from "../runtime/executor.js";
import { wrapWithInstrumentation } from "../runtime/instrumentation.js";
import { createServerApp } from "../server/serve.js";
import { event } from "../stream.js";
import type { OperationDefinition, ProviderContext, ProviderDefinition } from "../types.js";
import { createProviderContextDouble } from "./test-utils.js";
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
	it("derives the public ProviderContext type directly from a declaration", () => {
		const declaration = { http: {} } as const;
		type Context = ProviderContext<typeof declaration>;
		const verifyContext = (ctx: Context) => {
			void ctx.http;
			void ctx.trace;
			// @ts-expect-error test-invalid: cache is absent from the declaration.
			void ctx.cache;
		};

		void verifyContext;
		expect(Object.hasOwn(declaration, "http")).toBe(true);
	});

	it("contextually types inline handlers from the first phase", () => {
		const provider = defineProvider({
			id: "capability-inline",
			version: "1.0.0",
			runtime: "standard",
			http: {},
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

	it("exposes every bare-object capability declaration to handler context", () => {
		const provider = defineProvider({
			id: "capability-bare-objects",
			version: "1.0.0",
			runtime: "standard",
			http: {},
			choice: {},
			env: {},
			state: {},
			cache: {},
			files: {},
			meta,
		})({
			operations: {
				probe: {
					...operationSchemas,
					async handler(ctx) {
						void ctx.http;
						void ctx.choice;
						void ctx.env;
						void ctx.state;
						void ctx.cache;
						void ctx.files;
						return { ok: true };
					},
				},
			},
		});

		expect(provider.id).toBe("capability-bare-objects");
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
						// @ts-expect-error test-invalid: http is not declared.
						void ctx.http;
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

	it("does not turn policy and metadata declarations into context bindings", () => {
		const provider = defineProvider({
			id: "capability-non-bindings",
			version: "1.0.0",
			runtime: "standard",
			allowedHosts: ["example.test"],
			proxy: false,
			secrets: [],
			context: { keys: [] },
			meta,
		})({
			operations: {
				probe: {
					...operationSchemas,
					async handler(ctx) {
						void ctx.trace;
						// @ts-expect-error test-invalid: allowedHosts is policy, not a binding.
						void ctx.allowedHosts;
						// @ts-expect-error test-invalid: proxy is policy, not a binding.
						void ctx.proxy;
						// @ts-expect-error test-invalid: secrets are requirements, not a binding.
						void ctx.secrets;
						// @ts-expect-error test-invalid: context is metadata, not a binding.
						void ctx.context;
						return { ok: true };
					},
				},
			},
		});

		expect(provider.id).toBe("capability-non-bindings");
	});

	it("keeps legacy true capability markers source-compatible", () => {
		const provider = defineProvider({
			id: "capability-legacy-marker",
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
						return { ok: true };
					},
				},
			},
		});

		expect(provider.id).toBe("capability-legacy-marker");
	});

	it("composes a separately authored context-bound operation", () => {
		expect(factoredProvider.operations.factored).toBeDefined();
	});

	it("carries declaration-derived contexts through named operation and provider types", async () => {
		const buildProvider = defineProvider({
			id: "capability-context-carry",
			version: "1.0.0",
			runtime: "standard",
			http: {},
			meta,
		});
		type Context = ProviderContextOf<typeof buildProvider>;

		// A: a named operation can call a sibling with the context it receives.
		const child: OperationDefinitionFor<typeof buildProvider> = defineOperation<Context>()({
			...operationSchemas,
			async handler(ctx) {
				void ctx.http;
				return { ok: true };
			},
		});
		const parent = defineOperation<Context>()({
			...operationSchemas,
			async handler(ctx) {
				await child.handler(ctx, {});
				// F: carrying the context must not expose undeclared capabilities.
				// @ts-expect-error test-invalid: cache is absent from the declaration-derived context.
				void ctx.cache;
				return { ok: true };
			},
		});

		// B: stream operations survive the context-preserving provider index signature.
		const events = defineStreamOperation<Context>()({
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			transport: {
				kind: "sse",
				events: { status: z.object({ ok: z.boolean() }) },
			},
			async *handler(ctx) {
				void ctx.http;
				yield event("status", { ok: true });
			},
			healthCheckUnsupported: { reason: "type fixture" },
		});

		// C: a harness can retain the provider's derived handler context.
		const provider: ProviderDefinitionFor<typeof buildProvider> = buildProvider({
			operations: { child, parent, events },
		});
		const fullContext = createProviderContextDouble();
		const ctx: Context = {
			http: fullContext.http,
			trace: fullContext.trace,
			request: fullContext.request,
		};
		await provider.operations.child.handler(ctx, {});

		// D: executeOperation retains the selected operation's carried context.
		await executeOperation(provider, "child", ctx, {});

		// E: utility projections can select declared and ambient context members.
		const picked: Pick<Context, "http" | "trace"> = {
			http: ctx.http,
			trace: ctx.trace,
		};
		void picked;

		// The server callback is contextually typed from the narrow provider.
		const verifyServerExecutor = () =>
			createServerApp(provider, {
				operationExecutor: async ({ ctx: executorContext }) => {
					void executorContext.http;
					// @ts-expect-error test-invalid: server executors retain capability narrowing.
					void executorContext.cache;
					return { ok: true };
				},
			});
		void verifyServerExecutor;

		// G: today's bare annotations retain their wide default context.
		const bareOperation: OperationDefinition = {
			...operationSchemas,
			async handler(bareContext) {
				void bareContext.cache;
				return { ok: true };
			},
		};
		const bareProvider: ProviderDefinition = {
			id: "capability-context-bare",
			version: "1.0.0",
			runtime: "standard",
			meta,
			operations: { bareOperation },
		};
		const bareContext: ProviderContext = fullContext;
		await bareProvider.operations.bareOperation.handler(bareContext, {});

		expect(provider.operations.events.transport?.kind).toBe("sse");
	});

	it("rejects a server provider whose context the runtime cannot build", () => {
		// The public server factories are generic so a narrow provider can supply
		// an operationExecutor without a cast, and they launder the provider
		// through the wide runtime representation internally. That laundering is
		// only sound while the context parameter stays within ProviderContext:
		// an unconstrained parameter would let a provider demand members the SDK
		// never supplies, and the handler would read undefined at runtime.
		type ForeignContext = { upstreamSession: string };

		const foreignProvider: ProviderDefinition<ForeignContext> = {
			id: "capability-context-foreign",
			version: "1.0.0",
			runtime: "standard",
			meta,
			operations: {
				probe: {
					...operationSchemas,
					async handler(ctx: ForeignContext) {
						return { ok: ctx.upstreamSession.length > 0 };
					},
				},
			},
		};

		const rejectsForeignContext = () =>
			// @ts-expect-error test-invalid: the runtime never builds a foreign context.
			createServerApp(foreignProvider);
		void rejectsForeignContext;

		expect(foreignProvider.id).toBe("capability-context-foreign");
	});

	it("executes with the selected operation's declaration-derived context", async () => {
		const buildProvider = defineProvider({
			id: "capability-executor",
			version: "1.0.0",
			runtime: "standard",
			http: {},
			meta,
		});
		type Context = ProviderContextOf<typeof buildProvider>;
		const provider = buildProvider({
			operations: {
				probe: {
					...operationSchemas,
					async handler(ctx) {
						void ctx.http;
						return { ok: true };
					},
				},
			},
		});
		const fullContext = createProviderContextDouble();
		const derivedContext: Context = {
			http: fullContext.http,
			trace: fullContext.trace,
			request: fullContext.request,
		};
		const instrumentedContext = wrapWithInstrumentation(derivedContext);

		await expect(executeOperation(provider, "probe", instrumentedContext, {})).resolves.toEqual({
			ok: true,
		});
		await expect(provider.operations.probe.handler(derivedContext, {})).resolves.toEqual({
			ok: true,
		});
		await expect(executeOperation(provider, "probe", fullContext, {})).resolves.toEqual({
			ok: true,
		});

		const contextMissingHttp = {
			trace: fullContext.trace,
			request: fullContext.request,
		};
		const verifyContextRequirement = () => {
			// @ts-expect-error test-invalid: the selected handler requires declared HTTP access.
			void executeOperation(provider, "probe", contextMissingHttp, {});
			// @ts-expect-error test-invalid: direct handler execution keeps the same HTTP requirement.
			void provider.operations.probe.handler(contextMissingHttp, {});
		};
		void verifyContextRequirement;
	});

	it("reports required secrets when a narrow test context has no env", async () => {
		const buildProvider = defineProvider({
			id: "capability-executor-secrets",
			version: "1.0.0",
			runtime: "standard",
			secrets: [{ name: "CAPABILITY_EXECUTOR_SECRET", required: true }],
			meta,
		});
		type Context = ProviderContextOf<typeof buildProvider>;
		const provider = buildProvider({
			operations: {
				probe: {
					...operationSchemas,
					async handler() {
						return { ok: true };
					},
				},
			},
		});
		const fullContext = createProviderContextDouble();
		const derivedContext: Context = {
			trace: fullContext.trace,
			request: fullContext.request,
		};

		await expect(executeOperation(provider, "probe", derivedContext, {})).rejects.toMatchObject({
			options: { code: "MISSING_SECRET" },
		});
	});

	it("rejects ambient trace and unknown declaration capabilities", () => {
		defineProvider({
			id: "capability-trace-declaration",
			version: "1.0.0",
			runtime: "standard",
			meta,
			// @ts-expect-error test-invalid: trace is ambient and cannot be declared.
			trace: {},
		});
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
