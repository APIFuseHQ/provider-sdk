import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildReleasePrBody,
	nextBetaVersion,
	releaseBranchForVersion,
} from "../../scripts/prepare-beta-release-pr.js";

const WORKFLOW_DIR = ".github/workflows";
const RELEASE_WORKFLOW = workflow("release.yml");
const RELEASE_AUTOMATION_WORKFLOW = workflow("release-pr-automation.yml");
const RELEASE_GUARD_WORKFLOW = workflow("release-guard.yml");
const GUARDED_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("release workflows", () => {
	it("does not publish npm from a normal feature branch merge alone", () => {
		expect(RELEASE_WORKFLOW).toContain("pull_request:");
		expect(RELEASE_WORKFLOW).toContain("types: [closed]");
		expect(RELEASE_WORKFLOW).not.toMatch(/\n\s*push:/);
		expect(RELEASE_AUTOMATION_WORKFLOW).not.toContain("npm publish");
	});

	it("keeps beta npm publish behind merged release beta branches only", () => {
		expect(RELEASE_WORKFLOW).toContain(
			"startsWith(github.event.pull_request.head.ref, 'release/beta-')",
		);
		expect(RELEASE_WORKFLOW).toContain("environment: npm-publish");
		expect(RELEASE_WORKFLOW).toContain('if [[ "$RELEASE_BRANCH" == release/beta-* ]]; then');
		expect(RELEASE_WORKFLOW).toContain("npm publish --tag beta --provenance");
	});

	it("creates a machine-evidence-blocked beta release PR after release-relevant main changes", () => {
		expect(RELEASE_AUTOMATION_WORKFLOW).toContain("branches: [main]");
		expect(RELEASE_AUTOMATION_WORKFLOW).toContain(
			"!contains(github.event.head_commit.message, 'release/beta-')",
		);
		expect(RELEASE_AUTOMATION_WORKFLOW).toContain('- "src/**"');
		expect(RELEASE_AUTOMATION_WORKFLOW).toContain("pull-requests: write");
		expect(RELEASE_AUTOMATION_WORKFLOW).toContain("bun scripts/prepare-beta-release-pr.ts");
		expect(RELEASE_GUARD_WORKFLOW).toContain("types: [opened, synchronize, reopened, edited]");
		expect(RELEASE_GUARD_WORKFLOW).toContain("path: candidate");
		expect(RELEASE_GUARD_WORKFLOW).toContain("path: release-control");
		expect(RELEASE_GUARD_WORKFLOW).toContain(
			"bun release-control/scripts/run-release-validation.ts",
		);
		expect(RELEASE_GUARD_WORKFLOW).toContain("actions/upload-artifact@v4");
		expect(RELEASE_GUARD_WORKFLOW).toContain("bun release-control/scripts/guard-release-pr.ts");

		const body = buildReleasePrBody({
			branch: "release/beta-2.1.0-beta.11",
			version: "2.1.0-beta.11",
			candidateSha: GUARDED_SHA,
			sourceSha: GUARDED_SHA,
		});

		expect(body).toContain("Release-candidate validation");
		expect(body).toContain(`Candidate SHA: ${GUARDED_SHA}`);
		expect(body).toContain("The PR body is informational and cannot satisfy the gate");
		expect(body).toContain("`bun run pack:smoke`");
		expect(body).not.toMatch(/- \[[ x]\]/i);
	});

	it("uses release branch names accepted by the guard", () => {
		const branch = releaseBranchForVersion(nextBetaVersion(["2.1.0-beta.9", "2.1.0-beta.10"]));

		expect(branch).toBe("release/beta-2.1.0-beta.11");
	});

	it("makes publish consume the successful candidate artifact before existing checks", () => {
		expect(RELEASE_WORKFLOW).toContain("actions: read");
		expect(RELEASE_WORKFLOW).toContain("actions/workflows/release-guard.yml/runs");
		expect(RELEASE_WORKFLOW).toContain("release-evidence-$" + "{CANDIDATE_SHA}");
		expect(RELEASE_WORKFLOW).toContain("bun scripts/guard-release-pr.ts");
		for (const command of [
			"bun test",
			"bun run check",
			"bun run pack:check",
			"bun run pack:smoke",
		]) {
			expect(RELEASE_WORKFLOW).toContain(command);
		}
	});

	it("keeps dynamic GitHub expressions out of workflow run scripts", () => {
		for (const source of [RELEASE_WORKFLOW, RELEASE_GUARD_WORKFLOW, RELEASE_AUTOMATION_WORKFLOW]) {
			expect(runBlocks(source).some((block) => block.includes("${{"))).toBe(false);
		}
	});
});

function workflow(name: string): string {
	return readFileSync(join(WORKFLOW_DIR, name), "utf8");
}

function runBlocks(source: string): readonly string[] {
	const lines = source.split("\n");
	const blocks: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line?.match(/^\s*run:/)) continue;
		const indent = line.search(/\S/);
		const block = [line];
		for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
			const next = lines[cursor];
			if (next?.trim() && next.search(/\S/) <= indent) break;
			block.push(next ?? "");
		}
		blocks.push(block.join("\n"));
	}
	return blocks;
}
