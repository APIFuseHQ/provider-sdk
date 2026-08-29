#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { parseAndAssertReleaseEvidence } from "./release-evidence.js";

function main(): void {
	const evidencePath = process.env.RELEASE_EVIDENCE_PATH ?? process.argv[2];
	if (!evidencePath) {
		throw new Error("Usage: guard-release-pr.ts <release-evidence-path>");
	}
	const expectedSha = process.env.RELEASE_CANDIDATE_SHA ?? git(["rev-parse", "HEAD"]);
	const branch = process.env.RELEASE_BRANCH ?? git(["branch", "--show-current"]);

	if (
		!/^release\/(beta-[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+|v[0-9]+\.[0-9]+\.[0-9]+)$/.test(branch)
	) {
		throw new Error(
			`Release branch must be release/beta-X.Y.Z-beta.N or release/vX.Y.Z, got ${branch}`,
		);
	}
	parseAndAssertReleaseEvidence(readFileSync(evidencePath, "utf8"), expectedSha);
	console.log(`Release PR guard passed for ${branch} at ${expectedSha}`);
}

function git(args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

if (import.meta.main) {
	main();
}
