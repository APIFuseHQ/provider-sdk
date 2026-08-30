#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
	formatPromptAssetIssues,
	PROMPT_ASSET_SYNC_REMEDIATION,
	verifyPromptAssets,
} from "../src/cli/prompt-assets.js";
import {
	DECLARATION_INVALID_CODE,
	validateFailClosedDeclaration,
} from "../src/declaration-validation.js";
import { isProviderError } from "../src/errors.js";
import type { ProviderDefinition } from "../src/index.js";
import { lintProvider, type ProviderLintMode } from "../src/lint.js";
import { safeParseSchemaSync } from "../src/schema.js";

const HELP_TEXT = `Usage: apifuse check [path]
Example: apifuse check providers/korea-air-quality
Default: apifuse check .`;

export type CheckResult = {
	message: string;
	passed: boolean;
	details?: string[];
};

export type RunChecksOptions = {
	lintMode?: ProviderLintMode;
};

type SafeParseResult = { success: true; data: unknown } | { success: false; error: unknown };

export async function main() {
	const args = normalizeArgs(process.argv.slice(2));

	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP_TEXT);
		return;
	}

	const inputPath = args[0] ?? ".";
	const providerRoot = resolveProviderRoot(inputPath);
	const results = await runChecks(providerRoot);
	const failed = results.filter((result) => !result.passed);

	console.log(`Checking provider: ${providerRoot}\n`);

	for (const result of results) {
		const prefix = result.passed ? "✓" : "✗";
		console.log(`${prefix} ${result.message}`);

		for (const detail of result.details ?? []) {
			console.log(`  - ${detail}`);
		}
	}

	if (failed.length > 0) {
		process.exit(1);
	}

	console.log("\nAll checks passed.");
}

function normalizeArgs(argv: string[]): string[] {
	return argv[0] === "check" ? argv.slice(1) : argv;
}

export function resolveProviderRoot(inputPath: string): string {
	const resolvedInput = resolveFromParents(inputPath);

	if (!existsSync(resolvedInput)) {
		throw new Error(`Provider path not found: ${inputPath}`);
	}

	const startDirectory = statSync(resolvedInput).isDirectory()
		? resolvedInput
		: dirname(resolvedInput);

	for (let currentDirectory = startDirectory; ; ) {
		if (existsSync(resolve(currentDirectory, "index.ts"))) {
			return currentDirectory;
		}

		const parentDirectory = dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			break;
		}

		currentDirectory = parentDirectory;
	}

	throw new Error(`Could not find provider root for: ${inputPath}`);
}

function resolveFromParents(inputPath: string): string {
	let currentDirectory = process.cwd();

	while (true) {
		const candidate = resolve(currentDirectory, inputPath);
		if (existsSync(candidate)) {
			return candidate;
		}

		const parentDirectory = dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return resolve(process.cwd(), inputPath);
		}

		currentDirectory = parentDirectory;
	}
}

export async function runChecks(
	providerRoot: string,
	options: RunChecksOptions = {},
): Promise<CheckResult[]> {
	const indexPath = resolve(providerRoot, "index.ts");
	const dockerfilePath = resolve(providerRoot, "Dockerfile");
	const packageJsonPath = resolve(providerRoot, "package.json");
	const providerJsonPath = resolve(providerRoot, "provider.json");

	let providerModule: Record<string, unknown> | undefined;
	let providerImportError: unknown;
	if (existsSync(indexPath)) {
		try {
			providerModule = (await import(pathToFileURL(indexPath).href)) as Record<string, unknown>;
		} catch (error) {
			if (isProviderError(error) && error.code === DECLARATION_INVALID_CODE) {
				providerImportError = error;
			} else {
				throw error;
			}
		}
	}
	const provider = assertProviderDefinition(providerModule?.default);
	const providerSourceFiles = collectProviderSourceFiles(providerRoot);

	return [
		checkIndex(indexPath, provider),
		checkDeclaration(provider, providerImportError),
		checkOperations(provider),
		checkFixtures(provider),
		checkSchemas(provider),
		checkAuthoringLint(provider, providerSourceFiles, options.lintMode),
		checkProviderMetadata(provider),
		checkDockerfile(dockerfilePath),
		checkPackageJson(packageJsonPath),
		checkProviderJson(providerJsonPath, packageJsonPath),
		checkPromptAssets(providerRoot),
	];
}

