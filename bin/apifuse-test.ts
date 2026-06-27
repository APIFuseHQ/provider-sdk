#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

type CliArgs = {
	providerPath?: string;
	isJson: boolean;
	isVerbose: boolean;
};

type ProviderLocation = {
	inputPath: string;
	rootDir: string;
	testFilePath: string;
	rawFixturePath?: string;
	label: string;
};

type CommandResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

type TestSummary = {
	durationText?: string;
	errorCount: number;
	expectCallCount?: number;
	failedCount: number;
	fileCount?: number;
	passedCount: number;
	totalCount?: number;
};

type ActionableError = {
	candidateRawField?: string;
	expected?: string;
	field?: string;
	fixHint: string;
	received?: string;
	testName?: string;
	type: "zod";
};

export async function main() {
	try {
		const args = parseArgs(normalizeArgs(process.argv.slice(2)));
		const location = resolveProviderLocation(args.providerPath);

		if (args.isVerbose && !args.isJson) {
			console.log(`[apifuse test] Provider: ${location.label}`);
			console.log(`[apifuse test] Path: ${location.rootDir}`);
		}

		const result = await runProviderTests(location.rootDir, args.isJson);
		const combinedOutput = [result.stdout, result.stderr]
			.filter(Boolean)
			.join("\n");
		const summary = parseTestSummary(combinedOutput);
		const actionableError = parseActionableError(
			combinedOutput,
			location.rawFixturePath,
		);

		if (args.isJson) {
			const payload = {
				success: result.exitCode === 0,
				provider: {
					id: location.label,
					inputPath: location.inputPath,
					rootDir: location.rootDir,
					testFilePath: location.testFilePath,
				},
				exitCode: result.exitCode,
				summary: {
					duration: summary.durationText,
					errors: summary.errorCount,
					expectCalls: summary.expectCallCount,
					failed: summary.failedCount,
					files: summary.fileCount,
					passed: summary.passedCount,
					total: summary.totalCount,
				},
				actionableErrors: actionableError ? [actionableError] : [],
				...(args.isVerbose
					? {
							output: {
								stderr: result.stderr,
								stdout: result.stdout,
							},
						}
					: {}),
			};

			console.log(JSON.stringify(payload, null, 2));
			process.exit(result.exitCode);
		}

		printTextSummary({
			actionableError,
			providerLabel: location.label,
			exitCode: result.exitCode,
			summary,
		});

		process.exit(result.exitCode);
	} catch (error) {
		handleCliError(error);
	}
}

function normalizeArgs(argv: string[]): string[] {
	return argv[0] === "test" ? argv.slice(1) : argv;
}

function parseArgs(argv: string[]): CliArgs {
	let providerPath: string | undefined;
	let isJson = false;
	let isVerbose = false;

	for (const arg of argv) {
		if (arg === "--json") {
			isJson = true;
			continue;
		}

		if (arg === "--verbose" || arg === "-v") {
			isVerbose = true;
			continue;
		}

		if (arg.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}

		if (!providerPath) {
			providerPath = arg;
			continue;
		}

		throw new Error(`Unexpected argument: ${arg}`);
	}

	return { providerPath, isJson, isVerbose };
}

function resolveProviderLocation(inputPath?: string): ProviderLocation {
	const originalInput = inputPath ?? process.cwd();
	const resolvedInput = resolve(process.cwd(), originalInput);

	if (!existsSync(resolvedInput)) {
		throw new Error(`Provider path not found: ${originalInput}`);
	}

	const initialDirectory = statSync(resolvedInput).isDirectory()
		? resolvedInput
		: dirname(resolvedInput);
	const providerRoot =
		findProviderRoot(initialDirectory) ??
		autoDetectSingleProvider(initialDirectory, originalInput);

	const testFilePath = resolve(providerRoot, "__tests__", "index.test.ts");
	if (!existsSync(testFilePath)) {
		throw new Error(
			`Provider tests not found: ${relativeFromCwd(testFilePath)}. Expected __tests__/index.test.ts.`,
		);
	}

	const rawFixturePath = resolve(providerRoot, "__fixtures__", "raw.json");

	return {
		inputPath: originalInput,
		label: basename(providerRoot),
		rootDir: providerRoot,
		rawFixturePath: existsSync(rawFixturePath) ? rawFixturePath : undefined,
		testFilePath,
	};
}

