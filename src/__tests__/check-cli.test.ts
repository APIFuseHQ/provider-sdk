import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runChecks } from "../../bin/apifuse-check.js";

const tempDirs: string[] = [];
const tempRoot = join(process.cwd(), ".tmp-provider-sdk-tests");

function makeProviderDir(prefix: string): string {
	mkdirSync(tempRoot, { recursive: true });
	const dir = mkdtempSync(join(tempRoot, prefix));
	tempDirs.push(dir);
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			dependencies: { "@apifuse/provider-sdk": "workspace:*" },
		}),
	);
	writeFileSync(join(dir, "Dockerfile"), "FROM oven/bun:1.2-alpine\n");
	linkLocalSdkDependency(dir);
	return dir;
}

function linkLocalSdkDependency(providerDir: string): void {
	const scopeDir = join(providerDir, "node_modules", "@apifuse");
	mkdirSync(scopeDir, { recursive: true });
	const target = join(scopeDir, "provider-sdk");
	if (!existsSync(target)) {
		symlinkSync(dirname(dirname(import.meta.dir)), target, "dir");
	}
}

function writeValidLocaleCatalogs(dir: string): void {
	mkdirSync(join(dir, "locales"), { recursive: true });
	const en = {
		operations: {
			lookup: {
				description: "Catalog-owned lookup operation description.",
				input: { description: "Lookup input object." },
				output: { description: "Lookup output object." },
				fields: {
					q: { description: "Lookup query text." },
					ok: { description: "Lookup success flag." },
				},
			},
		},
	};
	const ko = {
		operations: {
			lookup: {
				description: "카탈로그 소유 lookup 작업 설명입니다.",
				input: { description: "Lookup 입력 객체입니다." },
				output: { description: "Lookup 출력 객체입니다." },
				fields: {
					q: { description: "Lookup 검색어입니다." },
					ok: { description: "Lookup 성공 플래그입니다." },
				},
			},
		},
	};
	writeFileSync(join(dir, "locales", "en.json"), JSON.stringify(en));
	writeFileSync(join(dir, "locales", "ko.json"), JSON.stringify(ko));
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("apifuse check", () => {
	it("fails public authoring lint errors before maintainer import", async () => {
		const providerDir = makeProviderDir("apifuse-check-lint-fail-");
		writeFileSync(
			join(providerDir, "index.ts"),
			`
import { z } from "zod";

export default {
  id: "bad-provider",
  version: "1.0.0",
  runtime: "standard",
  allowedHosts: ["api.example.com"],
  reviewed: "community",
  auth: { mode: "none" },
  meta: { displayName: "Bad Provider", category: "other" },
  operations: {
    lookup: {
      description: "Too short.",
      input: z.object({ q: z.string() }),
      output: z.object({ ok: z.boolean() }),
      handler: async () => ({ ok: true }),
      fixtures: { request: { q: "btc" }, response: { ok: true } },
      healthCheckUnsupported: { reason: "Unit test operation." },
    },
  },
};
`,
		);

		const results = await runChecks(providerDir);
		const authoring = results.find((result) => result.message.includes("Provider authoring lint"));

		expect(authoring?.passed).toBe(false);
		expect(authoring?.details?.join("\n")).toContain("description-min-length");
		expect(authoring?.details?.join("\n")).toContain("schema-description-key-required");
	});

	it("passes public authoring lint for a review-ready provider", async () => {
		const providerDir = makeProviderDir("apifuse-check-lint-pass-");
		writeValidLocaleCatalogs(providerDir);
		writeFileSync(
			join(providerDir, "index.ts"),
			`
import { describeKey, z } from "@apifuse/provider-sdk";

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

export default {
  id: "good-provider",
  version: "1.0.0",
  runtime: "standard",
  allowedHosts: ["api.example.com"],
  reviewed: "community",
  auth: { mode: "none" },
  meta: { displayName: "Good Provider", category: "other" },
  operations: {
    lookup: {
      descriptionKey: "operations.lookup.description",
      input,
      output,
      handler: async () => ({ ok: true }),
      fixtures: { request: { q: "btc" }, response: { ok: true } },
      healthCheckUnsupported: { reason: "Unit test operation." },
    },
  },
};
`,
		);

		const results = await runChecks(providerDir);
		const authoring = results.find((result) => result.message.includes("Provider authoring lint"));

		expect(authoring?.passed).toBe(true);
	});

	it("fails official authoring lint for nested self-hosted browser source and entrypoint scripts", async () => {
		const providerDir = makeProviderDir("apifuse-check-browser-lint-fail-");
		writeValidLocaleCatalogs(providerDir);
		writeFileSync(
			join(providerDir, "index.ts"),
			`
import { describeKey, z } from "@apifuse/provider-sdk";

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

export default {
  id: "browser-provider",
  version: "1.0.0",
  runtime: "browser",
  allowedHosts: ["api.example.com"],
  reviewed: "first-party",
  auth: { mode: "none" },
  meta: { displayName: "Browser Provider", category: "other" },
  operations: {
    lookup: {
      descriptionKey: "operations.lookup.description",
      input,
      output,
      handler: async () => ({ ok: true }),
      fixtures: { request: { q: "btc" }, response: { ok: true } },
      healthCheckUnsupported: { reason: "Unit test operation." },
    },
  },
};
`,
		);
		mkdirSync(join(providerDir, "src", "browser"), { recursive: true });
		writeFileSync(
			join(providerDir, "src", "browser", "launch.ts"),
			"export async function localBrowser() { return chromium.launch(); }\n",
		);
		mkdirSync(join(providerDir, "scripts"), { recursive: true });
		writeFileSync(
			join(providerDir, "scripts", "entrypoint.mjs"),
			'Bun.spawn(["chromium", "--remote-debugging-port=9222"]);\n',
		);
		writeFileSync(
			join(providerDir, "entrypoint.sh"),
			"#!/usr/bin/env bash\nchromium --remote-debugging-port=9222\n",
		);
		writeFileSync(
			join(providerDir, "Dockerfile"),
			'FROM oven/bun:1.2-alpine\nCMD ["google-chrome", "--remote-debugging-port=9222"]\n',
		);

		const results = await runChecks(providerDir);
		const authoring = results.find((result) => result.message.includes("Provider authoring lint"));
		const details = authoring?.details?.join("\n") ?? "";

		expect(authoring?.passed).toBe(false);
		expect(details).toContain("browser-self-hosted-launch");
		expect(details).toContain("sourceFiles.src/browser/launch.ts");
		expect(details).toContain("browser-self-hosted-child-process");
		expect(details).toContain("sourceFiles.scripts/entrypoint.mjs");
		expect(details).toContain("sourceFiles.entrypoint.sh");
		expect(details).toContain("sourceFiles.Dockerfile");
		expect(details).toContain("ctx.browser");
	});

	it("blocks operation credential writes while return-based refresh passes the scan", async () => {
		const providerDir = makeProviderDir("apifuse-check-credential-write-");
		writeValidLocaleCatalogs(providerDir);
		writeFileSync(
			join(providerDir, "index.ts"),
			`
import { defineProvider, describeKey, z } from "@apifuse/provider-sdk";

const input = describeKey(z.object({ q: describeKey(z.string(), "operations.lookup.fields.q.description") }), "operations.lookup.input.description");
const output = describeKey(z.object({ ok: describeKey(z.boolean(), "operations.lookup.fields.ok.description") }), "operations.lookup.output.description");

export default defineProvider({
  id: "credential-write-provider",
  version: "1.0.0",
  runtime: "standard",
  allowedHosts: ["api.example.com"],
  reviewed: "community",
  auth: {
    mode: "credentials",
    flow: {
      start: async () => ({ kind: "input", turnId: "1" }),
      continue: async () => ({ kind: "complete", turnId: "2", data: { credential: { session: "old" } } }),
      refresh: async () => ({ kind: "complete", turnId: "3", data: { credential: { session: "new" } } }),
    },
  },
  credential: {
    keys: ["session"],
    storesReusableSecret: true,
    justification: "Session cookie is required for upstream calls.",
  },
  meta: { displayName: "Credential Write Provider", category: "other" },
  operations: {
    lookup: {
      descriptionKey: "operations.lookup.description",
      input,
      output,
      handler: async (ctx) => {
        ctx.credential.set("session", "bad");
        return { ok: true };
      },
      fixtures: { request: { q: "btc" }, response: { ok: true } },
      healthCheckUnsupported: { reason: "Unit test operation." },
    },
  },
});
`,
		);

		const results = await runChecks(providerDir);
		const authoring = results.find((result) => result.message.includes("Provider authoring lint"));

		expect(authoring?.passed).toBe(false);
		expect(authoring?.details?.join("\n")).toContain("ctx-credential-write-forbidden-in-handler");
	});
});
