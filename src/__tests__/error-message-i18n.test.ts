import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { AuthError, ProviderError, TransportError } from "../errors.js";
import type { ProviderLocaleCatalogMap } from "../i18n/catalog.js";
import {
	interpolatedParamText,
	interpolateProviderErrorText,
	localizeProviderErrorText,
	MAX_INTERPOLATED_PARAM_LENGTH,
	providerLocaleFromAcceptLanguage,
	resolveProviderErrorLocale,
} from "../i18n/error-messages.js";
import { createServerApp, type ProviderServerLogEvent } from "../server/serve.js";
import type { OperationRiskClass, ProviderDefinition } from "../types.js";

const READ_RISK_CLASS: OperationRiskClass = "read";

describe("providerLocaleFromAcceptLanguage", () => {
	it("matches on the primary subtag", () => {
		expect(providerLocaleFromAcceptLanguage("ko-KR")).toBe("ko");
		expect(providerLocaleFromAcceptLanguage("JA-JP")).toBe("ja");
	});

	it("honours quality values instead of header order", () => {
		expect(providerLocaleFromAcceptLanguage("ko;q=0.2, ja;q=0.9")).toBe("ja");
		expect(providerLocaleFromAcceptLanguage("fr, ko;q=0.8, en;q=0.9")).toBe("en");
	});

	it("keeps header order for equal qualities", () => {
		expect(providerLocaleFromAcceptLanguage("ko, ja")).toBe("ko");
		expect(providerLocaleFromAcceptLanguage("ja;q=0.5, ko;q=0.5")).toBe("ja");
	});

	it("skips ranges explicitly rejected with q=0", () => {
		expect(providerLocaleFromAcceptLanguage("ko;q=0, ja")).toBe("ja");
	});

	it("treats a malformed quality as fully acceptable", () => {
		expect(providerLocaleFromAcceptLanguage("ko;q=banana")).toBe("ko");
	});

	it("returns undefined when nothing supported is requested", () => {
		expect(providerLocaleFromAcceptLanguage("fr-FR, de;q=0.8")).toBeUndefined();
		expect(providerLocaleFromAcceptLanguage("")).toBeUndefined();
		expect(providerLocaleFromAcceptLanguage(null)).toBeUndefined();
	});

	it("falls through header sources in order and defaults to en", () => {
		expect(resolveProviderErrorLocale(undefined, "ja")).toBe("ja");
		expect(resolveProviderErrorLocale("ko", "ja")).toBe("ko");
		expect(resolveProviderErrorLocale("fr", undefined)).toBe("en");
	});
});

describe("interpolateProviderErrorText", () => {
	it("substitutes named placeholders", () => {
		expect(interpolateProviderErrorText("Sold out at {venue}.", { venue: "Tokyo Dome" })).toBe(
			"Sold out at Tokyo Dome.",
		);
		expect(interpolateProviderErrorText("Retry in {seconds}s.", { seconds: 30 })).toBe(
			"Retry in 30s.",
		);
	});

	it("unescapes doubled braces", () => {
		expect(interpolateProviderErrorText("Use {{name}} as a literal.", { name: "x" })).toBe(
			"Use {name} as a literal.",
		);
	});

	it("leaves a placeholder verbatim when no param supplies it", () => {
		expect(interpolateProviderErrorText("Sold out at {venue}.")).toBe("Sold out at {venue}.");
		expect(interpolateProviderErrorText("Sold out at {venue}.", { other: "x" })).toBe(
			"Sold out at {venue}.",
		);
	});

	it("never re-interpolates substituted text", () => {
		expect(
			interpolateProviderErrorText("Upstream said: {detail}", {
				detail: "{secret} and {{escaped}}",
				secret: "LEAKED",
			}),
		).toBe("Upstream said: {secret} and {{escaped}}");
	});

	it("ignores inherited param names", () => {
		const params = Object.create({ venue: "INHERITED" }) as Record<string, string>;
		expect(interpolateProviderErrorText("At {venue}.", params)).toBe("At {venue}.");
	});

	it("strips markup openers from untrusted values", () => {
		expect(
			interpolateProviderErrorText("Upstream said: {detail}", {
				detail: `<script>alert(1)</script> \`code\``,
			}),
		).toBe("Upstream said: scriptalert(1)/script code");
	});

	it("neutralizes HTML entities while keeping ordinary ampersands", () => {
		expect(
			interpolateProviderErrorText("{detail}", { detail: "&lt;img&gt; Tom & Jerry &#60;" }),
		).toBe("lt;imggt; Tom & Jerry #60;");
	});

	it("removes control, bidi and newline characters", () => {
		const rendered = interpolateProviderErrorText("{detail}", {
			detail: "line1\nline2‮evil",
		});
		expect(rendered).not.toContain("\n");
		expect(rendered).not.toContain("‮");
		expect(rendered).toContain("line1 line2");
	});

	it("redacts credential-shaped values reused as params", () => {
		expect(
			interpolateProviderErrorText("{detail}", { detail: "Bearer abcdef0123456789abcdef" }),
		).toBe("Bearer [REDACTED]");
	});

	it("caps each interpolated value", () => {
		const rendered = interpolateProviderErrorText("{detail}", { detail: "xy ".repeat(2_000) });
		expect(rendered.length).toBe(MAX_INTERPOLATED_PARAM_LENGTH + 1);
		expect(rendered.endsWith("…")).toBe(true);
	});

	it("leaves the placeholder for non-finite numbers", () => {
		expect(
			interpolateProviderErrorText("{nan} {infinite}", {
				nan: Number.NaN,
				infinite: Number.POSITIVE_INFINITY,
			}),
		).toBe("{nan} {infinite}");
	});

	it("refuses to render a value that is neither a string nor a number", () => {
		expect(interpolatedParamText({ toString: () => "INJECTED" })).toBeUndefined();
		expect(interpolatedParamText(undefined)).toBeUndefined();
		expect(interpolatedParamText(null)).toBeUndefined();
		expect(interpolatedParamText(true)).toBeUndefined();
	});
});