const DECLARATION_CHECK_MESSAGE = "Provider declaration passes fail-closed validation";

function checkDeclaration(
	provider: ProviderDefinition | undefined,
	importError: unknown,
): CheckResult {
	if (importError !== undefined) {
		return {
			message: DECLARATION_CHECK_MESSAGE,
			passed: false,
			details: formatDeclarationError(importError),
		};
	}
	if (!provider) return { message: DECLARATION_CHECK_MESSAGE, passed: false };
	try {
		validateFailClosedDeclaration(provider);
		return { message: DECLARATION_CHECK_MESSAGE, passed: true };
	} catch (error) {
		return {
			message: DECLARATION_CHECK_MESSAGE,
			passed: false,
			details: formatDeclarationError(error),
		};
	}
}

function formatDeclarationError(error: unknown): string[] {
	if (isProviderError(error) && error.code === DECLARATION_INVALID_CODE) {
		const details = error.details;
		if (isRecord(details) && Array.isArray(details.violations)) {
			return details.violations.map((violation) => {
				if (!isRecord(violation)) return String(violation);
				const ruleId = typeof violation.ruleId === "string" ? violation.ruleId : "unknown-rule";
				const path = typeof violation.path === "string" ? violation.path : "unknown-path";
				const message = typeof violation.message === "string" ? `: ${violation.message}` : "";
				const fix = typeof violation.fix === "string" ? ` Fix: ${violation.fix}` : "";
				return `${path} [${ruleId}]${message}${fix}`;
			});
		}
	}
	return [error instanceof Error ? error.message : String(error)];
}

export const PROMPT_ASSETS_CHECK_MESSAGE =
	"Agent prompt assets match the installed SDK version";

function checkPromptAssets(providerRoot: string): CheckResult {
	const verification = verifyPromptAssets(providerRoot);
	if (verification.ok) {
		return { message: PROMPT_ASSETS_CHECK_MESSAGE, passed: true };
	}

	return {
		message: PROMPT_ASSETS_CHECK_MESSAGE,
		passed: false,
		details: [...formatPromptAssetIssues(verification), PROMPT_ASSET_SYNC_REMEDIATION],
	};
}

function isScannableProviderSourceFile(relativePath: string): boolean {
	return (
		/\.(?:ts|tsx|js|jsx|mjs|cjs|sh|bash)$/.test(relativePath) ||
		/(?:^|\/)Dockerfile(?:\.|$)/.test(relativePath) ||
		/(?:^|\/)entrypoint(?:\.|$)/.test(relativePath)
	);
}

function collectProviderSourceFiles(providerRoot: string): Record<string, string> {
	const sources: Record<string, string> = {};
	// `.agents`/`.apifuse` are deliberately not skipped: managed content there
	// is markdown/JSON (never matched by isScannableProviderSourceFile), and a
	// planted `.ts`/`.sh` under those directories must stay in scanner scope.
	const skipDirectories = new Set([".git", "node_modules", "dist", "build", ".next"]);
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				if (!skipDirectories.has(entry.name)) {
					visit(path);
				}
				continue;
			}
			if (!entry.isFile() || !isScannableProviderSourceFile(path.slice(providerRoot.length + 1))) {
				continue;
			}
			sources[path.slice(providerRoot.length + 1)] = readFileSync(path, "utf8");
		}
	};
	visit(providerRoot);
	return sources;
}

function checkIndex(indexPath: string, provider: ProviderDefinition | undefined): CheckResult {
	if (!existsSync(indexPath)) {
		return {
			message: "index.ts exists and exports default defineProvider",
			passed: false,
		};
	}

	if (!provider) {
		return {
			message: "index.ts exists and exports default defineProvider",
			passed: false,
		};
	}

	return {
		message: "index.ts exists and exports default defineProvider",
		passed: true,
		details: [`provider id: ${provider.id}`],
	};
}

function checkOperations(provider: ProviderDefinition | undefined): CheckResult {
	if (!provider) {
		return {
			message: "All operations have handler, input, output",
			passed: false,
		};
	}

	const failures: string[] = [];

	for (const [operationId, operation] of Object.entries(provider.operations)) {
		if (typeof operation.handler !== "function") {
			failures.push(`${operationId}: missing handler`);
		}

		if (!hasSchemaParser(operation.input)) {
			failures.push(`${operationId}: missing input schema`);
		}

		if (!hasSchemaParser(operation.output)) {
			failures.push(`${operationId}: missing output schema`);
		}
	}

	return {
		message: "All operations have handler, input, output",
		passed: failures.length === 0,
		details: failures.length > 0 ? failures : Object.keys(provider.operations),
	};
}

