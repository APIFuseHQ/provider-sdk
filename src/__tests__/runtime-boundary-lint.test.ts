import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { lintProvider, lintProviderWithInformation } from "../lint.js";
import {
	DIRECT_FETCH_CALL_RULE,
	isRuntimeBoundarySourceFile,
	NODE_RUNTIME_MODULE_IMPORT_RULE,
	PROCESS_ENV_DIRECT_READ_RULE,
	RUNTIME_BOUNDARY_RULES,
} from "../runtime-boundary-lint.js";
import type { OperationRiskClass } from "../types.js";

const READ_RISK_CLASS: OperationRiskClass = "read";
const RUNTIME_BOUNDARY_RULE_SET: ReadonlySet<string> = new Set(RUNTIME_BOUNDARY_RULES);

function providerWithFiles(providerSourceFiles: Record<string, string>) {
	return {
		id: "demo-provider",
		allowedHosts: ["api.example.com"],
		reviewed: "first-party" as const,
		providerSourceFiles,
		operations: {
			search: {
				riskClass: READ_RISK_CLASS,
				descriptionKey: "operations.search.description",
				input: z.object({ query: z.string() }),
				output: z.object({ ok: z.boolean() }),
				fixtures: { request: { query: "desk" }, response: { ok: true } },
				handler: async () => ({ ok: true }),
			},
		},
	};
}

function boundaryDiagnostics(providerSourceFiles: Record<string, string>) {
	return lintProvider(providerWithFiles(providerSourceFiles)).filter((diagnostic) =>
		RUNTIME_BOUNDARY_RULE_SET.has(diagnostic.rule),
	);
}

describe("runtime boundary lint: scope", () => {
	it("looks at runtime source only", () => {
		expect(isRuntimeBoundarySourceFile("index.ts")).toBe(true);
		expect(isRuntimeBoundarySourceFile("operations/search.ts")).toBe(true);
		expect(isRuntimeBoundarySourceFile("upstream/client.mjs")).toBe(true);
		expect(isRuntimeBoundarySourceFile("lib/runtime-port.ts")).toBe(true);
		// Bootstrap entrypoints call serve()/startDevServer() before a context exists.
		expect(isRuntimeBoundarySourceFile("dev.ts")).toBe(false);
		expect(isRuntimeBoundarySourceFile("start.ts")).toBe(false);
		expect(isRuntimeBoundarySourceFile("deploy.ts")).toBe(false);
		// Operator tooling is run by humans, not by the pod.
		expect(isRuntimeBoundarySourceFile("scripts/record-fixtures.ts")).toBe(false);
		expect(isRuntimeBoundarySourceFile("tools/build-har-evidence.ts")).toBe(false);
		expect(isRuntimeBoundarySourceFile("bin/smoke.ts")).toBe(false);
		// Tests, fixtures, declarations, and non-JavaScript files are out of scope.
		expect(isRuntimeBoundarySourceFile("__tests__/upstream-doubles.ts")).toBe(false);
		expect(isRuntimeBoundarySourceFile("index.test.ts")).toBe(false);
		expect(isRuntimeBoundarySourceFile("upstream/__fixtures__/page.ts")).toBe(false);
		expect(isRuntimeBoundarySourceFile("types.d.ts")).toBe(false);
		expect(isRuntimeBoundarySourceFile("Dockerfile")).toBe(false);
		expect(isRuntimeBoundarySourceFile("scripts/start.sh")).toBe(false);
		// Nested directories with the tooling names are still runtime source.
		expect(isRuntimeBoundarySourceFile("upstream/scripts/parse.ts")).toBe(true);
	});

	it("does not report bootstrap and tooling files at all", () => {
		const diagnostics = boundaryDiagnostics({
			"dev.ts":
				'import { readFileSync } from "node:fs"; startDevServer(provider, { port: Number(process.env.PORT) });',
			"start.ts": "await serve(provider, { port: Number(process.env.APIFUSE__RUNTIME__PORT) });",
			"deploy.ts": 'export default { image: process.env.IMAGE_TAG, spawn: Bun.spawn(["true"]) };',
			"scripts/record-fixtures.ts":
				'import { writeFileSync } from "node:fs"; const key = process.env.API_KEY; await fetch("https://api.example.com");',
			"index.test.ts": "process.env.APIFUSE__E2E__FAKE_LOGIN = '1'; await fetch('x');",
		});
		expect(diagnostics).toEqual([]);
	});
});