function findProviderRoot(startDirectory: string): string | undefined {
	let currentDirectory = startDirectory;

	while (true) {
		if (looksLikeProviderRoot(currentDirectory)) {
			return currentDirectory;
		}

		const parentDirectory = dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			return undefined;
		}

		currentDirectory = parentDirectory;
	}
}

function autoDetectSingleProvider(
	searchDirectory: string,
	originalInput: string,
): string {
	const matches = collectProviderRoots(searchDirectory);

	if (matches.length === 1) {
		const [firstMatch] = matches;
		if (firstMatch) {
			return firstMatch;
		}
	}

	if (matches.length > 1) {
		throw new Error(
			[
				`Multiple providers found under ${originalInput}.`,
				"Pass an explicit provider path, for example:",
				...matches.map((match) => `  - apifuse test ${relativeFromCwd(match)}`),
			].join("\n"),
		);
	}

	throw new Error(
		[
			`Could not find a provider under ${originalInput}.`,
			"Expected a directory containing:",
			"  - index.ts",
			"  - __tests__/index.test.ts",
		].join("\n"),
	);
}

function collectProviderRoots(directory: string): string[] {
	const matches: string[] = [];
	const seen = new Set<string>();
	const queue = [directory];

	while (queue.length > 0) {
		const currentDirectory = queue.shift();
		if (!currentDirectory || seen.has(currentDirectory)) {
			continue;
		}

		seen.add(currentDirectory);

		if (looksLikeProviderRoot(currentDirectory)) {
			matches.push(currentDirectory);
			continue;
		}

		for (const entry of readdirSync(currentDirectory, {
			withFileTypes: true,
		})) {
			if (!entry.isDirectory()) {
				continue;
			}

			if (entry.name === "node_modules" || entry.name.startsWith(".")) {
				continue;
			}

			queue.push(resolve(currentDirectory, entry.name));
		}
	}

	return matches;
}

function looksLikeProviderRoot(directory: string): boolean {
	return [
		resolve(directory, "index.ts"),
		resolve(directory, "__tests__", "index.test.ts"),
	].every((filePath) => existsSync(filePath));
}

function relativeFromCwd(filePath: string): string {
	const relativePath = relative(process.cwd(), filePath);
	return relativePath || ".";
}

