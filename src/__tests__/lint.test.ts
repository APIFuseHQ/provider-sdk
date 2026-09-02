import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { lintOperation, lintProvider } from "../lint.js";
import { describeKey, fields } from "../schema.js";
import type {
	AuthMode,
	OperationApprovalPolicy,
	OperationRiskClass,
} from "../types.js";

const READ_RISK_CLASS: OperationRiskClass = "read";

function withDescriptionKey<TSchema extends z.ZodType>(schema: TSchema, key: string): TSchema {
	return describeKey(schema, key);
}

describe("lintOperation", () => {
	it("reports expected diagnostics for weak operation metadata", () => {
		const diagnostics = lintOperation({
			input: z.object({
				filters: z.object({ ids: z.array(z.string()) }),
			}),
			output: z.object({ result: z.string() }),
			fixtures: { request: { filters: { ids: ["btc"] } } },
		});

		expect(diagnostics.some((item) => item.rule === "description-key-required")).toBe(true);
		expect(diagnostics.some((item) => item.rule === "schema-description-key-required")).toBe(true);
		expect(diagnostics.some((item) => item.rule === "fixtures-both-directions")).toBe(true);
	});

	it("accepts key-only operation descriptions", () => {
		const diagnostics = lintOperation({
			descriptionKey: "operations.search.description",
			input: withDescriptionKey(
				z.object({
					query: withDescriptionKey(z.string(), "operations.search.fields.query.description"),
				}),
				"operations.search.input.description",
			),
			output: withDescriptionKey(
				z.object({
					result: withDescriptionKey(z.string(), "operations.search.fields.result.description"),
				}),
				"operations.search.output.description",
			),
			fixtures: {
				request: { query: "cup" },
				response: { result: "cup" },
			},
		});

		expect(diagnostics.some((item) => item.rule === "description-key-required")).toBe(false);
		expect(
			diagnostics.some(
				(item) =>
					item.rule === "schema-description-raw-prose" ||
					item.rule === "schema-description-key-required",
			),
		).toBe(false);
	});

	it("accepts key-owned simple operations", () => {
		const diagnostics = lintOperation({
			descriptionKey: "operations.price.description",
			input: withDescriptionKey(
				z.object({
					symbol: withDescriptionKey(z.string(), "operations.price.fields.symbol.description"),
				}),
				"operations.price.input.description",
			),
			output: withDescriptionKey(
				z.object({
					price: withDescriptionKey(z.number(), "operations.price.fields.price.description"),
				}),
				"operations.price.output.description",
			),
			fixtures: {
				request: { symbol: "BTC" },
				response: { price: 100 },
			},
		});

		expect(diagnostics).toEqual([]);
	});

	it("rejects raw schema descriptions", () => {
		const diagnostics = lintOperation({
			descriptionKey: "operations.search.description",
			input: z.object({ query: z.string().describe("Search keyword") }).describe("Search input"),
			output: withDescriptionKey(
				z.object({
					ok: withDescriptionKey(z.boolean(), "operations.search.fields.ok.description"),
				}),
				"operations.search.output.description",
			),
			fixtures: { request: { query: "desk" }, response: { ok: true } },
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({ rule: "schema-description-raw-prose" }),
		);
	});

	it("does not require duplicate descriptions on transparent wrapper internals", () => {
		const diagnostics = lintOperation({
			descriptionKey:
				"Use this operation when a caller needs described optional, defaulted, array, and record fields and when wrapper internals should inherit the public field description instead of producing duplicate diagnostics.",
			input: z
				.object({
					keyword: z.string().default("").describe("Keyword filter supplied by the caller"),
					page: z.number().int().optional().describe("Optional page number"),
				})
				.describe("Wrapped input schema"),
			output: z
				.object({
					items: z
						.array(
							z.object({
								id: z.string().describe("Stable item id"),
								metadata: z.record(z.string(), z.string()).describe("Open-world metadata map"),
							}),
						)
						.describe("Returned item rows"),
				})
				.describe("Wrapped output schema"),
			fixtures: {
				request: { keyword: "cup", page: 1 },
				response: { items: [{ id: "1", metadata: { color: "red" } }] },
			},
		});

		expect(diagnostics.filter((item) => item.rule === "all-fields-described")).toEqual([]);
	});

	it("does not require duplicate descriptions on pipe input and output internals", () => {
		const normalizedCode = z
			.preprocess(
				(value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
				z.enum(["A", "B"]).describe("Normalized finite code"),
			)
			.describe("Normalized finite code");

		const diagnostics = lintOperation({
			descriptionKey:
				"Use this operation when callers may provide friendly code aliases and when the provider must normalize those aliases into a documented finite code before sending the upstream request.",
			input: z
				.object({
					code: normalizedCode.describe("Code or supported alias to normalize"),
				})
				.describe("Normalization input schema"),
			output: z
				.object({
					code: z.enum(["A", "B"]).describe("Normalized finite code"),
				})
				.describe("Normalization output schema"),
			fixtures: {
				request: { code: "a" },
				response: { code: "A" },
			},
		});

		expect(diagnostics.filter((item) => item.rule === "all-fields-described")).toEqual([]);
	});

	it("still requires descriptions for indexed union branches", () => {
		const diagnostics = lintOperation({
			descriptionKey:
				"Use this operation when callers need one of several documented response envelopes and each indexed union branch must remain part of the public contract surface instead of being hidden as an internal wrapper.",
			input: z
				.object({
					mode: z
						.enum(["success", "failure"])
						.describe("Fixture mode that selects the response branch"),
				})
				.describe("Union branch fixture input"),
			output: z
				.union([
					z.object({
						ok: z.string().describe("Successful branch payload"),
					}),
					z.object({
						error: z.string().describe("Failure branch payload"),
					}),
				])
				.describe("Union output schema"),
			fixtures: {
				request: { mode: "success" },
				response: { ok: "yes" },
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				field: "output[0]",
				rule: "schema-description-key-required",
			}),
		);
	});

	it("does not treat public fields prefixed with element as array wrappers", () => {
		const diagnostics = lintOperation({
			descriptionKey:
				"Use this operation when public field names happen to start with element and those fields must still be linted as ordinary response contract properties.",
			input: z
				.object({
					id: z.string().describe("Identifier to look up"),
				})
				.describe("Element field fixture input"),
			output: z
				.object({
					elementId: z.string(),
				})
				.describe("Element field output"),
			fixtures: {
				request: { id: "abc" },
				response: { elementId: "el_123" },
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				field: "output.elementId",
				rule: "schema-description-key-required",
			}),
		);
	});

	it("warns when suspicious sensitive fields are not marked", () => {
		const diagnostics = lintOperation({
			descriptionKey:
				"Use this operation when callers submit credential-bearing login details and when invocation observability must redact sensitive provider payload fields automatically.",
			input: z
				.object({
					password: z.string().describe("Password credential"),
				})
				.describe("Login input"),
			output: z
				.object({
					accessToken: fields.token().describe("Access token returned upstream"),
				})
				.describe("Login output"),
			fixtures: {
				request: { password: "secret" },
				response: { accessToken: "token" },
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				field: "input.password",
				rule: "sensitive-field-unmarked",
			}),
		);
		expect(
			diagnostics.find(
				(item) => item.field === "output.accessToken" && item.rule === "sensitive-field-unmarked",
			),
		).toBeUndefined();
	});
});

describe("lintProvider", () => {
	it("prefixes diagnostics with operation paths", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			operations: {
				lookup: {
					descriptionKey: "Short description",
					input: z.object({ symbol: z.string() }),
					output: z.object({ price: z.number() }),
				},
			},
			reviewed: "first-party",
		});

		expect(diagnostics[0]?.field?.startsWith("operations.lookup")).toBe(true);
	});

	it("rejects empty allowedHosts", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: [],
			reviewed: "first-party",
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "allowed-hosts-non-empty",
				level: "error",
			}),
		);
	});

	it("rejects wildcard allowedHosts", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["*"],
			reviewed: "first-party",
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "allowed-hosts-no-wildcards",
				level: "error",
			}),
		);
	});

	it("flags removed api-key auth mode", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			auth: { mode: "api-key" },
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({ rule: "auth-mode-api-key-removed" }),
		);
	});

	it("requires auth.flow.continue for credentials and oauth2 modes", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			auth: { mode: "credentials", flow: { start: async () => ({}) } },
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({ rule: "auth-flow-continue-required" }),
		);
	});

	it("rejects legacy auth.exchange so auth has one canonical interface", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			auth: {
				mode: "credentials",
				flow: { continue: async () => ({ kind: "complete", turnId: "1" }) },
				// test-invalid: lint must reject the removed legacy auth exchange field.
				exchange: async () => ({ session: "cookie" }),
				// test-invalid: the legacy auth object deliberately bypasses the current declaration shape.
			} as never,
			credential: {
				keys: ["session"],
				storesReusableSecret: true,
				justification: "Session cookie is required for private operations.",
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "auth-exchange-unsupported",
				field: "auth.exchange",
			}),
		);
	});

	it("does not crash when malformed auth is primitive", () => {
		expect(() =>
			lintProvider({
				id: "demo-provider",
				allowedHosts: ["api.example.com"],
				reviewed: "first-party",
				// test-invalid: lint crash resistance deliberately receives primitive auth metadata.
				auth: "credentials" as never,
			}),
		).not.toThrow();
	});

	it("rejects login-like operations on authenticated providers so auth flow remains canonical", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			auth: {
				mode: "credentials",
				flow: { continue: async () => ({ kind: "complete", turnId: "1" }) },
			},
			credential: {
				keys: ["session"],
				storesReusableSecret: true,
				justification: "Session cookie is required for private operations.",
			},
			operations: {
				"auth-login-with-password": {
					descriptionKey: "operations.authLogin.description",
					input: withDescriptionKey(z.object({}), "operations.authLogin.input.description"),
					output: withDescriptionKey(
						z.object({
							ok: withDescriptionKey(z.boolean(), "operations.authLogin.fields.ok.description"),
						}),
						"operations.authLogin.output.description",
					),
					fixtures: { request: {}, response: { ok: true } },
				},
				"login-with-password": {
					descriptionKey: "operations.login.description",
					input: withDescriptionKey(z.object({}), "operations.login.input.description"),
					output: withDescriptionKey(
						z.object({
							ok: withDescriptionKey(z.boolean(), "operations.login.fields.ok.description"),
						}),
						"operations.login.output.description",
					),
					fixtures: { request: {}, response: { ok: true } },
				},
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "auth-operation-unsupported",
				field: "operations.auth-login-with-password",
			}),
		);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "auth-operation-unsupported",
				field: "operations.login-with-password",
			}),
		);
	});

	it("requires credential keys for credentials mode", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			auth: {
				mode: "credentials",
				flow: { continue: async () => ({ kind: "complete", turnId: "1" }) },
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "credential-keys-required-when-credentials-mode",
			}),
		);
	});

	it("requires reusable secret justification when durable secrets are persisted", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			auth: {
				mode: "oauth2",
				flow: { continue: async () => ({ kind: "complete", turnId: "1" }) },
			},
			credential: { keys: ["refresh_token"] },
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({ rule: "credential-reusable-secret" }),
		);
	});

	it("requires reusable secret opt-in when refresh may silently re-login", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			auth: {
				mode: "credentials",
				flow: {
					start: async () => ({ kind: "input", turnId: "1" }),
					continue: async () => ({ kind: "complete", turnId: "2" }),
					refresh: async () => ({ kind: "complete", turnId: "3" }),
				},
			},
			credential: { keys: ["username", "password"] },
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({ rule: "auth-refresh-reusable-secret" }),
		);
	});

	it("blocks credential writes in operation handlers but allows return-based refresh handlers", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			auth: {
				mode: "credentials",
				flow: {
					start: async () => ({ kind: "input", turnId: "1" }),
					continue: async () => ({ kind: "complete", turnId: "2" }),
					refresh: async () => ({
						kind: "complete",
						turnId: "3",
						data: { credential: { session: "fresh" } },
					}),
				},
			},
			credential: {
				keys: ["session"],
				storesReusableSecret: true,
				justification: "Session cookies are required for upstream calls.",
			},
			operations: {
				search: {
					descriptionKey:
						"Use this operation when callers need a fixture that proves operation handlers cannot write credentials.",
					input: z.object({ query: z.string().describe("Search query") }),
					output: z.object({ ok: z.boolean().describe("Success flag") }),
					fixtures: { request: { query: "desk" }, response: { ok: true } },
					source:
						"async function handler(ctx) { ctx.credential.set('session', 'bad'); return { ok: true }; }",
				},
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "ctx-credential-write-forbidden-in-handler",
			}),
		);
	});

	it("warns when ctx.context is used without declared context keys", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			auth: {
				mode: "oauth2",
				flow: { continue: async () => ({ kind: "complete", turnId: "1" }) },
			},
			authFlowSource: "async function start(ctx) { return ctx.context.get('state'); }",
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "context-keys-required",
				level: "warn",
			}),
		);
	});

	it("requires provider.stealth when operation source uses ctx.stealth", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			operations: {
				search: {
					descriptionKey:
						"Use this operation when callers need protected search results and when the provider must explicitly opt into browser-like stealth transport instead of relying on implicit HTTP behavior.",
					input: z.object({ query: z.string().describe("Search query") }),
					output: z.object({ ok: z.boolean().describe("Success flag") }),
					fixtures: { request: { query: "desk" }, response: { ok: true } },
					source: "async function handler(ctx) { return ctx.stealth.fetch('/search'); }",
				},
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				field: "operations.search",
				message:
					'Provider "demo-provider" operation "search" uses ctx.stealth but provider.stealth is not declared.',
				rule: "stealth-config-required",
			}),
		);
	});

	it("allows ctx.stealth when provider.stealth is declared", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			stealth: { profile: "chrome-146", platform: "macos" },
			operations: {
				search: {
					descriptionKey:
						"Use this operation when callers need protected search results and when the provider has explicitly declared the stealth profile required by the source code.",
					input: z.object({ query: z.string().describe("Search query") }),
					output: z.object({ ok: z.boolean().describe("Success flag") }),
					fixtures: { request: { query: "desk" }, response: { ok: true } },
					source: "async function handler(ctx) { return ctx.stealth.fetch('/search'); }",
				},
			},
		});

		expect(diagnostics.some((diagnostic) => diagnostic.rule === "stealth-config-required")).toBe(
			false,
		);
	});

	it("warns when provider source imports playwright directly", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			operations: {
				search: {
					descriptionKey:
						"Use this operation when callers need browser-backed upstream access and when the provider should use the SDK browser abstraction instead of importing browser runtimes directly.",
					input: z.object({ query: z.string().describe("Search query") }),
					output: z.object({ ok: z.boolean().describe("Success flag") }),
					fixtures: { request: { query: "desk" }, response: { ok: true } },
					source:
						'import { chromium } from "playwright-core"; async function handler(ctx) { return { ok: true }; }',
				},
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				field: "operations.search.handler",
				level: "warn",
				rule: "playwright-direct-import",
			}),
		);
	});

	it("warns when top-level provider files import playwright directly", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			providerSourceFiles: {
				"index.ts": 'import { chromium } from "playwright-core"; export default provider;',
			},
			operations: {
				search: {
					riskClass: READ_RISK_CLASS,
					descriptionKey:
						"Use this operation when callers need browser-backed upstream access and when the provider should use the SDK browser abstraction instead of importing browser runtimes directly.",
					input: z.object({ query: z.string().describe("Search query") }),
					output: z.object({ ok: z.boolean().describe("Success flag") }),
					fixtures: { request: { query: "desk" }, response: { ok: true } },
					handler: async () => ({ ok: true }),
				},
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				field: "sourceFiles.index.ts",
				level: "warn",
				rule: "playwright-direct-import",
			}),
		);
	});

	it("errors on official self-hosted browser runtime patterns across nested files and entrypoint scripts", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			providerSourceFiles: {
				"src/browser/page.ts": `
import { chromium } from "playwright";
export async function open() {
  return chromium.launch();
}
`,
				"scripts/start-browser.mjs": `
import { spawn } from "node:child_process";
spawn("google-chrome", ["--remote-debugging-port=9222"]);
`,
				"src/cdp.ts": `
const endpoint = process.env.AMAZON_CDP_URL;
await fetch(endpoint + "/json/version");
`,
			},
			operations: {
				search: {
					riskClass: READ_RISK_CLASS,
					descriptionKey:
						"Use this operation when callers need browser-backed upstream access and when the provider should use the SDK browser abstraction instead of self-hosting browser runtimes.",
					input: z.object({ query: z.string().describe("Search query") }),
					output: z.object({ ok: z.boolean().describe("Success flag") }),
					fixtures: { request: { query: "desk" }, response: { ok: true } },
					handler: async () => ({ ok: true }),
				},
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				field: "sourceFiles.src/browser/page.ts",
				level: "error",
				rule: "browser-self-hosted-launch",
			}),
		);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				field: "sourceFiles.scripts/start-browser.mjs",
				level: "error",
				rule: "browser-self-hosted-child-process",
			}),
		);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				field: "sourceFiles.src/cdp.ts",
				level: "error",
				rule: "browser-provider-local-cdp-env",
			}),
		);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				field: "sourceFiles.src/cdp.ts",
				level: "error",
				rule: "browser-direct-cdp-version-poll",
				message: expect.stringContaining("ctx.browser"),
			}),
		);
	});

	it("warns on standalone self-hosted browser runtime patterns", () => {
		const diagnostics = lintProvider(
			{
				id: "demo-provider",
				allowedHosts: ["api.example.com"],
				reviewed: "community",
				providerSourceFiles: {
					"src/browser.ts":
						'const browser = await puppeteer.launch(); const ws = process.env["DEMO_CDP_URL"];',
				},
			},
			{ mode: "standalone" },
		);

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				level: "warn",
				rule: "browser-self-hosted-launch",
			}),
		);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				level: "warn",
				rule: "browser-provider-local-cdp-env",
			}),
		);
	});

	it("allows managed pool env references and non-source docs outside providerSourceFiles", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			providerSourceFiles: {
				"src/browser.ts": "const pool = process.env.APIFUSE__CDP_POOL__URL;",
			},
		});

		expect(diagnostics.some((diagnostic) => diagnostic.rule.startsWith("browser-"))).toBe(false);
	});

	it("rejects credential keys for platform-managed auth mode", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			auth: { mode: "platform-managed" },
			credential: { keys: ["access_token"] },
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({ rule: "platform-managed-no-credential-keys" }),
		);
	});

	it("passes new auth-model rules for a valid oauth2 provider", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			auth: {
				mode: "oauth2",
				flow: {
					start: async () => ({ kind: "redirect", turnId: "1" }),
					continue: async () => ({ kind: "complete", turnId: "2" }),
				},
			},
			credential: {
				keys: ["access_token", "refresh_token"],
				storesReusableSecret: true,
				justification: "Tokens must be reused across requests.",
			},
			context: { keys: ["state"] },
			authFlowSource: "async function start(ctx) { return ctx.context.get('state'); }",
		});

		expect(
			diagnostics.some((diagnostic) =>
				[
					"auth-mode-api-key-removed",
					"auth-flow-continue-required",
					"credential-keys-required-when-credentials-mode",
					"credential-reusable-secret",
					"context-keys-required",
					"platform-managed-no-credential-keys",
				].includes(diagnostic.rule),
			),
		).toBe(false);
	});
});

