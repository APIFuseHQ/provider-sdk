/**
 * One-release compatibility shims for the retired source-grep runtime
 * boundary (`process-env-direct-read`, `node-runtime-module-import`,
 * `direct-fetch-call`). The boundary is now judged at build time by
 * `bundleProvider` (`src/cli/bundle.ts`); these entry points keep the old
 * signatures working for one release by materialising the given sources into a
 * temporary provider checkout, running `bundleProvider` on it, and mapping each
 * `BoundaryViolation` to the old diagnostic shape (`field:
 * "sourceFiles.<file>"`, the nearest old rule id, lines in the message).
 *
 * Everything in this module is removed in the next major.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BoundaryViolation, ProviderBundle } from "./cli/bundle.js";
import type { LintDiagnostic, ProviderLintMode, ProviderLintResult } from "./lint.js";
import type { TypeScriptCompilerModuleLike } from "./typescript-module.js";

/** @deprecated The boundary is judged by `bundleProvider`; rule ids are gone with the next major. */
export const PROCESS_ENV_DIRECT_READ_RULE = "process-env-direct-read";
/** @deprecated The boundary is judged by `bundleProvider`; rule ids are gone with the next major. */
export const NODE_RUNTIME_MODULE_IMPORT_RULE = "node-runtime-module-import";
/** @deprecated The boundary is judged by `bundleProvider`; rule ids are gone with the next major. */
export const DIRECT_FETCH_CALL_RULE = "direct-fetch-call";

/**
 * @deprecated The runtime boundary is judged by `bundleProvider(providerRoot, { mode })`,
 * which reports `BoundaryViolation`s instead of rule ids. Removed in the next major.
 */
export const RUNTIME_BOUNDARY_RULES = [
	PROCESS_ENV_DIRECT_READ_RULE,
	NODE_RUNTIME_MODULE_IMPORT_RULE,
	DIRECT_FETCH_CALL_RULE,
] as const;

/** @deprecated See `RUNTIME_BOUNDARY_RULES`; use `BoundaryViolationKind` from `bundleProvider`. Removed in the next major. */
export type RuntimeBoundaryRule = (typeof RUNTIME_BOUNDARY_RULES)[number];

/**
 * @deprecated `lintRuntimeBoundarySources` no longer parses source itself; `typescript` is
 * accepted and ignored. Use `bundleProvider(providerRoot, { mode })`. Removed in the next major.
 */
export type LintRuntimeBoundarySourcesOptions = {
	typescript?: TypeScriptCompilerModuleLike;
};

const PROVIDER_ENTRY_FILE = "index.ts";
const ENV_OBJECT_PATHS: ReadonlySet<string> = new Set(["process.env", "import.meta.env", "Bun.env"]);
const GLOBAL_OBJECT_ALIAS_PATTERN = /^(?:globalThis|global|self)\./;

let warnedLintRuntimeBoundarySources = false;

function warnOnce(): void {
	if (warnedLintRuntimeBoundarySources) return;
	warnedLintRuntimeBoundarySources = true;
	console.warn(
		"[@apifuse/provider-sdk] lintRuntimeBoundarySources is deprecated and is removed in the next major: call bundleProvider(providerRoot, { mode }) on the provider checkout instead.",
	);
}

function assertMaterialisablePath(path: string): void {
	if (
		isAbsolute(path) ||
		path.includes("\\") ||
		path.split("/").some((segment) => segment === ".." || segment === "")
	) {
		throw new TypeError(
			`lintRuntimeBoundarySources: "${path}" is not a provider-root-relative file path.`,
		);
	}
}

function workerPath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const source = join(here, "cli", "bundle-worker.ts");
	return existsSync(source) ? source : join(here, "cli", "bundle-worker.js");
}