async function runProviderTests(
	providerRoot: string,
	isJson: boolean,
): Promise<CommandResult> {
	return await new Promise<CommandResult>((resolveResult, reject) => {
		const child = spawn("bun", ["test"], {
			cwd: providerRoot,
			stdio: ["inherit", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk: Buffer | string) => {
			const text = chunk.toString();
			stdout += text;
			if (!isJson) {
				process.stdout.write(text);
			}
		});

		child.stderr.on("data", (chunk: Buffer | string) => {
			const text = chunk.toString();
			stderr += text;
			if (!isJson) {
				process.stderr.write(text);
			}
		});

		child.on("error", (error) => {
			reject(new Error(`Failed to start bun test: ${error.message}`));
		});

		child.on("close", (code, signal) => {
			if (signal) {
				reject(new Error(`bun test terminated by signal: ${signal}`));
				return;
			}

			resolveResult({
				exitCode: code ?? 1,
				stderr,
				stdout,
			});
		});
	});
}

function parseTestSummary(output: string): TestSummary {
	const failedCount =
		extractLastNumber(output, /(^|\n)\s*(\d+)\s+fail\b/gm, 2) ?? 0;
	const errorCount =
		extractLastNumber(output, /(^|\n)\s*(\d+)\s+error\b/gm, 2) ?? 0;
	const passedCount =
		extractLastNumber(output, /(^|\n)\s*(\d+)\s+pass\b/gm, 2) ?? 0;
	const expectCallCount = extractLastNumber(
		output,
		/(^|\n)\s*(\d+)\s+expect\(\)\s+calls?\b/gm,
		2,
	);
	const runMatch = extractLastMatch(
		output,
		/Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?\.\s+\[(.+?)\]/g,
	);

	return {
		durationText: runMatch?.[3],
		errorCount,
		expectCallCount,
		failedCount,
		fileCount: runMatch?.[2] ? Number(runMatch[2]) : undefined,
		passedCount,
		totalCount: runMatch?.[1] ? Number(runMatch[1]) : undefined,
	};
}

function parseActionableError(
	output: string,
	rawFixturePath?: string,
): ActionableError | undefined {
	const issue = extractLastZodIssue(output);
	if (!issue) {
		return undefined;
	}

	const pathSegments = Array.isArray(issue.path) ? issue.path : [];
	const field = formatIssuePath(pathSegments);
	const lastPathSegment = pathSegments.at(-1);
	const fieldName =
		typeof lastPathSegment === "string" ? lastPathSegment : undefined;
	const candidateRawField = fieldName
		? findCandidateRawField(fieldName, rawFixturePath)
		: undefined;
	const fixLines = [
		fieldName
			? `transformResponse에서 ${fieldName} 필드를 빠뜨리지 않았는지 확인하세요.`
			: "transformResponse에서 누락된 필드 매핑이 없는지 확인하세요.",
		candidateRawField && candidateRawField !== fieldName
			? `raw fixture에서 해당 필드명은 "${candidateRawField}"일 수 있습니다.`
			: undefined,
	].filter(Boolean);

	return {
		candidateRawField,
		expected: typeof issue.expected === "string" ? issue.expected : undefined,
		field,
		fixHint: fixLines.join("\n"),
		received: extractReceivedValue(issue),
		testName: extractFailedTestName(output),
		type: "zod",
	};
}

function extractLastZodIssue(
	output: string,
): Record<string, unknown> | undefined {
	const zodIndex = output.lastIndexOf("ZodError:");
	if (zodIndex === -1) {
		return undefined;
	}

	const jsonText = extractBalancedJsonArray(
		output.slice(zodIndex + "ZodError:".length).trimStart(),
	);
	if (!jsonText) {
		return undefined;
	}

	try {
		const parsed: unknown = JSON.parse(jsonText);
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return undefined;
		}

		const [firstIssue] = parsed;
		if (!isRecord(firstIssue)) {
			return undefined;
		}

		return firstIssue;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractBalancedJsonArray(value: string): string | undefined {
	const start = value.indexOf("[");
	if (start === -1) {
		return undefined;
	}

	let depth = 0;
	let isEscaped = false;
	let isInsideString = false;

	for (let index = start; index < value.length; index += 1) {
		const character = value[index];

		if (!character) {
			continue;
		}

		if (isInsideString) {
			if (isEscaped) {
				isEscaped = false;
				continue;
			}

			if (character === "\\") {
				isEscaped = true;
				continue;
			}

			if (character === '"') {
				isInsideString = false;
			}

			continue;
		}

		if (character === '"') {
			isInsideString = true;
			continue;
		}

		if (character === "[") {
			depth += 1;
		}

		if (character === "]") {
			depth -= 1;
			if (depth === 0) {
				return value.slice(start, index + 1);
			}
		}
	}

	return undefined;
}

function extractReceivedValue(
	issue: Record<string, unknown>,
): string | undefined {
	if (typeof issue.received === "string") {
		return issue.received;
	}

	if (typeof issue.message !== "string") {
		return undefined;
	}

	const receivedMatch = /received\s+(.+)$/i.exec(issue.message);
	return receivedMatch?.[1]?.trim();
}

function extractFailedTestName(output: string): string | undefined {
	return extractLastMatch(
		output,
		/\(fail\)\s+(.+?)\s+\[[^\]]+\]/g,
	)?.[1]?.trim();
}

function formatIssuePath(path: unknown[]): string | undefined {
	if (path.length === 0) {
		return undefined;
	}

	let formatted = "";

	for (const segment of path) {
		if (typeof segment === "number") {
			formatted += `[${segment}]`;
			continue;
		}

		if (typeof segment === "string") {
			formatted += formatted ? `.${segment}` : segment;
		}
	}

	return formatted || undefined;
}

function findCandidateRawField(
	fieldName: string,
	rawFixturePath?: string,
): string | undefined {
	if (!rawFixturePath || !existsSync(rawFixturePath)) {
		return undefined;
	}

	try {
		const rawFixture: unknown = JSON.parse(
			readFileSync(rawFixturePath, "utf-8"),
		);
		const keys = Array.from(collectObjectKeys(rawFixture));
		const normalizedFieldName = normalizeIdentifier(fieldName);
		const ranked = keys
			.map((key) => ({
				key,
				score: scoreKeySimilarity(normalizedFieldName, key),
			}))
			.filter((entry) => entry.score > 0)
			.sort((left, right) => right.score - left.score);

		return ranked[0]?.key;
	} catch {
		return undefined;
	}
}

function collectObjectKeys(
	value: unknown,
	bucket = new Set<string>(),
): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectObjectKeys(item, bucket);
		}
		return bucket;
	}

	if (!value || typeof value !== "object") {
		return bucket;
	}

	for (const [key, nestedValue] of Object.entries(value)) {
		bucket.add(key);
		collectObjectKeys(nestedValue, bucket);
	}

	return bucket;
}

