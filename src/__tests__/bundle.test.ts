import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	type BoundaryViolation,
	bundleProvider,
	formatBoundaryViolation,
	RUNTIME_MODULE_ALLOWLIST,
} from "../cli/bundle.js";
import {
	CURRENT_BOUNTY_CDP_SOURCE,
	MANAGED_CDP_PORT_SOURCE,
} from "./amazon-jp-managed-cdp-acceptance-fixture.js";

const tempDirs: string[] = [];
const tempRoot = join(process.cwd(), ".tmp-provider-sdk-tests");

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeProvider(files: Record<string, string>): string {
	mkdirSync(tempRoot, { recursive: true });
	const dir = mkdtempSync(join(tempRoot, "bundle-"));
	tempDirs.push(dir);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}

function where(violation: BoundaryViolation): string {
	return `${violation.kind} ${violation.file}:${violation.line}:${violation.column} ${violation.subject}`;
}

describe("bundleProvider", () => {
	it("passes a provider that stays inside the SDK context and the module allowlist", async () => {
		const dir = makeProvider({
			"index.ts": `import { createHash } from "node:crypto";
import { join } from "path";
import { helper } from "./upstream/helper";
export default { hash: createHash("sha256"), p: join("a", "b"), helper };
`,
			"upstream/helper.ts": `export const helper = (ctx: { http: { get(url: string): Promise<unknown> } }) => {
  const port = process.env.APIFUSE__RUNTIME__PORT;
  const id = globalThis.crypto.randomUUID();
  const hasher = new Bun.CryptoHasher("sha256");
  const probe = typeof process !== "undefined" && process.platform;
  const bunProbe = typeof globalThis.Bun;
  const ctor = globalThis.constructor;
  function wrapped(fetch: typeof globalThis.fetch, process: { env: Record<string, string> }) {
    return fetch(process.env.X);
  }
  return ctx.http.get("https://api.example.com/" + port + id + hasher + probe + bunProbe + String(ctor) + wrapped.length);
};
`,
		});

		const bundle = await bundleProvider(dir);

		expect(bundle.violations.map(where)).toEqual([]);
		expect(bundle.ok).toBe(true);
	});

	it("names file, line and column for every reach outside the boundary", async () => {
		const dir = makeProvider({
			"index.ts": `import { session } from "./upstream/session";
export default { session };
`,
			"upstream/session.ts": `import { readFile } from "node:fs/promises";
import { isIP } from "net";
import { chromium } from "playwright";
const name = "node:" + "child_process";
export async function session(process2: { env: Record<string, string> }) {
  const token = process.env.SESSION_TOKEN;
  const all = process.env;
  const viaGlobal = globalThis.process.env.OTHER;
  const g = globalThis;
  const computed = globalThis["pro" + "cess"];
  const page = await fetch("https://api.example.com");
  const ws = new WebSocket("wss://api.example.com");
  const shell = Bun.$\`ls\`;
  const dyn = await import(name);
  const req = require("node:tls");
  const builtin = process.getBuiltinModule("fs");
  const meta = import.meta.env.SESSION_TOKEN;
  const probe = typeof process.env.PROBE;
  return [readFile, isIP, chromium, token, all, viaGlobal, g, computed, page, ws, shell, dyn, req, builtin, meta, probe, process2.env];
}
`,
		});

		const bundle = await bundleProvider(dir);

		expect(bundle.ok).toBe(false);
		expect(bundle.violations.map(where)).toEqual([
			"module upstream/session.ts:1:1 node:fs/promises",
			"module upstream/session.ts:2:1 net",
			"module upstream/session.ts:3:1 playwright",
			"global upstream/session.ts:6:17 process.env.SESSION_TOKEN",
			"global upstream/session.ts:7:15 process.env",
			"global upstream/session.ts:8:21 globalThis.process.env.OTHER",
			"global upstream/session.ts:9:13 globalThis",
			"global upstream/session.ts:10:20 globalThis[…]",
			"global upstream/session.ts:11:22 fetch",
			"global upstream/session.ts:12:18 WebSocket",
			"global upstream/session.ts:13:17 Bun.$",
			"dynamic-import upstream/session.ts:14:28 import(name)",
			"module upstream/session.ts:15:9 node:tls",
			"global upstream/session.ts:16:19 process.getBuiltinModule",
			"global upstream/session.ts:17:16 import.meta.env.SESSION_TOKEN",
			"global upstream/session.ts:18:24 process.env.PROBE",
		]);
		expect(bundle.violations.every((violation) => violation.level === "error")).toBe(true);
		expect(formatBoundaryViolation(bundle.violations[3] as BoundaryViolation)).toBe(
			`ERROR global upstream/session.ts:6:17: process.env.SESSION_TOKEN — ${bundle.violations[3]?.message}`,
		);
		expect(bundle.violations[3]?.message).toContain("ctx.env.get(name)");
		expect(bundle.violations[0]?.message).toContain(RUNTIME_MODULE_ALLOWLIST.join(", "));
	});

	it("reports only what the entry reaches and keeps, so unreachable or unused code is not judged", async () => {
		const dir = makeProvider({
			"index.ts": `import { used } from "./used";
import type { Stats } from "node:fs";
import { unusedBinding } from "./unused-binding";
export default { used, s: null as Stats | null };
`,
			"used.ts": `export const used = 1;\n`,
			"unused-binding.ts": `import { readFile } from "node:fs";\nexport const unusedBinding = () => readFile;\n`,
			"scripts/record.ts": `import { writeFile } from "node:fs/promises"; await writeFile("x", "y");\n`,
			"__tests__/a.test.ts": `export const raw = process.env.FIXTURE_TOKEN;\n`,
			"start.ts": `const port = process.env.APIFUSE__RUNTIME__PORT;\nawait fetch("http://localhost:" + port);\n`,
		});

		const bundle = await bundleProvider(dir);

		expect(bundle.violations.map(where)).toEqual([]);
	});

	it("follows re-exports, path aliases and side-effect imports into the graph", async () => {
		const dir = makeProvider({
			"tsconfig.json": JSON.stringify({
				compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } },
			}),
			"index.ts": `import "./side-effect";
export * from "@lib/alias";
export { env } from "./barrel";
`,
			"side-effect.ts": `import "node:fs";\n`,
			"lib/alias.ts": `export const alias = Bun.spawn(["ls"]);\n`,
			"barrel.ts": `export * from "./deep/env";\n`,
			"deep/env.ts": `export const env = Bun.env.SECRET;\n`,
		});

		const bundle = await bundleProvider(dir);

		expect(bundle.violations.map(where)).toEqual([
			"global deep/env.ts:1:20 Bun.env.SECRET",
			"global lib/alias.ts:1:22 Bun.spawn",
			"module side-effect.ts:1:1 node:fs",
		]);
	});

	it("warns instead of failing on browser drivers in standalone mode, and never on node escapes", async () => {
		const dir = makeProvider({
			"index.ts": `import puppeteer from "puppeteer-core/lib/esm/puppeteer";
import { createBrowserClient } from "@apifuse/provider-sdk/runtime/browser";
import { spawn } from "child_process";
export default { puppeteer, createBrowserClient, spawn };
`,
		});

		const official = await bundleProvider(dir, { mode: "official" });
		const standalone = await bundleProvider(dir, { mode: "standalone" });

		expect(official.ok).toBe(false);
		expect(official.violations.map((violation) => `${violation.level} ${violation.subject}`)).toEqual([
			"error puppeteer-core/lib/esm/puppeteer",
			"error @apifuse/provider-sdk/runtime/browser",
			"error child_process",
		]);
		expect(standalone.ok).toBe(false);
		expect(standalone.violations.map((violation) => `${violation.level} ${violation.subject}`)).toEqual([
			"warn puppeteer-core/lib/esm/puppeteer",
			"warn @apifuse/provider-sdk/runtime/browser",
			"error child_process",
		]);
	});

	it("rejects the amazon-jp bounty self-hosted CDP shape and accepts the managed ctx.browser shape", async () => {
		const bounty = makeProvider({
			"index.ts": `import "./operations/index";\n`,
			"operations/index.ts": CURRENT_BOUNTY_CDP_SOURCE,
		});
		const managed = makeProvider({
			"index.ts": `export * from "./operations/browser";\n`,
			"operations/browser.ts": MANAGED_CDP_PORT_SOURCE,
		});

		const [bountyBundle, managedBundle] = await Promise.all([
			bundleProvider(bounty),
			bundleProvider(managed),
		]);

		expect(bountyBundle.violations.map((violation) => violation.subject)).toEqual([
			"process.env.AMAZON_CDP_URL",
			"fetch",
			"Bun.spawn",
		]);
		expect(managedBundle.violations).toEqual([]);
	});

	it("surfaces a bundle that does not build as a violation with the bundler's position", async () => {
		const dir = makeProvider({
			"index.ts": `import { missing } from "./missing";\nexport default missing;\n`,
		});

		const bundle = await bundleProvider(dir);

		expect(bundle.ok).toBe(false);
		expect(bundle.violations).toHaveLength(1);
		expect(bundle.violations[0]?.kind).toBe("build");
		expect(bundle.violations[0]?.file).toBe("index.ts");
		expect(bundle.violations[0]?.message).toContain("./missing");
	});

	it("throws when the entry is missing", async () => {
		const dir = makeProvider({ "README.md": "no entry\n" });

		await expect(bundleProvider(dir)).rejects.toThrow("Provider entry not found");
	});
});
