#!/usr/bin/env bun
/**
 * Bump safety scan (DX rule 8): prove, not claim, that an SDK change keeps
 * every downstream provider loading, compiling and serving the same contract.
 *
 * Usage:
 *   bun scripts/bump-safety-scan.ts --base <git-ref|dir> --head <git-ref|dir>
 *     [--targets <glob,...>] [--apifuse <dir>] [--jobs N] [--scratch <dir>]
 *     [--keep] [--json]
 *
 * `--base` / `--head` are either git refs of this repository (archived into
 * the scratch dir, `bun install --frozen-lockfile`, `bun run build`) or
 * directories that already contain a build (`dist/index.js`; a source dir
 * without one is built in place).
 *
 * Targets are provider checkouts (a directory whose `index.ts` calls
 * `defineProvider`). The default set is every provider this host knows:
 *   /home/ubuntu/projects/apifuse-provider-*
 *   /home/ubuntu/projects/apifuse/.provider-workspace/providers/*
 *   /home/ubuntu/projects/apifuse/providers-staging/*
 * plus one `fixture-tests` target: the apifuse monorepo test files that author
 * `defineProvider` literals inline (scripts/__tests__, scripts/lib/
 * provider-contract/__tests__, packages/provider-registry/src/__tests__).
 * There are no directory-shaped fixture providers in apifuse; those inline
 * literals are the fixtures the beta.81 bump broke, so they are run as tests
 * in a staged copy of the whole monorepo (minus node_modules, .git and
 * generated trees) with the SDK swapped in every workspace node_modules. The last two groups
 * were outside every earlier ad-hoc fleet scan, which is how beta.81 refused
 * the six providers-staging workspaces and the monorepo fixtures at load time.
 *
 * Staging method: every target is copied (sources only) under the scratch dir,
 * once per side, and gets a shadow `node_modules` whose entries are symlinks
 * to the checkout's own installed packages (filled from the workspace twin
 * and the SDK build when the checkout has none), with two overrides:
 * `@apifuse/provider-sdk` -> the SDK build under test and `zod` -> that
 * build's own zod, so the provider's schemas and the SDK's walker share one
 * zod instance. Symlinks are used instead of a Bun `--preload` resolve plugin
 * on purpose: Bun's runtime `onResolve` plugin does not fire for bare
 * specifiers, so the preload method silently resolved the checkout's pinned
 * SDK on both sides and compared base to base.
 *
 * Several local directories can be clones of one GitHub repository (review
 * worktrees, renamed providers). Two checkouts are the same repository when
 * they share a root commit (`git rev-list --max-parents=0 HEAD`, an offline
 * identity that survives a GitHub rename such as modu-phone-otp ->
 * modu-parking) or the same normalized `origin` URL. Clones of one repository
 * at the same HEAD are scanned once; at different HEADs every clone is
 * scanned, but only the newest one gates: the others are reported as stale
 * clones with their verdict and are left out of the summary and the exit
 * code, so a stale clone can neither fail nor pass the gate silently.
 *
 * Per target and side the scan reports module load (ok / error class), the
 * `tsc --noEmit` errors, the served contract digest
 * (`digestProviderContract(extractProviderContract(provider))`), authoring
 * lint diagnostics by rule id, and the runtime warnings printed while
 * loading. The diff table marks a target BREAK when it loaded on base and
 * fails on head, when its contract digest changes, or when head reports a
 * tsc error (file, line, column, code) that base does not, whatever the
 * counts are (a base that is already red cannot mask new head errors); a lint
 * error-level rule or a runtime warning that is new on head is marked WARN;
 * a target that fails on both sides is NOT COVERED (`covered: false` in the
 * JSON), because the diff says nothing about it.
 *
 * The second section counts the one-release window rules across the targets.
 * Today those are the two public-schema description paths the next release
 * refuses (a field described with raw `.describe()` prose, a field with no
 * description at all); a window row leaves the table once the PR that deletes
 * its path merges, the last scan on the pre-deletion base being that
 * deletion's evidence. "Uses the rule" is what the BASE SDK itself says about
 * the provider, read from the base probe: a base lint diagnostic for the
 * rule's lint id when the rule has one, else the once-per-provider warning
 * `defineProvider` prints on base (the schema rows read the two field tags
 * of the locale-key warning). Nothing is regex-counted over source text. A
 * rule with 0 users can be deleted with its path; a rule with users cannot.
 * The table inherits the base SDK's own coverage: a use the base lint or
 * warning does not see counts 0 here, while the tsc set diff above still
 * marks the provider BREAK when the path goes. Read DELETABLE together with
 * a BREAK-free verdict table, never alone.
 *
 * Exit 1 when any BREAK row exists, 2 on a usage error.
 */
