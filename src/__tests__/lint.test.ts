import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { lintOperation, lintProvider } from "../lint.js";
import { describeKey, fields, publicField } from "../schema.js";
import type { AuthMode, OperationApprovalPolicy, OperationRiskClass } from "../types.js";

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

	it("accepts an explicit public declaration on a sensitive-looking field", () => {
		const diagnostics = lintOperation({
			input: z.object({ id: z.string() }),
			output: z.object({
				phone: publicField(z.string()),
				phoneNumber: z.string(),
				faxPhone: publicField(z.string()).nullable(),
				phone_number: z.string().pipe(publicField(z.string())),
				Phone: z.preprocess((value) => value, publicField(z.string())),
				token: fields.token().optional(),
				// Credential-shaped keys cannot be declared public.
				password: publicField(z.string()),
				apiKey: publicField(z.string()).optional(),
			}),
			fixtures: {
				request: { id: "hospital-1" },
				response: {
					phone: "02-000-0000",
					phoneNumber: "02-000-0001",
					phone_number: "02-000-0002",
					Phone: "02-000-0003",
					token: "t",
					password: "p",
					apiKey: "k",
				},
			},
		});

		const unmarked = diagnostics
			.filter((item) => item.rule === "sensitive-field-unmarked")
			.map((item) => item.field);
		expect(unmarked).toEqual(["output.phoneNumber", "output.password", "output.apiKey"]);
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
			stealth: { browser: "chrome", os: "macos" },
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

describe("lintProvider legacy-error-options", () => {
	const legacy = (item: { rule: string }) => item.rule === "legacy-error-options";

	function lintSources(
		providerSourceFiles: Record<string, string>,
		errorCodes: ReadonlyArray<{ code: string; status?: 400 | 502; description: string }> = [],
	) {
		return lintProvider({
			id: "demo",
			providerSourceFiles,
			operations: {
				lookup: {
					input: z.object({}),
					output: z.object({}),
					riskClass: READ_RISK_CLASS,
					...(errorCodes.length > 0 ? { errorCodes: [...errorCodes] } : {}),
				},
			},
		}).filter(legacy);
	}

	it("warns once per code and option set on a throw site that sets category or retryable", () => {
		const diagnostics = lintSources({
			"upstream/client.ts": [
				`throw new ProviderError("blocked", { code: "BLOCKED", category: "anti_bot_blocked", retryable: false });`,
				`throw new ProviderError("blocked again", { code: "BLOCKED", category: "anti_bot_blocked", retryable: false });`,
				`throw new ValidationError("bad row", { code: "ROW_INVALID", retryable: true });`,
			].join("\n"),
		});

		expect(diagnostics).toEqual([
			expect.objectContaining({
				rule: "legacy-error-options",
				level: "warn",
				field: "sourceFiles.upstream/client.ts",
				message: expect.stringContaining('ProviderError with code "BLOCKED"'),
			}),
			expect.objectContaining({
				field: "sourceFiles.upstream/client.ts",
				message: expect.stringContaining('ValidationError with code "ROW_INVALID"'),
			}),
		]);
		expect(diagnostics[0]?.message).toContain(
			"defineErrors({ BLOCKED: { status, category, description } })",
		);
		expect(diagnostics[0]?.message).toContain("errors.BLOCKED({ details, cause })");
	});

	it("warns on a non-literal category too, since a variable may carry any category", () => {
		const diagnostics = lintSources({
			"upstream/client.ts": `throw new ProviderError("gone", { code: "ITEM_GONE", category });`,
		});

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain("sets category per throw");
	});

	it("warns on an operation that still declares codes in the errorCodes table", () => {
		const diagnostics = lintSources({}, [
			{ code: "ITEM_GONE", status: 502, description: "Item withdrawn." },
			{ code: "UPSTREAM_ERROR", status: 502, description: "Upstream failed." },
		]);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				rule: "legacy-error-options",
				level: "warn",
				field: "operations.lookup.errorCodes",
				message: expect.stringContaining(
					"declares ITEM_GONE, UPSTREAM_ERROR in the deprecated errorCodes table",
				),
			}),
		]);
	});

	it("stays silent for a throw site that only sets code, details and cause", () => {
		const diagnostics = lintSources({
			"upstream/client.ts": `throw new ProviderError("gone", { code: "ITEM_GONE", details: { id }, cause });`,
		});

		expect(diagnostics).toEqual([]);
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

	it.each(credentialBearingModes)("requires explicit connectionMode for %s auth", (authMode) => {
		const diagnostics = providerWithOperation({ riskClass: "read" }, authMode);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "mixed-auth-connection-mode-required",
				level: "error",
				field: "operations.lookup.connectionMode",
			}),
		);
	});

	it("does not require connectionMode for none or platform-managed auth", () => {
		for (const authMode of ["none", "platform-managed"] satisfies readonly AuthMode[]) {
			const diagnostics = providerWithOperation({ riskClass: "read" }, authMode);
			expect(diagnostics.some((item) => item.rule === "mixed-auth-connection-mode-required")).toBe(
				false,
			);
		}
	});

	it("accepts explicit connectionMode for credential-bearing auth", () => {
		const diagnostics = providerWithOperation(
			{ riskClass: "read", connectionMode: "none" },
			"credentials",
		);
		expect(diagnostics.some((item) => item.rule === "mixed-auth-connection-mode-required")).toBe(
			false,
		);
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

describe("lintProvider browser-version-literal owned headers", () => {
	const OWNED_HEADER_LITERALS = `
export const HEADERS = {
  Accept: "text/html",
  "Sec-Fetch-Dest": "document",
};
export function apply(headers: Headers, tuples: Array<[string, string]>) {
  headers.set("sec-fetch-mode", "navigate");
  tuples.push(["sec-ch-ua-platform", '"macOS"']);
  const extra: Record<string, string> = {};
  extra["Sec-Fetch-Site"] = "same-origin";
  return extra;
}
`;

	function lintSourceFile(source: string) {
		return lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			providerSourceFiles: { "upstream/client.ts": source },
			operations: {
				search: {
					riskClass: READ_RISK_CLASS,
					descriptionKey:
						"Use this operation when callers need upstream search results and when header ownership between ctx.stealth and ctx.http must be linted.",
					input: z.object({ query: z.string().describe("Search query") }),
					output: z.object({ ok: z.boolean().describe("Success flag") }),
					fixtures: { request: { query: "desk" }, response: { ok: true } },
					handler: async () => ({ ok: true }),
				},
			},
		}).filter((diagnostic) => diagnostic.rule === "browser-version-literal");
	}

	it("errors on every stealth-owned header name shape in a file that uses ctx.stealth", () => {
		const diagnostics = lintSourceFile(
			`${OWNED_HEADER_LITERALS}\nexport function client(ctx: { stealth: unknown }) { return ctx.stealth; }\n`,
		);

		expect(diagnostics).toHaveLength(4);
		for (const name of [
			"Sec-Fetch-Dest",
			"sec-fetch-mode",
			"sec-ch-ua-platform",
			"Sec-Fetch-Site",
		]) {
			const diagnostic = diagnostics.find((item) => item.message.includes(`"${name}"`));
			expect(diagnostic).toEqual(
				expect.objectContaining({
					level: "error",
					field: "sourceFiles.upstream/client.ts",
				}),
			);
			expect(diagnostic?.message).toContain("STEALTH_HEADER_OVERRIDE_UNSUPPORTED");
			expect(diagnostic?.message).toContain(
				'stealth: { requestClass: "navigation" | "form-post" | "xhr" | "post" }',
			);
		}
	});

	it("does not report owned header names in a file that only uses ctx.http", () => {
		const diagnostics = lintSourceFile(
			`${OWNED_HEADER_LITERALS}\nexport function client(ctx: { http: { get: (url: string) => unknown } }) { return ctx.http.get("https://api.example.com/"); }\n`,
		);

		expect(diagnostics).toEqual([]);
	});

	it("ignores owned-name predicates and name lists that are not header entries", () => {
		const diagnostics = lintSourceFile(`
const OWNED = new Set(["host", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"]);
export function strip(headers: Record<string, string>, ctx: { stealth: unknown }) {
  for (const name of Object.keys(headers)) {
    if (OWNED.has(name.toLowerCase()) || name.toLowerCase().startsWith("sec-fetch-")) {
      delete headers[name];
    }
  }
  return ctx.stealth;
}
`);

		expect(diagnostics).toEqual([]);
	});

	it("ignores two-name lists, non-setter calls, and undefined entries in a ctx.stealth file", () => {
		const diagnostics = lintSourceFile(`
const CLIENT_HINTS = new Set(["sec-ch-ua-mobile", "sec-ch-ua-platform"]);
const OWNED_PAIR = ["sec-fetch-dest", "sec-fetch-mode"];
export function forward(name: string, headers: Record<string, string | undefined>, ctx: { stealth: unknown }) {
  if (name.startsWith("sec-fetch-site", 0)) return CLIENT_HINTS.has(name) || OWNED_PAIR.includes(name);
  console.log("sec-fetch-dest", headers);
  const cleared = { ...headers, "Sec-Fetch-Site": undefined };
  cleared["Sec-Fetch-Mode"] = undefined;
  return [cleared, ctx.stealth];
}
`);

		expect(diagnostics).toEqual([]);
	});

	it("ignores a bound or iterated two-name list whose second name is not owned", () => {
		const diagnostics = lintSourceFile(`
const STRIP = ["sec-fetch-dest", "referer"];
const STRIP_CONST = ["Sec-Fetch-Site", "cookie"] as const;
export function strip(headers: Record<string, string>, ctx: { stealth: unknown }) {
  for (const name of [...STRIP, ...STRIP_CONST]) delete headers[name];
  for (const name of ["sec-fetch-user", "origin"]) delete headers[name];
  return ["sec-ch-ua-mobile", "accept"].includes("x") ? headers : ctx.stealth;
}
`);

		expect(diagnostics).toEqual([]);
	});

	it("still reports a [name, value] tuple in an entries list, a call, or a tuple type", () => {
		const diagnostics = lintSourceFile(`
export function build(tuples: Array<[string, string]>, ctx: { stealth: unknown }) {
  const listed = Object.fromEntries([["sec-fetch-dest", "document"]]);
  const wrapped = new Headers([["Sec-Fetch-Mode", "navigate"]]);
  tuples.push(["sec-fetch-site", "same-origin"]);
  const typed: readonly [string, string] = ["sec-fetch-user", "?1"];
  const asserted = ["sec-ch-ua-mobile", "?0"] as [string, string];
  return [listed, wrapped, typed, asserted, ctx.stealth];
}
`);

		expect(
			diagnostics.map((diagnostic) => diagnostic.message.match(/"([^"]+)" header/)?.[1]),
		).toEqual([
			"sec-fetch-dest",
			"Sec-Fetch-Mode",
			"sec-fetch-site",
			"sec-fetch-user",
			"sec-ch-ua-mobile",
		]);
	});

	it("reports an undefined value in the Headers shapes the runtime does not drop", () => {
		const diagnostics = lintSourceFile(`
export function clear(headers: Headers, tuples: Array<[string, string | undefined]>, ctx: { stealth: unknown }) {
  headers.set("sec-fetch-dest", undefined);
  headers.append("sec-fetch-mode", void 0);
  tuples.push(["sec-fetch-site", undefined]);
  return ctx.stealth;
}
`);

		expect(
			diagnostics.map((diagnostic) => diagnostic.message.match(/"([^"]+)" header/)?.[1]),
		).toEqual(["sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"]);
	});

	it("does not scope a ctx.http file into the rule because a comment or string mentions ctx.stealth", () => {
		const diagnostics = lintSourceFile(`
// Use ctx.http, not ctx.stealth, for custom fetch metadata.
const NOTE = "ctx.stealth would reject these";
export function fetchPage(ctx: { http: { get: (url: string, init: { headers: Record<string, string> }) => unknown } }) {
  return ctx.http.get("https://api.example.com/", { headers: { "Sec-Fetch-Site": "same-origin", note: NOTE } });
}
`);

		expect(diagnostics).toEqual([]);
	});

	it("scopes a file that reaches the stealth client through destructuring or element access", () => {
		for (const access of ["const { stealth } = ctx; return stealth;", 'return ctx["stealth"];']) {
			const diagnostics = lintSourceFile(
				`export const HEADERS = { "Sec-Fetch-Mode": "navigate" };\nexport function client(ctx: { stealth: unknown }) { ${access} }\n`,
			);

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]?.message).toContain('ctx.stealth owns the "Sec-Fetch-Mode" header');
		}
	});

	it("reports a versioned sec-ch-ua entry once in a ctx.stealth file and as a version literal elsewhere", () => {
		const source = `export const headers = { "sec-ch-ua": '"Chromium";v="131", "Google Chrome";v="131"' };\n`;

		const stealthDiagnostics = lintSourceFile(
			`${source}export function client(ctx: { stealth: unknown }) { return ctx.stealth; }\n`,
		);
		expect(stealthDiagnostics).toHaveLength(1);
		expect(stealthDiagnostics[0]?.message).toContain('ctx.stealth owns the "sec-ch-ua" header');

		const httpDiagnostics = lintSourceFile(source);
		expect(httpDiagnostics).toHaveLength(1);
		expect(httpDiagnostics[0]?.message).toContain("Hardcoded sec-ch-ua versions");
	});
});
