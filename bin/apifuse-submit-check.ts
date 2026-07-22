#!/usr/bin/env bun

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as acorn from "acorn";
import { z } from "zod";

import packageJson from "../package.json";
import type { ProviderDefinition } from "../src/index.js";
import {
	loadProviderLocaleCatalogs,
	type ProviderLocale,
	validateProviderLocaleCatalogs,
} from "../src/i18n/index.js";
import { APIFUSE_DESCRIPTION_KEY_META_KEY } from "../src/schema.js";
import { safeParseSchemaSync } from "../src/schema.js";
import { type CheckResult, runChecks } from "./apifuse-check.js";
import { hasSubstantiveXmlStructure } from "./submit-check-xml.js";

const TIERS = ["bronze", "silver", "gold", "diamond"] as const;
const TIER_VALUES: ReadonlySet<string> = new Set(TIERS);
type BountyTier = (typeof TIERS)[number];

type CheckLevel = "blocker" | "warn" | "info";
type CheckStatus = "pass" | "fail" | "warn" | "not_applicable";
type Verdict = "ready" | "reviewable_with_warnings" | "blocked";

export type SubmitCheck = {
	id: string;
	category: string;
	level: CheckLevel;
	status: CheckStatus;
	points: number;
	maxPoints: number;
	message: string;
	remediation?: string;
	evidence?: string[];
	details?: unknown;
};

export type SubmitCheckReport = {
	schemaVersion: 1;
	generatedAt: string;
	provider: {
		id: string;
		version: string;
		runtime: string;
		authMode: string;
		sdkVersion: string;
		tier?: BountyTier;
	};
	score: {
		total: number;
		max: 100;
		verdict: Verdict;
	};
	summary: {
		blockers: number;
		warnings: number;
		passed: number;
	};
	checks: SubmitCheck[];
};

export function isAutoPromotionEligible(report: SubmitCheckReport): boolean {
	return report.score.total >= 95 && report.summary.blockers === 0;
}

type CliArgs = {
	isJson: boolean;
	markdownPath?: string;
	providerPath?: string;
	smoke: boolean;
	smokeNote?: string;
	tier?: BountyTier;
};

type SecretFinding = {
	label: string;
	file: string;
	line?: number;
	level?: CheckLevel;
	remediation?: string;
	evidence?: string;
};

export type SmokeOperationOutcome = {
	operationId: string;
	status: "success" | "structured_error" | "incoherent";
	httpStatus?: number;
	message: string;
};

export type SmokeResult = {
	measured: true;
	healthOk: boolean;
	bootError?: string;
	operations: SmokeOperationOutcome[];
};

type SourceFinding = {
	file: string;
	line: number;
};

const SDK_NATIVE_CATEGORY = "sdk-native";
const VENDOR_SHIM_PROVIDER_ID_PREFIX = "apifuse-provider-";
const MAX_SOURCE_FINDING_EVIDENCE = 5;

const CATEGORY_MAX_POINTS = {
	definition: 15,
	operations: 15,
	fixtures: 15,
	health: 15,
	smoke: 10,
	auth: 10,
	security: 10,
	docs: 10,
} as const;

const REQUIRED_PUBLIC_PROVIDER_LOCALES = ["en", "ko"] as const satisfies readonly ProviderLocale[];

const HELP_TEXT = `Usage: apifuse submit-check [path] [--tier bronze|silver|gold|diamond] [--json] [--markdown <path>] [--smoke]
Alias: apifuse bounty-check [path]
Default: apifuse submit-check .

Smoke: --smoke boots the provider dev server, checks /health, and POSTs every operation fixture. APIFUSE__PROVIDER__* env vars enable live upstream calls; without them, structured provider errors can still verify runtime routing. --smoke-note is deprecated and ignored for scoring.`;

export async function main() {
	try {
		const args = parseArgs(normalizeArgs(process.argv.slice(2)));

		if (args.isJson && process.argv.includes("--help")) {
			console.log(JSON.stringify({ help: HELP_TEXT }));
			return;
		}

		const providerRoot = resolveProviderRoot(args.providerPath ?? ".");
		const report = await buildSubmitCheckReport(providerRoot, args);

		if (args.markdownPath) {
			await writeFile(resolve(process.cwd(), args.markdownPath), renderMarkdown(report));
		}

		if (args.isJson) {
			console.log(JSON.stringify(report, null, 2));
		} else {
			console.log(renderText(report));
			if (args.markdownPath) {
				console.log(`\nMarkdown report: ${args.markdownPath}`);
			}
		}

		if (report.score.verdict === "blocked") {
			process.exit(1);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

function normalizeArgs(argv: string[]): string[] {
	const [command, ...rest] = argv;
	return command === "submit-check" || command === "bounty-check" ? rest : argv;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { isJson: false, smoke: false };

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg) continue;

		if (arg === "--help" || arg === "-h") {
			console.log(HELP_TEXT);
			process.exit(0);
		}

		if (arg === "--json") {
			args.isJson = true;
			continue;
		}

		if (arg === "--markdown") {
			args.markdownPath = requireValue(argv, index, arg);
			index += 1;
			continue;
		}

		if (arg.startsWith("--markdown=")) {
			args.markdownPath = arg.slice("--markdown=".length);
			continue;
		}

		if (arg === "--smoke") {
			args.smoke = true;
			continue;
		}

		if (arg === "--smoke-note") {
			args.smokeNote = requireValue(argv, index, arg);
			index += 1;
			continue;
		}

		if (arg.startsWith("--smoke-note=")) {
			args.smokeNote = arg.slice("--smoke-note=".length);
			continue;
		}

		if (arg === "--tier") {
			args.tier = parseTier(requireValue(argv, index, arg));
			index += 1;
			continue;
		}

		if (arg.startsWith("--tier=")) {
			args.tier = parseTier(arg.slice("--tier=".length));
			continue;
		}

		if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}

		if (!args.providerPath) {
			args.providerPath = arg;
			continue;
		}

		throw new Error(`Unexpected argument: ${arg}`);
	}

	return args;
}

function requireValue(argv: string[], index: number, label: string): string {
	const value = argv[index + 1];
	if (!value) {
		throw new Error(`Missing value for ${label}.`);
	}
	return value;
}

function parseTier(value: string): BountyTier {
	if (isBountyTier(value)) {
		return value;
	}
	throw new Error(`Invalid --tier "${value}". Expected one of: ${TIERS.join(", ")}`);
}

function isBountyTier(value: string): value is BountyTier {
	return TIER_VALUES.has(value);
}

export async function buildSubmitCheckReport(
	providerRoot: string,
	args: { smoke?: boolean; smokeNote?: string; tier?: BountyTier } = {},
): Promise<SubmitCheckReport> {
	const checks: SubmitCheck[] = [];
	const baseChecks = await safeRunChecks(providerRoot);
	const provider = await safeLoadProvider(providerRoot);

	checks.push(...scoreBaseChecks(baseChecks));
	checks.push(scoreProviderIdSlug(providerRoot, provider));
	checks.push(scoreNoVendorShim(providerRoot));
	checks.push(scoreNoVendorImport(providerRoot));
	checks.push(scoreDescribeKey(providerRoot));
	checks.push(scoreNoRawFetch(providerRoot));
	checks.push(scoreNoRedundantRuntimeGuards(providerRoot));
	checks.push(scoreManagedBrowserRuntime(providerRoot));
	checks.push(scoreAsAssertionCount(providerRoot));
	checks.push(scoreUnsafeInputPassthrough(providerRoot));
	checks.push(scoreUnjustifiedLooseSchema(providerRoot));
	checks.push(scoreFlatOperationComposition(providerRoot));

	if (provider) {
		const smokeResult = args.smoke ? await runSubmitCheckSmoke(providerRoot, provider) : undefined;
		checks.push(scoreCredentialUsage(providerRoot, provider));
		checks.push(scoreSdkOwnedSecretPresence(providerRoot, provider));
		checks.push(scoreLocaleCatalog(providerRoot, provider));
		checks.push(scoreOperationMetadata(provider));
		checks.push(scoreFixtureCoverage(provider));
		checks.push(scoreFixtureProvenance(providerRoot, provider));
		checks.push(scoreVendorKeyLeak(providerRoot));
		checks.push(scoreVendorTimestampLeak(providerRoot));
		checks.push(scoreHealthCoverage(provider));
		checks.push(scoreAuthSafety(provider));
		checks.push(scoreSmoke(smokeResult, args.smokeNote));
		checks.push(...scoreProviderDocs(providerRoot));
		checks.push(scoreRepositoryDx(providerRoot));
		checks.push(scoreSecrets(providerRoot, provider));
	} else {
		checks.push(
			blocker(
				"provider-load",
				"definition",
				"Provider could not be loaded.",
				"Fix index.ts so it default-exports defineProvider(...).",
				CATEGORY_MAX_POINTS.definition,
			),
		);
	}

	const total = clamp(Math.round(checks.reduce((sum, check) => sum + check.points, 0)), 0, 100);
	const blockers = checks.filter(
		(check) => check.level === "blocker" && check.status === "fail",
	).length;
	const warnings = checks.filter((check) => check.status === "warn").length;
	const passed = checks.filter((check) => check.status === "pass").length;
	const verdict: Verdict =
		blockers > 0 ? "blocked" : total >= 90 && warnings === 0 ? "ready" : "reviewable_with_warnings";

	return {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		provider: {
			id: provider?.id ?? basename(providerRoot),
			version: provider?.version ?? "unknown",
			runtime: provider?.runtime ?? "unknown",
			authMode: provider?.auth?.mode ?? "none",
			sdkVersion: packageJson.version,
			...(args.tier ? { tier: args.tier } : {}),
		},
		score: { total, max: 100, verdict },
		summary: { blockers, warnings, passed },
		checks,
	};
}

