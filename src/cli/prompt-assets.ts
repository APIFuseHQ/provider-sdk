import {
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import packageJson from "../../package.json";

/**
 * SDK-managed agent prompt assets.
 *
 * `apifuse create` scaffolds these files, `apifuse sync-assets` regenerates
 * them in an existing provider root, and `apifuse check` / `submit-check`
 * enforce that they byte-match the installed SDK version (fail closed).
 *
 * Layout contract:
 * - AGENTS.md                     — real file (agent guide)
 * - CLAUDE.md                     — symlink -> AGENTS.md
 * - .agents/skills/<skill>/SKILL.md — real files
 * - .agents/skills/upstream-notes/README.md — real file
 * - .claude / .codex              — symlinks -> .agents
 * - .apifuse/prompt-assets.json   — manifest (schema v2), written last
 */

export const PROMPT_ASSET_MANIFEST_PATH = ".apifuse/prompt-assets.json";
export const PROMPT_ASSET_MANIFEST_SCHEMA_VERSION = 2;
export const PROMPT_ASSET_SYNC_REMEDIATION =
	"Run `bun run sync-assets` (or `bunx apifuse sync-assets .`) to regenerate the SDK-managed agent prompt assets.";

export const PROMPT_ASSET_SYMLINKS: Readonly<Record<string, string>> = {
	"CLAUDE.md": "AGENTS.md",
	".claude": ".agents",
	".codex": ".agents",
};

/** Legacy layout remnants that must not survive a sync (pre-.agents layout). */
const LEGACY_TOP_LEVEL_SKILLS_DIR = "skills";

/** Relative asset paths whose content is rendered from `<path>.tpl`. */
export const PROMPT_ASSET_FILE_PATHS: readonly string[] = [
	"AGENTS.md",
	".agents/skills/normalization-standards/SKILL.md",
	".agents/skills/upstream-contract-verification/SKILL.md",
	".agents/skills/fixtures-and-recording/SKILL.md",
	".agents/skills/pagination-and-counts/SKILL.md",
	".agents/skills/health-checks-and-fail-closed/SKILL.md",
	".agents/skills/upstream-notes/README.md",
];

export type PromptAssetKind = "file" | "symlink";

export type PromptAssetEntry = {
	/** Provider-root-relative path (POSIX separators). */
	path: string;
	/** File content, or the symlink target for kind "symlink". */
	content: string;
	kind: PromptAssetKind;
};

export type PromptAssetTemplateRenderer = (
	fileName: string,
	values: Record<string, string>,
) => string | Promise<string>;

export type PromptAssetVerification = {
	ok: boolean;
	/** Expected paths (or the manifest) absent on disk. */
	missing: string[];
	/** Manifest recorded for a different SDK version than the installed one. */
	stale: string[];
	/** Files/symlinks/manifest whose bytes or target differ from the regenerated set. */
	modified: string[];
	/** Legacy layout remnants (top-level skills/). */
	legacy: string[];
};

export type PromptAssetSyncResult = {
	changed: boolean;
	removed: string[];
	wroteFiles: string[];
	createdSymlinks: string[];
	manifestPath: string;
};

const TEMPLATE_DIR = fileURLToPath(new URL("./templates/provider/", import.meta.url));

function renderPromptAssetTemplateSync(fileName: string): string {
	const template = readFileSync(resolve(TEMPLATE_DIR, fileName), "utf8");
	// Prompt asset templates take no values; mirror create.ts renderTemplate
	// semantics (unknown keys render as empty strings) for byte-identical output.
	return template.replace(/\{\{([A-Z_]+)\}\}/g, () => "");
}

/**
 * Build the full managed asset entry list (files first, symlinks after,
 * manifest excluded). The renderer is injected so `apifuse create` can reuse
 * its own template renderer; sync/verify use the SDK-internal renderer.
 */
export async function buildPromptAssetPlanEntries(
	renderTemplate: PromptAssetTemplateRenderer,
): Promise<PromptAssetEntry[]> {
	const entries: PromptAssetEntry[] = [];
	for (const assetPath of PROMPT_ASSET_FILE_PATHS) {
		entries.push({
			path: assetPath,
			content: await renderTemplate(`${assetPath}.tpl`, {}),
			kind: "file",
		});
	}
	for (const [linkPath, target] of Object.entries(PROMPT_ASSET_SYMLINKS)) {
		entries.push({ path: linkPath, content: target, kind: "symlink" });
	}
	return entries;
}

export function buildPromptAssetPlanEntriesSync(): PromptAssetEntry[] {
	const entries: PromptAssetEntry[] = [];
	for (const assetPath of PROMPT_ASSET_FILE_PATHS) {
		entries.push({
			path: assetPath,
			content: renderPromptAssetTemplateSync(`${assetPath}.tpl`),
			kind: "file",
		});
	}
	for (const [linkPath, target] of Object.entries(PROMPT_ASSET_SYMLINKS)) {
		entries.push({ path: linkPath, content: target, kind: "symlink" });
	}
	return entries;
}

/**
 * Deterministic manifest serialization: schema v2, 2-space JSON, trailing
 * newline, sorted paths (including symlink paths, excluding the manifest
 * itself). `sdkVersion` + `paths` keep their v1 semantics so older parsers
 * keep working; `schemaVersion` and `symlinks` are additive.
 */
export function buildPromptAssetManifest(
	entries: readonly PromptAssetEntry[],
	sdkVersion: string,
): string {
	const paths = entries.map((entry) => entry.path).sort();
	return `${JSON.stringify(
		{
			schemaVersion: PROMPT_ASSET_MANIFEST_SCHEMA_VERSION,
			sdkVersion,
			paths,
			symlinks: PROMPT_ASSET_SYMLINKS,
		},
		null,
		2,
	)}\n`;
}

export function installedSdkVersion(): string {
	return packageJson.version;
}

function lstatSafe(path: string) {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

function readManifestRaw(manifestAbsPath: string): string | undefined {
	const stat = lstatSafe(manifestAbsPath);
	if (!stat?.isFile()) {
		return undefined;
	}
	return readFileSync(manifestAbsPath, "utf8");
}

function parseManifest(raw: string): { sdkVersion?: string; paths: string[] } {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) {
			return { paths: [] };
		}
		const record = parsed as Record<string, unknown>;
		const sdkVersion = typeof record.sdkVersion === "string" ? record.sdkVersion : undefined;
		const paths = Array.isArray(record.paths)
			? record.paths.filter((value): value is string => typeof value === "string")
			: [];
		return { sdkVersion, paths };
	} catch {
		return { paths: [] };
	}
}