function bundleProviderSync(providerRoot: string, mode: ProviderLintMode): ProviderBundle {
	if (typeof Bun === "undefined") {
		throw new Error(
			"lintRuntimeBoundarySources needs the Bun runtime: the boundary is judged by bundling the provider with Bun.build.",
		);
	}
	const result = Bun.spawnSync({
		cmd: [process.execPath, workerPath(), providerRoot, mode],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`lintRuntimeBoundarySources: bundleProvider failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`,
		);
	}
	return JSON.parse(result.stdout.toString()) as ProviderBundle;
}

/** The old rule id nearest to what a build-time violation reports. */
function legacyRule(violation: BoundaryViolation): RuntimeBoundaryRule {
	if (violation.kind !== "global") return NODE_RUNTIME_MODULE_IMPORT_RULE;
	let subject = violation.subject;
	while (GLOBAL_OBJECT_ALIAS_PATTERN.test(subject)) subject = subject.replace(GLOBAL_OBJECT_ALIAS_PATTERN, "");
	const segments = subject.split(".");
	const envObject = segments.slice(0, 2).join(".");
	const metaEnvObject = segments.slice(0, 3).join(".");
	if (ENV_OBJECT_PATHS.has(envObject) || ENV_OBJECT_PATHS.has(metaEnvObject)) return PROCESS_ENV_DIRECT_READ_RULE;
	if (segments[0] === "fetch" || segments[0] === "WebSocket") return DIRECT_FETCH_CALL_RULE;
	return NODE_RUNTIME_MODULE_IMPORT_RULE;
}

function legacyDiagnostics(violations: readonly BoundaryViolation[]): LintDiagnostic[] {
	const groups = new Map<string, { file: string; rule: RuntimeBoundaryRule; items: BoundaryViolation[] }>();
	for (const violation of violations) {
		const rule = legacyRule(violation);
		const key = `${violation.file}\u0000${rule}`;
		const group = groups.get(key) ?? { file: violation.file, rule, items: [] };
		group.items.push(violation);
		groups.set(key, group);
	}
	const diagnostics: LintDiagnostic[] = [];
	for (const { file, rule, items } of groups.values()) {
		const linesBySubject = new Map<string, number[]>();
		for (const item of items) {
			linesBySubject.set(item.subject, [...(linesBySubject.get(item.subject) ?? []), item.line]);
		}
		const subjects = [...linesBySubject.entries()]
			.map(([subject, lines]) => `${subject} (line ${lines.join(", ")})`)
			.join(", ");
		const first = items[0] as BoundaryViolation;
		diagnostics.push({
			rule,
			level: items.some((item) => item.level === "error") ? "error" : "warn",
			field: `sourceFiles.${file}`,
			message: `${subjects}: ${first.message}`,
		});
	}
	return diagnostics;
}

/**
 * Lint provider runtime sources for the runtime boundary without a provider
 * checkout: `files` maps provider-root-relative paths to source text.
 *
 * @deprecated The boundary is judged at build time. Call
 * `bundleProvider(providerRoot, { mode })` on the provider checkout and read
 * its `BoundaryViolation`s (file, line, column, subject). This shim writes
 * `files` to a temporary directory, runs `bundleProvider` on it (graph rooted
 * at `index.ts` and `start.ts`; with no `index.ts` nothing is judged) and maps
 * each violation to the old diagnostic shape (`field: "sourceFiles.<file>"`,
 * nearest old rule id, lines in the message). There is no `@apifuse-allow`
 * acknowledgement, so `information` is always empty. `options.typescript` is
 * ignored. Removed in the next major.
 */
export function lintRuntimeBoundarySources(
	files: Record<string, string>,
	options: LintRuntimeBoundarySourcesOptions = {},
): ProviderLintResult {
	void options;
	warnOnce();
	for (const path of Object.keys(files)) assertMaterialisablePath(path);
	if (!Object.hasOwn(files, PROVIDER_ENTRY_FILE)) return { diagnostics: [], information: [] };
	const root = mkdtempSync(join(tmpdir(), "apifuse-runtime-boundary-"));
	try {
		for (const [path, source] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), source);
		}
		const bundle = bundleProviderSync(root, "official");
		return { diagnostics: legacyDiagnostics(bundle.violations), information: [] };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
