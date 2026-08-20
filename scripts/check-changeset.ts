const baseRef = process.env.CHANGESET_BASE_REF ?? "origin/main";

const diff = Bun.spawnSync(["git", "diff", "--name-only", baseRef], {
  cwd: process.cwd(),
  stdout: "pipe",
  stderr: "pipe",
});

if (diff.exitCode !== 0) {
  process.stderr.write(new TextDecoder().decode(diff.stderr));
  process.exit(diff.exitCode ?? 1);
}

const changed = new TextDecoder()
  .decode(diff.stdout)
  .split("\n")
  .map((path) => path.trim())
  .filter(Boolean);
const sourceChanged = changed.some((path) => path.startsWith("src/") || path.startsWith("bin/"));
const changesetAdded = changed.some(
  (path) => path.startsWith(".changeset/") && path.endsWith(".md") && !path.endsWith("/README.md"),
);

if (sourceChanged && !changesetAdded) {
  console.error("Source or bin files changed without a changeset.");
  console.error("Add a .changeset/*.md file, or use `bunx changeset --empty` for a no-release change.");
  process.exit(1);
}

console.log(sourceChanged ? "Changeset present for source/bin changes." : "No source/bin changes require a changeset.");