/** Reject manifest paths that could escape the provider root. */
function isSafeRelativeAssetPath(relativePath: string): boolean {
	if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")) {
		return false;
	}
	const segments = relativePath.split("/");
	return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Verify the on-disk prompt assets against the set regenerated from the
 * installed SDK. Uses lstat/readlink for symlinks (never follows), byte
 * comparison for files, and exact-version comparison for the manifest.
 */
export function verifyPromptAssets(providerRoot: string): PromptAssetVerification {
	const entries = buildPromptAssetPlanEntriesSync();
	const missing: string[] = [];
	const stale: string[] = [];
	const modified: string[] = [];
	const legacy: string[] = [];

	const legacySkillsStat = lstatSafe(join(providerRoot, LEGACY_TOP_LEVEL_SKILLS_DIR));
	if (legacySkillsStat?.isDirectory()) {
		legacy.push(`${LEGACY_TOP_LEVEL_SKILLS_DIR}/ (legacy top-level skills directory; the managed copy lives in .agents/skills/)`);
	}

	const manifestAbsPath = join(providerRoot, PROMPT_ASSET_MANIFEST_PATH);
	const manifestRaw = readManifestRaw(manifestAbsPath);
	if (manifestRaw === undefined) {
		missing.push(PROMPT_ASSET_MANIFEST_PATH);
	} else {
		const expectedManifest = buildPromptAssetManifest(entries, packageJson.version);
		const { sdkVersion } = parseManifest(manifestRaw);
		if (sdkVersion !== packageJson.version) {
			stale.push(
				`${PROMPT_ASSET_MANIFEST_PATH} (sdkVersion ${sdkVersion ?? "unreadable"} != installed ${packageJson.version})`,
			);
		} else if (manifestRaw !== expectedManifest) {
			modified.push(`${PROMPT_ASSET_MANIFEST_PATH} (differs from the regenerated manifest)`);
		}
	}

	for (const entry of entries) {
		const absPath = join(providerRoot, entry.path);
		const stat = lstatSafe(absPath);
		if (!stat) {
			missing.push(entry.path);
			continue;
		}
		if (entry.kind === "symlink") {
			if (!stat.isSymbolicLink()) {
				modified.push(`${entry.path} (expected symlink -> ${entry.content})`);
				continue;
			}
			const target = readlinkSync(absPath);
			if (target !== entry.content) {
				modified.push(`${entry.path} (symlink -> ${target}, expected -> ${entry.content})`);
			}
			continue;
		}
		if (!stat.isFile()) {
			modified.push(`${entry.path} (expected a regular file)`);
			continue;
		}
		if (readFileSync(absPath, "utf8") !== entry.content) {
			modified.push(`${entry.path} (content differs from the installed SDK template)`);
		}
	}

	return {
		ok: missing.length === 0 && stale.length === 0 && modified.length === 0 && legacy.length === 0,
		missing,
		stale,
		modified,
		legacy,
	};
}

export function formatPromptAssetIssues(verification: PromptAssetVerification): string[] {
	return [
		...verification.missing.map((item) => `missing: ${item}`),
		...verification.stale.map((item) => `stale: ${item}`),
		...verification.modified.map((item) => `modified: ${item}`),
		...verification.legacy.map((item) => `legacy: ${item}`),
	];
}