describe(`runtime boundary lint: ${PROCESS_ENV_DIRECT_READ_RULE}`, () => {
	it("warns once per file listing every read, with the env name and line", () => {
		const diagnostics = boundaryDiagnostics({
			"index.ts": [
				"export function fakeLogin() {",
				'  return process.env.APIFUSE__E2E__FAKE_LOGIN === "1";',
				"}",
				'const token = process.env["TRIPLE_FIREBASE_API_KEY"];',
				"const all = { ...process.env };",
				"const dyn = process.env[name];",
				"const viaBun = Bun.env.KAKAOTALK_DEBUG;",
				"const viaGlobal = globalThis.process.env.SOMETHING;",
			].join("\n"),
		});
		expect(diagnostics).toHaveLength(1);
		const [diagnostic] = diagnostics;
		expect(diagnostic).toMatchObject({
			rule: PROCESS_ENV_DIRECT_READ_RULE,
			level: "warn",
			field: "sourceFiles.index.ts",
		});
		expect(diagnostic?.message).toContain("process.env.APIFUSE__E2E__FAKE_LOGIN (line 2)");
		expect(diagnostic?.message).toContain("process.env.TRIPLE_FIREBASE_API_KEY (line 4)");
		expect(diagnostic?.message).toContain("process.env (line 5, 6)");
		expect(diagnostic?.message).toContain("Bun.env.KAKAOTALK_DEBUG (line 7)");
		expect(diagnostic?.message).toContain("process.env.SOMETHING (line 8)");
		expect(diagnostic?.message).toContain("ctx.env.get(");
		expect(diagnostic?.message).toContain(`@apifuse-allow ${PROCESS_ENV_DIRECT_READ_RULE}`);
	});

	it("exempts the APIFUSE__RUNTIME__* bootstrap family wherever it is read", () => {
		const diagnostics = boundaryDiagnostics({
			"lib/runtime-port.ts": [
				"const configured = process.env.APIFUSE__RUNTIME__PORT;",
				'const podId = process.env["APIFUSE__RUNTIME__POD_ID"] ?? "local";',
				"export const endpoint = process.env.APIFUSE__RUNTIME__POD_ENDPOINT;",
				"export const port = Number(configured) || 3000;",
			].join("\n"),
		});
		expect(diagnostics).toEqual([]);
	});

	it("does not treat other objects' env members or ctx.env as process.env", () => {
		const diagnostics = boundaryDiagnostics({
			"index.ts": [
				"const key = ctx.env.get('APIFUSE__PROVIDER__DEMO__API_KEY');",
				"const options = { env: { get: (name) => undefined } };",
				"const fromOptions = options.env.get('X');",
				"const record = { process: { env: { X: 1 } } };",
				"const nested = record.process.env.X;",
			].join("\n"),
		});
		expect(diagnostics).toEqual([]);
	});

	it("reports the auth flow and operation sources when no file tree is given", () => {
		const diagnostics = lintProvider({
			id: "demo-provider",
			allowedHosts: ["api.example.com"],
			reviewed: "first-party",
			authFlowSource: 'async function start() { return process.env.DEMO_LOGIN_FAKE === "1"; }',
			operations: {
				search: {
					riskClass: READ_RISK_CLASS,
					descriptionKey: "operations.search.description",
					input: z.object({ query: z.string() }),
					output: z.object({ ok: z.boolean() }),
					fixtures: { request: { query: "desk" }, response: { ok: true } },
					source: "async function handler(ctx) { return { ok: !!process.env.DEMO_FLAG }; }",
				},
			},
		}).filter((diagnostic) => diagnostic.rule === PROCESS_ENV_DIRECT_READ_RULE);
		expect(diagnostics.map((diagnostic) => diagnostic.field).sort()).toEqual([
			"auth.flow",
			"operations.search.handler",
		]);
	});
});