describe("lintProvider thrown-error-code-undeclared", () => {
	const undeclaredRule = (item: { rule: string }) => item.rule === "thrown-error-code-undeclared";

	function providerWithSources(
		providerSourceFiles: Record<string, string>,
		errorCodes: ReadonlyArray<{ code: string; status?: 400 | 409; description: string }> = [],
	) {
		return {
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party" as const,
			providerSourceFiles,
			operations: {
				lookup: {
					riskClass: READ_RISK_CLASS,
					descriptionKey: "operations.lookup.description",
					input: withDescriptionKey(
						z.object({
							symbol: withDescriptionKey(z.string(), "operations.lookup.fields.symbol.description"),
						}),
						"operations.lookup.input.description",
					),
					output: withDescriptionKey(
						z.object({
							price: withDescriptionKey(z.number(), "operations.lookup.fields.price.description"),
						}),
						"operations.lookup.output.description",
					),
					fixtures: { request: { symbol: "BTC" }, response: { price: 100 } },
					errorCodes: [...errorCodes],
				},
			},
		};
	}

	it("warns on a literal thrown code that no operation declares", () => {
		const diagnostics = lintProvider(
			providerWithSources({
				"upstream/client.ts": `throw new ProviderError("sold out", { retryable: false, code: "ITEM_SOLD_OUT" });`,
			}),
		).filter(undeclaredRule);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				rule: "thrown-error-code-undeclared",
				level: "warn",
				field: "sourceFiles.upstream/client.ts",
			}),
		]);
		expect(diagnostics[0]?.message).toContain('"ITEM_SOLD_OUT"');
		expect(diagnostics[0]?.message).toContain("upstream/client.ts");
		expect(diagnostics[0]?.message).toContain("errorCodes");
	});

	it("stays silent when any operation declares the thrown code", () => {
		const diagnostics = lintProvider(
			providerWithSources(
				{
					"upstream/client.ts": `throw new ProviderError("sold out", { code: "ITEM_SOLD_OUT" });`,
				},
				[{ code: "ITEM_SOLD_OUT", status: 409, description: "Upstream refused the purchase." }],
			),
		).filter(undeclaredRule);

		expect(diagnostics).toEqual([]);
	});

	it("stays silent for SDK-registered codes", () => {
		const diagnostics = lintProvider(
			providerWithSources({
				"index.ts": [
					`throw new ProviderError("upstream broke", { code: "UPSTREAM_ERROR" });`,
					`throw new ProviderError("secret missing", { code: "MISSING_SECRET" });`,
					`throw new ProviderError("relog", { code: "reauth_required" });`,
				].join("\n"),
			}),
		).filter(undeclaredRule);

		expect(diagnostics).toEqual([]);
	});

	it("skips computed or dynamic codes silently", () => {
		const diagnostics = lintProvider(
			providerWithSources({
				"index.ts": [
					`throw new ProviderError("dyn", { code: upstreamCode });`,
					// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture intentionally embeds a template expression as source text.
					'throw new ProviderError("tpl", { code: `UPSTREAM_${kind}` });',
					`throw new ProviderError("ternary", { code: soldOut ? "A_CODE" : "B_CODE" });`,
					`throw new ProviderError("concat", { code: "PREFIX_" + suffix });`,
				].join("\n"),
			}),
		).filter(undeclaredRule);

		expect(diagnostics).toEqual([]);
	});

	it("flags ValidationError constructions too", () => {
		const diagnostics = lintProvider(
			providerWithSources({
				"index.ts": `throw new ValidationError("bad input", { code: "WEIRD_INPUT" });`,
			}),
		).filter(undeclaredRule);

		expect(diagnostics).toEqual([
			expect.objectContaining({ level: "warn", field: "sourceFiles.index.ts" }),
		]);
		expect(diagnostics[0]?.message).toContain('"WEIRD_INPUT"');
	});

	it("does not read codes out of message strings or nested objects", () => {
		const diagnostics = lintProvider(
			providerWithSources({
				"index.ts": [
					`throw new ProviderError('set code: "NOT_A_CODE" upstream', { code: dynamic });`,
					`throw new ProviderError("nested", { details: { code: "INNER_CODE" }, code: dynamic });`,
				].join("\n"),
			}),
		).filter(undeclaredRule);

		expect(diagnostics).toEqual([]);
	});

	it("ignores test sources", () => {
		const diagnostics = lintProvider(
			providerWithSources({
				"index.test.ts": `throw new ProviderError("boom", { code: "TEST_ONLY_CODE" });`,
			}),
		).filter(undeclaredRule);

		expect(diagnostics).toEqual([]);
	});

	it("falls back to operation handler source when no source files are provided", () => {
		const base = providerWithSources({});
		const provider = {
			...base,
			providerSourceFiles: undefined,
			operations: {
				lookup: {
					...base.operations.lookup,
					source: `async () => { throw new ProviderError("nope", { code: "HANDLER_ONLY_CODE" }); }`,
				},
			},
		};

		const diagnostics = lintProvider(provider).filter(undeclaredRule);

		expect(diagnostics).toEqual([
			expect.objectContaining({ level: "warn", field: "operations.lookup.handler" }),
		]);
		expect(diagnostics[0]?.message).toContain('"HANDLER_ONLY_CODE"');
	});

	it("reports each undeclared code once per file", () => {
		const diagnostics = lintProvider(
			providerWithSources({
				"index.ts": [
					`throw new ProviderError("first", { code: "DUP_CODE" });`,
					`throw new ProviderError("second", { code: "DUP_CODE" });`,
				].join("\n"),
			}),
		).filter(undeclaredRule);

		expect(diagnostics).toHaveLength(1);
	});
});

