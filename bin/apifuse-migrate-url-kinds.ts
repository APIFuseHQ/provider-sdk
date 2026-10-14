#!/usr/bin/env bun

/**
 * `apifuse migrate-url-kinds [path] [--check] [--json] [--no-typecheck]`
 *
 * Moves output URL fields to the URL kind helpers (openspec
 * `add-output-url-kinds`): fleet-named fields with absolute-URL fixture values
 * become `image()`/`imageList()`/`itemPage()` (`url` only with evidence that
 * it is the item's own page), the mapper assignments it can trace are wrapped
 * in the constructors, other URL fields get a `TODO(url-kind)` marker. A
 * detector, not a gate: it prints what it left alone and why.
 *
 * Exit codes: 0 when it ran (changed, would change, or nothing to change);
 * 1 for a usage error (an unknown option, more than one path), a refused run
 * (no index.ts, an unreadable tsconfig.json, no operation, an SDK without the
 * helpers outside `--check`) or a failure. `--help` prints the usage and
 * touches nothing; `--check` never writes.
 */

import { resolve } from "node:path";

import {
	type MigrateUrlKindsResult,
	migrateUrlKindsRepository,
} from "../src/cli/migrate-url-kinds.js";

const COMMAND = "migrate-url-kinds";

export const MIGRATE_URL_KINDS_USAGE = `Usage: apifuse migrate-url-kinds [path] [--check] [--json] [--no-typecheck]

Declares output URL fields with image()/imageList()/itemPage() from recorded
fixture evidence, wraps the mapper assignments it can trace in the
constructors and marks other URL fields TODO(url-kind).

  path            provider repository root (default: current directory)
  --check         report what would change; write nothing
  --json          print one JSON object
  --no-typecheck  skip the in-memory type check of the result
  --help, -h      print this help; write nothing`;

const FLAGS = new Set(["--check", "--json", "--no-typecheck", "--help", "-h"]);

export type MigrateUrlKindsCliOutcome = {
	readonly code: number;
	readonly stdout: readonly string[];
	readonly stderr: readonly string[];
};

/** Runs the command for already-normalized arguments (no command name). */
export function runMigrateUrlKinds(args: readonly string[]): MigrateUrlKindsCliOutcome {
	const json = args.includes("--json");
	if (args.includes("--help") || args.includes("-h"))
		return { code: 0, stdout: [MIGRATE_URL_KINDS_USAGE], stderr: [] };

	const unknown = args.find((argument) => argument.startsWith("-") && !FLAGS.has(argument));
	const positional = args.filter((argument) => !argument.startsWith("-"));
	const usageError =
		unknown !== undefined
			? `unknown option ${unknown}`
			: positional.length > 1
				? `expected one path, got ${positional.length}: ${positional.join(" ")}`
				: undefined;
	if (usageError !== undefined) {
		if (json)
			return {
				code: 1,
				stdout: [
					JSON.stringify({
						schemaVersion: 1,
						command: COMMAND,
						status: "usage-error",
						reason: usageError,
					}),
				],
				stderr: [],
			};
		return { code: 1, stdout: [], stderr: [`${COMMAND}: ${usageError}`, MIGRATE_URL_KINDS_USAGE] };
	}

	const providerRoot = resolve(positional[0] ?? ".");
	let result: MigrateUrlKindsResult;
	try {
		result = migrateUrlKindsRepository(providerRoot, {
			check: args.includes("--check"),
			typecheck: !args.includes("--no-typecheck"),
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (json)
			return {
				code: 1,
				stdout: [
					JSON.stringify({
						schemaVersion: 1,
						command: COMMAND,
						providerRoot,
						status: "failed",
						reason,
					}),
				],
				stderr: [],
			};
		return { code: 1, stdout: [], stderr: [`${COMMAND}: failed: ${reason}`] };
	}
	const code = result.status === "refused" ? 1 : 0;
	if (json)
		return {
			code,
			stdout: [JSON.stringify({ schemaVersion: 1, command: COMMAND, providerRoot, ...result })],
			stderr: [],
		};
	return { code, stdout: formatResult(result), stderr: [] };
}

function formatResult(result: MigrateUrlKindsResult): string[] {
	const lines: string[] = [];
	if (result.status === "refused") lines.push(`${COMMAND}: refused: ${result.reason ?? ""}`);
	else {
		const verb =
			result.status === "would-migrate"
				? "would change"
				: result.status === "migrated"
					? "changed"
					: "nothing to change in";
		lines.push(
			`${COMMAND}: ${verb} ${result.changedFiles.length} file(s) — ${result.rewrites.length} field(s) declared with a helper, ${result.mapperWraps.length} mapper assignment(s) wrapped, ${result.todos.length} TODO(url-kind) marker(s), ${result.skipped.length} left alone; ${result.operations} operation(s) scanned.`,
		);
	}
	for (const diagnostic of result.configDiagnostics) lines.push(`  tsconfig ${diagnostic}`);
	if (result.sdk.status === "missing" || result.sdk.status === "outdated")
		lines.push(`  precondition ${result.sdk.detail ?? result.sdk.status}`);
	for (const item of result.rewrites) {
		lines.push(
			`  field   ${item.file}:${item.line} ${item.property} -> ${item.after}  [${item.paths.join(", ")}]`,
		);
		for (const note of item.notes ?? []) lines.push(`          note: ${note}`);
	}
	for (const item of result.mapperWraps)
		lines.push(`  mapper  ${item.file}:${item.line} ${item.property} -> ${item.constructor}(...)`);
	for (const item of result.todos)
		lines.push(
			`  todo    ${item.file}:${item.line} ${item.property} (${item.evidence})  [${item.paths.join(", ")}]${item.detail ? ` — ${item.detail}` : ""}`,
		);
	for (const item of result.skipped)
		lines.push(
			`  skip    ${item.file}:${item.line} ${item.property} ${item.reason}: ${item.detail}`,
		);
	for (const item of result.residual)
		lines.push(`  left    ${item.file}:${item.line} TS${item.code} ${item.message}`);
	if (result.residual.length > 0)
		lines.push(
			"  The type errors above are values the codemod could not trace: wrap each in toImageUrl()/toImageUrls()/toItemPageUrl(), or update the hand-written type.",
		);
	return lines;
}

function normalizeArgs(argv: readonly string[]): string[] {
	return argv[0] === COMMAND ? argv.slice(1) : [...argv];
}

export async function main(): Promise<number> {
	const outcome = runMigrateUrlKinds(normalizeArgs(process.argv.slice(2)));
	for (const line of outcome.stdout) console.log(line);
	for (const line of outcome.stderr) console.error(line);
	// The `apifuse` dispatcher ignores the return value.
	if (outcome.code !== 0) process.exitCode = outcome.code;
	return outcome.code;
}

if (import.meta.main) {
	process.exit(await main());
}
