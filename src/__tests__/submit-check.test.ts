import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
	buildSubmitCheckReport,
	extractStringLiteralCandidates,
	hasNonEmptyRecordedFixture,
	isAutoPromotionEligible,
	maskCommentsAndStrings,
	renderMarkdown,
	type SubmitCheckReport,
} from "../../bin/apifuse-submit-check.js";
import { STREAM_PREVIEW_BYTES } from "../stream-evidence.js";
import { hasSubstantiveDelimitedTextStructure } from "../../bin/submit-check-delimited-text.js";
import { syncPromptAssets } from "../cli/prompt-assets.js";

const tempDirs: string[] = [];
const repoRoot = dirname(dirname(import.meta.dir));
const submitCheckCliPath = join(repoRoot, "bin", "apifuse-submit-check.ts");
const tempRoot = join(process.cwd(), ".tmp-provider-sdk-submit-check-tests");

setDefaultTimeout(60_000);

function makeProviderDir(
	prefix: string,
	indexSource: string,
	readme = defaultReadme(),
	includeRepositoryDx = true,
	checkScript = "apifuse check . && bun run type-check",
): string {
	mkdirSync(tempRoot, { recursive: true });
	const dir = mkdtempSync(join(tempRoot, prefix));
	tempDirs.push(dir);
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			dependencies: { "@apifuse/provider-sdk": "workspace:*" },
			...(includeRepositoryDx
				? {
						scripts: {
							dev: "apifuse dev .",
							check: checkScript,
							"type-check": "tsc --noEmit",
						},
					}
				: {}),
		}),
	);
	if (includeRepositoryDx) {
		writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env\n");
		// Generated-scaffold prompt assets (AGENTS.md, .agents/skills, symlinks,
		// manifest) so the freshness blocker stays green for fixture providers.
		syncPromptAssets(dir);
	}
	writeFileSync(join(dir, "Dockerfile"), "FROM oven/bun:1.2-alpine\n");
	writeFileSync(join(dir, "README.md"), readme);
	mkdirSync(join(dir, "__fixtures__"), { recursive: true });
	writeFileSync(join(dir, "__fixtures__", "raw.json"), '{"lookup":{"q":"btc","ok":true}}\n');
	writeFileSync(join(dir, "index.ts"), indexSource);
	linkLocalSdkDependency(dir);
	return dir;
}

function linkLocalSdkDependency(providerDir: string): void {
	const scopeDir = join(providerDir, "node_modules", "@apifuse");
	mkdirSync(scopeDir, { recursive: true });
	const target = join(scopeDir, "provider-sdk");
	if (!existsSync(target)) {
		symlinkSync(repoRoot, target, "dir");
	}
	const binDir = join(providerDir, "node_modules", ".bin");
	mkdirSync(binDir, { recursive: true });
	const binTarget = join(binDir, "apifuse");
	if (!existsSync(binTarget)) {
		symlinkSync(join(target, "bin", "apifuse.ts"), binTarget);
	}
}

function writeValidLocaleCatalogs(dir: string): void {
	mkdirSync(join(dir, "locales"), { recursive: true });
	const { en, ko } = makeValidLocaleCatalogs();
	writeFileSync(join(dir, "locales", "en.json"), JSON.stringify(en));
	writeFileSync(join(dir, "locales", "ko.json"), JSON.stringify(ko));
}

function makeValidLocaleCatalogs(): {
	en: Record<string, unknown>;
	ko: Record<string, unknown>;
} {
	const en = {
		provider: {
			meta: {
				description:
					"Good Provider exposes a deterministic submit-check fixture with provider-owned catalog copy.",
				docTitle: "Good Provider API",
				docDescription: "Reference documentation for the Good Provider submit-check fixture.",
				docSummary: "Deterministic provider used by submit-check tests.",
				docMarkdown:
					"Use Good Provider to validate provider-level and operation-level localized copy.",
				publicProfile: {
					displayName: "Good Provider",
					shortDescription: "Deterministic localized provider fixture.",
					longDescription:
						"Good Provider demonstrates localized public profile copy for submit-check validation.",
					capabilities: ["Catalog-backed lookup"],
					examplePrompts: ["Look up the btc fixture."],
					setupSummary: "No connection setup is required.",
					requirements: ["Provide a lookup query."],
					limitations: ["Fixture responses are deterministic."],
				},
			},
		},
		operations: {
			lookup: {
				description:
					"Use this lookup operation when callers need a deterministic provider fixture with catalog-owned copy, schema field descriptions, and health metadata for submit-check validation.",
				input: { description: "Lookup request input object." },
				output: { description: "Lookup response output object." },
				fields: {
					q: { description: "Lookup query text." },
					ok: { description: "Boolean success flag." },
				},
			},
		},
	};
	const ko = {
		provider: {
			meta: {
				description: "Good Provider는 제공자 소유 카탈로그 문구를 포함한 제출 검사 픽스처입니다.",
				docTitle: "Good Provider API",
				docDescription: "Good Provider 제출 검사 픽스처 참조 문서입니다.",
				docSummary: "제출 검사 테스트에 사용하는 결정적 제공자입니다.",
				docMarkdown: "Good Provider를 사용해 제공자 및 작업 수준 현지화 문구를 검증합니다.",
				publicProfile: {
					displayName: "Good Provider",
					shortDescription: "현지화된 결정적 제공자 픽스처입니다.",
					longDescription:
						"Good Provider는 제출 검사 검증을 위한 현지화된 공개 프로필 문구를 보여줍니다.",
					capabilities: ["카탈로그 기반 lookup"],
					examplePrompts: ["btc 픽스처를 조회합니다."],
					setupSummary: "연결 설정이 필요하지 않습니다.",
					requirements: ["lookup 검색어를 제공합니다."],
					limitations: ["픽스처 응답은 결정적입니다."],
				},
			},
		},
		operations: {
			lookup: {
				description: "제출 검사 검증을 위한 현지화된 lookup 작업 설명입니다.",
				input: { description: "Lookup 요청 입력 객체입니다." },
				output: { description: "Lookup 응답 출력 객체입니다." },
				fields: {
					q: { description: "Lookup 검색어입니다." },
					ok: { description: "성공 여부 플래그입니다." },
				},
			},
		},
	};
	return { en, ko };
}

function defaultReadme(): string {
	return [
		"# Good Provider",
		"",
		"## Parameters",
		"Describe the input parameters.",
		"",
		"## Response",
		"Describe the response fields.",
		"",
		"## Example",
		"Run bun run submit-check before submitting bounty evidence.",
	].join("\n");
}

function validProviderSource(extraOperationFields: string | undefined = undefined): string {
	return `
import { defineProvider, describeKey, z } from "@apifuse/provider-sdk";

const input = describeKey(
  z.object({
    q: describeKey(z.string(), "operations.lookup.fields.q.description"),
  }),
  "operations.lookup.input.description",
);

const output = describeKey(
  z.object({
    ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),
  }),
  "operations.lookup.output.description",
);

export default defineProvider({
  id: "good-provider",
  version: "1.0.0",
  runtime: "standard",
  allowedHosts: ["api.example.com"],
  reviewed: "community",
  auth: { mode: "none" },
  meta: {
    displayName: "Good Provider",
    descriptionKey: "provider.meta.description",
    category: "other",
    docTitleKey: "provider.meta.docTitle",
    docDescriptionKey: "provider.meta.docDescription",
    docSummaryKey: "provider.meta.docSummary",
    docMarkdownKey: "provider.meta.docMarkdown",
    publicProfile: {
      displayNameKey: "provider.meta.publicProfile.displayName",
      shortDescriptionKey: "provider.meta.publicProfile.shortDescription",
      longDescriptionKey: "provider.meta.publicProfile.longDescription",
      capabilityKeys: ["provider.meta.publicProfile.capabilities"],
      examplePromptKeys: ["provider.meta.publicProfile.examplePrompts"],
      setupSummaryKey: "provider.meta.publicProfile.setupSummary",
      requirementKeys: ["provider.meta.publicProfile.requirements"],
      limitationKeys: ["provider.meta.publicProfile.limitations"],
    },
  },
})({
  operations: {
    lookup: {
      descriptionKey: "operations.lookup.description",
      input,
      output,
      annotations: { readOnly: true, idempotent: true, openWorld: true },
      handler: async () => ({ ok: true }),
      fixtures: { request: { q: "btc" }, response: { ok: true } },
      ${
				extraOperationFields ??
				`healthCheck: {
        interval: "1m",
        cases: [{ name: "lookup ok", input: { q: "btc" }, assertions: ({ status, data }) => { if (status !== 200) { return { status: "degraded", label: "lookup changed" }; } if (!data) { throw new Error("empty lookup response"); } } }],
      },`
			}
    },
  },
});
`;
}

function sourceWithHandler(handlerSource: string): string {
	return validProviderSource().replace("handler: async () => ({ ok: true }),", handlerSource);
}

function sourceWithAuth(authSource: string): string {
	return validProviderSource().replace('auth: { mode: "none" },', authSource);
}

function assertionLines(count: number): string {
	return Array.from(
		{ length: count },
		(_, index) => `        const value${index} = input.q as string;`,
	).join("\n");
}

