import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { defineOperation, defineProvider, z as providerZ } from "../provider.js";
import type {
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
						start: (async (_ctx: FlowContext, _input?: Record<string, unknown>) => ({
							kind: "form",
							turnId: "start",
						})) as never,
						continue: async () => ({ kind: "complete", turnId: "complete" }),
					},
				},
				operations: { noop },
			}),
		).toThrow(/auth\.flow\.start must not declare an input parameter/);
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
				} as never,
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
		expect(response.cookies.get("sid")).toBe("abc");
		await expect(response.json<{ ok: boolean }>()).resolves.toEqual({
			ok: true,
		});
	});
});