describe(`runtime boundary lint: ${NODE_RUNTIME_MODULE_IMPORT_RULE}`, () => {
	it("warns on value imports of fs, net, child_process and the http family in every import shape", () => {
		const diagnostics = boundaryDiagnostics({
			"upstream/booking.ts": [
				'import { mkdir, writeFile } from "node:fs/promises";',
				'import { createServer } from "net";',
				'import * as cp from "node:child_process";',
				'import https from "https";',
				'export { request } from "node:http2";',
				'const tls = require("node:tls");',
				'const dgram = await import("dgram");',
				'import path from "node:path";',
				'import { createHash } from "node:crypto";',
			].join("\n"),
		});
		expect(diagnostics).toHaveLength(1);
		const message = diagnostics[0]?.message ?? "";
		for (const specifier of [
			"node:fs/promises (line 1)",
			"net (line 2)",
			"node:child_process (line 3)",
			"https (line 4)",
			"node:http2 (line 5)",
			"node:tls (line 6)",
			"dgram (line 7)",
		]) {
			expect(message).toContain(specifier);
		}
		expect(message).not.toContain("node:path");
		expect(message).not.toContain("node:crypto");
		expect(diagnostics[0]).toMatchObject({
			rule: NODE_RUNTIME_MODULE_IMPORT_RULE,
			level: "warn",
			field: "sourceFiles.upstream/booking.ts",
		});
	});

	it("ignores imports and re-exports that are erased as type-only", () => {
		const diagnostics = boundaryDiagnostics({
			"protocol/types.ts": [
				'import type { Socket } from "node:net";',
				'import { type ChildProcess, type SpawnOptions } from "node:child_process";',
				'export type { Stats } from "node:fs";',
				'export { type Dirent } from "node:fs/promises";',
			].join("\n"),
		});
		expect(diagnostics).toEqual([]);
	});

	it("still reports an import that keeps a value binding next to inline types", () => {
		const diagnostics = boundaryDiagnostics({
			"upstream/io.ts": [
				'import { type ChildProcess, spawn } from "node:child_process";',
				'import fs, { type Stats } from "node:fs";',
				'import * as net from "node:net";',
				'import "node:tls";',
				'export * from "node:dgram";',
				'export { request, type IncomingMessage } from "node:http";',
			].join("\n"),
		});
		expect(diagnostics).toHaveLength(1);
		const message = diagnostics[0]?.message ?? "";
		for (const specifier of [
			"node:child_process (line 1)",
			"node:fs (line 2)",
			"node:net (line 3)",
			"node:tls (line 4)",
			"node:dgram (line 5)",
			"node:http (line 6)",
		]) {
			expect(message).toContain(specifier);
		}
	});

	it("warns on the Bun process and file equivalents", () => {
		const diagnostics = boundaryDiagnostics({
			"index.ts": [
				'const proc = Bun.spawn(["ffmpeg", "-i", inputPath]);',
				"await Bun.write(outputPath, bytes);",
				"const artifact = await Bun.file(AREA_DIRECTORY_ARTIFACT_PATH).json();",
				"const out = await Bun.$`ls`.text();",
				"const hash = Bun.hash(bytes);",
				"const ok = Bun.deepEquals(a, b);",
			].join("\n"),
		});
		expect(diagnostics).toHaveLength(1);
		const message = diagnostics[0]?.message ?? "";
		expect(message).toContain("Bun.spawn() (line 1)");
		expect(message).toContain("Bun.write() (line 2)");
		expect(message).toContain("Bun.file() (line 3)");
		expect(message).toContain("Bun.$`` (line 4)");
		expect(message).not.toContain("Bun.hash");
		expect(message).not.toContain("Bun.deepEquals");
	});
});

