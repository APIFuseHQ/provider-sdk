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

/**
 * Contributor-owned zone. `.agents/skills/upstream-notes/README.md` is
 * SDK-managed (pristine-verified), but the README template explicitly
 * instructs contributors to ADD per-vendor note files as sibling entries, and
 * reviewers treat them as submission quality. Any file under this directory
 * OTHER than README.md is therefore contributor-owned: the freshness gate must
 * never flag it `unexpected`, and sync-assets (including its legacy cleanup)
 * must never delete it — legacy authored notes are relocated here, not dropped.
 */
const UPSTREAM_NOTES_DIR = ".agents/skills/upstream-notes";
const UPSTREAM_NOTES_README = `${UPSTREAM_NOTES_DIR}/README.md`;

/**
 * True for real, contributor-authored entries inside the upstream-notes zone
 * (everything under it except the managed README.md). Symlinks are never
 * treated as contributor-owned — callers must gate this behind an lstat that
 * excludes symlinks so the exemption can never smuggle a path that escapes the
 * provider root by naming it under upstream-notes.
 */
function isContributorOwnedUpstreamNotesPath(relativePath: string): boolean {
	return (
		relativePath.startsWith(`${UPSTREAM_NOTES_DIR}/`) && relativePath !== UPSTREAM_NOTES_README
	);
}

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
 * The `.agents/skills/upstream-notes/` subtree is a contributor-owned zone: the
 * README template instructs contributors to ADD per-vendor note files there and
 * reviewers grade them, so real authored regular files under it are NOT flagged.
 * The exemption is scoped tightly and covers files only, never the walk itself:
 * README.md is still required and pristine (checked via the managed entry set),
 * real subdirectories are still descended into, and any SYMLINK anywhere under
 * the zone (at any depth) is still flagged (never followed), so no path can
 * escape the provider root by being named — or nested — under upstream-notes.
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
			// Symlinks are never contributor-owned, even under upstream-notes,
			// at any depth: flag them so the governance sweep unlinks them (never
			// following the link) and no escape path can be smuggled into the
			// exempt zone by nesting it below an authored directory.
			if (dirent.isSymbolicLink()) {
				unexpected.push(relativePath);
			} else if (dirent.isDirectory()) {
				// Always descend into real directories in the managed namespace,
				// including contributor-authored subdirectories of upstream-notes:
				// the exemption covers authored regular files, never the act of
				// walking, so nested content (especially symlinks) stays visible.
				if (
					AGENTS_EXPECTED_DIRS.has(relativePath) ||
					isContributorOwnedUpstreamNotesPath(relativePath)
				) {
					walk(relativePath);
				} else {
					unexpected.push(`${relativePath}/`);
				}
			} else if (
				!AGENTS_EXPECTED_FILES.has(relativePath) &&
				!isContributorOwnedUpstreamNotesPath(relativePath)
			) {
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
 * Relocate contributor-authored files from the legacy top-level
 * `skills/upstream-notes/` into the managed `.agents/skills/upstream-notes/`
 * zone before the legacy `skills/` tree is deleted. The legacy README.md is
 * skipped (regenerated from the template). Only real files reached through real
 * directories are moved — symlinks are never relocated or followed, so a
 * hostile `skills/upstream-notes/link -> /outside` can never copy content into
 * or out of the provider root.
 *
 * A newer `.agents` note is never overwritten. When the destination already
 * exists: identical bytes mean the legacy copy is redundant (dropped, no
 * write); differing bytes (or a non-regular-file destination) mean the legacy
 * content is written to the first free `<name>.legacy[.N]<ext>` path alongside
 * it so both versions are retained. Returns the paths actually written.
 *
 * Called only when the legacy `skills/` entry is itself a real directory.
 */
/**
 * First non-colliding conflict path alongside `destRelativePath`, inserting a
 * `.legacy` marker before the extension: `foo.md` -> `foo.legacy.md`, then
 * `foo.legacy.1.md`, `foo.legacy.2.md`, … Uses lstat (never follows) so an
 * existing symlink at a candidate name still counts as taken.
 */
function firstFreeConflictPath(providerRoot: string, destRelativePath: string): string {
	const slash = destRelativePath.lastIndexOf("/");
	const dir = destRelativePath.slice(0, slash);
	const filename = destRelativePath.slice(slash + 1);
	const dot = filename.lastIndexOf(".");
	const stem = dot > 0 ? filename.slice(0, dot) : filename;
	const ext = dot > 0 ? filename.slice(dot) : "";
	for (let index = 0; ; index += 1) {
		const candidateName = index === 0 ? `${stem}.legacy${ext}` : `${stem}.legacy.${index}${ext}`;
		const candidateRelative = `${dir}/${candidateName}`;
		if (!lstatSafe(join(providerRoot, candidateRelative))) {
			return candidateRelative;
		}
	}
}

function relocateLegacyUpstreamNotes(providerRoot: string): string[] {
	const legacyNotesDir = `${LEGACY_TOP_LEVEL_SKILLS_DIR}/upstream-notes`;
	const legacyNotesStat = lstatSafe(join(providerRoot, legacyNotesDir));
	if (!legacyNotesStat?.isDirectory()) {
		return [];
	}
	const relocated: string[] = [];
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
				continue; // never relocate a symlink or recurse through it
			}
			if (dirent.isDirectory()) {
				walk(relativePath);
				continue;
			}
			if (!dirent.isFile()) {
				continue;
			}
			const subPath = relativePath.slice(`${legacyNotesDir}/`.length);
			if (subPath === "README.md") {
				continue; // managed asset, regenerated from the template
			}
			const destRelativePath = `${UPSTREAM_NOTES_DIR}/${subPath}`;
			const contents = readFileSync(join(providerRoot, relativePath));
			const destAbsPath = join(providerRoot, destRelativePath);
			const destStat = lstatSafe(destAbsPath);
			if (!destStat) {
				// No collision — relocate the legacy note as-is.
				ensureParentDirectory(providerRoot, destRelativePath);
				writeFileSync(destAbsPath, contents);
				relocated.push(destRelativePath);
				continue;
			}
			if (destStat.isFile() && readFileSync(destAbsPath).equals(contents)) {
				// A byte-identical note already lives at the destination; the legacy
				// copy is redundant. Write nothing — the caller removes the legacy
				// tree, dropping the duplicate without touching the newer file.
				continue;
			}
			// Destination exists with different bytes (or is not a plain file):
			// never overwrite it. Retain both by writing the legacy content to the
			// first free `<name>.legacy[.N]<ext>` path beside it.
			const conflictRelativePath = firstFreeConflictPath(providerRoot, destRelativePath);
			ensureParentDirectory(providerRoot, conflictRelativePath);
			writeFileSync(join(providerRoot, conflictRelativePath), contents);
			relocated.push(conflictRelativePath);
		}
	};
	walk(legacyNotesDir);
	return relocated;
}

