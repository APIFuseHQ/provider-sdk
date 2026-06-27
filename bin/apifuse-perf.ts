#!/usr/bin/env bun
// @ts-nocheck

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	type ApiFuseConfig,
	createBypassProviderCache,
	createHttpClient,
	createProviderChoiceContext,
	createStealthClient,
	createSttClientFromEnv,
	executeOperation,
	getProviderBaseUrl,
	type HttpClient,
	loadApiFuseConfig,
	type ProviderContext,
	type ProviderDefinition,
	ProviderError,
	type Span,
	type StealthClient,
	type StealthResponse,
	wrapWithInstrumentation,
} from "../src";
import {
	computeStats,
	groupSpansByName,
	type PerfStats,
} from "../src/runtime/perf";
import { createMemoryProviderRuntimeState } from "../src/runtime/state";
import {
	createTraceContext,
	resolveTraceContextOptions,
} from "../src/runtime/trace";
import { renderWaterfall } from "../src/runtime/waterfall";
import type { BrowserClient } from "../src/types";

type CliArgs = {
	compareProxy: boolean;
	concurrency: number;
	providerPath: string;
	exportPath?: string;
	flame: boolean;
	operation: string;
	params?: string;
	runs: number;
	warmup: number;
};

type FixtureReplay = {
	raw: unknown;
	rawText: string;
};

type RunResult = {
	durationMs: number;
	mode: "live" | "fixture";
	spans: Span[];
	status: "ok" | "error";
	waterfall: string;
	proxyEnabled: boolean;
	error?: string;
	output?: unknown;
};

type ProfileSuite = {
	breakdown: Array<{ avgMs: number; name: string; percent: number }>;
	insights: string[];
	label: string;
	runs: RunResult[];
	stats: PerfStats;
};

type FlameNode = {
	children: FlameNode[];
	depth: number;
	span: Span;
};

const DEFAULT_RUNS = 10;
const DEFAULT_WARMUP = 2;
const DEFAULT_CONCURRENCY = 1;
const BAR_WIDTH = 20;
const HELP_TEXT = `Usage: apifuse perf <provider-path> --operation <operation> [options]

Options:
  --operation, -o <name>   operation to profile (required)
  --params, -p <json>      JSON input template; falls back to fixtures.request or {}
  --runs, -n <number>      number of runs (default: 10)
  --warmup <number>        warmup runs (default: 2)
  --concurrency, -c <n>    concurrent requests (default: 1)
  --compare-proxy          run with proxy on/off and compare
  --export <path>          export results to JSON file
  --flame                  generate flamegraph SVG
  --help, -h               show this help

Example:
  apifuse perf providers/korea-air-quality --operation realtime --params '{"stationName":"jongno"}' --runs 5`;

export async function main() {
	try {
		const args = parseArgs(normalizeArgs(process.argv.slice(2)));
		const providerDirectory = resolve(process.cwd(), args.providerPath);
		const providerEntry = resolveProviderEntry(providerDirectory);
		const provider = await loadProvider(providerEntry);
		const providerId = basename(providerDirectory);
		const config = await loadApiFuseConfig(process.cwd());
		const operation = getOperation(provider, args.operation);
		const inputSchema = getOperationSchema(provider, operation, "input");
		const outputSchema = getOperationSchema(provider, operation, "output");
		const fixtureReplay = await loadFixtureReplay(providerDirectory);
		const inputTemplate = resolveInputTemplate(
			provider,
			inputSchema,
			args.params,
		);

		const directSuite = await runProfileSuite({
			args,
			config,
			provider,
			providerId,
			fixtureReplay,
			inputSchema,
			inputTemplate,
			operationName: args.operation,
			outputSchema,
			proxyEnabled: false,
		});

		let proxySuite: ProfileSuite | undefined;
		if (args.compareProxy) {
			assertProxyConfigured(config);
			proxySuite = await runProfileSuite({
				args,
				config,
				provider,
				providerId,
				fixtureReplay,
				inputSchema,
				inputTemplate,
				operationName: args.operation,
				outputSchema,
				proxyEnabled: true,
			});
		}

		const report = renderReport({
			providerId,
			operationName: args.operation,
			runs: args.runs,
			suite: directSuite,
			proxySuite,
		});
		console.log(report);

		let flamePath: string | undefined;
		if (args.flame) {
			flamePath = await writeFlamegraph({
				providerId,
				operationName: args.operation,
				outputPath: args.exportPath,
				representativeRun: selectRepresentativeRun(directSuite.runs),
				fallbackDirectory: process.cwd(),
				label: `${providerId}/${args.operation}`,
				proxyEnabled: false,
				stats: directSuite.stats,
				mode: directSuite.runs.some((run) => run.mode === "fixture")
					? "fixture"
					: "live",
			});
			console.log(`Flamegraph: ${flamePath}`);
		}

		if (args.exportPath) {
			await writeExport(args.exportPath, {
				provider: providerId,
				operation: args.operation,
				runs: args.runs,
				warmup: args.warmup,
				concurrency: args.concurrency,
				direct: directSuite,
				proxy: proxySuite,
				flamePath,
			});
			console.log(`Exported JSON: ${resolve(process.cwd(), args.exportPath)}`);
		}
	} catch (error) {
		handleCliError(error);
	}
}