function scoreProviderIdSlug(
	providerRoot: string,
	provider: ProviderDefinition | undefined,
): SubmitCheck {
	const remediation =
		'Rename defineProvider({ id }) to the short slug (e.g. "tabelog", not "apifuse-provider-tabelog"). Also update manifest/PROVIDER_ID consts and tests. Grep: git grep "apifuse-provider-<name>".';

	// Prefer the loaded provider id; fall back to scanning source so the rule
	// still fires when the provider fails to load (e.g. a vendor shim or other
	// structural problem prevents defineProvider from resolving).
	if (provider) {
		if (provider.id.startsWith(VENDOR_SHIM_PROVIDER_ID_PREFIX)) {
			return blocker(
				"id-slug",
				SDK_NATIVE_CATEGORY,
				"Provider id uses the apifuse-provider- prefix.",
				remediation,
				0,
				[provider.id],
			);
		}

		return pass("id-slug", SDK_NATIVE_CATEGORY, "Provider id uses the short slug.", 0);
	}

	const findings = findSourceLineMatches(providerRoot, /["'`]apifuse-provider-[a-z0-9-]/i);
	if (findings.length > 0) {
		return blocker(
			"id-slug",
			SDK_NATIVE_CATEGORY,
			"Provider id uses the apifuse-provider- prefix.",
			remediation,
			0,
			formatSourceFindings(findings),
		);
	}

	return pass("id-slug", SDK_NATIVE_CATEGORY, "Provider id uses the short slug.", 0);
}

function scoreNoVendorShim(providerRoot: string): SubmitCheck {
	const vendorPath = resolve(providerRoot, "vendor");
	if (existsSync(vendorPath)) {
		return blocker(
			"no-vendor-shim",
			SDK_NATIVE_CATEGORY,
			"Provider contains a vendor/ SDK shim directory.",
			"Delete vendor/ and import directly from @apifuse/provider-sdk (/provider, root, /testing). SDK-absent symbols (e.g. createStateContext) must use real SDK equivalents (createUnsupportedProviderRuntimeState for unused ctx.state).",
			0,
			[vendorPath],
		);
	}

	return pass(
		"no-vendor-shim",
		SDK_NATIVE_CATEGORY,
		"Provider does not contain a vendor/ SDK shim directory.",
		0,
	);
}

function scoreNoVendorImport(providerRoot: string): SubmitCheck {
	const findings = findSourceLineMatches(providerRoot, /from\s+["'][^"']*vendor\//);
	if (findings.length > 0) {
		return blocker(
			"no-vendor-import",
			SDK_NATIVE_CATEGORY,
			"Provider source imports from vendor/ shim.",
			"Re-point every import from ../vendor/provider-sdk to @apifuse/provider-sdk/provider, @apifuse/provider-sdk, or @apifuse/provider-sdk/testing.",
			0,
			formatSourceFindings(findings),
		);
	}

	return pass(
		"no-vendor-import",
		SDK_NATIVE_CATEGORY,
		"Provider source imports directly from the SDK.",
		0,
	);
}

function scoreDescribeKey(providerRoot: string): SubmitCheck {
	const findings = findSourceLineMatches(providerRoot, /\.describe\(["']/);
	if (findings.length > 0) {
		return blocker(
			"describe-key",
			SDK_NATIVE_CATEGORY,
			"Schema descriptions use raw .describe() prose instead of describeKey.",
			'Replace .describe("prose") with describeKey(schema, key, { description }) backed by locale keys in locales/en.json + ko.json.',
			0,
			formatSourceFindings(findings),
		);
	}

	return pass("describe-key", SDK_NATIVE_CATEGORY, "Schema descriptions use describeKey.", 0);
}

function scoreNoRawFetch(providerRoot: string): SubmitCheck {
	const findings = findSourceLineMatches(providerRoot, /(?<![.\w])fetch\s*\(/);
	if (findings.length > 0) {
		const evidence = formatSourceFindings(findings);
		return blocker(
			"no-raw-fetch",
			SDK_NATIVE_CATEGORY,
			"Provider source calls raw fetch().",
			`Replace raw fetch() in ${evidence.join(", ")} with ctx.stealth.fetch() for stealth/cloud-IP-sensitive calls or ctx.http.get/post/request for ordinary HTTP calls.`,
			0,
			evidence,
		);
	}

	return pass("no-raw-fetch", SDK_NATIVE_CATEGORY, "Provider source avoids raw fetch().", 0);
}

const REDUNDANT_RUNTIME_GUARD_PATTERNS: readonly RegExp[] = [
	/\bctx\.(?:stealth|http|cache|state|browser|trace|auth|stt|choice)\?\./,
];

const SDK_CONTEXT_METHOD_ALIAS_PATTERN =
	/\bconst\s+(\w+)\s*=\s*ctx\.(?:stealth|http|cache|state|browser|trace|auth|stt|choice)\.(?:\w+)/;

function hasRedundantRuntimeGuard(line: string, remainingLines: readonly string[]): boolean {
	if (REDUNDANT_RUNTIME_GUARD_PATTERNS.some((pattern) => pattern.test(line))) {
		return true;
	}

	const aliasMatch = SDK_CONTEXT_METHOD_ALIAS_PATTERN.exec(line);
	const alias = aliasMatch?.[1];
	if (!alias) {
		return false;
	}

	const guardPattern = new RegExp(`(?:typeof\\s+${alias}\\s*!==\\s*["']function["']|!${alias}\\b)`);
	return remainingLines.slice(0, 8).some((candidate) => guardPattern.test(candidate));
}

function scoreNoRedundantRuntimeGuards(providerRoot: string): SubmitCheck {
	const findings = findSourceFindings(providerRoot, hasRedundantRuntimeGuard);
	if (findings.length > 0) {
		return blocker(
			"no-redundant-runtime-guards",
			SDK_NATIVE_CATEGORY,
			"Provider source has redundant runtime guard code for SDK-owned context APIs.",
			"Trust the provider SDK context contract: call ctx.stealth.fetch(), ctx.http, and other SDK-owned context APIs directly. Remove optional chaining and typeof function guards around non-null runtime clients.",
			0,
			formatSourceFindings(findings),
		);
	}

	return pass(
		"no-redundant-runtime-guards",
		SDK_NATIVE_CATEGORY,
		"Provider source avoids redundant runtime guard code around SDK-owned context APIs.",
		0,
	);
}

const AS_ASSERTION_PATTERN =
	/\bas\s+(any|unknown|never|string|number|boolean)\b|\bas\s+[A-Z]|\bas\s+\{|\bas\s+Record\b|\bas\s+typeof\b/;

function countAsAssertions(providerRoot: string): {
	count: number;
	findings: SourceFinding[];
} {
	let count = 0;
	const findings: SourceFinding[] = [];

	for (const filePath of listNonTestTypeScriptFiles(providerRoot)) {
		const content = readFileSync(filePath, "utf8");
		const lines = content.split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (
				line === undefined ||
				line.includes("import") ||
				/\bas\s*const\b/.test(line) ||
				!AS_ASSERTION_PATTERN.test(line)
			) {
				continue;
			}

			count += 1;
			if (findings.length < MAX_SOURCE_FINDING_EVIDENCE) {
				findings.push({
					file: toRelativeProviderPath(providerRoot, filePath),
					line: index + 1,
				});
			}
		}
	}

	return { count, findings };
}

function scoreAsAssertionCount(providerRoot: string): SubmitCheck {
	const { count, findings } = countAsAssertions(providerRoot);
	const assertionLabel = "as " + "Type";
	const remediation = `Replace \`${assertionLabel}\` with zod \`schema.safeParse()\` or \`if ('key' in obj)\` type guards. \`as const\` is allowed.`;

	if (count > 20) {
		return blocker(
			"as-assertion-count",
			SDK_NATIVE_CATEGORY,
			`Provider uses ${count} type assertions (${assertionLabel}). Replace with zod safeParse or type guards.`,
			remediation,
			0,
			formatSourceFindings(findings),
		);
	}

	if (count >= 6) {
		return {
			id: "as-assertion-count",
			category: SDK_NATIVE_CATEGORY,
			level: "warn",
			status: "warn",
			points: 0,
			maxPoints: 0,
			message: `Provider uses ${count} type assertions (${assertionLabel}). Replace with zod safeParse or type guards.`,
			remediation,
			evidence: formatSourceFindings(findings),
		};
	}

	return pass(
		"as-assertion-count",
		SDK_NATIVE_CATEGORY,
		"Type assertions are within the recommended limit.",
		0,
	);
}

// Returns true when `findingLine` (1-based) or the line directly above it
// carries an `// @apifuse-allow <ruleId>:` acknowledgement comment.
function hasAllowOverride(lines: readonly string[], findingLine: number, ruleId: string): boolean {
	const pattern = new RegExp(`@apifuse-allow\\s+${ruleId}\\b`);
	const current = lines[findingLine - 1];
	const previous = lines[findingLine - 2];
	return (
		(current !== undefined && pattern.test(current)) ||
		(previous !== undefined && pattern.test(previous))
	);
}

// Splits source findings into non-overridden (still violations) and
// acknowledged (escape-hatched) sets by re-reading each file's lines.
function partitionAllowOverrides(
	providerRoot: string,
	findings: readonly SourceFinding[],
	ruleId: string,
): { violations: SourceFinding[]; overridden: SourceFinding[] } {
	const fileLineCache = new Map<string, string[]>();
	const violations: SourceFinding[] = [];
	const overridden: SourceFinding[] = [];

	for (const finding of findings) {
		const absolute = resolve(providerRoot, finding.file);
		let lines = fileLineCache.get(absolute);
		if (lines === undefined) {
			lines = readFileSync(absolute, "utf8").split(/\r?\n/);
			fileLineCache.set(absolute, lines);
		}
		if (hasAllowOverride(lines, finding.line, ruleId)) {
			overridden.push(finding);
		} else {
			violations.push(finding);
		}
	}

	return { violations, overridden };
}

// Builds a blocker/warn/pass result for an escape-hatch-aware rule:
// any non-overridden finding => blocker; only acknowledged overrides => warn;
// nothing => pass.
function escapeHatchResult(
	providerRoot: string,
	ruleId: string,
	findings: readonly SourceFinding[],
	copy: { blockerMessage: string; remediation: string; passMessage: string },
): SubmitCheck {
	if (findings.length === 0) {
		return pass(ruleId, SDK_NATIVE_CATEGORY, copy.passMessage, 0);
	}

	const { violations, overridden } = partitionAllowOverrides(providerRoot, findings, ruleId);

	if (violations.length > 0) {
		return blocker(
			ruleId,
			SDK_NATIVE_CATEGORY,
			copy.blockerMessage,
			copy.remediation,
			0,
			formatSourceFindings(violations),
		);
	}

	return {
		id: ruleId,
		category: SDK_NATIVE_CATEGORY,
		level: "warn",
		status: "warn",
		points: 0,
		maxPoints: 0,
		message: `${copy.blockerMessage} ${overridden.length} acknowledged @apifuse-allow override(s).`,
		remediation: copy.remediation,
		evidence: formatSourceFindings(overridden),
	};
}

// 1-based line number of a character offset in `source`.
function offsetToLine(source: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset && index < source.length; index += 1) {
		if (source[index] === "\n") {
			line += 1;
		}
	}
	return line;
}

// ---------------------------------------------------------------------------
// SDK-native structural rules (input-passthrough, loose-schema, flat-operation)
//
// SCOPE & LIMITATION: these checks are source-grep heuristics, not a full AST
// analysis. They are deliberately tuned against the new-structure golden corpus
// (demaecan / kakaomap / triple) to catch the common non-standard SDK
// integration shapes seen in bounty submissions: inline/aliased/multi-line
// input .passthrough(), unjustified loose schemas, and factory-composed
// operations (inline, aliased, destructured, sibling-module, or unresolved
// import). They balance brackets and resolve one alias hop across the whole
// provider submission so trivial formatting/aliasing/module-split bypasses do
// not slip through.
//
// The flat-operation rule guards the "unsafe form" (an op map built by an
// OPAQUE builder whose operation set is hidden at the call site), not the mere
// presence of a function call. The stdlib enumerate-and-reshape idiom
// `Object.fromEntries(Object.entries(<source-visible obj>) ...)` is exempted:
// its op set still originates from a source-enumerable object and is only
// filtered/reshaped by pure built-ins. This is the verified golden pattern
// (triple narrows a statically-defined op object by a whitelist Set). Any other
// call — `makeOperations()`, a destructured factory, or
// `Object.fromEntries(buildEntries())` with no source-visible `Object.entries`
// — stays classified as factory composition and is blocked.
//
// They do NOT achieve AST-completeness. Known residual bypasses (schemas or
// operation maps imported from an external npm package, computed/dynamic
// property construction, or deliberate obfuscation) are out of reach for a
// text scan. submit-check is a bounty-workspace gate that runs ALONGSIDE human
// review; manual review remains the final backstop for adversarial submissions.
// Promoting these rules to a real TypeScript AST pass (ts.createSourceFile)
// is tracked as deferred follow-up work (Phase 8.7) and would require adding
// TypeScript as a provider-sdk dependency.
// ---------------------------------------------------------------------------

// Matches a `.passthrough()` call tolerant of whitespace before the parens or
// between them, so `.passthrough ()` / `.passthrough\n()` are still detected.
const PASSTHROUGH_CALL = /\.passthrough\s*\(\s*\)/;

// Strips redundant wrapping parentheses from an expression so that a value like
// `(makeOperations())` or `((x))` classifies the same as `makeOperations()`.
// Only unwraps when the leading `(` matches the trailing `)` at depth 0 (i.e.
// the whole expression is parenthesized), preserving call expressions such as
// `makeOperations()` whose first `(` is not a wrapper.
function unwrapParens(expr: string): string {
	let value = expr.trim();
	while (value.startsWith("(")) {
		let depth = 0;
		let matchIndex = -1;
		for (let i = 0; i < value.length; i += 1) {
			const ch = value[i];
			if (ch === "(") {
				depth += 1;
			} else if (ch === ")") {
				depth -= 1;
				if (depth === 0) {
					matchIndex = i;
					break;
				}
			}
		}
		// Only a true wrapper spans the entire expression (closing paren is the
		// last char). Otherwise the leading `(` belongs to a sub-expression.
		if (matchIndex === value.length - 1) {
			value = value.slice(1, -1).trim();
		} else {
			break;
		}
	}
	return value;
}

// Returns the value-expression substring starting at `valueStart`, balanced
// across (){}[] and stopping at the first top-level `,`/`;` or unmatched
// closing bracket. This lets a property value be read across newlines, so a
// multi-line `input: z.object({...})\n.passthrough()` is captured whole.
function balancedValueExpression(source: string, valueStart: number): string {
	const masked = maskCommentsAndStrings(source);
	let depth = 0;
	let index = valueStart;
	for (; index < source.length; index += 1) {
		const ch = masked[index];
		if (ch === "(" || ch === "{" || ch === "[") {
			depth += 1;
		} else if (ch === ")" || ch === "}" || ch === "]") {
			if (depth === 0) {
				break;
			}
			depth -= 1;
		} else if ((ch === "," || ch === ";") && depth === 0) {
			break;
		}
	}
	return source.slice(valueStart, index);
}

// True when an object-literal expression spreads a CALL expression at its top
// level, e.g. `{ ...makeOperations() }` or `{ ...a, ...build(x) }`. Spreads
// nested deeper than the outer object (inside handler bodies, nested objects,
// or arrays) are ignored, so only a factory composition of the object itself
// is detected. Input is expected to start at the outer `{`.
function hasTopLevelFactorySpread(expr: string): boolean {
	const open = expr.indexOf("{");
	if (open === -1) {
		return false;
	}
	let depth = 0;
	for (let i = open; i < expr.length; i += 1) {
		const ch = expr[i];
		if (ch === "{" || ch === "(" || ch === "[") {
			depth += 1;
		} else if (ch === "}" || ch === ")" || ch === "]") {
			depth -= 1;
			if (depth === 0) {
				break;
			}
		} else if (ch === "." && depth === 1 && expr.startsWith("...", i)) {
			// A spread at the object's own level. Check whether the spread
			// argument is a call expression (factory) rather than a plain
			// identifier/member spread of an already-built object.
			const rest = expr.slice(i + 3);
			if (/^\s*[A-Za-z_$][\w$.]*\s*\(/.test(rest)) {
				return true;
			}
		}
	}
	return false;
}

// Collects the depth-1 spread IDENTIFIERS of an object-literal expression that
// are bare identifiers (not call expressions), e.g. `{ ...hidden, ...base }` ->
// ["hidden", "base"]. A `...makeOps()` call spread is already caught by
// hasTopLevelFactorySpread, so it is excluded here. These identifiers must be
// resolved to their declarations: `const hidden = makeOperations()` spread as
// `{ ...hidden }` is still a factory-composed map and must block.
function topLevelSpreadIdentifiers(expr: string): string[] {
	const open = expr.indexOf("{");
	if (open === -1) {
		return [];
	}
	const names: string[] = [];
	let depth = 0;
	for (let i = open; i < expr.length; i += 1) {
		const ch = expr[i];
		if (ch === "{" || ch === "(" || ch === "[") {
			depth += 1;
		} else if (ch === "}" || ch === ")" || ch === "]") {
			depth -= 1;
			if (depth === 0) {
				break;
			}
		} else if (ch === "." && depth === 1 && expr.startsWith("...", i)) {
			const rest = expr.slice(i + 3);
			// Bare identifier spread (no call parens) -> needs declaration
			// resolution. `...obj.prop` member spreads are treated as already
			// built and ignored (the leading identifier is captured).
			const m = rest.match(/^\s*([A-Za-z_$][\w$]*)\s*(?![\w$(])/);
			if (m?.[1]) {
				names.push(m[1]);
			}
		}
	}
	return names;
}

// A call expression is an OPAQUE builder (block) when it invokes a
// provider-authored function whose body — and therefore the operation set — is
// not visible at the call site, e.g. `makeOperations()` or a destructured
// `const { operations } = createProviderComposition(...)`. It is NOT opaque
// when it is the stdlib `Object.fromEntries(Object.entries(<obj>) ...)`
// enumerate-and-reshape idiom: the operation set still originates from a
// source-visible object (the `Object.entries(...)` argument) and is merely
// filtered/reshaped by pure built-ins, so the registry/reviewer can still
// enumerate the op map from source. This is the verified golden pattern (a
// statically-defined op object narrowed by a whitelist Set).
//
// The exemption requires `Object.entries(` to be the ROOT of fromEntries'
// FIRST argument — not merely present somewhere inside the expression. This
// rejects opaque maps that only mention `Object.entries` deeper in a predicate,
// e.g. `Object.fromEntries(buildEntries().filter(([id]) => Object.entries(ALLOWED).some(...)))`,
// whose entries still originate from the opaque `buildEntries()` call. Any other
// expression — `Object.fromEntries(buildEntries())`, a destructured factory,
// `makeOperations()` — stays classified as factory composition.
const TRANSPARENT_RESHAPE_HEAD = /^Object\s*\.\s*fromEntries\s*\(/;
const OBJECT_ENTRIES_HEAD = /^Object\s*\.\s*entries\s*\(/;
function isTransparentObjectReshape(expr: string): boolean {
	const head = TRANSPARENT_RESHAPE_HEAD.exec(expr);
	if (!head) {
		return false;
	}
	// First argument starts immediately after `fromEntries(`. The reshape is
	// transparent only when that argument's root callee is `Object.entries(`
	// (optionally chained: `Object.entries(obj).filter(...)`), so the source
	// object is enumerable from source rather than produced by an opaque call.
	const firstArg = expr.slice(head[0].length).trimStart();
	return OBJECT_ENTRIES_HEAD.test(firstArg);
}

// Decide whether an `input:` property at `propIndex` is an operation's public
// input schema (the thing the rule guards) or merely a field literally named
// "input" inside a zod schema body (e.g. modelling an upstream payload that
// happens to have an `input` field: `z.object({ input: z.object(...) })`).
// We walk backwards to the directly-enclosing `{` and inspect the token that
// opened it: if that brace is the argument of a zod builder call such as
// `z.object(`, `z.strictObject(`, `z.looseObject(`, `z.record(`, or a bare
// `.object(` / `.shape(`, the `input` key is a schema field, not an operation
// input. Operation inputs live in a plain object literal (the operation
// definition), so their enclosing `{` is NOT immediately preceded by `(` of a
// schema builder.
function inputKeyIsSchemaField(source: string, propIndex: number): boolean {
	let depth = 0;
	let i = propIndex - 1;
	for (; i >= 0; i -= 1) {
		const ch = source[i];
		if (ch === "}" || ch === ")" || ch === "]") {
			depth += 1;
		} else if (ch === "(" || ch === "[") {
			if (depth === 0) {
				// Reached an opening paren/bracket that directly contains the
				// property — an array/call arg position, not an object literal.
				return false;
			}
			depth -= 1;
		} else if (ch === "{") {
			if (depth === 0) {
				break;
			}
			depth -= 1;
		}
	}
	if (i < 0) {
		return false;
	}
	// `i` indexes the directly-enclosing `{`. Look at the non-whitespace text
	// immediately before it. A zod object/record builder opens with `(` then
	// optionally whitespace then `{`, so the char before `{` is `(` and the
	// callee just before that `(` is a zod builder identifier.
	let j = i - 1;
	while (j >= 0 && /\s/.test(source[j] ?? "")) {
		j -= 1;
	}
	if (source[j] !== "(") {
		return false;
	}
	// Capture the callee identifier chain that ends at this `(` and test its
	// final member against the set of zod builders that take an object body.
	const before = source.slice(Math.max(0, j - 60), j);
	const calleeMatch = before.match(/([A-Za-z_$][\w$]*)\s*$/);
	const callee = calleeMatch?.[1];
	if (callee === undefined) {
		return false;
	}
	const SCHEMA_BODY_BUILDERS = new Set([
		"object",
		"strictObject",
		"looseObject",
		"record",
		"shape",
		"extend",
		"merge",
		"catchall",
		"partial",
		"required",
		"pick",
		"omit",
		"augment",
	]);
	return SCHEMA_BODY_BUILDERS.has(callee);
}

// True when `source` imports the binding `name` from another module, i.e. a
// top-level `import { ..., name, ... } from "..."` (named or aliased) or a
// default/namespace import of `name`. Used to confirm an `input: <alias>`
// reference actually binds to an imported declaration before resolving it
// against the provider-wide passthrough map (prevents same-name collisions
// across unrelated modules from producing false positives).
function fileImportsBinding(source: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`\\bimport\\b[^;]*\\b${escaped}\\b[^;]*\\bfrom\\b`).test(source);
}

// Resolves the ORIGINAL exported name for a local binding `localName`. When the
// file imports it under an alias — `import { requestSchema as inputSchema }` —
// the provider-wide passthrough map is keyed by the exported declaration name
// (`requestSchema`), not the local alias (`inputSchema`), so the alias must be
// mapped back before lookup. Returns `localName` unchanged when there is no
// aliased import (plain `import { requestSchema }` or a local declaration).
function importedOriginalName(source: string, localName: string): string {
	const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Match `<original> as <localName>` inside any import specifier list.
	const aliasMatch = new RegExp(
		`\\bimport\\b[^;]*\\{[^}]*\\b([A-Za-z_$][\\w$]*)\\s+as\\s+${escaped}\\b[^}]*\\}[^;]*\\bfrom\\b`,
	).exec(source);
	return aliasMatch?.[1] ?? localName;
}

function scoreUnsafeInputPassthrough(providerRoot: string): SubmitCheck {
	const findings: SourceFinding[] = [];
	const files = listNonTestTypeScriptFiles(providerRoot);

	// Pass 1: collect every passthrough schema const across the WHOLE provider
	// submission (not per-file), keyed by name -> declaration site. This lets an
	// `input:` in index.ts resolve a non-`input`-named passthrough schema that
	// was declared in another module (e.g. schemas.ts) and imported.
	type ConstSite = { file: string; line: number };
	const passthroughConsts = new Map<string, ConstSite>();
	// Per-file map of passthrough const declarations, so an `input: <alias>` can
	// resolve its ACTUAL binding (a same-file local declaration) before falling
	// back to an imported cross-module schema. This prevents a generic name like
	// `requestSchema` declared in one module from being matched against an
	// unrelated `input: requestSchema` in another module (a false positive on a
	// strict schema that merely shares the identifier).
	const passthroughByFile = new Map<string, Map<string, ConstSite>>();
	const fileSources = new Map<string, string>();
	for (const filePath of files) {
		const source = readFileSync(filePath, "utf8");
		const relPath = toRelativeProviderPath(providerRoot, filePath);
		fileSources.set(filePath, source);
		const localMap = new Map<string, ConstSite>();
		passthroughByFile.set(filePath, localMap);
		const constDecl =
			/(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?\s*=/g;
		for (let match = constDecl.exec(source); match !== null; match = constDecl.exec(source)) {
			const name = match[1];
			if (name === undefined) {
				continue;
			}
			const valueStart = match.index + match[0].length;
			const value = balancedValueExpression(source, valueStart);
			if (PASSTHROUGH_CALL.test(value)) {
				const site: ConstSite = {
					file: relPath,
					line: offsetToLine(source, valueStart),
				};
				localMap.set(name, site);
				// First declaration wins for line attribution; duplicate names
				// across modules are rare and either site is a valid pointer.
				if (!passthroughConsts.has(name)) {
					passthroughConsts.set(name, site);
				}
			}
		}
	}

	const seen = new Set<string>();
	const push = (site: ConstSite) => {
		const key = `${site.file}:${site.line}`;
		if (!seen.has(key)) {
			seen.add(key);
			findings.push({ file: site.file, line: site.line });
		}
	};

	// Pass 2: inspect every `input:` property value across all files. A value
	// that is itself a passthrough expression, or that references a passthrough
	// const by name (resolved against the provider-wide map), is a violation.
	for (const filePath of files) {
		const source = fileSources.get(filePath) ?? readFileSync(filePath, "utf8");
		const relPath = toRelativeProviderPath(providerRoot, filePath);

		const inputProp = /\binput\s*:\s*/g;
		for (let match = inputProp.exec(source); match !== null; match = inputProp.exec(source)) {
			// Skip `input` keys that are fields inside a zod schema body (e.g. an
			// upstream payload modelled as `z.object({ input: ... })`). Only an
			// operation's public `input:` property is in scope for this rule.
			if (inputKeyIsSchemaField(source, match.index)) {
				continue;
			}
			const valueStart = match.index + match[0].length;
			const value = balancedValueExpression(source, valueStart);
			if (PASSTHROUGH_CALL.test(value)) {
				push({ file: relPath, line: offsetToLine(source, valueStart) });
				continue;
			}
			const ref = value.trim().match(/^([A-Za-z_$][\w$]*)/);
			const refName = ref?.[1];
			if (refName) {
				// Resolve the alias by BINDING, not by global name. Prefer a
				// passthrough const declared in THIS file; otherwise only fall
				// back to the provider-wide map when this file actually imports
				// `refName` (so a generic name shared across modules cannot link
				// an unrelated strict input to a foreign passthrough schema).
				const localSite = passthroughByFile.get(filePath)?.get(refName);
				if (localSite) {
					push(localSite);
				} else if (fileImportsBinding(source, refName)) {
					// Imported binding: map a possible `orig as refName` alias
					// back to the exported name the provider-wide map is keyed by.
					const originalName = importedOriginalName(source, refName);
					const site = passthroughConsts.get(refName) ?? passthroughConsts.get(originalName);
					if (site) {
						push(site);
					}
				}
			}
		}

		// `input,` shorthand binds a local `input` const; flag it if that const
		// is a passthrough schema declared in THIS file (the binding the
		// shorthand actually closes over).
		if (/(?:^|\n)[ \t]*input\s*,/.test(source)) {
			const localInput = passthroughByFile.get(filePath)?.get("input");
			if (localInput) {
				push(localInput);
			} else if (fileImportsBinding(source, "input")) {
				const site = passthroughConsts.get("input");
				if (site) {
					push(site);
				}
			}
		}
	}

	return escapeHatchResult(providerRoot, "unsafe-input-passthrough", findings, {
		blockerMessage:
			"Public input schema uses .passthrough(); unknown caller fields are silently accepted or dropped.",
		remediation:
			"Use strict input schemas (z.object({...}) without .passthrough()). If upstream form replay genuinely needs it, allowlist the forwarded fields and add `// @apifuse-allow unsafe-input-passthrough: <reason>`.",
		passMessage: "Input schemas do not use unscoped .passthrough().",
	});
}

function scoreUnjustifiedLooseSchema(providerRoot: string): SubmitCheck {
	const findings: SourceFinding[] = [];

	for (const filePath of listNonTestTypeScriptFiles(providerRoot)) {
		const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (line === undefined || !/\bz\.(record|unknown|any)\s*\(/.test(line)) {
				continue;
			}
			// A `//` justification comment on the same line or the line above
			// (including the `@apifuse-allow loose-schema:` form) acknowledges it.
			const previous = lines[index - 1];
			const justified = line.includes("//") || previous?.trim().startsWith("//") === true;
			if (!justified) {
				findings.push({
					file: toRelativeProviderPath(providerRoot, filePath),
					line: index + 1,
				});
			}
		}
	}

	return escapeHatchResult(providerRoot, "unjustified-loose-schema", findings, {
		blockerMessage: "Loose schema (z.record/z.unknown/z.any) used without justification.",
		remediation:
			"Model the real shape with a typed zod schema. If the upstream payload is genuinely arbitrary, add a `// <reason>` comment or `// @apifuse-allow loose-schema: <reason>` on the line above.",
		passMessage: "Loose schemas are justified or absent.",
	});
}

// True when `name` resolves, anywhere in the provider submission, to a
// declaration whose initializer is an OPAQUE factory — a call expression
// (`const hidden = makeOperations()`) or itself a factory spread — or to an
// imported binding with no local declaration (out-of-view construction). Used
// to classify a top-level spread identifier (`{ ...hidden }`) so an opaque
// factory map cannot be laundered through a variable before being spread. The
// stdlib transparent reshape is NOT treated as a factory (parity with the
// direct-alias classification).
function spreadIdentifierResolvesToFactory(
	providerRoot: string,
	indexPath: string,
	indexSource: string,
	name: string,
): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const declRe = new RegExp(
		`(?:^|\\n)[ \t]*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*(?::[^=\\n]+)?\\s*=`,
		"g",
	);
	let sawDeclaration = false;
	for (const filePath of [
		indexPath,
		...listNonTestTypeScriptFiles(providerRoot).filter((p) => resolve(p) !== resolve(indexPath)),
	]) {
		if (!existsSync(filePath)) {
			continue;
		}
		const fileSource = filePath === indexPath ? indexSource : readFileSync(filePath, "utf8");
		const re = new RegExp(declRe.source, "g");
		for (let m = re.exec(fileSource); m !== null; m = re.exec(fileSource)) {
			sawDeclaration = true;
			const expr = unwrapParens(balancedValueExpression(fileSource, m.index + m[0].length).trim());
			const isFactory =
				(/^[A-Za-z_$][\w$.]*\s*\(/.test(expr) || hasTopLevelFactorySpread(expr)) &&
				!isTransparentObjectReshape(expr);
			if (isFactory) {
				return true;
			}
		}
	}
	// No local declaration anywhere but imported into index.ts => constructed
	// out of view; treat as factory (conservative, false-negative-safe).
	if (!sawDeclaration && fileImportsBinding(indexSource, name)) {
		return true;
	}
	return false;
}

function scoreFlatOperationComposition(providerRoot: string): SubmitCheck {
	const indexPath = resolve(providerRoot, "index.ts");
	const ruleId = "flat-operation-composition";
	if (!existsSync(indexPath)) {
		return pass(
			ruleId,
			SDK_NATIVE_CATEGORY,
			"Provider index.ts not found; flat-operation check skipped.",
			0,
		);
	}

	const source = readFileSync(indexPath, "utf8");
	// Use the same whitespace-tolerant detection as the resolver below, so a
	// `defineProvider (` / `defineProvider\n(` formatting cannot pass the early
	// exit before the real classification runs.
	if (!/\bdefineProvider\s*\(/.test(source)) {
		return pass(
			ruleId,
			SDK_NATIVE_CATEGORY,
			"No defineProvider call to evaluate for operation composition.",
			0,
		);
	}

	// Scope the scan to the argument of the EXPORTED `defineProvider(...)` call.
	// A provider can contain helper/non-exported defineProvider calls before the
	// real default export (e.g. test scaffolds), so resolve the default export
	// rather than blindly taking the first regex match. Resolution order:
	//   1. `export default defineProvider(` — inline default export
	//   2. `export default <ident>` then `const <ident> = defineProvider(`
	//   3. fallback: first `defineProvider(` in the file
	let defineParenIndex = -1;
	const inlineDefault = /\bexport\s+default\s+defineProvider\s*\(/.exec(source);
	if (inlineDefault) {
		defineParenIndex = inlineDefault.index + inlineDefault[0].length - 1; // points at `(`
	} else {
		const namedDefault = /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?/.exec(source);
		const exportedName = namedDefault?.[1];
		if (exportedName !== undefined) {
			const namedDecl = new RegExp(
				`(?:^|\\n)[ \t]*(?:export\\s+)?(?:const|let|var)\\s+${exportedName}\\s*(?::[^=\\n]+)?\\s*=\\s*defineProvider\\s*\\(`,
			).exec(source);
			if (namedDecl) {
				defineParenIndex = namedDecl.index + namedDecl[0].length - 1;
			}
		}
		if (defineParenIndex === -1) {
			const firstCall = /\bdefineProvider\s*\(/.exec(source);
			if (firstCall) {
				defineParenIndex = firstCall.index + firstCall[0].length - 1;
			}
		}
	}
	if (defineParenIndex === -1) {
		return pass(
			ruleId,
			SDK_NATIVE_CATEGORY,
			"No defineProvider call to evaluate for operation composition.",
			0,
		);
	}
	const argStart = defineParenIndex + 1;
	const argText = balancedValueExpression(source, argStart);

	// Resolve the value passed as `operations:` inside the defineProvider call,
	// following one alias hop. The value is classified as a static object
	// literal (pass) or a factory/call expression (block). The regex index is
	// offset back into the full source so line numbers stay accurate.
	const opsProp = /\boperations\s*:\s*/.exec(argText);
	let opsValue: string | undefined;
	let opsLine = 1;
	if (opsProp) {
		const valueStart = argStart + opsProp.index + opsProp[0].length;
		opsValue = unwrapParens(balancedValueExpression(source, valueStart).trim());
		opsLine = offsetToLine(source, valueStart);
	}

	// Property shorthand: `defineProvider({ ..., operations })` — resolve the
	// local `operations` const initializer.
	let aliasName: string | undefined;
	if (opsValue === undefined) {
		if (/\boperations\s*[,}]/.test(argText)) {
			aliasName = "operations";
		}
	} else if (/^[A-Za-z_$][\w$]*$/.test(opsValue)) {
		// `operations: ops` — a bare identifier alias to resolve.
		aliasName = opsValue;
	}

	// Determine the effective initializer expression to classify. The alias may
	// be declared in index.ts OR re-exported from a sibling module (the common
	// generated scaffold: `import { operations } from "./operations"` where
	// ./operations.ts builds the map with makeOperations()/Object.fromEntries).
	// Resolve across every provider source file so cross-module factory
	// composition cannot evade the blocker.
	let effective = opsValue;
	let effectiveLine = opsLine;
	let effectiveFile = "index.ts";
	if (aliasName !== undefined) {
		const aliasDecl = new RegExp(
			`(?:^|\\n)[ \t]*(?:export\\s+)?(?:const|let|var)\\s+${aliasName}\\s*(?::[^=\\n]+)?\\s*=`,
		);
		// Destructured factory form: `const { operations } = makeOps()`.
		const destructured = new RegExp(
			`(?:^|\\n)[ \t]*(?:export\\s+)?(?:const|let|var)\\s*\\{[^}]*\\b${aliasName}\\b[^}]*\\}\\s*=\\s*([A-Za-z_$][\\w$.]*)\\s*\\(`,
		);

		// Search index.ts first (its line attribution wins), then siblings.
		const searchOrder = [
			indexPath,
			...listNonTestTypeScriptFiles(providerRoot).filter((p) => resolve(p) !== resolve(indexPath)),
		];

		// Collect EVERY same-named declaration across the submission and classify
		// each as factory vs static. A factory declaration anywhere wins, so a
		// decoy static `const operations = {}` in an earlier-scanned file cannot
		// mask a factory-composed declaration in another module. (We deliberately
		// do not resolve the exact import target path; "any same-named factory
		// blocks" is the conservative, false-negative-avoiding choice for a gate.)
		type Candidate = {
			expr: string;
			line: number;
			file: string;
			isFactory: boolean;
		};
		const candidates: Candidate[] = [];
		for (const filePath of searchOrder) {
			if (!existsSync(filePath)) {
				continue;
			}
			const fileSource = filePath === indexPath ? source : readFileSync(filePath, "utf8");
			const relPath = toRelativeProviderPath(providerRoot, filePath);

			const declRe = new RegExp(aliasDecl.source, "g");
			for (let m = declRe.exec(fileSource); m !== null; m = declRe.exec(fileSource)) {
				const valueStart = m.index + m[0].length;
				const expr = unwrapParens(balancedValueExpression(fileSource, valueStart).trim());
				const isFactory =
					(/^[A-Za-z_$][\w$.]*\s*\(/.test(expr) || hasTopLevelFactorySpread(expr)) &&
					!isTransparentObjectReshape(expr);
				candidates.push({
					expr,
					line: offsetToLine(fileSource, valueStart),
					file: relPath,
					isFactory,
				});
			}
			const destructRe = new RegExp(destructured.source, "g");
			for (let m = destructRe.exec(fileSource); m !== null; m = destructRe.exec(fileSource)) {
				candidates.push({
					expr: `${m[1]}(`,
					line: offsetToLine(fileSource, m.index),
					file: relPath,
					isFactory: true,
				});
			}
		}

		const resolved = candidates.length > 0;
		if (resolved) {
			// Prefer a factory declaration (it blocks); otherwise keep the first
			// static declaration for line attribution.
			const factory = candidates.find((c) => c.isFactory);
			const chosen = factory ?? candidates[0];
			if (chosen !== undefined) {
				effective = chosen.expr;
				effectiveLine = chosen.line;
				effectiveFile = chosen.file;
			}
		}

		// An imported alias that resolves to no local declaration anywhere in the
		// submission means the operations map is constructed out of view. Treat
		// the unresolved import as a factory-composed (non-static) shape rather
		// than silently passing.
		if (!resolved) {
			const importMatch = new RegExp(`\\bimport\\b[^;]*\\b${aliasName}\\b[^;]*\\bfrom\\b`).exec(
				source,
			);
			if (importMatch) {
				effective = `${aliasName}(`;
				effectiveLine = offsetToLine(source, importMatch.index);
				effectiveFile = "index.ts";
			}
		}
	}

	// A value starting with `{` is an object literal, but it is only STATIC if
	// its TOP-LEVEL entries are all explicit properties. A factory spread such
	// as `{ ...makeOperations() }` still composes the map dynamically. We only
	// inspect depth-1 entries so that ordinary spreads deep inside operation
	// handler bodies (e.g. `{ ...headers }`, `...arr.map(...)`) are NOT mistaken
	// for a top-level factory composition of the operations map itself.
	const hasFactorySpread = effective !== undefined && hasTopLevelFactorySpread(effective);
	// A spread of a bare identifier (`{ ...hidden }`) is static ONLY when that
	// identifier resolves to a non-factory declaration. Resolve each top-level
	// spread identifier so an opaque factory map laundered through a variable
	// (`const hidden = makeOperations(); operations: { ...hidden }`) still blocks.
	const hasFactorySpreadIdentifier =
		effective !== undefined &&
		topLevelSpreadIdentifiers(effective).some((name) =>
			spreadIdentifierResolvesToFactory(providerRoot, indexPath, source, name),
		);
	const isStaticLiteral =
		effective?.startsWith("{") === true && !hasFactorySpread && !hasFactorySpreadIdentifier;
	// A call expression `ident(...)` (factory) or a factory-spread literal is
	// the rejected, non-static shape — UNLESS it is the stdlib
	// `Object.fromEntries(Object.entries(<source-visible obj>)...)` reshape,
	// whose op set is still enumerable from source (verified golden pattern).
	const isFactoryCall =
		effective !== undefined &&
		(/^[A-Za-z_$][\w$.]*\s*\(/.test(effective) || hasFactorySpread || hasFactorySpreadIdentifier) &&
		!isTransparentObjectReshape(effective);

	if (isFactoryCall && !isStaticLiteral) {
		// Route through the shared escape-hatch partitioner so an
		// `// @apifuse-allow flat-operation-composition: <reason>` comment on
		// the reported line (or the line above) downgrades this blocker to a
		// counted warning, consistent with the other structural rules.
		return escapeHatchResult(providerRoot, ruleId, [{ file: effectiveFile, line: effectiveLine }], {
			blockerMessage:
				"defineProvider operations are composed by a factory call instead of a static object literal.",
			remediation:
				"Declare operations as a static literal: defineProvider({ operations: { 'op-id': defineOperation({...}) } }). The provider-registry AST gate requires static runtime/operations; factory composition fails the registry build. If composition is unavoidable, add `// @apifuse-allow flat-operation-composition: <reason>`.",
			passMessage: "defineProvider declares operations as a static object literal.",
		});
	}

	return pass(
		ruleId,
		SDK_NATIVE_CATEGORY,
		"defineProvider declares operations as a static object literal.",
		0,
	);
}

function scoreCredentialUsage(providerRoot: string, provider: ProviderDefinition): SubmitCheck {
	const credentialReferences = findSourceLineMatches(providerRoot, /ctx\.credential/);
	const authMode = provider.auth?.mode ?? "none";
	const credentialKeys = provider.credential?.keys ?? [];
	const storesProviderCredential = authMode !== "none" || credentialKeys.length > 0;

	if (storesProviderCredential && credentialReferences.length === 0) {
		return {
			id: "credential-usage",
			category: SDK_NATIVE_CATEGORY,
			level: "warn",
			status: "warn",
			points: 0,
			maxPoints: 0,
			message: "Credential-backed provider does not reference credential persistence in source.",
			remediation:
				"Persist provider session state through the SDK credential context instead of process-local state. See providers/catchtable for the reference pattern.",
		};
	}

	return pass(
		"credential-usage",
		SDK_NATIVE_CATEGORY,
		authMode === "none" && credentialKeys.length === 0
			? "Provider does not declare reusable credentials."
			: "Credential-backed provider references ctx.credential.",
		0,
		credentialReferences.length > 0 ? formatSourceFindings(credentialReferences) : undefined,
	);
}

// ---------------------------------------------------------------------------
// sdk-owned-secret-presence (warn): provider-local double validation of
// declared env secrets.
//
// The SDK runtime is the single source of truth for secret presence: declared
// `required: true` secrets are validated before every handler/auth-flow
// invocation and fail with the canonical structured MISSING_SECRET error
// (HTTP 400, category credential_unavailable). Provider-local presence guards
// (requireServiceKey/requireApiKey style) are dead weight that historically
// diverged into inconsistent shapes (CONFIGURATION_ERROR vs MISSING_SECRET,
// with/without category), which broke uniform incident attribution when nine
// providers shipped with unprovisioned secrets (2026-07-22).
//
// Heuristic, warn-only: a line reading a declared `required: true` secret via
// `.env.get(...)` (string literal or a const alias of a declared name)
// followed within a small window by a falsy presence check plus a `throw`.
// The rule flags duplication of the SDK gate ONLY: env names that are not
// declared in defineProvider secrets[], and optional declarations
// (`required: false`/omitted) that the runtime deliberately does not enforce,
// are out of scope. Escape hatch:
// `// @apifuse-allow sdk-owned-secret-presence: <reason>`.
// ---------------------------------------------------------------------------

const SDK_OWNED_SECRET_PRESENCE_RULE_ID = "sdk-owned-secret-presence";
const SECRET_PRESENCE_GUARD_LOOKAHEAD_LINES = 10;

const ENV_GET_CALL_PATTERN =
	/\.env\.get\(\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`|([A-Za-z_$][\w$]*))\s*\)/;

const SECRET_ALIAS_CONST_PATTERN =
	/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:"([^"]+)"|'([^']+)'|`([^`$]+)`)/g;

const ENV_GET_ASSIGNMENT_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;]*\.env\.get\(/;

// Const aliases of declared secret names (e.g. `const SERVICE_KEY_ENV =
// "APIFUSE__PROVIDER__X__SERVICE_KEY"`) so aliased `.env.get(SERVICE_KEY_ENV)`
// guards are detected, not just direct string literals.
function buildDeclaredSecretAliasMap(
	providerRoot: string,
	declaredNames: ReadonlySet<string>,
): Map<string, string> {
	const aliases = new Map<string, string>();
	for (const filePath of listNonTestTypeScriptFiles(providerRoot)) {
		const content = readFileSync(filePath, "utf8");
		for (const match of content.matchAll(SECRET_ALIAS_CONST_PATTERN)) {
			const alias = match[1];
			const name = match[2] ?? match[3] ?? match[4];
			if (alias && name && declaredNames.has(name)) {
				aliases.set(alias, name);
			}
		}
	}
	return aliases;
}

function hasLocalSecretPresenceGuard(
	line: string,
	remainingLines: readonly string[],
	declaredNames: ReadonlySet<string>,
	aliases: ReadonlyMap<string, string>,
): boolean {
	const match = ENV_GET_CALL_PATTERN.exec(line);
	if (!match) {
		return false;
	}
	const literal = match[1] ?? match[2] ?? match[3];
	const identifier = match[4];
	const readsDeclaredSecret =
		literal !== undefined
			? declaredNames.has(literal)
			: identifier !== undefined && aliases.has(identifier);
	if (!readsDeclaredSecret) {
		return false;
	}

	const window = [line, ...remainingLines.slice(0, SECRET_PRESENCE_GUARD_LOOKAHEAD_LINES)];
	if (!window.some((candidate) => /\bthrow\b/.test(candidate))) {
		return false;
	}

	// Assigned read (`const key = ctx.env.get(...)`): only a falsy/undefined
	// check on THAT variable counts as a presence guard. Anchoring on the
	// assigned identifier avoids false positives from unrelated guards/throws
	// that merely sit near the env read (mirrors the aliased runtime-guard rule).
	const assigned = ENV_GET_ASSIGNMENT_PATTERN.exec(line)?.[1];
	if (assigned) {
		const escaped = assigned.replace(/\$/g, "\\$");
		const guardPattern = new RegExp(
			`(?:!\\s*${escaped}\\b|\\b${escaped}\\s*===?\\s*(?:undefined|null)\\b|\\b${escaped}\\s*==\\s*null\\b|\\b${escaped}(?:\\?\\.|\\.)length\\s*===?\\s*0\\b)`,
		);
		return window.some((candidate) => guardPattern.test(candidate));
	}

	// Un-assigned read: only an inline presence check on the same line counts,
	// e.g. `if (!ctx.env.get(KEY)) throw ...`.
	return /(?:if\s*\(\s*!|===?\s*undefined\b|==\s*null\b)/.test(line);
}

function scoreSdkOwnedSecretPresence(
	providerRoot: string,
	provider: ProviderDefinition,
): SubmitCheck {
	const passMessage = "Provider relies on SDK-owned secret presence validation.";
	// Only `required: true` declarations: those are exactly what the runtime
	// gate enforces. A presence guard over an optional secret is conditional
	// business logic the SDK will not replace, not double validation.
	const declaredNames: ReadonlySet<string> = new Set(
		(provider.secrets ?? [])
			.filter((secret) => secret.required === true)
			.map((secret) => secret.name),
	);
	if (declaredNames.size === 0) {
		return pass(SDK_OWNED_SECRET_PRESENCE_RULE_ID, SDK_NATIVE_CATEGORY, passMessage, 0);
	}

	const aliases = buildDeclaredSecretAliasMap(providerRoot, declaredNames);
	const findings = findSourceFindings(providerRoot, (line, remainingLines) =>
		hasLocalSecretPresenceGuard(line, remainingLines, declaredNames, aliases),
	);
	if (findings.length === 0) {
		return pass(SDK_OWNED_SECRET_PRESENCE_RULE_ID, SDK_NATIVE_CATEGORY, passMessage, 0);
	}

	const { violations, overridden } = partitionAllowOverrides(
		providerRoot,
		findings,
		SDK_OWNED_SECRET_PRESENCE_RULE_ID,
	);
	if (violations.length === 0) {
		return pass(
			SDK_OWNED_SECRET_PRESENCE_RULE_ID,
			SDK_NATIVE_CATEGORY,
			`${passMessage} ${overridden.length} acknowledged @apifuse-allow override(s).`,
			0,
			formatSourceFindings(overridden),
		);
	}

	return {
		id: SDK_OWNED_SECRET_PRESENCE_RULE_ID,
		category: SDK_NATIVE_CATEGORY,
		level: "warn",
		status: "warn",
		points: 0,
		maxPoints: 0,
		message:
			"Provider source re-validates declared env secret presence locally; the SDK owns this check.",
		remediation:
			"The provider SDK validates declared required secrets before handlers and auth flows run and returns the canonical MISSING_SECRET error (HTTP 400, category credential_unavailable). Declare the secret with required: true in defineProvider({ secrets: [...] }), delete the provider-local presence guard (requireServiceKey/requireApiKey style), and read the value directly with ctx.env.get(); the guard is dead weight and its divergent CONFIGURATION_ERROR-style shape is deprecated. Acknowledge intentional exceptions with `// @apifuse-allow sdk-owned-secret-presence: <reason>`.",
		evidence: formatSourceFindings(violations),
	};
}

function findSourceLineMatches(
	providerRoot: string,
	pattern: RegExp | ((line: string) => boolean),
): SourceFinding[] {
	return findSourceFindings(providerRoot, (line) => matchesLinePattern(line, pattern));
}

function findSourceFindings(
	providerRoot: string,
	matchesLine: (line: string, remainingLines: readonly string[]) => boolean,
): SourceFinding[] {
	const findings: SourceFinding[] = [];
	for (const filePath of listNonTestTypeScriptFiles(providerRoot)) {
		const content = readFileSync(filePath, "utf8");
		const lines = content.split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (line !== undefined && matchesLine(line, lines.slice(index + 1))) {
				findings.push({
					file: toRelativeProviderPath(providerRoot, filePath),
					line: index + 1,
				});
				if (findings.length >= MAX_SOURCE_FINDING_EVIDENCE) {
					return findings;
				}
			}
		}
	}
	return findings;
}

function matchesLinePattern(line: string, pattern: RegExp | ((line: string) => boolean)): boolean {
	return typeof pattern === "function" ? pattern(line) : pattern.test(line);
}

function listNonTestTypeScriptFiles(providerRoot: string): string[] {
	const files: string[] = [];
	collectNonTestTypeScriptFiles(providerRoot, providerRoot, files);
	return files;
}

function listNonTestProviderSourceFiles(providerRoot: string): string[] {
	const files: string[] = [];
	collectNonTestProviderSourceFiles(providerRoot, providerRoot, files);
	return files;
}

function collectNonTestProviderSourceFiles(
	providerRoot: string,
	currentPath: string,
	files: string[],
): void {
	for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
		const entryPath = join(currentPath, entry.name);
		const relativePath = toRelativeProviderPath(providerRoot, entryPath);
		if (entry.isDirectory()) {
			if (shouldScanSourceDirectory(relativePath)) {
				collectNonTestProviderSourceFiles(providerRoot, entryPath, files);
			}
			continue;
		}
		if (
			entry.isFile() &&
			isScannableProviderSourceFile(relativePath) &&
			!isExcludedTestSource(relativePath)
		) {
			files.push(entryPath);
		}
	}
}

function collectNonTestTypeScriptFiles(
	providerRoot: string,
	currentPath: string,
	files: string[],
): void {
	for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
		const entryPath = join(currentPath, entry.name);
		const relativePath = toRelativeProviderPath(providerRoot, entryPath);
		if (entry.isDirectory()) {
			if (shouldScanSourceDirectory(relativePath)) {
				collectNonTestTypeScriptFiles(providerRoot, entryPath, files);
			}
			continue;
		}
		if (entry.isFile() && relativePath.endsWith(".ts") && !isExcludedTestSource(relativePath)) {
			files.push(entryPath);
		}
	}
}

function isScannableProviderSourceFile(relativePath: string): boolean {
	return (
		/\.(?:ts|tsx|js|jsx|mjs|cjs|sh|bash)$/.test(relativePath) ||
		/(?:^|\/)Dockerfile(?:\.|$)/.test(relativePath) ||
		/(?:^|\/)entrypoint(?:\.|$)/.test(relativePath)
	);
}

function shouldScanSourceDirectory(relativePath: string): boolean {
	return ![".git", "node_modules", "dist", "build", "coverage"].includes(relativePath);
}

function isExcludedTestSource(relativePath: string): boolean {
	return (
		relativePath.endsWith(".test.ts") ||
		relativePath.startsWith("__tests__/") ||
		relativePath.includes("/__tests__/") ||
		relativePath.startsWith("tests/") ||
		relativePath.includes("/tests/")
	);
}

function toRelativeProviderPath(providerRoot: string, filePath: string): string {
	return relative(providerRoot, filePath).replaceAll("\\", "/");
}

function formatSourceFindings(findings: readonly SourceFinding[]): string[] {
	return findings.map((finding) => `${finding.file}:${finding.line}`);
}

function scoreRepositoryDx(providerRoot: string): SubmitCheck {
	const missing: string[] = [];
	if (!existsSync(resolve(providerRoot, ".gitignore"))) {
		missing.push(".gitignore");
	}
	if (!existsSync(resolve(providerRoot, "AGENTS.md"))) {
		missing.push("AGENTS.md");
	}

	const packageJsonPath = resolve(providerRoot, "package.json");
	const packageScripts = readPackageScripts(packageJsonPath);
	if (typeof packageScripts?.["type-check"] !== "string") {
		missing.push("package.json scripts.type-check");
	}
	if (!checkScriptRunsTypeCheck(packageScripts?.check)) {
		missing.push("package.json scripts.check includes type-check");
	}

	if (missing.length === 0) {
		return pass(
			"repository-dx",
			"docs",
			"Repository includes generated-provider DX guardrails.",
			0,
		);
	}

	return {
		id: "repository-dx",
		category: "docs",
		level: "warn",
		status: "warn",
		points: 0,
		maxPoints: 0,
		message: `Generated repository DX guardrails are missing: ${missing.join(", ")}.`,
		remediation:
			"Regenerate with the current `apifuse create` template or restore the missing files: .gitignore, AGENTS.md (agent contribution guide), plus `type-check: tsc --noEmit` included from `check`.",
		evidence: missing,
	};
}

function readPackageScripts(packageJsonPath: string): Record<string, unknown> | undefined {
	if (!existsSync(packageJsonPath)) {
		return undefined;
	}

	try {
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		if (!isRecord(packageJson) || !isRecord(packageJson.scripts)) {
			return undefined;
		}
		return packageJson.scripts;
	} catch {
		return undefined;
	}
}

function checkScriptRunsTypeCheck(checkScript: unknown): boolean {
	return (
		typeof checkScript === "string" &&
		/(?:^|&&|;)\s*bun\s+run\s+type-check(?:\s|$)/.test(checkScript)
	);
}

async function safeRunChecks(providerRoot: string): Promise<CheckResult[]> {
	try {
		return await runChecks(providerRoot, { lintMode: "standalone" });
	} catch (error) {
		return [
			{
				message: "Base provider checks can run",
				passed: false,
				details: [error instanceof Error ? error.message : String(error)],
			},
		];
	}
}

const SUBMIT_CHECK_BROWSER_PATTERNS: ReadonlyArray<{
	rule: string;
	pattern: RegExp;
}> = [
	{
		rule: "browser-self-hosted-launch",
		pattern: /\b(?:playwright|chromium|firefox|webkit|puppeteer)\.launch\s*\(/,
	},
	{
		rule: "browser-self-hosted-child-process",
		pattern:
			/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|Bun\.spawn|Bun\.spawnSync)\s*\([^;]*\b(?:google-chrome|chrome|chromium|chromium-browser)\b|\$`[^`]*\b(?:google-chrome|chrome|chromium|chromium-browser)\b/,
	},
	{
		rule: "browser-self-hosted-remote-debugging-port",
		pattern:
			/(?:\b(?:google-chrome|chrome|chromium|chromium-browser)\b[\s\S]{0,240}--remote-debugging-port\b|--remote-debugging-port(?:=|\s+))/,
	},
	{
		rule: "browser-direct-cdp-version-poll",
		pattern: /\/json\/version\b/,
	},
	{
		rule: "browser-provider-local-cdp-env",
		pattern:
			/\b(?!APIFUSE__CDP_POOL__URL\b)[A-Z][A-Z0-9_]*_CDP_URL\b|process\.env(?:\.(?!APIFUSE__CDP_POOL__URL\b)[A-Z0-9_]*_CDP_URL\b|\[\s*["'`](?!APIFUSE__CDP_POOL__URL\b)[A-Z0-9_]*_CDP_URL["'`]\s*\])/,
	},
];

function scoreManagedBrowserRuntime(providerRoot: string): SubmitCheck {
	const maxManagedBrowserEvidence = MAX_SOURCE_FINDING_EVIDENCE * 2;
	const browserFindings: string[] = [];
	for (const filePath of listNonTestProviderSourceFiles(providerRoot)) {
		const content = readFileSync(filePath, "utf8");
		const lines = content.split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (line === undefined) continue;
			for (const { rule, pattern } of SUBMIT_CHECK_BROWSER_PATTERNS) {
				pattern.lastIndex = 0;
				if (!pattern.test(line)) continue;
				browserFindings.push(
					`${rule} ${toRelativeProviderPath(providerRoot, filePath)}:${index + 1}`,
				);
				if (browserFindings.length >= maxManagedBrowserEvidence) break;
			}
			if (browserFindings.length >= maxManagedBrowserEvidence) break;
		}
		if (browserFindings.length >= maxManagedBrowserEvidence) break;
	}

	if (browserFindings.length > 0) {
		return {
			id: "managed-browser-runtime",
			category: SDK_NATIVE_CATEGORY,
			level: "warn",
			status: "warn",
			points: 0,
			maxPoints: 0,
			message:
				"Provider source contains self-hosted browser/CDP patterns that APIFuse maintainers must review before promotion.",
			remediation:
				"Use ctx.browser backed by the managed CDP Pool. Do not launch Playwright/Puppeteer/Chrome, poll /json/version, or read provider-local *_CDP_URL env vars in provider runtime code.",
			evidence: browserFindings.map(redact),
		};
	}

	return pass(
		"managed-browser-runtime",
		SDK_NATIVE_CATEGORY,
		"Provider source avoids self-hosted browser/CDP runtime patterns.",
		0,
	);
}

function scoreBaseChecks(results: CheckResult[]): SubmitCheck[] {
	const failed = results.filter((result) => !result.passed);
	if (failed.length > 0) {
		const remediation = [
			"Run `bunx apifuse check .` from the provider root.",
			...Array.from(new Set(failed.map(baseCheckRemediation))),
		].join(" ");
		return [
			{
				id: "base-checks",
				category: "definition",
				level: "blocker",
				status: "fail",
				points: 0,
				maxPoints: CATEGORY_MAX_POINTS.definition,
				message: "Base provider checks failed.",
				remediation,
				evidence: failed.map((result) =>
					redact(`${result.message}: ${(result.details ?? []).join("; ")}`),
				),
			},
		];
	}

	return [
		{
			id: "base-checks",
			category: "definition",
			level: "info",
			status: "pass",
			points: CATEGORY_MAX_POINTS.definition,
			maxPoints: CATEGORY_MAX_POINTS.definition,
			message: "Base provider checks passed.",
			evidence: results.map((result) => result.message),
		},
	];
}

function baseCheckRemediation(result: CheckResult): string {
	switch (result.message) {
		case "index.ts exists and exports default defineProvider":
			return "Fix `index.ts` so it default-exports `defineProvider({...})`.";
		case "All operations have handler, input, output":
			return "For each operation named in evidence, add `handler`, `input`, and `output` fields to `defineProvider({ operations })`.";
		case "All operations have fixtures":
			return "For each operation named in evidence, add `fixtures.request` and `fixtures.response` values that exercise the operation schemas.";
		case "Zod schemas parse fixtures without error":
			return "Update the failing fixture values or their zod schemas until `fixtures.request` and `fixtures.response` parse cleanly.";
		case "Provider authoring lint has no error-level diagnostics":
			return "Fix each lint diagnostic shown in evidence, then rerun `bunx apifuse check .`.";
		case "Provider metadata is declared in defineProvider":
			return "Fill the missing `defineProvider` metadata fields: `id`, `meta.displayName`, `meta.category`, `runtime`, and `auth.mode`.";
		case "Dockerfile exists":
			return "Add a provider-root `Dockerfile` based on the current `apifuse create` template.";
		case "package.json exists with @apifuse/provider-sdk dependency":
			return "Add `@apifuse/provider-sdk` to `package.json` dependencies.";
		case "Base provider checks can run":
			return "Fix the import/runtime error shown in evidence so `apifuse check` can load the provider.";
		default:
			return `Fix the failing base check "${result.message}" shown in evidence.`;
	}
}

function scoreLocaleCatalog(providerRoot: string, provider: ProviderDefinition): SubmitCheck {
	const requiredKeys = collectProviderRequiredLocaleKeys(provider);
	if (requiredKeys.length === 0) {
		return pass(
			"locale-catalog",
			"operations",
			"No key-owned provider metadata or operation metadata requires locale catalog validation.",
			0,
		);
	}

	try {
		const availableLocales = REQUIRED_PUBLIC_PROVIDER_LOCALES.filter((locale) =>
			existsSync(join(providerRoot, "locales", `${locale}.json`)),
		);
		const catalogs = loadProviderLocaleCatalogs({
			providerDir: providerRoot,
			locales: availableLocales,
		});
		const validation = validateProviderLocaleCatalogs({
			catalogs,
			requiredLocales: REQUIRED_PUBLIC_PROVIDER_LOCALES,
			requiredKeys,
		});
		if (!validation.ok) {
			return blocker(
				"locale-catalog",
				"operations",
				"Provider locale catalog is missing required public-provider copy.",
				"Add provider-local locales/en.json and locales/ko.json values for every provider metadata key, operation descriptionKey, and .describeKey() or describeKey() schema field.",
				0,
				validation.issues.map((issue) => `${issue.locale}:${issue.key}: ${issue.message}`),
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return blocker(
			"locale-catalog",
			"operations",
			"Provider locale catalog is missing required public-provider copy.",
			"Add provider-local locales/en.json and locales/ko.json values for every provider metadata key, operation descriptionKey, and .describeKey() or describeKey() schema field.",
			0,
			[`*:*: ${message}`],
		);
	}

	return pass(
		"locale-catalog",
		"operations",
		"Required provider and operation locale keys resolve in locales/en.json and locales/ko.json.",
		0,
	);
}

function collectProviderRequiredLocaleKeys(provider: ProviderDefinition): string[] {
	const keys = new Set<string>();

	addLocaleKeys(keys, [
		provider.meta.descriptionKey,
		provider.meta.docTitleKey,
		provider.meta.docDescriptionKey,
		provider.meta.docSummaryKey,
		provider.meta.docMarkdownKey,
	]);

	const publicProfile = provider.meta.publicProfile;
	if (publicProfile) {
		addLocaleKeys(keys, [
			publicProfile.displayNameKey,
			publicProfile.shortDescriptionKey,
			publicProfile.longDescriptionKey,
			publicProfile.setupSummaryKey,
			...(publicProfile.capabilityKeys ?? []),
			...(publicProfile.examplePromptKeys ?? []),
			...(publicProfile.requirementKeys ?? []),
			...(publicProfile.limitationKeys ?? []),
		]);
	}

	for (const operation of Object.values(provider.operations)) {
		addLocaleKeys(keys, [
			operation.descriptionKey,
			operation.docs?.titleKey,
			operation.docs?.descriptionKey,
			operation.docs?.summaryKey,
			operation.docs?.markdownKey,
			...(operation.whenToUseKeys ?? []),
			...(operation.whenNotToUseKeys ?? []),
			...collectSchemaDescriptionKeys(operation.input),
			...collectSchemaDescriptionKeys(operation.output),
		]);
	}

	return Array.from(keys);
}

function addLocaleKeys(keys: Set<string>, values: readonly unknown[]): void {
	for (const key of values) {
		if (typeof key === "string" && key.length > 0) {
			keys.add(key);
		}
	}
}

function collectSchemaDescriptionKeys(schema: unknown): string[] {
	if (!(schema instanceof z.ZodType)) {
		return [];
	}
	const jsonSchema = z.toJSONSchema(schema);
	if (!isRecord(jsonSchema)) {
		return [];
	}
	const keys: string[] = [];
	collectJsonSchemaDescriptionKeys(jsonSchema, keys);
	return keys;
}

function collectJsonSchemaDescriptionKeys(schema: Record<string, unknown>, keys: string[]): void {
	const descriptionKey = schema[APIFUSE_DESCRIPTION_KEY_META_KEY];
	if (typeof descriptionKey === "string" && descriptionKey.length > 0) {
		keys.push(descriptionKey);
	}

	for (const value of Object.values(schema)) {
		if (isRecord(value)) {
			collectJsonSchemaDescriptionKeys(value, keys);
		} else if (Array.isArray(value)) {
			for (const item of value) {
				if (isRecord(item)) {
					collectJsonSchemaDescriptionKeys(item, keys);
				}
			}
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scoreOperationMetadata(provider: ProviderDefinition): SubmitCheck {
	const operations = Object.entries(provider.operations);
	const weakDescriptions = operations
		.filter(([, operation]) => {
			// Hard-cut providers move operation copy into locale catalogs via
			// descriptionKey instead of raw inline prose; the resolved text length
			// is enforced at registry catalog-build time, matching how lintOperation
			// skips the raw-description min-length rule when a descriptionKey is set.
			const hasDescriptionKey =
				typeof operation.descriptionKey === "string" && operation.descriptionKey.length > 0;
			if (hasDescriptionKey) return false;
			return true;
		})
		.map(([operationId]) => operationId);
	const missingAnnotations = operations
		.filter(([, operation]) => !operation.annotations)
		.map(([operationId]) => operationId);

	if (weakDescriptions.length > 0) {
		return {
			id: "operation-metadata",
			category: "operations",
			level: "blocker",
			status: "fail",
			points: 0,
			maxPoints: CATEGORY_MAX_POINTS.operations,
			message: "One or more operations have weak descriptions.",
			remediation: `For ${weakDescriptions.join(", ")}, add an operation \`descriptionKey\` backed by \`locales/en.json\` and \`locales/ko.json\`, or add a 150+ character \`description\` explaining when to use it, when not to use it, outputs, and caveats.`,
			evidence: weakDescriptions,
		};
	}

	const points = missingAnnotations.length > 0 ? 11 : CATEGORY_MAX_POINTS.operations;
	return {
		id: "operation-metadata",
		category: "operations",
		level: missingAnnotations.length > 0 ? "warn" : "info",
		status: missingAnnotations.length > 0 ? "warn" : "pass",
		points,
		maxPoints: CATEGORY_MAX_POINTS.operations,
		message:
			missingAnnotations.length > 0
				? "Operations are described, but some are missing safety annotations."
				: "Operation descriptions and metadata are review-ready.",
		remediation:
			missingAnnotations.length > 0
				? `For ${missingAnnotations.join(", ")}, add \`annotations\` with the applicable safety fields, such as \`readOnly\`, \`destructive\`, \`idempotent\`, \`openWorld\`, \`rateLimit\`, or \`timeoutMs\`.`
				: undefined,
		evidence:
			missingAnnotations.length > 0
				? missingAnnotations.map((operationId) => `${operationId}: missing annotations`)
				: operations.map(([operationId]) => operationId),
	};
}

function scoreFixtureCoverage(provider: ProviderDefinition): SubmitCheck {
	const missing = Object.entries(provider.operations)
		.filter(([, operation]) => !operation.fixtures?.request || !operation.fixtures?.response)
		.map(([operationId]) => operationId);
	if (missing.length > 0) {
		return blocker(
			"fixtures",
			"fixtures",
			"One or more operations are missing bidirectional fixtures.",
			`For ${missing.join(", ")}, add \`fixtures.request\` and \`fixtures.response\` values that parse against the operation input and output schemas.`,
			CATEGORY_MAX_POINTS.fixtures,
			missing,
		);
	}
	return pass(
		"fixtures",
		"fixtures",
		"All operations include bidirectional fixtures.",
		CATEGORY_MAX_POINTS.fixtures,
	);
}

const GENERATED_LOCAL_ONLY_SCAFFOLD_REASON = /generated local-only scaffold/i;

function scoreFixtureProvenance(providerRoot: string, provider: ProviderDefinition): SubmitCheck {
	const rawPath = resolve(providerRoot, "__fixtures__", "raw.json");
	let hasRecordedEvidence = false;
	if (existsSync(rawPath)) {
		try {
			hasRecordedEvidence = hasNonEmptyRecordedFixture(JSON.parse(readFileSync(rawPath, "utf8")));
		} catch {
			hasRecordedEvidence = false;
		}
	}

	if (hasRecordedEvidence) {
		return pass(
			"fixture-provenance",
			"fixtures",
			"Recorded upstream fixture evidence is present.",
			0,
		);
	}

	if (allOperationsAreGeneratedLocalScaffold(provider)) {
		return {
			id: "fixture-provenance",
			category: "fixtures",
			level: "warn",
			status: "warn",
			points: 0,
			maxPoints: 0,
			message:
				"Generated local-only scaffold has no recorded upstream fixture evidence yet; run `bun run record` once real operations exist.",
			remediation:
				"Run `bun run record` (apifuse record) against the real upstream to capture raw payloads once real operations exist.",
			evidence: ["__fixtures__/raw.json"],
		};
	}

	return blocker(
		"fixture-provenance",
		"fixtures",
		"No recorded upstream fixture evidence (__fixtures__/raw.json is empty or missing).",
		"Run `bun run record` (apifuse record) against the real upstream to capture actual recorded upstream payloads per operation in __fixtures__/raw.json; derive normalized expectations in tests from mapper(recorded raw). Hand-authored fixtures without recorded provenance are not reviewable.",
		0,
		["__fixtures__/raw.json"],
	);
}

function hasNonEmptyRecordedFixture(value: unknown): boolean {
	return recordedFixtureStats(value, 0).hasNestedSubstance;
}

function recordedFixtureStats(
	value: unknown,
	depth: number,
): { hasNestedSubstance: boolean; leafValues: number } {
	if (value === null || value === undefined) {
		return { hasNestedSubstance: false, leafValues: 0 };
	}
	if (Array.isArray(value)) {
		let leafValues = 0;
		let hasNestedSubstance = false;
		for (const item of value) {
			const child = recordedFixtureStats(item, depth + 1);
			leafValues += child.leafValues;
			hasNestedSubstance ||= child.hasNestedSubstance;
		}
		return {
			hasNestedSubstance: hasNestedSubstance || (depth >= 1 && value.length > 0 && leafValues >= 2),
			leafValues,
		};
	}
	if (typeof value === "object") {
		let leafValues = 0;
		let hasNestedSubstance = false;
		for (const item of Object.values(value)) {
			const child = recordedFixtureStats(item, depth + 1);
			leafValues += child.leafValues;
			hasNestedSubstance ||= child.hasNestedSubstance;
		}
		return {
			hasNestedSubstance:
				hasNestedSubstance || (depth >= 1 && Object.keys(value).length > 0 && leafValues >= 2),
			leafValues,
		};
	}
	if (typeof value === "string") {
		if (value.length === 0) {
			return { hasNestedSubstance: false, leafValues: 0 };
		}
		// A recorded operation value may be a raw XML success payload; treat a
		// substantive, well-formed one as nested evidence while still counting the
		// string as a leaf so existing JSON provenance heuristics are unchanged.
		return { hasNestedSubstance: hasSubstantiveXmlStructure(value), leafValues: 1 };
	}
	return { hasNestedSubstance: false, leafValues: 1 };
}

function allOperationsAreGeneratedLocalScaffold(provider: ProviderDefinition): boolean {
	const operations = Object.values(provider.operations);
	return (
		operations.length > 0 &&
		operations.every((operation) =>
			GENERATED_LOCAL_ONLY_SCAFFOLD_REASON.test(operation.healthCheckUnsupported?.reason ?? ""),
		)
	);
}

function scoreVendorKeyLeak(providerRoot: string): SubmitCheck {
	return escapeHatchResult(
		providerRoot,
		"vendor-key-leak",
		findVendorKeyLeakFindings(providerRoot),
		{
			blockerMessage: "Public schema keys leak raw vendor field names.",
			remediation:
				"Normalize public request/response fields to APIFuse-standard lowerCamelCase names (e.g. isOpen24h, latitude); keep raw vendor keys only in upstream-parsing schemas (const upstream... = z.object(...)). Add `// @apifuse-allow vendor-key-leak` only with a comment explaining why the vendor name is genuinely canonical.",
			passMessage: "No vendor field-name leaks detected in public schemas.",
		},
	);
}

function scoreVendorTimestampLeak(providerRoot: string): SubmitCheck {
	return escapeHatchResult(
		providerRoot,
		"vendor-timestamp-leak",
		findVendorTimestampLeakFindings(providerRoot),
		{
			blockerMessage: "Normalized fixtures carry raw vendor timestamp formats.",
			remediation:
				"Convert vendor compact timestamps (yyyymmdd, HHmm, yyyymmddHHmmss) to ISO 8601 (date, time with timezone) at the mapper boundary; fixtures.response must show the normalized form. Add `// @apifuse-allow vendor-timestamp-leak` only when the value is genuinely not a timestamp.",
			passMessage: "No vendor timestamp formats detected in normalized fixtures.",
		},
	);
}

type ObjectRange = {
	start: number;
	end: number;
};

type ZObjectLiteral = {
	objectStart: number;
	objectEnd: number;
	callStart: number;
};

type NamedObjectRange = ObjectRange & {
	name: string;
};

function findVendorKeyLeakFindings(providerRoot: string): SourceFinding[] {
	const findings: SourceFinding[] = [];
	const seen = new Set<string>();

	for (const filePath of listNonTestTypeScriptFiles(providerRoot)) {
		const source = readFileSync(filePath, "utf8");
		const relPath = toRelativeProviderPath(providerRoot, filePath);
		const upstreamRanges = findUpstreamMarkedConstRanges(source);
		for (const zObject of findZObjectLiterals(source)) {
			if (rangeContainsOffset(upstreamRanges, zObject.callStart)) {
				continue;
			}
			if (!zObjectAppearsPublicOutput(source, zObject)) {
				continue;
			}
			for (const keyFinding of vendorKeyFindingsForObject(source, zObject)) {
				const key = `${relPath}:${keyFinding.line}:${keyFinding.key}`;
				if (!seen.has(key)) {
					seen.add(key);
					findings.push({ file: relPath, line: keyFinding.line });
					if (findings.length >= MAX_SOURCE_FINDING_EVIDENCE) {
						return findings;
					}
				}
			}
		}
	}

	return findings;
}

function findZObjectLiterals(source: string): ZObjectLiteral[] {
	const literals: ZObjectLiteral[] = [];
	const masked = maskCommentsAndStrings(source);
	const callPattern = /\bz\s*\.\s*object\s*\(/g;
	for (let match = callPattern.exec(masked); match !== null; match = callPattern.exec(masked)) {
		const parenIndex = masked.indexOf("(", match.index);
		const objectStart = findNextNonWhitespace(masked, parenIndex + 1);
		if (objectStart === -1 || masked[objectStart] !== "{") {
			continue;
		}
		const objectEnd = findMatchingBracket(masked, objectStart);
		if (objectEnd === -1) {
			continue;
		}
		literals.push({
			objectStart,
			objectEnd,
			callStart: match.index,
		});
		callPattern.lastIndex = objectEnd;
	}
	return literals;
}

function zObjectAppearsPublicOutput(source: string, zObject: ZObjectLiteral): boolean {
	const enclosingConst = findConstValueRangeContaining(source, zObject.callStart);
	if (enclosingConst && /output|response|result/i.test(enclosingConst.name)) {
		return true;
	}
	const before = source.slice(Math.max(0, zObject.callStart - 160), zObject.callStart);
	return /(?:^|[\s,{])(?:output|response)\s*:\s*$/.test(before);
}

function vendorKeyFindingsForObject(
	source: string,
	zObject: ZObjectLiteral,
): Array<{ key: string; line: number }> {
	const keys = collectTopLevelObjectKeys(source, zObject.objectStart, zObject.objectEnd);
	const digitFamilies = new Map<string, Set<string>>();
	for (const key of keys) {
		const member = numberedFamilyMember(key.name);
		if (!member) {
			continue;
		}
		const positions = digitFamilies.get(member.base) ?? new Set<string>();
		positions.add(member.position);
		digitFamilies.set(member.base, positions);
	}

	return keys
		.filter((key) => {
			if (!isAllowedPublicOutputKeyName(key.name)) {
				return true;
			}
			const member = numberedFamilyMember(key.name);
			return member !== null && (digitFamilies.get(member.base)?.size ?? 0) >= 3;
		})
		.map((key) => ({ key: key.name, line: offsetToLine(source, key.offset) }));
}

// A numbered vendor family is a base name plus a numeric position and an
// optional trailing letter suffix, in either compact/camel form (sensor1,
// duty1s) or semantic snake_case form (sensor_1, duty_time_1s). Both styles
// normalize to the same { base, position } so a family of >=3 distinct
// positions is caught regardless of which naming style the vendor leaked
// through. Returns null for names that carry no numeric position.
function numberedFamilyMember(name: string): { base: string; position: string } | null {
	const camelMatch = /^([a-z][a-zA-Z]*)(\d+)[a-z]*$/i.exec(name);
	if (camelMatch?.[1] && camelMatch[2]) {
		return { base: camelMatch[1], position: camelMatch[2] };
	}
	const snakeMatch = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)*?)_(\d+)[a-z]*$/.exec(name);
	if (snakeMatch?.[1] && snakeMatch[2]) {
		return { base: snakeMatch[1], position: snakeMatch[2] };
	}
	return null;
}

// Public output keys may use APIFuse lowerCamelCase (isOpen24h, latitude) or
// semantic snake_case (pharmacy_id, weekly_hours, total_count, scan_exhausted).
// Both are normalized, human-authored names. Raw vendor keys leak through mixed
// case or uppercase acronyms (MKioskTy) and match neither, so they stay flagged.
// Numbered vendor families still pass this name gate in either style
// (sensor1/2/3 or sensor_1/sensor_2/sensor_3), so they are caught separately by
// the >=3-member numberedFamilyMember check in vendorKeyFindingsForObject.
function isAllowedPublicOutputKeyName(name: string): boolean {
	const isLowerCamelCase = /^[a-z][a-zA-Z0-9]*$/.test(name);
	const isSemanticSnakeCase = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name);
	return isLowerCamelCase || isSemanticSnakeCase;
}

function collectTopLevelObjectKeys(
	source: string,
	objectStart: number,
	objectEnd: number,
): Array<{ name: string; offset: number }> {
	const keys: Array<{ name: string; offset: number }> = [];
	const masked = maskCommentsAndStrings(source);
	let index = objectStart + 1;
	while (index < objectEnd) {
		index = skipWhitespaceAndComments(masked, index, objectEnd);
		if (index >= objectEnd || masked[index] === "}") {
			break;
		}
		const keyStart = index;
		let key: string | undefined;
		const quote = source[index];
		if (quote === '"' || quote === "'") {
			const endQuote = findStringEnd(source, index);
			if (endQuote === -1) {
				break;
			}
			key = source.slice(index + 1, endQuote);
			index = endQuote + 1;
		} else if (masked[index] === "[") {
			const computedEnd = findMatchingBracket(masked, index);
			const literalStart = findNextNonWhitespace(masked, index + 1);
			if (computedEnd === -1 || literalStart === -1) {
				break;
			}
			const computedQuote = source[literalStart];
			if (computedQuote === '"' || computedQuote === "'") {
				const literalEnd = findStringEnd(source, literalStart);
				const afterLiteral =
					literalEnd === -1 ? -1 : skipWhitespaceAndComments(masked, literalEnd + 1, computedEnd);
				if (literalEnd !== -1 && afterLiteral === computedEnd) {
					key = source.slice(literalStart + 1, literalEnd);
				}
			}
			index = computedEnd + 1;
		} else {
			const idMatch = /^[A-Za-z_$][\w$]*/.exec(masked.slice(index));
			if (idMatch?.[0]) {
				key = idMatch[0];
				index += idMatch[0].length;
			}
		}
		index = skipWhitespaceAndComments(masked, index, objectEnd);
		if (key && masked[index] === ":") {
			keys.push({ name: key, offset: keyStart });
			index = skipObjectValue(masked, index + 1, objectEnd);
		} else {
			// Spread-based composition is intentionally not expanded here; this gate
			// only evaluates keys visible in the object literal.
			index = skipObjectValue(masked, index, objectEnd);
		}
		if (masked[index] === ",") {
			index += 1;
		}
	}
	return keys;
}

function findVendorTimestampLeakFindings(providerRoot: string): SourceFinding[] {
	const findings: SourceFinding[] = [];
	const seen = new Set<string>();

	for (const filePath of listNonTestTypeScriptFiles(providerRoot)) {
		const source = readFileSync(filePath, "utf8");
		const relPath = toRelativeProviderPath(providerRoot, filePath);
		const zObjectRanges = findZObjectLiterals(source).map((zObject) => ({
			start: zObject.callStart,
			end: zObject.objectEnd,
		}));
		const upstreamRanges = findUpstreamMarkedConstRanges(source);
		const fixtureRanges = findPropertyObjectRanges(source, "fixtures");
		const fixtureResponseRanges = [
			...findPropertyObjectRanges(source, "response"),
			...findPropertyObjectRanges(source, "output"),
		].filter((range) => rangeContainedInRanges(fixtureRanges, range));

		for (const range of fixtureResponseRanges) {
			for (const literal of findStringLiteralsInRange(source, range)) {
				if (
					rangeContainsOffset(zObjectRanges, literal.offset) ||
					rangeContainsOffset(upstreamRanges, literal.offset) ||
					!isVendorTimestampCandidate(
						literal.value,
						propertyKeyForStringLiteral(source, literal.offset),
					)
				) {
					continue;
				}
				const line = offsetToLine(source, literal.offset);
				const key = `${relPath}:${line}:${literal.value}`;
				if (!seen.has(key)) {
					seen.add(key);
					findings.push({ file: relPath, line });
					if (findings.length >= MAX_SOURCE_FINDING_EVIDENCE) {
						return findings;
					}
				}
			}
		}
	}

	return findings;
}

function findPropertyObjectRanges(source: string, propertyName: string): ObjectRange[] {
	const ranges: ObjectRange[] = [];
	const masked = maskCommentsAndStrings(source);
	const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`(?:^|[^\\w$])["']?${escaped}["']?\\s*:`, "g");
	for (let match = pattern.exec(masked); match !== null; match = pattern.exec(masked)) {
		const objectStart = findNextNonWhitespace(masked, match.index + match[0].length);
		if (objectStart === -1 || masked[objectStart] !== "{") {
			continue;
		}
		const objectEnd = findMatchingBracket(masked, objectStart);
		if (objectEnd === -1) {
			continue;
		}
		ranges.push({ start: objectStart, end: objectEnd });
		pattern.lastIndex = objectEnd;
	}
	return ranges;
}

function findUpstreamMarkedConstRanges(source: string): ObjectRange[] {
	return findNamedConstValueRanges(source)
		.filter((range) => /upstream|raw|vendor/i.test(range.name))
		.map(({ start, end }) => ({ start, end }));
}

function findNamedConstValueRanges(source: string): NamedObjectRange[] {
	const ranges: NamedObjectRange[] = [];
	const masked = maskCommentsAndStrings(source);
	const pattern =
		/(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?\s*=/g;
	for (let match = pattern.exec(masked); match !== null; match = pattern.exec(masked)) {
		const name = match[1];
		if (!name) {
			continue;
		}
		const start = match.index + match[0].length;
		const expression = balancedValueExpression(masked, start);
		ranges.push({ name, start, end: start + expression.length });
	}
	return ranges;
}

function findConstValueRangeContaining(
	source: string,
	offset: number,
): NamedObjectRange | undefined {
	return findNamedConstValueRanges(source).find(
		(range) => offset >= range.start && offset <= range.end,
	);
}

function findStringLiteralsInRange(
	source: string,
	range: ObjectRange,
): Array<{ value: string; offset: number }> {
	const literals: Array<{ value: string; offset: number }> = [];
	let index = range.start;
	while (index <= range.end) {
		const quote = source[index];
		if (quote !== '"' && quote !== "'" && quote !== "`") {
			index += 1;
			continue;
		}
		const end = findStringEnd(source, index);
		if (end === -1) {
			break;
		}
		if (quote === "`" && source.slice(index + 1, end).includes("${")) {
			index = end + 1;
			continue;
		}
		literals.push({ value: source.slice(index + 1, end), offset: index });
		index = end + 1;
	}
	return literals;
}

function isVendorTimestampCandidate(value: string, key: string | undefined): boolean {
	if (/^\d{8}$/.test(value)) {
		return isPlausibleCompactDate(value);
	}
	if (/^\d{12}$/.test(value)) {
		return isPlausibleCompactDate(value.slice(0, 8)) && isPlausibleHourMinute(value.slice(8, 12));
	}
	if (/^\d{14}$/.test(value)) {
		const seconds = Number(value.slice(12, 14));
		return (
			isPlausibleCompactDate(value.slice(0, 8)) &&
			isPlausibleHourMinute(value.slice(8, 12)) &&
			seconds >= 0 &&
			seconds <= 59
		);
	}
	if (
		/^\d{4}$/.test(value) &&
		key !== undefined &&
		/(?:^|_)at$|At$|time|date|open|close|updated|created/i.test(key)
	) {
		return isPlausibleHourMinute(value);
	}
	return false;
}

function isPlausibleCompactDate(value: string): boolean {
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(4, 6));
	const day = Number(value.slice(6, 8));
	return year >= 1900 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function isPlausibleHourMinute(value: string): boolean {
	const hour = Number(value.slice(0, 2));
	const minute = Number(value.slice(2, 4));
	return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function findNextNonWhitespace(source: string, start: number): number {
	for (let index = start; index < source.length; index += 1) {
		if (!/\s/.test(source[index] ?? "")) {
			return index;
		}
	}
	return -1;
}

function findMatchingBracket(source: string, openIndex: number): number {
	const open = source[openIndex];
	const close = open === "{" ? "}" : open === "(" ? ")" : open === "[" ? "]" : undefined;
	if (!close) {
		return -1;
	}
	let depth = 0;
	for (let index = openIndex; index < source.length; index += 1) {
		const char = source[index];
		if (char === '"' || char === "'" || char === "`") {
			const stringEnd = findStringEnd(source, index);
			if (stringEnd === -1) {
				return -1;
			}
			index = stringEnd;
			continue;
		}
		if (char === open) {
			depth += 1;
		} else if (char === close) {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

function findStringEnd(source: string, start: number): number {
	const quote = source[start];
	for (let index = start + 1; index < source.length; index += 1) {
		if (source[index] === "\\") {
			index += 1;
			continue;
		}
		if (source[index] === quote) {
			return index;
		}
	}
	return -1;
}

function maskCommentsAndStrings(source: string): string {
	const chars = source.split("");
	for (let index = 0; index < source.length; index += 1) {
		if (source.startsWith("//", index)) {
			const bodyStart = index + 2;
			const newline = source.indexOf("\n", bodyStart);
			const end = newline === -1 ? source.length : newline;
			for (let bodyIndex = bodyStart; bodyIndex < end; bodyIndex += 1) {
				chars[bodyIndex] = " ";
			}
			index = end;
			continue;
		}
		if (source.startsWith("/*", index)) {
			const bodyStart = index + 2;
			const close = source.indexOf("*/", bodyStart);
			const end = close === -1 ? source.length : close;
			for (let bodyIndex = bodyStart; bodyIndex < end; bodyIndex += 1) {
				if (chars[bodyIndex] !== "\n") {
					chars[bodyIndex] = " ";
				}
			}
			index = close === -1 ? source.length : close + 1;
			continue;
		}
		const quote = source[index];
		if (quote !== '"' && quote !== "'" && quote !== "`") {
			continue;
		}
		const end = findStringEnd(source, index);
		if (end === -1) {
			break;
		}
		// Preserve quoted property keys ("response": ...) so range/key scanners
		// can still match them; only string VALUES are blanked.
		let probe = end + 1;
		while (probe < source.length && /\s/.test(source[probe] ?? "")) {
			probe += 1;
		}
		if (source[probe] !== ":") {
			for (let bodyIndex = index + 1; bodyIndex < end; bodyIndex += 1) {
				if (chars[bodyIndex] !== "\n") {
					chars[bodyIndex] = " ";
				}
			}
		}
		index = end;
	}
	return chars.join("");
}

function skipWhitespaceAndComments(source: string, start: number, end: number): number {
	let index = start;
	while (index < end) {
		if (/\s/.test(source[index] ?? "")) {
			index += 1;
			continue;
		}
		if (source.startsWith("//", index)) {
			const newline = source.indexOf("\n", index + 2);
			index = newline === -1 ? end : newline + 1;
			continue;
		}
		if (source.startsWith("/*", index)) {
			const close = source.indexOf("*/", index + 2);
			index = close === -1 ? end : close + 2;
			continue;
		}
		break;
	}
	return index;
}

function skipObjectValue(source: string, start: number, end: number): number {
	let index = start;
	while (index < end) {
		const char = source[index];
		if (char === '"' || char === "'" || char === "`") {
			const stringEnd = findStringEnd(source, index);
			if (stringEnd === -1) {
				return end;
			}
			index = stringEnd + 1;
			continue;
		}
		if (char === "{" || char === "(" || char === "[") {
			const close = findMatchingBracket(source, index);
			if (close === -1) {
				return end;
			}
			index = close + 1;
			continue;
		}
		if (char === "," || char === "}") {
			return index;
		}
		index += 1;
	}
	return index;
}

function rangeContainsOffset(ranges: readonly ObjectRange[], offset: number): boolean {
	return ranges.some((range) => offset >= range.start && offset <= range.end);
}

function rangeContainedInRanges(ranges: readonly ObjectRange[], candidate: ObjectRange): boolean {
	return ranges.some((range) => candidate.start >= range.start && candidate.end <= range.end);
}

function propertyKeyForStringLiteral(source: string, literalOffset: number): string | undefined {
	const masked = maskCommentsAndStrings(source);
	let index = skipWhitespaceBackward(masked, literalOffset - 1);
	if (masked[index] !== ":") {
		return undefined;
	}
	index = skipWhitespaceBackward(masked, index - 1);
	if (index < 0) {
		return undefined;
	}
	if (source[index] === '"' || source[index] === "'") {
		const quote = source[index];
		let start = index - 1;
		while (start >= 0) {
			if (source[start] === quote && source[start - 1] !== "\\") {
				return source.slice(start + 1, index);
			}
			start -= 1;
		}
		return undefined;
	}
	const keyMatch = /[A-Za-z_$][\w$]*$/.exec(masked.slice(0, index + 1));
	return keyMatch?.[0];
}

function skipWhitespaceBackward(source: string, start: number): number {
	let index = start;
	while (index >= 0 && /\s/.test(source[index] ?? "")) {
		index -= 1;
	}
	return index;
}

function scoreHealthCoverage(provider: ProviderDefinition): SubmitCheck {
	const operations = Object.entries(provider.operations);
	const missing: string[] = [];
	const vacuous: string[] = [];
	const placeholder: string[] = [];
	const unsupported: string[] = [];
	const generatedStarter: string[] = [];

	for (const [operationId, operation] of operations) {
		const hasCheck = operation.healthCheck !== undefined;
		const hasUnsupported = operation.healthCheckUnsupported !== undefined;
		if (!hasCheck && !hasUnsupported) {
			missing.push(operationId);
			continue;
		}
		if (hasCheck && !hasUnsupported && hasOnlyVacuousHealthCases(operation.healthCheck)) {
			vacuous.push(operationId);
		}
		if (hasUnsupported) {
			const reason = operation.healthCheckUnsupported?.reason ?? "";
			unsupported.push(operationId);
			if (/generated local-only scaffold/i.test(reason)) {
				generatedStarter.push(operationId);
			}
			if (
				/(todo|later|tbd|test fixture|unit test|placeholder|not sure|skip for test)/i.test(reason)
			) {
				placeholder.push(operationId);
			}
		}
	}

	if (missing.length > 0) {
		return blocker(
			"health-coverage",
			"health",
			"One or more operations lack healthCheck or healthCheckUnsupported.",
			`For ${missing.join(", ")}, add \`healthCheck: { interval, cases }\` for safe read-only upstream probes, or add \`healthCheckUnsupported: { reason: "<specific reason>" }\`.`,
			CATEGORY_MAX_POINTS.health,
			missing,
		);
	}

	if (vacuous.length > 0) {
		return blocker(
			"health-coverage",
			"health",
			"One or more operations have healthCheck cases with empty assertions.",
			`healthCheck.assertions for ${vacuous.join(", ")} is empty — assert on status and response shape (e.g. throw or return {status:'degraded'} when the upstream contract breaks), or declare healthCheckUnsupported with a specific reason if the operation genuinely cannot be probed.`,
			CATEGORY_MAX_POINTS.health,
			vacuous.map((operationId) => `${operationId}: empty healthCheck.assertions`),
		);
	}

	if (placeholder.length > 0) {
		return {
			id: "health-coverage",
			category: "health",
			level: "warn",
			status: "warn",
			points: 8,
			maxPoints: CATEGORY_MAX_POINTS.health,
			message: "Some healthCheckUnsupported reasons look placeholder-like.",
			remediation: `For ${placeholder.join(", ")}, replace the placeholder \`healthCheckUnsupported.reason\` with a specific reason such as destructive mutation, paid call, credential sensitivity, or upstream flakiness.`,
			evidence: placeholder,
		};
	}

	if (generatedStarter.length > 0) {
		return {
			id: "health-coverage",
			category: "health",
			level: "warn",
			status: "warn",
			points: 10,
			maxPoints: CATEGORY_MAX_POINTS.health,
			message:
				"Generated starter operation health rationale is present; replace starter logic before bounty submission.",
			remediation: `Replace generated starter operation(s) ${generatedStarter.join(", ")} with real upstream-backed operations and add \`healthCheck\` for safe read-only probes.`,
			evidence: generatedStarter,
		};
	}

	if (unsupported.length > 0) {
		return {
			id: "health-coverage",
			category: "health",
			level: "warn",
			status: "warn",
			points: 12,
			maxPoints: CATEGORY_MAX_POINTS.health,
			message: "Health coverage is declared, with one or more unsupported probes.",
			remediation: `For ${unsupported.join(", ")}, replace \`healthCheckUnsupported\` with \`healthCheck: { interval, cases }\` when the upstream operation is safe and read-only; keep unsupported only for destructive, paid, credential-sensitive, or flaky probes with a specific reason.`,
			evidence: unsupported.map((operationId) => `${operationId}: healthCheckUnsupported`),
		};
	}

	return pass(
		"health-coverage",
		"health",
		"All operations declare real health checks.",
		CATEGORY_MAX_POINTS.health,
	);
}

function hasOnlyVacuousHealthCases(
	healthCheck: ProviderDefinition["operations"][string]["healthCheck"],
): boolean {
	const cases = healthCheck?.cases;
	if (!Array.isArray(cases) || cases.length === 0) {
		return true;
	}
	return cases.every((healthCase) => isVacuousAssertionFunction(healthCase?.assertions));
}

function isVacuousAssertionFunction(assertions: unknown): boolean {
	if (typeof assertions !== "function") {
		return true;
	}

	let source: string;
	try {
		source = Function.prototype.toString.call(assertions);
	} catch {
		return false;
	}

	// Native / bound functions stringify to `function () { [native code] }` with
	// no inspectable body or params. The underlying implementation may inspect
	// ctx, so fail open (do not flag) rather than mistake it for an empty body.
	if (/\[native code\]/.test(source)) {
		return false;
	}

	const fn = parseAssertionFunction(source);
	if (!fn) {
		// Unparseable source → fail open (treat as a real assertion). A false
		// negative here only misses a no-op; a false positive would wrongly
		// reject a valid contributor.
		return false;
	}

	// A real health assertion MUST either throw when the upstream contract
	// breaks, or inspect the probe response, which is delivered exclusively
	// through the assertion's own parameter(s). Working on the parsed AST (not
	// text) makes this precise at the syntactic layer: a `throw` only counts
	// when it is a real ThrowStatement in THIS function's body (not inside a
	// nested, uninvoked function), and a parameter reference is checked against
	// the actual bound names (destructuring binds the local alias, not the
	// property key). This closes the whole equivalent-no-op class — empty
	// bodies, `void 0`, `({})`, `Promise.resolve()`, `await Promise.resolve()`,
	// `.then()`, `new Promise(r => r())`, side-effect-only bodies, throws hidden
	// in uninvoked closures — without enumerating spellings.
	if (functionThrows(fn)) {
		return false;
	}
	const bound = new Set<string>();
	for (const param of fn.params) {
		collectBoundNames(param, bound);
	}
	if (bound.size === 0) {
		return true;
	}
	// A parameter reference anywhere in the (reachable) body is treated as
	// inspecting the response. This is deliberately syntactic, not a dataflow
	// analysis.
	//
	// KNOWN LIMITATION (accepted): a body that reads the parameter but never
	// turns that read into an outcome — no throw, no returned verdict — still
	// passes, e.g. `({ status }) => { console.info(status); }`. Precisely
	// rejecting it would require tracking whether the read flows to a throw
	// argument or return value through arbitrary local bindings and invoked
	// helpers (`const ok = ctx.output.ok; return ok ? ...` / a called helper that
	// throws). That is transitive use-def dataflow, and an imprecise version
	// FALSE-BLOCKS real assertions of exactly those shapes — verified
	// empirically. Under the fail-open contract (rejecting a real contributor is
	// strictly worse than missing a no-op) we accept the miss here. This gate
	// stops accidental/lazy no-ops (empty bodies, `void 0`, `Promise.resolve()`,
	// throws in uninvoked closures); a determined bypass via a decorative ctx
	// read is no easier than writing the real one-line `throw`, and the actual
	// defense against a runtime-empty assertion is the live `--smoke` probe.
	return !referencesBoundNames(fn, bound);
}

type AssertionFunctionNode =
	| acorn.ArrowFunctionExpression
	| acorn.FunctionExpression
	| acorn.FunctionDeclaration;

function isFunctionNode(node: acorn.AnyNode): node is AssertionFunctionNode {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionExpression" ||
		node.type === "FunctionDeclaration"
	);
}

/**
 * Parse the `Function.prototype.toString()` output of an assertion into its AST
 * function node. The stringified form can be an arrow (`(a) => {}`), a function
 * expression (`function (a) {}`), or a bare method (`foo() {}`), so try a few
 * wrappers until one parses. Returns undefined on any parse failure so callers
 * fail open.
 */
function parseAssertionFunction(source: string): AssertionFunctionNode | undefined {
	const candidates = [source, `(${source})`, `({${source}})`];
	for (const candidate of candidates) {
		let program: acorn.Program;
		try {
			program = acorn.parse(candidate, { ecmaVersion: "latest" });
		} catch {
			continue;
		}
		const fn = findFirstFunction(program);
		if (fn) {
			return fn;
		}
	}
	return undefined;
}

/** Depth-first search for the first function node in a parsed program. */
function findFirstFunction(root: acorn.AnyNode): AssertionFunctionNode | undefined {
	let found: AssertionFunctionNode | undefined;
	walkAst(root, (node) => {
		if (found) {
			return false;
		}
		if (isFunctionNode(node)) {
			found = node;
			return false;
		}
		return true;
	});
	return found;
}

/**
 * Collect the identifier names actually BOUND by a parameter pattern. For
 * destructuring, the binding is the local target (`value`), not the source
 * property key — so `({ status: ignored })` binds `ignored`, and a body that
 * merely mentions `status` is not referencing a parameter.
 */
function collectBoundNames(pattern: acorn.Pattern | null, out: Set<string>): void {
	if (!pattern) {
		return;
	}
	switch (pattern.type) {
		case "Identifier":
			out.add(pattern.name);
			break;
		case "AssignmentPattern":
			collectBoundNames(pattern.left, out);
			break;
		case "RestElement":
			collectBoundNames(pattern.argument, out);
			break;
		case "ArrayPattern":
			for (const element of pattern.elements) {
				collectBoundNames(element, out);
			}
			break;
		case "ObjectPattern":
			for (const property of pattern.properties) {
				if (property.type === "RestElement") {
					collectBoundNames(property.argument, out);
				} else {
					// `.value` is the local binding target, `.key` is the source
					// property name — bind only the former.
					collectBoundNames(property.value, out);
				}
			}
			break;
	}
}

/**
 * True if the function contains a real `throw` statement in ITS OWN body —
 * descending through control flow but NOT into nested functions, whose throws
 * do not execute unless that nested function is invoked.
 */
function functionThrows(fn: AssertionFunctionNode): boolean {
	if (fn.body.type !== "BlockStatement") {
		// Concise arrow returning an expression cannot contain a throw statement.
		return false;
	}
	let throws = false;
	walkAst(fn.body, (node) => {
		if (throws) {
			return false;
		}
		if (node.type === "ThrowStatement") {
			throws = true;
			return false;
		}
		// Do not descend into nested function bodies.
		if (isFunctionNode(node)) {
			return false;
		}
		return true;
	});
	return throws;
}

/**
 * True if the function's body references any of the given bound parameter names
 * as an actual value. Property KEYS (`{ status: ... }`, `obj.status`) are not
 * references; computed members (`obj[status]`) are. Nested functions that
 * re-bind the same name shadow it, so their bodies are searched with the
 * shadowed name removed from the target set.
 */
function referencesBoundNames(fn: AssertionFunctionNode, bound: Set<string>): boolean {
	if (bound.size === 0) {
		return false;
	}
	let referenced = false;
	walkAstValues(fn.body, bound, fn.body, null, null, () => {
		referenced = true;
	});
	return referenced;
}

/**
 * Walk `node`, invoking `onReference` when an Identifier in value position
 * matches a name in `names`. Skips property keys and non-computed member
 * properties. On entering a nested function, removes any parameter names it
 * rebinds (shadowing) from the active set for that subtree, and does NOT descend
 * into a PROVABLY-UNINVOKED helper — a function bound to a local name that is
 * never referenced again anywhere in the assertion body, so it cannot run when
 * the assertion runs (e.g. `(ctx) => { const later = () => ctx.status; }`). Its
 * parameter reads therefore must not count as inspecting the response, mirroring
 * how `functionThrows` ignores throws inside nested functions.
 *
 * Crucially, a helper that IS referenced again (a call site like `check()`) is
 * NOT skipped — its body is searched — so real assertions that factor the check
 * into a local helper still pass. Immediately-invoked callbacks (`.every(cb)`,
 * IIFEs, callees) are likewise searched. When in doubt we descend (fail open):
 * the only skip is a helper we can prove is never invoked.
 */
function walkAstValues(
	node: acorn.AnyNode,
	names: Set<string>,
	outerBody: acorn.AnyNode,
	parent: acorn.AnyNode | null,
	parentKey: string | null,
	onReference: () => void,
): void {
	if (names.size === 0) {
		return;
	}
	if (node.type === "Identifier") {
		if (names.has(node.name)) {
			onReference();
		}
		return;
	}
	// Nested function: subtract its own parameter bindings (shadowing) before
	// descending into its body — and skip it only when it is a provably
	// uninvoked helper.
	if (isFunctionNode(node)) {
		const shadowed = new Set<string>();
		for (const param of node.params) {
			collectBoundNames(param, shadowed);
		}
		const visible = new Set<string>();
		for (const name of names) {
			if (!shadowed.has(name)) {
				visible.add(name);
			}
		}
		if (visible.size === 0 || isProvablyUninvokedHelper(node, parent, parentKey, outerBody)) {
			return;
		}
		for (const [key, child] of childEntries(node)) {
			if (key === "params") {
				continue;
			}
			walkAstValues(child, visible, outerBody, node, key, onReference);
		}
		return;
	}
	for (const [key, child] of childEntries(node)) {
		// Skip non-computed property keys (`{ status: x }`) and member
		// properties (`obj.status`) — these are names, not references.
		if (key === "key" && node.type === "Property" && !node.computed) {
			continue;
		}
		if (key === "property" && node.type === "MemberExpression" && !node.computed) {
			continue;
		}
		walkAstValues(child, names, outerBody, node, key, onReference);
	}
}

/**
 * True if `fn` is a local helper bound to a name that is NEVER referenced again
 * anywhere in `outerBody` — meaning it is never invoked, so its body does not run
 * as part of evaluating the assertion. Only these provably-dead helpers are
 * skipped; a helper with any call site (its name appearing more than once, i.e.
 * beyond its own declaration) is treated as potentially executed and searched.
 * Anonymous functions in expression position (call args, callees, returns) are
 * never "uninvoked helpers" — they may run — so they are not skipped here.
 */
function isProvablyUninvokedHelper(
	fn: AssertionFunctionNode,
	parent: acorn.AnyNode | null,
	parentKey: string | null,
	outerBody: acorn.AnyNode,
): boolean {
	let helperName: string | undefined;
	if (fn.type === "FunctionDeclaration" && fn.id) {
		helperName = fn.id.name;
	} else if (
		parent &&
		parent.type === "VariableDeclarator" &&
		parentKey === "init" &&
		parent.id.type === "Identifier"
	) {
		helperName = parent.id.name;
	}
	if (helperName === undefined) {
		// Not a name-bound helper (anonymous callback / expression). It may run,
		// so do not skip it.
		return false;
	}
	// Count every occurrence of the helper name in the assertion body. Exactly
	// one occurrence is its own binding declaration; more than one means there is
	// at least one reference (call site), so the helper can run.
	let occurrences = 0;
	walkAst(outerBody, (node) => {
		if (node.type === "Identifier" && node.name === helperName) {
			occurrences += 1;
		}
		return true;
	});
	return occurrences <= 1;
}

/** Generic pre-order AST walk; `visit` returns false to stop descending. */
function walkAst(node: acorn.AnyNode, visit: (node: acorn.AnyNode) => boolean): void {
	if (!visit(node)) {
		return;
	}
	for (const child of childNodes(node)) {
		walkAst(child, visit);
	}
}

function* childNodes(node: acorn.AnyNode): Generator<acorn.AnyNode> {
	for (const [, child] of childEntries(node)) {
		yield child;
	}
}

function* childEntries(node: acorn.AnyNode): Generator<[string, acorn.AnyNode]> {
	for (const key of Object.keys(node)) {
		if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") {
			continue;
		}
		const value = (node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (isAstNode(item)) {
					yield [key, item];
				}
			}
		} else if (isAstNode(value)) {
			yield [key, value];
		}
	}
}

function isAstNode(value: unknown): value is acorn.AnyNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

function scoreSmoke(
	smokeResult: SmokeResult | undefined,
	smokeNote: string | undefined,
): SubmitCheck {
	const deprecatedEvidence = smokeNote?.trim()
		? ["Deprecated --smoke-note was provided and ignored for scoring."]
		: [];
	if (!smokeResult) {
		return {
			id: "local-smoke",
			category: "smoke",
			level: "warn",
			status: "warn",
			points: 0,
			maxPoints: CATEGORY_MAX_POINTS.smoke,
			message: "Measured local smoke was not run.",
			remediation:
				"Rerun submit-check with `--smoke` so it boots the provider, verifies `/health`, and POSTs every operation fixture. Set APIFUSE__PROVIDER__* env vars when live upstream credentials are available.",
			evidence: deprecatedEvidence,
		};
	}

	const evidence = [
		`/health: ${smokeResult.healthOk ? "ok" : "failed"}`,
		...smokeResult.operations.map(
			(outcome) =>
				`${outcome.operationId}: ${outcome.status}${outcome.httpStatus ? ` HTTP ${outcome.httpStatus}` : ""} - ${outcome.message}`,
		),
		...deprecatedEvidence,
	];
	const incoherent = smokeResult.operations.filter((outcome) => outcome.status === "incoherent");
	if (!smokeResult.healthOk || smokeResult.bootError || incoherent.length > 0) {
		return {
			id: "local-smoke",
			category: "smoke",
			level: "blocker",
			status: "fail",
			points: 0,
			maxPoints: CATEGORY_MAX_POINTS.smoke,
			message: "Measured smoke failed to verify a coherent provider runtime.",
			remediation:
				"Fix the dev server boot, `/health`, or incoherent operation responses, then rerun `bun run submit-check -- --smoke`.",
			evidence: smokeResult.bootError ? [`boot: ${smokeResult.bootError}`, ...evidence] : evidence,
			details: smokeResult,
		};
	}

	const successes = smokeResult.operations.filter((outcome) => outcome.status === "success");
	if (successes.length > 0) {
		return {
			id: "local-smoke",
			category: "smoke",
			level: "info",
			status: "pass",
			points: CATEGORY_MAX_POINTS.smoke,
			maxPoints: CATEGORY_MAX_POINTS.smoke,
			message: "Measured smoke passed with at least one schema-valid operation success.",
			evidence,
			details: smokeResult,
		};
	}

	return {
		id: "local-smoke",
		category: "smoke",
		level: "warn",
		status: "warn",
		points: 7,
		maxPoints: CATEGORY_MAX_POINTS.smoke,
		message: "Runtime path was verified, but no live upstream schema-valid success was observed.",
		remediation:
			"Provide APIFUSE__PROVIDER__* env vars or fixture-safe upstream access, then rerun `bun run submit-check -- --smoke` to capture at least one schema-valid success.",
		evidence,
		details: smokeResult,
	};
}

export async function runSubmitCheckSmoke(
	providerRoot: string,
	provider?: ProviderDefinition,
): Promise<SmokeResult> {
	const loadedProvider = provider ?? (await loadProvider(providerRoot));
	if (!loadedProvider) {
		return {
			measured: true,
			healthOk: false,
			bootError: "Provider could not be loaded.",
			operations: [],
		};
	}

	const port = await getAvailablePort();
	const server = spawn("bun", ["run", "dev"], {
		cwd: providerRoot,
		env: { ...process.env, APIFUSE__RUNTIME__PORT: String(port) },
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	server.stdout?.on("data", (chunk) => {
		output += chunk.toString();
	});
	server.stderr?.on("data", (chunk) => {
		output += chunk.toString();
	});

	try {
		const baseUrl = `http://127.0.0.1:${port}`;
		const health = await waitForSmokeHealth(`${baseUrl}/health`, server, () => output);
		if (!health.ok) {
			return {
				measured: true,
				healthOk: false,
				bootError: health.error,
				operations: [],
			};
		}
		const operations: SmokeOperationOutcome[] = [];
		for (const [operationId, operation] of Object.entries(loadedProvider.operations)) {
			operations.push(
				await smokeOperation(baseUrl, operationId, operation.output, {
					requestId: `req_submit_check_smoke_${operationId}`,
					input: operation.fixtures?.request ?? {},
					headers: {},
				}),
			);
		}
		return { measured: true, healthOk: true, operations };
	} finally {
		await stopSmokeServer(server);
	}
}

async function smokeOperation(
	baseUrl: string,
	operationId: string,
	outputSchema: ProviderDefinition["operations"][string]["output"],
	body: unknown,
): Promise<SmokeOperationOutcome> {
	try {
		const response = await fetch(`${baseUrl}/v1/${operationId}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(20_000),
		});
		const payload = await response.json().catch(() => undefined);
		if (response.ok && isRecord(payload) && "data" in payload) {
			const parsed = safeParseSchemaSync(
				outputSchema,
				payload.data,
				`operations.${operationId}.output`,
			);
			if (parsed.success) {
				return {
					operationId,
					status: "success",
					httpStatus: response.status,
					message: "schema-valid success",
				};
			}
			return {
				operationId,
				status: "incoherent",
				httpStatus: response.status,
				message: "success payload failed output schema validation",
			};
		}
		if (isStructuredProviderError(payload) && response.status < 500) {
			return {
				operationId,
				status: "structured_error",
				httpStatus: response.status,
				message: `${payload.error.code}: ${payload.error.message}`,
			};
		}
		return {
			operationId,
			status: "incoherent",
			httpStatus: response.status,
			message: isStructuredProviderError(payload)
				? `${payload.error.code}: ${payload.error.message}`
				: "response was not a schema-valid success or structured provider error",
		};
	} catch (error) {
		return {
			operationId,
			status: "incoherent",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

function isStructuredProviderError(
	value: unknown,
): value is { error: { code: string; message: string } } {
	return (
		isRecord(value) &&
		isRecord(value.error) &&
		typeof value.error.code === "string" &&
		typeof value.error.message === "string"
	);
}

async function getAvailablePort(): Promise<number> {
	return await new Promise((resolvePromise, rejectPromise) => {
		const server = createServer();
		server.once("error", rejectPromise);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close((error) => {
				if (error) {
					rejectPromise(error);
					return;
				}
				if (!address || typeof address === "string") {
					rejectPromise(new Error("Could not allocate a local TCP port."));
					return;
				}
				resolvePromise(address.port);
			});
		});
	});
}

async function waitForSmokeHealth(
	url: string,
	server: ChildProcess,
	getOutput: () => string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const deadline = Date.now() + 20_000;
	let lastError: unknown;

	while (Date.now() < deadline) {
		if (server.exitCode !== null) {
			return {
				ok: false,
				error: `Dev server exited early with code ${server.exitCode}. ${getOutput()}`,
			};
		}

		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) return { ok: true };
			lastError = new Error(`${url} returned ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
	}

	return {
		ok: false,
		error: `Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}. ${getOutput()}`,
	};
}

async function stopSmokeServer(server: ChildProcess): Promise<void> {
	if (server.exitCode !== null) return;
	killSmokeProcessTree(server, "SIGTERM");
	await new Promise<void>((resolvePromise) => {
		const timeout = setTimeout(() => {
			if (server.exitCode === null) {
				killSmokeProcessTree(server, "SIGKILL");
			}
			resolvePromise();
		}, 2_000);
		server.once("exit", () => {
			clearTimeout(timeout);
			resolvePromise();
		});
	});
}

function killSmokeProcessTree(server: ChildProcess, signal: NodeJS.Signals): void {
	if (server.pid === undefined) return;
	try {
		if (process.platform === "win32") {
			server.kill(signal);
			return;
		}
		process.kill(-server.pid, signal);
	} catch {
		server.kill(signal);
	}
}

function scoreAuthSafety(provider: ProviderDefinition): SubmitCheck {
	const authMode = provider.auth?.mode ?? "none";
	const credentialKeys = provider.credential?.keys ?? [];
	if (authMode === "credentials" && credentialKeys.length === 0) {
		return blocker(
			"auth-safety",
			"auth",
			"Credential-backed auth mode is missing credential.keys.",
			"Declare credential.keys and document local-only connection.secrets debugging.",
			CATEGORY_MAX_POINTS.auth,
		);
	}

	if (authMode === "oauth2" && credentialKeys.length === 0) {
		return {
			id: "auth-safety",
			category: "auth",
			level: "warn",
			status: "warn",
			points: 7,
			maxPoints: CATEGORY_MAX_POINTS.auth,
			message: "OAuth auth mode does not declare persisted credential.keys.",
			remediation:
				"Add `credential: { keys: [...] }` to `defineProvider` with the persisted OAuth token fields returned by the real token exchange.",
		};
	}

	if (authMode === "none") {
		const securedOperations = Object.entries(provider.operations).filter(
			([, operation]) => operation.annotations?.openWorld === false,
		);
		if (securedOperations.length > 0) {
			return {
				id: "auth-safety",
				category: "auth",
				level: "warn",
				status: "warn",
				points: 7,
				maxPoints: CATEGORY_MAX_POINTS.auth,
				message: "Provider is no-auth but at least one operation is not marked openWorld.",
				remediation: `Either set \`auth.mode\` to the upstream auth model, or mark these public no-auth operations with \`annotations.openWorld: true\`: ${securedOperations.map(([operationId]) => operationId).join(", ")}.`,
				evidence: securedOperations.map(([operationId]) => operationId),
			};
		}
	}

	return pass(
		"auth-safety",
		"auth",
		"Auth and credential declarations are internally consistent.",
		CATEGORY_MAX_POINTS.auth,
	);
}

function scoreProviderDocs(providerRoot: string): SubmitCheck[] {
	const readmePath = resolve(providerRoot, "README.md");
	if (!existsSync(readmePath)) {
		return [
			{
				id: "submission-docs",
				category: "docs",
				level: "warn",
				status: "warn",
				points: 4,
				maxPoints: CATEGORY_MAX_POINTS.docs,
				message: "Provider README.md is missing.",
				remediation:
					"Add README sections for parameters, response shape, examples, auth/env setup, health coverage, and known upstream constraints.",
			},
		];
	}

	const readme = readFileSync(readmePath, "utf8").toLowerCase();
	const missing = [
		["parameters", "Parameters"],
		["response", "Response"],
		["example", "Example"],
	].filter(([needle]) => !readme.includes(needle));
	const mentionsSubmitCheck = readme.includes("submit-check");

	const points = Math.max(
		0,
		CATEGORY_MAX_POINTS.docs - missing.length * 2 - (mentionsSubmitCheck ? 0 : 1),
	);

	return [
		{
			id: "submission-docs",
			category: "docs",
			level: missing.length > 0 || !mentionsSubmitCheck ? "warn" : "info",
			status: missing.length > 0 || !mentionsSubmitCheck ? "warn" : "pass",
			points,
			maxPoints: CATEGORY_MAX_POINTS.docs,
			message:
				missing.length > 0 || !mentionsSubmitCheck
					? "Provider README is present but missing some submission evidence guidance."
					: "Provider README includes expected submission guidance.",
			remediation:
				missing.length > 0 || !mentionsSubmitCheck
					? "Update `README.md` to include `Parameters`, `Response`, `Example`, and submit-check evidence guidance sections."
					: undefined,
			evidence: [
				...missing.map(([, label]) => `missing ${label}`),
				...(mentionsSubmitCheck ? [] : ["missing submit-check mention"]),
			],
		},
	];
}

// Splits secret findings into still-active findings and acknowledged
// `// @apifuse-allow secret-scan` overrides, mirroring partitionAllowOverrides
// (same pragma placement: the finding line or the line directly above it).
// Every finding source carries a line number (entropy candidates and located
// SECRET_PATTERNS matches); a finding that somehow lacks one stays active
// defensively.
function partitionSecretScanAllowOverrides(
	providerRoot: string,
	findings: readonly SecretFinding[],
): { active: SecretFinding[]; overridden: SecretFinding[] } {
	const fileLineCache = new Map<string, string[]>();
	const active: SecretFinding[] = [];
	const overridden: SecretFinding[] = [];

	for (const finding of findings) {
		if (finding.line === undefined) {
			active.push(finding);
			continue;
		}
		const absolute = resolve(providerRoot, finding.file);
		let lines = fileLineCache.get(absolute);
		if (lines === undefined) {
			lines = existsSync(absolute) ? readFileSync(absolute, "utf8").split(/\r?\n/) : [];
			fileLineCache.set(absolute, lines);
		}
		if (hasAllowOverride(lines, finding.line, "secret-scan")) {
			overridden.push(finding);
		} else {
			active.push(finding);
		}
	}

	return { active, overridden };
}

function scoreSecrets(providerRoot: string, provider?: ProviderDefinition): SubmitCheck {
	const { active, overridden } = partitionSecretScanAllowOverrides(
		providerRoot,
		findSecretFindings(providerRoot, provider?.id),
	);
	const blockerFindings = active.filter((finding) => finding.level !== "warn");
	if (blockerFindings.length > 0) {
		return {
			id: "secret-scan",
			category: "security",
			level: "blocker",
			status: "fail",
			points: 0,
			maxPoints: CATEGORY_MAX_POINTS.security,
			message: "Potential real credential material was found in shareable files.",
			remediation:
				blockerFindings[0]?.remediation ??
				'Move hardcoded credentials to env vars read via `ctx.env.get("APIFUSE__PROVIDER__<ID>__<NAME>")` and rotate the leaked credential.',
			evidence: blockerFindings.map(
				(finding) =>
					finding.evidence ??
					`${finding.file}${finding.line ? `:${finding.line}` : ""}: ${finding.label}`,
			),
		};
	}
	if (active.length > 0 || overridden.length > 0) {
		const messageBase =
			active.length > 0
				? "High-entropy source strings were found without secret-like identifier context; they may be false positives."
				: "Potential credential-like strings were found in shareable files.";
		const message =
			overridden.length > 0
				? `${messageBase} ${overridden.length} acknowledged @apifuse-allow override(s).`
				: messageBase;
		return {
			id: "secret-scan",
			category: "security",
			level: "warn",
			status: "warn",
			points: 8,
			maxPoints: CATEGORY_MAX_POINTS.security,
			message,
			remediation:
				'Review the listed strings. If any are credentials, move them to env vars read via `ctx.env.get("APIFUSE__PROVIDER__<ID>__<NAME>")` and rotate the leaked credential; otherwise keep generated blobs in fixtures/tests or document why they are public with `// @apifuse-allow secret-scan: <reason>`.',
			evidence: [...active, ...overridden].map(
				(finding) =>
					finding.evidence ??
					`${finding.file}${finding.line ? `:${finding.line}` : ""}: ${finding.label}`,
			),
		};
	}

	return pass(
		"secret-scan",
		"security",
		"No high-confidence secrets were found in README, source, package, or fixtures.",
		CATEGORY_MAX_POINTS.security,
	);
}

function findSecretFindings(providerRoot: string, providerId = "<ID>"): SecretFinding[] {
	const candidateFiles = [
		"README.md",
		"index.ts",
		"package.json",
		"__fixtures__/raw.json",
		"__fixtures__/transform.snap.json",
	];
	const findings: SecretFinding[] = [];

	for (const relativePath of candidateFiles) {
		const filePath = resolve(providerRoot, relativePath);
		if (!existsSync(filePath)) continue;
		const content = readFileSync(filePath, "utf8");
		for (const [label, pattern] of SECRET_PATTERNS) {
			// Locate every match to its line so pattern findings carry the line
			// information hasAllowOverride needs: `// @apifuse-allow secret-scan`
			// must behave uniformly across entropy findings and pattern findings.
			const globalPattern = new RegExp(
				pattern.source,
				pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
			);
			const seenLines = new Set<number>();
			for (const match of content.matchAll(globalPattern)) {
				const line = offsetToLine(content, match.index);
				if (seenLines.has(line)) continue;
				seenLines.add(line);
				findings.push({ label, file: relativePath, line });
			}
		}
	}

	findings.push(...findEntropySecretFindings(providerRoot, providerId));
	return findings;
}

function findEntropySecretFindings(providerRoot: string, providerId: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	for (const filePath of listNonTestProviderSourceFiles(providerRoot)) {
		const relativePath = toRelativeProviderPath(providerRoot, filePath);
		if (isEntropySecretExcludedPath(relativePath)) continue;
		const content = readFileSync(filePath, "utf8");
		const lines = content.split(/\r?\n/);
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
			const line = lines[lineIndex] ?? "";
			for (const candidate of extractStringLiteralCandidates(line)) {
				const finding = classifyEntropyCandidate({
					value: candidate,
					line,
					file: relativePath,
					lineNumber: lineIndex + 1,
					providerId,
				});
				if (finding) findings.push(finding);
			}
		}
	}
	return findings;
}

function isEntropySecretExcludedPath(relativePath: string): boolean {
	return (
		relativePath.endsWith(".test.ts") ||
		relativePath.startsWith("__tests__/") ||
		relativePath.includes("/__tests__/") ||
		relativePath.startsWith("__fixtures__/") ||
		relativePath.includes("/__fixtures__/")
	);
}

export function extractStringLiteralCandidates(line: string): string[] {
	const candidates: string[] = [];
	for (let index = 0; index < line.length; index += 1) {
		const quote = line[index];
		if (quote !== '"' && quote !== "'" && quote !== "`") continue;

		const contentStart = index + 1;
		let cursor = contentStart;
		while (cursor < line.length) {
			const char = line[cursor];
			if (char === "\\") {
				cursor += 2;
				continue;
			}
			if (char === quote) {
				if (cursor - contentStart >= ENTROPY_CANDIDATE_MIN_LENGTH) {
					candidates.push(line.slice(contentStart, cursor));
				}
				index = cursor;
				break;
			}
			cursor += 1;
		}
	}
	return candidates;
}

function classifyEntropyCandidate(input: {
	value: string;
	line: string;
	file: string;
	lineNumber: number;
	providerId: string;
}): SecretFinding | undefined {
	const value = input.value;
	if (!shouldConsiderEntropyValue(value)) return undefined;
	const charset = classifyEntropyCharset(value);
	if (!charset) return undefined;
	const entropy = shannonEntropy(value);
	const secretishContext = SECRETISH_IDENTIFIER_PATTERN.test(input.line);
	// Word-like SCREAMING_SNAKE values (e.g. error-code constants such as
	// "AUTH_PASSWORD_LOGIN_CAPTCHA_REQUIRED") may contain secret-ish words
	// (AUTH/PASSWORD/...) in their own text and would otherwise be permanently
	// blocker-flagged. They are never skipped — entropy classification always
	// runs — but when the secret-ish context comes solely from identifier-
	// constant-shaped literal text (the line with those literals stripped
	// carries no secret-ish identifier), the finding is capped at a
	// non-blocking warning instead of a blocker. Stripping constant-shaped
	// siblings — not just the candidate — matters for lines holding several
	// constants (e.g. an ERROR_CODES array), while quoted property keys and
	// header names ("Authorization", "apiKey") stay visible as genuine
	// external context. Assignments to `apiKey`/`token`/`secret`-style names
	// still escalate to blockers via the identifier side, and
	// `// @apifuse-allow secret-scan` remains the reviewed way to silence the
	// warning.
	const selfContextOnlyConstant =
		secretishContext &&
		isScreamingSnakeConstantValue(value) &&
		!SECRETISH_IDENTIFIER_PATTERN.test(stripIdentifierConstantLiterals(input.line, value));
	const threshold = charset === "hex" ? 3.0 : secretishContext ? 4.0 : 4.5;
	if (entropy < threshold) return undefined;

	const preview = `${value.slice(0, 4)}...[REDACTED length=${value.length}]`;
	const envName = `APIFUSE__PROVIDER__${input.providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}__${guessSecretName(input.line)}`;
	const location = `${input.file}:${input.lineNumber}`;
	const label =
		charset === "hex"
			? `high-entropy hex string (${entropy.toFixed(2)} bits/char)`
			: `high-entropy base64-like string (${entropy.toFixed(2)} bits/char)`;
	const contextNote = selfContextOnlyConstant
		? "; identifier-like constant (downgraded to warning)"
		: secretishContext
			? ""
			: "; may be a false positive";
	return {
		label,
		file: input.file,
		line: input.lineNumber,
		level: secretishContext && !selfContextOnlyConstant ? "blocker" : "warn",
		remediation: `Move ${location} to an env var read via \`ctx.env.get("${envName}")\` and rotate the leaked credential.`,
		evidence: `${location}: ${label}; preview ${preview}${contextNote}`,
	};
}

// Word-like SCREAMING_SNAKE identifier shape: at least two underscore-
// separated segments, each essentially pure alphabetic — letters optionally
// followed by a SHORT digit suffix (at most 2, e.g. version markers like
// "V2") — and at most 15% digits across the whole value. Dictionary-style
// constants like "AUTH_PASSWORD_LOGIN_CAPTCHA_REQUIRED" or
// "PROVIDER_CONTRACT_V2_REQUIRED" match; digit-heavy segmented material
// (e.g. license/credential shapes like "ABCD1234_EFGH5678_IJKL9012"),
// uppercase blobs ("XK9J_Q2ZP_M7VN"), and underscore-free hex-like values
// ("A1B2C3D4...") do not. This shape gate never skips entropy classification;
// it only decides whether a finding whose secret-ish context comes solely
// from the literal's own text is downgraded from blocker to warning, so it
// deliberately stays strict: values that merely contain a secret-ish word but
// are not word-like constants keep full blocker severity.
function isScreamingSnakeConstantValue(value: string): boolean {
	if (!/^[A-Z][A-Z0-9_]*$/.test(value) || !value.includes("_")) return false;
	const segments = value.split("_");
	if (segments.length < 2) return false;
	if (!segments.every((segment) => /^[A-Z]+[0-9]{0,2}$/.test(segment))) return false;
	const digitCount = value.match(/[0-9]/g)?.length ?? 0;
	return digitCount / value.length <= 0.15;
}

type LineStringLiteral = {
	// Index of the opening quote.
	start: number;
	// Index just past the closing quote (line end when unterminated).
	end: number;
	content: string;
	closed: boolean;
	role: "key" | "value";
	// Nearest unclosed bracket enclosing the literal's start, if any.
	container?: { bracket: "[" | "(" | "{"; index: number };
};

// Stable identity for the container a literal sits in ("top" when the
// literal is not inside any bracket on the line).
function literalContainerKey(literal: LineStringLiteral): string {
	return literal.container
		? `${literal.container.bracket}${literal.container.index}`
		: "top";
}

// Single-pass line tokenizer: extracts every string literal with its span and
// classifies its syntactic role once. A literal is a KEY when it is preceded
// (ignoring whitespace) by "{", ",", "(", or the line start AND followed
// (ignoring whitespace) by ":" — i.e. it names the value next to it. Every
// other literal is a VALUE: ternary arms (preceded by "?" or ":"), array
// elements, call arguments, and assignment right-hand sides, even when a
// ternary's ":" happens to follow them. Uses the same quote/escape walking as
// extractStringLiteralCandidates.
function tokenizeLineStringLiterals(line: string): LineStringLiteral[] {
	const literals: LineStringLiteral[] = [];
	const bracketStack: Array<{ bracket: "[" | "(" | "{"; index: number }> = [];
	let index = 0;
	while (index < line.length) {
		const char = line[index];
		if (char !== '"' && char !== "'" && char !== "`") {
			if (char === "[" || char === "(" || char === "{") {
				bracketStack.push({ bracket: char, index });
			} else if (char === "]" || char === ")" || char === "}") {
				bracketStack.pop();
			}
			index += 1;
			continue;
		}
		const quote = char;
		const start = index;
		const contentStart = index + 1;
		let cursor = contentStart;
		let closed = false;
		while (cursor < line.length) {
			const inner = line[cursor];
			if (inner === "\\") {
				cursor += 2;
				continue;
			}
			if (inner === quote) {
				closed = true;
				break;
			}
			cursor += 1;
		}
		const contentEnd = Math.min(cursor, line.length);
		const end = closed ? cursor + 1 : line.length;
		const before = line.slice(0, start).trimEnd();
		const keyPreceded = before === "" || /[{,(]$/.test(before);
		const keyFollowed = closed && /^\s*:/.test(line.slice(end));
		literals.push({
			start,
			end,
			content: line.slice(contentStart, contentEnd),
			closed,
			role: keyPreceded && keyFollowed ? "key" : "value",
			container: bracketStack[bracketStack.length - 1],
		});
		index = end;
	}
	return literals;
}

// Builds the context text used to decide whether a candidate's secret-ish
// context is genuine. The candidate's own literal is ALWAYS stripped
// (self-context rule). SIBLING identifier-constant-shaped candidate literals
// (VALUE role, SCREAMING_SNAKE shape, >= ENTROPY_CANDIDATE_MIN_LENGTH) are
// stripped only when they share the candidate's non-call container — the same
// `[...]` array, the same `{...}` object value list, or the bracket-free top
// level (ternary arms) — so a value list of error codes cannot poison its own
// members' context. Call-argument siblings (inside `(...)`) always keep their
// context: in `headers.set("X_LONG_AUTH_TOKEN_NAME", "QWERTY_...")` the first
// argument genuinely describes the second, so stripping it would erase real
// auth/token context. KEY-role literals are never stripped.
function stripIdentifierConstantLiterals(line: string, candidate: string): string {
	const literals = tokenizeLineStringLiterals(line);
	const candidateContainers = new Set<string>();
	for (const literal of literals) {
		if (literal.content === candidate) {
			candidateContainers.add(literalContainerKey(literal));
		}
	}
	let result = "";
	let previousEnd = 0;
	for (const literal of literals) {
		result += line.slice(previousEnd, literal.start);
		const isSelf = literal.content === candidate;
		const isSameNonCallContainerSibling =
			literal.role === "value" &&
			literal.content.length >= ENTROPY_CANDIDATE_MIN_LENGTH &&
			isScreamingSnakeConstantValue(literal.content) &&
			literal.container?.bracket !== "(" &&
			candidateContainers.has(literalContainerKey(literal));
		if (isSelf || isSameNonCallContainerSibling) {
			const quote = line[literal.start] ?? "";
			result += quote + (literal.closed ? quote : "");
		} else {
			result += line.slice(literal.start, literal.end);
		}
		previousEnd = literal.end;
	}
	result += line.slice(previousEnd);
	return result;
}

function shouldConsiderEntropyValue(value: string): boolean {
	const lower = value.toLowerCase();
	if (/^(?:dev-only|local|example|sample|your-|replace|<)/i.test(value)) {
		return false;
	}
	if (/^sha(?:256|512)-/i.test(value)) return false;
	if (/\s/.test(value)) return false;
	if (value.includes("${")) return false;
	if (value.includes("/")) return false;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
	if (/^(?:\.{0,2}\/|~\/|[A-Za-z]:\\)/.test(value)) return false;
	if (value.includes(".") && /^[A-Za-z0-9_.-]+$/.test(value)) return false;
	if (lower.includes("/") && /\.[a-z0-9]{1,8}(?:$|[/?#])/i.test(value)) {
		return false;
	}
	return value.length >= ENTROPY_CANDIDATE_MIN_LENGTH;
}

function classifyEntropyCharset(value: string): "base64" | "hex" | undefined {
	if (/^[a-f0-9]+$/i.test(value) && value.length >= 32) return "hex";
	const base64ishChars = value.match(/[A-Za-z0-9+/=_-]/g)?.length ?? 0;
	if (base64ishChars / value.length >= 0.9) return "base64";
	return undefined;
}

function shannonEntropy(value: string): number {
	const counts = new Map<string, number>();
	for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
	let entropy = 0;
	for (const count of counts.values()) {
		const probability = count / value.length;
		entropy -= probability * Math.log2(probability);
	}
	return entropy;
}

function guessSecretName(line: string): string {
	const match =
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line) ??
		/["']?([A-Za-z_$][\w$-]*)["']?\s*:/.exec(line);
	const raw = match?.[1] ?? "SECRET";
	return raw
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_");
}

const SECRETISH_IDENTIFIER_PATTERN = /key|token|secret|password|credential|auth/i;

// Minimum length for a string literal to be considered an entropy candidate.
// Shared by candidate extraction, entropy screening, and the context strip so
// the three stay coherent.
const ENTROPY_CANDIDATE_MIN_LENGTH = 20;

const SECRET_PATTERNS: Array<[string, RegExp]> = [
	["JWT-like token", /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/],
	["GitHub token", /gh[pousr]_[A-Za-z0-9_]{30,}/],
	["Stripe live key", /(?:sk|rk)_live_[A-Za-z0-9]{20,}/],
	["Bearer token", /Bearer\s+[A-Za-z0-9._~+/=-]{32,}/i],
	[
		"credential field",
		/"(?:apiKey|api_key|accessToken|access_token|refreshToken|refresh_token|password|secret|sessionCookie|cookie)"\s*:\s*"(?!dev-only|local|example|sample|your-|replace|<)[^"]{16,}"/i,
	],
];

async function safeLoadProvider(providerRoot: string): Promise<ProviderDefinition | undefined> {
	try {
		return await loadProvider(providerRoot);
	} catch {
		return undefined;
	}
}

async function loadProvider(providerRoot: string): Promise<ProviderDefinition | undefined> {
	const entryPath = resolve(providerRoot, "index.ts");
	if (!existsSync(entryPath)) {
		return undefined;
	}
	const module = (await import(pathToFileURL(entryPath).href)) as {
		default?: ProviderDefinition;
	};
	return module.default;
}

function resolveProviderRoot(inputPath: string): string {
	let current = resolve(process.cwd(), inputPath);
	if (!existsSync(current)) {
		throw new Error(`Provider path not found: ${inputPath}`);
	}
	if (!existsSync(resolve(current, "index.ts"))) {
		current = dirname(current);
	}
	while (!existsSync(resolve(current, "index.ts"))) {
		const parent = dirname(current);
		if (parent === current) {
			throw new Error(`Could not find provider root for: ${inputPath}`);
		}
		current = parent;
	}
	return current;
}

function pass(
	id: string,
	category: string,
	message: string,
	points: number,
	evidence?: string[],
): SubmitCheck {
	return {
		id,
		category,
		level: "info",
		status: "pass",
		points,
		maxPoints: points,
		message,
		...(evidence ? { evidence } : {}),
	};
}

function blocker(
	id: string,
	category: string,
	message: string,
	remediation: string,
	maxPoints: number,
	evidence?: string[],
): SubmitCheck {
	return {
		id,
		category,
		level: "blocker",
		status: "fail",
		points: 0,
		maxPoints,
		message,
		remediation,
		...(evidence ? { evidence: evidence.map(redact) } : {}),
	};
}

export function renderText(report: SubmitCheckReport): string {
	const lines = [
		`APIFuse Provider Submission Score: ${report.score.total} / ${report.score.max}`,
		`Verdict: ${report.score.verdict.toUpperCase()}`,
		`Provider: ${report.provider.id}@${report.provider.version} (${report.provider.runtime}, auth: ${report.provider.authMode})`,
		`Blockers: ${report.summary.blockers}  Warnings: ${report.summary.warnings}  Passed: ${report.summary.passed}`,
		"",
		"Checklist:",
	];

	for (const check of report.checks) {
		const marker = check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✗";
		lines.push(
			`${marker} [${check.category}] ${check.message} (${check.points}/${check.maxPoints})`,
		);
		if (check.remediation) {
			lines.push(`  Fix: ${check.remediation}`);
		}
		for (const evidence of check.evidence ?? []) {
			lines.push(`  - ${redact(evidence)}`);
		}
	}

	return lines.join("\n");
}

export function renderMarkdown(report: SubmitCheckReport): string {
	const lines = [
		"# APIFuse Provider Submission Report",
		"",
		`- **Provider**: ${report.provider.id}@${report.provider.version}`,
		`- **SDK**: ${report.provider.sdkVersion}`,
		`- **Runtime/Auth**: ${report.provider.runtime} / ${report.provider.authMode}`,
		...(report.provider.tier ? [`- **Bounty tier**: ${report.provider.tier}`] : []),
		`- **Score**: ${report.score.total}/${report.score.max}`,
		`- **Verdict**: ${report.score.verdict}`,
		`- **Blockers**: ${report.summary.blockers}`,
		`- **Warnings**: ${report.summary.warnings}`,
		"",
		"## Checklist",
		"",
		"| Status | Category | Check | Points | Remediation |",
		"|---|---|---|---:|---|",
	];

	for (const check of report.checks) {
		const status = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
		lines.push(
			`| ${status} | ${escapeMarkdown(check.category)} | ${escapeMarkdown(check.message)} | ${check.points}/${check.maxPoints} | ${escapeMarkdown(check.remediation ?? "")} |`,
		);
	}

	const evidence = report.checks.flatMap((check) =>
		(check.evidence ?? []).map((item) => `- **${check.id}**: ${redact(item)}`),
	);
	if (evidence.length > 0) {
		lines.push("", "## Evidence", "", ...evidence);
	}

	lines.push("");
	return `${lines.join("\n")}\n`;
}

function escapeMarkdown(value: string): string {
	return redact(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function redact(value: string): string {
	let output = value;
	for (const [, pattern] of SECRET_PATTERNS) {
		output = output.replace(toGlobalRegex(pattern), "[REDACTED]");
	}
	return output;
}

function toGlobalRegex(pattern: RegExp): RegExp {
	return pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

if (import.meta.main) {
	await main();
}