describe("flat operation safety lint", () => {
	const credentialBearingModes = [
		"credentials",
		"oauth2",
		"oauth2_proxied",
	] satisfies readonly AuthMode[];

	function providerWithOperation(
		operation: {
			riskClass: OperationRiskClass;
			approval?: OperationApprovalPolicy;
			connectionMode?: "none" | "optional" | "required";
		},
		authMode: AuthMode = "none",
	) {
		return lintProvider({
			id: "flat-safety-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			auth: { mode: authMode },
			operations: {
				lookup: {
					...operation,
					descriptionKey: "operations.lookup.description",
					input: withDescriptionKey(z.object({}), "operations.lookup.input.description"),
					output: withDescriptionKey(z.object({}), "operations.lookup.output.description"),
					fixtures: { request: {}, response: {} },
				},
			},
		});
	}

	it.each(credentialBearingModes)(
		"requires explicit connectionMode for %s auth",
		(authMode) => {
			const diagnostics = providerWithOperation({ riskClass: "read" }, authMode);
			expect(diagnostics).toContainEqual(
				expect.objectContaining({
					rule: "mixed-auth-connection-mode-required",
					level: "error",
					field: "operations.lookup.connectionMode",
				}),
			);
		},
	);

	it("does not require connectionMode for none or platform-managed auth", () => {
		for (const authMode of ["none", "platform-managed"] satisfies readonly AuthMode[]) {
			const diagnostics = providerWithOperation({ riskClass: "read" }, authMode);
			expect(
				diagnostics.some((item) => item.rule === "mixed-auth-connection-mode-required"),
			).toBe(false);
		}
	});

	it("accepts explicit connectionMode for credential-bearing auth", () => {
		const diagnostics = providerWithOperation(
			{ riskClass: "read", connectionMode: "none" },
			"credentials",
		);
		expect(
			diagnostics.some((item) => item.rule === "mixed-auth-connection-mode-required"),
		).toBe(false);
	});

	it.each([
		{ riskClass: "read", approval: "never" },
		{ riskClass: "write", approval: "risk-based" },
		{ riskClass: "destructive", approval: "always" },
		{ riskClass: "external-send", approval: "always" },
	] satisfies readonly {
		riskClass: OperationRiskClass;
		approval: OperationApprovalPolicy;
	}[])("rejects redundant $riskClass/$approval approval", (operation) => {
		const diagnostics = providerWithOperation(operation);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "redundant-approval",
				level: "error",
				field: "operations.lookup.approval",
			}),
		);
	});

	it("accepts an approval override that differs from the risk default", () => {
		const diagnostics = providerWithOperation({ riskClass: "write", approval: "always" });
		expect(diagnostics.some((item) => item.rule === "redundant-approval")).toBe(false);
	});
});
