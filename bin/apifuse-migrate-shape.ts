#!/usr/bin/env bun

/**
 * `apifuse migrate-shape [path] [--check] [--json]`
 *
 * Applies the provider authoring-shape migration (single-phase
 * `defineProvider({...operations})` to the two-phase declaration builder) to
 * a provider's `index.ts`. This is the source half of a breaking SDK bump:
 * the pin bump and this transform must land in the same commit, because the
 * single-phase shape default-exports a builder function under 2.2.0-beta.37+
 * and the module stops loading.
 *
 * Exit codes: 0 migrated or already two-phase; 1 skipped (the transform
 * refuses to guess) or the file is missing. `--check` reports without
 * writing. A skip is a hard stop for fan-out callers — never pair a pin bump
 * with a skipped migration.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { migrateProviderShape } from "../src/cli/migrate-provider-shape.js";

export async function main(): Promise<void> {
	const args = process.argv.slice(3);
	const check = args.includes("--check");
	const json = args.includes("--json");
	const positional = args.filter((argument) => !argument.startsWith("--"));
	const providerRoot = resolve(positional[0] ?? ".");
	const indexPath = resolve(providerRoot, "index.ts");

	const report = (payload: Record<string, unknown>, humanText: string): void => {
		if (json) {
			console.log(JSON.stringify({ schemaVersion: 1, indexPath, ...payload }));
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

	const sourceText = readFileSync(indexPath, "utf8");
	const result = migrateProviderShape(sourceText, indexPath);

	if (result.status === "skipped") {
		report(
			{ status: "skipped", reason: result.reason },
			`migrate-shape: skipped — ${result.reason}\nThis provider needs a manual migration; do not bump its SDK pin without one.`,
		);
		process.exit(1);
	}

	if (result.status === "unchanged") {
		report(
			{ status: "unchanged" },
			"migrate-shape: already two-phase; nothing to do.",
		);
		return;
	}

	if (check) {
		report(
			{ status: "would-migrate", kind: result.kind },
			`migrate-shape: would migrate (${result.kind}). Run without --check to write.`,
		);
		return;
	}

	writeFileSync(indexPath, result.code, "utf8");
	report(
		{ status: "migrated", kind: result.kind },
		`migrate-shape: migrated (${result.kind}). Review the diff, then run \`apifuse check\` and \`bun test\`.`,
	);
}

if (import.meta.main) {
	await main();
}
