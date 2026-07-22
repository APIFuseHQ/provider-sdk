import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
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
});
