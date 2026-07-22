import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
	buildProviderCreatePlan,
	type CreateResolvedOptions,
} from "../cli/create.js";
import {
	buildPromptAssetManifest,
	buildPromptAssetPlanEntriesSync,
	formatPromptAssetIssues,
	PROMPT_ASSET_MANIFEST_PATH,
	syncPromptAssets,
	verifyPromptAssets,
} from "../cli/prompt-assets.js";

const repoRoot = dirname(dirname(import.meta.dir));
const syncAssetsCliPath = join(repoRoot, "bin", "apifuse-sync-assets.ts");
const sdkVersion = (
	JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }
).version;

const tempDirs: string[] = [];
const tempRoot = join(process.cwd(), ".tmp-provider-sdk-sync-assets-tests");

function makeTempDir(prefix: string): string {
	mkdirSync(tempRoot, { recursive: true });
	const dir = mkdtempSync(join(tempRoot, prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	rmSync(tempRoot, { recursive: true, force: true });
});

function createOptions(overrides: Partial<CreateResolvedOptions> = {}): CreateResolvedOptions {
	return {
		name: "weather-provider",
		displayName: "Weather Provider",
		category: "data",
		authMode: "none",
		runtime: "standard",
		preset: "standalone",
		dryRun: true,
		json: false,
		yes: true,
		...overrides,
	};
}

async function materializeScaffold(cwd: string): Promise<string> {
	const plan = await buildProviderCreatePlan(createOptions(), cwd);
	for (const file of plan.files) {
		mkdirSync(dirname(file.path), { recursive: true });
		if (file.kind === "symlink") {
			rmSync(file.path, { recursive: true, force: true });
			symlinkSync(file.content, file.path);
			continue;
		}
		writeFileSync(file.path, file.content);
	}
	return plan.providerRoot;
}

function runSyncAssetsCli(providerRoot: string, extraArgs: string[] = []) {
	return spawnSync("bun", [syncAssetsCliPath, providerRoot, ...extraArgs], {
		cwd: providerRoot,
		encoding: "utf8",
	});
}

describe("apifuse sync-assets", () => {
	it("treats a fresh scaffold as in sync: --check passes and a run is a no-op", async () => {
		const cwd = makeTempDir("sync-assets-fresh-");
		const providerRoot = await materializeScaffold(cwd);

		const verification = verifyPromptAssets(providerRoot);
		expect(verification).toEqual({
			ok: true,
			missing: [],
			stale: [],
			modified: [],
			legacy: [],
			unexpected: [],
		});

		const manifestBefore = readFileSync(join(providerRoot, PROMPT_ASSET_MANIFEST_PATH), "utf8");
		const result = syncPromptAssets(providerRoot);
		expect(result.changed).toBeFalse();
		expect(result.removed).toEqual([]);
		expect(result.wroteFiles).toEqual([]);
		expect(result.createdSymlinks).toEqual([]);
		expect(readFileSync(join(providerRoot, PROMPT_ASSET_MANIFEST_PATH), "utf8")).toBe(
			manifestBefore,
		);

		const cli = runSyncAssetsCli(providerRoot, ["--check"]);
		expect(cli.status).toBe(0);
		expect(cli.stdout).toContain("in sync");
	});

	it("migrates a legacy layout (top-level skills/, regular CLAUDE.md, no manifest)", async () => {
		const cwd = makeTempDir("sync-assets-legacy-");
		const providerRoot = await materializeScaffold(cwd);

		// Rewind to the legacy layout: real CLAUDE.md file, top-level skills/,
		// no .agents, no symlinks, no manifest.
		rmSync(join(providerRoot, ".agents"), { recursive: true, force: true });
		rmSync(join(providerRoot, ".claude"), { force: true });
		rmSync(join(providerRoot, ".codex"), { force: true });
		rmSync(join(providerRoot, ".apifuse"), { recursive: true, force: true });
		rmSync(join(providerRoot, "CLAUDE.md"), { force: true });
		writeFileSync(join(providerRoot, "CLAUDE.md"), "@AGENTS.md\n");
		mkdirSync(join(providerRoot, "skills", "normalization-standards"), { recursive: true });
		writeFileSync(
			join(providerRoot, "skills", "normalization-standards", "SKILL.md"),
			"legacy skill content\n",
		);

		const before = verifyPromptAssets(providerRoot);
		expect(before.ok).toBeFalse();
		expect(before.legacy.join("\n")).toContain("skills/");
		expect(before.missing).toContain(PROMPT_ASSET_MANIFEST_PATH);
		expect(before.modified.join("\n")).toContain("CLAUDE.md");

		const result = syncPromptAssets(providerRoot);
		expect(result.changed).toBeTrue();
		expect(result.removed).toContain("skills/");

		expect(existsSync(join(providerRoot, "skills"))).toBeFalse();
		expect(lstatSync(join(providerRoot, "CLAUDE.md")).isSymbolicLink()).toBeTrue();
		expect(readlinkSync(join(providerRoot, "CLAUDE.md"))).toBe("AGENTS.md");
		expect(lstatSync(join(providerRoot, ".claude")).isSymbolicLink()).toBeTrue();
		expect(readlinkSync(join(providerRoot, ".claude"))).toBe(".agents");
		expect(lstatSync(join(providerRoot, ".codex")).isSymbolicLink()).toBeTrue();
		expect(readlinkSync(join(providerRoot, ".codex"))).toBe(".agents");
		expect(
			lstatSync(
				join(providerRoot, ".agents", "skills", "normalization-standards", "SKILL.md"),
			).isFile(),
		).toBeTrue();

		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
	});

	it("fails --check on a tampered SKILL.md and restores it on the next run", async () => {
		const cwd = makeTempDir("sync-assets-tamper-");
		const providerRoot = await materializeScaffold(cwd);
		const skillPath = join(
			providerRoot,
			".agents",
			"skills",
			"pagination-and-counts",
			"SKILL.md",
		);
		const original = readFileSync(skillPath, "utf8");
		writeFileSync(skillPath, `${original}\ntampered by a well-meaning agent\n`);

		const verification = verifyPromptAssets(providerRoot);
		expect(verification.ok).toBeFalse();
		expect(verification.modified.join("\n")).toContain(
			".agents/skills/pagination-and-counts/SKILL.md",
		);

		const cli = runSyncAssetsCli(providerRoot, ["--check"]);
		expect(cli.status).toBe(1);
		expect(cli.stderr).toContain(".agents/skills/pagination-and-counts/SKILL.md");
		expect(cli.stderr).toContain("sync-assets");

		const result = syncPromptAssets(providerRoot);
		expect(result.wroteFiles).toContain(".agents/skills/pagination-and-counts/SKILL.md");
		expect(readFileSync(skillPath, "utf8")).toBe(original);
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
	});

	it("flags a wrong manifest sdkVersion as stale and refreshes it", async () => {
		const cwd = makeTempDir("sync-assets-stale-");
		const providerRoot = await materializeScaffold(cwd);
		const manifestPath = join(providerRoot, PROMPT_ASSET_MANIFEST_PATH);
		const entries = buildPromptAssetPlanEntriesSync();
		writeFileSync(manifestPath, buildPromptAssetManifest(entries, "0.0.0-old"));

		const verification = verifyPromptAssets(providerRoot);
		expect(verification.ok).toBeFalse();
		expect(verification.stale.join("\n")).toContain("0.0.0-old");
		expect(verification.stale.join("\n")).toContain(sdkVersion);

		const result = syncPromptAssets(providerRoot);
		expect(result.changed).toBeTrue();
		const refreshed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			schemaVersion: number;
			sdkVersion: string;
		};
		expect(refreshed.schemaVersion).toBe(2);
		expect(refreshed.sdkVersion).toBe(sdkVersion);
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
	});

	it("removes paths a pre-existing manifest managed that left the asset set", async () => {
		const cwd = makeTempDir("sync-assets-orphan-");
		const providerRoot = await materializeScaffold(cwd);

		// Simulate an older SDK that managed an extra skill file.
		const orphanRelPath = ".agents/skills/retired-skill/SKILL.md";
		const orphanAbsPath = join(providerRoot, orphanRelPath);
		mkdirSync(dirname(orphanAbsPath), { recursive: true });
		writeFileSync(orphanAbsPath, "retired skill\n");
		const manifestPath = join(providerRoot, PROMPT_ASSET_MANIFEST_PATH);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			paths: string[];
		};
		manifest.paths = [...manifest.paths, orphanRelPath].sort();
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

		const result = syncPromptAssets(providerRoot);
		expect(result.removed).toContain(orphanRelPath);
		expect(existsSync(orphanAbsPath)).toBeFalse();
		expect(existsSync(dirname(orphanAbsPath))).toBeFalse();
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
	});

	it("never deletes manifest-listed paths outside the managed namespaces", async () => {
		const cwd = makeTempDir("sync-assets-hostile-manifest-");
		const providerRoot = await materializeScaffold(cwd);

		mkdirSync(join(providerRoot, "src"), { recursive: true });
		writeFileSync(join(providerRoot, "src", "index.ts"), "export default 1;\n");
		mkdirSync(join(providerRoot, ".git"), { recursive: true });
		writeFileSync(join(providerRoot, ".git", "config"), "[core]\n");

		const manifestPath = join(providerRoot, PROMPT_ASSET_MANIFEST_PATH);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] };
		manifest.paths = [...manifest.paths, "src/index.ts", "src", ".git/config"].sort();
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

		const result = syncPromptAssets(providerRoot);
		expect(result.removed).toEqual([]);
		expect(readFileSync(join(providerRoot, "src", "index.ts"), "utf8")).toBe(
			"export default 1;\n",
		);
		expect(readFileSync(join(providerRoot, ".git", "config"), "utf8")).toBe("[core]\n");
	});

	it("never follows a symlinked directory out of the provider root during orphan cleanup", async () => {
		const cwd = makeTempDir("sync-assets-symlink-escape-");
		const providerRoot = await materializeScaffold(cwd);

		// Victim directory OUTSIDE the provider root, reachable through a
		// committed-style symlink inside a managed namespace.
		const outsideDir = join(cwd, "outside-victim");
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(join(outsideDir, "important.txt"), "do not delete\n");
		symlinkSync(outsideDir, join(providerRoot, ".agents", "linkdir"));

		const manifestPath = join(providerRoot, PROMPT_ASSET_MANIFEST_PATH);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] };
		manifest.paths = [...manifest.paths, ".agents/linkdir/important.txt"].sort();
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

		const result = syncPromptAssets(providerRoot);
		// Orphan cleanup never deletes the manifest-listed path through the link.
		expect(result.removed).not.toContain(".agents/linkdir/important.txt");
		expect(readFileSync(join(outsideDir, "important.txt"), "utf8")).toBe("do not delete\n");
		// A symlink at the `.agents/` root (not under the skills tree) is tool
		// content: sync never sweeps it, and it never resolves out of the root.
		expect(lstatSync(join(providerRoot, ".agents", "linkdir")).isSymbolicLink()).toBeTrue();
		expect(existsSync(join(outsideDir, "important.txt"))).toBeTrue();
	});

	it("flags a top-level `skills` symlink as legacy in verify and removes it in sync", async () => {
		const cwd = makeTempDir("sync-assets-skills-symlink-");
		const providerRoot = await materializeScaffold(cwd);
		symlinkSync(".agents/skills", join(providerRoot, "skills"));

		const verification = verifyPromptAssets(providerRoot);
		expect(verification.ok).toBeFalse();
		expect(verification.legacy.join("\n")).toContain("skills");
		expect(verification.legacy.join("\n")).toContain("symlink");

		const result = syncPromptAssets(providerRoot);
		expect(result.removed).toContain("skills/");
		expect(existsSync(join(providerRoot, "skills"))).toBeFalse();
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
		// verify-green implies sync-no-op.
		expect(syncPromptAssets(providerRoot).changed).toBeFalse();
	});

	it("rejects a symlinked .agents directory and replaces it with real files", async () => {
		const cwd = makeTempDir("sync-assets-agents-symlink-");
		const providerRoot = await materializeScaffold(cwd);

		// Move the managed tree outside the root and symlink .agents at it —
		// byte reads through the link would match, but the layout contract
		// requires .agents to be a real directory.
		const outsideAgents = join(cwd, "outside-agents");
		renameSync(join(providerRoot, ".agents"), outsideAgents);
		symlinkSync(outsideAgents, join(providerRoot, ".agents"));

		const verification = verifyPromptAssets(providerRoot);
		expect(verification.ok).toBeFalse();
		expect(verification.modified.join("\n")).toContain(
			".agents (expected a real directory, found a symlink)",
		);

		const result = syncPromptAssets(providerRoot);
		expect(result.changed).toBeTrue();
		expect(lstatSync(join(providerRoot, ".agents")).isDirectory()).toBeTrue();
		expect(lstatSync(join(providerRoot, ".agents")).isSymbolicLink()).toBeFalse();
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
		// The outside tree is left untouched (only the link is replaced).
		expect(
			lstatSync(join(outsideAgents, "skills", "normalization-standards", "SKILL.md")).isFile(),
		).toBeTrue();
	});

	it("rejects a symlinked .apifuse directory", async () => {
		const cwd = makeTempDir("sync-assets-apifuse-symlink-");
		const providerRoot = await materializeScaffold(cwd);

		const outsideApifuse = join(cwd, "outside-apifuse");
		renameSync(join(providerRoot, ".apifuse"), outsideApifuse);
		symlinkSync(outsideApifuse, join(providerRoot, ".apifuse"));

		const verification = verifyPromptAssets(providerRoot);
		expect(verification.ok).toBeFalse();
		expect(verification.modified.join("\n")).toContain(
			".apifuse (expected a real directory, found a symlink)",
		);

		const result = syncPromptAssets(providerRoot);
		expect(result.changed).toBeTrue();
		expect(lstatSync(join(providerRoot, ".apifuse")).isDirectory()).toBeTrue();
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
	});

	it("flags an unauthorized injected skill but never deletes it, and ignores non-skill files", async () => {
		const cwd = makeTempDir("sync-assets-injected-file-");
		const providerRoot = await materializeScaffold(cwd);
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();

		// A non-skill file at the `.agents/` root is tool/user content (it lands
		// there via the .claude/.codex symlinks) — it must NOT be flagged.
		writeFileSync(join(providerRoot, ".agents", "settings.json"), '{"tool":"config"}\n');
		// An unauthorized skill directory IS the injection vector: every agent CLI
		// auto-loads `.agents/skills/<name>/`.
		mkdirSync(join(providerRoot, ".agents", "skills", "injected"), { recursive: true });
		writeFileSync(
			join(providerRoot, ".agents", "skills", "injected", "SKILL.md"),
			"# injected skill\n",
		);

		const verification = verifyPromptAssets(providerRoot);
		expect(verification.ok).toBeFalse();
		expect(verification.unexpected).toContain(".agents/skills/injected/");
		expect(verification.unexpected).not.toContain(".agents/settings.json");
		expect(formatPromptAssetIssues(verification).join("\n")).toContain(
			"unexpected: .agents/skills/injected/",
		);

		// sync-assets NEVER deletes: the injected skill and the tool config both
		// survive (a human removes the injected skill after the gate flags it).
		const result = syncPromptAssets(providerRoot);
		expect(result.removed).not.toContain(".agents/skills/injected/");
		expect(result.removed).toEqual([]);
		expect(
			readFileSync(join(providerRoot, ".agents", "skills", "injected", "SKILL.md"), "utf8"),
		).toBe("# injected skill\n");
		expect(readFileSync(join(providerRoot, ".agents", "settings.json"), "utf8")).toBe(
			'{"tool":"config"}\n',
		);
		// The gate stays red until the human removes the injected skill.
		expect(verifyPromptAssets(providerRoot).ok).toBeFalse();
	});

	it("preserves a contributor-authored upstream-notes file: check passes and sync is a no-op", async () => {
		const cwd = makeTempDir("sync-assets-upstream-notes-authored-");
		const providerRoot = await materializeScaffold(cwd);

		// The upstream-notes README template instructs contributors to ADD
		// sibling note files; they are contributor-owned, never flagged.
		const notePath = join(providerRoot, ".agents", "skills", "upstream-notes", "foo.md");
		writeFileSync(notePath, "# vendor foo\nSymptom -> Cause -> Rule -> Evidence\n");

		const verification = verifyPromptAssets(providerRoot);
		expect(verification.ok).toBeTrue();
		expect(verification.unexpected).toEqual([]);

		const cli = runSyncAssetsCli(providerRoot, ["--check"]);
		expect(cli.status).toBe(0);
		expect(cli.stdout).toContain("in sync");

		const result = syncPromptAssets(providerRoot);
		expect(result.changed).toBeFalse();
		expect(result.removed).toEqual([]);
		expect(existsSync(notePath)).toBeTrue();
		expect(readFileSync(notePath, "utf8")).toContain("# vendor foo");
	});

	it("keeps the upstream-notes README.md managed: tampering fails the gate and sync restores it", async () => {
		const cwd = makeTempDir("sync-assets-upstream-notes-readme-");
		const providerRoot = await materializeScaffold(cwd);
		const readmePath = join(providerRoot, ".agents", "skills", "upstream-notes", "README.md");
		const original = readFileSync(readmePath, "utf8");
		writeFileSync(readmePath, `${original}\nsmuggled guidance\n`);

		const verification = verifyPromptAssets(providerRoot);
		expect(verification.ok).toBeFalse();
		expect(verification.modified.join("\n")).toContain(
			".agents/skills/upstream-notes/README.md",
		);

		const result = syncPromptAssets(providerRoot);
		expect(result.wroteFiles).toContain(".agents/skills/upstream-notes/README.md");
		expect(readFileSync(readmePath, "utf8")).toBe(original);
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
	});

	it("relocates legacy skills/upstream-notes authored notes instead of destroying them", async () => {
		const cwd = makeTempDir("sync-assets-upstream-notes-legacy-");
		const providerRoot = await materializeScaffold(cwd);

		// Rewind to a legacy layout carrying an authored upstream note.
		rmSync(join(providerRoot, ".agents"), { recursive: true, force: true });
		rmSync(join(providerRoot, ".claude"), { force: true });
		rmSync(join(providerRoot, ".codex"), { force: true });
		rmSync(join(providerRoot, ".apifuse"), { recursive: true, force: true });
		rmSync(join(providerRoot, "CLAUDE.md"), { force: true });
		writeFileSync(join(providerRoot, "CLAUDE.md"), "@AGENTS.md\n");
		mkdirSync(join(providerRoot, "skills", "upstream-notes"), { recursive: true });
		writeFileSync(
			join(providerRoot, "skills", "upstream-notes", "README.md"),
			"legacy readme that must be regenerated\n",
		);
		writeFileSync(
			join(providerRoot, "skills", "upstream-notes", "bar.md"),
			"# vendor bar\nhard-won upstream quirk\n",
		);

		const result = syncPromptAssets(providerRoot);
		expect(result.changed).toBeTrue();
		expect(result.removed).toContain("skills/");
		expect(result.wroteFiles).toContain(".agents/skills/upstream-notes/bar.md");

		// Legacy tree is gone; the authored note survives at the managed path.
		expect(existsSync(join(providerRoot, "skills"))).toBeFalse();
		const relocated = join(providerRoot, ".agents", "skills", "upstream-notes", "bar.md");
		expect(existsSync(relocated)).toBeTrue();
		expect(readFileSync(relocated, "utf8")).toContain("hard-won upstream quirk");
		// README.md is regenerated from the template, not the stale legacy copy.
		expect(
			readFileSync(
				join(providerRoot, ".agents", "skills", "upstream-notes", "README.md"),
				"utf8",
			),
		).not.toContain("legacy readme that must be regenerated");
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
	});

	it("never follows a hostile symlink named under upstream-notes", async () => {
		const cwd = makeTempDir("sync-assets-upstream-notes-symlink-escape-");
		const providerRoot = await materializeScaffold(cwd);

		// Victim outside the provider root, reachable through a symlink planted
		// inside the contributor-owned zone — the exemption must not let it
		// escape.
		const outsideDir = join(cwd, "outside-victim");
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(join(outsideDir, "important.txt"), "do not delete\n");
		symlinkSync(outsideDir, join(providerRoot, ".agents", "skills", "upstream-notes", "linkdir"));

		const manifestPath = join(providerRoot, PROMPT_ASSET_MANIFEST_PATH);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] };
		manifest.paths = [
			...manifest.paths,
			".agents/skills/upstream-notes/linkdir/important.txt",
		].sort();
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

		// A symlink is never contributor-owned: the gate flags it even under
		// upstream-notes.
		const verification = verifyPromptAssets(providerRoot);
		expect(verification.ok).toBeFalse();
		expect(verification.unexpected).toContain(".agents/skills/upstream-notes/linkdir");

		const result = syncPromptAssets(providerRoot);
		// Orphan cleanup never deletes through the link, and sync never sweeps:
		// the flagged symlink is preserved (a human removes it) and never
		// followed, so the outside victim is untouched.
		expect(result.removed).not.toContain(".agents/skills/upstream-notes/linkdir/important.txt");
		expect(result.removed).not.toContain(".agents/skills/upstream-notes/linkdir");
		expect(
			lstatSync(
				join(providerRoot, ".agents", "skills", "upstream-notes", "linkdir"),
			).isSymbolicLink(),
		).toBeTrue();
		expect(readFileSync(join(outsideDir, "important.txt"), "utf8")).toBe("do not delete\n");
		expect(existsSync(join(outsideDir, "important.txt"))).toBeTrue();
		// The gate stays red while the symlink remains.
		expect(verifyPromptAssets(providerRoot).ok).toBeFalse();
	});

	it("never recursively deletes a managed directory named by a manifest entry (protects authored notes)", async () => {
		const cwd = makeTempDir("sync-assets-dir-orphan-");
		const providerRoot = await materializeScaffold(cwd);

		const notePath = join(providerRoot, ".agents", "skills", "upstream-notes", "foo.md");
		writeFileSync(notePath, "# vendor foo\nhard-won quirk\n");

		const manifestPath = join(providerRoot, PROMPT_ASSET_MANIFEST_PATH);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] };
		// A hostile/stale manifest lists DIRECTORIES inside the managed namespace;
		// a recursive delete of these would destroy contributor-authored notes.
		manifest.paths = [...manifest.paths, ".agents/skills", ".agents/skills/upstream-notes"].sort();
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

		const result = syncPromptAssets(providerRoot);
		expect(result.removed).not.toContain(".agents/skills");
		expect(result.removed).not.toContain(".agents/skills/upstream-notes");
		expect(existsSync(notePath)).toBeTrue();
		expect(readFileSync(notePath, "utf8")).toContain("hard-won quirk");
		expect(
			existsSync(join(providerRoot, ".agents", "skills", "normalization-standards", "SKILL.md")),
		).toBeTrue();
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
	});

	it("flags a nested symlink under upstream-notes via sync-assets --check and never follows it", async () => {
		const cwd = makeTempDir("sync-assets-nested-upstream-symlink-");
		const providerRoot = await materializeScaffold(cwd);

		const outsideDir = join(cwd, "outside-victim");
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(join(outsideDir, "important.txt"), "do not delete\n");

		// Authored (contributor-owned) subdirectory hiding a nested escape symlink.
		const vendorDir = join(providerRoot, ".agents", "skills", "upstream-notes", "vendor");
		mkdirSync(vendorDir, { recursive: true });
		writeFileSync(join(vendorDir, "notes.md"), "# vendor notes\n");
		symlinkSync(outsideDir, join(vendorDir, "evil"));

		// The nested symlink must be visible to verification even though it lives
		// below an authored (exempt) directory; the authored file stays exempt.
		const verification = verifyPromptAssets(providerRoot);
		expect(verification.ok).toBeFalse();
		expect(verification.unexpected).toContain(".agents/skills/upstream-notes/vendor/evil");
		expect(verification.unexpected).not.toContain(
			".agents/skills/upstream-notes/vendor/notes.md",
		);

		const cli = runSyncAssetsCli(providerRoot, ["--check"]);
		expect(cli.status).toBe(1);
		expect(cli.stderr).toContain(".agents/skills/upstream-notes/vendor/evil");

		const result = syncPromptAssets(providerRoot);
		// sync never sweeps: the nested symlink is preserved (a human removes it)
		// and never followed; the authored note and outside victim are untouched.
		expect(result.removed).not.toContain(".agents/skills/upstream-notes/vendor/evil");
		expect(lstatSync(join(vendorDir, "evil")).isSymbolicLink()).toBeTrue();
		expect(readFileSync(join(outsideDir, "important.txt"), "utf8")).toBe("do not delete\n");
		expect(existsSync(join(vendorDir, "notes.md"))).toBeTrue();
		// The gate stays red while the nested symlink remains.
		expect(verifyPromptAssets(providerRoot).ok).toBeFalse();
	});

	it("never overwrites a newer .agents upstream-note when migrating a conflicting legacy copy", async () => {
		const cwd = makeTempDir("sync-assets-upstream-notes-conflict-");
		const providerRoot = await materializeScaffold(cwd);

		// Manually-migrated (newer) note already lives under .agents.
		const destPath = join(providerRoot, ".agents", "skills", "upstream-notes", "foo.md");
		writeFileSync(destPath, "# vendor foo (NEWER, hand-authored)\n");

		// A stale legacy copy with DIFFERENT content still sits under skills/.
		mkdirSync(join(providerRoot, "skills", "upstream-notes"), { recursive: true });
		writeFileSync(
			join(providerRoot, "skills", "upstream-notes", "foo.md"),
			"# vendor foo (older legacy copy)\n",
		);

		const result = syncPromptAssets(providerRoot);
		expect(result.removed).toContain("skills/");

		// The newer .agents note is byte-unchanged.
		expect(readFileSync(destPath, "utf8")).toBe("# vendor foo (NEWER, hand-authored)\n");
		// The legacy content is preserved at a non-colliding conflict path.
		const conflictPath = join(
			providerRoot,
			".agents",
			"skills",
			"upstream-notes",
			"foo.legacy.md",
		);
		expect(existsSync(conflictPath)).toBeTrue();
		expect(readFileSync(conflictPath, "utf8")).toBe("# vendor foo (older legacy copy)\n");
		expect(result.wroteFiles).toContain(".agents/skills/upstream-notes/foo.legacy.md");
		expect(existsSync(join(providerRoot, "skills"))).toBeFalse();
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
	});

	it("drops a byte-identical legacy upstream-note without creating a conflict file", async () => {
		const cwd = makeTempDir("sync-assets-upstream-notes-identical-");
		const providerRoot = await materializeScaffold(cwd);

		const destPath = join(providerRoot, ".agents", "skills", "upstream-notes", "foo.md");
		writeFileSync(destPath, "# vendor foo (identical bytes)\n");
		mkdirSync(join(providerRoot, "skills", "upstream-notes"), { recursive: true });
		writeFileSync(
			join(providerRoot, "skills", "upstream-notes", "foo.md"),
			"# vendor foo (identical bytes)\n",
		);

		const result = syncPromptAssets(providerRoot);
		expect(result.removed).toContain("skills/");

		// Destination unchanged, legacy dropped, no conflict file created.
		expect(readFileSync(destPath, "utf8")).toBe("# vendor foo (identical bytes)\n");
		expect(
			existsSync(join(providerRoot, ".agents", "skills", "upstream-notes", "foo.legacy.md")),
		).toBeFalse();
		expect(result.wroteFiles).not.toContain(".agents/skills/upstream-notes/foo.legacy.md");
		expect(existsSync(join(providerRoot, "skills"))).toBeFalse();
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
	});

	it("fails loudly and non-destructively when .claude is a real directory", async () => {
		const cwd = makeTempDir("sync-assets-claude-real-dir-");
		const providerRoot = await materializeScaffold(cwd);

		// Replace the managed .claude symlink with a real user-authored config dir.
		rmSync(join(providerRoot, ".claude"), { force: true });
		mkdirSync(join(providerRoot, ".claude", "commands"), { recursive: true });
		writeFileSync(join(providerRoot, ".claude", "commands", "foo.md"), "# my command\n");
		writeFileSync(join(providerRoot, ".claude", "settings.json"), '{"hooks":true}\n');

		// sync-assets throws, names the path, and touches nothing.
		expect(() => syncPromptAssets(providerRoot)).toThrow(".claude");
		expect(lstatSync(join(providerRoot, ".claude")).isDirectory()).toBeTrue();
		expect(readFileSync(join(providerRoot, ".claude", "commands", "foo.md"), "utf8")).toBe(
			"# my command\n",
		);
		expect(readFileSync(join(providerRoot, ".claude", "settings.json"), "utf8")).toBe(
			'{"hooks":true}\n',
		);

		// verify reports the distinct migration-required reason, never `unexpected`.
		const verification = verifyPromptAssets(providerRoot);
		expect(verification.ok).toBeFalse();
		expect(verification.modified.join("\n")).toContain(
			".claude (must be a symlink to .agents; migrate its contents first)",
		);
		expect(verification.unexpected).not.toContain(".claude");
		expect(verification.unexpected).not.toContain(".claude/");

		// The CLI --check surfaces the same failure and exits 1.
		const check = runSyncAssetsCli(providerRoot, ["--check"]);
		expect(check.status).toBe(1);
		expect(check.stderr).toContain("must be a symlink to .agents");

		// A plain sync-assets run also exits non-zero with a message naming .claude,
		// and still destroys nothing.
		const run = runSyncAssetsCli(providerRoot);
		expect(run.status).toBe(1);
		expect(run.stderr).toContain(".claude");
		expect(existsSync(join(providerRoot, ".claude", "commands", "foo.md"))).toBeTrue();
	});

	it("leaves already-correct .claude/.codex symlinks untouched (no-op)", async () => {
		const cwd = makeTempDir("sync-assets-symlink-noop-");
		const providerRoot = await materializeScaffold(cwd);

		const result = syncPromptAssets(providerRoot);
		expect(result.changed).toBeFalse();
		expect(result.wroteFiles).toEqual([]);
		expect(result.removed).toEqual([]);
		expect(lstatSync(join(providerRoot, ".claude")).isSymbolicLink()).toBeTrue();
		expect(readlinkSync(join(providerRoot, ".claude"))).toBe(".agents");
		expect(lstatSync(join(providerRoot, ".codex")).isSymbolicLink()).toBeTrue();
		expect(readlinkSync(join(providerRoot, ".codex"))).toBe(".agents");
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
	});

	it("converges and stays green after the user removes a previously-real .claude directory", async () => {
		const cwd = makeTempDir("sync-assets-claude-converge-");
		const providerRoot = await materializeScaffold(cwd);

		// Provider is in the failing state: .claude is a real directory.
		rmSync(join(providerRoot, ".claude"), { force: true });
		mkdirSync(join(providerRoot, ".claude"), { recursive: true });
		writeFileSync(join(providerRoot, ".claude", "settings.json"), "{}\n");
		expect(() => syncPromptAssets(providerRoot)).toThrow(".claude");

		// User reconciles by hand: relocates content and removes the directory.
		rmSync(join(providerRoot, ".claude"), { recursive: true, force: true });

		// Sync now converges (creates the symlink); a second run is an idempotent no-op.
		const first = syncPromptAssets(providerRoot);
		expect(first.changed).toBeTrue();
		expect(lstatSync(join(providerRoot, ".claude")).isSymbolicLink()).toBeTrue();
		expect(readlinkSync(join(providerRoot, ".claude"))).toBe(".agents");
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();

		const second = syncPromptAssets(providerRoot);
		expect(second.changed).toBeFalse();
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
	});

	it("preserves tool config written under .agents (via .claude/.codex): check passes, sync idempotent", async () => {
		const cwd = makeTempDir("sync-assets-tool-config-");
		const providerRoot = await materializeScaffold(cwd);
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();

		// Agent CLIs write project config through the .claude/.codex symlinks, so
		// the files physically land under .agents/.
		writeFileSync(join(providerRoot, ".claude", "settings.json"), '{"a":1}\n');
		writeFileSync(join(providerRoot, ".claude", "settings.local.json"), '{"b":2}\n');
		mkdirSync(join(providerRoot, ".claude", "commands"), { recursive: true });
		writeFileSync(join(providerRoot, ".claude", "commands", "deploy.md"), "# deploy\n");
		writeFileSync(join(providerRoot, ".codex", "config.toml"), 'model = "x"\n');

		// The gate stays green — none of this is the guidance-injection vector.
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
		const check = runSyncAssetsCli(providerRoot, ["--check"]);
		expect(check.status).toBe(0);

		// Two consecutive sync runs are no-ops and lose nothing.
		expect(syncPromptAssets(providerRoot).changed).toBeFalse();
		expect(syncPromptAssets(providerRoot).changed).toBeFalse();

		expect(readFileSync(join(providerRoot, ".agents", "settings.json"), "utf8")).toBe('{"a":1}\n');
		expect(readFileSync(join(providerRoot, ".agents", "settings.local.json"), "utf8")).toBe(
			'{"b":2}\n',
		);
		expect(readFileSync(join(providerRoot, ".agents", "commands", "deploy.md"), "utf8")).toBe(
			"# deploy\n",
		);
		expect(readFileSync(join(providerRoot, ".agents", "config.toml"), "utf8")).toBe('model = "x"\n');
		// Reachable through the symlinks post-sync.
		expect(readFileSync(join(providerRoot, ".claude", "settings.json"), "utf8")).toBe('{"a":1}\n');
		expect(readFileSync(join(providerRoot, ".codex", "config.toml"), "utf8")).toBe('model = "x"\n');
	});

	it("sync-assets (default mode) exits non-zero on an injected skill, never deletes it, converges after removal", async () => {
		const cwd = makeTempDir("sync-assets-cli-injected-skill-");
		const providerRoot = await materializeScaffold(cwd);
		mkdirSync(join(providerRoot, ".agents", "skills", "pwn"), { recursive: true });
		writeFileSync(join(providerRoot, ".agents", "skills", "pwn", "SKILL.md"), "# pwn\n");

		const run = runSyncAssetsCli(providerRoot);
		expect(run.status).toBe(1);
		const out = `${run.stdout}\n${run.stderr}`;
		expect(out).toContain(".agents/skills/pwn/");
		expect(out).not.toContain("already in sync");
		// The injected skill is preserved (a human must remove it), never deleted.
		expect(existsSync(join(providerRoot, ".agents", "skills", "pwn", "SKILL.md"))).toBeTrue();

		// After the user removes it by hand, sync-assets converges and exits 0.
		rmSync(join(providerRoot, ".agents", "skills", "pwn"), { recursive: true, force: true });
		const ok = runSyncAssetsCli(providerRoot);
		expect(ok.status).toBe(0);
	});

	it("sync-assets (default mode) reports 'already in sync' and exits 0 on a clean provider", async () => {
		const cwd = makeTempDir("sync-assets-cli-clean-");
		const providerRoot = await materializeScaffold(cwd);
		const run = runSyncAssetsCli(providerRoot);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("already in sync");
	});

	it("sync-assets (default mode) converges to exit 0 when only managed writes are needed", async () => {
		const cwd = makeTempDir("sync-assets-cli-managed-writes-");
		const providerRoot = await materializeScaffold(cwd);
		const skillPath = join(providerRoot, ".agents", "skills", "pagination-and-counts", "SKILL.md");
		writeFileSync(skillPath, "tampered\n");

		const run = runSyncAssetsCli(providerRoot);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("Prompt assets synced");
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
	});

	it("preserves a legacy upstream-note when .agents is a symlink to an outside dir with identical bytes", async () => {
		const cwd = makeTempDir("sync-assets-agents-symlink-legacy-note-");
		const providerRoot = await materializeScaffold(cwd);

		const noteBytes = "# vendor foo\nhard-won quirk\n";

		// Move the real .agents outside and symlink .agents at it; the outside
		// tree already holds an identical-bytes upstream note.
		const outsideAgents = join(cwd, "outside-agents");
		renameSync(join(providerRoot, ".agents"), outsideAgents);
		mkdirSync(join(outsideAgents, "skills", "upstream-notes"), { recursive: true });
		writeFileSync(join(outsideAgents, "skills", "upstream-notes", "foo.md"), noteBytes);
		symlinkSync(outsideAgents, join(providerRoot, ".agents"));

		// Legacy top-level skills/ carries the SAME note (identical bytes) — the
		// through-symlink duplicate check would otherwise drop it as redundant.
		mkdirSync(join(providerRoot, "skills", "upstream-notes"), { recursive: true });
		writeFileSync(join(providerRoot, "skills", "upstream-notes", "foo.md"), noteBytes);

		const result = syncPromptAssets(providerRoot);
		expect(result.changed).toBeTrue();

		// .agents is now a REAL directory (the symlink was normalized away first).
		expect(lstatSync(join(providerRoot, ".agents")).isDirectory()).toBeTrue();
		expect(lstatSync(join(providerRoot, ".agents")).isSymbolicLink()).toBeFalse();
		// The contributor note survives in the real tree — not dropped as redundant.
		const notePath = join(providerRoot, ".agents", "skills", "upstream-notes", "foo.md");
		expect(existsSync(notePath)).toBeTrue();
		expect(readFileSync(notePath, "utf8")).toBe(noteBytes);
		// Legacy skills/ is gone, verify is green, and the outside tree is untouched.
		expect(existsSync(join(providerRoot, "skills"))).toBeFalse();
		expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
		expect(readFileSync(join(outsideAgents, "skills", "upstream-notes", "foo.md"), "utf8")).toBe(
			noteBytes,
		);
	});

	// Same hazard at every nested level of the managed ancestor chain: step 0
	// normalizes the WHOLE chain, so a symlink at any depth cannot make the
	// duplicate check read an outside file and drop the note.
	for (const symlinkRel of [".agents/skills", ".agents/skills/upstream-notes"]) {
		it(`preserves a legacy upstream-note when ${symlinkRel} is a symlink to an outside dir with identical bytes`, async () => {
			const cwd = makeTempDir("sync-assets-nested-symlink-note-");
			const providerRoot = await materializeScaffold(cwd);
			const noteBytes = "# vendor foo\nhard-won quirk\n";

			// Move the chosen managed subtree outside and symlink it back; seed the
			// outside target with an identical-bytes note at the upstream-notes path.
			const outsideDir = join(cwd, `outside-${symlinkRel.replace(/[/.]/g, "_")}`);
			renameSync(join(providerRoot, symlinkRel), outsideDir);
			const innerNoteRel = ".agents/skills/upstream-notes/foo.md".slice(symlinkRel.length + 1);
			const outsideNotePath = join(outsideDir, innerNoteRel);
			mkdirSync(dirname(outsideNotePath), { recursive: true });
			writeFileSync(outsideNotePath, noteBytes);
			symlinkSync(outsideDir, join(providerRoot, symlinkRel));

			// Legacy top-level skills/ carries the same note (identical bytes).
			mkdirSync(join(providerRoot, "skills", "upstream-notes"), { recursive: true });
			writeFileSync(join(providerRoot, "skills", "upstream-notes", "foo.md"), noteBytes);

			const result = syncPromptAssets(providerRoot);
			expect(result.changed).toBeTrue();

			// The whole managed ancestor chain is real again (no level is a symlink).
			expect(lstatSync(join(providerRoot, ".agents")).isSymbolicLink()).toBeFalse();
			expect(lstatSync(join(providerRoot, ".agents", "skills")).isSymbolicLink()).toBeFalse();
			expect(
				lstatSync(join(providerRoot, ".agents", "skills", "upstream-notes")).isSymbolicLink(),
			).toBeFalse();

			// The contributor note survives in the REAL tree — not dropped as redundant.
			const notePath = join(providerRoot, ".agents", "skills", "upstream-notes", "foo.md");
			expect(existsSync(notePath)).toBeTrue();
			expect(readFileSync(notePath, "utf8")).toBe(noteBytes);
			// Legacy skills/ gone, verify green, outside target untouched.
			expect(existsSync(join(providerRoot, "skills"))).toBeFalse();
			expect(verifyPromptAssets(providerRoot).ok).toBeTrue();
			expect(readFileSync(outsideNotePath, "utf8")).toBe(noteBytes);
		});
	}

	it("flags a symlink directly under .agents/skills/ but ignores a symlink at the .agents/ root", async () => {
		const cwd = makeTempDir("sync-assets-injected-symlink-");
		const providerRoot = await materializeScaffold(cwd);

		// A symlink at the `.agents/` root is tool content (agent CLIs may write
		// links there via .claude/.codex) — NOT the guidance-injection vector.
		symlinkSync("AGENTS.md", join(providerRoot, ".agents", "root-alias.md"));
		// A symlink directly under the auto-loaded skills tree IS the vector.
		symlinkSync("normalization-standards/SKILL.md", join(providerRoot, ".agents", "skills", "alias.md"));

		const verification = verifyPromptAssets(providerRoot);
		expect(verification.ok).toBeFalse();
		expect(verification.unexpected).toContain(".agents/skills/alias.md");
		expect(verification.unexpected).not.toContain(".agents/root-alias.md");

		// sync never sweeps: both links survive (a human removes the skills-tree
		// one after the gate flags it); neither is followed.
		const result = syncPromptAssets(providerRoot);
		expect(result.removed).toEqual([]);
		expect(lstatSync(join(providerRoot, ".agents", "skills", "alias.md")).isSymbolicLink()).toBeTrue();
		expect(lstatSync(join(providerRoot, ".agents", "root-alias.md")).isSymbolicLink()).toBeTrue();
		expect(verifyPromptAssets(providerRoot).ok).toBeFalse();
	});
});
