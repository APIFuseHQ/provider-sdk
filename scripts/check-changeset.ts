import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const changesetConfig = JSON.parse(
	readFileSync(resolve(root, ".changeset", "config.json"), "utf8"),
) as {
	baseBranch?: unknown;
};

if (typeof changesetConfig.baseBranch !== "string" || changesetConfig.baseBranch.length === 0) {
	console.error(".changeset/config.json must declare a non-empty baseBranch.");
	process.exit(2);
}

const baseRef = process.env.CHANGESET_BASE_REF ?? `origin/${changesetConfig.baseBranch}`;
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
		"Fetch the base branch from .changeset/config.json, or set CHANGESET_BASE_REF to an available ref.",
	);
	process.exit(2);
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
const ignoredChangesetNames = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
const changesetAdded = changedPaths(["--diff-filter=A"], [".changeset/"]).some((path) => {
	const name = path.startsWith(".changeset/") ? path.slice(".changeset/".length) : path;
	return (
		!name.includes("/") &&
		!name.startsWith(".") &&
		name.endsWith(".md") &&
		!/^README\.md$/i.test(name) &&
		!ignoredChangesetNames.has(name)
	);
});

if (sourceChanged && !changesetAdded) {
	console.error("Source or bin files changed without a newly added changeset.");
	console.error(
		"Add a .changeset/*.md file, or use `bunx changeset --empty` for a no-release change.",
	);
	process.exit(1);
}

console.log(
	sourceChanged
		? "New changeset present for source/bin changes."
		: "No source/bin changes require a changeset.",
);