function normalizeArgs(argv: string[]): string[] {
	return argv[0] === "perf" ? argv.slice(1) : argv;
}

function parseArgs(argv: string[]): CliArgs {
	let providerPath: string | undefined;
	let operation: string | undefined;
	let runs = DEFAULT_RUNS;
	let warmup = DEFAULT_WARMUP;
	let concurrency = DEFAULT_CONCURRENCY;
	let compareProxy = false;
	let exportPath: string | undefined;
	let flame = false;
	let params: string | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];

		if (!arg) {
			continue;
		}

		if (!arg.startsWith("-")) {
			if (providerPath) {
				throw new Error(`Unexpected argument: ${arg}`);
			}

			providerPath = arg;
			continue;
		}

		if (arg === "--help" || arg === "-h") {
			console.log(HELP_TEXT);
			process.exit(0);
		}

		if (arg === "--compare-proxy") {
			compareProxy = true;
			continue;
		}

		if (arg === "--flame") {
			flame = true;
			continue;
		}

		if (arg === "--operation" || arg === "-o") {
			operation = requireArgValue(argv, index, arg);
			index += 1;
			continue;
		}

		if (arg.startsWith("--operation=")) {
			operation = arg.slice("--operation=".length);
			continue;
		}

		if (arg === "--params" || arg === "-p") {
			params = requireArgValue(argv, index, arg);
			index += 1;
			continue;
		}

		if (arg.startsWith("--params=")) {
			params = arg.slice("--params=".length);
			continue;
		}

		if (arg.startsWith("-p=")) {
			params = arg.slice("-p=".length);
			continue;
		}

		if (arg.startsWith("-o=")) {
			operation = arg.slice("-o=".length);
			continue;
		}

		if (arg === "--runs" || arg === "-n") {
			runs = parsePositiveInteger(requireArgValue(argv, index, arg), arg);
			index += 1;
			continue;
		}

		if (arg.startsWith("--runs=")) {
			runs = parsePositiveInteger(arg.slice("--runs=".length), "--runs");
			continue;
		}

		if (arg.startsWith("-n=")) {
			runs = parsePositiveInteger(arg.slice("-n=".length), "-n");
			continue;
		}

		if (arg === "--warmup") {
			warmup = parseNonNegativeInteger(requireArgValue(argv, index, arg), arg);
			index += 1;
			continue;
		}

		if (arg.startsWith("--warmup=")) {
			warmup = parseNonNegativeInteger(
				arg.slice("--warmup=".length),
				"--warmup",
			);
			continue;
		}

		if (arg === "--concurrency" || arg === "-c") {
			concurrency = parsePositiveInteger(
				requireArgValue(argv, index, arg),
				arg,
			);
			index += 1;
			continue;
		}

		if (arg.startsWith("--concurrency=")) {
			concurrency = parsePositiveInteger(
				arg.slice("--concurrency=".length),
				"--concurrency",
			);
			continue;
		}

		if (arg.startsWith("-c=")) {
			concurrency = parsePositiveInteger(arg.slice("-c=".length), "-c");
			continue;
		}

		if (arg === "--export") {
			exportPath = requireArgValue(argv, index, arg);
			index += 1;
			continue;
		}

		if (arg.startsWith("--export=")) {
			exportPath = arg.slice("--export=".length);
			continue;
		}

		throw new Error(`Unknown option: ${arg}`);
	}

	if (!providerPath || !operation) {
		throw new Error(HELP_TEXT);
	}

	return {
		compareProxy,
		concurrency,
		providerPath,
		exportPath,
		flame,
		operation,
		params,
		runs,
		warmup,
	};
}

