import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * `apifuse migrate`: the one provider-facing entry point for the ast-grep
 * codemods under `scripts/codemods/`. Each YAML is the single source of its
 * rewrite and of the step it leaves to the author (its header). This module
 * only orders them, runs them against a provider checkout, and turns the
 * ast-grep findings into one summary: files changed per codemod, and the
 * residues (a finding without a fix, or a fix that did not apply) with
 * file:line and the message the rule carries.
 */

export type CodemodId =
	| "errors-factory"
	| "health-refs"
	| "handles"
	| "runtime-boundary-allow-comments"
	| "schema";

export type CodemodManifest = {
	readonly id: CodemodId;
	readonly file: `${CodemodId}.yml`;
	/** One line: what the author still does by hand after this codemod ran. The YAML header has the detail. */
	readonly manualStep: string;
};

/**
 * Dependency order. `errors-factory` first: it turns the `errorCodes` table
 * into the `defineErrors` map that `health-refs` references as `errors.<CODE>`,
 * so a health scenario rewritten after it points at a name that exists. The
 * others touch disjoint syntax (handle options, allow comments, schema
 * descriptions) and run after so their diagnostics are reported against the
 * migrated error sites.
 */
export const CODEMODS: readonly CodemodManifest[] = [
	{
		id: "errors-factory",
		file: "errors-factory.yml",
		manualStep:
			'import { defineErrors, sdkErrors } from "@apifuse/provider-sdk/provider" where a table became a map; import the map where errors.X is thrown or listed; tsc names the category a provider row still lacks',
	},
	{
		id: "health-refs",
		file: "health-refs.yml",
		manualStep:
			"declare `errors` once in the scenario module (errorRefs(<operation>ErrorCodes) or the defineErrors map); move a per-call staleIfErrorMs to defineOperation({ cache: { staleIfErrorMs } }) and delete the per-call option",
	},
	{
		id: "handles",
		file: "handles.yml",
		manualStep:
			"refresh contract snapshots that pinned the old issuer wording; `legacy-handle-declaration` must be 0 in apifuse check",
	},
	{
		id: "runtime-boundary-allow-comments",
		file: "runtime-boundary-allow-comments.yml",
		manualStep:
			"fix what the removed comment acknowledged: the build-time boundary (apifuse check) names the file:line",
	},
	{
		id: "schema",
		file: "schema.yml",
		manualStep:
			'add each `schema.<name>` key with the prose the note quotes to locales/en.json (and ko.json, ja.json where present); wrap a reported non-property .describe() as describeKey(<schema>, "<key>")',
	},
];

export const CODEMOD_IDS: readonly CodemodId[] = CODEMODS.map((codemod) => codemod.id);

export const CODEMODS_DIR = resolve(import.meta.dir, "../../scripts/codemods");

export function isCodemodId(value: string): value is CodemodId {
	return (CODEMOD_IDS as readonly string[]).includes(value);
}

export type MigrateResidue = {
	readonly codemod: CodemodId;
	readonly ruleId: string;
	/** Relative to the provider root. */
	readonly file: string;
	/** 1-based. */
	readonly line: number;
	/** 1-based. */
	readonly column: number;
	readonly message: string;
	readonly note?: string;
};

export type CodemodResult = {
	readonly id: CodemodId;
	readonly manualStep: string;
	/** Files with at least one rewrite (applied, or pending under --dry-run), relative to the provider root. */
	readonly filesChanged: readonly string[];
	/** Rewrites applied (or pending under --dry-run). */
	readonly rewrites: number;
	/** Rewrites whose rule carries a message: what the rewrite moved out of the file (a quoted prose, a dropped option). Not residues. */
	readonly notes: readonly MigrateResidue[];
	readonly residues: readonly MigrateResidue[];
};

export type MigrateReport = {
	readonly providerRoot: string;
	readonly dryRun: boolean;
	readonly astGrep: string;
	readonly codemods: readonly CodemodResult[];
	/** True when no rewrite is pending and no residue remains: exit 0. */
	readonly clean: boolean;
};

