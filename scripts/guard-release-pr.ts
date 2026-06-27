#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REQUIRED_LABELS = [
	"SDK unit/integration gates",
	"generated provider scaffold check/test/submit-check",
	"pack/package validation",
	"clean consumer install smoke",
	"dev-server HTTP smoke",
	"monorepo compatibility smoke",
];

function main(): void {
	const bodyPath = process.env.RELEASE_PR_BODY_PATH ?? process.argv[2];
	if (!bodyPath) {
		throw new Error("Usage: guard-release-pr.ts <pr-body-path>");
	}
	const expectedSha = process.env.RELEASE_CANDIDATE_SHA ?? git(["rev-parse", "HEAD"]);
	const branch = process.env.RELEASE_BRANCH ?? git(["branch", "--show-current"]);
	const body = readFileSync(bodyPath, "utf8");

	if (!/^release\/(beta-[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+|v[0-9]+\.[0-9]+\.[0-9]+)$/.test(branch)) {
		throw new Error(`Release branch must be release/beta-X.Y.Z-beta.N or release/vX.Y.Z, got ${branch}`);
	}
	if (!/release-candidate validation/i.test(body) && !/stable promotion validation/i.test(body)) {
		throw new Error("Release PR body must contain a release-candidate or stable promotion validation section.");
	}
	const shas = body.match(/\b[0-9a-f]{40}\b/gi) ?? [];
	if (!shas.some((sha) => sha.toLowerCase() === expectedSha.toLowerCase())) {
		throw new Error(`Release PR body must include candidate SHA ${expectedSha}. Found: ${shas.join(", ") || "none"}`);
	}
	for (const label of REQUIRED_LABELS) {
		const pattern = new RegExp(`-\\s*\\[x\\]\\s*[^\\n]*${escapeRegExp(label)}`, "i");
		if (!pattern.test(body)) {
			throw new Error(`Release PR body missing checked validation item: ${label}`);
		}
	}
	console.log(`Release PR guard passed for ${branch} at ${expectedSha}`);
}

function git(args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main();
