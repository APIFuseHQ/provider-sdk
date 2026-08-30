#!/usr/bin/env bun

/**
 * `apifuse migrate-shape [path] [--check] [--json]`
 *
 * Applies the provider authoring-shape migration for the phase-separated SDK
 * (2.2.0-beta.37+) to a provider repository. Two coordinated transforms:
 *
 * 1. `index.ts`: single-phase `defineProvider({...operations})` becomes the
 *    two-phase declaration builder. The old shape default-exports a builder
 *    FUNCTION under the new SDK, so the module stops loading.
 * 2. Every provider source file: legacy `defineOperation(config)` /
 *    `defineStreamOperation(config)` become the curried
 *    `defineOperation<ProviderContext>()(config)`. The legacy call returns
 *    the inner factory with the config swallowed, so every operation in the
 *    map turns into a function and finalizeProvider rejects the provider
 *    with a misleading health-check error.
 *
 * Both halves belong to the same SDK bump: this transform and the pin bump
 * must land in one commit.
 *
 * Exit codes: 0 migrated or already migrated; 1 any skip (the transform
 * refuses to guess) or a missing index.ts. `--check` reports without
 * writing. A skip is a hard stop for fan-out callers — never pair a pin bump
 * with a skipped migration.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { migrateOperationShape } from "../src/cli/migrate-operation-shape.js";
import { migrateProviderShape } from "../src/cli/migrate-provider-shape.js";

const SOURCE_SKIP_DIRECTORIES = new Set([
	"node_modules",
	"__tests__",
	"__fixtures__",
	".git",
	"dist",
]);

type FileOutcome = {
	readonly path: string;
	readonly status: string;
	readonly detail?: string;
};

export async function main(): Promise<void> {
	const args = process.argv.slice(3);
	const check = args.includes("--check");
	const json = args.includes("--json");
	const positional = args.filter((argument) => !argument.startsWith("--"));
	const providerRoot = resolve(positional[0] ?? ".");
	const indexPath = resolve(providerRoot, "index.ts");

	const report = (payload: Record<string, unknown>, humanText: string): void => {
		if (json) {
			console.log(
				JSON.stringify({ schemaVersion: 2, providerRoot, ...payload }),
			);
		} else {
			console.log(humanText);
		}
	};

	if (!existsSync(indexPath)) {
		report(
			{ status: "skipped", reason: "index.ts not found" },
			`migrate-shape: ${indexPath} not found.`,
		);
		process.exit(1);
	}

	// ── Pass 1: provider two-phase shape on index.ts
	const indexSource = readFileSync(indexPath, "utf8");
	const providerResult = migrateProviderShape(indexSource, indexPath);

	if (providerResult.status === "skipped") {
		report(
			{ status: "skipped", stage: "provider-shape", reason: providerResult.reason },
			`migrate-shape: skipped — ${providerResult.reason}\nThis provider needs a manual migration; do not bump its SDK pin without one.`,
		);
		process.exit(1);
	}

	// ── Pass 2: operation currying across the provider's source tree.
	// The index.ts input for this pass is pass 1's OUTPUT, so a provider
	// whose index both holds the declaration and defines operations gets
	// both transforms in one write.
	const indexAfterProvider = providerResult.code;
	const outcomes: FileOutcome[] = [];
	const pendingWrites = new Map<string, string>();
	let operationRewrites = 0;

	for (const sourcePath of collectSourceFiles(providerRoot)) {
		const isIndex = sourcePath === indexPath;
		const input = isIndex
			? indexAfterProvider
			: readFileSync(sourcePath, "utf8");
		// Operation modules import the alias from the provider entry; the
		// entry file declares it itself.
		const contextSpecifier = isIndex
			? "./index"
			: relativeImportToIndex(sourcePath, providerRoot);
		const result = migrateOperationShape(input, sourcePath, contextSpecifier);

		if (result.status === "skipped") {
			report(
				{
					status: "skipped",
					stage: "operation-shape",
					file: relative(providerRoot, sourcePath),
					reason: result.reason,
				},
				`migrate-shape: skipped at ${relative(providerRoot, sourcePath)} — ${result.reason}\nThis provider needs a manual migration; do not bump its SDK pin without one.`,
			);
			process.exit(1);
		}
		if (result.status === "migrated") {
			operationRewrites += result.rewrites;
			pendingWrites.set(sourcePath, result.code);
			outcomes.push({
				path: relative(providerRoot, sourcePath),
				status: "curried",
				detail: `${result.rewrites} call site(s)`,
			});
		} else if (isIndex && providerResult.status === "migrated") {
			// Provider shape changed even though no operation calls did.
			pendingWrites.set(sourcePath, result.code);
		}
	}

	const providerChanged = providerResult.status === "migrated";
	const anythingChanged = providerChanged || operationRewrites > 0;

	if (!anythingChanged) {
		report(
			{ status: "unchanged" },
			"migrate-shape: already migrated; nothing to do.",
		);
		return;
	}

	if (check) {
		report(
			{
				status: "would-migrate",
				providerShape: providerChanged ? providerResult.kind : "unchanged",
				operationCallSites: operationRewrites,
				files: outcomes,
			},
			`migrate-shape: would migrate (provider: ${providerChanged ? providerResult.kind : "unchanged"}, operation call sites: ${operationRewrites}). Run without --check to write.`,
		);
		return;
	}

	for (const [path, code] of pendingWrites) {
		writeFileSync(path, code, "utf8");
	}
	report(
		{
			status: "migrated",
			providerShape: providerChanged ? providerResult.kind : "unchanged",
			operationCallSites: operationRewrites,
			files: outcomes,
		},
		`migrate-shape: migrated (provider: ${providerChanged ? providerResult.kind : "unchanged"}, operation call sites: ${operationRewrites} across ${pendingWrites.size} file(s)). Review the diff, then run \`apifuse check\` and \`bun test\`.`,
	);
}

/** Provider-authored .ts sources, excluding tests, fixtures, and build output. */
function collectSourceFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (SOURCE_SKIP_DIRECTORIES.has(entry.name)) continue;
				walk(join(directory, entry.name));
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			if (entry.name.endsWith(".d.ts")) continue;
			if (entry.name.endsWith(".test.ts")) continue;
			files.push(join(directory, entry.name));
		}
	};
	walk(root);
	return files.sort();
}

/** `operations/foo.ts` -> `../index`; `operations/a/b.ts` -> `../../index`. */
function relativeImportToIndex(sourcePath: string, providerRoot: string): string {
	const fromDirectory = dirname(sourcePath);
	let specifier = relative(fromDirectory, join(providerRoot, "index"));
	specifier = specifier.split("\\").join("/");
	if (!specifier.startsWith(".")) specifier = `./${specifier}`;
	return specifier;
}

if (import.meta.main) {
	await main();
}