function requireArgValue(
	argv: string[],
	index: number,
	option: string,
): string {
	const value = argv[index + 1];
	if (!value) {
		throw new Error(`Missing value for ${option}`);
	}

	return value;
}

function parsePositiveInteger(value: string, option: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`Invalid value for ${option}: ${value}`);
	}

	return parsed;
}

function parseNonNegativeInteger(value: string, option: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`Invalid value for ${option}: ${value}`);
	}

	return parsed;
}

function resolveProviderEntry(providerDirectory: string): string {
	for (const candidate of ["index.ts", "index.js"]) {
		const entryPath = resolve(providerDirectory, candidate);
		if (existsSync(entryPath)) {
			return entryPath;
		}
	}

	throw new Error(`Provider entry not found in ${providerDirectory}`);
}

async function loadProvider(
	providerEntry: string,
): Promise<ProviderDefinition> {
	const mod = (await import(pathToFileURL(providerEntry).href)) as {
		default?: ProviderDefinition;
	};

	if (!mod.default) {
		throw new Error(`Provider module has no default export: ${providerEntry}`);
	}

	return mod.default;
}

function getOperation(provider: ProviderDefinition, operationName: string) {
	const operation = provider.operations[operationName];
	if (!operation) {
		throw new ProviderError(`Unknown operation: ${operationName}`, {
			code: "OPERATION_NOT_FOUND",
		});
	}

	return operation;
}

function getOperationSchema(
	_provider: ProviderDefinition,
	operation: unknown,
	kind: "input" | "output",
) {
	if (operation && typeof operation === "object" && kind in operation) {
		const operationSchema = Reflect.get(operation, kind);
		if (isSchema(operationSchema)) {
			return operationSchema;
		}
	}

	throw new ProviderError(`Operation missing ${kind} schema`);
}

function isSchema(value: unknown): value is { parse(input: unknown): unknown } {
	return value !== null && typeof value === "object" && "parse" in value;
}