function removeEmptyParentDirectories(providerRoot: string, startDirectory: string): void {
	const rootPath = resolve(providerRoot);
	let currentDirectory = resolve(startDirectory);
	while (currentDirectory.startsWith(`${rootPath}/`) && currentDirectory !== rootPath) {
		try {
			rmdirSync(currentDirectory); // only succeeds when empty
		} catch {
			return;
		}
		currentDirectory = dirname(currentDirectory);
	}
}

/** Remove any non-directory ancestor blocking a managed file path, then mkdir -p. */
function ensureParentDirectory(providerRoot: string, relativeFilePath: string): void {
	const segments = relativeFilePath.split("/").slice(0, -1);
	let currentPath = providerRoot;
	for (const segment of segments) {
		currentPath = join(currentPath, segment);
		const stat = lstatSafe(currentPath);
		if (stat && !stat.isDirectory()) {
			rmSync(currentPath, { recursive: true, force: true });
		}
	}
	mkdirSync(join(providerRoot, segments.join("/")), { recursive: true });
}

/**
 * Regenerate the full managed asset set for the installed SDK version in an
 * existing provider root. Deletes legacy managed paths first (top-level
 * skills/**, paths listed in a pre-existing manifest that left the set),
 * writes files, replaces symlinks, and writes the manifest last. Idempotent.
 */
export function syncPromptAssets(providerRoot: string): PromptAssetSyncResult {
	const entries = buildPromptAssetPlanEntriesSync();
	const manifestContent = buildPromptAssetManifest(entries, packageJson.version);
	const manifestAbsPath = join(providerRoot, PROMPT_ASSET_MANIFEST_PATH);
	const expectedPaths = new Set<string>([
		...entries.map((entry) => entry.path),
		PROMPT_ASSET_MANIFEST_PATH,
	]);

	const removed: string[] = [];
	const wroteFiles: string[] = [];
	const createdSymlinks: string[] = [];

	// 1. Legacy top-level skills/ from the pre-.agents layout.
	const legacySkillsAbsPath = join(providerRoot, LEGACY_TOP_LEVEL_SKILLS_DIR);
	if (lstatSafe(legacySkillsAbsPath)) {
		rmSync(legacySkillsAbsPath, { recursive: true, force: true });
		removed.push(`${LEGACY_TOP_LEVEL_SKILLS_DIR}/`);
	}

	// 2. Paths a pre-existing manifest managed that are no longer in the set.
	const previousManifestRaw = readManifestRaw(manifestAbsPath);
	if (previousManifestRaw !== undefined) {
		for (const previousPath of parseManifest(previousManifestRaw).paths) {
			if (expectedPaths.has(previousPath) || !isSafeRelativeAssetPath(previousPath)) {
				continue;
			}
			const absPath = join(providerRoot, previousPath);
			if (!lstatSafe(absPath)) {
				continue;
			}
			rmSync(absPath, { recursive: true, force: true });
			removed.push(previousPath);
			removeEmptyParentDirectories(providerRoot, dirname(absPath));
		}
	}

	// 3. Regular files (byte-identical files are left untouched).
	for (const entry of entries) {
		if (entry.kind !== "file") {
			continue;
		}
		const absPath = join(providerRoot, entry.path);
		const stat = lstatSafe(absPath);
		if (stat?.isFile() && readFileSync(absPath, "utf8") === entry.content) {
			continue;
		}
		if (stat) {
			rmSync(absPath, { recursive: true, force: true });
		}
		ensureParentDirectory(providerRoot, entry.path);
		writeFileSync(absPath, entry.content);
		wroteFiles.push(entry.path);
	}

	// 4. Symlinks — replace whatever occupies the path (regular files, dirs,
	// wrong-target links). Correct links are left untouched.
	for (const entry of entries) {
		if (entry.kind !== "symlink") {
			continue;
		}
		const absPath = join(providerRoot, entry.path);
		const stat = lstatSafe(absPath);
		if (stat?.isSymbolicLink() && readlinkSync(absPath) === entry.content) {
			continue;
		}
		if (stat) {
			rmSync(absPath, { recursive: true, force: true });
		}
		ensureParentDirectory(providerRoot, entry.path);
		symlinkSync(entry.content, absPath);
		createdSymlinks.push(`${entry.path} -> ${entry.content}`);
	}

	// 5. Manifest last so a crash mid-sync never records a fresh manifest.
	let manifestChanged = false;
	const manifestStat = lstatSafe(manifestAbsPath);
	if (!(manifestStat?.isFile() && readFileSync(manifestAbsPath, "utf8") === manifestContent)) {
		if (manifestStat) {
			rmSync(manifestAbsPath, { recursive: true, force: true });
		}
		ensureParentDirectory(providerRoot, PROMPT_ASSET_MANIFEST_PATH);
		writeFileSync(manifestAbsPath, manifestContent);
		manifestChanged = true;
	}

	return {
		changed:
			manifestChanged ||
			removed.length > 0 ||
			wroteFiles.length > 0 ||
			createdSymlinks.length > 0,
		removed,
		wroteFiles,
		createdSymlinks,
		manifestPath: PROMPT_ASSET_MANIFEST_PATH,
	};
}
