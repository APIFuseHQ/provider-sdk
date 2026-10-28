/**
 * One-release compatibility shims for the retired source-grep runtime
 * boundary (`process-env-direct-read`, `node-runtime-module-import`,
 * `direct-fetch-call`). The boundary is now judged at build time by
 * `bundleProvider` (`src/cli/bundle.ts`); these entry points keep the old
 * signatures and the old contract working for one release: the given sources
 * are materialised into a temporary directory, every file the old scope
 * filter kept is a graph root, the graph is judged with `bundleSourceSet`,
 * and each `BoundaryViolation` is mapped to the old diagnostic shape (`field:
 * "sourceFiles.<file>"`, the nearest old rule id, lines in the message), with
 * `// @apifuse-allow <rule>` acknowledgements reported as `information`.
 *
 * Everything in this module is removed in the next major.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BoundaryViolation, ProviderBundle } from "./cli/bundle.js";
import type { LintDiagnostic, ProviderLintInformation, ProviderLintMode, ProviderLintResult } from "./lint.js";
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

/** Root-relative file that imports every root; written into the temporary directory. */
const ROOTS_FILE = ".apifuse-runtime-boundary-roots.ts";
const ENV_OBJECT_PATHS: ReadonlySet<string> = new Set(["process.env", "import.meta.env", "Bun.env"]);
const GLOBAL_OBJECT_ALIAS_PATTERN = /^(?:globalThis|global|self)\./;

// The scope the retired rules judged: runtime source minus tests, recorded
// fixtures, declarations, the root bootstrap files and operator tooling.
const BOOTSTRAP_ENTRYPOINT_FILE_PATTERN = /^(?:dev|start|deploy)\.[cm]?[jt]sx?$/;
const TOOLING_DIRECTORY_PATTERN = /^(?:scripts|tools|bin)\//;
const TEST_SOURCE_FILE_PATTERN = /(?:^|\/)(?:__tests__|__mocks__|tests)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const RECORDED_FIXTURE_SOURCE_FILE_PATTERN = /(?:^|\/)__fixtures__(?:\/|$)|(?:^|\/)__tests__\/fixtures(?:\/|$)/;
const JAVASCRIPT_SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const DECLARATION_FILE_PATTERN = /\.d\.[cm]?ts$/;

const COMMENT_ONLY_LINE_PATTERN = /^\s*(?:\/\/|\/\*|\*)/;
const ALLOW_COMMENT_PATTERN = /@apifuse-allow\s+([a-z][a-z0-9-]*)\b(?:\s*:\s*(.*?))?\s*(?:\*\/)?\s*$/;

let warnedLintRuntimeBoundarySources = false;

function warnOnce(): void {
	if (warnedLintRuntimeBoundarySources) return;
	warnedLintRuntimeBoundarySources = true;
	console.warn(
		"[@apifuse/provider-sdk] lintRuntimeBoundarySources is deprecated and is removed in the next major: call bundleProvider(providerRoot, { mode }) on the provider checkout instead.",
	);
}