function resolveInputTemplate(
	provider: ProviderDefinition,
	inputSchema: { parse(input: unknown): unknown },
	params: string | undefined,
): unknown {
	if (params !== undefined) {
		try {
			return inputSchema.parse(JSON.parse(params));
		} catch (error) {
			throw new Error(
				`Failed to parse --params JSON or validate input: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const firstOp = Object.values(provider.operations)[0];
	if (firstOp?.fixtures?.request !== undefined) {
		return firstOp.fixtures.request;
	}

	try {
		return inputSchema.parse({});
	} catch {
		throw new Error(
			"No fixture request found. Add fixtures.request to the operation or make the input schema parse an empty object.",
		);
	}
}

async function loadFixtureReplay(
	providerDirectory: string,
): Promise<FixtureReplay | null> {
	const fixturePath = resolve(providerDirectory, "__fixtures__", "raw.json");
	if (!existsSync(fixturePath)) {
		return null;
	}

	const rawText = await readFile(fixturePath, "utf8");
	return {
		raw: JSON.parse(rawText),
		rawText,
	};
}

function assertProxyConfigured(config: ApiFuseConfig): void {
	if (config.proxy?.url || process.env.APIFUSE__PROXY__URL) {
		return;
	}

	throw new Error(
		"--compare-proxy requires a proxy URL in apifuse.config.ts or APIFUSE__PROXY__URL.",
	);
}

async function runProfileSuite(options: {
	args: CliArgs;
	config: ApiFuseConfig;
	provider: ProviderDefinition;
	providerId: string;
	fixtureReplay: FixtureReplay | null;
	inputSchema: { parse(input: unknown): unknown };
	inputTemplate: unknown;
	operationName: string;
	outputSchema: { parse(input: unknown): unknown };
	proxyEnabled: boolean;
}): Promise<ProfileSuite> {
	for (let index = 0; index < options.args.warmup; index += 1) {
		await profileRun({
			config: options.config,
			provider: options.provider,
			providerId: options.providerId,
			fixtureReplay: options.fixtureReplay,
			inputSchema: options.inputSchema,
			inputTemplate: options.inputTemplate,
			operationName: options.operationName,
			outputSchema: options.outputSchema,
			proxyEnabled: options.proxyEnabled,
		});
	}

	const runs: RunResult[] = [];
	for (
		let index = 0;
		index < options.args.runs;
		index += options.args.concurrency
	) {
		const batchSize = Math.min(
			options.args.concurrency,
			options.args.runs - index,
		);
		const batch = Array.from({ length: batchSize }, () =>
			profileRun({
				config: options.config,
				provider: options.provider,
				providerId: options.providerId,
				fixtureReplay: options.fixtureReplay,
				inputSchema: options.inputSchema,
				inputTemplate: options.inputTemplate,
				operationName: options.operationName,
				outputSchema: options.outputSchema,
				proxyEnabled: options.proxyEnabled,
			}),
		);
		runs.push(...(await Promise.all(batch)));
	}

	const stats = computeStats(runs.map((run) => run.durationMs));
	const groupedSpans = groupSpansByName(runs.map((run) => run.spans));
	const rootSpanName = `${options.providerId}/${options.operationName}`;
	const breakdown = [...groupedSpans.entries()]
		.filter(([name]) => name !== rootSpanName)
		.map(([name, durations]) => {
			const avgMs =
				durations.reduce((sum, value) => sum + value, 0) / durations.length;
			const percent = stats.avg > 0 ? (avgMs / stats.avg) * 100 : 0;
			return { avgMs, name, percent };
		})
		.sort((left, right) => right.avgMs - left.avgMs);

	return {
		breakdown,
		insights: buildInsights(runs, stats, breakdown),
		label: options.proxyEnabled ? "proxy: on" : "proxy: off",
		runs,
		stats,
	};
}

async function profileRun(options: {
	config: ApiFuseConfig;
	provider: ProviderDefinition;
	providerId: string;
	fixtureReplay: FixtureReplay | null;
	inputSchema: { parse(input: unknown): unknown };
	inputTemplate: unknown;
	operationName: string;
	outputSchema: { parse(input: unknown): unknown };
	proxyEnabled: boolean;
}): Promise<RunResult> {
	try {
		return await executeProfileRun({ ...options, forceFixtureReplay: false });
	} catch (error) {
		if (!options.fixtureReplay || !looksLikeNetworkFailure(error)) {
			throw error;
		}

		return executeProfileRun({ ...options, forceFixtureReplay: true });
	}
}

function looksLikeNetworkFailure(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	return /network|http|tls|fetch|timeout|transport/i.test(error.message);
}

async function executeProfileRun(options: {
	config: ApiFuseConfig;
	provider: ProviderDefinition;
	providerId: string;
	fixtureReplay: FixtureReplay | null;
	forceFixtureReplay: boolean;
	inputSchema: { parse(input: unknown): unknown };
	inputTemplate: unknown;
	operationName: string;
	outputSchema: { parse(input: unknown): unknown };
	proxyEnabled: boolean;
}): Promise<RunResult> {
	const _operation = getOperation(options.provider, options.operationName);
	const traceContext = createTraceContext(
		resolveTraceContextOptions(options.config.trace),
	);
	const baseContext = createBaseContext({
		config: options.config,
		provider: options.provider,
		fixtureReplay: options.fixtureReplay,
		forceFixtureReplay: options.forceFixtureReplay,
		proxyEnabled: options.proxyEnabled,
		traceContext,
	});
	const ctx = wrapWithInstrumentation(baseContext);
	const input = cloneValue(options.inputTemplate);
	const rootSpanName = `${options.providerId}/${options.operationName}`;

	const startedAt = performance.now();
	const output = await ctx.trace.span(rootSpanName, async () => {
		const normalizedInput = await ctx.trace.span("normalizeRequest", async () =>
			options.inputSchema.parse(input),
		);
		const result = await executeOperation(
			options.provider,
			options.operationName,
			ctx,
			normalizedInput,
		);

		return ctx.trace.span("transformResponse", async () =>
			options.outputSchema.parse(result),
		);
	});
	const durationMs = performance.now() - startedAt;
	const spans = ctx.trace.getSpans();
	const waterfall = renderWaterfall(spans, {
		method: "POST",
		path: `/v1/${options.providerId}/${options.operationName}`,
		status: 200,
		totalMs: Math.max(0, Math.round(durationMs)),
	});

	return {
		durationMs,
		mode: options.forceFixtureReplay ? "fixture" : "live",
		output,
		proxyEnabled: options.proxyEnabled,
		spans,
		status: "ok",
		waterfall,
	};
}

function createBaseContext(options: {
	config: ApiFuseConfig;
	provider: ProviderDefinition;
	fixtureReplay: FixtureReplay | null;
	forceFixtureReplay: boolean;
	proxyEnabled: boolean;
	traceContext: ReturnType<typeof createTraceContext>;
}): ProviderContext {
	const upstream = {
		...{ proxy: options.provider.proxy },
		proxy: options.proxyEnabled,
	};
	const apifuseConfig = options.proxyEnabled ? options.config : {};
	const http =
		options.forceFixtureReplay && options.fixtureReplay
			? createFixtureHttpClient(options.fixtureReplay.raw)
			: createHttpClient(getProviderBaseUrl(options.provider), {
					apifuseConfig,
					upstream,
				});
	const stealth =
		options.forceFixtureReplay && options.fixtureReplay
			? createFixtureStealthClient(options.fixtureReplay.rawText)
			: createStealthClient(getProviderBaseUrl(options.provider), {
					apifuseConfig,
					upstream,
				});

	const env = {
		get: (key: string) => process.env[key],
	};
	const credential = {
		mode: "none" as const,
		get: () => undefined,
		getAll: () => ({}),
		getAccessToken: () => undefined,
		getScopes: () => [],
	};
	const state = createMemoryProviderRuntimeState();
	return {
		env,
		credential,
		request: { headers: {} },
		http,
		cache: createBypassProviderCache({ providerId: options.provider.id }),
		state,
		stealth,
		browser: createBrowserStub(),
		trace: options.traceContext,
		auth: createAuthStub(),
		stt: createSttClientFromEnv(options.provider.stt),
		choice: createProviderChoiceContext({
			providerId: options.provider.id,
			env,
			request: { headers: {} },
			credential,
			state,
		}),
	};
}

function createAuthStub() {
	return {
		requestField: async (name: string) => {
			throw new ProviderError(`Auth prompt is unavailable for ${name}`, {
				code: "AUTH_PROMPT_UNAVAILABLE",
			});
		},
	};
}

function createFixtureHttpClient(raw: unknown): HttpClient {
	return {
		request: async () => createFixtureResponse(raw),
		get: async () => createFixtureResponse(raw),
		post: async () => createFixtureResponse(raw),
		put: async () => createFixtureResponse(raw),
		delete: async () => createFixtureResponse(raw),
	};
}

function createFixtureResponse(raw: unknown) {
	return {
		data: cloneValue(raw),
		meta: {
			requestId: crypto.randomUUID(),
			duration: 0,
			cached: true,
		},
	};
}

function createFixtureStealthClient(rawText: string): StealthClient {
	const createResponse = async (): Promise<StealthResponse> => ({
		status: 200,
		ok: true,
		headers: { "content-type": "application/json" },
		rawHeaders: [["content-type", "application/json"]],
		body: rawText,
		cookies: { get: () => undefined, getAll: () => ({}), toString: () => "" },
		json: async <T>() => JSON.parse(rawText) as T,
	});

	return {
		fetch: async () => createResponse(),
		createSession() {
			return {
				fetch: async () => createResponse(),
				close() {},
			};
		},
	};
}

function createBrowserStub(): BrowserClient {
	return {
		engine: "playwright-stealth",
		async close() {},
		async newPage() {
			throw new ProviderError(
				"Browser runtime is not supported by apifuse perf yet.",
				{
					code: "BROWSER_RUNTIME_UNSUPPORTED",
				},
			);
		},
		async rawPage() {
			throw new ProviderError(
				"Browser runtime is not supported by apifuse perf yet.",
				{
					code: "BROWSER_RUNTIME_UNSUPPORTED",
				},
			);
		},
		async withIsolatedContext() {
			throw new ProviderError(
				"Browser runtime is not supported by apifuse perf yet.",
				{
					code: "BROWSER_RUNTIME_UNSUPPORTED",
				},
			);
		},
		async solveChallenge() {
			throw new ProviderError(
				"Browser runtime is not supported by apifuse perf yet.",
				{
					code: "BROWSER_RUNTIME_UNSUPPORTED",
				},
			);
		},
	};
}

function buildInsights(
	runs: RunResult[],
	stats: PerfStats,
	breakdown: Array<{ avgMs: number; name: string; percent: number }>,
): string[] {
	const insights: string[] = [];
	const allSpans = runs.flatMap((run) => run.spans);
	const stealthSpans = allSpans.filter((span) => span.name === "stealth.fetch");
	const dnsSpans = allSpans.filter((span) => span.name === "dns");
	const transform = breakdown.find(
		(entry) => entry.name === "transformResponse",
	);
	const responseSizes = allSpans
		.map((span) => span.attributes.response_size)
		.filter((value): value is number => typeof value === "number");
	const reuseFlags = stealthSpans
		.map((span) => span.attributes.connection_reused)
		.filter((value): value is boolean => typeof value === "boolean");

	if (reuseFlags.length > 0) {
		const reusePercent = Math.round(
			(reuseFlags.filter(Boolean).length / reuseFlags.length) * 100,
		);
		insights.push(
			reusePercent >= 80
				? `✓ Stealth connection reuse: ${reusePercent}% (good)`
				: `⚠ Stealth connection reuse: ${reusePercent}% — consider session reuse`,
		);
	}

	if (transform) {
		insights.push(
			transform.percent < 2
				? `✓ Transform overhead: <2% (good)`
				: `⚠ Transform overhead: ${formatPercent(transform.percent)} — review response shaping`,
		);
	}

	if (dnsSpans.length > 0) {
		const dnsAvg =
			dnsSpans.reduce((sum, span) => sum + span.duration_ms, 0) /
			dnsSpans.length;
		if (dnsAvg >= 5) {
			insights.push(
				`⚠ DNS resolution: ${formatDuration(dnsAvg)} avg — consider DNS caching`,
			);
		}
	}

	if (responseSizes.length > 0) {
		const avgSize =
			responseSizes.reduce((sum, value) => sum + value, 0) /
			responseSizes.length;
		if (avgSize >= 4096) {
			insights.push(
				`⚠ Response size: ${formatBytes(avgSize)} avg — check gzip (Accept-Encoding)`,
			);
		}
	}

	if (insights.length === 0) {
		insights.push(
			stats.p95 > stats.p50 * 1.5
				? "⚠ Tail latency spread is high — inspect slow outlier runs"
				: "✓ No obvious bottlenecks detected",
		);
	}

	return insights;
}

function renderReport(options: {
	providerId: string;
	operationName: string;
	proxySuite?: ProfileSuite;
	runs: number;
	suite: ProfileSuite;
}): string {
	const lines = [
		`┌ Performance Report: ${options.providerId}/${options.operationName} (${options.runs} runs)`,
		"│",
		"│ Total",
		`│   p50: ${formatDuration(options.suite.stats.p50)}    p95: ${formatDuration(options.suite.stats.p95)}    p99: ${formatDuration(options.suite.stats.p99)}    avg: ${formatDuration(options.suite.stats.avg)}`,
		"│",
		"│ Breakdown (avg)",
	];

	for (const row of options.suite.breakdown) {
		lines.push(
			`│   ${row.name.padEnd(22)} ${formatDuration(row.avgMs).padStart(7)}  ${renderBar(row.percent)}  ${formatPercent(row.percent).padStart(3)}`,
		);
	}

	lines.push("│");
	lines.push("│ Insights:");
	for (const insight of options.suite.insights) {
		lines.push(`│   ${insight}`);
	}

	if (options.proxySuite) {
		const delta = options.proxySuite.stats.p50 - options.suite.stats.p50;
		const deltaPercent =
			options.suite.stats.p50 > 0 ? (delta / options.suite.stats.p50) * 100 : 0;
		lines.push("│");
		lines.push("│ Proxy Comparison (--compare-proxy):");
		lines.push(
			`│   proxy: off  → p50: ${formatDuration(options.suite.stats.p50)}`,
		);
		lines.push(
			`│   proxy: on   → p50: ${formatDuration(options.proxySuite.stats.p50)} (${delta >= 0 ? "+" : ""}${Math.round(deltaPercent)}%)`,
		);
	}

	lines.push("└──────────────────────────────────────────────────────");
	return lines.join("\n");
}

function renderBar(percent: number): string {
	if (percent < 10) {
		return `░${" ".repeat(BAR_WIDTH - 1)}`;
	}

	const blocks = Math.max(1, Math.min(BAR_WIDTH, Math.round(percent / 5)));
	return `${"█".repeat(blocks)}${" ".repeat(BAR_WIDTH - blocks)}`;
}

function formatDuration(ms: number): string {
	if (ms >= 1000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}

	if (ms >= 10) {
		return `${Math.round(ms)}ms`;
	}

	return `${ms.toFixed(1)}ms`;
}

function formatPercent(value: number): string {
	return `${Math.round(value)}%`;
}

function formatBytes(value: number): string {
	if (value >= 1024 * 1024) {
		return `${(value / (1024 * 1024)).toFixed(1)}MB`;
	}

	if (value >= 1024) {
		return `${(value / 1024).toFixed(1)}KB`;
	}

	return `${Math.round(value)}B`;
}

function selectRepresentativeRun(runs: RunResult[]): RunResult {
	const sorted = [...runs].sort(
		(left, right) => left.durationMs - right.durationMs,
	);
	const middle = sorted[Math.floor(sorted.length / 2)];
	if (middle) {
		return middle;
	}

	const first = runs[0];
	if (!first) {
		throw new Error("Expected at least one run result");
	}

	return first;
}

async function writeExport(filePath: string, payload: unknown): Promise<void> {
	const absolutePath = resolve(process.cwd(), filePath);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, JSON.stringify(payload, null, 2));
}

async function writeFlamegraph(options: {
	providerId: string;
	operationName: string;
	outputPath?: string;
	representativeRun: RunResult;
	fallbackDirectory: string;
	label: string;
	proxyEnabled: boolean;
	stats: PerfStats;
	mode: "fixture" | "live";
}): Promise<string> {
	const svg = buildFlamegraphSvg(options.representativeRun.spans, {
		label: options.label,
		mode: options.mode,
		proxyEnabled: options.proxyEnabled,
		stats: options.stats,
	});
	const absolutePath = resolve(
		options.outputPath
			? `${stripExtension(resolve(process.cwd(), options.outputPath))}.flame.svg`
			: resolve(
					options.fallbackDirectory,
					`${sanitizeFileName(options.providerId)}-${sanitizeFileName(options.operationName)}.flame.svg`,
				),
	);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, svg);
	return absolutePath;
}

function stripExtension(filePath: string): string {
	const extension = extname(filePath);
	return extension ? filePath.slice(0, -extension.length) : filePath;
}

function sanitizeFileName(value: string): string {
	return value.replace(/[^a-z0-9-_]+/gi, "-").replace(/-+/g, "-");
}

function buildFlamegraphSvg(
	spans: Span[],
	meta: {
		label: string;
		mode: "fixture" | "live";
		proxyEnabled: boolean;
		stats: PerfStats;
	},
): string {
	if (spans.length === 0) {
		return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="120"><text x="16" y="32">No spans captured</text></svg>`;
	}

	const tree = buildFlameTree(spans);
	const flattened = flattenFlameTree(tree);
	const root = findRootSpan(spans);
	const totalDuration = Math.max(1, root.duration_ms);
	const width = 1200;
	const rowHeight = 26;
	const chartTop = 64;
	const maxDepth = Math.max(...flattened.map((node) => node.depth), 0);
	const height = chartTop + (maxDepth + 1) * rowHeight + 24;

	const rects = flattened
		.map((node) => {
			const x =
				12 +
				((node.span.startedAt - root.startedAt) / totalDuration) * (width - 24);
			const rectWidth = Math.max(
				1,
				(node.span.duration_ms / totalDuration) * (width - 24),
			);
			const y = chartTop + node.depth * rowHeight;
			const label = escapeXml(
				`${node.span.name} (${formatDuration(node.span.duration_ms)})`,
			);
			const title = escapeXml(
				`${node.span.name}\n${formatDuration(node.span.duration_ms)}\nstatus: ${node.span.status}`,
			);
			return `<g><title>${title}</title><rect x="${x.toFixed(2)}" y="${y}" width="${rectWidth.toFixed(2)}" height="20" rx="3" fill="${spanColor(node.span.name)}" /><text x="${(x + 4).toFixed(2)}" y="${y + 14}" font-size="11" fill="#0f172a">${label}</text></g>`;
		})
		.join("");

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<rect width="100%" height="100%" fill="#ffffff" />`,
		`<text x="16" y="24" font-size="18" font-family="ui-sans-serif, system-ui" fill="#0f172a">${escapeXml(meta.label)} flamegraph</text>`,
		`<text x="16" y="44" font-size="12" font-family="ui-sans-serif, system-ui" fill="#475569">mode: ${meta.mode} · proxy: ${meta.proxyEnabled ? "on" : "off"} · p50: ${formatDuration(meta.stats.p50)} · p95: ${formatDuration(meta.stats.p95)}</text>`,
		rects,
		`</svg>`,
	].join("");
}

function buildFlameTree(spans: Span[]): FlameNode[] {
	const sorted = [...spans].sort(
		(left, right) => left.startedAt - right.startedAt,
	);
	const nodeMap = new Map<string, FlameNode>();

	for (const span of sorted) {
		nodeMap.set(span.id, { children: [], depth: 0, span });
	}

	const roots: FlameNode[] = [];
	for (const span of sorted) {
		const node = nodeMap.get(span.id);
		if (!node) {
			continue;
		}
		if (span.parentId) {
			const parent = nodeMap.get(span.parentId);
			if (parent) {
				node.depth = parent.depth + 1;
				parent.children.push(node);
				continue;
			}
		}

		roots.push(node);
	}

	return roots;
}

function flattenFlameTree(nodes: FlameNode[]): FlameNode[] {
	const output: FlameNode[] = [];
	for (const node of nodes) {
		output.push(node);
		output.push(...flattenFlameTree(node.children));
	}
	return output;
}

function findRootSpan(spans: Span[]): Span {
	const root = spans.find((span) => !span.parentId);
	if (root) {
		return root;
	}

	const sorted = [...spans].sort(
		(left, right) => left.startedAt - right.startedAt,
	);
	const first = sorted[0];
	if (!first) {
		throw new Error("Expected at least one span");
	}

	return first;
}

function spanColor(name: string): string {
	if (name.startsWith("tls.")) {
		return "#60a5fa";
	}
	if (name.startsWith("browser.")) {
		return "#4ade80";
	}
	if (name.startsWith("http.")) {
		return "#f59e0b";
	}
	if (name === "normalizeRequest") {
		return "#a78bfa";
	}
	if (name === "transformResponse") {
		return "#f472b6";
	}
	return "#cbd5e1";
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

function handleCliError(error: unknown): never {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`[apifuse perf] ${message}`);
	process.exit(1);
}

if (import.meta.main) {
	await main();
}