function normalizeIdentifier(value: string): string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function scoreKeySimilarity(targetTokens: string[], key: string): number {
	const keyTokens = normalizeIdentifier(key);
	if (keyTokens.length === 0) {
		return 0;
	}

	let score = 0;

	for (const token of targetTokens) {
		if (keyTokens.includes(token)) {
			score += 3;
			continue;
		}

		if (key.toLowerCase().includes(token)) {
			score += 2;
			continue;
		}

		if (
			token.length >= 3 &&
			keyTokens.some((candidate) => candidate.startsWith(token))
		) {
			score += 1;
		}
	}

	return score;
}

function printTextSummary(options: {
	actionableError?: ActionableError;
	providerLabel: string;
	exitCode: number;
	summary: TestSummary;
}) {
	const { actionableError, providerLabel, exitCode, summary } = options;
	const totalFailures = summary.failedCount + summary.errorCount;
	const durationSuffix = summary.durationText
		? ` (${summary.durationText})`
		: "";
	const ranLabel =
		summary.totalCount !== undefined
			? `Ran ${summary.totalCount} tests`
			: "Ran tests";

	if (exitCode === 0) {
		console.log(`\n✓ ${providerLabel} tests passed`);
		console.log(
			`${ranLabel} | ${summary.passedCount} passed, ${totalFailures} failed${durationSuffix} | exit ${exitCode}`,
		);
		return;
	}

	if (actionableError) {
		console.log(
			`\n✗ ${actionableError.testName ?? "transformResponse(raw) → output schema"}`,
		);
		console.log("\n  transformResponse output doesn't match schema:\n");
		if (actionableError.field) {
			console.log(`  ┌ Field: ${actionableError.field}`);
		}
		if (actionableError.expected) {
			console.log(`  │ Expected: ${actionableError.expected}`);
		}
		if (actionableError.received) {
			console.log(`  │ Received: ${actionableError.received}`);
		}
		console.log("  │");
		console.log(
			`  └ Fix: ${actionableError.fixHint.replace(/\n/g, "\n         ")}`,
		);
	}

	console.log(`\n✗ ${providerLabel} tests failed`);
	console.log(
		`${ranLabel} | ${summary.passedCount} passed, ${totalFailures} failed${durationSuffix} | exit ${exitCode}`,
	);
}

function handleCliError(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[apifuse test] ${message}`);
	process.exit(1);
}

function extractLastNumber(
	value: string,
	pattern: RegExp,
	groupIndex: number,
): number | undefined {
	const match = extractLastMatch(value, pattern);
	const resolved = match?.[groupIndex];
	return resolved ? Number(resolved) : undefined;
}

function extractLastMatch(
	value: string,
	pattern: RegExp,
): RegExpMatchArray | undefined {
	const matches = Array.from(value.matchAll(pattern));
	return matches[matches.length - 1];
}

void main();
