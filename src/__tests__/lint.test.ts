import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { lintOperation, lintProvider } from "../lint.js";
import { describeKey, fields } from "../schema.js";
import type { AuthMode, OperationRiskClass } from "../types.js";

describe("lintOperation", () => {
	it("reports one-directional fixtures and leaves descriptionKey to defineProvider", () => {
		const diagnostics = lintOperation({
			input: z.object({
				filters: z.object({ ids: z.array(z.string()) }),
			}),
			output: z.object({ result: z.string() }),
			fixtures: { request: { filters: { ids: ["btc"] } } },
		});

		expect(diagnostics.map((item) => item.rule)).toEqual(["fixtures-both-directions"]);
	});

	it("accepts key-owned simple operations", () => {
		const diagnostics = lintOperation({
			input: describeKey(
				z.object({
					symbol: describeKey(z.string(), "operations.price.fields.symbol.description"),
				}),
				"operations.price.input.description",
			),
			output: describeKey(
				z.object({
					price: describeKey(z.number(), "operations.price.fields.price.description"),
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

	it("does not lint schema descriptions or sensitive-looking names; defineProvider owns the declarations", () => {
		const diagnostics = lintOperation({
			input: z.object({ password: z.string(), phoneNumber: z.string() }),
			output: z.object({ accessToken: fields.token(), ok: z.boolean() }),
			fixtures: {
				request: { password: "secret", phoneNumber: "02-000-0000" },
				response: { accessToken: "token", ok: true },
			},
		});

		expect(diagnostics).toEqual([]);
	});
});

describe("lintProvider", () => {
	it("prefixes diagnostics with operation paths", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			operations: {
				lookup: {
					descriptionKey: "Short description",
					input: z.object({ symbol: z.string() }),
					output: z.object({ price: z.number() }),
					fixtures: { request: { symbol: "BTC" } },
				},
			},
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				rule: "fixtures-both-directions",
				field: "operations.lookup.fixtures",
				message: "[lookup] Fixtures must include both request and response.",
			}),
		);
	});

	it("does not crash when malformed auth is primitive", () => {
		expect(() =>
			lintProvider({
				id: "demo-provider",
				// test-invalid: lint crash resistance deliberately receives primitive auth metadata.
				auth: "credentials" as never,
			}),
		).not.toThrow();
	});

	it("rejects login-like operations on authenticated providers so auth flow remains canonical", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			auth: {
				mode: "credentials",
				flow: { continue: async () => ({ kind: "complete", turnId: "1" }) },
			},
			operations: {
				"auth-login-with-password": {
					descriptionKey: "operations.authLogin.description",
					input: describeKey(z.object({}), "operations.authLogin.input.description"),
					output: describeKey(
						z.object({
							ok: describeKey(z.boolean(), "operations.authLogin.fields.ok.description"),
						}),
						"operations.authLogin.output.description",
					),
					fixtures: { request: {}, response: { ok: true } },
				},
				"login-with-password": {
					descriptionKey: "operations.login.description",
					input: describeKey(z.object({}), "operations.login.input.description"),
					output: describeKey(
						z.object({
							ok: describeKey(z.boolean(), "operations.login.fields.ok.description"),
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

	it("blocks credential writes in operation handlers but allows return-based refresh handlers", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
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
			operations: {
				search: {
					descriptionKey:
						"Use this operation when callers need a fixture that proves operation handlers cannot write credentials.",
					input: z.object({ query: z.string() }),
					output: z.object({ ok: z.boolean() }),
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
			connectionMode?: "none" | "optional" | "required";
		},
		authMode: AuthMode = "none",
	) {
		return lintProvider({
			id: "flat-safety-provider",
			auth: { mode: authMode },
			operations: {
				lookup: {
					...(operation.connectionMode === undefined
						? {}
						: { connectionMode: operation.connectionMode }),
					descriptionKey: "operations.lookup.description",
					input: describeKey(z.object({}), "operations.lookup.input.description"),
					output: describeKey(z.object({}), "operations.lookup.output.description"),
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
});

describe("lintProvider deprecated errorCodes table", () => {
	function lintWithErrorCodes(errorCodes?: ReadonlyArray<{ code: string; status: number }>) {
		return lintProvider({
			id: "table-provider",
			operations: {
				lookup: {
					descriptionKey: "operations.lookup.description",
					input: describeKey(z.object({}), "operations.lookup.input.description"),
					output: describeKey(z.object({}), "operations.lookup.output.description"),
					fixtures: { request: {}, response: {} },
					...(errorCodes ? { errorCodes } : {}),
				},
			},
		});
	}

	it("warns on an operation that still declares codes in the errorCodes table", () => {
		const diagnostics = lintWithErrorCodes([
			{ code: "ITEM_GONE", status: 502 },
			{ code: "UPSTREAM_ERROR", status: 502 },
		]);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				rule: "deprecated-error-codes-table",
				level: "warn",
				field: "operations.lookup.errorCodes",
				message: expect.stringContaining(
					"declares ITEM_GONE, UPSTREAM_ERROR in the deprecated errorCodes table",
				),
			}),
		]);
		expect(diagnostics[0]?.message).toContain(
			"defineErrors({ ITEM_GONE: { status, category, description } })",
		);
	});

	it("stays silent for an operation without the table", () => {
		expect(lintWithErrorCodes()).toEqual([]);
		expect(lintWithErrorCodes([])).toEqual([]);
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
			providerSourceFiles: { "upstream/client.ts": source },
			operations: {
				search: {
					descriptionKey:
						"Use this operation when callers need upstream search results and when header ownership between ctx.stealth and ctx.http must be linted.",
					input: z.object({ query: z.string() }),
					output: z.object({ ok: z.boolean() }),
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