export type MigrateOptions = {
	readonly providerRoot: string;
	readonly dryRun: boolean;
	/** Subset of codemods to run, in manifest order; every codemod when omitted. */
	readonly only?: readonly CodemodId[];
	readonly astGrep?: string;
};

export const AST_GREP_PREREQUISITE =
	"apifuse migrate needs the ast-grep binary: `bun add -d @ast-grep/cli` in the provider (resolved from node_modules/.bin), or install ast-grep on PATH.";

/**
 * The provider's own install first (`bun add -d @ast-grep/cli`), then the SDK
 * checkout's (a developer running the SDK repo), then PATH. Undefined when none.
 */
export function resolveAstGrep(providerRoot: string): string | undefined {
	const candidates = [
		join(providerRoot, "node_modules", ".bin", "ast-grep"),
		resolve(import.meta.dir, "../../node_modules/.bin/ast-grep"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return Bun.which("ast-grep") ?? undefined;
}

export async function runMigrate(options: MigrateOptions): Promise<MigrateReport> {
	const providerRoot = resolve(options.providerRoot);
	const astGrep = options.astGrep ?? resolveAstGrep(providerRoot);
	if (astGrep === undefined) {
		throw new Error(AST_GREP_PREREQUISITE);
	}

	const selected =
		options.only === undefined
			? CODEMODS
			: CODEMODS.filter((codemod) => options.only?.includes(codemod.id));

	const codemods: CodemodResult[] = [];
	for (const codemod of selected) {
		const ruleFile = join(CODEMODS_DIR, codemod.file);
		const before = await scan(astGrep, providerRoot, ruleFile);
		const fixable = before.filter((finding) => finding.replacement !== undefined);
		// A finding without a fix is the codemod naming the step it leaves to
		// the author; it is a residue whether or not the rewrites are applied.
		let residues = before
			.filter((finding) => finding.replacement === undefined)
			.map((finding) => toResidue(codemod.id, finding));

		if (!options.dryRun && fixable.length > 0) {
			await applyFixes(astGrep, providerRoot, ruleFile);
			// After the rewrites the rule reports what is still there: a residue
			// at its new line, or a rewrite that could not apply (overlapping
			// fixes). A residue whose anchor was rewritten away (a conflicting
			// row inside a table that became a map) keeps its pre-apply line.
			const after = await scan(astGrep, providerRoot, ruleFile).then((findings) =>
				findings.map((finding) => toResidue(codemod.id, finding)),
			);
			const reportedAfter = new Set(after.map(residueScope));
			residues = [
				...residues.filter((residue) => !reportedAfter.has(residueScope(residue))),
				...after,
			];
		}

		codemods.push({
			id: codemod.id,
			manualStep: codemod.manualStep,
			filesChanged: [...new Set(fixable.map((finding) => finding.file))].sort(),
			rewrites: fixable.length,
			notes: fixable
				.filter((finding) => finding.message !== "")
				.map((finding) => toResidue(codemod.id, finding))
				.sort(byPosition),
			residues: residues.sort(byPosition),
		});
	}

	const clean = codemods.every(
		(result) => result.residues.length === 0 && (!options.dryRun || result.rewrites === 0),
	);
	return { providerRoot, dryRun: options.dryRun, astGrep, codemods, clean };
}

export function migrateExitCode(report: MigrateReport): 0 | 1 {
	return report.clean ? 0 : 1;
}

export function formatMigrateReport(report: MigrateReport): string {
	const lines: string[] = [];
	const verb = report.dryRun ? "would change" : "changed";
	lines.push(
		`${report.dryRun ? "Dry run" : "Migrated"}: ${report.providerRoot} (ast-grep: ${report.astGrep})`,
		"",
	);
	const header = ["codemod", `files ${verb}`, "rewrites", "residues"];
	const rows = report.codemods.map((result) => [
		result.id,
		String(result.filesChanged.length),
		String(result.rewrites),
		String(result.residues.length),
	]);
	const widths = header.map((cell, index) =>
		Math.max(cell.length, ...rows.map((row) => row[index]?.length ?? 0)),
	);
	const renderRow = (row: readonly string[]): string =>
		row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ");
	lines.push(renderRow(header), renderRow(widths.map((width) => "-".repeat(width))));
	for (const row of rows) lines.push(renderRow(row));

	for (const result of report.codemods) {
		if (result.filesChanged.length === 0 && result.residues.length === 0) continue;
		lines.push("", `${result.id}:`);
		if (result.filesChanged.length > 0) {
			lines.push(`  files ${verb}:`);
			for (const file of result.filesChanged) lines.push(`    ${file}`);
			lines.push(`  by hand: ${result.manualStep}`);
			for (const note of result.notes) {
				lines.push(`    ${note.file}:${note.line}:${note.column} ${note.message}`);
			}
		}
		if (result.residues.length > 0) {
			lines.push("  residues:");
			for (const residue of result.residues) {
				lines.push(`    ${residue.file}:${residue.line}:${residue.column} [${residue.ruleId}]`);
				lines.push(`      ${residue.message}`);
				if (residue.note !== undefined) lines.push(`      ${residue.note}`);
			}
		}
	}

	lines.push(
		"",
		report.clean
			? "Nothing left to migrate."
			: report.dryRun
				? "Rewrites pending or residues remain; run without --dry-run to apply the rewrites."
				: "Residues remain; each names the step the codemod leaves to you.",
	);
	return lines.join("\n");
}

type AstGrepFinding = {
	readonly ruleId: string;
	readonly file: string;
	readonly range: { readonly start: { readonly line: number; readonly column: number } };
	readonly message: string;
	readonly note: string | null;
	readonly replacement?: string;
};

const SCAN_GLOBS = ["--globs", "!node_modules/**", "--globs", "!dist/**", "--globs", "!.git/**"];

async function scan(
	astGrep: string,
	providerRoot: string,
	ruleFile: string,
): Promise<AstGrepFinding[]> {
	const { stdout, stderr, code } = await run(
		astGrep,
		["scan", "--rule", ruleFile, "--json=compact", ...SCAN_GLOBS, "."],
		providerRoot,
	);
	// `scan` exits 1 when an error-severity rule matched; the JSON is still
	// the whole result, so the exit code alone is not a failure.
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
	} catch {
		throw new Error(
			`ast-grep scan failed for ${relative(CODEMODS_DIR, ruleFile)} (exit ${code}): ${stderr.trim() || stdout.trim()}`,
		);
	}
	if (!Array.isArray(parsed)) {
		throw new Error(
			`ast-grep scan returned no finding list for ${relative(CODEMODS_DIR, ruleFile)}`,
		);
	}
	return parsed as AstGrepFinding[];
}

async function applyFixes(astGrep: string, providerRoot: string, ruleFile: string): Promise<void> {
	const { stderr, code } = await run(
		astGrep,
		["scan", "--rule", ruleFile, "--update-all", ...SCAN_GLOBS, "."],
		providerRoot,
	);
	if (code !== 0 && code !== 1) {
		throw new Error(
			`ast-grep --update-all failed for ${relative(CODEMODS_DIR, ruleFile)} (exit ${code}): ${stderr.trim()}`,
		);
	}
}

function run(
	binary: string,
	args: readonly string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				code: code ?? 1,
			});
		});
	});
}

function toResidue(codemod: CodemodId, finding: AstGrepFinding): MigrateResidue {
	return {
		codemod,
		ruleId: finding.ruleId,
		file: finding.file,
		line: finding.range.start.line + 1,
		column: finding.range.start.column + 1,
		message: finding.message,
		...(finding.note === null || finding.note === undefined ? {} : { note: finding.note }),
	};
}

function byPosition(a: MigrateResidue, b: MigrateResidue): number {
	return (
		a.file.localeCompare(b.file) ||
		a.line - b.line ||
		a.column - b.column ||
		a.ruleId.localeCompare(b.ruleId)
	);
}

function residueScope(residue: MigrateResidue): string {
	return `${residue.ruleId}\0${residue.file}`;
}
