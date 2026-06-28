#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const PACKAGE_NAME = "@apifuse/provider-sdk";
const PackageJsonSchema = z.object({ version: z.string() }).catchall(z.unknown());
const REQUIRED_EVIDENCE = [
	"SDK unit/integration gates",
	"generated provider scaffold check/test/submit-check",
	"pack/package validation",
	"clean consumer install smoke",
	"dev-server HTTP smoke",
	"monorepo compatibility smoke",
] as const;

type BetaVersion = {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly beta: number;
};

type ReleasePrContext = {
	readonly branch: string;
	readonly version: string;
	readonly candidateSha: string;
	readonly sourceSha: string;
};

export function parseBetaVersion(version: string): BetaVersion | null {
	const match = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/.exec(version);
	if (!match) return null;
	const [, major, minor, patch, beta] = match;
	if (!major || !minor || !patch || !beta) return null;
	return {
		major: Number.parseInt(major, 10),
		minor: Number.parseInt(minor, 10),
		patch: Number.parseInt(patch, 10),
		beta: Number.parseInt(beta, 10),
	};
}

export function nextBetaVersion(versions: readonly string[]): string {
	const betaVersions = versions.map(parseBetaVersion).filter((version) => version !== null);
	if (betaVersions.length === 0) {
		throw new Error("At least one beta version is required to prepare the next beta release.");
	}

	const latest = betaVersions.toSorted(compareBetaVersion).at(-1);
	if (!latest) {
		throw new Error("Unable to determine the latest beta version.");
	}

	return `${latest.major}.${latest.minor}.${latest.patch}-beta.${latest.beta + 1}`;
}

export function releaseBranchForVersion(version: string): string {
	if (!parseBetaVersion(version)) {
		throw new Error(`Beta release version must match X.Y.Z-beta.N, got ${version}`);
	}
	return `release/beta-${version}`;
}

export function buildReleasePrBody(context: ReleasePrContext): string {
	const checklist = REQUIRED_EVIDENCE.map((label) => `- [ ] ${label}`).join("\n");
	return `## Release-candidate validation

Candidate SHA: ${context.candidateSha}
Source main SHA: ${context.sourceSha}
Release branch: ${context.branch}
Version: ${context.version}

This PR was prepared automatically after release-relevant changes landed on main. It is not deployed until this release PR is updated with evidence, the guard passes, the protected npm-publish environment approves, and the PR is merged.

${checklist}
`;
}

function main(): void {
	const sourceSha = requiredEnv("SOURCE_SHA");
	const currentVersion = packageVersion();
	const publishedBeta = latestPublishedBetaVersion();
	const version = nextBetaVersion([currentVersion, publishedBeta].filter(isPresent));
	const branch = releaseBranchForVersion(version);

	git(["config", "user.name", "github-actions[bot]"]);
	git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
	git(["fetch", "origin", "main", "--prune"]);
	git(["checkout", "-B", branch, "origin/main"]);

	updatePackageVersion(version);
	updateChangelog(version, sourceSha);
	git(["add", "package.json", "CHANGELOG.md"]);
	git(["commit", "-m", `chore: release ${PACKAGE_NAME} v${version}`]);

	const candidateSha = git(["rev-parse", "HEAD"]);
	const body = buildReleasePrBody({ branch, version, candidateSha, sourceSha });
	writeFileSync("/tmp/provider-sdk-release-pr.md", body);
	git(["push", "origin", `HEAD:${branch}`, "--force-with-lease"]);

	upsertPullRequest(branch, version);
}

function compareBetaVersion(left: BetaVersion, right: BetaVersion): number {
	return (
		left.major - right.major ||
		left.minor - right.minor ||
		left.patch - right.patch ||
		left.beta - right.beta
	);
}

function packageVersion(): string {
	return readPackageJson().version;
}

function latestPublishedBetaVersion(): string | null {
	try {
		return execFileSync("npm", ["view", `${PACKAGE_NAME}@beta`, "version"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		if (error instanceof Error) return null;
		throw error;
	}
}

function updatePackageVersion(version: string): void {
	const packageJson = { ...readPackageJson(), version };
	writeFileSync("package.json", `${JSON.stringify(packageJson, null, "\t")}\n`);
}

function readPackageJson(): z.infer<typeof PackageJsonSchema> {
	return PackageJsonSchema.parse(JSON.parse(readFileSync("package.json", "utf8")));
}

function updateChangelog(version: string, sourceSha: string): void {
	const current = readFileSync("CHANGELOG.md", "utf8");
	const entry = `\n## ${version}\n\n- Release candidate for main commit ${sourceSha}.\n`;
	writeFileSync("CHANGELOG.md", current.replace("\n## ", `${entry}\n## `));
}

function upsertPullRequest(branch: string, version: string): void {
	const existingNumber = execFileSync(
		"gh",
		[
			"pr",
			"list",
			"--base",
			"main",
			"--head",
			branch,
			"--state",
			"open",
			"--json",
			"number",
			"--jq",
			".[0].number // empty",
		],
		{ encoding: "utf8" },
	).trim();
	const title = `chore: release ${PACKAGE_NAME} v${version}`;
	if (existingNumber) {
		execFileSync("gh", [
			"pr",
			"edit",
			existingNumber,
			"--title",
			title,
			"--body-file",
			"/tmp/provider-sdk-release-pr.md",
		]);
		return;
	}
	execFileSync("gh", [
		"pr",
		"create",
		"--base",
		"main",
		"--head",
		branch,
		"--title",
		title,
		"--body-file",
		"/tmp/provider-sdk-release-pr.md",
	]);
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required.`);
	return value;
}

function isPresent(value: string | null): value is string {
	return value !== null;
}

function git(args: readonly string[]): string {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

if (import.meta.main) {
	main();
}
