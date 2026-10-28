#!/usr/bin/env bun

/**
 * `apifuse migrate [path] [--dry-run] [--only <codemod>] [--json]`
 *
 * Runs every shipped codemod (scripts/codemods/*.yml) against a provider
 * checkout in dependency order and prints one summary: files changed per
 * codemod and the residues the codemods leave to the author, with file:line.
 *
 * Exit codes: 0 when nothing is left (no residue; under --dry-run also no
 * pending rewrite); 1 otherwise. There is no CI detection and no default
 * dry run: the command does what its flags say wherever it runs, and a CI
 * gate is `apifuse migrate --dry-run` read through its exit code.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
	CODEMOD_IDS,
	type CodemodId,
	formatMigrateReport,
	isCodemodId,
	migrateExitCode,
	runMigrate,
} from "../src/cli/migrate.js";

const HELP_TEXT = `Usage: apifuse migrate [path] [--dry-run] [--only <codemod>] [--json]

Runs the SDK's migration codemods against the provider at [path] (default: .)
in dependency order: ${CODEMOD_IDS.join(", ")}.

  --dry-run          Report what would change; write nothing.
  --only <codemod>   Run one codemod (repeatable).
  --json             Print the report as JSON.

Exit 0 when nothing is left to migrate, 1 when rewrites are pending (--dry-run)
or residues remain. Needs ast-grep: \`bun add -d @ast-grep/cli\` or on PATH.`;

export async function main(): Promise<void> {
	const args = process.argv[2] === "migrate" ? process.argv.slice(3) : process.argv.slice(2);

	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP_TEXT);
		return;
	}

	let inputPath = ".";
	let dryRun = false;
	let json = false;
	const only: CodemodId[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--json") {
			json = true;
		} else if (arg === "--only") {
			const value = args[index + 1];
			index += 1;
			if (value === undefined || !isCodemodId(value)) {
				console.error(
					`--only needs one of: ${CODEMOD_IDS.join(", ")} (got ${value === undefined ? "nothing" : JSON.stringify(value)})`,
				);
				process.exit(2);
			}
			only.push(value);
		} else if (arg.startsWith("--")) {
			console.error(`Unknown option: ${arg}\n\n${HELP_TEXT}`);
			process.exit(2);
		} else {
			inputPath = arg;
		}
	}

	const providerRoot = resolve(process.cwd(), inputPath);
	if (!existsSync(providerRoot) || !statSync(providerRoot).isDirectory()) {
		console.error(`Provider path not found: ${inputPath}`);
		process.exit(2);
	}

	let report: Awaited<ReturnType<typeof runMigrate>>;
	try {
		report = await runMigrate({
			providerRoot,
			dryRun,
			...(only.length > 0 ? { only } : {}),
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	}

	if (json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(formatMigrateReport(report));
	}
	process.exit(migrateExitCode(report));
}

if (import.meta.main) {
	await main();
}