const CATALOGS: ProviderLocaleCatalogMap = {
	en: {
		errors: {
			explicit: { message: "Explicit English", fix: "Explicit English fix" },
			declared: { message: "Declared English" },
			ITEM_SOLD_OUT: { message: "Sold out (en) at {venue}", fix: "Try another date (en)" },
			listValued: { message: ["not", "a", "string"] },
		},
	},
	ko: {
		errors: {
			explicit: { message: "명시적 한국어", fix: "명시적 한국어 해결" },
			ITEM_SOLD_OUT: { message: "{venue} 매진 (ko)", fix: "다른 날짜를 선택하세요 (ko)" },
		},
	},
	ja: { errors: { ITEM_SOLD_OUT: { message: "売り切れ (ja)" } } },
};

describe("localizeProviderErrorText", () => {
	it("prefers an earlier candidate key even when a later one has the caller's locale", () => {
		expect(
			localizeProviderErrorText({
				catalogs: CATALOGS,
				locale: "ko",
				candidates: [
					{ kind: "key", key: "errors.declared.message" },
					{ kind: "derived", code: "ITEM_SOLD_OUT", field: "message" },
				],
				fallback: "literal",
			}),
		).toBe("Declared English");
	});

	it("resolves the caller locale before the en fallback", () => {
		expect(
			localizeProviderErrorText({
				catalogs: CATALOGS,
				locale: "ko",
				candidates: [{ kind: "key", key: "errors.explicit.message" }],
				fallback: "literal",
			}),
		).toBe("명시적 한국어");
	});

	it("falls back to en for a locale that lacks the key", () => {
		expect(
			localizeProviderErrorText({
				catalogs: CATALOGS,
				locale: "ja",
				candidates: [{ kind: "key", key: "errors.explicit.message" }],
				fallback: "literal",
			}),
		).toBe("Explicit English");
	});

	it("skips a missing key and moves to the next candidate", () => {
		expect(
			localizeProviderErrorText({
				catalogs: CATALOGS,
				locale: "ko",
				candidates: [
					{ kind: "key", key: "errors.absent.message" },
					{ kind: "derived", code: "ITEM_SOLD_OUT", field: "message" },
				],
				params: { venue: "Tokyo Dome" },
				fallback: "literal",
			}),
		).toBe("Tokyo Dome 매진 (ko)");
	});

	it("returns the literal fallback when nothing resolves", () => {
		expect(
			localizeProviderErrorText({
				catalogs: CATALOGS,
				locale: "ko",
				candidates: [{ kind: "key", key: "errors.absent.message" }],
				fallback: "literal",
			}),
		).toBe("literal");
	});

	it("returns the literal fallback when the provider ships no catalogs", () => {
		expect(
			localizeProviderErrorText({
				locale: "ko",
				candidates: [{ kind: "key", key: "errors.explicit.message" }],
				fallback: "literal",
			}),
		).toBe("literal");
	});

	it("treats a malformed key as a miss rather than throwing", () => {
		expect(
			localizeProviderErrorText({
				catalogs: CATALOGS,
				locale: "ko",
				candidates: [
					{ kind: "key", key: "errors..explicit" },
					{ kind: "key", key: "errors.explicit.message" },
				],
				fallback: "literal",
			}),
		).toBe("명시적 한국어");
	});

	it("ignores a non-string catalog value", () => {
		expect(
			localizeProviderErrorText({
				catalogs: CATALOGS,
				locale: "en",
				candidates: [{ kind: "key", key: "errors.listValued.message" }],
				fallback: "literal",
			}),
		).toBe("literal");
	});

	it("ignores an empty code for a derived candidate", () => {
		expect(
			localizeProviderErrorText({
				catalogs: CATALOGS,
				locale: "en",
				candidates: [{ kind: "derived", code: undefined, field: "message" }],
				fallback: "literal",
			}),
		).toBe("literal");
	});

	it("absorbs hostile params rather than masking the error as a 500", () => {
		const params: Record<string, string> = new Proxy(
			{ venue: "x" },
			{
				get() {
					throw new Error("boom");
				},
			},
		);
		expect(
			localizeProviderErrorText({
				catalogs: CATALOGS,
				locale: "en",
				candidates: [{ kind: "derived", code: "ITEM_SOLD_OUT", field: "message" }],
				params,
				fallback: "literal",
			}),
		).toBe("literal");
	});

	it("absorbs a hostile catalog rather than masking the error as a 500", () => {
		const hostile = {
			en: new Proxy(
				{},
				{
					get() {
						throw new Error("boom");
					},
					getOwnPropertyDescriptor() {
						throw new Error("boom");
					},
				},
			),
		} as ProviderLocaleCatalogMap;
		expect(
			localizeProviderErrorText({
				catalogs: hostile,
				locale: "en",
				candidates: [{ kind: "key", key: "errors.explicit.message" }],
				fallback: "literal",
			}),
		).toBe("literal");
	});
});

