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
 * Per target and side the scan reports module load (ok / error class), the
 * `tsc --noEmit` error count, the served contract digest
 * (`digestProviderContract(extractProviderContract(provider))`), authoring
 * lint diagnostics by rule id, and the runtime warnings printed while
 * loading. The diff table marks a target BREAK when it loaded or compiled on
 * base and fails on head, or when its contract digest changes; a lint
 * error-level rule or a runtime warning that is new on head is marked WARN;
 * a target that fails on both sides is NOT COVERED (`covered: false` in the
 * JSON), because the diff says nothing about it.
 *
 * The second section counts the one-release window rules across the targets
 * (legacy per-throw error options, defineCursor/defineDraft fieldName or
 * issuedBy, proxy.session.poolSize, approval:, contextKeys, raw .describe()).
 * A rule with 0 users can be deleted with its path; a rule with users cannot.
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

import ts from "typescript";

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
	lint: Record<string, { level: "error" | "warn"; count: number }>;
	warnings: string[];
}

export interface SideResult {
	probe?: ProviderProbe;
	tsc?: { errors: number; sample: string[] };
	tests?: { pass: number; fail: number; files: Record<string, FixtureFileResult> };
}

export interface FixtureFileResult {
	pass: number;
	fail: number;
	firstFailure?: string;
}

export type Verdict = "SAME" | "BREAK" | "WARN" | "NOT COVERED" | "SKIP";

export interface TargetReport {
	name: string;
	kind: "provider" | "fixture-tests";
	path: string;
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
	providers: string[];
	sites: number;
}

export interface ScanReport {
	base: { spec: string; dir: string; version: string };
	head: { spec: string; dir: string; version: string };
	targetPatterns: string[];
	targets: TargetReport[];
	windowRules: WindowRuleUsage[];
	summary: Record<Verdict, number>;
}

