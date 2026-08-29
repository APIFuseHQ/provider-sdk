#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import {
	RELEASE_CHECKS,
	type ReleaseCheckEvidence,
	type ReleaseEvidence,
} from "./release-evidence.js";

export type ReleaseCommandExecutor = (
	argv: readonly string[],
	cwd: string,
) => { readonly exitCode: number };

export function runReleaseChecks(
	candidateSha: string,
	cwd: string,
	execute: ReleaseCommandExecutor = executeCommand,
	now: () => Date = () => new Date(),
): ReleaseEvidence {
	const checks: ReleaseCheckEvidence[] = [];
	for (const check of RELEASE_CHECKS) {
		console.log(`\n=== Release validation: ${check.id} (${check.command}) ===`);
		const result = execute(check.argv, cwd);
		checks.push({
			id: check.id,
			command: check.command,
			exitCode: result.exitCode,
			summary:
				result.exitCode === 0
					? `${check.summary}: passed`
					: `${check.summary}: failed with exit code ${result.exitCode}`,
		});
	}

	return {
		schemaVersion: 1,
		candidateSha,
		generatedAt: now().toISOString(),
		checks,
	};
}

function executeCommand(argv: readonly string[], cwd: string): { readonly exitCode: number } {
	const [command, ...args] = argv;
	if (!command) return { exitCode: 127 };
	const result = spawnSync(command, args, {
		cwd,
		env: process.env,
		stdio: "inherit",
	});
	if (result.error) {
		console.error(result.error.message);
		return { exitCode: 127 };
	}
	return { exitCode: result.status ?? 1 };
}

function main(): void {
	const candidateSha = requiredEnv("RELEASE_CANDIDATE_SHA");
	const evidencePath = requiredEnv("RELEASE_EVIDENCE_PATH");
	const candidateDirectory = process.env.RELEASE_CANDIDATE_DIRECTORY ?? process.cwd();
	const evidence = runReleaseChecks(candidateSha, candidateDirectory);
	writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
	console.log(`\nRelease evidence written to ${evidencePath}`);
	if (evidence.checks.some((check) => check.exitCode !== 0)) {
		process.exitCode = 1;
	}
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

if (import.meta.main) {
	main();
}
