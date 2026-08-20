import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { defineAuthFlow } from "../ceremonies/index.js";
import {
	defineOperation,
	defineProvider,
	ProviderError,
	z as providerZ,
} from "../provider.js";
import type {
	AuthFlowDefinition,
	AuthMode,
	BrowserEngine,
	CookieJar,
	FlowContext,
	ProviderContext,
	ProviderDefinition,
	ProviderMeta,
	StealthFetchOptions,
	StealthPlatform,
	StealthProfile,
	StealthResponse,
} from "../types.js";

describe("ProviderDefinition types", () => {
	it("should allow valid provider meta", () => {
		const meta = {
			displayName: "AirKorea Realtime",
			displayNameKey: "meta.title",
			descriptionKey: "meta.description",
			category: "finance",
			tags: ["prices"],
			icon: "./icon.png",
			docTitleKey: "meta.docTitle",
			docDescriptionKey: "meta.docDescription",
			docSummaryKey: "meta.docSummary",
			normalizationNotesKeys: ["meta.normalizationNotes.0"],
			publicProfile: {
				displayNameKey: "publicProfile.displayName",
				shortDescriptionKey: "publicProfile.shortDescription",
				longDescriptionKey: "publicProfile.longDescription",
				capabilityKeys: ["publicProfile.capabilities.0"],
				examplePromptKeys: ["publicProfile.examplePrompts.0"],
				setupSummaryKey: "publicProfile.setupSummary",
				requirementKeys: ["publicProfile.requirements.0"],
				limitationKeys: ["publicProfile.limitations.0"],
			},
		} satisfies ProviderMeta;

		expect(meta.displayName).toBe("AirKorea Realtime");
		expect(meta.category).toBe("finance");
	});

	it("should enforce id format via pattern test", () => {
		const validId = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)+$/.test("korea-air-quality");
		expect(validId).toBe(true);

		const invalidId = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)+$/.test("AirKoreaRealtime");
		expect(invalidId).toBe(false);
	});

	it("should support all auth modes", () => {
		const modes = [
			"none",
			"platform-managed",
			"credentials",
			"oauth2",
		] as const satisfies readonly AuthMode[];
		expect(modes).toContain("none");
		expect(modes).toContain("credentials");
	});

	it("rejects auth start handlers that declare input at runtime", () => {
		const noop = defineOperation({
			descriptionKey: "operations.noop.description",
			input: providerZ.object({}),
			output: providerZ.object({ ok: providerZ.boolean() }),
			handler: async () => ({ ok: true }),
		});

		expect(() =>
			// @ts-expect-error test-invalid: runtime validation must reject auth start handlers that declare input.
			defineProvider({
				id: "bad-auth-start",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "Bad Auth Start",
					descriptionKey: "providers.badAuthStart.description",
					category: "test",
				},
				auth: {
					mode: "credentials",
					flow: {
						start: async (_ctx: FlowContext, _input?: Record<string, unknown>) => ({
							kind: "form",
							turnId: "start",
						}),
						continue: async () => ({ kind: "complete", turnId: "complete" }),
					},
				},
				operations: { noop },
			}),
		).toThrow(/auth\.flow\.start must not declare an input parameter/);
	});

	it("rejects defaulted auth start input without rejecting no-input handlers", () => {
		const noop = defineOperation({
			descriptionKey: "operations.noop.description",
			input: providerZ.object({}),
			output: providerZ.object({ ok: providerZ.boolean() }),
			handler: async () => ({ ok: true }),
			healthCheckUnsupported: { reason: "test fixture" },
		});
		const defaultedInputStart = async (
			_ctx: FlowContext,
			_input: Record<string, unknown> = {},
		) => ({
			kind: "form" as const,
			turnId: "start",
		});
		const defineInvalidProvider = () =>
			// @ts-expect-error test-invalid: runtime validation must reject defaulted auth start input hidden from Function.length.
			defineProvider({
				id: "defaulted-auth-start",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "Defaulted Auth Start",
					descriptionKey: "providers.defaultedAuthStart.description",
					category: "test",
				},
				auth: {
					mode: "credentials",
					flow: {
						start: defaultedInputStart,
						continue: async () => ({ kind: "complete", turnId: "complete" }),
					},
				},
				operations: { noop },
			});

		expect(defaultedInputStart.length).toBe(1);
		expect(defineInvalidProvider).toThrow(ProviderError);
		expect(defineInvalidProvider).toThrow(
			/auth\.flow\.start must not declare an input parameter/,
		);

		const contextOnlyProvider = defineProvider({
			id: "context-only-auth-start",
			version: "1.0.0",
			runtime: "standard",
			meta: {
				displayName: "Context Only Auth Start",
				descriptionKey: "providers.contextOnlyAuthStart.description",
				category: "test",
			},
			auth: {
				mode: "credentials",
				flow: {
					start: async (_ctx: FlowContext) => ({ kind: "form", turnId: "start" }),
					continue: async () => ({ kind: "complete", turnId: "complete" }),
				},
			},
			operations: { noop },
		});
		const noParameterProvider = defineProvider({
			id: "no-parameter-auth-start",
			version: "1.0.0",
			runtime: "standard",
			meta: {
				displayName: "No Parameter Auth Start",
				descriptionKey: "providers.noParameterAuthStart.description",
				category: "test",
			},
			auth: {
				mode: "credentials",
				flow: {
					start: async () => ({ kind: "form", turnId: "start" }),
					continue: async () => ({ kind: "complete", turnId: "complete" }),
				},
			},
			operations: { noop },
		});

		expect(contextOnlyProvider.id).toBe("context-only-auth-start");
		expect(noParameterProvider.id).toBe("no-parameter-auth-start");
	});

	it("does not reject one-parameter function handlers with misleading body or comments", () => {
		const noop = defineOperation({
			descriptionKey: "operations.noop.description",
			input: providerZ.object({}),
			output: providerZ.object({ ok: providerZ.boolean() }),
			handler: async () => ({ ok: true }),
			healthCheckUnsupported: { reason: "test fixture" },
		});
		const nestedArrow: unknown = Function(
			"return function start(ctx) { const h = (context, input = {}) => input; return h(ctx, {}); }",
		)();
		const blockComment: unknown = Function(
			"return function start(ctx /*, input = {} */) { return ctx; }",
		)();
		const lineComment: unknown = Function(
			"return function start(ctx // , input = {}\n) { return ctx; }",
		)();
		const makeProvider = (id: string, start: unknown): unknown =>
			Reflect.apply(defineProvider, undefined, [
				{
					id,
					version: "1.0.0",
					runtime: "standard",
					meta: {
						displayName: "One Parameter Auth Start",
						descriptionKey: "providers.oneParameterAuthStart.description",
						category: "test",
					},
					auth: {
						mode: "credentials",
						flow: {
							start,
							continue: async () => ({ kind: "complete", turnId: "complete" }),
						},
					},
					operations: { noop },
				},
			]);

		expect(() => makeProvider("nested-arrow-auth-start", nestedArrow)).not.toThrow();
		expect(() => makeProvider("block-comment-auth-start", blockComment)).not.toThrow();
		expect(() => makeProvider("line-comment-auth-start", lineComment)).not.toThrow();

		const functionDefaulted = async function start(
			_ctx: FlowContext,
			_input: Record<string, unknown> = {},
		) {
			return { kind: "form" as const, turnId: "start" };
		};
		expect(() =>
			// @ts-expect-error test-invalid: runtime validation must reject defaulted auth start input in function declarations.
			defineProvider({
				id: "function-defaulted-auth-start",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "Function Defaulted Auth Start",
					descriptionKey: "providers.functionDefaultedAuthStart.description",
					category: "test",
				},
				auth: {
					mode: "credentials",
					flow: {
						start: functionDefaulted,
						continue: async () => ({ kind: "complete", turnId: "complete" }),
					},
				},
				operations: { noop },
			}),
		).toThrow(/auth\.flow\.start must not declare an input parameter/);
	});

	it("does not reject ambiguous auth start handler source shapes", () => {
		const noop = defineOperation({
			descriptionKey: "operations.noop.description",
			input: providerZ.object({}),
			output: providerZ.object({ ok: providerZ.boolean() }),
			handler: async () => ({ ok: true }),
			healthCheckUnsupported: { reason: "test fixture" },
		});
		const minifiedStart: unknown = Function(
			"return async (c,i={}) => ({ kind: 'form', turnId: 'start' })",
		)();
		const boundStart = (
			async (_ctx: FlowContext) => ({ kind: "form", turnId: "start" })
		).bind(undefined);
		const destructuredDefaultStart = async (
			{ context: _context } = { context: undefined },
		) => ({
			kind: "form",
			turnId: "start",
		});
		const defineUncheckedProvider = (id: string, start: unknown): unknown =>
			Reflect.apply(defineProvider, undefined, [
				{
					id,
					version: "1.0.0",
					runtime: "standard",
					meta: {
						displayName: "Ambiguous Auth Start",
						descriptionKey: "providers.ambiguousAuthStart.description",
						category: "test",
					},
					auth: {
						mode: "credentials",
						flow: {
							start,
							continue: async () => ({ kind: "complete", turnId: "complete" }),
						},
					},
					operations: { noop },
				},
			]);

		for (const [id, start] of [
			["minified-auth-start", minifiedStart],
			["bound-auth-start", boundStart],
			["destructured-auth-start", destructuredDefaultStart],
		] as const) {
			expect(() => defineUncheckedProvider(id, start)).not.toThrow();
		}
	});

	it("rejects defaulted auth start input at the flow definition boundary", () => {
		// @ts-expect-error test-invalid: auth start handlers must receive user input through continue, including when the second parameter is defaulted.
		const flow = defineAuthFlow({
			start: async (_ctx: FlowContext, _input: Record<string, unknown> = {}) => ({
				kind: "form",
				turnId: "start",
			}),
			continue: async () => ({ kind: "complete", turnId: "complete" }),
		});

		expect(flow.start.length).toBe(1);
	});

	it("documents the known compile-time limitation for widened auth flows", () => {
		const noop = defineOperation({
			descriptionKey: "operations.noop.description",
			input: providerZ.object({}),
			output: providerZ.object({ ok: providerZ.boolean() }),
			handler: async () => ({ ok: true }),
			healthCheckUnsupported: { reason: "test fixture" },
		});
		const widenedFlow: AuthFlowDefinition = {
			start: async (_ctx: FlowContext, _input: Record<string, unknown> = {}) => ({
				kind: "form",
				turnId: "start",
			}),
			continue: async () => ({ kind: "complete", turnId: "complete" }),
		};
		const makeWidenedFlow = (): AuthFlowDefinition => ({
			start: async (_ctx: FlowContext, _input: Record<string, unknown> = {}) => ({
				kind: "form",
				turnId: "start",
			}),
			continue: async () => ({ kind: "complete", turnId: "complete" }),
		});

		// Known limitation: annotation, declared factory returns, and spreading a widened
		// flow defeat the compile-time guard. Branding closes this in a future major;
		// defineProvider runtime validation catches these shapes in practice.
		const fromAnnotatedVariable = defineAuthFlow(widenedFlow);
		const fromDeclaredFactory = defineAuthFlow(makeWidenedFlow());
		const fromWidenedSpread = defineAuthFlow({ ...widenedFlow });

		expect([
			fromAnnotatedVariable.start.length,
			fromDeclaredFactory.start.length,
			fromWidenedSpread.start.length,
		]).toEqual([1, 1, 1]);

		for (const [id, flow] of [
			["annotated-widened-auth", fromAnnotatedVariable],
			["factory-widened-auth", fromDeclaredFactory],
			["spread-widened-auth", fromWidenedSpread],
		] as const) {
			const defineWidenedProvider = () =>
				defineProvider({
					id,
					version: "1.0.0",
					runtime: "standard",
					meta: {
						displayName: "Widened Auth Flow",
						descriptionKey: "providers.widenedAuthFlow.description",
						category: "test",
					},
					auth: { mode: "credentials", flow },
					operations: { noop },
				});

			expect(defineWidenedProvider).toThrow(ProviderError);
			expect(defineWidenedProvider).toThrow(
				/auth\.flow\.start must not declare an input parameter/,
			);
		}
	});

	it("rejects legacy auth exchange handlers at runtime", () => {
		const noop = defineOperation({
			descriptionKey: "operations.noop.description",
			input: providerZ.object({}),
			output: providerZ.object({ ok: providerZ.boolean() }),
			handler: async () => ({ ok: true }),
		});

		expect(() =>
			defineProvider({
				id: "bad-auth-exchange",
				version: "1.0.0",
				runtime: "standard",
				meta: {
					displayName: "Bad Auth Exchange",
					descriptionKey: "providers.badAuthExchange.description",
					category: "test",
				},
				auth: {
					mode: "credentials",
					flow: {
						start: async () => ({ kind: "form", turnId: "start" }),
						continue: async () => ({ kind: "complete", turnId: "complete" }),
					},
					exchange: async () => ({ session: "cookie" }),
				},
				operations: { noop },
			}),
		).toThrow(/auth\.exchange is not part of the Provider SDK auth contract/);
	});

	it("should type a complete provider definition", () => {
		const definition = {
			id: "korea-air-quality",
			version: "1.0.0",
			runtime: "standard" as const,
			stealth: {
				profile: "chrome-146",
				platform: "macos" as StealthPlatform,
			},
			proxy: true,
			browser: {
				engine: "nodriver" as BrowserEngine,
			},
			auth: {
				mode: "oauth2",
				flow: {
					start: async (_ctx: FlowContext) => ({
						kind: "redirect",
						turnId: "turn-1",
					}),
					continue: async (_ctx: FlowContext, _input) => ({
						kind: "complete",
						turnId: "turn-2",
					}),
				},
			},
			secrets: [{ name: "NOTION_OAUTH_CLIENT_ID", required: true }],
			credential: {
				keys: ["access_token"],
				storesReusableSecret: true,
				justification: "OAuth access token reuse is required for API calls.",
			},
			context: { keys: ["state"] },
			meta: {
				displayName: "AirKorea Realtime",
				descriptionKey: "meta.description",
				category: "finance",
				tags: ["prices"],
				icon: "./icon.png",
			},
			operations: {
				search: {
					descriptionKey: "operations.search.description",
					input: z.object({ query: z.string() }),
					output: z.object({ results: z.array(z.string()) }),
					handler: async (_ctx: ProviderContext, input) => {
						const parsed = z.object({ query: z.string() }).parse(input);

						return {
							results: [parsed.query],
						};
					},
					fixtures: {
						request: { query: "bitcoin" },
						response: { results: ["bitcoin"] },
					},
					hints: {
						query: "Coin symbol or asset name",
					},
				},
			},
		} satisfies ProviderDefinition;

		expect(definition.id).toBe("korea-air-quality");
		expect(definition.operations.search.descriptionKey).toBe("operations.search.description");
		expect(definition.auth?.mode).toBe("oauth2");
	});

	it("should type stealth profiles", () => {
		const stealthProfile = {
			name: "chrome-146-macos",
			platform: "macos",
			version: "146",
			userAgent: "Mozilla/5.0",
			headerOrder: ["Host", "User-Agent"],
		} satisfies StealthProfile;

		expect(stealthProfile.platform).toBe("macos");
	});

	it("should type stealth fetch options and response extensions", async () => {
		const cookies: CookieJar = {
			get: (name) => (name === "sid" ? "abc" : undefined),
			getAll: () => ({ sid: "abc" }),
			toString: () => "sid=abc",
		};

		const options = {
			method: "GET",
			maxBodyBytes: 1_000_000,
			profile: "chrome-146",
			stealth: {
				insecureSkipVerify: true,
			},
		} satisfies StealthFetchOptions;

		const response: StealthResponse = {
			arrayBuffer: async () => new TextEncoder().encode('{"ok":true}').buffer,
			bytes: async () => new TextEncoder().encode('{"ok":true}'),
			status: 200,
			ok: true,
			headers: { "content-type": "application/json" },
			rawHeaders: [["content-type", "application/json"]],
			body: '{"ok":true}',
			cookies,
			json: async <T>() => JSON.parse('{"ok":true}') as T,
		};

		expect(options.stealth?.insecureSkipVerify).toBe(true);
		expect(options.maxBodyBytes).toBe(1_000_000);
		expect(response.cookies.get("sid")).toBe("abc");
		await expect(response.json<{ ok: boolean }>()).resolves.toEqual({
			ok: true,
		});
	});
});
