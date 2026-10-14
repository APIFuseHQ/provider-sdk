#!/usr/bin/env bun

/**
 * `apifuse migrate-url-kinds [path] [--check] [--json] [--no-typecheck]`
 *
 * Moves output URL fields to the URL kind helpers (openspec
 * `add-output-url-kinds`): fleet-named fields with absolute-URL fixture values
 * become `image()`/`imageList()`/`itemPage()`, the mapper assignments it can
 * trace are wrapped in the constructors, other URL fields get a
 * `TODO(url-kind)` marker. A detector, not a gate: it always exits 0 and prints
 * what it left alone and why.
 */

import { resolve } from "node:path";

import { migrateUrlKindsRepository } from "../src/cli/migrate-url-kinds.js";

export async function main(): Promise<number> {
	const args = process.argv.slice(3);
	const check = args.includes("--check");
	const json = args.includes("--json");
	const typecheck = !args.includes("--no-typecheck");
	const positional = args.filter((argument) => !argument.startsWith("--"));
	const providerRoot = resolve(positional[0] ?? ".");
	const result = migrateUrlKindsRepository(providerRoot, { check, typecheck });

	if (json) {
		console.log(JSON.stringify({ schemaVersion: 1, command: "migrate-url-kinds", ...result }));
		return 0;
	}
	const verb =
		result.status === "would-migrate"
			? "would change"
			: result.status === "migrated"
				? "changed"
				: "nothing to change in";
	console.log(
		`migrate-url-kinds: ${verb} ${result.changedFiles.length} file(s) — ${result.rewrites.length} field(s) declared with a helper, ${result.mapperWraps.length} mapper assignment(s) wrapped, ${result.todos.length} TODO(url-kind) marker(s), ${result.skipped.length} left alone; ${result.operations} operation(s) scanned.`,
	);
	for (const item of result.rewrites)
		console.log(
			`  field   ${item.file}:${item.line} ${item.property} -> ${item.after}  [${item.paths.join(", ")}]`,
		);
	for (const item of result.mapperWraps)
		console.log(`  mapper  ${item.file}:${item.line} ${item.property} -> ${item.constructor}(...)`);
	for (const item of result.todos)
		console.log(
			`  todo    ${item.file}:${item.line} ${item.property} (${item.evidence})  [${item.paths.join(", ")}]`,
		);
	for (const item of result.skipped)
		console.log(
			`  skip    ${item.file}:${item.line} ${item.property} ${item.reason}: ${item.detail}`,
		);
	for (const item of result.residual)
		console.log(`  left    ${item.file}:${item.line} ${item.message}`);
	if (result.residual.length > 0)
		console.log(
			"  The type errors above are values the codemod could not trace: wrap each in toImageUrl()/toImageUrls()/toItemPageUrl(), or update the hand-written type.",
		);
	return 0;
}

if (import.meta.main) {
	process.exit(await main());
}
