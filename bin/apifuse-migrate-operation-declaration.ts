#!/usr/bin/env bun

/**
 * `apifuse migrate-operation-declaration [path] [--check] [--json]`
 *
 * Rewrites ADR-0009's legacy nested operation declarations to the flat
 * authoring contract. The run is repository-atomic: any declaration the
 * codemod cannot prove leaves every source file untouched and exits 2.
 */

import { resolve } from "node:path";

import { migrateOperationDeclarationRepository } from "../src/cli/migrate-operation-declaration.js";

export async function main(): Promise<number> {
	const args = process.argv.slice(3);
	const check = args.includes("--check");
	const json = args.includes("--json");
	const positional = args.filter((argument) => !argument.startsWith("--"));
	const providerRoot = resolve(positional[0] ?? ".");
	const result = migrateOperationDeclarationRepository(providerRoot, { check });

	if (json) {
		console.log(
			JSON.stringify({
				schemaVersion: 1,
				command: "migrate-operation-declaration",
				...result,
			}),
		);
	} else if (result.status === "refused") {
		console.error(
			`migrate-operation-declaration: refused ${result.refusals.length} declaration(s); no files were written.`,
		);
		for (const item of result.refusals) {
			console.error(`  ${item.file} [${item.operationKey}] ${item.reason}: ${item.detail}`);
		}
	} else if (result.status === "unchanged") {
		console.log("migrate-operation-declaration: already flat; nothing to do.");
	} else {
		const verb = result.status === "would-migrate" ? "would migrate" : "migrated";
		const sidecar = result.sidecar === undefined ? "" : ` and ${result.sidecar}`;
		console.log(
			`migrate-operation-declaration: ${verb} ${result.operationCount} operation(s) across ${result.changedFiles.length} file(s)${sidecar}.`,
		);
	}

	const exitCode = result.status === "refused" ? 2 : 0;
	process.exitCode = exitCode;
	return exitCode;
}

if (import.meta.main) {
	process.exit(await main());
}