function checkFixtures(provider: ProviderDefinition | undefined): CheckResult {
	if (!provider) {
		return { message: "All operations have fixtures", passed: false };
	}

	const failures: string[] = [];

	for (const [operationId, operation] of Object.entries(provider.operations)) {
		if (!operation.fixtures) {
			failures.push(`${operationId}: missing fixtures`);
			continue;
		}

		if (operation.fixtures.request === undefined) {
			failures.push(`${operationId}: missing fixtures.request`);
		}

		if (operation.fixtures.response === undefined) {
			failures.push(`${operationId}: missing fixtures.response`);
		}
	}

	return {
		message: "All operations have fixtures",
		passed: failures.length === 0,
		details: failures,
	};
}

function checkSchemas(provider: ProviderDefinition | undefined): CheckResult {
	if (!provider) {
		return {
			message: "Zod schemas parse fixtures without error",
			passed: false,
		};
	}

	const failures: string[] = [];

	for (const [operationId, operation] of Object.entries(provider.operations)) {
		if (!operation.fixtures) {
			continue;
		}

		const requestResult = parseFixture(operation.input, operation.fixtures.request);
		if (!requestResult.success) {
			failures.push(
				`${operationId}: request fixture invalid (${formatSchemaError(requestResult.error)})`,
			);
		}

		const responseResult = parseFixture(operation.output, operation.fixtures.response);
		if (!responseResult.success) {
			failures.push(
				`${operationId}: response fixture invalid (${formatSchemaError(responseResult.error)})`,
			);
		}
	}

	return {
		message: "Zod schemas parse fixtures without error",
		passed: failures.length === 0,
		details: failures,
	};
}

function checkAuthoringLint(
	provider: ProviderDefinition | undefined,
	providerSourceFiles: Record<string, string>,
	lintMode: ProviderLintMode = "official",
): CheckResult {
	if (!provider) {
		return {
			message: "Provider authoring lint has no error-level diagnostics",
			passed: false,
		};
	}

	const diagnostics = lintProvider({ ...provider, providerSourceFiles }, { mode: lintMode });
	const errors = diagnostics.filter((diagnostic) => diagnostic.level === "error");
	const details = diagnostics.map((diagnostic) => {
		const field = diagnostic.field ? `${diagnostic.field}: ` : "";
		return `${diagnostic.level.toUpperCase()} ${diagnostic.rule} ${field}${diagnostic.message}`;
	});

	return {
		message: "Provider authoring lint has no error-level diagnostics",
		passed: errors.length === 0,
		details,
	};
}

function checkProviderMetadata(provider: ProviderDefinition | undefined): CheckResult {
	if (!provider) {
		return {
			message: "Provider metadata is declared in defineProvider",
			passed: false,
		};
	}

	const details: string[] = [];

	if (!provider.id.trim()) {
		details.push("provider.id is empty");
	}

	if (!provider.meta.displayName.trim()) {
		details.push("provider.meta.displayName is empty");
	}

	if (!provider.meta.category.trim()) {
		details.push("provider.meta.category is empty");
	}

	if (!provider.runtime) {
		details.push("provider.runtime is missing");
	}

	if (!provider.auth?.mode) {
		details.push("provider.auth.mode is missing");
	}

	return {
		message: "Provider metadata is declared in defineProvider",
		passed: details.length === 0,
		details:
			details.length > 0
				? details
				: [
						`id: ${provider.id}`,
						`displayName: ${provider.meta.displayName}`,
						`category: ${provider.meta.category}`,
						`runtime: ${provider.runtime}`,
						`auth: ${provider.auth?.mode ?? "none"}`,
					],
	};
}

function checkDockerfile(dockerfilePath: string): CheckResult {
	return {
		message: "Dockerfile exists",
		passed: existsSync(dockerfilePath),
	};
}