interface Target {
	name: string;
	kind: "provider" | "fixture-tests";
	path: string;
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

export function discoverTargets(
	patterns: string[],
	apifuse: string,
	fixtureTests: boolean,
): Target[] {
	const targets: Target[] = [];
	const seen = new Set<string>();
	const workspaceProviders = path.join(DEFAULT_APIFUSE, ".provider-workspace", "providers");
	for (const pattern of patterns) {
		for (const dir of expandPattern(pattern)) {
			if (!isProviderCheckout(dir)) continue;
			const real = realpathSync(dir);
			if (seen.has(real)) continue;
			seen.add(real);
			let name = targetName(real);
			if (targets.some((target) => target.name === name))
				name = `${path.basename(path.dirname(real))}/${name}`;
			const nodeModulesSources = [path.join(real, "node_modules")];
			const id = providerIdOf(real) ?? path.basename(real);
			const twin = path.join(workspaceProviders, id, "node_modules");
			if (twin !== nodeModulesSources[0] && existsSync(twin)) nodeModulesSources.push(twin);
			targets.push({
				name,
				kind: "provider",
				path: real,
				sources: collectSources(real),
				nodeModulesSources,
			});
		}
	}
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
	return targets;
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
	if (parsed.digestError) warnings.add(`digest: ${parsed.digestError}`);
	if (parsed.lintError) warnings.add(`lint: ${parsed.lintError}`);
	return {
		load: parsed.load,
		digest: parsed.digest,
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

async function typecheck(staged: string, sdk: SdkBuild): Promise<SideResult["tsc"]> {
	const tsc = typescriptEntry(staged, sdk);
	if (!tsc) return { errors: -1, sample: ["no typescript install reachable"] };
	const project = ["tsconfig.typecheck.json", "tsconfig.json"]
		.map((name) => path.join(staged, name))
		.find((candidate) => existsSync(candidate));
	if (!project) return { errors: -1, sample: ["no tsconfig"] };
	const result = await run("bun", [tsc, "--noEmit", "--pretty", "false", "-p", project], {
		cwd: staged,
		timeoutMs: 300_000,
	});
	if (result.timedOut) return { errors: -1, sample: ["tsc timed out after 300s"] };
	const lines = `${result.stdout}\n${result.stderr}`
		.split("\n")
		.filter((line) => /error TS\d+/.test(line))
		.map((line) => line.replace(`${staged}/`, "").trim());
	return { errors: lines.length, sample: lines.slice(0, 5) };
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
		const text = `${result.stdout}\n${result.stderr}`;
		const pass = Number(/^\s*(\d+) pass/m.exec(text)?.[1] ?? 0);
		let fail = Number(/^\s*(\d+) fail/m.exec(text)?.[1] ?? 0);
		if (result.timedOut || (result.code !== 0 && pass === 0 && fail === 0))
			fail = Math.max(fail, 1);
		const firstFailure = result.timedOut
			? "timed out after 600s"
			: text
					.split("\n")
					.map((line) => line.trim())
					.find((line) => /^(error:|\(fail\)|[A-Za-z]*Error:|ENOENT)/.test(line));
		return [
			file,
			{
				pass,
				fail,
				...(fail > 0 && firstFailure ? { firstFailure: firstFailure.slice(0, 160) } : {}),
			},
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
		if (base.digest && head.digest && base.digest !== head.digest) {
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
	if (baseTsc && headTsc && baseTsc.errors === 0 && headTsc.errors > 0) {
		escalate("BREAK", `tsc 0 -> ${headTsc.errors}: ${headTsc.sample[0] ?? ""}`);
	}
	const baseWarnings = new Set(base.warnings);
	const newWarnings = head.warnings.filter((line) => !baseWarnings.has(line));
	if (newWarnings.length > 0) {
		escalate("WARN", `new runtime warning: ${newWarnings[0]!.slice(0, 120)}`);
	}
	return { verdict, covered, reasons };
}

const WINDOW_RULES: Array<{
	rule: string;
	description: string;
	count: (source: string) => number;
}> = [
	{
		rule: "legacy-error-options",
		description:
			"per-throw options: { category | retryable } on ProviderError/AuthError/ValidationError",
		count: (source) =>
			callArguments(source, /new\s+(?:ProviderError|AuthError|ValidationError)\s*\(/g).filter(
				(args) => /\b(?:category|retryable)\s*:/.test(args),
			).length,
	},
	{
		rule: "legacy-handle-declaration",
		description: "defineCursor( / defineDraft( with fieldName or issuedBy",
		count: (source) =>
			callArguments(source, /define(?:Cursor|Draft)\s*\(/g).filter((args) =>
				/\b(?:fieldName|issuedBy)\s*:/.test(args),
			).length,
	},
	{
		rule: "proxy-session-pool-size",
		description: "proxy.session.poolSize",
		count: (source) => matches(source, /\bpoolSize\s*:/g),
	},
	{
		rule: "redundant-approval",
		description: "approval: on an operation",
		count: (source) => matches(source, /\bapproval\s*:/g),
	},
	{
		rule: "context-keys",
		description: "contextKeys",
		count: (source) => matches(source, /\bcontextKeys\b/g),
	},
	{
		rule: "schema-describe-prose",
		description: "raw .describe( on a schema",
		count: (source) => matches(source, /\.describe\s*\(/g),
	},
];

/**
 * Blanks every comment the TypeScript parser sees, so a `*\/*` inside a string
 * (an `Accept` header) or a `//` inside a string or template never opens one.
 */
export function stripComments(source: string): string {
	const sourceFile = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
	const ranges = new Map<number, number>();
	const collect = (comments: readonly ts.CommentRange[] | undefined) => {
		for (const comment of comments ?? []) ranges.set(comment.pos, comment.end);
	};
	const visit = (node: ts.Node) => {
		collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
		collect(ts.getTrailingCommentRanges(source, node.getEnd()));
		for (const child of node.getChildren(sourceFile)) visit(child);
	};
	visit(sourceFile);
	let stripped = "";
	let cursor = 0;
	for (const [start, end] of [...ranges.entries()].sort(([left], [right]) => left - right)) {
		if (start < cursor) continue;
		stripped += source.slice(cursor, start);
		cursor = end;
	}
	return stripped + source.slice(cursor);
}

function matches(source: string, pattern: RegExp): number {
	return (source.match(pattern) ?? []).length;
}

/** The argument text of every call matched by `opener` (balanced parentheses, strings skipped). */
function callArguments(source: string, opener: RegExp): string[] {
	const out: string[] = [];
	opener.lastIndex = 0;
	for (let match = opener.exec(source); match; match = opener.exec(source)) {
		let depth = 1;
		let quote: string | null = null;
		const start = match.index + match[0].length;
		for (let index = start; index < source.length; index++) {
			const char = source[index]!;
			if (quote) {
				if (char === "\\") index++;
				else if (char === quote) quote = null;
				continue;
			}
			if (char === '"' || char === "'" || char === "`") quote = char;
			else if (char === "(") depth++;
			else if (char === ")" && --depth === 0) {
				out.push(source.slice(start, index));
				break;
			}
		}
	}
	return out;
}

export function countWindowRules(
	targets: Array<Pick<Target, "name" | "sources">>,
): WindowRuleUsage[] {
	return WINDOW_RULES.map(({ rule, description, count }) => {
		const providers: string[] = [];
		let sites = 0;
		for (const target of targets) {
			let hits = 0;
			for (const file of target.sources) {
				let source: string;
				try {
					source = stripComments(readFileSync(file, "utf8"));
				} catch {
					continue;
				}
				hits += count(source);
			}
			if (hits > 0) {
				providers.push(target.name);
				sites += hits;
			}
		}
		return { rule, description, providers, sites };
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
	out.push(`targets: ${report.targets.length} from ${report.targetPatterns.join(", ")}`);
	out.push("");
	const rows: string[][] = [
		["target", "load b/h", "tsc b/h", "digest", "lint b/h", "warns b/h", "verdict", "reason"],
	];
	for (const target of report.targets) {
		const digest =
			target.base.probe?.digest && target.head.probe?.digest
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
			target.verdict,
			target.reasons[0] ?? "",
		]);
	}
	out.push(table(rows));
	out.push("");
	out.push(
		`summary: ${report.summary.BREAK} BREAK, ${report.summary.WARN} WARN, ${report.summary.SAME} SAME, ${report.summary["NOT COVERED"]} NOT COVERED, ${report.summary.SKIP} SKIP`,
	);
	for (const target of report.targets) {
		if (target.verdict === "BREAK" || target.verdict === "WARN") {
			for (const reason of target.reasons)
				out.push(`  ${target.verdict} ${target.name}: ${reason}`);
		}
	}
	const uncovered = report.targets.filter((target) => !target.covered);
	if (uncovered.length > 0) {
		out.push("");
		out.push(
			`not covered: ${uncovered.length} target(s) fail on both sides (the diff says nothing about them)`,
		);
		for (const target of uncovered) {
			for (const reason of target.reasons) {
				if (!/^fails to load on both sides: |fail on both sides: /.test(reason)) continue;
				out.push(`  ${target.name}: ${reason.replace(/^fails to load on both sides: /, "")}`);
			}
		}
	}
	out.push("");
	out.push(
		`window rules over the ${report.targets.length} target(s) above (deletion gate: a rule and its one-release path can go only at 0 users on the default target set)`,
	);
	const usageRows: string[][] = [["rule", "providers", "sites", "gate", "users"]];
	for (const usage of report.windowRules) {
		usageRows.push([
			usage.rule,
			String(usage.providers.length),
			String(usage.sites),
			usage.providers.length === 0 ? "DELETABLE" : "KEEP",
			usage.providers.slice(0, 6).join(", ") +
				(usage.providers.length > 6 ? `, +${usage.providers.length - 6}` : ""),
		]);
	}
	out.push(table(usageRows));
	return out.join("\n");
}

export async function scan(options: Options): Promise<ScanReport> {
	mkdirSync(options.scratch, { recursive: true });
	const runDir = path.join(options.scratch, `run-${Date.now().toString(36)}-${process.pid}`);
	mkdirSync(runDir, { recursive: true });
	try {
		const base = await resolveSdk(options.base, options.scratch);
		const head = await resolveSdk(options.head, options.scratch);
		const targets = discoverTargets(options.targets, options.apifuse, options.fixtureTests);
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
			summary[report.verdict] += 1;
		}
		return {
			base,
			head,
			targetPatterns: [
				...options.targets,
				...(options.fixtureTests ? [`${options.apifuse} (fixture-tests)`] : []),
			],
			targets: [...reports.values()],
			windowRules: countWindowRules(targets),
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
