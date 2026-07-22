#!/usr/bin/env bun

import {
	formatPromptAssetIssues,
	installedSdkVersion,
	syncPromptAssets,
	verifyPromptAssets,
} from "../src/cli/prompt-assets.js";
import { resolveProviderRoot } from "./apifuse-check.js";

const HELP_TEXT = `Usage: apifuse sync-assets [path] [--check]
Example: apifuse sync-assets .
Default: apifuse sync-assets .

Regenerates the SDK-managed agent prompt assets for the installed SDK version:
AGENTS.md, .agents/skills/**, the CLAUDE.md/.claude/.codex symlinks, and the
.apifuse/prompt-assets.json manifest. Legacy top-level skills/ layouts are
migrated. Idempotent.

Options:
  --check        Verify only; exit 1 with a diff list when assets are stale/missing/modified
  --help, -h     Show this help`;

export async function main() {
	const args = normalizeArgs(process.argv.slice(2));

	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP_TEXT);
		return;
	}

	let checkOnly = false;
	let inputPath: string | undefined;
	for (const arg of args) {
		if (arg === "--check") {
			checkOnly = true;
			continue;
		}
		if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}
		if (inputPath !== undefined) {
			throw new Error(`Unexpected argument: ${arg}`);
		}
		inputPath = arg;
	}

	const providerRoot = resolveProviderRoot(inputPath ?? ".");

	if (checkOnly) {
		const verification = verifyPromptAssets(providerRoot);
		if (verification.ok) {
			console.log(
				`Prompt assets are in sync with the installed SDK (${installedSdkVersion()}): ${providerRoot}`,
			);
			return;
		}
		console.error(`Prompt assets are out of sync in ${providerRoot}:`);
		for (const issue of formatPromptAssetIssues(verification)) {
			console.error(`  - ${issue}`);
		}
		console.error("\nRun `bun run sync-assets` (or `bunx apifuse sync-assets .`) to regenerate.");
		process.exit(1);
	}

	const result = syncPromptAssets(providerRoot);

	// Honesty gate: writes alone never imply success. sync-assets intentionally
	// PRESERVES (does not delete) unauthorized skills and symlinks under
	// .agents/skills, so it can return changed:false while verify still fails.
	// Re-verify AFTER writing and let the true post-sync state drive the exit
	// code — never claim success while the freshness gate would reject the tree.
	const verification = verifyPromptAssets(providerRoot);

	if (result.changed) {
		for (const removed of result.removed) {
			console.log(`removed  ${removed}`);
		}
		for (const wrote of result.wroteFiles) {
			console.log(`wrote    ${wrote}`);
		}
		for (const link of result.createdSymlinks) {
			console.log(`symlink  ${link}`);
		}
		console.log(`manifest ${result.manifestPath} (sdkVersion ${installedSdkVersion()})`);
	}

	if (!verification.ok) {
		console.error(`\nPrompt assets are still out of sync in ${providerRoot}:`);
		for (const issue of formatPromptAssetIssues(verification)) {
			console.error(`  - ${issue}`);
		}
		console.error(
			"\nsync-assets never deletes unrecognized content: resolve these by hand — remove any unauthorized skill directory or symlink under .agents/skills/, migrate a real .claude/.codex directory into .agents/ — then re-run `apifuse sync-assets .`.",
		);
		process.exit(1);
	}

	if (!result.changed) {
		console.log(
			`Prompt assets already in sync with the installed SDK (${installedSdkVersion()}): ${providerRoot}`,
		);
		return;
	}
	console.log(`\nPrompt assets synced: ${providerRoot}`);
}

function normalizeArgs(argv: string[]): string[] {
	return argv[0] === "sync-assets" ? argv.slice(1) : argv;
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