describe(`runtime boundary lint: ${DIRECT_FETCH_CALL_RULE}`, () => {
	it("warns on the global fetch and its globalThis/window forms", () => {
		const diagnostics = boundaryDiagnostics({
			"auth.ts": [
				"export async function fetchIdentity(input, init) {",
				"  return await fetch(input, init);",
				"}",
				"const viaGlobal = await globalThis.fetch(url);",
				'const viaWindow = await window["fetch"](url);',
			].join("\n"),
		});
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			rule: DIRECT_FETCH_CALL_RULE,
			level: "warn",
			field: "sourceFiles.auth.ts",
		});
		expect(diagnostics[0]?.message).toContain("fetch() (line 2)");
		expect(diagnostics[0]?.message).toContain("globalThis.fetch() (line 4, 5)");
		expect(diagnostics[0]?.message).toContain("ctx.http");
	});

	it("leaves SDK transports and shadowed fetch bindings alone", () => {
		const diagnostics = boundaryDiagnostics({
			"upstream/client.ts": [
				"const page = await ctx.stealth.fetch(url, { stealth: { requestClass: 'xhr' } });",
				"const data = await ctx.http.get('/v1/items');",
				"const fetchIdentity = (input) => input;",
				"await fetchIdentity(url);",
			].join("\n"),
			"upstream/injected.ts": [
				"export function withTransport(fetch: typeof globalThis.fetch) {",
				"  return fetch('https://api.example.com');",
				"}",
				"export const bound = (fetch) => fetch('https://api.example.com');",
				"export const named = function fetch(url) { return fetch(url); };",
				"export function hoisted() { if (flag) { var fetch = shim; } return fetch('/v'); }",
				"try { run(); } catch (fetch) { fetch('/z'); }",
				"for (const fetch of transports) fetch('/y');",
				"{ const fetch = ctx.stealth.fetch; await fetch('/x'); }",
			].join("\n"),
			"upstream/aliased.ts": [
				'import { fetch } from "undici";',
				"export const load = () => fetch('https://api.example.com');",
			].join("\n"),
			"upstream/destructured.ts": [
				"const { fetch } = createTransport();",
				"export const load = () => fetch('https://api.example.com');",
			].join("\n"),
		});
		expect(diagnostics).toEqual([]);
	});

	it("still reports a global fetch when another scope in the same file declares its own", () => {
		const diagnostics = boundaryDiagnostics({
			"upstream/session.ts": [
				"export function withTransport(fetch: typeof globalThis.fetch) {",
				"  return fetch('https://api.example.com/probe');",
				"}",
				"function helper() { const fetch = 1; return fetch; }",
				"export async function login(url: string, password: string) {",
				"  return await fetch(url, { method: 'POST', body: password });",
				"}",
				"{ const fetch = ctx.stealth.fetch; await fetch('/x'); }",
				"await fetch('https://api.example.com/after-block');",
				"const { fetch: aliased } = createTransport();",
				"await aliased('/aliased'); await fetch('https://api.example.com/last');",
				"// A body `var` is not visible from a parameter initializer.",
				"function load(result = fetch('https://api.example.com/default')) { var fetch = transport; return result; }",
			].join("\n"),
		});
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			rule: DIRECT_FETCH_CALL_RULE,
			field: "sourceFiles.upstream/session.ts",
		});
		expect(diagnostics[0]?.message).toContain("fetch() (line 6, 9, 11, 13)");
	});
});

describe("runtime boundary lint: parsing", () => {
	it("parses .ts as TypeScript so a generic arrow or angle-bracket assertion does not hide the rest of the file", () => {
		const diagnostics = boundaryDiagnostics({
			"upstream/generic.ts": [
				"const identity = <T>(value: T): T => value;",
				"const count = <number>identity(1);",
				"const key = process.env.REAL_SECRET;",
				"const res = await fetch('https://api.example.com');",
				'import { readFileSync } from "node:fs";',
			].join("\n"),
		});
		expect(diagnostics.map((diagnostic) => diagnostic.rule).sort()).toEqual(
			[...RUNTIME_BOUNDARY_RULES].sort(),
		);
		const messages = diagnostics.map((diagnostic) => diagnostic.message).join("\n");
		expect(messages).toContain("process.env.REAL_SECRET (line 3)");
		expect(messages).toContain("fetch() (line 4)");
		expect(messages).toContain("node:fs (line 5)");
	});

	it("parses .tsx with JSX", () => {
		const diagnostics = boundaryDiagnostics({
			"ui/widget.tsx": [
				"export const Widget = () => <div>{process.env.PUBLIC_LABEL}</div>;",
				"export const load = () => fetch('https://api.example.com');",
			].join("\n"),
		});
		expect(diagnostics.map((diagnostic) => diagnostic.rule).sort()).toEqual(
			[DIRECT_FETCH_CALL_RULE, PROCESS_ENV_DIRECT_READ_RULE].sort(),
		);
		const messages = diagnostics.map((diagnostic) => diagnostic.message).join("\n");
		expect(messages).toContain("process.env.PUBLIC_LABEL (line 1)");
		expect(messages).toContain("fetch() (line 2)");
	});
});

