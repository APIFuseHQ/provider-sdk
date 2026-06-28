import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildReleasePrBody,
	nextBetaVersion,
	releaseBranchForVersion,
} from "../../scripts/prepare-beta-release-pr";

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

	it("creates an evidence-blocked beta release PR after release-relevant main changes", () => {
		expect(RELEASE_AUTOMATION_WORKFLOW).toContain("branches: [main]");
		expect(RELEASE_AUTOMATION_WORKFLOW).toContain(
			"!contains(github.event.head_commit.message, 'release/beta-')",
		);
		expect(RELEASE_AUTOMATION_WORKFLOW).toContain('- "src/**"');
		expect(RELEASE_AUTOMATION_WORKFLOW).toContain("pull-requests: write");
		expect(RELEASE_AUTOMATION_WORKFLOW).toContain("bun scripts/prepare-beta-release-pr.ts");
		expect(RELEASE_GUARD_WORKFLOW).toContain("types: [opened, synchronize, reopened, edited]");

		const body = buildReleasePrBody({
			branch: "release/beta-2.1.0-beta.11",
			version: "2.1.0-beta.11",
			candidateSha: GUARDED_SHA,
			sourceSha: GUARDED_SHA,
		});

		expect(body).toContain("Release-candidate validation");
		expect(body).toContain(`Candidate SHA: ${GUARDED_SHA}`);
		expect(body).toContain("- [ ] SDK unit/integration gates");
		expect(body).not.toContain("- [x]");
	});

	it("uses release branch names accepted by the guard", async () => {
		const branch = releaseBranchForVersion(nextBetaVersion(["2.1.0-beta.9", "2.1.0-beta.10"]));
		const body = requiredEvidenceBody(GUARDED_SHA);
		const result = await runGuard(branch, GUARDED_SHA, body);

		expect(branch).toBe("release/beta-2.1.0-beta.11");
		expect(result.exitCode).toBe(0);
	});

	it("rejects release PR evidence placeholders before evidence is checked", async () => {
		const body = buildReleasePrBody({
			branch: "release/beta-2.1.0-beta.11",
			version: "2.1.0-beta.11",
			candidateSha: GUARDED_SHA,
			sourceSha: GUARDED_SHA,
		});
		const result = await runGuard("release/beta-2.1.0-beta.11", GUARDED_SHA, body);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("missing checked validation item");
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

function requiredEvidenceBody(sha: string): string {
	return `## Release-candidate validation

Candidate SHA: ${sha}

- [x] SDK unit/integration gates
- [x] generated provider scaffold check/test/submit-check
- [x] pack/package validation
- [x] clean consumer install smoke
- [x] dev-server HTTP smoke
- [x] monorepo compatibility smoke
`;
}

async function runGuard(
	branch: string,
	candidateSha: string,
	body: string,
): Promise<{ readonly exitCode: number; readonly stderr: string }> {
	const tempDir = mkdtempSync(join(process.cwd(), ".tmp-release-workflow-"));
	const bodyPath = join(tempDir, "body.md");
	writeFileSync(bodyPath, body);
	const proc = Bun.spawn(["bun", "scripts/guard-release-pr.ts", bodyPath], {
		env: {
			...process.env,
			RELEASE_BRANCH: branch,
			RELEASE_CANDIDATE_SHA: candidateSha,
			RELEASE_PR_BODY_PATH: bodyPath,
		},
		stderr: "pipe",
	});
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	rmSync(tempDir, { recursive: true, force: true });
	return { exitCode, stderr };
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
