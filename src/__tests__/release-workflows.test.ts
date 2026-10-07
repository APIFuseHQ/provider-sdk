import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const NPM_TARBALL_WAIT_STEP = "- name: Wait for the published tarball on npm";
// The failing case spends a real 4s budget (one attempt, one sleep); the timeout
// leaves headroom over bun's 5s default on a loaded runner.
const NPM_WAIT_TEST_TIMEOUT_MS = 30_000;

const FAKE_NPM = `#!/usr/bin/env bash
# Stand-in for \`npm view <package>@<version> dist.tarball\`.
if [ "$1" = view ] && [ "$3" = dist.tarball ]; then
	version="\${2##*@}"
	printf 'https://registry.npmjs.org/@apifuse/provider-sdk/-/provider-sdk-%s.tgz\\n' "\${version}"
	exit 0
fi
echo "unexpected npm call: $*" >&2
exit 2
`;

const FAKE_CURL = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${FAKE_CURL_LOG}"
printf '%s' "\${FAKE_TARBALL_HTTP}"
`;

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
		// The npm-publish environment has no protection rules, so the body must not
		// advertise an approval step nobody performs; the merge is the approval.
		expect(body).not.toContain("environment approves");
		expect(body).toContain("merging publishes immediately");
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

	it("dispatches provider_sdk_released only after the npm tarball wait", () => {
		const publish = RELEASE_WORKFLOW.indexOf("- name: Publish to npm");
		const wait = RELEASE_WORKFLOW.indexOf(NPM_TARBALL_WAIT_STEP);
		const notify = RELEASE_WORKFLOW.indexOf(
			"- name: Notify monorepo (provider_sdk_released dispatch)",
		);
		expect(publish).toBeGreaterThan(-1);
		expect(wait).toBeGreaterThan(publish);
		expect(notify).toBeGreaterThan(wait);
	});
});

// Executes the extracted wait step against a stand-in `npm`/`curl` on PATH.
// No network: `node` (package.json read) and coreutils are the only real tools.
describe("release npm tarball wait step (executed)", () => {
	it(
		"passes once the published tarball answers HTTP 200",
		() => {
			const run = runNpmTarballWait({ budgetSeconds: 60, tarballHttp: "200" });
			expect(run.exitCode, run.stderr).toBe(0);
			expect(run.stdout).toContain("@apifuse/provider-sdk@2.2.0-beta.69 tarball answers HTTP 200");
			expect(run.curlCalls).toContain(
				"https://registry.npmjs.org/@apifuse/provider-sdk/-/provider-sdk-2.2.0-beta.69.tgz",
			);
		},
		NPM_WAIT_TEST_TIMEOUT_MS,
	);

	it(
		"keeps waiting while the tarball is not served and fails with a warning at the budget",
		() => {
			const run = runNpmTarballWait({ budgetSeconds: 4, tarballHttp: "404" });
			expect(run.exitCode).toBe(1);
			expect(run.stdout).toContain(
				"::warning::@apifuse/provider-sdk@2.2.0-beta.69 tarball did not answer HTTP 200 within 4s",
			);
			expect(run.stdout).toContain("answered HTTP 404");
		},
		NPM_WAIT_TEST_TIMEOUT_MS,
	);
});

function npmTarballWaitScript(): string {
	const start = RELEASE_WORKFLOW.indexOf(NPM_TARBALL_WAIT_STEP);
	if (start < 0) throw new Error("npm tarball wait step not found in release.yml");
	const lines = RELEASE_WORKFLOW.slice(start).split("\n");
	const runIndex = lines.findIndex((line) => /^\s*run: \|$/.test(line));
	const runLine = lines[runIndex];
	if (runIndex < 0 || runLine === undefined)
		throw new Error("npm tarball wait step has no run block");
	const indent = runLine.search(/\S/);
	const body: string[] = [];
	for (const line of lines.slice(runIndex + 1)) {
		if (line.trim() && line.search(/\S/) <= indent) break;
		body.push(line.slice(indent + 2));
	}
	return body.join("\n");
}

function runNpmTarballWait(input: {
	readonly budgetSeconds: number;
	readonly tarballHttp: string;
}): {
	readonly curlCalls: string;
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
} {
	const root = mkdtempSync(join(tmpdir(), "provider-sdk-release-npm-wait-"));
	try {
		const bin = join(root, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "npm"), FAKE_NPM);
		writeFileSync(join(bin, "curl"), FAKE_CURL);
		chmodSync(join(bin, "npm"), 0o755);
		chmodSync(join(bin, "curl"), 0o755);
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "@apifuse/provider-sdk", version: "2.2.0-beta.69" }),
		);
		const curlLog = join(root, "curl-calls");
		writeFileSync(curlLog, "");
		const result = Bun.spawnSync(["bash", "-c", npmTarballWaitScript()], {
			cwd: root,
			env: {
				...process.env,
				FAKE_CURL_LOG: curlLog,
				FAKE_TARBALL_HTTP: input.tarballHttp,
				NPM_VISIBILITY_TIMEOUT_SECONDS: String(input.budgetSeconds),
				PATH: [bin, dirname(process.execPath), process.env.PATH ?? ""].join(":"),
			},
		});
		return {
			curlCalls: readFileSync(curlLog, "utf8"),
			exitCode: result.exitCode,
			stderr: result.stderr.toString(),
			stdout: result.stdout.toString(),
		};
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

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