import { spawn } from "node:child_process";
import {
	type Dirent,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import path from "node:path";

const SDK_REPO = path.resolve(import.meta.dirname, "..");
const SDK_PACKAGE = "@apifuse/provider-sdk";

export const DEFAULT_TARGETS = [
	"/home/ubuntu/projects/apifuse-provider-*",
	"/home/ubuntu/projects/apifuse/.provider-workspace/providers/*",
	"/home/ubuntu/projects/apifuse/providers-staging/*",
];
export const DEFAULT_APIFUSE = "/home/ubuntu/projects/apifuse";
const FIXTURE_TEST_DIRS = [
	"scripts/__tests__",
	"scripts/lib/provider-contract/__tests__",
	"packages/provider-registry/src/__tests__",
];
const APIFUSE_STAGE_EXCLUDES = [
	"node_modules",
	".git",
	".worktree",
	".provider-workspace",
	"__generated__",
	".tmp",
	".next",
	".turbo",
	"coverage",
];

export type Side = "base" | "head";

export interface LoadResult {
	status: "ok" | "error";
	errorClass?: string;
	errorCode?: string;
	message?: string;
}

export interface ProviderProbe {
	load: LoadResult;
	digest?: string;
	/** The provider loaded but the SDK threw while extracting or hashing its contract. */
	digestError?: string;
	lint: Record<string, { level: "error" | "warn"; count: number }>;
	warnings: string[];
}

export interface TscResult {
	/** Diagnostic count; -1 when tsc could not run (no tsconfig, no typescript, timeout). */
	errors: number;
	sample: string[];
	/** One `file(line,col): error TSnnnn` key per diagnostic, sorted; the set the verdict compares. */
	keys: string[];
}

export interface SideResult {
	probe?: ProviderProbe;
	tsc?: TscResult;
	tests?: { pass: number; fail: number; files: Record<string, FixtureFileResult> };
}

export interface FixtureFileResult {
	pass: number;
	fail: number;
	firstFailure?: string;
}

export type Verdict = "SAME" | "BREAK" | "WARN" | "NOT COVERED" | "SKIP";

/** Where a provider checkout comes from: its repository and the commit it sits on. */
export interface CloneIdentity {
	/** Normalized remote: `host/owner/repo`, lower case, no scheme, user or `.git`. */
	remote: string;
	/**
	 * Root commits of HEAD's history (`git rev-list --max-parents=0 HEAD`),
	 * sorted. Two checkouts that share one are the same repository whatever
	 * their remote says, which is how a clone made under a repository's old
	 * GitHub name is recognized after the rename.
	 */
	roots: string[];
	head: string;
	/** HEAD commit time (unix seconds); the newest clone of a remote is the one that gates. */
	committedAt: number;
	/**
	 * Working tree differs from HEAD (`git status --porcelain`, untracked
	 * included, ignored excluded). The scan stages the working tree, so a dirty
	 * clone is never folded into another clone and never absorbs one: it is
	 * scanned and gates on its own.
	 */
	dirty: boolean;
}

export interface TargetReport {
	name: string;
	kind: "provider" | "fixture-tests";
	path: string;
	clone?: CloneIdentity;
	/** Set when another clone of the same remote sits on a newer commit: this row is reported but does not gate. */
	staleCloneOf?: string;
	base: SideResult;
	head: SideResult;
	verdict: Verdict;
	/** False when the target fails on both sides, so the diff says nothing about it. */
	covered: boolean;
	reasons: string[];
}

export interface WindowRuleUsage {
	rule: string;
	description: string;
	/** What the base SDK emits for a user of the rule: a lint rule id or a defineProvider warning. */
	signal: string;
	providers: string[];
	sites: number;
}

export interface DuplicateClone {
	path: string;
	/** The target that was scanned in its place (same remote, same HEAD). */
	scannedAs: string;
}

export interface ScanReport {
	base: { spec: string; dir: string; version: string };
	head: { spec: string; dir: string; version: string };
	targetPatterns: string[];
	targets: TargetReport[];
	duplicateClones: DuplicateClone[];
	windowRules: WindowRuleUsage[];
	/** Verdict counts over the gating targets (stale clones are not counted). */
	summary: Record<Verdict, number>;
}

interface Target {
	name: string;
	kind: "provider" | "fixture-tests";
	path: string;
	clone?: CloneIdentity;
	staleCloneOf?: string;
	sources: string[];
	nodeModulesSources: string[];
	testFiles?: string[];
}

interface Options {
	base: string;
	head: string;
	targets: string[];
	apifuse: string;
	fixtureTests: boolean;
	jobs: number;
	scratch: string;
	keep: boolean;
	json: boolean;
}

function usage(message?: string): never {
	if (message) console.error(`bump-safety-scan: ${message}`);
	console.error(
		"usage: bun scripts/bump-safety-scan.ts --base <git-ref|dir> --head <git-ref|dir> [--targets <glob,...>] [--apifuse <dir>|--no-fixture-tests] [--jobs N] [--scratch <dir>] [--keep] [--json]",
	);
	process.exit(2);
}

export function parseArgs(argv: string[]): Options {
	const options: Options = {
		base: "",
		head: "",
		targets: DEFAULT_TARGETS,
		apifuse: DEFAULT_APIFUSE,
		fixtureTests: true,
		jobs: Math.max(2, Math.min(16, Math.floor(cpus().length / 4))),
		scratch: defaultScratchRoot(),
		keep: false,
		json: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]!;
		const value = () => {
			const next = argv[++index];
			if (next === undefined) usage(`${argument} needs a value`);
			return next;
		};
		switch (argument) {
			case "--base":
				options.base = value();
				break;
			case "--head":
				options.head = value();
				break;
			case "--targets":
				options.targets = value()
					.split(",")
					.map((entry) => entry.trim())
					.filter(Boolean);
				break;
			case "--apifuse":
				options.apifuse = value();
				break;
			case "--no-fixture-tests":
				options.fixtureTests = false;
				break;
			case "--jobs":
				options.jobs = Number.parseInt(value(), 10);
				if (!Number.isInteger(options.jobs) || options.jobs < 1) usage("--jobs must be >= 1");
				break;
			case "--scratch":
				options.scratch = path.resolve(value());
				break;
			case "--keep":
				options.keep = true;
				break;
			case "--json":
				options.json = true;
				break;
			default:
				usage(`unknown option ${argument}`);
		}
	}
	if (!options.base || !options.head) usage("--base and --head are required");
	return options;
}

function defaultScratchRoot(): string {
	const scratch = "/mnt/scratch/tmp";
	return existsSync(scratch)
		? path.join(scratch, "bump-safety-scan")
		: path.join(process.env.TMPDIR ?? tmpdir(), "bump-safety-scan");
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

function run(
	command: string,
	args: string[],
	options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						child.kill("SIGKILL");
					}, options.timeoutMs);
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			resolve({ code: null, stdout, stderr: `${stderr}${error.message}`, timedOut });
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

async function mustRun(command: string, args: string[], cwd: string, what: string): Promise<void> {
	const result = await run(command, args, { cwd });
	if (result.code !== 0) {
		throw new Error(
			`${what} failed (exit ${result.code}) in ${cwd}\n${result.stderr || result.stdout}`,
		);
	}
}

async function mapPool<T, R>(items: T[], jobs: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
	return results;
}

export interface SdkBuild {
	spec: string;
	dir: string;
	version: string;
}

function sdkVersion(dir: string): string {
	try {
		const parsed = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
			version?: string;
		};
		return parsed.version ?? "?";
	} catch {
		return "?";
	}
}

async function buildSdkInPlace(dir: string): Promise<void> {
	if (!existsSync(path.join(dir, "node_modules"))) {
		await mustRun("bun", ["install", "--frozen-lockfile"], dir, "bun install");
	}
	await mustRun("bun", ["run", "build"], dir, "bun run build");
}

export async function resolveSdk(spec: string, scratch: string): Promise<SdkBuild> {
	if (existsSync(spec) && lstatSync(spec).isDirectory()) {
		const dir = realpathSync(spec);
		if (!existsSync(path.join(dir, "dist", "index.js"))) await buildSdkInPlace(dir);
		return { spec, dir, version: sdkVersion(dir) };
	}
	const revision = await run("git", ["rev-parse", "--verify", `${spec}^{commit}`], {
		cwd: SDK_REPO,
	});
	if (revision.code !== 0) {
		throw new Error(`--base/--head "${spec}" is neither a directory nor a git ref of ${SDK_REPO}`);
	}
	const sha = revision.stdout.trim();
	const dir = path.join(scratch, "sdk", sha.slice(0, 12));
	if (!existsSync(path.join(dir, "dist", "index.js"))) {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		const archive = await run("bash", ["-c", `git archive ${sha} | tar -x -C "${dir}"`], {
			cwd: SDK_REPO,
		});
		if (archive.code !== 0) throw new Error(`git archive ${sha} failed: ${archive.stderr}`);
		await buildSdkInPlace(dir);
	}
	return { spec: `${spec} (${sha.slice(0, 12)})`, dir, version: sdkVersion(dir) };
}

const SOURCE_SKIP_DIRECTORIES = new Set([
	"node_modules",
	".git",
	".worktree",
	"dist",
	"build",
	"__tests__",
	"__fixtures__",
	"coverage",
]);