describe("runtime boundary lint: @apifuse-allow acknowledgement", () => {
	it("moves an acknowledged finding from diagnostics to information with its reason", () => {
		const result = lintProviderWithInformation(
			providerWithFiles({
				"index.ts": [
					`// @apifuse-allow ${PROCESS_ENV_DIRECT_READ_RULE}: e2e fake-login switch, removed with #999`,
					'const fake = process.env.APIFUSE__E2E__FAKE_LOGIN === "1";',
					`const tap = process.env.TABELOG_DIAG_TAP_DIR; // @apifuse-allow ${PROCESS_ENV_DIRECT_READ_RULE}: local diagnostics tap`,
					"const stillReported = process.env.OTHER_FLAG;",
					`// @apifuse-allow ${DIRECT_FETCH_CALL_RULE}: wrong rule id for this line`,
					"const alsoReported = process.env.MISMATCHED_RULE;",
				].join("\n"),
			}),
		);
		const diagnostics = result.diagnostics.filter((diagnostic) =>
			RUNTIME_BOUNDARY_RULE_SET.has(diagnostic.rule),
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]?.message).toContain("process.env.OTHER_FLAG (line 4)");
		expect(diagnostics[0]?.message).toContain("process.env.MISMATCHED_RULE (line 6)");
		expect(diagnostics[0]?.message).not.toContain("APIFUSE__E2E__FAKE_LOGIN");
		expect(diagnostics[0]?.message).not.toContain("TABELOG_DIAG_TAP_DIR");

		const information = result.information.filter((entry) =>
			RUNTIME_BOUNDARY_RULE_SET.has(entry.rule),
		);
		expect(information).toHaveLength(2);
		expect(information[0]).toMatchObject({
			rule: PROCESS_ENV_DIRECT_READ_RULE,
			field: "sourceFiles.index.ts",
		});
		expect(information[0]?.message).toContain("APIFUSE__E2E__FAKE_LOGIN at line 2");
		expect(information[0]?.message).toContain("Reason: e2e fake-login switch, removed with #999");
		expect(information[1]?.message).toContain("TABELOG_DIAG_TAP_DIR at line 3");
		expect(information[1]?.message).toContain("Reason: local diagnostics tap");
	});

	it("keeps the acknowledgement information alongside pinned wire field information", () => {
		const result = lintProviderWithInformation({
			...providerWithFiles({
				"index.ts": `// @apifuse-allow ${DIRECT_FETCH_CALL_RULE}: probe\nawait fetch("https://api.example.com/health");`,
			}),
			meta: { contract: {} },
		});
		expect(result.diagnostics.some((d) => d.rule === DIRECT_FETCH_CALL_RULE)).toBe(false);
		expect(result.information.some((entry) => entry.rule === DIRECT_FETCH_CALL_RULE)).toBe(true);
	});
});

describe("runtime boundary lint: severity", () => {
	it("never raises an error-level diagnostic in this release", () => {
		const diagnostics = boundaryDiagnostics({
			"index.ts": [
				'import { readFileSync } from "node:fs";',
				"const key = process.env.SECRET;",
				"await fetch(url);",
			].join("\n"),
		});
		expect(diagnostics).toHaveLength(3);
		expect(diagnostics.every((diagnostic) => diagnostic.level === "warn")).toBe(true);
		expect(diagnostics.map((diagnostic) => diagnostic.rule).sort()).toEqual(
			[...RUNTIME_BOUNDARY_RULES].sort(),
		);
	});
});