function checkPackageJson(packageJsonPath: string): CheckResult {
	if (!existsSync(packageJsonPath)) {
		return {
			message: "package.json exists with @apifuse/provider-sdk dependency",
			passed: false,
		};
	}

	try {
		const packageJson = z
			.object({
				dependencies: z.record(z.string(), z.string()).optional(),
			})
			.parse(JSON.parse(readFileSync(packageJsonPath, "utf-8")) as unknown);

		const dependency = packageJson.dependencies?.["@apifuse/provider-sdk"];

		return {
			message: "package.json exists with @apifuse/provider-sdk dependency",
			passed: typeof dependency === "string" && dependency.length > 0,
			details:
				typeof dependency === "string"
					? [`@apifuse/provider-sdk: ${dependency}`]
					: ["Missing dependencies.@apifuse/provider-sdk"],
		};
	} catch (error) {
		return {
			message: "package.json exists with @apifuse/provider-sdk dependency",
			passed: false,
			details: [error instanceof Error ? error.message : String(error)],
		};
	}
}

export const PROVIDER_JSON_CHECK_MESSAGE = "provider.json exists with a valid declaration";

const providerDeclarationSchema = z
	.object({
		schemaVersion: z.literal(1),
		providerId: z.string(),
		owner: z.string(),
		lifecycle: z.enum(["draft", "ready", "live", "retired"]),
	})
	.strict();

function checkProviderJson(providerJsonPath: string, packageJsonPath: string): CheckResult {
	if (!existsSync(providerJsonPath)) {
		return {
			message: PROVIDER_JSON_CHECK_MESSAGE,
			passed: false,
			details: ["Missing provider.json at the provider root"],
		};
	}

	try {
		const declaration = providerDeclarationSchema.parse(
			JSON.parse(readFileSync(providerJsonPath, "utf-8")) as unknown,
		);
		const expectedProviderId = readProviderIdFromPackageName(packageJsonPath);
		if (expectedProviderId !== undefined && declaration.providerId !== expectedProviderId) {
			return {
				message: PROVIDER_JSON_CHECK_MESSAGE,
				passed: false,
				details: [
					`provider.json providerId "${declaration.providerId}" does not match package.json name (expected "${expectedProviderId}")`,
				],
			};
		}

		return {
			message: PROVIDER_JSON_CHECK_MESSAGE,
			passed: true,
			details: [`providerId: ${declaration.providerId}`, `lifecycle: ${declaration.lifecycle}`],
		};
	} catch (error) {
		return {
			message: PROVIDER_JSON_CHECK_MESSAGE,
			passed: false,
			details: [error instanceof Error ? error.message : String(error)],
		};
	}
}

function readProviderIdFromPackageName(packageJsonPath: string): string | undefined {
	try {
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as unknown;
		if (!isRecord(packageJson) || typeof packageJson.name !== "string") return undefined;
		return /^(?:apifuse-provider-|@apifuse\/provider-)(.+)$/.exec(packageJson.name)?.[1];
	} catch {
		return undefined;
	}
}

function assertProviderDefinition(value: unknown): ProviderDefinition | undefined {
	return isProviderDefinition(value) ? value : undefined;
}

function isProviderDefinition(value: unknown): value is ProviderDefinition {
	if (!isRecord(value) || !isRecord(value.meta) || !isRecord(value.operations)) {
		return false;
	}

	return (
		typeof value.id === "string" &&
		typeof value.version === "string" &&
		(value.runtime === "standard" || value.runtime === "shared" || value.runtime === "browser") &&
		typeof value.meta.displayName === "string" &&
		typeof value.meta.category === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasSchemaParser(value: unknown): boolean {
	return (
		isRecord(value) &&
		(typeof value.safeParse === "function" ||
			(isRecord(value["~standard"]) && typeof value["~standard"].validate === "function"))
	);
}

function formatSchemaError(error: unknown): string {
	if (error instanceof z.ZodError) {
		return error.issues.map((issue) => issue.message).join(", ");
	}

	if (Array.isArray(error)) {
		return error
			.map((issue) =>
				isRecord(issue) && typeof issue.message === "string" ? issue.message : String(issue),
			)
			.join(", ");
	}

	return error instanceof Error ? error.message : String(error);
}

function parseFixture(
	schema: ProviderDefinition["operations"][string]["input"],
	fixture: unknown,
): SafeParseResult {
	return safeParseSchemaSync(schema, fixture, "fixture");
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