function collectSources(root: string): string[] {
	const out: string[] = [];
	const visit = (directory: string) => {
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SOURCE_SKIP_DIRECTORIES.has(entry.name) && !existsSync(path.join(full, ".git")))
					visit(full);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!/\.ts$/.test(entry.name) || /\.(test|spec|d)\.ts$/.test(entry.name)) continue;
			out.push(full);
		}
	};
	visit(root);
	return out.sort();
}

function expandPattern(pattern: string): string[] {
	const first = pattern.search(/[*?[{]/);
	if (first === -1) return existsSync(pattern) ? [pattern] : [];
	const cut = pattern.lastIndexOf("/", first);
	const base = pattern.slice(0, cut) || "/";
	const rest = pattern.slice(cut + 1);
	if (!existsSync(base)) return [];
	return [...new Bun.Glob(rest).scanSync({ cwd: base, onlyFiles: false })]
		.map((entry) => path.join(base, entry))
		.sort();
}

function isProviderCheckout(dir: string): boolean {
	const index = path.join(dir, "index.ts");
	try {
		return lstatSync(dir).isDirectory() && readFileSync(index, "utf8").includes("defineProvider");
	} catch {
		return false;
	}
}

function providerIdOf(dir: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
			name?: string;
		};
		return parsed.name?.replace(/^apifuse-provider-/, "").replace(/^@apifuse\/provider-/, "");
	} catch {
		return undefined;
	}
}

/**
 * `git@host:owner/repo.git`, `ssh://git@host/owner/repo` and
 * `https://host/owner/repo.git` all name one repository: `host/owner/repo`.
 */
export function normalizeRemote(url: string): string {
	const trimmed = url.trim();
	const scp = /^[^@/:]+@([^:/]+):(.+)$/.exec(trimmed);
	const hostAndPath = scp
		? `${scp[1]}/${scp[2]}`
		: trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?/i, "");
	return hostAndPath
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.toLowerCase();
}

/**
 * The clone identity of a checkout, or undefined when the directory is not the
 * top level of a git repository with an `origin` remote (a fixture inside
 * another repository, a plain copy). Only top-level checkouts are deduped so
 * sibling fixtures of one repository never collapse into each other.
 */