/**
 * Losslessly migrate a pre-existing REAL directory sitting where a managed
 * symlink belongs (a user's real `.claude/` or `.codex/` holding project agent
 * config — commands/, settings.json, hooks, …) into the symlink's target tree
 * (`.agents/`), so the content stays reachable through the new link instead of
 * being deleted. Returns the destination paths written (clean, no trailing
 * slash) so the caller can shield them from the governance sweep in this run.
 *
 * Merge rules mirror the upstream-notes conflict handling: destination absent
 * -> move; byte-identical -> drop the duplicate; differing bytes (or occupied
 * by a non-matching kind) -> never overwrite, write to the first free
 * `<name>.legacy[.N]<ext>` path. Nested symlinks are recreated verbatim and
 * never followed (no traversal into their target), so nothing can escape the
 * provider root. The source is removed only after it is verifiably emptied; any
 * unmergeable leftover throws rather than being deleted.
 *
 * Fails loudly if the symlink target is not a real directory (never merges
 * through a symlinked/absent `.agents`).
 */
function mergeRealDirectoryIntoSymlinkTarget(
	providerRoot: string,
	sourceRelDir: string,
	targetRelDir: string,
	wroteFiles: string[],
): string[] {
	const targetStat = lstatSafe(join(providerRoot, targetRelDir));
	if (!targetStat?.isDirectory()) {
		throw new Error(
			`sync-assets: refusing to migrate ${sourceRelDir}/ — its symlink target ${targetRelDir} is not a real directory. Resolve manually to avoid data loss.`,
		);
	}
	const migrated: string[] = [];
	const readDirentsSafe = (absDir: string) => {
		try {
			return readdirSync(absDir, { withFileTypes: true });
		} catch {
			return [];
		}
	};
	const mergeDir = (relSourceDir: string, relTargetDir: string): void => {
		for (const dirent of readDirentsSafe(join(providerRoot, relSourceDir))) {
			const srcRel = `${relSourceDir}/${dirent.name}`;
			const srcAbs = join(providerRoot, srcRel);
			const destRel = `${relTargetDir}/${dirent.name}`;
			const destAbs = join(providerRoot, destRel);
			const destStat = lstatSafe(destAbs);

			if (dirent.isSymbolicLink()) {
				// Preserve the user's symlink verbatim (never followed).
				const linkTarget = readlinkSync(srcAbs);
				const placeRel = destStat ? firstFreeConflictPath(providerRoot, destRel) : destRel;
				ensureParentDirectory(providerRoot, placeRel);
				symlinkSync(linkTarget, join(providerRoot, placeRel));
				rmSync(srcAbs, { force: true }); // unlink the source link, never following it
				if (destStat) {
					migrated.push(destRel);
				}
				migrated.push(placeRel);
				wroteFiles.push(placeRel);
				continue;
			}

			if (dirent.isDirectory()) {
				if (!destStat) {
					mkdirSync(destAbs, { recursive: true });
					mergeDir(srcRel, destRel);
					rmdirSync(srcAbs);
				} else if (destStat.isDirectory()) {
					mergeDir(srcRel, destRel);
					rmdirSync(srcAbs);
				} else {
					// Target occupied by a non-directory: relocate the whole subtree
					// to a conflict path rather than overwrite either side.
					const placeRel = firstFreeConflictPath(providerRoot, destRel);
					mkdirSync(join(providerRoot, placeRel), { recursive: true });
					mergeDir(srcRel, placeRel);
					rmdirSync(srcAbs);
				}
				continue;
			}

			if (!dirent.isFile()) {
				// Sockets/fifos/devices — never guess; fail loudly rather than delete.
				throw new Error(
					`sync-assets: cannot migrate ${srcRel} (not a regular file, directory, or symlink). Resolve manually.`,
				);
			}

			const contents = readFileSync(srcAbs);
			if (!destStat) {
				ensureParentDirectory(providerRoot, destRel);
				writeFileSync(destAbs, contents);
				rmSync(srcAbs, { force: true });
				migrated.push(destRel);
				wroteFiles.push(destRel);
			} else if (destStat.isFile() && readFileSync(destAbs).equals(contents)) {
				// Byte-identical — drop the redundant copy without touching the dest,
				// but shield the recognized destination from this run's sweep.
				rmSync(srcAbs, { force: true });
				migrated.push(destRel);
			} else {
				// Differing bytes (or dest occupied by another kind): never overwrite.
				// Keep the existing destination AND the migrated copy at a free path.
				const placeRel = firstFreeConflictPath(providerRoot, destRel);
				ensureParentDirectory(providerRoot, placeRel);
				writeFileSync(join(providerRoot, placeRel), contents);
				rmSync(srcAbs, { force: true });
				migrated.push(destRel);
				migrated.push(placeRel);
				wroteFiles.push(placeRel);
			}
		}
	};
	mergeDir(sourceRelDir, targetRelDir);
	// Source must now be empty; refuse to delete it if anything is left behind.
	if (readDirentsSafe(join(providerRoot, sourceRelDir)).length > 0) {
		throw new Error(
			`sync-assets: ${sourceRelDir}/ still has unmerged entries after migration; refusing to delete. Resolve manually.`,
		);
	}
	rmdirSync(join(providerRoot, sourceRelDir));
	return migrated;
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

	// 1. Legacy top-level skills/ from the pre-.agents layout. Contributor-
	// authored upstream-notes files are relocated into the managed
	// .agents/skills/upstream-notes/ zone FIRST (never destroyed); only then is
	// the legacy tree removed. Relocation runs only when `skills` is a real
	// directory — a `skills` symlink is unlinked without following it.
	const legacySkillsAbsPath = join(providerRoot, LEGACY_TOP_LEVEL_SKILLS_DIR);
	const legacySkillsStat = lstatSafe(legacySkillsAbsPath);
	if (legacySkillsStat) {
		if (legacySkillsStat.isDirectory()) {
			wroteFiles.push(...relocateLegacyUpstreamNotes(providerRoot));
		}
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
				isContributorOwnedUpstreamNotesPath(previousPath) ||
				findSymlinkAncestor(providerRoot, previousPath) !== undefined
			) {
				continue;
			}
			const absPath = join(providerRoot, previousPath);
			const orphanStat = lstatSafe(absPath);
			if (!orphanStat) {
				continue;
			}
			// Never recursively delete a managed-namespace DIRECTORY named by the
			// (untrusted) manifest: a hostile or stale entry like `.agents/skills`
			// would otherwise sweep away contributor-authored upstream-notes files
			// nested inside it. Directories are removed only when already empty;
			// recursive removal is limited to regular files (and a symlink AT the
			// path, which rmSync unlinks without following). Individual authored
			// notes are additionally guarded by isContributorOwnedUpstreamNotesPath.
			if (orphanStat.isDirectory()) {
				try {
					rmdirSync(absPath); // succeeds only when the directory is empty
				} catch {
					continue;
				}
				removed.push(previousPath);
				removeEmptyParentDirectories(providerRoot, dirname(absPath));
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

	// 4. Symlinks — replace whatever occupies the path. Wrong-target links and
	// regular files carry no user tree and are simply removed, but a REAL
	// DIRECTORY here is pre-existing user agent config (a hand-managed
	// `.claude/` or `.codex/`): it is migrated losslessly into the symlink
	// target (`.agents/`) rather than deleted. Correct links are left untouched.
	const migratedIntoAgents = new Set<string>();
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
		if (stat?.isDirectory()) {
			const merged = mergeRealDirectoryIntoSymlinkTarget(
				providerRoot,
				entry.path,
				entry.content,
				wroteFiles,
			);
			for (const migratedPath of merged) {
				migratedIntoAgents.add(migratedPath);
			}
		} else if (stat) {
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
		// Never sweep away user content just migrated in from a real
		// .claude/.codex directory in this same run (the file itself, or a
		// stray directory that now holds migrated files).
		if (
			migratedIntoAgents.has(cleanRelativePath) ||
			[...migratedIntoAgents].some((migratedPath) =>
				migratedPath.startsWith(`${cleanRelativePath}/`),
			)
		) {
			continue;
		}
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
