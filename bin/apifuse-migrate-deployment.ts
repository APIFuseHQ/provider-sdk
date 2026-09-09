#!/usr/bin/env bun

/**
 * `apifuse migrate-deployment [path] [--check] [--json] [--drop-codeowners-lock]`
 *
 * Retires a provider repository's standalone `deploy.ts`. Deployment intent
 * has one home — the `deployment` key on `defineProvider({...})` — and only
 * the fields that differ from the runtime profile are written there. The
 * command:
 *
 * 1. reads `deploy.ts`, subtracts the profile defaults, and proves the
 *    resulting key resolves to exactly what the file declared;
 * 2. writes the key into the declaration literal (after `runtime`), removes
 *    a `deployment` extra from a `{ ...provider, deployment }` default export
 *    and any `import ... from "./deploy"`;
 * 3. deletes `deploy.ts` — after checking that no other repository source
 *    (tests included) imports the module. The `.github/CODEOWNERS`
 *    `/deploy.ts` lock stays unless `--drop-codeowners-lock` is passed: the
 *    platform still honors a re-added legacy file until its fallback is
 *    retired.
 *
 * Exit codes: 0 migrated or already migrated; 1 refused (the transform does
 * not guess — a refusal names the manual step) or missing index.ts.
 * `--check` reports without writing.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type * as MigrateModule from "../src/cli/migrate-deployment-intent.js";

/** Directories never scanned for deploy-module consumers. */
const SKIPPED_DIRECTORIES = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"coverage",
	".turbo",
	"__generated__",
]);
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

export const LEGACY_DEPLOY_FILE = "deploy.ts";
export const CODEOWNERS_FILE = ".github/CODEOWNERS";

export async function main(): Promise<void> {
	// The transform needs the TypeScript compiler; load it here so a missing
	// devDependency is a one-line report instead of an import stack trace.
	let migrateDeploymentIntent: typeof MigrateModule.migrateDeploymentIntent;
	let findDeployModuleConsumers: typeof MigrateModule.findDeployModuleConsumers;
	try {
		({ migrateDeploymentIntent, findDeployModuleConsumers } = await import(
			"../src/cli/migrate-deployment-intent.js"
		));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
	const args = normalizeArgs(process.argv.slice(2));
	const check = args.includes("--check");
	const json = args.includes("--json");
	const dropCodeownersLock = args.includes("--drop-codeowners-lock");
	const positional = args.filter((argument) => !argument.startsWith("--"));
	const providerRoot = resolve(positional[0] ?? ".");
	const indexPath = resolve(providerRoot, "index.ts");
	const deployPath = resolve(providerRoot, LEGACY_DEPLOY_FILE);
	const codeownersPath = resolve(providerRoot, CODEOWNERS_FILE);

	const report = (payload: Record<string, unknown>, humanText: string): void => {
		if (json) {
			console.log(JSON.stringify({ schemaVersion: 1, providerRoot, ...payload }));
		} else {
			console.log(humanText);
		}
	};

	if (!existsSync(indexPath)) {
		report(
			{ status: "refused", reason: "index.ts not found" },
			`migrate-deployment: ${indexPath} not found.`,
		);
		process.exit(1);
	}

	const deploySource = existsSync(deployPath) ? readFileSync(deployPath, "utf8") : undefined;
	const codeownersSource = existsSync(codeownersPath)
		? readFileSync(codeownersPath, "utf8")
		: undefined;
	const result = migrateDeploymentIntent({
		indexSource: readFileSync(indexPath, "utf8"),
		deploySource,
		codeownersSource,
		dropCodeownersLock,
		indexFileName: indexPath,
	});

	if (result.status === "refused") {
		report(
			{ status: "refused", reason: result.reason },
			`migrate-deployment: refused — ${result.reason}\nThis provider needs a manual migration; do not delete deploy.ts without one.`,
		);
		process.exit(1);
	}

	if (result.status === "unchanged") {
		report(
			{ status: "unchanged", notes: result.notes },
			`migrate-deployment: already migrated; nothing to do.${formatNotes(result.notes)}`,
		);
		return;
	}

	if (result.removeDeployFile) {
		// index.ts is accounted for by the transform; any other source that
		// imports the module (a test, a helper) would break when it is deleted.
		const consumers = findDeployModuleConsumers(
			providerRoot,
			collectOtherSources(providerRoot, [indexPath, deployPath]),
		);
		if (consumers.length > 0) {
			const reason = `deploy.ts is still imported by ${consumers.join(", ")}; remove or rewrite those imports before migrating.`;
			report(
				{ status: "refused", reason },
				`migrate-deployment: refused — ${reason}\nThis provider needs a manual migration; do not delete deploy.ts without one.`,
			);
			process.exit(1);
		}
	}

	const touchedPaths: string[] = [];
	if (result.indexChanged) touchedPaths.push("index.ts");
	if (result.removeDeployFile) touchedPaths.push(LEGACY_DEPLOY_FILE);
	if (result.codeownersChanged) touchedPaths.push(CODEOWNERS_FILE);
	const payload = {
		shape: result.shape,
		legacy: result.legacy,
		intent: result.intent,
		resolved: result.resolved,
		resolvedEqual: result.legacy === undefined ? undefined : true,
		touchedPaths,
		notes: result.notes,
	};
	const intentSummary =
		Object.keys(result.intent).length === 0
			? "profile defaults (no deployment key)"
			: `deployment: ${JSON.stringify(result.intent)}`;

	if (check) {
		report(
			{ status: "would-migrate", ...payload },
			`migrate-deployment: would migrate (${intentSummary}; touches ${touchedPaths.join(", ")}). Run without --check to write.${formatNotes(result.notes)}`,
		);
		return;
	}

	if (result.indexChanged) writeFileSync(indexPath, result.indexSource, "utf8");
	if (result.codeownersChanged && result.codeownersSource !== undefined) {
		writeFileSync(codeownersPath, result.codeownersSource, "utf8");
	}
	if (result.removeDeployFile) rmSync(deployPath, { force: true });
	report(
		{ status: "migrated", ...payload },
		`migrate-deployment: migrated (${intentSummary}; touched ${touchedPaths.join(", ")}). Review the diff, then run \`apifuse check\` and \`bun run type-check\`.${formatNotes(result.notes)}`,
	);
}

function normalizeArgs(argv: string[]): string[] {
	return argv[0] === "migrate-deployment" ? argv.slice(1) : argv;
}

/** Every source file under `providerRoot` except `excluded`, with text. */
function collectOtherSources(
	providerRoot: string,
	excluded: readonly string[],
): { readonly path: string; readonly text: string }[] {
	const skip = new Set(excluded.map((file) => resolve(file)));
	const files: { readonly path: string; readonly text: string }[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(absolute);
				continue;
			}
			if (!entry.isFile() || !SOURCE_FILE.test(entry.name) || skip.has(resolve(absolute))) continue;
			files.push({ path: relative(providerRoot, absolute), text: readFileSync(absolute, "utf8") });
		}
	};
	walk(providerRoot);
	return files;
}

function formatNotes(notes: readonly string[]): string {
	return notes.length === 0 ? "" : `\n${notes.map((note) => `  - ${note}`).join("\n")}`;
}

if (import.meta.main) {
	await main();
}