async function cloneIdentity(dir: string): Promise<CloneIdentity | undefined> {
	const git = (args: string[]) => run("git", ["-C", dir, ...args], { timeoutMs: 30_000 });
	const top = await git(["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) return undefined;
	try {
		if (realpathSync(top.stdout.trim()) !== dir) return undefined;
	} catch {
		return undefined;
	}
	const [remote, head, committed, roots, status] = await Promise.all([
		git(["remote", "get-url", "origin"]),
		git(["rev-parse", "HEAD"]),
		git(["log", "-1", "--format=%ct", "HEAD"]),
		git(["rev-list", "--max-parents=0", "HEAD"]),
		git(["status", "--porcelain", "--untracked-files=all"]),
	]);
	if (remote.code !== 0 || head.code !== 0) return undefined;
	return {
		remote: normalizeRemote(remote.stdout),
		roots: roots.code === 0 ? roots.stdout.split("\n").filter(Boolean).sort() : [],
		head: head.stdout.trim(),
		committedAt: Number.parseInt(committed.stdout.trim(), 10) || 0,
		// A status that cannot be read is treated as dirty: never fold a clone we cannot vouch for.
		dirty: status.code !== 0 || status.stdout.trim().length > 0,
	};
}

/**
 * Groups clones into repositories: two clones belong together when they share
 * a root commit or the same normalized remote (union of both relations, so a
 * renamed remote and an https/ssh spelling of one URL both collapse).
 * Returns, per input index, the index of the repository's representative.
 */
export function groupRepositories(clones: ReadonlyArray<CloneIdentity>): number[] {
	const parent = clones.map((_, index) => index);
	const find = (index: number): number => {
		while (parent[index] !== index) {
			parent[index] = parent[parent[index]!]!;
			index = parent[index]!;
		}
		return index;
	};
	const union = (left: number, right: number) => {
		const [a, b] = [find(left), find(right)];
		if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
	};
	const byKey = new Map<string, number>();
	clones.forEach((clone, index) => {
		for (const key of [`remote:${clone.remote}`, ...clone.roots.map((root) => `root:${root}`)]) {
			const seen = byKey.get(key);
			if (seen === undefined) byKey.set(key, index);
			else union(seen, index);
		}
	});
	return clones.map((_, index) => find(index));
}

export interface CloneDedupe<T> {
	/** Input order, minus the clones that repeat an earlier clone's remote and HEAD. */
	kept: T[];
	duplicates: Array<{ dropped: T; keptAs: T }>;
	/** Kept clones whose remote has another kept clone on a newer commit. */
	stale: Array<{ clone: T; newest: T }>;
}

/**
 * Same repository (shared root commit or same remote, see
 * `groupRepositories`) and same HEAD: one scan is enough, the first one found
 * keeps the row. Same repository at different HEADs: every clone is scanned,
 * the one with the newest commit gates, the rest are stale clones. A dirty
 * clone (working tree differs from HEAD) is what the scan actually stages, so
 * it is neither dropped as a duplicate nor used as the kept twin of another
 * clone: it is always scanned, and the stale rule still applies to it.
 */
export function dedupeClones<T extends { clone?: CloneIdentity }>(targets: T[]): CloneDedupe<T> {
	const kept: T[] = [];
	const duplicates: CloneDedupe<T>["duplicates"] = [];
	const withClone = targets.filter((target) => target.clone !== undefined);
	const representative = groupRepositories(withClone.map((target) => target.clone!));
	const repositoryOf = new Map(withClone.map((target, index) => [target, representative[index]!]));
	const byRepository = new Map<number, T[]>();
	for (const target of targets) {
		const repository = repositoryOf.get(target);
		if (repository === undefined) {
			kept.push(target);
			continue;
		}
		const group = byRepository.get(repository) ?? [];
		const twin = target.clone?.dirty
			? undefined
			: group.find((other) => !other.clone?.dirty && other.clone?.head === target.clone?.head);
		if (twin) {
			duplicates.push({ dropped: target, keptAs: twin });
			continue;
		}
		group.push(target);
		byRepository.set(repository, group);
		kept.push(target);
	}
	const stale: CloneDedupe<T>["stale"] = [];
	for (const group of byRepository.values()) {
		if (group.length < 2) continue;
		const newest = group.reduce((best, candidate) =>
			(candidate.clone?.committedAt ?? 0) > (best.clone?.committedAt ?? 0) ? candidate : best,
		);
		// Only an older HEAD is stale; a dirty twin kept at the newest HEAD gates on its own.
		for (const clone of group) {
			if (clone !== newest && clone.clone?.head !== newest.clone?.head)
				stale.push({ clone, newest });
		}
	}
	return { kept, duplicates, stale };
}

export async function discoverTargets(
	patterns: string[],
	apifuse: string,
	fixtureTests: boolean,
): Promise<{ targets: Target[]; duplicateClones: DuplicateClone[] }> {
	const found: Target[] = [];
	const seen = new Set<string>();
	const workspaceProviders = path.join(DEFAULT_APIFUSE, ".provider-workspace", "providers");
	for (const pattern of patterns) {
		for (const dir of expandPattern(pattern)) {
			if (!isProviderCheckout(dir)) continue;
			const real = realpathSync(dir);
			if (seen.has(real)) continue;
			seen.add(real);
			let name = targetName(real);
			if (found.some((target) => target.name === name))
				name = `${path.basename(path.dirname(real))}/${name}`;
			const nodeModulesSources = [path.join(real, "node_modules")];
			const id = providerIdOf(real) ?? path.basename(real);
			const twin = path.join(workspaceProviders, id, "node_modules");
			if (twin !== nodeModulesSources[0] && existsSync(twin)) nodeModulesSources.push(twin);
			const clone = await cloneIdentity(real);
			found.push({
				name,
				kind: "provider",
				path: real,
				...(clone ? { clone } : {}),
				sources: collectSources(real),
				nodeModulesSources,
			});
		}
	}
	const deduped = dedupeClones(found);
	for (const { clone, newest } of deduped.stale) clone.staleCloneOf = newest.name;
	const targets = deduped.kept;
	if (fixtureTests && existsSync(apifuse)) {
		const testFiles: string[] = [];
		for (const relativeDir of FIXTURE_TEST_DIRS) {
			const dir = path.join(apifuse, relativeDir);
			if (!existsSync(dir)) continue;
			for (const entry of readdirSync(dir)) {
				if (!/\.test\.ts$/.test(entry)) continue;
				const file = path.join(dir, entry);
				if (readFileSync(file, "utf8").includes("defineProvider(")) {
					testFiles.push(path.relative(apifuse, file));
				}
			}
		}
		if (testFiles.length > 0) {
			targets.push({
				name: "apifuse fixture-tests",
				kind: "fixture-tests",
				path: apifuse,
				sources: testFiles.map((file) => path.join(apifuse, file)),
				nodeModulesSources: [path.join(apifuse, "node_modules")],
				testFiles: testFiles.sort(),
			});
		}
	}
	return {
		targets,
		duplicateClones: deduped.duplicates.map(({ dropped, keptAs }) => ({
			path: dropped.path,
			scannedAs: keptAs.name,
		})),
	};
}

function targetName(dir: string): string {
	const home = "/home/ubuntu/projects/";
	const rest = dir.startsWith(home) ? dir.slice(home.length) : "";
	if (/^apifuse-provider-[^/]+$/.test(rest)) return rest.replace("apifuse-provider-", "");
	if (/^apifuse\/\.provider-workspace\/providers\/[^/]+$/.test(rest))
		return `workspace/${path.basename(dir)}`;
	if (/^apifuse\/providers-staging\/[^/]+$/.test(rest)) return `staging/${path.basename(dir)}`;
	return path.basename(dir);
}

/**
 * Builds a shadow node_modules: every entry of each source node_modules (first
 * source wins) becomes an absolute symlink to the installed package. Workspace
 * packages (a symlink that resolves inside `repoRoot` outside any
 * node_modules) are re-pointed into the staged copy so they also see the
 * swapped SDK. `@apifuse/provider-sdk` and `zod` always point at the SDK under
 * test; `typescript` and `@types/bun` are filled from it when missing so
 * `tsc --noEmit` can run on a checkout that was never installed.
 */
function shadowNodeModules(
	stagedNodeModules: string,
	sources: string[],
	sdkDir: string,
	remap?: { repoRoot: string; stagedRoot: string },
): void {
	mkdirSync(stagedNodeModules, { recursive: true });
	const link = (name: string, target: string) => {
		const at = path.join(stagedNodeModules, name);
		if (existsSync(at) || isSymlink(at)) return;
		mkdirSync(path.dirname(at), { recursive: true });
		symlinkSync(target, at);
	};
	const resolveTarget = (full: string): string => {
		const real = realpathSync(full);
		if (remap && real.startsWith(`${remap.repoRoot}/`) && !real.includes("/node_modules/")) {
			return path.join(remap.stagedRoot, path.relative(remap.repoRoot, real));
		}
		return real;
	};
	for (const source of sources) {
		if (!existsSync(source)) continue;
		for (const entry of readdirSync(source)) {
			const full = path.join(source, entry);
			if (entry === ".bin" || entry === ".bun" || entry === ".cache") {
				link(entry, full);
				continue;
			}
			if (entry.startsWith("@") && !isSymlink(full)) {
				for (const scoped of readdirSync(full)) {
					if (`${entry}/${scoped}` === SDK_PACKAGE) continue;
					try {
						link(`${entry}/${scoped}`, resolveTarget(path.join(full, scoped)));
					} catch {
						/* dangling symlink in the source install */
					}
				}
				continue;
			}
			if (entry === "zod") continue;
			try {
				link(entry, resolveTarget(full));
			} catch {
				/* dangling symlink in the source install */
			}
		}
	}
	const sdkNodeModules = path.join(sdkDir, "node_modules");
	rmSync(path.join(stagedNodeModules, SDK_PACKAGE), { recursive: true, force: true });
	link(SDK_PACKAGE, sdkDir);
	link("zod", realpathSync(path.join(sdkNodeModules, "zod")));
	for (const fill of ["typescript", "@types/bun", "bun-types"]) {
		const candidate = path.join(sdkNodeModules, fill);
		if (existsSync(candidate)) link(fill, realpathSync(candidate));
	}
}

function isSymlink(file: string): boolean {
	try {
		return lstatSync(file).isSymbolicLink();
	} catch {
		return false;
	}
}

async function copyTree(from: string, to: string, excludes: string[]): Promise<void> {
	mkdirSync(to, { recursive: true });
	const args = [
		"-a",
		"--delete",
		...excludes.flatMap((pattern) => ["--exclude", pattern]),
		`${from}/`,
		`${to}/`,
	];
	await mustRun("rsync", args, from, "rsync");
}

async function stageProvider(
	target: Target,
	side: Side,
	sdk: SdkBuild,
	scratch: string,
): Promise<string> {
	const staged = path.join(scratch, side, target.name.replace(/\//g, "__"));
	await copyTree(target.path, staged, ["node_modules", ".git", ".worktree", "dist", "coverage"]);
	shadowNodeModules(path.join(staged, "node_modules"), target.nodeModulesSources, sdk.dir);
	return staged;
}

async function stageApifuse(
	target: Target,
	side: Side,
	sdk: SdkBuild,
	scratch: string,
): Promise<string> {
	const staged = path.join(scratch, side, "apifuse");
	await copyTree(target.path, staged, APIFUSE_STAGE_EXCLUDES);
	const remap = { repoRoot: target.path, stagedRoot: staged };
	for (const original of workspaceNodeModules(target.path)) {
		const relative = path.relative(target.path, original);
		if (!existsSync(path.dirname(path.join(staged, relative)))) continue;
		shadowNodeModules(path.join(staged, relative), [original], sdk.dir, remap);
	}
	return staged;
}

/** The root node_modules plus every `<group>/<member>/node_modules` of the workspace (apps, packages, providers-staging). */
function workspaceNodeModules(repoRoot: string): string[] {
	const found = [path.join(repoRoot, "node_modules")];
	for (const group of readdirSync(repoRoot, { withFileTypes: true })) {
		if (!group.isDirectory() || APIFUSE_STAGE_EXCLUDES.includes(group.name)) continue;
		for (const member of readdirSync(path.join(repoRoot, group.name), { withFileTypes: true })) {
			if (!member.isDirectory()) continue;
			const candidate = path.join(repoRoot, group.name, member.name, "node_modules");
			if (existsSync(candidate)) found.push(candidate);
		}
	}
	return found.filter((candidate) => existsSync(candidate));
}

const PROBE_MARKER = "__BUMP_SAFETY_SCAN_PROBE__";

/**
 * Runs in its own `bun` process inside the staged copy: loads `index.ts`
 * through the shadow node_modules, then reads the SDK helpers straight from
 * the build under test (same realpath as the symlink, so one module instance).
 */
const PROBE_SOURCE = `
const [indexPath, sdkDir, providerRoot] = process.argv.slice(2);
const warnings = [];
const record = (args) => { const line = args.map(String).join(" ").split("\\n")[0]; if (line) warnings.push(line); };
const originalWarn = console.warn; const originalError = console.error;
console.warn = (...args) => record(args);
console.error = (...args) => record(args);
const result = { load: { status: "ok" }, lint: {}, warnings };
try {
	const module = await import(Bun.pathToFileURL(indexPath).href);
	const provider = module.default;
	if (!provider || typeof provider !== "object" || typeof provider.id !== "string" || !provider.operations) {
		result.load = { status: "error", errorClass: "NoDefaultProvider", message: "index.ts default export is not a provider definition" };
	} else {
		try {
			const contract = await import(sdkDir + "/dist/contract.js");
			result.digest = contract.digestProviderContract(contract.extractProviderContract(provider));
		} catch (error) {
			result.digestError = String(error && error.message || error).split("\\n")[0];
		}
		try {
			const lint = await import(sdkDir + "/dist/lint.js");
			const { readdirSync, readFileSync, existsSync, statSync } = await import("node:fs");
			const { join } = await import("node:path");
			const sources = {};
			const skip = new Set([".git", "node_modules", "dist", "build", ".next"]);
			const visit = (directory) => {
				for (const entry of readdirSync(directory, { withFileTypes: true })) {
					const full = join(directory, entry.name);
					if (entry.isDirectory()) { if (!skip.has(entry.name) && !existsSync(join(full, ".git"))) visit(full); continue; }
					if (!entry.isFile()) continue;
					const relative = full.slice(providerRoot.length + 1);
					if (/\\.(?:ts|tsx|js|jsx|mjs|cjs|sh|bash)$/.test(relative) || /(?:^|\\/)Dockerfile(?:\\.|$)/.test(relative)) sources[relative] = readFileSync(full, "utf8");
				}
			};
			visit(providerRoot);
			let localeCatalogEn = {};
			const catalog = join(providerRoot, "locales", "en.json");
			if (existsSync(catalog)) { try { localeCatalogEn = JSON.parse(readFileSync(catalog, "utf8")); } catch {} }
			const linted = lint.lintProviderWithInformation
				? lint.lintProviderWithInformation({ ...provider, providerSourceFiles: sources, localeCatalogEn }).diagnostics
				: lint.lintProvider({ ...provider, providerSourceFiles: sources, localeCatalogEn });
			for (const diagnostic of linted) {
				const entry = result.lint[diagnostic.rule] ?? (result.lint[diagnostic.rule] = { level: diagnostic.level, count: 0 });
				entry.count += 1;
			}
		} catch (error) {
			result.lintError = String(error && error.message || error).split("\\n")[0];
		}
	}
} catch (error) {
	const message = String(error && error.message || error).split("\\n")[0];
	result.load = {
		status: "error",
		errorClass: (error && error.constructor && error.constructor.name) || "Error",
		...(error && typeof error.code === "string" ? { errorCode: error.code } : {}),
		message,
	};
}
console.warn = originalWarn; console.error = originalError;
process.stdout.write("\\n" + ${JSON.stringify(PROBE_MARKER)} + JSON.stringify(result) + "\\n");
process.exit(0);
`;

function writeProbe(scratch: string): string {
	const probe = path.join(scratch, "probe.mjs");
	writeFileSync(probe, PROBE_SOURCE);
	return probe;
}

async function probeProvider(staged: string, sdk: SdkBuild, probe: string): Promise<ProviderProbe> {
	const index = path.join(staged, "index.ts");
	const result = await run("bun", [probe, index, sdk.dir, staged], {
		cwd: staged,
		timeoutMs: 120_000,
		env: { NODE_ENV: "test", APIFUSE_BUMP_SAFETY_SCAN: "1" },
	});
	const marker = result.stdout.lastIndexOf(PROBE_MARKER);
	if (marker === -1) {
		const tail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" | ");
		return {
			load: {
				status: "error",
				errorClass: result.timedOut ? "Timeout" : "ProcessExit",
				message: result.timedOut ? "probe timed out after 120s" : `exit ${result.code}: ${tail}`,
			},
			lint: {},
			warnings: [],
		};
	}
	const payload = result.stdout.slice(marker + PROBE_MARKER.length).split("\n")[0]!;
	const parsed = JSON.parse(payload) as ProviderProbe & {
		digestError?: string;
		lintError?: string;
	};
	const warnings = new Set(parsed.warnings);
	for (const line of result.stderr.split("\n")) {
		const trimmed = line.trim();
		if (trimmed && !/^\s*at /.test(trimmed)) warnings.add(trimmed);
	}
	if (parsed.lintError) warnings.add(`lint: ${parsed.lintError}`);
	return {
		load: parsed.load,
		...(parsed.digest === undefined ? {} : { digest: parsed.digest }),
		...(parsed.digestError === undefined ? {} : { digestError: parsed.digestError }),
		lint: parsed.lint,
		warnings: [...warnings].sort(),
	};
}

function typescriptEntry(staged: string, sdk: SdkBuild): string | undefined {
	for (const candidate of [
		path.join(staged, "node_modules", "typescript", "lib", "tsc.js"),
		path.join(sdk.dir, "node_modules", "typescript", "lib", "tsc.js"),
	]) {
		if (existsSync(candidate)) return realpathSync(candidate);
	}
	return undefined;
}

async function typecheck(staged: string, sdk: SdkBuild): Promise<TscResult> {
	const tsc = typescriptEntry(staged, sdk);
	if (!tsc) return { errors: -1, sample: ["no typescript install reachable"], keys: [] };
	const project = ["tsconfig.typecheck.json", "tsconfig.json"]
		.map((name) => path.join(staged, name))
		.find((candidate) => existsSync(candidate));
	if (!project) return { errors: -1, sample: ["no tsconfig"], keys: [] };
	const result = await run("bun", [tsc, "--noEmit", "--pretty", "false", "-p", project], {
		cwd: staged,
		timeoutMs: 300_000,
	});
	if (result.timedOut) return { errors: -1, sample: ["tsc timed out after 300s"], keys: [] };
	return parseTscOutput(`${result.stdout}\n${result.stderr}`, staged, [staged, sdk.dir]);
}

/**
 * One diagnostic per `file(line,col): error TSnnnn: message` line. tsc prints
 * the file relative to the directory it ran in (`cwd`), so a diagnostic inside
 * the SDK build arrives as `../../sdk/<sha>/dist/x.d.ts`; the file is resolved
 * against `cwd` first, then the per-side roots (staged copy, SDK build) are
 * removed, so the key the verdict compares carries no per-side path or SHA.
 * Location-less diagnostics (`error TS5083: Cannot read file '<abs path>'`) and
 * message text get the same roots removed textually, so neither the key nor the
 * sample text differs between the two sides.
 */
export function parseTscOutput(text: string, cwd: string, roots: string[]): TscResult {
	const lines: string[] = [];
	const keys: string[] = [];
	const strip = (file: string): string => {
		const absolute = path.resolve(cwd, file);
		for (const root of roots) {
			if (absolute === root) return ".";
			if (absolute.startsWith(`${root}/`)) return absolute.slice(root.length + 1);
		}
		return absolute;
	};
	const neutral = (fragment: string): string => {
		let out = fragment;
		for (const root of roots) out = out.split(`${root}/`).join("");
		return out;
	};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!/error TS\d+/.test(line)) continue;
		const match = /^(.*?)\((\d+),(\d+)\): error (TS\d+)(.*)$/.exec(line);
		if (!match) {
			const neutralLine = neutral(line);
			lines.push(neutralLine);
			keys.push(neutralLine);
			continue;
		}
		const [, file, row, column, code, rest] = match;
		const location = `${strip(file!)}(${row},${column})`;
		lines.push(`${location}: error ${code}${neutral(rest!)}`);
		keys.push(`${location}: error ${code}`);
	}
	return { errors: lines.length, sample: lines.slice(0, 5), keys: keys.sort() };
}

async function runFixtureTests(
	staged: string,
	files: string[],
	jobs: number,
): Promise<SideResult["tests"]> {
	const perFile = await mapPool(files, Math.max(1, Math.floor(jobs / 2)), async (file) => {
		const result = await run("bun", ["test", file], {
			cwd: staged,
			timeoutMs: 600_000,
			env: { CI: "1" },
		});
		return [
			file,
			parseFixtureTestOutput(`${result.stdout}\n${result.stderr}`, result.code, result.timedOut),
		] as const;
	});
	const files_: Record<string, FixtureFileResult> = {};
	let pass = 0;
	let fail = 0;
	for (const [file, counts] of perFile) {
		files_[file] = counts;
		pass += counts.pass;
		fail += counts.fail;
	}
	return { pass, fail, files: files_ };
}

/**
 * A nonzero exit with no parsed failure is still a failure: bun reports an
 * unhandled error outside a test (a throwing afterAll, an error between
 * tests) as `N pass, 0 fail, 1 error` and exits 1.
 */
export function parseFixtureTestOutput(
	text: string,
	code: number | null,
	timedOut: boolean,
): FixtureFileResult {
	const pass = Number(/^\s*(\d+) pass/m.exec(text)?.[1] ?? 0);
	const parsedFail = Number(/^\s*(\d+) fail/m.exec(text)?.[1] ?? 0);
	const exitedWithoutFailedTest = code !== 0 && parsedFail === 0;
	const fail = timedOut || exitedWithoutFailedTest ? Math.max(parsedFail, 1) : parsedFail;
	const firstFailure = timedOut
		? "timed out after 600s"
		: (text
				.split("\n")
				.map((line) => line.trim())
				.find((line) => /^(error:|\(fail\)|[A-Za-z]*Error:|ENOENT)/.test(line)) ??
			(exitedWithoutFailedTest ? `process exited ${code} with no failed test` : undefined));
	return {
		pass,
		fail,
		...(fail > 0 && firstFailure ? { firstFailure: firstFailure.slice(0, 160) } : {}),
	};
}

export interface Judgement {
	verdict: Verdict;
	covered: boolean;
	reasons: string[];
}

/**
 * BREAK and WARN come from a base-to-head change; NOT COVERED means the target
 * (or, for fixture tests, at least one of its files) fails on both sides, so
 * the diff says nothing about it. A fixture-tests target with one both-sides
 * failing file and one regressing file is BREAK and not covered at once.
 */
export function judge(target: Pick<TargetReport, "kind" | "base" | "head">): Judgement {
	const reasons: string[] = [];
	let verdict: Verdict = "SAME";
	let covered = true;
	const escalate = (level: Verdict, reason: string) => {
		reasons.push(reason);
		if (level === "BREAK" || (level === "WARN" && verdict === "SAME")) verdict = level;
	};
	const uncover = (reason: string) => {
		covered = false;
		reasons.push(reason);
		if (verdict === "SAME") verdict = "NOT COVERED";
	};
	if (target.kind === "fixture-tests") {
		const base = target.base.tests;
		const head = target.head.tests;
		if (!base || !head) return { verdict: "SKIP", covered: false, reasons: ["tests did not run"] };
		for (const [file, counts] of Object.entries(head.files)) {
			const before = base.files[file];
			if (!before) continue;
			if (before.fail === 0 && counts.fail > 0) {
				escalate(
					"BREAK",
					`${file}: ${before.pass} pass on base, ${counts.fail} fail on head: ${counts.firstFailure ?? ""}`,
				);
			} else if (before.fail > 0 && counts.fail > 0) {
				uncover(
					`${file}: ${before.fail} fail on both sides: ${before.firstFailure ?? counts.firstFailure ?? ""}`,
				);
			}
		}
		return { verdict, covered, reasons };
	}
	const base = target.base.probe;
	const head = target.head.probe;
	if (!base || !head) return { verdict: "SKIP", covered: false, reasons: ["probe did not run"] };
	if (base.load.status === "error" && head.load.status === "error") {
		uncover(
			`fails to load on both sides: ${head.load.errorCode ?? head.load.errorClass}: ${(head.load.message ?? "").slice(0, 110)}`,
		);
	}
	if (base.load.status === "ok" && head.load.status === "error") {
		escalate(
			"BREAK",
			`loads on base, fails on head: ${head.load.errorClass}: ${head.load.message ?? ""}`,
		);
	}
	if (base.load.status === "ok" && head.load.status === "ok") {
		if (base.digestError !== undefined && head.digestError !== undefined) {
			uncover(`contract extraction fails on both sides: ${head.digestError.slice(0, 110)}`);
		} else if (base.digest && head.digestError !== undefined) {
			escalate("BREAK", `contract extraction failed on head: ${head.digestError.slice(0, 110)}`);
		} else if (base.digest && head.digest && base.digest !== head.digest) {
			escalate(
				"BREAK",
				`contract digest ${base.digest.slice(0, 12)} -> ${head.digest.slice(0, 12)}`,
			);
		}
		for (const [rule, entry] of Object.entries(head.lint)) {
			const before = base.lint[rule];
			if (entry.level === "error" && before?.level !== "error") {
				escalate("WARN", `new lint error ${rule} x${entry.count}`);
			}
		}
	}
	const baseTsc = target.base.tsc;
	const headTsc = target.head.tsc;
	if (baseTsc && headTsc && baseTsc.errors >= 0 && headTsc.errors >= 0) {
		const known = new Set(baseTsc.keys);
		const introduced = headTsc.keys.filter((key) => !known.has(key));
		if (introduced.length > 0) {
			escalate(
				"BREAK",
				`tsc ${baseTsc.errors} -> ${headTsc.errors}, ${introduced.length} new on head: ${introduced[0]}`,
			);
		}
	}
	const baseWarnings = new Set(base.warnings);
	const newWarnings = head.warnings.filter((line) => !baseWarnings.has(line));
	if (newWarnings.length > 0) {
		escalate("WARN", `new runtime warning: ${newWarnings[0]!.slice(0, 120)}`);
	}
	return { verdict, covered, reasons };
}

/**
 * How the BASE SDK reports a use of a window rule, read from the base probe.
 * `lint`: the diagnostics of that lint rule id (sites = diagnostic count).
 * `warning`: the once-per-provider `defineProvider` warning for a rule that
 * has no lint rule; `sites` reads the count the warning states, else 1.
 */
type WindowSignal = { lint: string } | { warning: RegExp; sites?: (line: string) => number };

export const WINDOW_RULES: ReadonlyArray<{
	rule: string;
	description: string;
	signal: WindowSignal;
}> = [
	// A window row is removed from this table once the PR that deletes its path
	// merges; the last scan on the pre-deletion base is that deletion's evidence.
	{
		rule: "schema-describe-prose",
		description:
			'public schema field described with raw .describe() prose instead of a locale key (no lint rule; defineProvider warns once per provider, tagging each field "(raw .describe() prose)")',
		signal: publicSchemaFieldSignal("raw .describe() prose"),
	},
	{
		rule: "schema-missing-key",
		description:
			'public schema field with no description at all (no lint rule; the same defineProvider warning tags each field "(no description)")',
		signal: publicSchemaFieldSignal("no description"),
	},
];

/**
 * The base SDK's one locale-key warning lists every undeclared public schema
 * field as `operations.<op>.<path> (<reason>)`, with the reason being one of
 * the two `UndeclaredFieldReason` texts; each reason is its own window row,
 * sites = fields carrying that tag.
 */
function publicSchemaFieldSignal(reason: string): WindowSignal {
	const tag = `(${reason})`;
	const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return {
		warning: new RegExp(
			`\\[provider-sdk\\] Provider "[^"]*" has \\d+ public schema fields? without a locale key:.*${escaped}`,
		),
		sites: (line) => line.split(tag).length - 1,
	};
}

export function windowSignalLabel(signal: WindowSignal): string {
	return "lint" in signal ? `lint ${signal.lint}` : "defineProvider warning";
}

/** Sites of one window rule in one base probe, as the base SDK reported them. */
function windowSites(signal: WindowSignal, probe: ProviderProbe): number {
	if ("lint" in signal) return probe.lint[signal.lint]?.count ?? 0;
	let sites = 0;
	for (const line of probe.warnings) {
		if (signal.warning.test(line)) sites += signal.sites ? signal.sites(line) : 1;
	}
	return sites;
}

/**
 * Users of each window rule over the gating targets, read from what the base
 * SDK emitted for each provider (the base probe's lint diagnostics or
 * defineProvider warnings). A target without a base probe (fixture tests, a
 * staging failure) or whose base load failed has no signal and is not a user.
 */
export function countWindowRules(
	targets: Array<Pick<TargetReport, "name" | "base" | "staleCloneOf">>,
): WindowRuleUsage[] {
	return WINDOW_RULES.map(({ rule, description, signal }) => {
		const providers: string[] = [];
		let sites = 0;
		for (const target of targets) {
			if (target.staleCloneOf !== undefined || !target.base.probe) continue;
			const hits = windowSites(signal, target.base.probe);
			if (hits > 0) {
				providers.push(target.name);
				sites += hits;
			}
		}
		return { rule, description, signal: windowSignalLabel(signal), providers, sites };
	});
}

function table(rows: string[][]): string {
	const widths = rows[0]!.map((_, column) =>
		Math.max(...rows.map((row) => (row[column] ?? "").length)),
	);
	const line = (row: string[]) =>
		row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ");
	return [
		line(rows[0]!),
		widths.map((width) => "-".repeat(width)).join("  "),
		...rows.slice(1).map(line),
	].join("\n");
}

function loadCell(side: SideResult): string {
	if (side.tests)
		return side.tests.fail === 0 ? `${side.tests.pass} pass` : `${side.tests.fail} fail`;
	const probe = side.probe;
	if (!probe) return "-";
	return probe.load.status === "ok"
		? "ok"
		: `ERR ${probe.load.errorCode ?? probe.load.errorClass ?? ""}`;
}

function tscCell(side: SideResult): string {
	if (!side.tsc) return "-";
	return side.tsc.errors < 0 ? "n/a" : String(side.tsc.errors);
}

function lintCell(side: SideResult): string {
	const probe = side.probe;
	if (!probe) return "-";
	let errors = 0;
	let warns = 0;
	for (const entry of Object.values(probe.lint)) {
		if (entry.level === "error") errors += entry.count;
		else warns += entry.count;
	}
	return `${errors}e/${warns}w`;
}

export function renderReport(report: ScanReport): string {
	const out: string[] = [];
	out.push(
		`bump-safety-scan: base ${report.base.spec} v${report.base.version} -> head ${report.head.spec} v${report.head.version}`,
	);
	const gating = report.targets.filter((target) => target.staleCloneOf === undefined);
	const stale = report.targets.filter((target) => target.staleCloneOf !== undefined);
	out.push(
		`targets: ${gating.length} from ${report.targetPatterns.join(", ")}` +
			(stale.length > 0 ? ` (+${stale.length} stale clone(s), not gating)` : "") +
			(report.duplicateClones.length > 0
				? ` (${report.duplicateClones.length} duplicate clone(s) scanned once)`
				: ""),
	);
	out.push("");
	const rows: string[][] = [
		["target", "load b/h", "tsc b/h", "digest", "lint b/h", "warns b/h", "verdict", "reason"],
	];
	for (const target of report.targets) {
		const digest =
			target.base.probe?.digestError !== undefined || target.head.probe?.digestError !== undefined
				? `${target.base.probe?.digestError === undefined ? "ok" : "ERR"} / ${target.head.probe?.digestError === undefined ? "ok" : "ERR"}`
				: target.base.probe?.digest && target.head.probe?.digest
					? target.base.probe.digest === target.head.probe.digest
						? "same"
						: "CHANGED"
					: "-";
		rows.push([
			target.name,
			`${loadCell(target.base)} / ${loadCell(target.head)}`,
			`${tscCell(target.base)} / ${tscCell(target.head)}`,
			digest,
			`${lintCell(target.base)} / ${lintCell(target.head)}`,
			`${target.base.probe?.warnings.length ?? "-"} / ${target.head.probe?.warnings.length ?? "-"}`,
			target.staleCloneOf === undefined
				? target.verdict
				: `stale clone (${target.verdict})${target.clone?.dirty ? " dirty" : ""}`,
			target.staleCloneOf === undefined
				? (target.reasons[0] ?? "")
				: `newest clone is ${target.staleCloneOf}; ${target.reasons[0] ?? ""}`,
		]);
	}
	out.push(table(rows));
	out.push("");
	out.push(
		`summary: ${report.summary.BREAK} BREAK, ${report.summary.WARN} WARN, ${report.summary.SAME} SAME, ${report.summary["NOT COVERED"]} NOT COVERED, ${report.summary.SKIP} SKIP`,
	);
	for (const target of gating) {
		if (target.verdict === "BREAK" || target.verdict === "WARN") {
			for (const reason of target.reasons)
				out.push(`  ${target.verdict} ${target.name}: ${reason}`);
		}
	}
	if (stale.length > 0) {
		out.push("");
		out.push(
			`stale clones: ${stale.length} target(s) share a repository with a newer clone; reported, not gating`,
		);
		for (const target of stale) {
			out.push(
				`  ${target.name}: ${target.verdict}, ${target.clone?.head.slice(0, 12) ?? "?"} is older than ${target.staleCloneOf}${target.clone?.dirty ? " (dirty working tree, local changes were not gated)" : ""}${target.reasons[0] ? `: ${target.reasons[0]}` : ""}`,
			);
		}
	}
	if (report.duplicateClones.length > 0) {
		out.push("");
		out.push(
			`duplicate clones: ${report.duplicateClones.length} director(y|ies) at the same repository and HEAD as a scanned target, scanned once`,
		);
		for (const duplicate of report.duplicateClones)
			out.push(`  ${duplicate.path} = ${duplicate.scannedAs}`);
	}
	const uncovered = gating.filter((target) => !target.covered);
	const uncoveredReason =
		/^(fails to load on both sides: |contract extraction fails on both sides: )|fail on both sides: /;
	if (uncovered.length > 0) {
		out.push("");
		out.push(
			`not covered: ${uncovered.length} target(s) fail on both sides (the diff says nothing about them)`,
		);
		for (const target of uncovered) {
			for (const reason of target.reasons) {
				if (!uncoveredReason.test(reason)) continue;
				out.push(`  ${target.name}: ${reason.replace(/^fails to load on both sides: /, "")}`);
			}
		}
	}
	out.push("");
	out.push(
		`window rules over the ${gating.length} target(s) above, as the base SDK reports them (deletion gate: a rule and its one-release path can go only at 0 users on the default target set)`,
	);
	const usageRows: string[][] = [["rule", "signal", "providers", "sites", "gate", "users"]];
	for (const usage of report.windowRules) {
		usageRows.push([
			usage.rule,
			usage.signal,
			String(usage.providers.length),
			String(usage.sites),
			usage.providers.length === 0 ? "DELETABLE" : "KEEP",
			usage.providers.slice(0, 6).join(", ") +
				(usage.providers.length > 6 ? `, +${usage.providers.length - 6}` : ""),
		]);
	}
	out.push(table(usageRows));
	out.push(
		"users are what the base SDK's own lint and defineProvider warnings report, so a use that signal does not see counts 0 here; read DELETABLE together with a BREAK-free verdict table (the tsc set diff still catches such a provider), never alone",
	);
	return out.join("\n");
}

export async function scan(options: Options): Promise<ScanReport> {
	mkdirSync(options.scratch, { recursive: true });
	const runDir = path.join(options.scratch, `run-${Date.now().toString(36)}-${process.pid}`);
	mkdirSync(runDir, { recursive: true });
	try {
		const base = await resolveSdk(options.base, options.scratch);
		const head = await resolveSdk(options.head, options.scratch);
		const { targets, duplicateClones } = await discoverTargets(
			options.targets,
			options.apifuse,
			options.fixtureTests,
		);
		if (targets.length === 0)
			throw new Error(
				"no targets matched; a target is a directory whose index.ts calls defineProvider",
			);
		const probe = writeProbe(runDir);
		const sides: Array<[Side, SdkBuild]> = [
			["base", base],
			["head", head],
		];
		const providerTargets = targets.filter((target) => target.kind === "provider");
		const fixtureTargets = targets.filter((target) => target.kind === "fixture-tests");
		const reports = new Map<string, TargetReport>();
		for (const target of targets) {
			reports.set(target.name, {
				name: target.name,
				kind: target.kind,
				path: target.path,
				...(target.clone ? { clone: target.clone } : {}),
				...(target.staleCloneOf === undefined ? {} : { staleCloneOf: target.staleCloneOf }),
				base: {},
				head: {},
				verdict: "SKIP",
				covered: false,
				reasons: [],
			});
		}
		let done = 0;
		const progress = (label: string) => {
			done += 1;
			if (!options.json)
				process.stderr.write(
					`[${done}/${providerTargets.length * 2 + fixtureTargets.length * 2}] ${label}\n`,
				);
		};
		await mapPool(
			providerTargets.flatMap((target) => sides.map(([side, sdk]) => ({ target, side, sdk }))),
			options.jobs,
			async ({ target, side, sdk }) => {
				const report = reports.get(target.name)!;
				try {
					const staged = await stageProvider(target, side, sdk, runDir);
					const [probed, tsc] = await Promise.all([
						probeProvider(staged, sdk, probe),
						typecheck(staged, sdk),
					]);
					report[side] = { probe: probed, tsc };
				} catch (error) {
					report[side] = {
						probe: {
							load: {
								status: "error",
								errorClass: "StagingError",
								message: String(error instanceof Error ? error.message : error).split("\n")[0],
							},
							lint: {},
							warnings: [],
						},
					};
				}
				progress(`${side} ${target.name}`);
			},
		);
		for (const target of fixtureTargets) {
			const report = reports.get(target.name)!;
			for (const [side, sdk] of sides) {
				const staged = await stageApifuse(target, side, sdk, runDir);
				report[side] = {
					tests: await runFixtureTests(staged, target.testFiles ?? [], options.jobs),
				};
				progress(`${side} ${target.name}`);
			}
		}
		const summary: Record<Verdict, number> = {
			SAME: 0,
			BREAK: 0,
			WARN: 0,
			"NOT COVERED": 0,
			SKIP: 0,
		};
		for (const report of reports.values()) {
			const judged = judge(report);
			report.verdict = judged.verdict;
			report.covered = judged.covered;
			report.reasons = judged.reasons;
			if (report.staleCloneOf === undefined) summary[report.verdict] += 1;
		}
		const targetReports = [...reports.values()];
		return {
			base,
			head,
			targetPatterns: [
				...options.targets,
				...(options.fixtureTests ? [`${options.apifuse} (fixture-tests)`] : []),
			],
			targets: targetReports,
			duplicateClones,
			windowRules: countWindowRules(targetReports),
			summary,
		};
	} finally {
		if (!options.keep) rmSync(runDir, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const options = parseArgs(process.argv.slice(2));
	try {
		const report = await scan(options);
		if (options.json) console.log(JSON.stringify(report, null, 2));
		else console.log(renderReport(report));
		process.exit(report.summary.BREAK > 0 ? 1 : 0);
	} catch (error) {
		console.error(`bump-safety-scan: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	}
}
