import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseChangesetFile } from "@changesets/parse";

const root = resolve(import.meta.dir, "..");
const changesetConfig = JSON.parse(
	readFileSync(resolve(root, ".changeset", "config.json"), "utf8"),
) as {
	baseBranch?: unknown;
};
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
	name?: unknown;
};

if (typeof changesetConfig.baseBranch !== "string" || changesetConfig.baseBranch.length === 0) {
	console.error(".changeset/config.json must declare a non-empty baseBranch.");
	process.exit(2);
}

if (typeof packageJson.name !== "string" || packageJson.name.length === 0) {
	console.error("package.json must declare a non-empty package name.");
	process.exit(2);
}

const githubBaseBranch = process.env.GITHUB_BASE_REF;
const baseRef =
	process.env.GITHUB_ACTIONS === "true" && githubBaseBranch
		? `origin/${githubBaseBranch}`
		: (process.env.CHANGESET_BASE_REF ?? `origin/${changesetConfig.baseBranch}`);
const verifyBase = Bun.spawnSync(
	["git", "rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`],
	{
		cwd: root,
		stdout: "ignore",
		stderr: "ignore",
	},
);

if (verifyBase.exitCode !== 0) {
	console.error(`Changeset comparison ref '${baseRef}' is not available locally.`);
	console.error(
		process.env.GITHUB_ACTIONS === "true"
			? "Fetch the pull request base branch named by GITHUB_BASE_REF."
			: "Fetch the base branch from .changeset/config.json, or set CHANGESET_BASE_REF to an available ref.",
	);
	process.exit(2);
}

function gitOutput(args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		process.stderr.write(new TextDecoder().decode(result.stderr));
		process.exit(result.exitCode ?? 1);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

const mergeBase = gitOutput(["merge-base", baseRef, "HEAD"]);

function packageExportsAt(ref: string): unknown {
	const contents = gitOutput(["show", `${ref}:package.json`]);
	try {
		return (JSON.parse(contents) as { exports?: unknown }).exports;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Could not parse package.json at '${ref}': ${message}`);
		process.exit(2);
	}
}

function changedPaths(options: string[], paths: string[]): string[] {
	const diff = Bun.spawnSync(
		["git", "diff", "--name-only", ...options, `${baseRef}...HEAD`, "--", ...paths],
		{
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	if (diff.exitCode !== 0) {
		const stderr = new TextDecoder().decode(diff.stderr);
		if (stderr.includes("no merge base")) {
			console.error(`No merge base is available between '${baseRef}' and HEAD.`);
			console.error("Fetch enough history for the configured base branch and the current branch.");
		} else {
			process.stderr.write(stderr);
		}
		process.exit(diff.exitCode ?? 1);
	}

	return new TextDecoder()
		.decode(diff.stdout)
		.split("\n")
		.map((path) => path.trim())
		.filter(Boolean);
}

const sourceChanged = changedPaths([], ["src/", "bin/"]).length > 0;
const apiExtractorConfigChanged = changedPaths([], ["config/api-extractor/"]).length > 0;
const exportsChanged =
	JSON.stringify(packageExportsAt(mergeBase)) !== JSON.stringify(packageExportsAt("HEAD"));
const releaseRelevantChanged = sourceChanged || apiExtractorConfigChanged || exportsChanged;
const releaseRelevantReasons = [
	sourceChanged ? "source/bin files" : undefined,
	apiExtractorConfigChanged ? "API Extractor configs" : undefined,
	exportsChanged ? "package.json exports" : undefined,
].filter((reason): reason is string => reason !== undefined);
const ignoredChangesetNames = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
const addedChangesets = changedPaths(["--diff-filter=A"], [".changeset/"]).filter((path) => {
	const name = path.startsWith(".changeset/") ? path.slice(".changeset/".length) : path;
	return (
		!name.includes("/") &&
		!name.startsWith(".") &&
		name.endsWith(".md") &&
		!/^README\.md$/i.test(name) &&
		!ignoredChangesetNames.has(name)
	);
});

const validBumpTypes = new Set(["patch", "minor", "major"]);
let invalidChangeset = false;

for (const path of addedChangesets) {
	try {
		// @changesets/cli does not expose a parsing API; this is the parser it uses internally.
		const parsed = parseChangesetFile(readFileSync(resolve(root, path), "utf8"));
		for (const release of parsed.releases) {
			if (release.name !== packageJson.name) {
				throw new Error(
					`package '${release.name}' is not this workspace package ('${packageJson.name}')`,
				);
			}
			if (!validBumpTypes.has(release.type)) {
				throw new Error(
					`package '${release.name}' uses '${release.type}'; expected patch, minor, or major`,
				);
			}
		}
	} catch (error) {
		invalidChangeset = true;
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Invalid changeset '${path}': ${message}`);
	}
}

if (invalidChangeset) {
	process.exit(1);
}

if (releaseRelevantChanged && addedChangesets.length === 0) {
	console.error(
		`Release-relevant changes (${releaseRelevantReasons.join(", ")}) have no newly added changeset.`,
	);
	console.error(
		"Add a .changeset/*.md file, or use `bunx changeset --empty` for a no-release change.",
	);
	process.exit(1);
}

console.log(
	releaseRelevantChanged
		? `Valid new changeset present for release-relevant changes: ${releaseRelevantReasons.join(", ")}.`
		: "No release-relevant changes require a changeset.",
);
