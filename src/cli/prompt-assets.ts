import {
	lstatSync,
	mkdirSync,
	readdirSync,
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
	/** Entries inside `.agents/` that are not part of the managed asset set. */
	unexpected: string[];
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
 * Namespaces the SDK has ever managed. Manifest-driven orphan cleanup may
 * only delete inside these — a pre-existing manifest is untrusted repository
 * content (bounty submissions are adversarial), so listing e.g. `src/index.ts`
 * or `.git/config` must never make sync-assets delete it.
 */
const MANAGED_TOP_LEVEL_NAMES: ReadonlySet<string> = new Set([
	"AGENTS.md",
	"CLAUDE.md",
	".claude",
	".codex",
	".agents",
	".apifuse",
	LEGACY_TOP_LEVEL_SKILLS_DIR,
]);
const MANAGED_PATH_PREFIXES: readonly string[] = [
	".agents/",
	".apifuse/",
	`${LEGACY_TOP_LEVEL_SKILLS_DIR}/`,
];

function isManagedNamespacePath(relativePath: string): boolean {
	return (
		MANAGED_TOP_LEVEL_NAMES.has(relativePath) ||
		MANAGED_PATH_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
	);
}

/** The real-file asset paths that live under the `.agents/` tree. */
const AGENTS_EXPECTED_FILES: ReadonlySet<string> = new Set(
	PROMPT_ASSET_FILE_PATHS.filter((assetPath) => assetPath.startsWith(".agents/")),
);

/** Every ancestor directory implied by AGENTS_EXPECTED_FILES (incl. `.agents`). */
const AGENTS_EXPECTED_DIRS: ReadonlySet<string> = (() => {
	const dirs = new Set<string>();
	for (const assetPath of AGENTS_EXPECTED_FILES) {
		const segments = assetPath.split("/");
		for (let end = 1; end < segments.length; end += 1) {
			dirs.add(segments.slice(0, end).join("/"));
		}
	}
	return dirs;
})();

/**
 * Enumerate entries inside the real `.agents/` tree that are NOT part of the
 * managed set — injected files, stray directories, or any symlink (the layout
 * contract permits symlinks only at CLAUDE.md/.claude/.codex). This is the
 * governance backstop: `.claude`/`.codex` symlink onto `.agents`, so an
 * unlisted `.agents/**` file is loaded as agent guidance by every agent CLI.
 * Returns sorted provider-root-relative paths (directories get a trailing `/`).
 *
 * Never enumerates when `.agents` is missing or a symlink — those cases are
 * reported separately (missing entries / "found a symlink"); walking would
 * either no-op or follow the link out of the provider root.
 */
function findUnexpectedAgentEntries(providerRoot: string): string[] {
	const agentsStat = lstatSafe(join(providerRoot, ".agents"));
	if (!agentsStat?.isDirectory()) {
		return [];
	}
	const unexpected: string[] = [];
	const readDirentsSafe = (absDir: string) => {
		try {
			return readdirSync(absDir, { withFileTypes: true });
		} catch {
			return [];
		}
	};
	const walk = (relativeDir: string): void => {
		for (const dirent of readDirentsSafe(join(providerRoot, relativeDir))) {
			const relativePath = `${relativeDir}/${dirent.name}`;
			if (dirent.isSymbolicLink()) {
				unexpected.push(relativePath);
			} else if (dirent.isDirectory()) {
				if (AGENTS_EXPECTED_DIRS.has(relativePath)) {
					walk(relativePath);
				} else {
					unexpected.push(`${relativePath}/`);
				}
			} else if (!AGENTS_EXPECTED_FILES.has(relativePath)) {
				unexpected.push(relativePath);
			}
		}
	};
	walk(".agents");
	return unexpected.sort();
}

/**
 * First ancestor directory of `relativePath` (relative, final component
 * excluded) that exists on disk as a symlink — undefined when every existing
 * ancestor is a real directory. The lexical safety check cannot catch this:
 * `join()` never follows links, but rmSync/readFileSync/writeFileSync resolve
 * intermediate symlink components, so `linkdir -> /outside` plus a manifest
 * path `linkdir/x` would otherwise read or delete outside the provider root.
 */
function findSymlinkAncestor(providerRoot: string, relativePath: string): string | undefined {
	const segments = relativePath.split("/").slice(0, -1);
	let currentRelative = "";
	for (const segment of segments) {
		currentRelative = currentRelative === "" ? segment : `${currentRelative}/${segment}`;
		const stat = lstatSafe(join(providerRoot, currentRelative));
		if (!stat) {
			return undefined;
		}
		if (stat.isSymbolicLink()) {
			return currentRelative;
		}
	}
	return undefined;
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

	// Any top-level `skills` entry is legacy — directory, regular file, or
	// symlink (a `skills -> elsewhere` link would keep serving stale prompt
	// content to agents following pre-migration references). This mirrors the
	// sync-assets removal predicate so verify-green always implies sync-no-op.
	const legacySkillsStat = lstatSafe(join(providerRoot, LEGACY_TOP_LEVEL_SKILLS_DIR));
	if (legacySkillsStat) {
		const kind = legacySkillsStat.isDirectory()
			? "directory"
			: legacySkillsStat.isSymbolicLink()
				? "symlink"
				: "file";
		legacy.push(
			`${LEGACY_TOP_LEVEL_SKILLS_DIR}/ (legacy top-level skills ${kind}; the managed copy lives in .agents/skills/)`,
		);
	}

	// Managed assets must not resolve through symlinked directories: the
	// layout contract allows symlinks only at CLAUDE.md/.claude/.codex. A
	// symlinked `.agents` (or `.apifuse`) would let the effective prompt
	// content live outside the repository while byte checks still pass.
	const flaggedSymlinkAncestors = new Set<string>();
	const recordSymlinkAncestor = (relativePath: string): boolean => {
		const ancestor = findSymlinkAncestor(providerRoot, relativePath);
		if (ancestor === undefined) {
			return false;
		}
		if (!flaggedSymlinkAncestors.has(ancestor)) {
			flaggedSymlinkAncestors.add(ancestor);
			modified.push(`${ancestor} (expected a real directory, found a symlink)`);
		}
		return true;
	};

	const manifestAbsPath = join(providerRoot, PROMPT_ASSET_MANIFEST_PATH);
	const manifestRaw = recordSymlinkAncestor(PROMPT_ASSET_MANIFEST_PATH)
		? undefined
		: readManifestRaw(manifestAbsPath);
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
		if (recordSymlinkAncestor(entry.path)) {
			continue;
		}
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

	// Extra, unlisted files under `.agents/` must fail closed: the freshness
	// gate would otherwise let a contributor inject agent guidance that byte
	// checks over the fixed expected set never see.
	const unexpected = findUnexpectedAgentEntries(providerRoot);

	return {
		ok:
			missing.length === 0 &&
			stale.length === 0 &&
			modified.length === 0 &&
			legacy.length === 0 &&
			unexpected.length === 0,
		missing,
		stale,
		modified,
		legacy,
		unexpected,
	};
}

export function formatPromptAssetIssues(verification: PromptAssetVerification): string[] {
	return [
		...verification.missing.map((item) => `missing: ${item}`),
		...verification.stale.map((item) => `stale: ${item}`),
		...verification.modified.map((item) => `modified: ${item}`),
		...verification.legacy.map((item) => `legacy: ${item}`),
		...verification.unexpected.map((item) => `unexpected: ${item}`),
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
 * skills/**, plus manifest-listed paths that left the set — restricted to
 * managed namespaces with no symlinked ancestors), writes files, replaces
 * symlinks, and writes the manifest last. Idempotent.
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
	// The manifest is untrusted repository content: deletion is restricted to
	// SDK-managed namespaces, and paths resolving through a symlinked
	// directory are skipped entirely (rmSync follows intermediate symlinks, so
	// they could otherwise delete files outside the provider root).
	const previousManifestRaw =
		findSymlinkAncestor(providerRoot, PROMPT_ASSET_MANIFEST_PATH) === undefined
			? readManifestRaw(manifestAbsPath)
			: undefined;
	if (previousManifestRaw !== undefined) {
		for (const previousPath of parseManifest(previousManifestRaw).paths) {
			if (
				expectedPaths.has(previousPath) ||
				!isSafeRelativeAssetPath(previousPath) ||
				!isManagedNamespacePath(previousPath) ||
				findSymlinkAncestor(providerRoot, previousPath) !== undefined
			) {
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

	// 3. Regular files (byte-identical files are left untouched). When an
	// ancestor directory is a symlink (e.g. `.agents -> /elsewhere`), the
	// bytes visible through the link never count as in-sync: the entry is
	// rewritten and ensureParentDirectory replaces the offending link with a
	// real directory. The final path is never rmSync'd through such a link.
	for (const entry of entries) {
		if (entry.kind !== "file") {
			continue;
		}
		const absPath = join(providerRoot, entry.path);
		const symlinkAncestor = findSymlinkAncestor(providerRoot, entry.path);
		const stat = symlinkAncestor === undefined ? lstatSafe(absPath) : undefined;
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
		const symlinkAncestor = findSymlinkAncestor(providerRoot, entry.path);
		const stat = symlinkAncestor === undefined ? lstatSafe(absPath) : undefined;
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

	// 4b. Remove unlisted entries from the `.agents/` tree so a regenerated
	// tree contains only the managed set (injected guidance, stray dirs, and
	// symlinks). After steps 3-4 `.agents` is guaranteed a real directory, so
	// this never resolves through a symlinked ancestor. Keeps the invariant
	// that a completed sync leaves verifyPromptAssets green.
	for (const relativePath of findUnexpectedAgentEntries(providerRoot)) {
		const cleanRelativePath = relativePath.endsWith("/")
			? relativePath.slice(0, -1)
			: relativePath;
		const absPath = join(providerRoot, cleanRelativePath);
		if (!lstatSafe(absPath)) {
			continue;
		}
		rmSync(absPath, { recursive: true, force: true });
		removed.push(relativePath);
		removeEmptyParentDirectories(providerRoot, dirname(absPath));
	}

	// 5. Manifest last so a crash mid-sync never records a fresh manifest.
	let manifestChanged = false;
	const manifestStat =
		findSymlinkAncestor(providerRoot, PROMPT_ASSET_MANIFEST_PATH) === undefined
			? lstatSafe(manifestAbsPath)
			: undefined;
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