function isRuntimeBoundarySourceFile(relativePath: string): boolean {
	const normalized = relativePath.replace(/^\.\//, "");
	return (
		JAVASCRIPT_SOURCE_FILE_PATTERN.test(normalized) &&
		!DECLARATION_FILE_PATTERN.test(normalized) &&
		!TEST_SOURCE_FILE_PATTERN.test(normalized) &&
		!RECORDED_FIXTURE_SOURCE_FILE_PATTERN.test(normalized) &&
		!BOOTSTRAP_ENTRYPOINT_FILE_PATTERN.test(normalized) &&
		!TOOLING_DIRECTORY_PATTERN.test(normalized)
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
	return join(here, "cli", import.meta.url.endsWith(".ts") ? "bundle-worker.ts" : "bundle-worker.js");
}

function bundleSourceSetSync(providerRoot: string, mode: ProviderLintMode): ProviderBundle {
	if (typeof Bun === "undefined") {
		throw new Error(
			"lintRuntimeBoundarySources needs the Bun runtime: the boundary is judged by bundling the provider with Bun.build.",
		);
	}
	const result = Bun.spawnSync({
		cmd: [process.execPath, workerPath(), providerRoot, mode, ROOTS_FILE],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`lintRuntimeBoundarySources: bundleSourceSet failed (exit ${result.exitCode}): ${result.stderr.toString().trim()}`,
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

/** A trailing `@apifuse-allow <rule>` on the finding line, or a comment-only line directly above it. */
function readAllowComment(source: string | undefined, line: number, rule: RuntimeBoundaryRule): string | undefined {
	if (source === undefined || line < 1) return undefined;
	const lines = source.split(/\r?\n/);
	const current = lines[line - 1];
	const previous = lines[line - 2];
	const candidates = [current, previous?.match(COMMENT_ONLY_LINE_PATTERN) ? previous : undefined];
	for (const candidate of candidates) {
		if (candidate === undefined) continue;
		const match = ALLOW_COMMENT_PATTERN.exec(candidate);
		if (match && match[1] === rule) return match[2]?.trim() || "(no reason given)";
	}
	return undefined;
}

function legacyResult(files: Record<string, string>, violations: readonly BoundaryViolation[]): ProviderLintResult {
	const groups = new Map<string, { file: string; rule: RuntimeBoundaryRule; items: BoundaryViolation[] }>();
	const information: ProviderLintInformation[] = [];
	for (const violation of violations) {
		const rule = legacyRule(violation);
		const reason = readAllowComment(files[violation.file], violation.line, rule);
		if (reason !== undefined) {
			information.push({
				rule,
				field: `sourceFiles.${violation.file}`,
				message: `Acknowledged ${violation.subject} at line ${violation.line}. Reason: ${reason}`,
			});
			continue;
		}
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
	return { diagnostics, information };
}

/**
 * Lint provider runtime sources for the runtime boundary without a provider
 * checkout: `files` maps provider-root-relative paths to source text.
 *
 * @deprecated The boundary is judged at build time. Call
 * `bundleProvider(providerRoot, { mode })` on the provider checkout and read
 * its `BoundaryViolation`s (file, line, column, subject). This shim writes
 * `files` to a temporary directory, roots the module graph at every supplied
 * file the retired rules judged (not tests, recorded fixtures, `.d.ts`, the
 * root `dev.ts`/`start.ts`/`deploy.ts`, `scripts/`, `tools/`, `bin/`), loads
 * a relative import the set lacks as an empty module, keeps an unused value
 * import as a reach, and maps each violation to the old diagnostic shape
 * (`field: "sourceFiles.<file>"`, nearest old rule id, lines in the message).
 * `// @apifuse-allow <rule>: <reason>` on the finding line or the line above
 * still moves a finding to `information` here; `apifuse check` has no such
 * acknowledgement. `options.typescript` is ignored. Removed in the next major.
 */
export function lintRuntimeBoundarySources(
	files: Record<string, string>,
	options: LintRuntimeBoundarySourcesOptions = {},
): ProviderLintResult {
	void options;
	warnOnce();
	for (const path of Object.keys(files)) assertMaterialisablePath(path);
	const roots = Object.keys(files).filter(isRuntimeBoundarySourceFile);
	if (roots.length === 0) return { diagnostics: [], information: [] };
	const root = mkdtempSync(join(tmpdir(), "apifuse-runtime-boundary-"));
	try {
		for (const [path, source] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), source);
		}
		// Namespace imports re-exported from the root keep every export of every
		// root alive; a bare side-effect import would let the bundler drop an
		// exported function nobody calls, and the reach inside it with it.
		writeFileSync(
			join(root, ROOTS_FILE),
			roots
				.map((path, index) => `import * as root${index} from "./${path}";\nexport { root${index} };\n`)
				.join(""),
		);
		const bundle = bundleSourceSetSync(root, "official");
		return legacyResult(
			files,
			bundle.violations.filter((violation) => violation.file !== ROOTS_FILE),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