function localizedProvider(): ProviderDefinition {
	return {
		id: "locale-provider",
		version: "1.0.0",
		runtime: "standard",
		runtimeTarget: "vanilla",
		meta: {
			displayName: "Locale Provider",
			descriptionKey: "meta.description",
			category: "test",
		},
		auth: { mode: "none" },
		operations: {
			declaredOnly: {
				riskClass: READ_RISK_CLASS,
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				errorCodes: [
					{
						code: "ITEM_SOLD_OUT",
						status: 409,
						description: "Upstream refused the purchase.",
						retryable: false,
					},
				],
				handler: async () => {
					throw new ProviderError("Sold out (literal)", {
						code: "ITEM_SOLD_OUT",
						fix: "Try another date (literal)",
						params: { venue: "Tokyo Dome" },
					});
				},
			},
			declarationKey: {
				riskClass: READ_RISK_CLASS,
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				errorCodes: [
					{
						code: "OTHER_CODE",
						status: 409,
						description: "Upstream refused the purchase.",
						retryable: false,
						messageKey: "errors.explicit.message",
						fixKey: "errors.explicit.fix",
					},
				],
				handler: async () => {
					throw new ProviderError("Other (literal)", { code: "OTHER_CODE" });
				},
			},
			siteKey: {
				riskClass: READ_RISK_CLASS,
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				errorCodes: [
					{
						code: "ITEM_SOLD_OUT",
						status: 409,
						description: "Upstream refused the purchase.",
						retryable: false,
					},
				],
				handler: async () => {
					throw new ProviderError("Sold out (literal)", {
						code: "ITEM_SOLD_OUT",
						messageKey: "errors.explicit.message",
					});
				},
			},
			missingKey: {
				riskClass: READ_RISK_CLASS,
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new ProviderError("Literal survives", {
						code: "UNCATALOGED_CODE",
						messageKey: "errors.absent.message",
						fix: "Literal fix survives",
					});
				},
			},
			untrustedParam: {
				riskClass: READ_RISK_CLASS,
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				errorCodes: [
					{
						code: "ITEM_SOLD_OUT",
						status: 409,
						description: "Upstream refused the purchase.",
						retryable: false,
					},
				],
				handler: async () => {
					throw new ProviderError("Sold out (literal)", {
						code: "ITEM_SOLD_OUT",
						params: { venue: `<img src=x onerror="alert(1)">` },
					});
				},
			},
			sdkOwned: {
				riskClass: READ_RISK_CLASS,
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new TransportError("Upstream exploded", { code: "transport_timeout" });
				},
			},
		},
	} satisfies ProviderDefinition;
}