function sourceWithFactorySpreadDepthNoise(noise: string): string {
	return validProviderSource()
		.replace(
			"\nexport default defineProvider",
			"\nfunction makeOperations() { return {}; }\nconst hidden = makeOperations();\n\nexport default defineProvider",
		)
		.replace(
			'descriptionKey: "operations.lookup.description",',
			`descriptionKey: "operations.lookup.description",\n      ${noise}`,
		)
		.replace("\n    },\n  },\n});", "\n    },\n    ...hidden,\n  },\n});");
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("apifuse submit-check", () => {
	it("scores a review-ready provider and renders markdown", async () => {
		const dir = makeProviderDir("submit-ready-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir, {
			tier: "bronze",
			smoke: true,
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});

		expect(report.score.verdict).toBe("ready");
		expect(report.summary.blockers).toBe(0);
		expect(report.score.total).toBeGreaterThanOrEqual(90);
		expect(renderMarkdown(report)).toContain("APIFuse Provider Submission Report");
	});

	it("warns when generated repository DX files or scripts are missing", async () => {
		const dir = makeProviderDir(
			"submit-dx-warning-",
			validProviderSource(),
			defaultReadme(),
			false,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir, {
			tier: "bronze",
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});
		const dxCheck = report.checks.find((check) => check.id === "repository-dx");

		// Missing prompt assets are additionally a zero-point freshness blocker,
		// so a provider without the generated DX files is now blocked outright.
		expect(report.score.verdict).toBe("blocked");
		expect(report.checks.find((check) => check.id === "prompt-assets-fresh")?.status).toBe("fail");
		expect(dxCheck?.status).toBe("warn");
		expect(dxCheck?.message).toContain(".gitignore");
		expect(dxCheck?.message).toContain("AGENTS.md");
		expect(dxCheck?.message).toContain("type-check");
		expect(dxCheck?.remediation).toContain("apifuse create");
	});

	it("warns when check script does not run type-check", async () => {
		const dir = makeProviderDir(
			"submit-dx-check-warning-",
			validProviderSource(),
			defaultReadme(),
			true,
			"apifuse check .",
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir, {
			tier: "bronze",
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});
		const dxCheck = report.checks.find((check) => check.id === "repository-dx");

		expect(report.score.verdict).toBe("reviewable_with_warnings");
		expect(dxCheck?.status).toBe("warn");
		expect(dxCheck?.message).toContain("scripts.check includes type-check");
	});

	it("passes when provider id uses the short slug", async () => {
		const dir = makeProviderDir("submit-id-slug-pass-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "id-slug");

		expect(check?.status).toBe("pass");
		expect(check?.maxPoints).toBe(0);
		expect(check?.points).toBe(0);
		expect(report.summary.blockers).toBe(0);
	});

	it("blocks when provider id keeps the apifuse-provider prefix", async () => {
		const dir = makeProviderDir(
			"submit-id-slug-fail-",
			validProviderSource().replace('id: "good-provider"', 'id: "apifuse-provider-good-provider"'),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "id-slug");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.evidence).toContain("apifuse-provider-good-provider");
		expect(report.score.verdict).toBe("blocked");
		expect(report.summary.blockers).toBeGreaterThanOrEqual(1);
	});

	it("blocks on the apifuse-provider prefix via source scan when the provider fails to load", async () => {
		// Index has no default export, so safeLoadProvider returns null and the
		// rule must fall back to scanning source for the prefixed id literal.
		const dir = makeProviderDir(
			"submit-id-slug-fallback-",
			'export const providerId = "apifuse-provider-broken";\n',
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "id-slug");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.evidence?.some((line) => line.includes("index.ts"))).toBe(true);
		expect(report.score.verdict).toBe("blocked");
		expect(report.summary.blockers).toBeGreaterThanOrEqual(1);
	});

	it("returns a structured blocked report for a syntactically broken index", async () => {
		const dir = makeProviderDir(
			"submit-index-parse-blocked-",
			'const x = { input: z.object({}) };\nconst broken = "unterminated;\n',
		);
		writeValidLocaleCatalogs(dir);

		const report = await buildSubmitCheckReport(dir);
		const providerLoad = report.checks.find((item) => item.id === "provider-load");
		const parse = report.checks.find((item) => item.id === "provider-load-parse");
		expect(providerLoad?.status).toBe("fail");
		expect(parse?.status).toBe("fail");
		expect(parse?.evidence?.some((line) => line.includes("index.ts"))).toBe(true);
		expect(report.score.verdict).toBe("blocked");
	});

	it("passes when provider root has no vendor SDK shim directory", async () => {
		const dir = makeProviderDir("submit-no-vendor-shim-pass-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-vendor-shim");

		expect(check?.status).toBe("pass");
		expect(check?.maxPoints).toBe(0);
		expect(check?.points).toBe(0);
		expect(report.summary.blockers).toBe(0);
	});

	it("blocks when provider root contains a vendor SDK shim directory", async () => {
		const dir = makeProviderDir("submit-no-vendor-shim-fail-", validProviderSource());
		mkdirSync(join(dir, "vendor"), { recursive: true });
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-vendor-shim");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.evidence?.[0]).toContain("vendor");
		expect(report.score.verdict).toBe("blocked");
		expect(report.summary.blockers).toBeGreaterThanOrEqual(1);
	});

	it("passes when source files import directly from the SDK", async () => {
		const dir = makeProviderDir("submit-no-vendor-import-pass-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-vendor-import");

		expect(check?.status).toBe("pass");
		expect(check?.maxPoints).toBe(0);
		expect(check?.points).toBe(0);
		expect(report.summary.blockers).toBe(0);
	});

	it("blocks when source files import from vendor shim paths", async () => {
		const dir = makeProviderDir("submit-no-vendor-import-fail-", validProviderSource());
		writeFileSync(
			join(dir, "helper.ts"),
			'import { defineProvider } from "../vendor/provider-sdk";\n',
		);
		mkdirSync(join(dir, "tests"), { recursive: true });
		writeFileSync(
			join(dir, "tests", "ignored.ts"),
			'import { defineProvider } from "../vendor/provider-sdk";\n',
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-vendor-import");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.evidence).toContain("helper.ts:1");
		expect(report.score.verdict).toBe("blocked");
		expect(report.summary.blockers).toBeGreaterThanOrEqual(1);
	});

	it("passes when schema descriptions use describeKey", async () => {
		const dir = makeProviderDir("submit-describe-key-pass-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "describe-key");

		expect(check?.status).toBe("pass");
		expect(check?.maxPoints).toBe(0);
		expect(check?.points).toBe(0);
		expect(report.summary.blockers).toBe(0);
	});

	it("blocks when source schemas use raw describe prose", async () => {
		const dir = makeProviderDir("submit-describe-key-fail-", validProviderSource());
		writeFileSync(
			join(dir, "schema.ts"),
			'import { z } from "@apifuse/provider-sdk";\nexport const schema = z.string().describe("Raw prose");\n',
		);
		writeFileSync(
			join(dir, "schema.test.ts"),
			'import { z } from "@apifuse/provider-sdk";\nexport const schema = z.string().describe("Ignored test prose");\n',
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "describe-key");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.evidence).toContain("schema.ts:2");
		expect(report.score.verdict).toBe("blocked");
		expect(report.summary.blockers).toBeGreaterThanOrEqual(1);
	});

	it("passes when provider source uses ctx.stealth.fetch", async () => {
		const dir = makeProviderDir(
			"submit-no-raw-fetch-pass-",
			`${validProviderSource()}
async function useStealth(ctx: { stealth: { fetch: typeof fetch } }) {
  await ctx.stealth.fetch("https://api.example.com/lookup");
}
void useStealth;
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-raw-fetch");

		expect(check?.status).toBe("pass");
		expect(check?.maxPoints).toBe(0);
		expect(check?.points).toBe(0);
		expect(report.summary.blockers).toBe(0);
	});

	it("blocks when provider source uses raw fetch", async () => {
		const dir = makeProviderDir(
			"submit-no-raw-fetch-fail-",
			sourceWithHandler(`handler: async () => {
        await fetch("https://api.example.com/lookup");
        return { ok: true };
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-raw-fetch");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.evidence?.some((line) => line.includes("index.ts"))).toBe(true);
		expect(report.score.verdict).toBe("blocked");
	});

	it("ignores raw fetch syntax inside comments", async () => {
		const dir = makeProviderDir(
			"submit-no-raw-fetch-comment-",
			`${validProviderSource()}\n// Example only: fetch("https://api.example.com/lookup")\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-raw-fetch");

		expect(check?.status).toBe("pass");
		expect(check?.evidence).toBeUndefined();
	});

	it("ignores raw fetch syntax inside string literals", async () => {
		const dir = makeProviderDir(
			"submit-no-raw-fetch-string-",
			`${validProviderSource()}\nconst documentation = "Call fetch( through the SDK client";\nvoid documentation;\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-raw-fetch");

		expect(check?.status).toBe("pass");
		expect(check?.evidence).toBeUndefined();
	});

	it("blocks eval-based dynamic code evaluation", async () => {
		const dir = makeProviderDir(
			"submit-no-dynamic-code-eval-",
			`${validProviderSource()}\nvoid eval("fetch(x)");\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-dynamic-code");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
		expect(check?.maxPoints).toBe(0);
		expect(check?.evidence?.some((line) => line.includes("index.ts:"))).toBe(true);
	});

	it("blocks globalThis.eval dynamic code evaluation", async () => {
		const dir = makeProviderDir(
			"submit-no-dynamic-code-globalthis-eval-",
			`${validProviderSource()}\nexport function risky(u: string) { return globalThis.eval("fetch(u)"); }\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const dynamicCheck = report.checks.find((item) => item.id === "no-dynamic-code");
		const fetchCheck = report.checks.find((item) => item.id === "no-raw-fetch");

		expect(dynamicCheck?.status).toBe("fail");
		expect(dynamicCheck?.level).toBe("blocker");
		expect(dynamicCheck?.evidence).toEqual(["index.ts:61"]);
		expect(fetchCheck?.status).toBe("pass");
	});

	it("blocks window.eval dynamic code evaluation", async () => {
		const dir = makeProviderDir(
			"submit-no-dynamic-code-window-eval-",
			`${validProviderSource()}\nvoid window.eval("1");\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-dynamic-code");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks globalThis.Function dynamic code evaluation", async () => {
		const dir = makeProviderDir(
			"submit-no-dynamic-code-globalthis-function-",
			`${validProviderSource()}\nconst generated = globalThis.Function("return 1");\nvoid generated;\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-dynamic-code");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks comma-indirect eval dynamic code evaluation", async () => {
		const dir = makeProviderDir(
			"submit-no-dynamic-code-indirect-eval-",
			`${validProviderSource()}\nvoid (0, eval)("1");\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-dynamic-code");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks optional eval dynamic code evaluation", async () => {
		const dir = makeProviderDir(
			"submit-no-dynamic-code-optional-eval-",
			`${validProviderSource()}\nvoid eval?.("1");\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-dynamic-code");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks new Function dynamic code evaluation", async () => {
		const dir = makeProviderDir(
			"submit-no-dynamic-code-new-function-",
			`${validProviderSource()}\nconst generated = new Function("return 1");\nvoid generated;\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-dynamic-code");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks bare Function dynamic code evaluation", async () => {
		const dir = makeProviderDir(
			"submit-no-dynamic-code-function-",
			`${validProviderSource()}\nconst generated = Function("return 1");\nvoid generated;\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-dynamic-code");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("ignores dynamic-code words inside comments and strings", async () => {
		const dir = makeProviderDir(
			"submit-no-dynamic-code-inert-text-",
			`${validProviderSource()}\n// Example only: eval("fetch(x)")\nconst documentation = "Use Function( only in a sandbox";\nvoid documentation;\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-dynamic-code");

		expect(check?.status).toBe("pass");
		expect(check?.evidence).toBeUndefined();
	});

	it("does not match identifiers that merely contain eval", async () => {
		const dir = makeProviderDir(
			"submit-no-dynamic-code-identifier-boundary-",
			`${validProviderSource()}\nfunction evaluateTotal(value: number) { return value; }\nconst helper = { evaluate: evaluateTotal };\nvoid evaluateTotal(1);\nvoid helper.evaluate(1);\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-dynamic-code");

		expect(check?.status).toBe("pass");
	});

	it("passes the dynamic-code rule for a clean provider", async () => {
		const dir = makeProviderDir("submit-no-dynamic-code-clean-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-dynamic-code");

		expect(check?.status).toBe("pass");
		expect(check?.maxPoints).toBe(0);
		expect(check?.points).toBe(0);
	});

	it("ignores raw fetch syntax in a quoted property key", async () => {
		const dir = makeProviderDir(
			"submit-no-raw-fetch-property-key-",
			`${validProviderSource()}\nconst examples = { "fetch(": "use ctx.http instead" };\nvoid examples;\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-raw-fetch");

		expect(check?.status).toBe("pass");
		expect(check?.evidence).toBeUndefined();
	});

	it("warns standalone bounty submissions for self-hosted browser runtime patterns", async () => {
		const dir = makeProviderDir(
			"submit-managed-browser-warning-",
			sourceWithHandler(`handler: async () => {
        const ws = process.env.AMAZON_CDP_URL;
        const versionPath = "/json/version";
        void puppeteer.launch;
        return { ok: Boolean(ws || versionPath) };
      },`).replace('runtime: "standard"', 'runtime: "browser"'),
		);
		mkdirSync(join(dir, "src", "browser"), { recursive: true });
		writeFileSync(
			join(dir, "src", "browser", "local-cdp.ts"),
			`
export async function openLocalBrowser() {
  const ws = process.env.AMAZON_CDP_URL;
  const versionPath = "/json/version";
  return { ws, versionPath };
}
`,
		);
		mkdirSync(join(dir, "bin"), { recursive: true });
		writeFileSync(
			join(dir, "bin", "browser-entrypoint.mjs"),
			"const browser = await puppeteer.launch();\n",
		);
		writeFileSync(
			join(dir, "entrypoint.sh"),
			"#!/usr/bin/env bash\nchromium --remote-debugging-port=9222\n",
		);
		writeFileSync(
			join(dir, "Dockerfile"),
			'FROM oven/bun:1.2-alpine\nCMD ["google-chrome", "--remote-debugging-port=9222"]\n',
		);
		writeValidLocaleCatalogs(dir);

		const report = await buildSubmitCheckReport(dir, {
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});
		const check = report.checks.find((item) => item.id === "managed-browser-runtime");

		expect(check?.level).toBe("warn");
		expect(check?.status).toBe("warn");
		expect(check?.maxPoints).toBe(0);
		expect(check?.message).toContain("self-hosted browser/CDP");
		expect(check?.remediation).toContain("ctx.browser");
		expect(check?.remediation).toContain("managed CDP Pool");
		expect(check?.evidence?.join("\n")).toContain("browser-provider-local-cdp-env");
		expect(check?.evidence?.join("\n")).toContain("browser-self-hosted-launch");
		expect(check?.evidence?.join("\n")).toContain("entrypoint.sh");
		expect(check?.evidence?.join("\n")).toContain("Dockerfile");
		expect(
			report.checks.some(
				(item) =>
					item.id === "managed-browser-runtime" &&
					item.level === "blocker" &&
					item.status === "fail",
			),
		).toBe(false);
	});

	it("does not flag member fetch or fetch-like identifiers", async () => {
		const dir = makeProviderDir(
			"submit-no-raw-fetch-guard-",
			sourceWithHandler(`handler: async () => {
        const client = { fetch: async () => undefined };
        await client.fetch();
        await prefetch();
        await refetch();
        return { ok: true };
      },`),
		);
		writeFileSync(
			join(dir, "helpers.ts"),
			"export async function prefetch() {}\nexport async function refetch() {}\n",
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "no-raw-fetch");

		expect(check?.status).toBe("pass");
		expect(report.summary.blockers).toBe(0);
	});

	it("passes when type assertions stay within the recommended limit", async () => {
		const dir = makeProviderDir(
			"submit-as-assertion-pass-",
			sourceWithHandler(`handler: async (_ctx, input) => {
${assertionLines(5)}
        const tuple = ["allowed"] as const;
        return { ok: Boolean(value0 && value1 && value2 && value3 && value4 && tuple) };
      },`),
		);
		writeFileSync(
			join(dir, "import-alias.ts"),
			'import { defineProvider as aliasedDefineProvider } from "@apifuse/provider-sdk";\nexport { aliasedDefineProvider };\n',
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir, {
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});
		const check = report.checks.find((item) => item.id === "as-assertion-count");

		expect(check?.status).toBe("pass");
		expect(check?.maxPoints).toBe(0);
		expect(check?.points).toBe(0);
		expect(report.score.verdict).toBe("reviewable_with_warnings");
	});

	it("does not count type assertion examples inside comments", async () => {
		const examples = Array.from(
			{ length: 6 },
			(_, index) => `// example ${index}: value as unknown`,
		).join("\n");
		const dir = makeProviderDir(
			"submit-as-assertion-comment-",
			`${validProviderSource()}\n${examples}\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "as-assertion-count");

		expect(check?.status).toBe("pass");
		expect(check?.message).toBe("Type assertions are within the recommended limit.");
	});

	it("does not count type assertion examples inside string literals", async () => {
		const examples = Array.from(
			{ length: 6 },
			(_, index) => `const assertionExample${index} = "value as unknown";`,
		).join("\n");
		const dir = makeProviderDir(
			"submit-as-assertion-string-",
			`${validProviderSource()}\n${examples}\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "as-assertion-count");

		expect(check?.status).toBe("pass");
		expect(check?.message).toBe("Type assertions are within the recommended limit.");
	});

	it("does not count type assertion syntax in a quoted property key", async () => {
		const dir = makeProviderDir(
			"submit-as-assertion-property-key-",
			sourceWithHandler(`handler: async (_ctx, input) => {
${assertionLines(5)}
        const examples = { "value as unknown": true };
        return { ok: Boolean(value0 && value1 && value2 && value3 && value4 && examples) };
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "as-assertion-count");

		expect(check?.status).toBe("pass");
		expect(check?.message).toBe("Type assertions are within the recommended limit.");
	});

	it("warns for moderate type assertion counts without changing score", async () => {
		const dir = makeProviderDir(
			"submit-as-assertion-warn-",
			sourceWithHandler(`handler: async (_ctx, input) => {
${assertionLines(6)}
        return { ok: Boolean(value0 && value1 && value2 && value3 && value4 && value5) };
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir, {
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});
		const check = report.checks.find((item) => item.id === "as-assertion-count");

		expect(check?.level).toBe("warn");
		expect(check?.status).toBe("warn");
		expect(check?.maxPoints).toBe(0);
		expect(check?.points).toBe(0);
		expect(check?.message).toContain("6 type assertions");
		expect(report.score.total).toBeGreaterThanOrEqual(90);
		expect(report.score.verdict).toBe("reviewable_with_warnings");
	});

	it("blocks for excessive type assertion counts", async () => {
		const dir = makeProviderDir(
			"submit-as-assertion-blocker-",
			sourceWithHandler(`handler: async (_ctx, input) => {
${assertionLines(21)}
        return { ok: Boolean(value0) };
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "as-assertion-count");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.maxPoints).toBe(0);
		expect(check?.points).toBe(0);
		expect(check?.message).toContain("21 type assertions");
		expect(report.score.verdict).toBe("blocked");
	});

	it("warns when an auth provider does not reference ctx.credential", async () => {
		const dir = makeProviderDir(
			"submit-credential-usage-warn-",
			sourceWithAuth(`auth: {
    mode: "credentials",
    flow: {
      continue: async () => ({
        kind: "complete",
        turnId: crypto.randomUUID(),
        data: { credential: { userId: "user_123" } },
      }),
    },
  },
  credential: { keys: ["userId"] },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir, {
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});
		const check = report.checks.find((item) => item.id === "credential-usage");

		expect(check?.level).toBe("warn");
		expect(check?.status).toBe("warn");
		expect(check?.maxPoints).toBe(0);
		expect(check?.points).toBe(0);
		expect(report.score.verdict).toBe("reviewable_with_warnings");
	});

	it("warns when the only credential reference is inside a comment", async () => {
		const source = `${sourceWithAuth(`auth: {
    mode: "credentials",
    flow: {
      continue: async () => ({
        kind: "complete",
        turnId: crypto.randomUUID(),
        data: { credential: { userId: "user_123" } },
      }),
    },
  },
  credential: { keys: ["userId"] },`)}
// ctx.credential would be used here
`;
		const dir = makeProviderDir("submit-credential-comment-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "credential-usage");

		expect(check?.level).toBe("warn");
		expect(check?.status).toBe("warn");
	});

	it("warns when the only credential reference is inside a string literal", async () => {
		const source = `${sourceWithAuth(`auth: {
    mode: "credentials",
    flow: {
      continue: async () => ({
        kind: "complete",
        turnId: crypto.randomUUID(),
        data: { credential: { userId: "user_123" } },
      }),
    },
  },
  credential: { keys: ["userId"] },`)}
const credentialDocumentation = "ctx.credential.get";
void credentialDocumentation;
`;
		const dir = makeProviderDir("submit-credential-string-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "credential-usage");

		expect(check?.level).toBe("warn");
		expect(check?.status).toBe("warn");
	});

	it("warns when the only credential reference is a quoted property key", async () => {
		const source = `${sourceWithAuth(`auth: {
    mode: "credentials",
    flow: {
      continue: async () => ({
        kind: "complete",
        turnId: crypto.randomUUID(),
        data: { credential: { userId: "user_123" } },
      }),
    },
  },
  credential: { keys: ["userId"] },`)}
const examples = { "ctx.credential": "persist through the SDK" };
void examples;
`;
		const dir = makeProviderDir("submit-credential-property-key-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "credential-usage");

		expect(check?.level).toBe("warn");
		expect(check?.status).toBe("warn");
	});

	it("passes credential usage for no-auth providers", async () => {
		const dir = makeProviderDir("submit-credential-usage-no-auth-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "credential-usage");

		expect(check?.status).toBe("pass");
		expect(check?.maxPoints).toBe(0);
		expect(check?.points).toBe(0);
	});

	it("passes credential usage when auth provider references ctx.credential", async () => {
		const dir = makeProviderDir(
			"submit-credential-usage-pass-",
			sourceWithAuth(`auth: {
    mode: "credentials",
    flow: {
      continue: async () => ({
        kind: "complete",
        turnId: crypto.randomUUID(),
        data: { credential: { userId: "user_123" } },
      }),
    },
  },
  credential: { keys: ["userId"] },`).replace(
				"handler: async () => ({ ok: true }),",
				'handler: async (ctx) => ({ ok: Boolean(ctx.credential.get("userId")) }),',
			),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "credential-usage");

		expect(check?.status).toBe("pass");
		expect(check?.evidence?.some((line) => line.includes("index.ts"))).toBe(true);
	});

	it("blocks key-only providers when the English locale catalog is missing", async () => {
		const dir = makeProviderDir("submit-missing-locale-", validProviderSource());
		const report = await buildSubmitCheckReport(dir, {
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});

		expect(report.score.verdict).toBe("blocked");
		expect(report.summary.blockers).toBeGreaterThan(0);
		expect(report.checks.find((check) => check.id === "locale-catalog")?.evidence).toContain(
			"en:*: Missing provider locale catalog for en",
		);
	});

	it("blocks key-only providers when the English locale catalog is missing a required key", async () => {
		const dir = makeProviderDir("submit-missing-en-key-", validProviderSource());
		const { en, ko } = makeValidLocaleCatalogs();
		mkdirSync(join(dir, "locales"), { recursive: true });
		delete (en.operations as { lookup: { description?: string } }).lookup.description;
		writeFileSync(join(dir, "locales", "en.json"), JSON.stringify(en));
		writeFileSync(join(dir, "locales", "ko.json"), JSON.stringify(ko));

		const report = await buildSubmitCheckReport(dir, {
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});

		expect(report.score.verdict).toBe("blocked");
		expect(report.checks.find((check) => check.id === "locale-catalog")?.evidence).toContain(
			"en:operations.lookup.description: Missing provider locale key operations.lookup.description in en",
		);
	});

	it("blocks key-only providers when the English locale catalog is missing a provider meta key", async () => {
		const dir = makeProviderDir("submit-missing-en-provider-meta-key-", validProviderSource());
		const { en, ko } = makeValidLocaleCatalogs();
		mkdirSync(join(dir, "locales"), { recursive: true });
		delete (en.provider as { meta: { description?: string } }).meta.description;
		writeFileSync(join(dir, "locales", "en.json"), JSON.stringify(en));
		writeFileSync(join(dir, "locales", "ko.json"), JSON.stringify(ko));

		const report = await buildSubmitCheckReport(dir, {
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});

		expect(report.score.verdict).toBe("blocked");
		expect(report.checks.find((check) => check.id === "locale-catalog")?.evidence).toContain(
			"en:provider.meta.description: Missing provider locale key provider.meta.description in en",
		);
	});

	it("blocks key-only providers when the Korean locale catalog is missing", async () => {
		const dir = makeProviderDir("submit-missing-ko-locale-", validProviderSource());
		const { en } = makeValidLocaleCatalogs();
		mkdirSync(join(dir, "locales"), { recursive: true });
		writeFileSync(join(dir, "locales", "en.json"), JSON.stringify(en));

		const report = await buildSubmitCheckReport(dir, {
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});

		expect(report.score.verdict).toBe("blocked");
		expect(report.checks.find((check) => check.id === "locale-catalog")?.evidence).toContain(
			"ko:*: Missing provider locale catalog for ko",
		);
	});

	it("blocks key-only providers when the Korean locale catalog is missing a required key", async () => {
		const dir = makeProviderDir("submit-missing-ko-key-", validProviderSource());
		const { en, ko } = makeValidLocaleCatalogs();
		mkdirSync(join(dir, "locales"), { recursive: true });
		delete (ko.operations as { lookup: { description?: string } }).lookup.description;
		writeFileSync(join(dir, "locales", "en.json"), JSON.stringify(en));
		writeFileSync(join(dir, "locales", "ko.json"), JSON.stringify(ko));

		const report = await buildSubmitCheckReport(dir, {
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});

		expect(report.score.verdict).toBe("blocked");
		expect(report.checks.find((check) => check.id === "locale-catalog")?.evidence).toContain(
			"ko:operations.lookup.description: Missing provider locale key operations.lookup.description in ko",
		);
	});

	it("blocks key-only providers when the Korean locale catalog is missing a public profile key", async () => {
		const dir = makeProviderDir("submit-missing-ko-public-profile-key-", validProviderSource());
		const { en, ko } = makeValidLocaleCatalogs();
		mkdirSync(join(dir, "locales"), { recursive: true });
		delete (
			ko.provider as {
				meta: { publicProfile: { shortDescription?: string } };
			}
		).meta.publicProfile.shortDescription;
		writeFileSync(join(dir, "locales", "en.json"), JSON.stringify(en));
		writeFileSync(join(dir, "locales", "ko.json"), JSON.stringify(ko));

		const report = await buildSubmitCheckReport(dir, {
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});

		expect(report.score.verdict).toBe("blocked");
		expect(report.checks.find((check) => check.id === "locale-catalog")?.evidence).toContain(
			"ko:provider.meta.publicProfile.shortDescription: Missing provider locale key provider.meta.publicProfile.shortDescription in ko",
		);
	});

	it("runs the CLI with JSON and Markdown output", async () => {
		const dir = makeProviderDir("submit-cli-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const markdownPath = join(dir, "submission-report.md");
		const proc = Bun.spawn(
			[
				"bun",
				submitCheckCliPath,
				"submit-check",
				dir,
				"--json",
				"--markdown",
				markdownPath,
				"--smoke",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout).score.verdict).toBe("ready");
		expect(existsSync(markdownPath)).toBeTrue();
		expect(readFileSync(markdownPath, "utf8")).toContain("APIFuse Provider Submission Report");
	}, 60_000);

	it("warns with zero smoke points when measured smoke is not run", async () => {
		const dir = makeProviderDir("submit-no-smoke-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir, {
			smokeNote: "GET /health and POST /v1/lookup passed locally.",
		});
		const check = report.checks.find((item) => item.id === "local-smoke");

		expect(check?.status).toBe("warn");
		expect(check?.points).toBe(0);
		expect(check?.remediation).toContain("--smoke");
		expect(check?.evidence).toContain(
			"Deprecated --smoke-note was provided and ignored for scoring.",
		);
	});

	it("passes measured smoke for an offline scaffold-like provider", async () => {
		const dir = makeProviderDir("submit-smoke-pass-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir, { smoke: true });
		const check = report.checks.find((item) => item.id === "local-smoke");

		expect(check?.status).toBe("pass");
		expect(check?.points).toBe(10);
		expect(check?.evidence?.join("\n")).toContain("lookup: success HTTP 200");
	});

	it("blocks measured smoke when a handler throws an unstructured error", async () => {
		const dir = makeProviderDir(
			"submit-smoke-fail-",
			sourceWithHandler(`handler: async () => {
        throw new Error("boom");
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir, { smoke: true });
		const check = report.checks.find((item) => item.id === "local-smoke");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.points).toBe(0);
		expect(check?.evidence?.join("\n")).toContain("lookup: incoherent HTTP 500");
	});

	it("blocks when health coverage is missing", async () => {
		const dir = makeProviderDir("submit-missing-health-", validProviderSource(""));
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);

		expect(report.score.verdict).toBe("blocked");
		expect(report.summary.blockers).toBeGreaterThan(0);
	});

	it("blocks empty recorded fixture provenance for real operations", async () => {
		const dir = makeProviderDir("submit-empty-raw-real-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		writeFileSync(join(dir, "__fixtures__", "raw.json"), "{}\n");
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "fixture-provenance");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
		expect(check?.message).toContain("__fixtures__/raw.json is empty or missing");
		expect(report.score.verdict).toBe("blocked");
	});

	it("warns on empty recorded fixture provenance for generated local-only scaffolds", async () => {
		const dir = makeProviderDir(
			"submit-empty-raw-scaffold-",
			validProviderSource(
				'healthCheckUnsupported: { reason: "generated local-only scaffold until real upstream access exists" },',
			),
		);
		writeValidLocaleCatalogs(dir);
		writeFileSync(join(dir, "__fixtures__", "raw.json"), "{}\n");
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "fixture-provenance");

		expect(check?.status).toBe("warn");
		expect(check?.level).toBe("warn");
		expect(check?.message).toContain("bun run record");
		expect(report.summary.blockers).toBe(0);
	});

	it("blocks missing recorded fixture provenance", async () => {
		const dir = makeProviderDir("submit-missing-raw-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		rmSync(join(dir, "__fixtures__", "raw.json"), { force: true });
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "fixture-provenance");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
		expect(report.score.verdict).toBe("blocked");
	});

	it("passes non-empty recorded fixture provenance", async () => {
		const dir = makeProviderDir("submit-non-empty-raw-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "fixture-provenance");

		expect(check?.status).toBe("pass");
	});

	it("accepts a stream evidence fixture with one allowlisted header", () => {
		const preview = Buffer.alloc(STREAM_PREVIEW_BYTES, 0x50);
		expect(
			hasNonEmptyRecordedFixture({
				__apifuse_stream__: true,
				status: 200,
				ok: true,
				headers: { "content-type": "application/zip" },
				body_sha256: "a".repeat(64),
				body_bytes: 805_000,
				body_preview_base64: preview.toString("base64"),
			}),
		).toBeTrue();
	});

	it("rejects structurally inconsistent or unsafe stream evidence fixtures", () => {
		const validEvidence = {
			__apifuse_stream__: true,
			status: 200,
			ok: true,
			headers: { "content-type": "application/zip" },
			body_sha256: "a".repeat(64),
			body_bytes: 805_000,
			body_preview_base64: Buffer.alloc(STREAM_PREVIEW_BYTES, 0x50).toString("base64"),
		};

		expect(
			hasNonEmptyRecordedFixture({ ...validEvidence, body_preview_base64: "UEsDBA==" }),
		).toBeFalse();
		expect(
			hasNonEmptyRecordedFixture({
				...validEvidence,
				headers: { authorization: "Bearer must-not-replay" },
			}),
		).toBeFalse();
	});

	it("does not discard ordinary fixtures that merely reuse the marker field name", () => {
		for (const markerValue of ["upstream-domain-value", true]) {
			expect(
				hasNonEmptyRecordedFixture({
					__apifuse_stream__: markerValue,
					items: [{ id: "one", label: "retained" }],
				}),
			).toBeTrue();
		}
	});

	it("surfaces a field-specific malformed stream evidence diagnostic", async () => {
		const dir = makeProviderDir("submit-malformed-stream-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		writeFileSync(
			join(dir, "__fixtures__", "raw.json"),
			JSON.stringify({
				__apifuse_stream__: true,
				status: 200,
				ok: true,
				headers: {},
				body_sha256: "a".repeat(64),
				body_bytes: 3,
				body_preview_base64: "%%%",
			}),
		);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "fixture-provenance");
		expect(check?.status).toBe("fail");
		expect(check?.message).toContain("body_preview_base64");
		expect(check?.message).not.toContain("empty or missing");
	});

	it("accepts a top-level recorded Cabinet Office-shaped Japanese CSV payload", async () => {
		const rawCsv = [
			"国民の祝日・休日月日,国民の祝日・休日名称",
			"2026/1/1,元日",
			"2026/1/12,成人の日",
			"2026/2/11,建国記念の日",
			"2026/2/23,天皇誕生日",
			"2026/3/20,春分の日",
			"2026/4/29,昭和の日",
			"2026/5/3,憲法記念日",
			"2026/5/4,みどりの日",
			"2026/5/5,こどもの日",
			"2026/5/6,振替休日",
			"2026/7/20,海の日",
			"2026/8/11,山の日",
			"2026/9/21,敬老の日",
			"2026/9/22,国民の休日",
			"2026/9/23,秋分の日",
			"2026/10/12,スポーツの日",
			"2026/11/3,文化の日",
			"2026/11/23,勤労感謝の日",
		].join("\r\n");

		expect(hasSubstantiveDelimitedTextStructure(rawCsv)).toBeTrue();
		expect(hasNonEmptyRecordedFixture(rawCsv)).toBeTrue();

		const dir = makeProviderDir("submit-japanese-csv-raw-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		writeFileSync(join(dir, "__fixtures__", "raw.json"), JSON.stringify(rawCsv));
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "fixture-provenance");

		expect(check?.status).toBe("pass");
		expect(report.score.verdict).not.toBe("blocked");
	});

	for (const [caseName, rawText] of [
		["short delimited text", "date,name\n2026/1/1,元日\n2026/1/12,成人の日"],
		[
			"multi-line prose",
			[
				"This is a long prose paragraph describing an upstream service without tabular fields.",
				"It continues on another line and intentionally contains enough detail to cross the length floor.",
				"A final sentence confirms that ordinary explanatory text is not recorded delimited evidence.",
			].join("\n"),
		],
		["single-line delimited text", "date,name,".repeat(30)],
	] as const) {
		it(`blocks ${caseName} as recorded fixture provenance`, () => {
			expect(hasSubstantiveDelimitedTextStructure(rawText)).toBeFalse();
			expect(hasNonEmptyRecordedFixture(rawText)).toBeFalse();
		});
	}

	it("passes the real EV root-operation raw XML fixture shape", async () => {
		const dir = makeProviderDir("submit-ev-xml-raw-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const rawXml = [
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
			"<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg>",
			"<totalCount>75374</totalCount><pageNo>1</pageNo><numOfRows>10</numOfRows></header>",
			"<body><items><item><statNm>낙성대동주민센터</statNm><statId>ME174013</statId>",
			"<chgerId>01</chgerId><chgerType>06</chgerType><addr>서울특별시 관악구 낙성대로4가길 5</addr>",
			"<lat>37.476296</lat><lng>126.9583876</lng><stat>2</stat></item></items></body></response>",
		].join("");
		writeFileSync(
			join(dir, "__fixtures__", "raw.json"),
			JSON.stringify({ "search-chargers": rawXml }),
		);

		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "fixture-provenance");

		expect(check?.status).toBe("pass");
	});

	it("accepts domain faultCode fields inside recorded XML items", async () => {
		const dir = makeProviderDir("submit-domain-fault-code-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const rawXml = [
			"<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>",
			"<body><items><item><recordId>EV-FAULT-001</recordId><faultCode>connector_overheat</faultCode>",
			"<faultMessage>Connector temperature sensor reading for this charger</faultMessage>",
			"<observedAt>2026-07-15T00:00:00Z</observedAt></item></items></body></response>",
		].join("");
		writeFileSync(
			join(dir, "__fixtures__", "raw.json"),
			JSON.stringify({ "charger-diagnostics": rawXml }),
		);

		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "fixture-provenance");

		expect(check?.status).toBe("pass");
	});

	for (const [caseName, rawXml] of [
		[
			"malformed XML",
			"<response><header><resultCode>00</resultCode></header><body><items><item><id>EV-1</id><status>available</status></items></body></response>",
		],
		[
			"HTML",
			`<html><head><title>Service unavailable</title></head><body><h1>Upstream error</h1><p>${"Please retry later. ".repeat(8)}</p></body></html>`,
		],
		[
			"DOCTYPE",
			'<!DOCTYPE response [<!ENTITY station SYSTEM "file:///etc/hostname">]><response><header><resultCode>00</resultCode></header><body><items><item><id>&station;</id><status>available for charging</status></item></items></body></response>',
		],
		[
			"processing instruction",
			'<?recording source="upstream"?><response><header><resultCode>00</resultCode></header><body><items><item><id>EV-1</id><status>available for charging</status></item></items></body></response>',
		],
		[
			"error root",
			`<Error><Code>ServiceUnavailable</Code><Message>${"The upstream request could not be completed. ".repeat(4)}</Message></Error>`,
		],
		[
			"failure control envelope",
			`<response><header><resultCode>30</resultCode><resultMsg>${"SERVICE KEY IS NOT REGISTERED ".repeat(4)}</resultMsg></header><body><items><item><id>EV-1</id><status>available</status></item></items></body></response>`,
		],
		[
			"control-only success envelope",
			`<response><header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg><totalCount>75374</totalCount><pageNo>1</pageNo><numOfRows>10</numOfRows></header>${" ".repeat(64)}</response>`,
		],
	] as const) {
		it(`blocks ${caseName} as recorded XML evidence`, async () => {
			const dir = makeProviderDir("submit-invalid-xml-raw-", validProviderSource());
			writeValidLocaleCatalogs(dir);
			writeFileSync(join(dir, "__fixtures__", "raw.json"), JSON.stringify({ lookup: rawXml }));

			const report = await buildSubmitCheckReport(dir);
			const check = report.checks.find((item) => item.id === "fixture-provenance");

			expect(check?.status).toBe("fail");
			expect(check?.level).toBe("blocker");
		});
	}

	it("blocks recorded XML above the size limit", async () => {
		const dir = makeProviderDir("submit-oversized-xml-raw-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const rawXml = `<response><body><items><item><recordId>EV-1</recordId><description>${"x".repeat(
			4 * 1024 * 1024,
		)}</description></item></items></body></response>`;
		writeFileSync(join(dir, "__fixtures__", "raw.json"), JSON.stringify({ lookup: rawXml }));

		const report = await buildSubmitCheckReport(dir);
		expect(report.checks.find((item) => item.id === "fixture-provenance")?.status).toBe("fail");
	});

	it("blocks recorded XML above the depth limit", async () => {
		const dir = makeProviderDir("submit-deep-xml-raw-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const rawXml = `<response><body>${"<layer>".repeat(
			65,
		)}<item><recordId>EV-1</recordId><description>available for charging today</description></item>${"</layer>".repeat(
			65,
		)}</body></response>`;
		writeFileSync(join(dir, "__fixtures__", "raw.json"), JSON.stringify({ lookup: rawXml }));

		const report = await buildSubmitCheckReport(dir);
		expect(report.checks.find((item) => item.id === "fixture-provenance")?.status).toBe("fail");
	});

	it("blocks recorded XML above the element-width limit", async () => {
		const dir = makeProviderDir("submit-wide-xml-raw-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const rawXml = `<response><body><items>${"<marker/>".repeat(
			50_001,
		)}<item><recordId>EV-1</recordId><description>available for charging today</description></item></items></body></response>`;
		writeFileSync(join(dir, "__fixtures__", "raw.json"), JSON.stringify({ lookup: rawXml }));

		const report = await buildSubmitCheckReport(dir);
		expect(report.checks.find((item) => item.id === "fixture-provenance")?.status).toBe("fail");
	});

	it("blocks flat primitive raw fixture provenance", async () => {
		const dir = makeProviderDir("submit-flat-raw-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		writeFileSync(join(dir, "__fixtures__", "raw.json"), '{"a":1}\n');
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "fixture-provenance");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks vendor keys leaked from public output schemas with source evidence", async () => {
		const source = validProviderSource()
			.replace(
				`ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
				`MKioskTy: z.string(),
    duty_name: z.string(),
    ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
			)
			.replace(
				"handler: async () => ({ ok: true }),",
				'handler: async () => ({ ok: true, MKioskTy: "K", duty_name: "open" }),',
			)
			.replace(
				'fixtures: { request: { q: "btc" }, response: { ok: true } },',
				'fixtures: { request: { q: "btc" }, response: { ok: true, MKioskTy: "K", duty_name: "open" } },',
			);
		const dir = makeProviderDir("submit-vendor-key-leak-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-key-leak");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
		expect(check?.evidence?.[0]).toMatch(/index\.ts:\d+/);
	});

	it("warns when vendor key leaks are allow-listed", async () => {
		const source = validProviderSource()
			.replace(
				`ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
				`// @apifuse-allow vendor-key-leak: canonical public agency code.
    MKioskTy: z.string(),
    ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
			)
			.replace(
				"handler: async () => ({ ok: true }),",
				'handler: async () => ({ ok: true, MKioskTy: "K" }),',
			)
			.replace(
				'fixtures: { request: { q: "btc" }, response: { ok: true } },',
				'fixtures: { request: { q: "btc" }, response: { ok: true, MKioskTy: "K" } },',
			);
		const dir = makeProviderDir("submit-vendor-key-allow-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-key-leak");

		expect(check?.status).toBe("warn");
		expect(check?.level).toBe("warn");
	});

	it("does not flag vendor keys in upstream parsing schemas", async () => {
		const source = `${validProviderSource()}
const upstreamRow = z.object({ MKioskTy: z.string() });
`;
		const dir = makeProviderDir("submit-upstream-key-pass-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-key-leak");

		expect(check?.status).toBe("pass");
	});

	it("allows semantic snake_case keys in public output schemas", async () => {
		const source = validProviderSource()
			.replace(
				`ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
				`pharmacy_id: z.string(),
    weekly_hours: z.array(z.string()),
    trauma_centers: z.array(z.string()),
    total_count: z.number(),
    filtered_count: z.number(),
    scan_count: z.number(),
    scan_exhausted: z.boolean(),
    ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
			)
			.replace(
				"handler: async () => ({ ok: true }),",
				'handler: async () => ({ ok: true, pharmacy_id: "P-1", weekly_hours: ["24h"], trauma_centers: ["regional"], total_count: 1, filtered_count: 1, scan_count: 1, scan_exhausted: false }),',
			)
			.replace(
				'fixtures: { request: { q: "btc" }, response: { ok: true } },',
				'fixtures: { request: { q: "btc" }, response: { ok: true, pharmacy_id: "P-1", weekly_hours: ["24h"], trauma_centers: ["regional"], total_count: 1, filtered_count: 1, scan_count: 1, scan_exhausted: false } },',
			);
		const dir = makeProviderDir("submit-semantic-snake-case-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-key-leak");

		expect(check?.status).toBe("pass");
	});

	it("does not flag two-member digit suffix families in public output schemas", async () => {
		const source = validProviderSource()
			.replace(
				`ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
				`addressLine1: z.string(),
    addressLine2: z.string(),
    ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
			)
			.replace(
				"handler: async () => ({ ok: true }),",
				'handler: async () => ({ ok: true, addressLine1: "a", addressLine2: "b" }),',
			)
			.replace(
				'fixtures: { request: { q: "btc" }, response: { ok: true } },',
				'fixtures: { request: { q: "btc" }, response: { ok: true, addressLine1: "a", addressLine2: "b" } },',
			);
		const dir = makeProviderDir("submit-two-digit-key-family-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-key-leak");

		expect(check?.status).toBe("pass");
	});

	it("blocks digit-suffixed vendor key families in public output schemas", async () => {
		const source = validProviderSource()
			.replace(
				`ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
				`hvec1: z.string(),
    hvec2: z.string(),
    hvec3: z.string(),
    ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
			)
			.replace(
				"handler: async () => ({ ok: true }),",
				'handler: async () => ({ ok: true, hvec1: "a", hvec2: "b", hvec3: "c" }),',
			)
			.replace(
				'fixtures: { request: { q: "btc" }, response: { ok: true } },',
				'fixtures: { request: { q: "btc" }, response: { ok: true, hvec1: "a", hvec2: "b", hvec3: "c" } },',
			);
		const dir = makeProviderDir("submit-digit-key-family-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-key-leak");

		expect(check?.status).toBe("fail");
		expect(check?.evidence?.[0]).toMatch(/index\.ts:\d+/);
	});

	it("blocks snake_case-suffixed vendor key families in public output schemas", async () => {
		const source = validProviderSource()
			.replace(
				`ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
				`sensor_1: z.string(),
    sensor_2: z.string(),
    sensor_3: z.string(),
    ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
			)
			.replace(
				"handler: async () => ({ ok: true }),",
				'handler: async () => ({ ok: true, sensor_1: "a", sensor_2: "b", sensor_3: "c" }),',
			)
			.replace(
				'fixtures: { request: { q: "btc" }, response: { ok: true } },',
				'fixtures: { request: { q: "btc" }, response: { ok: true, sensor_1: "a", sensor_2: "b", sensor_3: "c" } },',
			);
		const dir = makeProviderDir("submit-snake-digit-key-family-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-key-leak");

		expect(check?.status).toBe("fail");
		expect(check?.evidence?.[0]).toMatch(/index\.ts:\d+/);
	});

	it("does not flag two-member snake_case digit families in public output schemas", async () => {
		const source = validProviderSource()
			.replace(
				`ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
				`address_line_1: z.string(),
    address_line_2: z.string(),
    ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
			)
			.replace(
				"handler: async () => ({ ok: true }),",
				'handler: async () => ({ ok: true, address_line_1: "a", address_line_2: "b" }),',
			)
			.replace(
				'fixtures: { request: { q: "btc" }, response: { ok: true } },',
				'fixtures: { request: { q: "btc" }, response: { ok: true, address_line_1: "a", address_line_2: "b" } },',
			);
		const dir = makeProviderDir("submit-two-snake-digit-key-family-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-key-leak");

		expect(check?.status).toBe("pass");
	});

	it("blocks computed string vendor keys in public output schemas", async () => {
		const source = validProviderSource()
			.replace(
				`ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
				`["MKioskTy"]: z.string(),
    ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
			)
			.replace(
				"handler: async () => ({ ok: true }),",
				'handler: async () => ({ ok: true, MKioskTy: "K" }),',
			)
			.replace(
				'fixtures: { request: { q: "btc" }, response: { ok: true } },',
				'fixtures: { request: { q: "btc" }, response: { ok: true, MKioskTy: "K" } },',
			);
		const dir = makeProviderDir("submit-computed-vendor-key-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-key-leak");

		expect(check?.status).toBe("fail");
	});

	it("does not let unrelated upstream-named consts exempt public schemas", async () => {
		const source = validProviderSource()
			.replace(
				'import { defineProvider, describeKey, z } from "@apifuse/provider-sdk";',
				`import { defineProvider, describeKey, z } from "@apifuse/provider-sdk";

const upstreamNote = true;`,
			)
			.replace("output,", "output: z.object({ MKioskTy: z.string() }),")
			.replace("handler: async () => ({ ok: true }),", 'handler: async () => ({ MKioskTy: "K" }),')
			.replace(
				'fixtures: { request: { q: "btc" }, response: { ok: true } },',
				'fixtures: { request: { q: "btc" }, response: { MKioskTy: "K" } },',
			);
		const dir = makeProviderDir("submit-upstream-note-bypass-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-key-leak");

		expect(check?.status).toBe("fail");
	});

	it("still exempts upstream-marked z.object value ranges", async () => {
		const source = `${validProviderSource()}
const upstreamOutput = z.object({ MKioskTy: z.string() });
`;
		const dir = makeProviderDir("submit-upstream-range-pass-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-key-leak");

		expect(check?.status).toBe("pass");
	});

	it("does not confuse braces in comments with object structure", async () => {
		const source = validProviderSource()
			.replace(
				`ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
				`// } comment with brace
    good: z.string(),
    ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
			)
			.replace(
				"handler: async () => ({ ok: true }),",
				'handler: async () => ({ ok: true, good: "yes" }),',
			)
			.replace(
				'fixtures: { request: { q: "btc" }, response: { ok: true } },',
				'fixtures: { request: { q: "btc" }, response: { ok: true, good: "yes" } },',
			);
		const dir = makeProviderDir("submit-comment-brace-schema-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-key-leak");

		expect(check?.status).toBe("pass");
	});

	it("detects vendor keys after a URL regex literal", async () => {
		const source = validProviderSource()
			.replace(
				"const output =",
				`${String.raw`const urlPattern = /https?:\/\//;`}\n\nconst output =`,
			)
			.replace(
				`ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
				`MKioskTy: z.string(),
    ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
			)
			.replace(
				"handler: async () => ({ ok: true }),",
				'handler: async () => ({ ok: true, MKioskTy: "K" }),',
			)
			.replace(
				'fixtures: { request: { q: "btc" }, response: { ok: true } },',
				'fixtures: { request: { q: "btc" }, response: { ok: true, MKioskTy: "K" } },',
			);
		const dir = makeProviderDir("submit-url-regex-vendor-key-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);

		expect(report.checks.find((item) => item.id === "vendor-key-leak")?.status).toBe(
			"fail",
		);
	});

	it("detects vendor keys after a quote-matching regex literal", async () => {
		const source = validProviderSource()
			.replace("const output =", `const quotePattern = /["']/;\n\nconst output =`)
			.replace(
				`ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
				`MKioskTy: z.string(),
    ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description"),`,
			)
			.replace(
				"handler: async () => ({ ok: true }),",
				'handler: async () => ({ ok: true, MKioskTy: "K" }),',
			)
			.replace(
				'fixtures: { request: { q: "btc" }, response: { ok: true } },',
				'fixtures: { request: { q: "btc" }, response: { ok: true, MKioskTy: "K" } },',
			);
		const dir = makeProviderDir("submit-quote-regex-vendor-key-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);

		expect(report.checks.find((item) => item.id === "vendor-key-leak")?.status).toBe(
			"fail",
		);
	});

	it("ignores vendor-key documentation text after a quote-matching regex", async () => {
		const source = `${validProviderSource()}
const quotePattern = /["']/;
const example = " output: z.object({ MKioskTy: z.string() })";
`;
		const dir = makeProviderDir("submit-quote-regex-documentation-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);

		expect(report.checks.find((item) => item.id === "vendor-key-leak")?.status).toBe(
			"pass",
		);
	});

	it("masks schema-looking text in a ternary consequent string", () => {
		const source =
			'const example = ok ? "output: z.object({ MKioskTy: z.string() })" : "";';
		const masked = maskCommentsAndStrings(source);

		expect(masked).not.toContain("MKioskTy");
	});

	it("ignores vendor-key documentation text in a ternary consequent string", async () => {
		const source = `${validProviderSource()}
const outputExample = true ? "output: z.object({ MKioskTy: z.string() })" : "";
`;
		const dir = makeProviderDir("submit-ternary-documentation-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);

		expect(report.checks.find((item) => item.id === "vendor-key-leak")?.status).toBe(
			"pass",
		);
	});

	it("preserves template interpolation code while masking its literal text", () => {
		const source =
			'const rendered = `ignore "} ${({ "}": codeIdentifier })} output: z.object({ MKioskTy: z.string() })`;';
		const masked = maskCommentsAndStrings(source);

		expect(masked).toContain('${({ " ": codeIdentifier })}');
		expect(masked).not.toContain("ignore");
		expect(masked).not.toContain("MKioskTy");
	});

	it("masks a regex containing a block-comment marker without hiding later code", () => {
		const source = "const pattern = /[/*]/; const codeIdentifier = 1;";
		const masked = maskCommentsAndStrings(source);

		expect(masked).not.toContain("/*");
		expect(masked).toContain("const codeIdentifier = 1;");
	});

	it("masks a string containing a block-comment terminator without shifting later code", () => {
		const source = 'const example = "*/ hidden"; const codeIdentifier = 1;';
		const masked = maskCommentsAndStrings(source);

		expect(masked).not.toContain("*/ hidden");
		expect(masked).toContain("const codeIdentifier = 1;");
	});

	it("masks escaped quotes inside strings and regex literals", () => {
		const source = String.raw`const text = "a\"b"; const pattern = /a\"b/; const codeIdentifier = 1;`;
		const masked = maskCommentsAndStrings(source);

		expect(masked).not.toContain(String.raw`a\"b`);
		expect(masked).toContain("const codeIdentifier = 1;");
	});

	it("preserves mask offsets for code following literals", () => {
		const source =
			'const text = "hidden"; const pattern = /["\']/; const codeIdentifier = 1;';
		const masked = maskCommentsAndStrings(source);
		const identifierOffset = source.indexOf("codeIdentifier");

		expect(masked.length).toBe(source.length);
		expect(masked.indexOf("codeIdentifier")).toBe(identifierOffset);
		expect(masked.slice(identifierOffset, identifierOffset + "codeIdentifier".length)).toBe(
			"codeIdentifier",
		);
	});

	it("keeps line-continuation strings parseable and mask-idempotent", async () => {
		const source = [
			'const doc = "first\\\ncontinued";',
			"const pattern = /quoted\\/value/;",
			"const rendered = `text ${value} tail`;",
			"// comment with braces",
			"void doc;",
		].join("\n");
		const masked = maskCommentsAndStrings(source);

		expect(masked.length).toBe(source.length);
		const codeOffset = source.indexOf("void doc");
		expect(masked.indexOf("void doc")).toBe(codeOffset);
		expect(maskCommentsAndStrings(masked)).toBe(masked);

		const dir = makeProviderDir("submit-mask-line-continuation-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		writeFileSync(join(dir, "extra.ts"), source);
		await expect(buildSubmitCheckReport(dir)).resolves.toBeDefined();
	});

	it("keeps CRLF line-continuation strings parseable and mask-idempotent", () => {
		const source = 'const doc = "first\\\r\ncontinued"; const codeIdentifier = 1;';
		const masked = maskCommentsAndStrings(source);

		expect(masked.length).toBe(source.length);
		expect(masked.indexOf("codeIdentifier")).toBe(source.indexOf("codeIdentifier"));
		expect(maskCommentsAndStrings(masked)).toBe(masked);
	});

	it("keeps line continuations in preserved quoted keys parseable and mask-idempotent", async () => {
		const source = 'const value = { "long\\\nkey": 1 };';
		const masked = maskCommentsAndStrings(source);

		expect(masked.length).toBe(source.length);

		const providerSource = validProviderSource().replace(
			"\nexport default defineProvider",
			`\n${source}\nvoid value;\n\nexport default defineProvider`,
		);
		const dir = makeProviderDir("submit-mask-key-line-continuation-", providerSource);
		writeValidLocaleCatalogs(dir);

		const report = await buildSubmitCheckReport(dir);
		expect(report.schemaVersion).toBe(1);
		expect(report.checks.find((item) => item.id === "flat-operation-composition")).toBeDefined();
		expect(maskCommentsAndStrings(masked)).toBe(masked);
	});

	it("preserves quoted property keys while masking quoted values", () => {
		const source = 'const value = { "response" : "hidden" };';
		const masked = maskCommentsAndStrings(source);
		const responseOffset = source.indexOf('"response"');

		expect(masked.slice(responseOffset, responseOffset + '"response" :'.length)).toBe(
			'"response" :',
		);
		expect(masked).not.toContain("hidden");
	});

	it("neutralizes structural delimiters inside preserved quoted property keys", () => {
		const source = 'const value = { "{ } ( ) [ ] ` \\" \' / \\\\, ;": hidden };';
		const masked = maskCommentsAndStrings(source);
		const keyStart = source.indexOf('"{');
		const keyEnd = source.indexOf('": hidden', keyStart);
		const keyBody = source.slice(keyStart + 1, keyEnd);
		const maskedKeyBody = masked.slice(keyStart + 1, keyEnd);
		const structural = new Set(["{", "}", "(", ")", "[", "]", "`", '"', "'", "/", "\\", ",", ";"]);

		expect(masked.length).toBe(source.length);
		expect(maskedKeyBody).toBe(
			[...keyBody].map((character) => (structural.has(character) ? " " : character)).join(""),
		);
	});

	it("leaves ordinary quoted property-key text byte-for-byte intact", () => {
		const source = 'const value = { "some-key": hidden };';
		const masked = maskCommentsAndStrings(source);
		const keyStart = source.indexOf('"some-key"');

		expect(masked.slice(keyStart, keyStart + '"some-key"'.length)).toBe('"some-key"');
	});

	it("keeps property-key mask modes isolated in the memo cache", () => {
		const source = 'const value = { "fetch(": "hidden" };';
		const keyPreserving = maskCommentsAndStrings(source);
		const keyBlanked = maskCommentsAndStrings(source, "provider.ts", {
			blankPropertyKeys: true,
		});

		expect(keyPreserving).toContain('"fetch ":');
		expect(keyBlanked).not.toContain("fetch(");
		expect(maskCommentsAndStrings(source)).toBe(keyPreserving);
		expect(
			maskCommentsAndStrings(source, "provider.ts", { blankPropertyKeys: true }),
		).toBe(keyBlanked);
		expect(keyBlanked).not.toBe(keyPreserving);
	});

	it("masks a string used as a case value", () => {
		const source = 'switch (value) { case "20260709": break; }';
		const masked = maskCommentsAndStrings(source);

		expect(masked).not.toContain("20260709");
	});

	it("fails closed when a provider source file has a syntax error", async () => {
		const dir = makeProviderDir("submit-mask-syntax-error-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		writeFileSync(join(dir, "broken.ts"), 'const broken = "unterminated;\n');

		await expect(buildSubmitCheckReport(dir)).rejects.toThrow(
			"Cannot safely scan TypeScript source broken.ts",
		);
	});

	it("scans valid declaration files without crashing", async () => {
		const dir = makeProviderDir("submit-mask-valid-declaration-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		writeFileSync(join(dir, "types.d.ts"), "export type Foo = string;\n");
		writeFileSync(
			join(dir, "vendor-output.ts"),
			'import { z } from "zod";\nconst output = z.object({ MKioskTy: z.string() });\n',
		);

		const report = await buildSubmitCheckReport(dir);
		expect(report).toBeDefined();
		expect(report.checks.find((item) => item.id === "vendor-key-leak")?.status).toBe("fail");
	});

	it("fails closed and names a broken declaration file", async () => {
		const dir = makeProviderDir("submit-mask-broken-declaration-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		writeFileSync(join(dir, "broken.d.ts"), 'export type Broken = "unterminated;\n');

		await expect(buildSubmitCheckReport(dir)).rejects.toThrow(
			"Cannot safely scan TypeScript source broken.d.ts",
		);
	});

	it("names a broken sibling module in the fail-closed parse error", async () => {
		const dir = makeProviderDir("submit-mask-broken-sibling-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		writeFileSync(join(dir, "util-broken.ts"), 'const broken = "unterminated;\n');

		await expect(buildSubmitCheckReport(dir)).rejects.toThrow("util-broken.ts");
	});

	it("escapes control characters in fail-closed parse error file names", async () => {
		const dir = makeProviderDir("submit-mask-control-filename-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const rawFileName = "bad\u001b[31mname.ts";
		writeFileSync(join(dir, rawFileName), 'const broken = "unterminated;\n');

		let thrown: unknown;
		try {
			await buildSubmitCheckReport(dir);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		if (!(thrown instanceof Error)) {
			throw new Error("Expected submit-check to reject a syntactically broken source file.");
		}
		expect(thrown.message).toContain("bad\\x1b[31mname.ts");
		expect(thrown.message).not.toContain("\u001b");
	});

	it("escapes C1 and bidi controls while preserving ordinary Unicode filenames", async () => {
		const c1Dir = makeProviderDir("submit-mask-c1-filename-", validProviderSource());
		writeValidLocaleCatalogs(c1Dir);
		const c1Name = "bad\u009bname.ts";
		writeFileSync(join(c1Dir, c1Name), 'const broken = "unterminated;\n');
		await expect(buildSubmitCheckReport(c1Dir)).rejects.toThrow("bad\\x9bname.ts");

		const bidiDir = makeProviderDir("submit-mask-bidi-filename-", validProviderSource());
		writeValidLocaleCatalogs(bidiDir);
		const bidiName = "bad\u202ename.ts";
		writeFileSync(join(bidiDir, bidiName), 'const broken = "unterminated;\n');
		let bidiThrown: unknown;
		try {
			await buildSubmitCheckReport(bidiDir);
		} catch (error) {
			bidiThrown = error;
		}
		expect(bidiThrown).toBeInstanceOf(Error);
		if (!(bidiThrown instanceof Error)) throw new Error("Expected a parse failure.");
		expect(bidiThrown.message).toContain("bad\\u{202e}name.ts");
		expect(bidiThrown.message).not.toContain("\u202e");

		const almDir = makeProviderDir("submit-mask-alm-filename-", validProviderSource());
		writeValidLocaleCatalogs(almDir);
		const almName = "bad\u061cname.ts";
		writeFileSync(join(almDir, almName), 'const broken = "unterminated;\n');
		let almThrown: unknown;
		try {
			await buildSubmitCheckReport(almDir);
		} catch (error) {
			almThrown = error;
		}
		expect(almThrown).toBeInstanceOf(Error);
		if (!(almThrown instanceof Error)) throw new Error("Expected a parse failure.");
		expect(almThrown.message).toContain("bad\\u{61c}name.ts");
		expect(almThrown.message).not.toContain("\u061c");

		const lsDir = makeProviderDir("submit-mask-ls-filename-", validProviderSource());
		writeValidLocaleCatalogs(lsDir);
		const lsName = "bad\u2028name.ts";
		writeFileSync(join(lsDir, lsName), 'const broken = "unterminated;\n');
		let lsThrown: unknown;
		try {
			await buildSubmitCheckReport(lsDir);
		} catch (error) {
			lsThrown = error;
		}
		expect(lsThrown).toBeInstanceOf(Error);
		if (!(lsThrown instanceof Error)) throw new Error("Expected a parse failure.");
		expect(lsThrown.message).toContain("bad\\u{2028}name.ts");
		expect(lsThrown.message).not.toContain("\u2028");

		const koreanDir = makeProviderDir("submit-mask-korean-filename-", validProviderSource());
		writeValidLocaleCatalogs(koreanDir);
		const koreanName = "깨진.ts";
		writeFileSync(join(koreanDir, koreanName), 'const broken = "unterminated;\n');
		await expect(buildSubmitCheckReport(koreanDir)).rejects.toThrow(koreanName);
	});

	it("blocks compact vendor timestamps in normalized response fixtures", async () => {
		const source = validProviderSource().replace(
			'fixtures: { request: { q: "btc" }, response: { ok: true } },',
			`fixtures: {
        request: { q: "btc" },
        response: { ok: true, startTime: "1030", date: "20260709" },
      },`,
		);
		const dir = makeProviderDir("submit-vendor-timestamp-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-timestamp-leak");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
		expect(check?.evidence?.[0]).toMatch(/index\.ts:\d+/);
	});

	it("ignores compact vendor timestamp examples in fixture comments", async () => {
		const source = validProviderSource().replace(
			'fixtures: { request: { q: "btc" }, response: { ok: true } },',
			'fixtures: { request: { q: "btc" }, response: { /* date: "20260709" */ ok: true } },',
		);
		const dir = makeProviderDir("submit-vendor-timestamp-comment-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-timestamp-leak");

		expect(check?.status).toBe("pass");
		expect(check?.evidence).toBeUndefined();
	});

	it("does not flag HHmm-like status values in normalized response fixtures", async () => {
		const source = validProviderSource().replace(
			'fixtures: { request: { q: "btc" }, response: { ok: true } },',
			'fixtures: { request: { q: "btc" }, response: { ok: true, status: "1030" } },',
		);
		const dir = makeProviderDir("submit-status-hhmm-pass-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-timestamp-leak");

		expect(check?.status).toBe("pass");
	});

	it("blocks HHmm strings on timestamp-like fixture keys", async () => {
		const source = validProviderSource().replace(
			'fixtures: { request: { q: "btc" }, response: { ok: true } },',
			'fixtures: { request: { q: "btc" }, response: { ok: true, openTime: "1030" } },',
		);
		const dir = makeProviderDir("submit-open-time-hhmm-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-timestamp-leak");

		expect(check?.status).toBe("fail");
	});

	it("blocks non-interpolated template timestamp fixtures", async () => {
		const source = validProviderSource().replace(
			'fixtures: { request: { q: "btc" }, response: { ok: true } },',
			'fixtures: { request: { q: "btc" }, response: { ok: true, openTime: `1030` } },',
		);
		const dir = makeProviderDir("submit-template-time-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-timestamp-leak");

		expect(check?.status).toBe("fail");
	});

	it("detects timestamps under JSON-style quoted fixture keys", async () => {
		const source = validProviderSource().replace(
			'fixtures: { request: { q: "btc" }, response: { ok: true } },',
			'fixtures: { "request": { "q": "btc" }, "response": { "ok": true, "updated_at": "20260707222855" } },',
		);
		const dir = makeProviderDir("submit-quoted-key-fixtures-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-timestamp-leak");

		expect(check?.status).toBe("fail");
	});

	it("only checks compact timestamps inside fixtures objects", async () => {
		const source = `${validProviderSource()}
const response = { updatedAt: "20260707222855" };
`;
		const dir = makeProviderDir("submit-response-outside-fixtures-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-timestamp-leak");

		expect(check?.status).toBe("pass");
	});

	it("checks compact timestamps in response objects inside fixtures", async () => {
		const source = validProviderSource().replace(
			'fixtures: { request: { q: "btc" }, response: { ok: true } },',
			`fixtures: {
        request: { q: "btc", extra: "${"x".repeat(2200)}" },
        response: { ok: true, updatedAt: "20260707222855" },
      },`,
		);
		const dir = makeProviderDir("submit-response-inside-fixtures-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-timestamp-leak");

		expect(check?.status).toBe("fail");
	});

	it("passes ISO timestamps in normalized response fixtures", async () => {
		const source = validProviderSource().replace(
			'fixtures: { request: { q: "btc" }, response: { ok: true } },',
			`fixtures: {
        request: { q: "btc" },
        response: { ok: true, startTime: "2026-07-09T10:30:00+09:00" },
      },`,
		);
		const dir = makeProviderDir("submit-iso-timestamp-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-timestamp-leak");

		expect(check?.status).toBe("pass");
	});

	it("warns when compact vendor timestamps are allow-listed", async () => {
		const source = validProviderSource().replace(
			'fixtures: { request: { q: "btc" }, response: { ok: true } },',
			`fixtures: {
        request: { q: "btc" },
        // @apifuse-allow vendor-timestamp-leak: source value is a route code.
        response: { ok: true, startTime: "1030" },
      },`,
		);
		const dir = makeProviderDir("submit-timestamp-allow-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "vendor-timestamp-leak");

		expect(check?.status).toBe("warn");
		expect(check?.level).toBe("warn");
	});

	it("does not add new blockers for the fresh local-only scaffold shape", async () => {
		const dir = makeProviderDir(
			"submit-fresh-scaffold-",
			validProviderSource(
				'healthCheckUnsupported: { reason: "generated local-only scaffold until real operations exist" },',
			),
		);
		writeValidLocaleCatalogs(dir);
		writeFileSync(join(dir, "__fixtures__", "raw.json"), "{}\n");
		const report = await buildSubmitCheckReport(dir);

		expect(report.checks.find((item) => item.id === "fixture-provenance")?.status).toBe("warn");
		expect(report.checks.find((item) => item.id === "vendor-key-leak")?.status).toBe("pass");
		expect(report.checks.find((item) => item.id === "vendor-timestamp-leak")?.status).toBe("pass");
	});

	it("blocks no-op health assertion bodies", async () => {
		const dir = makeProviderDir(
			"submit-vacuous-health-empty-",
			validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [{ name: "lookup ok", input: { q: "btc" }, assertions: () => {} }],
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "health-coverage");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.points).toBe(0);
		expect(check?.remediation).toContain("healthCheck.assertions for lookup is empty");
		expect(report.score.verdict).toBe("blocked");
		expect(report.score.total).toBeLessThan(90);
	});

	for (const [label, assertionsSource] of [
		["undefined concise return", "() => undefined"],
		["comment-only block", "(ctx) => { /* TODO */ }"],
		["destructured params empty block", "({ data, status }) => {}"],
		["destructured params comment-only", "({ data }) => { /* TODO */ }"],
		["non-arrow function empty block", "function ({ data }) {}"],
		["block return empty object", "() => { return {}; }"],
		["block return void 0", "() => { return void 0; }"],
		["block return parenthesized object", "() => { return ({}); }"],
		["concise void 0", "() => void 0"],
		["concise parenthesized object", "() => ({})"],
		["concise Promise.resolve()", "() => Promise.resolve()"],
		["concise Promise.resolve({})", "() => Promise.resolve({})"],
		["block return Promise.resolve()", "() => { return Promise.resolve(); }"],
		["async empty block", "async () => {}"],
		["async return Promise.resolve()", "async () => { return Promise.resolve(); }"],
		["async awaited Promise.resolve()", "async () => await Promise.resolve()"],
		["async awaited block", "async () => { await Promise.resolve(); }"],
		["async awaited undefined", "async () => { await undefined; }"],
		["Promise.resolve().then no-op", "() => Promise.resolve().then(() => {})"],
		["new Promise resolve no-op", "() => new Promise((resolve) => resolve())"],
		["side-effect only, no param ref", "() => { globalThis.__x = 1; }"],
		["throw only inside a string literal", '() => { console.info("throw later"); }'],
		["bound param referenced only in string", '({ data }) => { console.info("data missing"); }'],
		["statement-position regex after if()", "(ctx) => { if (true) /ctx/.test('x'); }"],
		["statement-position regex after while()", "(ctx) => { while (false) /ctx/.test('x'); }"],
		["throw only as an object property key", "() => ({ throw: undefined })"],
		["throw property key among others", "() => ({ throw: 1, status: 2 })"],
		[
			"throw only inside an uninvoked nested function",
			"() => { const later = () => { throw new Error('x'); }; }",
		],
		[
			"destructured alias whose binding is unused",
			"({ status: ignored }) => { const status = 200; }",
		],
		[
			"destructured alias, body refs the property key",
			"({ status: ignored }) => { return status; }",
		],
		["nested arrow references only its own param", "function (ctx) { [1].forEach((x) => x + 1); }"],
		[
			"param read only inside an uninvoked arrow closure",
			"(ctx) => { const later = () => ctx.status; }",
		],
		[
			"param read only inside an uninvoked function declaration",
			"(ctx) => { function later() { return ctx.status; } }",
		],
	] as const) {
		it(`blocks vacuous health assertions with ${label}`, async () => {
			const dir = makeProviderDir(
				"submit-vacuous-health-",
				validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [{ name: "lookup ok", input: { q: "btc" }, assertions: ${assertionsSource} }],
      },`),
			);
			writeValidLocaleCatalogs(dir);
			const report = await buildSubmitCheckReport(dir);
			const check = report.checks.find((item) => item.id === "health-coverage");

			expect(check?.level).toBe("blocker");
			expect(check?.status).toBe("fail");
			expect(check?.evidence?.join("\n")).toContain("lookup: empty healthCheck.assertions");
		});
	}

	it("passes real health assertion bodies", async () => {
		const dir = makeProviderDir(
			"submit-real-health-assertions-",
			validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [{
          name: "lookup ok",
          input: { q: "btc" },
          assertions: (ctx) => {
            if (!ctx.output.ok) {
              throw new Error("lookup must return ok");
            }
            if (ctx.durationMs > 1_000) {
              return { status: "degraded", label: "slow lookup" };
            }
          },
        }],
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "health-coverage");

		expect(check?.status).toBe("pass");
		expect(check?.points).toBe(15);
	});

	it("passes real destructured-parameter health assertion bodies", async () => {
		const dir = makeProviderDir(
			"submit-real-destructured-health-",
			validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [{
          name: "lookup ok",
          input: { q: "btc" },
          assertions: ({ status, data }) => {
            if (status !== 200) {
              return { status: "degraded", label: "lookup changed" };
            }
            if (!Array.isArray(data.items)) {
              throw new Error("items must be an array");
            }
          },
        }],
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "health-coverage");

		expect(check?.status).toBe("pass");
		expect(check?.points).toBe(15);
	});

	it("passes real async / Promise-returning health assertion bodies", async () => {
		const dir = makeProviderDir(
			"submit-real-async-health-",
			validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [{
          name: "lookup ok",
          input: { q: "btc" },
          assertions: (ctx) =>
            Promise.resolve(
              ctx.output.ok ? undefined : { status: "degraded", label: "lookup down" },
            ),
        }],
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "health-coverage");

		expect(check?.status).toBe("pass");
		expect(check?.points).toBe(15);
	});

	it("passes assertions that inspect a URL-shaped field via a regex literal", async () => {
		// Regression: the `//` inside /^https?:\/\// must not be treated as a
		// line comment and erase the data.url parameter reference.
		const dir = makeProviderDir(
			"submit-regex-url-health-",
			validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [{
          name: "lookup ok",
          input: { q: "btc" },
          assertions: ({ data }) => {
            const ok = /^https?:\\/\\//.test(data.url);
            return ok ? undefined : { status: "degraded", label: "bad url" };
          },
        }],
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "health-coverage");

		expect(check?.status).toBe("pass");
		expect(check?.points).toBe(15);
	});

	it("passes real assertions that use a nested arrow callback", async () => {
		// Regression: a nested arrow (item => item.ok) must not be mistaken for
		// the assertion's own signature. The outer function still inspects its
		// own `ctx` parameter, so this is a real assertion.
		const dir = makeProviderDir(
			"submit-nested-arrow-health-",
			validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [{
          name: "lookup ok",
          input: { q: "btc" },
          assertions: (ctx) => {
            const allOk = ctx.output.items.every((item) => item.ok);
            return allOk ? undefined : { status: "degraded", label: "bad item" };
          },
        }],
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "health-coverage");

		expect(check?.status).toBe("pass");
		expect(check?.points).toBe(15);
	});

	it("passes real assertions that use an immediately-invoked callback", async () => {
		// Regression: a callback invoked immediately (Array#every) executes when
		// the assertion runs, so a param read inside it is a real response
		// inspection — unlike a deferred/uninvoked closure.
		const dir = makeProviderDir(
			"submit-immediate-callback-health-",
			validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [{
          name: "lookup ok",
          input: { q: "btc" },
          assertions: (ctx) =>
            ctx.output.items.every((item) => item.ok)
              ? undefined
              : { status: "degraded", label: "bad item" },
        }],
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "health-coverage");

		expect(check?.status).toBe("pass");
		expect(check?.points).toBe(15);
	});

	it("passes real assertions that invoke a local helper function", async () => {
		// Regression (Codex): a helper factored into a local binding and then
		// called — `const check = () => { ... }; check();` — must not be treated
		// as a deferred/uninvoked closure. The call site means the helper runs, so
		// its ctx read / throw is a real assertion.
		const dir = makeProviderDir(
			"submit-invoked-helper-health-",
			validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [{
          name: "lookup ok",
          input: { q: "btc" },
          assertions: (ctx) => {
            const check = () => {
              if (!ctx.output.ok) {
                throw new Error("lookup down");
              }
            };
            check();
          },
        }],
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "health-coverage");

		expect(check?.status).toBe("pass");
		expect(check?.points).toBe(15);
	});

	it("passes real assertions that alias a destructured parameter", async () => {
		// Regression: destructuring binds the local alias (`renamed`), not the
		// source property key (`status`). Referencing the alias is a real
		// response inspection.
		const dir = makeProviderDir(
			"submit-alias-health-",
			validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [{
          name: "lookup ok",
          input: { q: "btc" },
          assertions: ({ status: renamed }) => {
            if (renamed !== 200) {
              throw new Error("lookup failed");
            }
          },
        }],
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "health-coverage");

		expect(check?.status).toBe("pass");
		expect(check?.points).toBe(15);
	});

	it("fails open for native / bound assertion functions", async () => {
		// Regression: fn.bind(...) stringifies to `function () { [native code] }`
		// with no inspectable params; must not be flagged as an empty assertion.
		const dir = makeProviderDir(
			"submit-bound-health-",
			validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [{
          name: "lookup ok",
          input: { q: "btc" },
          assertions: (function checkHealth({ status }) {
            if (status !== 200) {
              throw new Error("lookup failed");
            }
          }).bind(undefined),
        }],
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "health-coverage");

		expect(check?.status).toBe("pass");
		expect(check?.points).toBe(15);
	});

	it("passes assertions whose parameter name contains $", async () => {
		// Regression: `\b` word boundaries fail for `$ctx` because `$` is not a
		// word char, so the param-reference check must use identifier-aware
		// lookarounds.
		const dir = makeProviderDir(
			"submit-dollar-param-health-",
			validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [{
          name: "lookup ok",
          input: { q: "btc" },
          assertions: ($ctx) =>
            $ctx.status === 200 ? undefined : { status: "degraded", label: "lookup down" },
        }],
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "health-coverage");

		expect(check?.status).toBe("pass");
		expect(check?.points).toBe(15);
	});

	it("passes assertions that reference the param only inside a regex or template expression", async () => {
		// Regression (token-aware lexer): a `return /re/.test(param)` (the shape a
		// transpiler may inline) and a `${param}` interpolation must both count as
		// real parameter references. A `param.a / param.b` division must not be
		// mistaken for a regex literal that swallows the reference.
		const dir = makeProviderDir(
			"submit-lexer-edge-health-",
			validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [
          {
            name: "url shape",
            input: { q: "btc" },
            assertions: ({ data }) => {
              return /^https?:\\/\\//.test(data.url) ? undefined : { status: "degraded" };
            },
          },
          {
            name: "ratio",
            input: { q: "eth" },
            assertions: ({ data }) => {
              return data.a / data.b > 1 ? undefined : { status: "degraded" };
            },
          },
          {
            name: "template",
            input: { q: "sol" },
            assertions: (ctx) =>
              \`\${ctx.status}\` === "200" ? undefined : { status: "degraded" },
          },
        ],
      },`),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "health-coverage");

		expect(check?.status).toBe("pass");
		expect(check?.points).toBe(15);
	});

	it("blocks only operations whose health cases are all vacuous", async () => {
		const source = validProviderSource().replace(
			"    },\n  },\n});",
			`    },
    empty: {
      descriptionKey: "operations.lookup.description",
      input,
      output,
      annotations: { readOnly: true, idempotent: true, openWorld: true },
      handler: async () => ({ ok: true }),
      fixtures: { request: { q: "eth" }, response: { ok: true } },
      healthCheck: {
        interval: "1m",
        cases: [{ name: "empty ok", input: { q: "eth" }, assertions: () => {} }],
      },
    },
  },
});`,
		);
		const dir = makeProviderDir("submit-mixed-vacuous-health-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "health-coverage");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.evidence).toEqual(["empty: empty healthCheck.assertions"]);
		expect(check?.remediation).toContain("healthCheck.assertions for empty is empty");
		expect(check?.remediation).not.toContain("lookup is empty");
	});

	it("warns but does not block generated OAuth providers without credential keys", async () => {
		const oauthSource = validProviderSource().replace(
			'auth: { mode: "none" },',
			`auth: {
    mode: "oauth2",
    flow: {
      start: async () => ({
        kind: "redirect",
        turnId: crypto.randomUUID(),
        data: { authorizeUrl: "https://example.com/oauth/authorize" },
      }),
      continue: async () => ({
        kind: "complete",
        turnId: crypto.randomUUID(),
        data: { credential: {} },
      }),
    },
  },`,
		);
		const dir = makeProviderDir("submit-oauth-starter-", oauthSource);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);

		expect(report.summary.blockers).toBe(0);
		expect(report.score.verdict).toBe("reviewable_with_warnings");
		expect(report.checks.find((check) => check.id === "auth-safety")?.status).toBe("warn");
	});

	it("surfaces reusable-secret gate failures for auth refresh", async () => {
		const refreshSource = validProviderSource().replace(
			'auth: { mode: "none" },',
			`auth: {
    mode: "credentials",
    flow: {
      start: async () => ({ kind: "input", turnId: crypto.randomUUID() }),
      continue: async () => ({ kind: "complete", turnId: crypto.randomUUID(), data: { credential: { username: "u", password: "p" } } }),
      refresh: async () => ({ kind: "complete", turnId: crypto.randomUUID(), data: { credential: { username: "u", password: "p" } } }),
    },
  },
  credential: { keys: ["username", "password"] },`,
		);
		const dir = makeProviderDir("submit-refresh-secret-gate-", refreshSource);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const baseChecks = report.checks.find((check) => check.id === "base-checks");

		expect(report.score.verdict).toBe("blocked");
		expect(baseChecks?.evidence?.join("\\n")).toContain("auth-refresh-reusable-secret");
	});

	it("includes actionable remediation on every failing or warning submit check", async () => {
		const brokenSource = validProviderSource(
			'healthCheckUnsupported: { reason: "TODO later after real API access" },',
		)
			.replace(
				"handler: async () => ({ ok: true }),",
				`handler: async () => {
        await fetch("https://api.example.com/raw");
        return { ok: true };
      },`,
			)
			.replace(
				'fixtures: { request: { q: "btc" }, response: { ok: true } },',
				"fixtures: { request: { q: 123 }, response: { ok: true } },",
			)
			.replace("annotations: { readOnly: true, idempotent: true, openWorld: true },", "");
		const dir = makeProviderDir(
			"submit-remediation-coverage-",
			brokenSource,
			"missing submission guidance",
			false,
		);
		const report = await buildSubmitCheckReport(dir);
		const actionable = report.checks.filter(
			(check) => check.status === "fail" || check.status === "warn",
		);

		expect(actionable.length).toBeGreaterThan(0);
		expect(
			actionable.map((check) => ({
				id: check.id,
				remediation: check.remediation?.trim(),
			})),
		).toEqual(
			actionable.map((check) => ({
				id: check.id,
				remediation: expect.stringMatching(/\S/),
			})),
		);

		const vacuousHealthDir = makeProviderDir(
			"submit-remediation-vacuous-health-",
			validProviderSource(`healthCheck: {
        interval: "1m",
        cases: [{ name: "lookup ok", input: { q: "btc" }, assertions: () => {} }],
      },`),
		);
		writeValidLocaleCatalogs(vacuousHealthDir);
		const vacuousHealthReport = await buildSubmitCheckReport(vacuousHealthDir);
		expect(
			vacuousHealthReport.checks.find((check) => check.id === "health-coverage")?.remediation,
		).toContain("healthCheck.assertions for lookup is empty");
	});

	it("warns on placeholder unsupported health rationale without blocking", async () => {
		const dir = makeProviderDir(
			"submit-placeholder-health-",
			validProviderSource(
				'healthCheckUnsupported: { reason: "TODO later after real API access" },',
			),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);

		expect(report.score.verdict).toBe("reviewable_with_warnings");
		expect(report.summary.blockers).toBe(0);
		expect(report.checks.find((check) => check.id === "health-coverage")?.status).toBe("warn");
	});

	it("redacts repeated secret-like values from submitted evidence", async () => {
		const firstToken = "Bearer abcdefghijklmnopqrstuvwxyz1234567890TOKENA";
		const secondToken = "Bearer abcdefghijklmnopqrstuvwxyz1234567890TOKENB";
		const dir = makeProviderDir("submit-repeated-secret-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir, {
			smokeNote: `${firstToken} then ${secondToken}`,
		});
		const markdown = renderMarkdown(report);

		expect(markdown).not.toContain(firstToken);
		expect(markdown).not.toContain(secondToken);
		expect(markdown).toContain("Deprecated --smoke-note was provided and ignored for scoring.");
	});

	it("blocks and redacts high-confidence secret evidence", async () => {
		const dir = makeProviderDir(
			"submit-secret-",
			`${validProviderSource()}\n// accidental token: ghp_abcdefghijklmnopqrstuvwxyzABCDE12345\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const markdown = renderMarkdown(report);

		expect(report.score.verdict).toBe("blocked");
		expect(report.summary.blockers).toBeGreaterThan(0);
		expect(markdown).not.toContain("ghp_abcdefghijklmnopqrstuvwxyzABCDE12345");
	});

	it("blocks high-entropy strings assigned to secret-like identifiers", async () => {
		const key = "qJ8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS8dF2gH7jK4lM9nP6qR1tV5wY8z";
		const dir = makeProviderDir(
			"submit-entropy-secret-",
			`${validProviderSource()}\nconst FALLBACK_SERVICE_KEY = "${key}";\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.points).toBe(0);
		expect(check?.remediation).toContain("ctx.env.get");
		expect(check?.remediation).toContain("rotate");
		expect(check?.evidence?.join("\n")).toContain("index.ts:");
		expect(check?.evidence?.join("\n")).toContain("qJ8n...[REDACTED length=58]");
		expect(check?.evidence?.join("\n")).not.toContain(key);
	});

	it("excludes nested node_modules directories from secret scanning", async () => {
		const key = "qJ8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS8dF2gH7jK4lM9nP6qR1tV5wY8z";
		const dir = makeProviderDir("submit-nested-node-modules-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const plantedPath = join(dir, "foo", "node_modules", "bar.ts");
		mkdirSync(dirname(plantedPath), { recursive: true });
		writeFileSync(plantedPath, `export const FALLBACK_SERVICE_KEY = "${key}";\n`);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.status).toBe("pass");
	});

	it("excludes task worktrees from secret scanning", async () => {
		const key = "qJ8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS8dF2gH7jK4lM9nP6qR1tV5wY8z";
		const dir = makeProviderDir("submit-task-worktree-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const plantedPath = join(dir, ".worktree", "anything", "upstream", "client.ts");
		mkdirSync(dirname(plantedPath), { recursive: true });
		writeFileSync(plantedPath, `export const FALLBACK_SERVICE_KEY = "${key}";\n`);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.status).toBe("pass");
	});

	it("keeps root node_modules excluded from secret scanning", async () => {
		const key = "qJ8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS8dF2gH7jK4lM9nP6qR1tV5wY8z";
		const dir = makeProviderDir("submit-root-node-modules-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		writeFileSync(
			join(dir, "node_modules", "planted.ts"),
			`export const FALLBACK_SERVICE_KEY = "${key}";\n`,
		);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.status).toBe("pass");
	});

	it("keeps regular nested source directories in secret-scan scope", async () => {
		const key = "qJ8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS8dF2gH7jK4lM9nP6qR1tV5wY8z";
		const dir = makeProviderDir("submit-regular-nested-source-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const plantedPath = join(dir, "upstream", "deep", "creds.ts");
		mkdirSync(dirname(plantedPath), { recursive: true });
		writeFileSync(plantedPath, `export const FALLBACK_SERVICE_KEY = "${key}";\n`);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.evidence?.join("\n")).toContain("upstream/deep/creds.ts:");
		expect(check?.evidence?.join("\n")).not.toContain(key);
	});

	it("keeps secret-scan coverage for source files planted under .agents/", async () => {
		const key = "qJ8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS8dF2gH7jK4lM9nP6qR1tV5wY8z";
		const dir = makeProviderDir("submit-agents-hidden-secret-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		// .agents must not be a scan-exempt sanctuary: a planted .ts there is
		// runtime-reachable via a plain relative import from index.ts.
		writeFileSync(
			join(dir, ".agents", "planted.ts"),
			`export const FALLBACK_SERVICE_KEY = "${key}";\n`,
		);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.evidence?.join("\n")).toContain(".agents/planted.ts:");
		expect(check?.evidence?.join("\n")).not.toContain(key);
	});

	it("scans short string literals in linear time", () => {
		const shortLiteralLine = '\t\t\tcloses_at: "21:00",';
		const lines = Array.from({ length: 500 }, () => shortLiteralLine);
		const startedAt = Date.now();

		const candidates = lines.flatMap((line) => extractStringLiteralCandidates(line));

		expect(candidates).toHaveLength(0);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});

	it("extracts long string literal candidates without dropping supported quote forms", () => {
		const highEntropy = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		const escaped = String.raw`abc\"defghiJKLMNOP1234567890`;
		const backtick = "mP4sT7yB3cD6fG1hL5zX0aS";
		const first = "A1b2C3d4E5f6G7h8I9j0K";
		const second = "z9Y8x7W6v5U4t3S2r1Q0p";

		expect(highEntropy.length).toBe(64);
		expect(extractStringLiteralCandidates(`const key = "${highEntropy}";`)).toEqual([highEntropy]);
		expect(extractStringLiteralCandidates(`const escaped = "${escaped}";`)).toEqual([escaped]);
		expect(extractStringLiteralCandidates(`const template = \`${backtick}\`;`)).toEqual([backtick]);
		expect(extractStringLiteralCandidates(`const pair = '${first}' + "${second}";`)).toEqual([
			first,
			second,
		]);
		expect(extractStringLiteralCandidates('const short = "1234567890123456789";')).toEqual([]);
	});

	it("ignores high-entropy strings in fixtures", async () => {
		const key = "qJ8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS8dF2gH7jK4lM9nP6qR1tV5wY8z";
		const dir = makeProviderDir("submit-entropy-fixture-", validProviderSource());
		mkdirSync(join(dir, "__fixtures__"), { recursive: true });
		writeFileSync(
			join(dir, "__fixtures__", "fixture.ts"),
			`export const SERVICE_KEY = "${key}";\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.status).toBe("pass");
	});

	it("ignores English text, URLs, and package integrity hashes", async () => {
		const dir = makeProviderDir(
			"submit-entropy-ignored-",
			`${validProviderSource()}
const sentence = "this is a long english sentence with normal words";
const docsUrl = "https://example.com/really/long/path/that/is/not/a/secret";
const integrity = "sha512-qJ8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS8dF2gH7jK4lM9nP6qR1tV5wY8z";
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.status).toBe("pass");
	});

	it("ignores template-literal URL path composition", async () => {
		const dir = makeProviderDir(
			"submit-entropy-template-path-",
			`${validProviderSource()}
	const PHARMACY_API_BASE = "https://example.com";
	const BASE = PHARMACY_API_BASE;
	export const LIST_URL = \`\${PHARMACY_API_BASE}/getParmacyListInfoInqire\`;
	export const DETAIL_URL = \`\${BASE}/getSomethingLongerCamelCase\`;
	`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.status).toBe("pass");
	});

	it("ignores MIME and form-encoding strings with path separators", async () => {
		const dir = makeProviderDir(
			"submit-entropy-mime-path-",
			`${validProviderSource()}
	const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=UTF-8";
	const COMPACT_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded;charset=UTF-8";
	const UPLOAD_CONTENT_TYPE = "multipart/form-data; boundary=APIFuseProviderBoundary";
	`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.status).toBe("pass");
	});

	it("warns on high-entropy source blobs without secret-like context", async () => {
		const blob = "qJ8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS8dF2gH7jK4lM9nP6qR1tV5wY8z";
		const dir = makeProviderDir(
			"submit-entropy-warn-",
			`${validProviderSource()}\nconst fixtureBlob = "${blob}";\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("warn");
		expect(check?.status).toBe("warn");
		expect(check?.points).toBeGreaterThan(0);
		expect(check?.message).toContain("false positives");
		expect(check?.evidence?.join("\n")).toContain("may be a false positive");
		expect(check?.evidence?.join("\n")).not.toContain(blob);
	});

	it("downgrades SCREAMING_SNAKE error-code constants to a non-blocking warning", async () => {
		// Entropy 4.04 bits/char, 36 chars, 100% base64-ish charset, and the
		// value itself contains AUTH/PASSWORD — before the downgrade this was
		// permanently blocker-flagged (verdict BLOCKED, no suppression path).
		// Entropy classification still runs, but because the secret-ish
		// context comes solely from the literal's own text (throw sites and
		// neutrally-named constants), the finding is capped at a warning and
		// the verdict is never BLOCKED.
		const dir = makeProviderDir(
			"submit-entropy-error-code-",
			`${validProviderSource()}
const CAPTCHA_REQUIRED_CODE = "AUTH_PASSWORD_LOGIN_CAPTCHA_REQUIRED";
const SUBMIT_FAILED_CODE = "AUTH_PASSWORD_LOGIN_SUBMIT_FAILED";
const CONTRACT_GATE_CODE = "PROVIDER_CONTRACT_V2_REQUIRED";
export function raiseCaptchaGate(): never {
	throw new Error("AUTH_PASSWORD_LOGIN_CAPTCHA_REQUIRED");
}
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("warn");
		expect(check?.status).toBe("warn");
		expect(check?.evidence?.join("\n")).toContain(
			"identifier-like constant (downgraded to warning)",
		);
		expect(report.summary.blockers).toBe(0);
		expect(report.score.verdict).not.toBe("blocked");
	});

	it("downgrades multiple error-code constants sharing one line to a warning", async () => {
		// Codex round-5 counterexample: with several SCREAMING_SNAKE literals
		// on one line, a sibling literal must not leak AUTH/PASSWORD into this
		// candidate's context — all literal contents are stripped before the
		// secret-context check, so the array line stays non-blocking.
		const dir = makeProviderDir(
			"submit-entropy-error-code-array-",
			`${validProviderSource()}
const ERROR_CODES = ["AUTH_PASSWORD_LOGIN_CAPTCHA_REQUIRED", "AUTH_PASSWORD_LOGIN_SUBMIT_FAILED"];
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("warn");
		expect(check?.status).toBe("warn");
		expect(report.summary.blockers).toBe(0);
	});

	it("still blocks error-code-shaped arrays assigned to secret-like identifiers", async () => {
		const dir = makeProviderDir(
			"submit-entropy-error-code-array-key-",
			`${validProviderSource()}
const apiKeys = ["AUTH_PASSWORD_LOGIN_CAPTCHA_REQUIRED", "AUTH_PASSWORD_LOGIN_SUBMIT_FAILED"];
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
	});

	it("downgrades error-code constants in ternary arms to a warning", async () => {
		// Codex round-8 counterexample: a ternary arm is followed by ":" but is
		// not an object key. The role classifier marks it VALUE (preceded by
		// "?"), so it is stripped from context and the line stays non-blocking.
		const dir = makeProviderDir(
			"submit-entropy-ternary-arm-",
			`${validProviderSource()}
const ok = Date.now() > 0;
const code = ok ? "AUTH_PASSWORD_LOGIN_CAPTCHA_REQUIRED" : "AUTH_PASSWORD_LOGIN_SUBMIT_FAILED";
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("warn");
		expect(check?.status).toBe("warn");
		expect(report.summary.blockers).toBe(0);
	});

	it("still blocks ternary error-code constants assigned to secret-like identifiers", async () => {
		const dir = makeProviderDir(
			"submit-entropy-ternary-secret-ident-",
			`${validProviderSource()}
const ok = Date.now() > 0;
const password = ok ? "AUTH_PASSWORD_LOGIN_CAPTCHA_REQUIRED" : "AUTH_PASSWORD_LOGIN_SUBMIT_FAILED";
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
	});

	it("keeps constant-shaped call-argument siblings as blocking secret context", async () => {
		// Codex round-9 counterexample: in a call, the first argument (a
		// 20+-char SCREAMING_SNAKE header NAME) genuinely describes the second
		// argument. Sibling stripping is scoped to non-call containers, so
		// call-argument siblings keep their context and the high-entropy value
		// stays a blocker.
		const dir = makeProviderDir(
			"submit-entropy-call-arg-sibling-",
			`${validProviderSource()}
const headers = new Headers();
headers.set("X_CUSTOM_LONG_AUTH_TOKEN_HEADER", "QWERTYUIOP_ASDFGHJKL_ZXCVBNMQWE_RTYUIOPASD");
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
	});

	it("downgrades single error-code constants at call-site throw positions", async () => {
		// The self-context rule is container-independent: a lone constant
		// inside a call's parentheses is still stripped as self, so throw
		// sites stay non-blocking.
		const dir = makeProviderDir(
			"submit-entropy-throw-call-",
			`${validProviderSource()}
export function raiseSubmitGate(): never {
	throw new Error("AUTH_PASSWORD_LOGIN_SUBMIT_FAILED");
}
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("warn");
		expect(check?.status).toBe("warn");
		expect(report.summary.blockers).toBe(0);
	});

	it("keeps quoted property names as blocking secret context", async () => {
		// Codex round-6 counterexample: only identifier-constant-shaped
		// literals are stripped from the context check; quoted property keys
		// and header names like "Authorization" are genuine external context,
		// so a high-entropy value behind them must stay a blocker.
		const dir = makeProviderDir(
			"submit-entropy-quoted-header-",
			`${validProviderSource()}
const headers = { "Authorization": "QWERTYUIOP_ASDFGHJKL_ZXCVBNMQWE_RTYUIOPASD" };
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
	});

	it("keeps SCREAMING_SNAKE quoted keys as blocking secret context", async () => {
		// Codex round-7 counterexample: short constant-shaped keys like
		// "API_KEY" are below the entropy-candidate minimum length and survive
		// the strip, so they stay genuine external context.
		const dir = makeProviderDir(
			"submit-entropy-snake-key-",
			`${validProviderSource()}
const headers = { "API_KEY": "QWERTYUIOP_ASDFGHJKL_ZXCVBNMQWE_RTYUIOPASD" };
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
	});

	it("keeps long SCREAMING_SNAKE quoted keys in key position as blocking secret context", async () => {
		// Even a pathological 20+-char constant-shaped key is never stripped
		// when it sits in key position (immediately followed by ":").
		const dir = makeProviderDir(
			"submit-entropy-snake-long-key-",
			`${validProviderSource()}
const headers = { "X_CUSTOM_LONG_AUTH_TOKEN_HEADER": "QWERTYUIOP_ASDFGHJKL_ZXCVBNMQWE_RTYUIOPASD" };
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
	});

	it("still warns on pure-alphabetic keyboard-mash uppercase values", async () => {
		// Codex round-3 counterexample: all-alphabetic segments pass the
		// word-like shape test, but entropy classification is never skipped —
		// 4.66 bits/char in a neutral context still surfaces as a warning.
		const mash = "QWERTYUIOP_ASDFGHJKL_ZXCVBNMQWE_RTYUIOPASD";
		const dir = makeProviderDir(
			"submit-entropy-keyboard-mash-",
			`${validProviderSource()}\nconst license = "${mash}";\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.status).toBe("warn");
		expect(check?.evidence?.join("\n")).not.toContain(mash);
	});

	it("suppresses downgraded error-code warnings via @apifuse-allow secret-scan", async () => {
		const dir = makeProviderDir(
			"submit-entropy-error-code-allow-",
			`${validProviderSource()}
// @apifuse-allow secret-scan: upstream auth error code, not a credential
const CAPTCHA_REQUIRED_CODE = "AUTH_PASSWORD_LOGIN_CAPTCHA_REQUIRED";
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("warn");
		expect(check?.message).toContain("1 acknowledged @apifuse-allow override(s)");
		expect(report.summary.blockers).toBe(0);
	});

	it("still blocks SCREAMING_SNAKE-shaped values assigned to secret-like identifiers", async () => {
		// Codex review counterexample: the exemption must not fire when the
		// secret-ish context comes from code outside the literal itself.
		const dir = makeProviderDir(
			"submit-entropy-upper-secret-ident-",
			`${validProviderSource()}\nconst apiKey = "AUTH_PASSWORD_LOGIN_CAPTCHA_REQUIRED";\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
	});

	it("still blocks uppercase underscore credentials assigned to key-like identifiers", async () => {
		// Codex review's verbatim example: base64-like alphabet, entropy 4.78,
		// on an `apiKey` line — must remain a blocker.
		const key = "ABCD_EFGH_IJKL_MNOP_QRST_UVWX_YZ12_3456";
		const dir = makeProviderDir(
			"submit-entropy-upper-key-",
			`${validProviderSource()}\nconst apiKey = "${key}";\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.evidence?.join("\n")).not.toContain(key);
	});

	it("still flags uppercase high-entropy blobs that are not word-like constants", async () => {
		// Shape boundary: every underscore-separated segment must be letters
		// with at most a 2-digit suffix, and digits must be <= 15% of the
		// value. Codex's uppercase-credential alphabet example fails both
		// (segment "3456"), so it stays scanned even in a non-secretish
		// context.
		const blob = "ABCD_EFGH_IJKL_MNOP_QRST_UVWX_YZ12_3456";
		const dir = makeProviderDir(
			"submit-entropy-upper-blob-",
			`${validProviderSource()}\nconst REQUEST_SIGNING_SEED = "${blob}";\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.status).toBe("warn");
		expect(check?.evidence?.join("\n")).not.toContain(blob);
	});

	it("still warns on digit-heavy segmented uppercase values in neutral context", async () => {
		// Codex round-2 counterexample: license/credential-shaped material with
		// digit-heavy segments must fall through to entropy classification.
		// Each segment carries a 4-digit suffix (> 2) and digits are 46% of the
		// value (> 15%), so the word-like predicate rejects it; entropy 4.65
		// exceeds the no-context threshold (4.5) and surfaces as a warn.
		const license = "ABCD1234_EFGH5678_IJKL9012_MNOP3456";
		const dir = makeProviderDir(
			"submit-entropy-license-neutral-",
			`${validProviderSource()}\nconst license = "${license}";\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.status).toBe("warn");
		expect(check?.evidence?.join("\n")).not.toContain(license);
	});

	it("still blocks digit-heavy segmented uppercase values in secret context", async () => {
		const license = "ABCD1234_EFGH5678_IJKL9012_MNOP3456";
		const dir = makeProviderDir(
			"submit-entropy-license-secret-",
			`${validProviderSource()}\nconst licenseKey = "${license}";\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
	});

	it("still blocks mixed-case base64-like values assigned to key-like identifiers", async () => {
		const key = "qJ8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS8dF2gH7j";
		const dir = makeProviderDir(
			"submit-entropy-mixed-case-key-",
			`${validProviderSource()}\nconst apiKey = "${key}";\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.evidence?.join("\n")).not.toContain(key);
	});

	it("still blocks uppercase hex-like values without the identifier underscore shape", async () => {
		// Deliberate exemption boundary: uppercase-only is not enough — the
		// SCREAMING_SNAKE exemption also requires at least one underscore, so
		// hex-like uppercase material stays fully scanned.
		const hex = "A1B2C3D4E5F60718293A4B5C6D7E8F90";
		const dir = makeProviderDir(
			"submit-entropy-upper-hex-",
			`${validProviderSource()}\nconst signingKey = "${hex}";\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.evidence?.join("\n")).not.toContain(hex);
	});

	it("downgrades acknowledged @apifuse-allow secret-scan findings to a warn", async () => {
		const key = "qJ8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS8dF2gH7j";
		const dir = makeProviderDir(
			"submit-entropy-allow-override-",
			`${validProviderSource()}
// @apifuse-allow secret-scan: public demo blob documented in README
const apiKey = "${key}";
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("warn");
		expect(check?.status).toBe("warn");
		expect(check?.message).toContain("1 acknowledged @apifuse-allow override(s)");
		expect(check?.evidence?.join("\n")).toContain("index.ts:");
		expect(check?.evidence?.join("\n")).not.toContain(key);
		expect(report.summary.blockers).toBe(0);
	});

	it("suppresses acknowledged SECRET_PATTERNS hits in README via @apifuse-allow secret-scan", async () => {
		// Pattern findings (demo Bearer tokens, JWTs, quoted credential
		// fields) must honor the pragma uniformly with entropy findings: the
		// match is located to its line so hasAllowOverride can see the
		// adjacent acknowledgement.
		const demoToken = "Bearer abcdefghijklmnopqrstuvwxyz1234567890TOKENA";
		const dir = makeProviderDir(
			"submit-pattern-allow-readme-",
			validProviderSource(),
			`${defaultReadme()}
<!-- @apifuse-allow secret-scan: public documentation example, not a live credential -->
Authorization: ${demoToken}
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("warn");
		expect(check?.status).toBe("warn");
		expect(check?.message).toContain("1 acknowledged @apifuse-allow override(s)");
		expect(check?.evidence?.join("\n")).toContain("README.md:");
		expect(report.summary.blockers).toBe(0);
	});

	it("still blocks unacknowledged SECRET_PATTERNS hits in README", async () => {
		const demoToken = "Bearer abcdefghijklmnopqrstuvwxyz1234567890TOKENA";
		const dir = makeProviderDir(
			"submit-pattern-readme-",
			validProviderSource(),
			`${defaultReadme()}\nAuthorization: ${demoToken}\n`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
		expect(check?.evidence?.join("\n")).toContain("README.md:");
		expect(report.score.verdict).toBe("blocked");
	});

	it("does not let an @apifuse-allow pragma suppress findings on other lines", async () => {
		const key = "qJ8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS8dF2gH7j";
		const dir = makeProviderDir(
			"submit-entropy-allow-wrong-line-",
			`${validProviderSource()}
// @apifuse-allow secret-scan: acknowledged blob
const acknowledged = "${key}";
const apiKey = "${key}";
`,
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "secret-scan");

		expect(check?.level).toBe("blocker");
		expect(check?.status).toBe("fail");
	});

	it("checks auto-promotion eligibility boundaries", () => {
		const report = {
			score: { total: 94, max: 100, verdict: "ready" },
			summary: { blockers: 0, warnings: 0, passed: 1 },
		} as SubmitCheckReport;

		expect(isAutoPromotionEligible(report)).toBe(false);

		report.score.total = 95;
		expect(isAutoPromotionEligible(report)).toBe(true);

		report.summary.blockers = 1;
		expect(isAutoPromotionEligible(report)).toBe(false);
	});

	it("passes structural rules for a clean provider", async () => {
		const dir = makeProviderDir("submit-structural-pass-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		for (const id of [
			"unsafe-input-passthrough",
			"unjustified-loose-schema",
			"flat-operation-composition",
		]) {
			const check = report.checks.find((item) => item.id === id);
			expect(check?.status).toBe("pass");
			expect(check?.maxPoints).toBe(0);
		}
	});

	it("blocks when a public input schema uses .passthrough()", async () => {
		const source = validProviderSource()
			.replace(
				"const input = describeKey(",
				"const requestSchema = z.object({ q: z.string() }).passthrough();\nconst input = describeKey(",
			)
			.replace("input,\n", "input: requestSchema,\n");
		const dir = makeProviderDir("submit-input-passthrough-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "unsafe-input-passthrough");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
		expect(report.score.verdict).toBe("blocked");
	});

	it("downgrades input passthrough to a warning with @apifuse-allow", async () => {
		const source = validProviderSource()
			.replace(
				"const input = describeKey(",
				"// @apifuse-allow unsafe-input-passthrough: upstream form replay\nconst requestSchema = z.object({ q: z.string() }).passthrough();\nconst input = describeKey(",
			)
			.replace("input,\n", "input: requestSchema,\n");
		const dir = makeProviderDir("submit-input-passthrough-allow-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "unsafe-input-passthrough");

		// The acknowledged @apifuse-allow downgrades this rule from blocker to a
		// counted warning: status is warn and the rule contributes no blocker.
		expect(check?.status).toBe("warn");
		expect(check?.level).toBe("warn");
	});

	it("blocks unjustified loose schemas", async () => {
		const source = validProviderSource().replace(
			"const input = describeKey(",
			"const looseThing = z.unknown();\nconst input = describeKey(",
		);
		const dir = makeProviderDir("submit-loose-schema-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "unjustified-loose-schema");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
		expect(report.score.verdict).toBe("blocked");
	});

	it("passes a justified loose schema", async () => {
		const source = validProviderSource().replace(
			"const input = describeKey(",
			"// upstream payload is arbitrary at this layer\nconst looseThing = z.unknown();\nconst input = describeKey(",
		);
		const dir = makeProviderDir("submit-loose-schema-justified-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "unjustified-loose-schema");

		expect(check?.status).toBe("pass");
	});

	it("blocks factory-composed operations", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

function buildProvider() {
  const { operations } = makeOperations();
  return defineProvider({ id: "factory", version: "1.0.0", runtime: "standard", operations });
}

const { operations } = makeOperations();
export default defineProvider({ id: "factory", version: "1.0.0", runtime: "standard", operations });
`;
		const dir = makeProviderDir("submit-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("passes static-literal operations", async () => {
		const dir = makeProviderDir("submit-static-ops-", validProviderSource());
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("pass");
	});

	it("blocks factory operations when the implementation argument uses satisfies", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({ id: "satisfies", operations: makeOperations() } satisfies Record<string, unknown>);
`;
		const dir = makeProviderDir("submit-satisfies-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks factory operations when the implementation argument uses as", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({ id: "asserted", operations: makeOperations() } as Record<string, unknown>);
`;
		const dir = makeProviderDir("submit-asserted-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("inspects static operations when the implementation argument uses satisfies", async () => {
		const source = validProviderSource().replace(
			/\}\);\s*$/,
			"} satisfies Record<string, unknown>);",
		);
		const dir = makeProviderDir("submit-satisfies-static-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("pass");
		expect(check?.message).toBe("defineProvider declares operations as a static object literal.");
	});

	it("blocks named curried defineProvider factory operations", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

function makeOperations() { return {}; }
const providerImpl = defineProvider({ id: "probe" })({ operations: makeOperations() });
export default providerImpl;
`;
		const dir = makeProviderDir("submit-named-curried-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks inline curried defineProvider factory operations", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({ id: "inline-curried" })({ operations: makeOperations() });
`;
		const dir = makeProviderDir("submit-inline-curried-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("passes named curried defineProvider static operations", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

const providerImpl = defineProvider({ id: "named-static", operations: makeMetadataOperations() })({ operations: { ping: {} } });
export default providerImpl;
`;
		const dir = makeProviderDir("submit-named-curried-static-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("pass");
		expect(check?.message).toBe("defineProvider declares operations as a static object literal.");
	});

	it("passes inline curried defineProvider static operations", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({ id: "inline-static" })({ operations: { ping: {} } });
`;
		const dir = makeProviderDir("submit-inline-curried-static-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("pass");
		expect(check?.message).toBe("defineProvider declares operations as a static object literal.");
	});

	it("blocks input passthrough bound via a non-input-named schema", async () => {
		const source = validProviderSource()
			.replace(
				"const input = describeKey(",
				"const requestSchema = z.object({ q: z.string() }).passthrough();\nconst input = describeKey(",
			)
			.replace("input,\n", "input: requestSchema,\n");
		const dir = makeProviderDir("submit-input-aliased-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "unsafe-input-passthrough");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks inline input passthrough", async () => {
		const source = validProviderSource().replace(
			"input,\n",
			"input: z.object({ q: z.string() }).passthrough(),\n",
		);
		const dir = makeProviderDir("submit-input-inline-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "unsafe-input-passthrough");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks inline factory-call operations", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({ id: "factory", version: "1.0.0", runtime: "standard", operations: makeOperations(handlers) });
`;
		const dir = makeProviderDir("submit-inline-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks factory-composed operations under a quoted property name", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({ id: "factory", version: "1.0.0", runtime: "standard", "operations": makeOperations() });
`;
		const dir = makeProviderDir("submit-quoted-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("passes static-literal operations under a quoted property name", async () => {
		const source = validProviderSource().replace("  operations: {", '  "operations": {');
		const dir = makeProviderDir("submit-quoted-static-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("pass");
	});

	it("blocks an unresolved computed operations property name", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

const opsKey = "operations";
export default defineProvider({ id: "computed", version: "1.0.0", runtime: "standard", [opsKey]: makeOperations() });
`;
		const dir = makeProviderDir("submit-computed-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
		expect(check?.message).toContain("computed property name");
		expect(check?.message).not.toContain("factory call");
		expect(check?.evidence).toContain("index.ts:5 (computed property name)");
	});

	it("blocks a computed operations override after a static literal", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

const opsKey = "operations";
export default defineProvider({ id: "computed-override" })({
  operations: { lookup: {} },
  [opsKey]: makeOperations(),
});
`;
		const dir = makeProviderDir("submit-computed-operations-override-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
		expect(check?.message).toContain("computed property name");
		expect(check?.evidence).toContain("index.ts:7 (computed property name)");
	});

	it("blocks an opaque implementation spread after static operations", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({ id: "spread-override" })({
  operations: { lookup: {} },
  ...makeOperations(),
});
`;
		const dir = makeProviderDir("submit-opaque-implementation-spread-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("passes an inline static object spread in the implementation", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({ id: "inline-static-spread" })({
  operations: { lookup: {} },
  ...{ operations: { ping: {} } },
});
`;
		const dir = makeProviderDir("submit-inline-static-implementation-spread-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("pass");
	});

	it("classifies operations from an inline implementation spread", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({ id: "inline-factory-spread" })({
  operations: { lookup: {} },
  ...{ operations: makeOperations() },
});
`;
		const dir = makeProviderDir("submit-inline-factory-implementation-spread-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks factory operations shadowed by an operations comment", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({
  id: "factory",
  version: "1.0.0",
  runtime: "standard",
  // operations: makeOperations()
  operations: makeOperations(),
});
`;
		const dir = makeProviderDir("submit-comment-shadowed-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks factory operations after an operations-like quoted key", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({
  id: "factory",
  version: "1.0.0",
  runtime: "standard",
  meta: { "operations: decoy": true },
  operations: makeOperations(),
});
`;
		const dir = makeProviderDir("submit-quoted-key-shadowed-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks factory operations after an operations decoy in a template literal", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({
  id: "factory",
  version: "1.0.0",
  runtime: "standard",
  meta: { note: \`operations: decoy\` },
  operations: makeOperations(),
});
`;
		const dir = makeProviderDir("submit-template-shadowed-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks factory operations after an operations decoy in a comment", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({
  id: "factory",
  version: "1.0.0",
  runtime: "standard",
  // operations: decoy
  operations: makeOperations(),
});
`;
		const dir = makeProviderDir("submit-comment-decoy-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks factory operations after an operations string literal", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({
  id: "factory",
  version: "1.0.0",
  runtime: "standard",
  description: "operations: x",
  operations: makeOperations(),
});
`;
		const dir = makeProviderDir("submit-string-shadowed-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks multi-line inline input passthrough", async () => {
		const source = validProviderSource().replace(
			"input,\n",
			"input: z\n        .object({ q: z.string() })\n        .passthrough(),\n",
		);
		const dir = makeProviderDir("submit-input-multiline-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "unsafe-input-passthrough");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks factory operations bound through an aliased identifier", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

const ops = makeOperations(handlers);
export default defineProvider({ id: "factory", version: "1.0.0", runtime: "standard", operations: ops });
`;
		const dir = makeProviderDir("submit-aliased-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks input passthrough whose schema lives in another module", async () => {
		const source = validProviderSource()
			.replace(
				'import { defineProvider, describeKey, z } from "@apifuse/provider-sdk";',
				'import { defineProvider, describeKey, z } from "@apifuse/provider-sdk";\nimport { requestSchema } from "./schemas";',
			)
			.replace("input,\n", "input: requestSchema,\n");
		const dir = makeProviderDir("submit-input-cross-module-", source);
		writeFileSync(
			join(dir, "schemas.ts"),
			'import { z } from "@apifuse/provider-sdk";\n\nexport const requestSchema = z.object({ q: z.string() }).passthrough();\n',
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "unsafe-input-passthrough");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("does not flag a strict input that shares an identifier with an unrelated passthrough schema", async () => {
		// `requestSchema` is a generic name: one module declares a strict input
		// using a locally-built schema, another module has an unrelated
		// passthrough const of the same name. With no import binding the two,
		// the strict input must NOT be flagged (binding-aware resolution).
		const source = validProviderSource().replace("input,\n", "input: requestSchema,\n");
		const dir = makeProviderDir("submit-input-name-collision-", source);
		// index.ts declares its own strict requestSchema (no passthrough); a
		// sibling module has an unrelated passthrough const of the same name.
		writeFileSync(
			join(dir, "schemas.ts"),
			'import { z } from "@apifuse/provider-sdk";\n\nexport const requestSchema = z.object({ raw: z.unknown() }).passthrough();\n',
		);
		const withLocal = source.replace(
			"const input = describeKey(",
			"const requestSchema = z.object({ q: z.string() });\nconst input = describeKey(",
		);
		writeFileSync(join(dir, "index.ts"), withLocal);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "unsafe-input-passthrough");

		expect(check?.status).toBe("pass");
	});

	it("blocks input passthrough imported under a local alias", async () => {
		// `import { requestSchema as inputSchema }` then `input: inputSchema`.
		// The local alias must be mapped back to the exported name the
		// provider-wide passthrough map is keyed by, or the cross-module
		// passthrough input slips through.
		const source = validProviderSource()
			.replace(
				'import { defineProvider, describeKey, z } from "@apifuse/provider-sdk";',
				'import { defineProvider, describeKey, z } from "@apifuse/provider-sdk";\nimport { requestSchema as inputSchema } from "./schemas";',
			)
			.replace("input,\n", "input: inputSchema,\n");
		const dir = makeProviderDir("submit-input-import-alias-", source);
		writeFileSync(
			join(dir, "schemas.ts"),
			'import { z } from "@apifuse/provider-sdk";\n\nexport const requestSchema = z.object({ q: z.string() }).passthrough();\n',
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "unsafe-input-passthrough");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("flags factory operations even with an unrelated earlier operations literal", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

const docs = { operations: {} };
export default defineProvider({ id: "factory", version: "1.0.0", runtime: "standard", operations: makeOperations() });
`;
		const dir = makeProviderDir("submit-decoy-operations-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks factory operations re-exported from a sibling module", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";
import { operations } from "./operations";

export default defineProvider({ id: "factory", version: "1.0.0", runtime: "standard", operations });
`;
		const dir = makeProviderDir("submit-sibling-factory-ops-", source);
		writeFileSync(
			join(dir, "operations.ts"),
			"export const operations = makeOperations(handlers);\n",
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("does not flag an `input` field nested inside an upstream schema body", async () => {
		// `input` here is a property of a zod object body modelling an upstream
		// payload, not an operation's public input schema. Must NOT be flagged.
		const source = validProviderSource().replace(
			"const output = describeKey(",
			"const upstreamRaw = z.object({ input: z.object({ q: z.string() }).passthrough() });\nconst output = describeKey(",
		);
		const dir = makeProviderDir("submit-input-field-in-schema-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "unsafe-input-passthrough");

		expect(check?.status).toBe("pass");
	});

	it("still flags a real operation input passthrough alongside an upstream input field", async () => {
		// Decoy upstream `input` field must not suppress the real operation input
		// passthrough that follows.
		const source = validProviderSource()
			.replace(
				"const output = describeKey(",
				"const upstreamRaw = z.object({ input: z.object({ q: z.string() }).passthrough() });\nconst output = describeKey(",
			)
			.replace("input,\n", "input: z.object({ q: z.string() }).passthrough(),\n");
		const dir = makeProviderDir("submit-input-mixed-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "unsafe-input-passthrough");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("evaluates the default-exported provider, not an earlier helper call", async () => {
		// A static helper provider appears first; the real default export is
		// factory-composed and must still be blocked.
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

const helper = defineProvider({ id: "helper", version: "1.0.0", runtime: "standard", operations: { ping: {} } });
export default defineProvider({ id: "real", version: "1.0.0", runtime: "standard", operations: makeOperations() });
`;
		const dir = makeProviderDir("submit-default-export-real-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("passes a static default export even when an earlier helper is factory-composed", async () => {
		// A factory helper appears first; the real default export is static and
		// must pass (the first regex match would have wrongly blocked it).
		const source = `
import { defineProvider, describeKey, z } from "@apifuse/provider-sdk";

const helperOps = defineProvider({ id: "helper", version: "1.0.0", runtime: "standard", operations: makeOperations() });

const input = describeKey(z.object({ q: describeKey(z.string(), "operations.lookup.fields.q.description") }), "operations.lookup.input.description");
const output = describeKey(z.object({ ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description") }), "operations.lookup.output.description");

export default defineProvider({
  id: "good-provider",
  version: "1.0.0",
  runtime: "standard",
  allowedHosts: ["api.example.com"],
  reviewed: "community",
  auth: { mode: "none" },
  meta: {
    displayName: "Good Provider",
    descriptionKey: "provider.meta.description",
    category: "other",
    docTitleKey: "provider.meta.docTitle",
    docDescriptionKey: "provider.meta.docDescription",
    docSummaryKey: "provider.meta.docSummary",
    docMarkdownKey: "provider.meta.docMarkdown",
    publicProfile: {
      displayNameKey: "provider.meta.publicProfile.displayName",
      shortDescriptionKey: "provider.meta.publicProfile.shortDescription",
      longDescriptionKey: "provider.meta.publicProfile.longDescription",
      capabilityKeys: ["provider.meta.publicProfile.capabilities"],
      examplePromptKeys: ["provider.meta.publicProfile.examplePrompts"],
      setupSummaryKey: "provider.meta.publicProfile.setupSummary",
      requirementKeys: ["provider.meta.publicProfile.requirements"],
      limitationKeys: ["provider.meta.publicProfile.limitations"],
    },
  },
  operations: {
    lookup: {
      descriptionKey: "operations.lookup.description",
      input,
      output,
      annotations: { readOnly: true, idempotent: true, openWorld: true },
      handler: async () => ({ ok: true }),
      fixtures: { request: { q: "btc" }, response: { ok: true } },
      healthCheck: {
        interval: "1m",
        cases: [{ name: "lookup ok", input: { q: "btc" }, assertions: ({ status, data }) => { if (status !== 200) { return { status: "degraded", label: "lookup changed" }; } if (!data) { throw new Error("empty lookup response"); } } }],
      },
    },
  },
});
`;
		const dir = makeProviderDir("submit-default-export-static-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("pass");
	});

	it("blocks operations imported from a module that cannot be resolved locally", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";
import { operations } from "./generated/operations";

export default defineProvider({ id: "factory", version: "1.0.0", runtime: "standard", operations });
`;
		const dir = makeProviderDir("submit-unresolved-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks a factory-composed provider exported via a named const default", async () => {
		// `export const provider = defineProvider(...)` then `export default
		// provider`, with a static helper defineProvider earlier. The named
		// default must be resolved, not the helper.
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

const helper = defineProvider({ id: "helper", version: "1.0.0", runtime: "standard", operations: { ping: {} } });
export const provider = defineProvider({ id: "real", version: "1.0.0", runtime: "standard", operations: makeOperations() });
export default provider;
`;
		const dir = makeProviderDir("submit-named-default-factory-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks a factory spread inside an operations object literal", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({ id: "spread", version: "1.0.0", runtime: "standard", operations: { ...makeOperations() } });
`;
		const dir = makeProviderDir("submit-factory-spread-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks a factory spread after a quoted opening-brace operation key", async () => {
		const source = sourceWithFactorySpreadDepthNoise("").replace(
			"operations: {\n    lookup:",
			"operations: {\n    \"{\": undefined as never,\n    lookup:",
		);
		const dir = makeProviderDir("submit-factory-spread-quoted-open-key-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("ignores a nested spread after a quoted closing-brace operation key", async () => {
		const source = validProviderSource()
			.replace(
				"\nexport default defineProvider",
				"\nfunction makeFields() { return {}; }\n\nexport default defineProvider",
			)
			.replace(
				'descriptionKey: "operations.lookup.description",',
				'descriptionKey: "operations.lookup.description",\n      "}": undefined as never,\n      ...makeFields(),',
			);
		const dir = makeProviderDir("submit-factory-spread-quoted-close-key-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("pass");
	});

	it("blocks an operations-level factory spread after an opening brace in a string", async () => {
		const dir = makeProviderDir(
			"submit-factory-spread-string-open-",
			sourceWithFactorySpreadDepthNoise('documentation: "{",'),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks an operations-level factory spread after an opening brace in a template", async () => {
		const dir = makeProviderDir(
			"submit-factory-spread-template-open-",
			sourceWithFactorySpreadDepthNoise("documentation: `{`,"),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks an operations-level factory spread after an opening brace in a comment", async () => {
		const dir = makeProviderDir(
			"submit-factory-spread-comment-open-",
			sourceWithFactorySpreadDepthNoise("// {"),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks an operations-level factory spread after an opening brace in a regex", async () => {
		const dir = makeProviderDir(
			"submit-factory-spread-regex-open-",
			sourceWithFactorySpreadDepthNoise("pattern: /\\{/,"),
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("ignores a nested factory spread promoted by a closing brace in a string", async () => {
		const source = validProviderSource()
			.replace(
				"\nexport default defineProvider",
				"\nfunction makeFields() { return {}; }\nconst fields = makeFields();\n\nexport default defineProvider",
			)
			.replace(
				'descriptionKey: "operations.lookup.description",',
				'descriptionKey: "operations.lookup.description",\n      documentation: "}",\n      ...fields,',
			);
		const dir = makeProviderDir("submit-nested-spread-string-close-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("pass");
	});

	it("blocks a factory provider formatted as `defineProvider (` with whitespace", async () => {
		// Whitespace before the call paren must not let the early-exit precheck
		// pass a factory-composed provider.
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider ({ id: "ws", version: "1.0.0", runtime: "standard", operations: makeOperations() });
`;
		const dir = makeProviderDir("submit-ws-defineprovider-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks a factory operations module despite a decoy same-named static const", async () => {
		// A decoy `const operations = {}` in an earlier-scanned sibling must not
		// mask the factory-composed `operations` the provider actually imports.
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";
import { operations } from "./operations";

export default defineProvider({ id: "decoy", version: "1.0.0", runtime: "standard", operations });
`;
		const dir = makeProviderDir("submit-decoy-samename-const-", source);
		// "decoy.ts" sorts before "operations.ts" so the static decl is scanned
		// first; the factory one must still win.
		writeFileSync(join(dir, "decoy.ts"), "export const operations = {};\n");
		writeFileSync(
			join(dir, "operations.ts"),
			"export const operations = makeOperations(handlers);\n",
		);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks a parenthesized factory operations expression", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

export default defineProvider({ id: "paren", version: "1.0.0", runtime: "standard", operations: (makeOperations()) });
`;
		const dir = makeProviderDir("submit-paren-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks an input passthrough call written with whitespace before the parens", async () => {
		const source = validProviderSource().replace(
			"input,\n",
			"input: z.object({ q: z.string() }).passthrough (),\n",
		);
		const dir = makeProviderDir("submit-spaced-passthrough-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "unsafe-input-passthrough");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("downgrades flat-operation-composition to a warning with @apifuse-allow", async () => {
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

// @apifuse-allow flat-operation-composition: legacy generated map, migration tracked
const operations = makeOperations();
export default defineProvider({ id: "allow", version: "1.0.0", runtime: "standard", operations });
`;
		const dir = makeProviderDir("submit-flat-op-allow-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("warn");
		expect(check?.level).toBe("warn");
	});

	it("blocks a typed-alias operations map composed by an opaque factory", async () => {
		// Codex round-10 P2-2: a TypeScript type annotation on the operations
		// const must not let an opaque factory evade classification.
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";
import type { OperationDefinition } from "@apifuse/provider-sdk";

const operations: Record<string, OperationDefinition> = makeOperations();
export default defineProvider({ id: "typed-factory", version: "1.0.0", runtime: "standard", operations });
`;
		const dir = makeProviderDir("submit-typed-factory-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("passes a static op map narrowed by Object.fromEntries(Object.entries(...).filter(...))", async () => {
		// Verified golden pattern (triple): a statically-defined operations
		// object is filtered to a whitelist via the stdlib enumerate-and-reshape
		// idiom. The op set is still enumerable from source, so this passes —
		// even when the const carries a TypeScript type annotation.
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";
import type { OperationDefinition } from "@apifuse/provider-sdk";

const allOperations: Record<string, OperationDefinition> = {
  ping: { handler: async () => ({}) },
  pong: { handler: async () => ({}) },
};
const VERIFIED = new Set<string>(["ping"]);
const operations: Record<string, OperationDefinition> = Object.fromEntries(
  Object.entries(allOperations).filter(([opId]) => VERIFIED.has(opId)),
);
export default defineProvider({ id: "reshape", version: "1.0.0", runtime: "standard" })({ operations });
`;
		const dir = makeProviderDir("submit-transparent-reshape-ops-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("pass");
	});

	it("blocks Object.fromEntries(buildEntries()) without a source-visible Object.entries", async () => {
		// The reshape exemption only applies to the exact
		// Object.fromEntries(Object.entries(...)) idiom. A fromEntries fed by an
		// opaque entries builder hides the op set and must still be blocked.
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

const operations = Object.fromEntries(buildEntries());
export default defineProvider({ id: "opaque-entries", version: "1.0.0", runtime: "standard", operations });
`;
		const dir = makeProviderDir("submit-opaque-fromentries-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks fromEntries whose source is opaque despite Object.entries in a predicate", async () => {
		// Object.entries appears only inside the filter predicate; the actual
		// entries source is the opaque buildEntries() call, so the op set is
		// NOT enumerable from source and the exemption must not apply.
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

const ALLOWED = { a: 1 };
const operations = Object.fromEntries(
  buildEntries().filter(([id]) => Object.entries(ALLOWED).some(([k]) => k === id)),
);
export default defineProvider({ id: "opaque-pred", version: "1.0.0", runtime: "standard", operations });
`;
		const dir = makeProviderDir("submit-opaque-predicate-entries-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("blocks a factory map laundered through a variable before spreading", async () => {
		// `const hidden = makeOperations(); operations: { ...hidden }` — the
		// spread identifier must be resolved to its factory declaration so an
		// opaque map cannot pass by being assigned to a variable first.
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

const hidden = makeOperations();
export default defineProvider({ id: "launder", version: "1.0.0", runtime: "standard", operations: { ...hidden } });
`;
		const dir = makeProviderDir("submit-laundered-spread-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("fail");
		expect(check?.level).toBe("blocker");
	});

	it("passes a spread of a statically-declared object variable", async () => {
		// Control: `const base = { ... }; operations: { ...base }` spreads a
		// static object literal, not a factory, and must pass.
		const source = `
import { defineProvider } from "@apifuse/provider-sdk";

const base = { ping: { handler: async () => ({ ok: true }) } };
export default defineProvider({ id: "static-spread", version: "1.0.0", runtime: "standard" })({ operations: { ...base } });
`;
		const dir = makeProviderDir("submit-static-var-spread-", source);
		writeValidLocaleCatalogs(dir);
		const report = await buildSubmitCheckReport(dir);
		const check = report.checks.find((item) => item.id === "flat-operation-composition");

		expect(check?.status).toBe("pass");
	});
});

describe("sdk-owned-secret-presence rule", () => {
	const SECRET_NAME = "APIFUSE__PROVIDER__GOOD_PROVIDER__SERVICE_KEY";

	function sourceWithDeclaredSecret(): string {
		return validProviderSource().replace(
			'auth: { mode: "none" },',
			`auth: { mode: "none" },\n  secrets: [{ name: "${SECRET_NAME}", required: true }],`,
		);
	}

	function literalGuardHandler(allowComment = ""): string {
		return `handler: async (ctx) => {
        ${allowComment}const key = ctx.env.get("${SECRET_NAME}");
        if (!key?.trim()) {
          throw new Error("missing key");
        }
        return { ok: true };
      },`;
	}

	async function findCheck(dir: string) {
		const report = await buildSubmitCheckReport(dir);
		return report.checks.find((item) => item.id === "sdk-owned-secret-presence");
	}

	it("warns on a direct-literal local presence guard", async () => {
		const dir = makeProviderDir(
			"submit-secret-presence-literal-",
			sourceWithDeclaredSecret().replace(
				"handler: async () => ({ ok: true }),",
				literalGuardHandler(),
			),
		);
		writeValidLocaleCatalogs(dir);

		const check = await findCheck(dir);
		expect(check?.status).toBe("warn");
		expect(check?.level).toBe("warn");
		expect(check?.points).toBe(0);
		expect(check?.maxPoints).toBe(0);
		expect(check?.remediation).toContain("MISSING_SECRET");
		expect(check?.evidence?.some((line) => line.startsWith("index.ts:"))).toBe(true);
	});

	it("detects the aliased requireServiceKey pattern in a sibling module", async () => {
		const dir = makeProviderDir("submit-secret-presence-alias-", sourceWithDeclaredSecret());
		writeFileSync(
			join(dir, "upstream.ts"),
			`export const SERVICE_KEY_ENV = "${SECRET_NAME}";

export function requireServiceKey(ctx: { env: { get(key: string): string | undefined } }): string {
  const value = ctx.env.get(SERVICE_KEY_ENV);
  if (!value?.trim()) {
    throw new Error("Missing required provider secret: " + SERVICE_KEY_ENV);
  }
  return value;
}
`,
		);
		writeValidLocaleCatalogs(dir);

		const check = await findCheck(dir);
		expect(check?.status).toBe("warn");
		expect(check?.evidence?.some((line) => line.startsWith("upstream.ts:"))).toBe(true);
	});

	it("passes with an acknowledged @apifuse-allow override", async () => {
		const dir = makeProviderDir(
			"submit-secret-presence-allow-",
			sourceWithDeclaredSecret().replace(
				"handler: async () => ({ ok: true }),",
				literalGuardHandler(
					"// @apifuse-allow sdk-owned-secret-presence: legacy guard pending removal\n        ",
				),
			),
		);
		writeValidLocaleCatalogs(dir);

		const check = await findCheck(dir);
		expect(check?.status).toBe("pass");
		expect(check?.message).toContain("acknowledged @apifuse-allow override");
	});

	it("passes a guard-free provider that reads the secret directly", async () => {
		const dir = makeProviderDir(
			"submit-secret-presence-clean-",
			sourceWithDeclaredSecret().replace(
				"handler: async () => ({ ok: true }),",
				`handler: async (ctx) => {
        const key = ctx.env.get("${SECRET_NAME}");
        return { ok: key !== undefined };
      },`,
			),
		);
		writeValidLocaleCatalogs(dir);

		const check = await findCheck(dir);
		expect(check?.status).toBe("pass");
	});

	it("ignores guards over optional declared secrets the runtime does not enforce", async () => {
		const dir = makeProviderDir(
			"submit-secret-presence-optional-",
			validProviderSource()
				.replace(
					'auth: { mode: "none" },',
					`auth: { mode: "none" },\n  secrets: [{ name: "${SECRET_NAME}", required: false }],`,
				)
				.replace("handler: async () => ({ ok: true }),", literalGuardHandler()),
		);
		writeValidLocaleCatalogs(dir);

		const check = await findCheck(dir);
		expect(check?.status).toBe("pass");
	});

	it("ignores guards over env names not declared in secrets[]", async () => {
		const dir = makeProviderDir(
			"submit-secret-presence-undeclared-",
			sourceWithDeclaredSecret().replace(
				"handler: async () => ({ ok: true }),",
				`handler: async (ctx) => {
        const flag = ctx.env.get("SOME_UNDECLARED_TOGGLE");
        if (!flag) {
          throw new Error("toggle disabled");
        }
        return { ok: true };
      },`,
			),
		);
		writeValidLocaleCatalogs(dir);

		const check = await findCheck(dir);
		expect(check?.status).toBe("pass");
	});
});