const SDK_OWNED_CATALOGS: ProviderLocaleCatalogMap = {
	...CATALOGS,
	en: {
		errors: {
			...(CATALOGS.en?.errors as Record<string, unknown>),
			transport_timeout: { message: "Provider-authored timeout text" },
		},
	},
};

async function postOperation(
	app: ReturnType<typeof createServerApp>,
	operation: string,
	headers: Record<string, string> = {},
	body: Record<string, unknown> = {},
): Promise<{ status: number; error: Record<string, unknown> }> {
	const response = await app.request(`/v1/${operation}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ requestId: "req_1", input: {}, ...body }),
	});
	const payload = (await response.json()) as { error: Record<string, unknown> };
	return { status: response.status, error: payload.error };
}

describe("serve error envelope localization", () => {
	const app = createServerApp(localizedProvider(), { localeCatalogs: CATALOGS });

	it("localizes message and fix from the derived errors.<code> convention", async () => {
		const { error } = await postOperation(app, "declaredOnly", { "accept-language": "ko-KR" });

		expect(error.message).toBe("Tokyo Dome 매진 (ko)");
		expect(error.fix).toBe("다른 날짜를 선택하세요 (ko)");
		expect(error.code).toBe("ITEM_SOLD_OUT");
	});

	it("falls back to en for a locale the catalog does not cover", async () => {
		const { error } = await postOperation(app, "declaredOnly", { "accept-language": "ja" });

		// ja has the message but not the fix, so each field falls back independently.
		expect(error.message).toBe("売り切れ (ja)");
		expect(error.fix).toBe("Try another date (en)");
	});

	it("serves the en catalog value when no Accept-Language is sent", async () => {
		const { error } = await postOperation(app, "declaredOnly");

		expect(error.message).toBe("Sold out (en) at Tokyo Dome");
	});

	it("resolves declaration-level keys without touching the throw site", async () => {
		const { error } = await postOperation(app, "declarationKey", { "accept-language": "ko" });

		expect(error.message).toBe("명시적 한국어");
		expect(error.fix).toBe("명시적 한국어 해결");
	});

	it("lets a throw-site messageKey win over the declaration and the derived key", async () => {
		const { error } = await postOperation(app, "siteKey", { "accept-language": "ko" });

		expect(error.message).toBe("명시적 한국어");
	});

	it("keeps the English literal when the key is missing from every catalog", async () => {
		const { error } = await postOperation(app, "missingKey", { "accept-language": "ko" });

		expect(error.message).toBe("Literal survives");
		expect(error.fix).toBe("Literal fix survives");
	});

	it("prefers the request envelope headers over the HTTP header", async () => {
		const { error } = await postOperation(
			app,
			"declaredOnly",
			{ "accept-language": "en" },
			{ headers: { "Accept-Language": "ko" } },
		);

		expect(error.message).toBe("Tokyo Dome 매진 (ko)");
	});

	it("sanitizes untrusted param text before interpolation", async () => {
		const { error } = await postOperation(app, "untrustedParam", { "accept-language": "en" });

		expect(error.message).toBe(`Sold out (en) at img src=x onerror="alert(1)"`);
		expect(error.message).not.toContain("<");
		expect(error.message).not.toContain(">");
	});

	it("keeps the response a well-formed envelope with an injected param", async () => {
		const response = await app.request("/v1/untrustedParam", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ requestId: "req_1", input: {} }),
		});
		const raw = await response.text();

		expect(() => JSON.parse(raw) as unknown).not.toThrow();
		expect(JSON.parse(raw)).toMatchObject({ error: { code: "ITEM_SOLD_OUT" } });
	});

	it("keeps the thrown English literal in logs while localizing the envelope", async () => {
		const events: ProviderServerLogEvent[] = [];
		const loggingApp = createServerApp(localizedProvider(), {
			localeCatalogs: CATALOGS,
			logger: (event) => events.push(event),
		});

		const { error } = await postOperation(loggingApp, "declaredOnly", {
			"accept-language": "ko",
		});

		expect(error.message).toBe("Tokyo Dome 매진 (ko)");
		const failure = events.find((event) => event.event === "provider_request_failed");
		expect(failure).toMatchObject({ message: "Sold out (literal)", code: "ITEM_SOLD_OUT" });
	});

	it("does not let a provider catalog relabel an SDK-owned transport failure", async () => {
		const sdkOwnedApp = createServerApp(localizedProvider(), {
			localeCatalogs: SDK_OWNED_CATALOGS,
		});

		const { error } = await postOperation(sdkOwnedApp, "sdkOwned", { "accept-language": "en" });

		expect(error.message).toBe("Request timed out");
	});

	it("serves English literals unchanged when the provider ships no catalogs", async () => {
		const bareApp = createServerApp(localizedProvider(), { localeCatalogs: {} });

		const { error } = await postOperation(bareApp, "declaredOnly", { "accept-language": "ko" });

		expect(error.message).toBe("Sold out (literal)");
		expect(error.fix).toBe("Try another date (literal)");
	});
});

describe("auth route error envelope localization", () => {
	it("localizes an AuthError thrown by the flow", async () => {
		const provider: ProviderDefinition = {
			...localizedProvider(),
			auth: {
				mode: "credentials",
				flow: {
					async start() {
						throw new AuthError("Sign-in failed (literal)", {
							code: "SIGN_IN_FAILED",
							messageKey: "errors.explicit.message",
							fixKey: "errors.explicit.fix",
						});
					},
					async continue() {
						return { kind: "complete", turnId: "turn", data: {} };
					},
				},
			},
		};
		const app = createServerApp(provider, { localeCatalogs: CATALOGS });

		const response = await app.request("/auth/start", {
			method: "POST",
			headers: { "content-type": "application/json", "accept-language": "ko" },
			body: JSON.stringify({ requestId: "req_1", flowId: "flow_1", input: {} }),
		});
		const payload = (await response.json()) as { error: Record<string, unknown> };

		expect(payload.error.message).toBe("명시적 한국어");
		expect(payload.error.fix).toBe("명시적 한국어 해결");
	});
});

describe("provider locale catalog loading", () => {
	async function withProviderDir(
		files: Record<string, string>,
		run: () => Promise<void>,
	): Promise<void> {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { dirname, join } = await import("node:path");
		const root = mkdtempSync(join(tmpdir(), "apifuse-locale-"));
		for (const [relativePath, contents] of Object.entries(files)) {
			const absolute = join(root, relativePath);
			mkdirSync(dirname(absolute), { recursive: true });
			writeFileSync(absolute, contents);
		}
		const previousCwd = process.cwd();
		process.chdir(root);
		try {
			await run();
		} finally {
			process.chdir(previousCwd);
			rmSync(root, { recursive: true, force: true });
		}
	}

	it("loads the locales that exist instead of failing on an absent ja.json", async () => {
		await withProviderDir(
			{
				"locales/en.json": JSON.stringify(CATALOGS.en),
				"locales/ko.json": JSON.stringify(CATALOGS.ko),
			},
			async () => {
				const app = createServerApp(localizedProvider());
				const { error } = await postOperation(app, "declaredOnly", { "accept-language": "ko" });

				expect(error.message).toBe("Tokyo Dome 매진 (ko)");
			},
		);
	});

	it("logs once and serves English literals when a present catalog cannot be parsed", async () => {
		await withProviderDir({ "locales/en.json": "{ not json" }, async () => {
			const events: ProviderServerLogEvent[] = [];
			const app = createServerApp(localizedProvider(), { logger: (event) => events.push(event) });

			const { error } = await postOperation(app, "declaredOnly", { "accept-language": "ko" });

			expect(error.message).toBe("Sold out (literal)");
			expect(
				events.filter((event) => event.event === "provider_locale_catalogs_unavailable"),
			).toHaveLength(1);
		});
	});

	it("serves English literals when the provider directory has no catalogs", async () => {
		await withProviderDir({ "package.json": "{}" }, async () => {
			const app = createServerApp(localizedProvider());
			const { error } = await postOperation(app, "declaredOnly", { "accept-language": "ko" });

			expect(error.message).toBe("Sold out (literal)");
		});
	});
});
