#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { ProviderDefinition } from "../src";
import {
	createBrowserClient,
	createCredentialContext,
	createEnvContext,
	createHttpClient,
	createProviderCache,
	createProviderChoiceContext,
	createStealthClient,
	createSttClientFromEnv,
	PROVIDER_RUNTIME_CHOICE_TOKEN_MASTER_SECRET_ENV,
	ProviderError,
} from "../src";
import { createMemoryProviderRuntimeState } from "../src/runtime/state";
import { createTraceContext } from "../src/runtime/trace";
import type { BrowserClient, ProviderContext } from "../src/types";

const HELP_TEXT = `Usage: apifuse dev [path]
Example: apifuse dev providers/korea-air-quality
Default: apifuse dev .`;

export async function main() {
	const args = normalizeArgs(process.argv.slice(2));

	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP_TEXT);
		return;
	}

	const providerPath = resolveProviderPath(args[0] ?? ".");
	const providerModule = await import(resolve(providerPath, "index.ts"));
	const provider = assertProviderDefinition(
		providerModule.default,
		providerPath,
	);

	const { startDevServer } = await import("../src/dev");
	const port = Number(process.env.APIFUSE__RUNTIME__PORT) || 3900;

	startDevServer(provider, { port });

	console.log("\nEndpoints:");
	console.log(`  GET  http://localhost:${port}/health`);

	for (const operationId of Object.keys(provider.operations)) {
		console.log(`  POST http://localhost:${port}/v1/${operationId}`);
	}

	console.log(`  POST http://localhost:${port}/auth/start`);
	console.log(`  POST http://localhost:${port}/auth/continue`);
	console.log(`  POST http://localhost:${port}/auth/poll`);
	console.log(`  POST http://localhost:${port}/auth/disconnect`);

	const firstOperation = Object.keys(provider.operations)[0];
	if (firstOperation) {
		const sampleInput =
			provider.operations[firstOperation]?.fixtures?.request ?? {};
		const sampleBody = JSON.stringify({
			requestId: `req_local_${firstOperation}`,
			input: sampleInput,
			headers: {},
		});
		console.log("\nSmoke:");
		console.log(`  curl -s http://localhost:${port}/health`);
		console.log(
			`  curl -s -X POST http://localhost:${port}/v1/${firstOperation} -H 'Content-Type: application/json' -d ${shellSingleQuote(sampleBody)}`,
		);
	}

	console.log("\nHot reload:");
	console.log(`  ${renderHotReloadCommand(providerPath, port)}`);
}

export function createProviderContext(provider: ProviderDefinition): {
	ctx: ProviderContext;
} {
	const env = createEnvContext([
		...(provider.secrets?.map((secret) => secret.name) ?? []),
		PROVIDER_RUNTIME_CHOICE_TOKEN_MASTER_SECRET_ENV,
	]);
	const credential = createCredentialContext();
	const state = createMemoryProviderRuntimeState();
	const ctx: ProviderContext = {
		env,
		credential,
		auth: createUnsupportedAuthStub(),
		browser:
			provider.runtime === "browser"
				? createBrowserClient({
						allowedHosts: provider.allowedHosts,
						engine: provider.browser?.engine ?? "playwright-stealth",
					})
				: createUnsupportedBrowserStub(),
		http: createHttpClient(),
		cache: createProviderCache({ providerId: provider.id }),
		state,
		trace: createTraceContext(),
		stealth: createStealthClient("http://localhost"),
		stt: createSttClientFromEnv(provider.stt),
		choice: createProviderChoiceContext({
			providerId: provider.id,
			env,
			credential,
			state,
		}),
	};

	return { ctx };
}

function normalizeArgs(argv: string[]): string[] {
	return argv[0] === "dev" ? argv.slice(1) : argv;
}

function resolveProviderPath(inputPath: string): string {
	const resolvedInput = resolveFromParents(inputPath);
	const entryPath = resolve(resolvedInput, "index.ts");

	if (!existsSync(entryPath)) {
		throw new Error(`Could not find index.ts in provider path: ${inputPath}`);
	}

	return resolvedInput;
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

function renderHotReloadCommand(providerPath: string, port: number): string {
	const devEntry = resolve(providerPath, "dev.ts");
	if (existsSync(devEntry)) {
		const relativeDevEntry = relative(process.cwd(), devEntry) || "dev.ts";
		const portPrefix = process.env.APIFUSE__RUNTIME__PORT
			? `APIFUSE__RUNTIME__PORT=${port} `
			: "";
		return `${portPrefix}bun --hot ${relativeDevEntry}`;
	}
	return "rerun `apifuse dev` after edits (no dev.ts entrypoint found)";
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function createUnsupportedBrowserStub(): BrowserClient {
	return {
		engine: "playwright-stealth",
		async close() {},
		async newPage() {
			throw new ProviderError(
				"Browser runtime is not enabled for this provider",
				{
					code: "BROWSER_RUNTIME_UNSUPPORTED",
					fix: 'Set provider runtime to "browser" to use ctx.browser',
				},
			);
		},
		async rawPage() {
			throw new ProviderError(
				"Browser runtime is not enabled for this provider",
				{
					code: "BROWSER_RUNTIME_UNSUPPORTED",
					fix: 'Set provider runtime to "browser" and APIFUSE__CDP_POOL__URL to use ctx.browser.rawPage',
				},
			);
		},
		async withIsolatedContext() {
			throw new ProviderError(
				"Browser runtime is not enabled for this provider",
				{
					code: "BROWSER_RUNTIME_UNSUPPORTED",
					fix: 'Set provider runtime to "browser" to use ctx.browser.withIsolatedContext',
				},
			);
		},
		async solveChallenge() {
			throw new ProviderError(
				"Browser runtime is not enabled for this provider",
				{
					code: "BROWSER_RUNTIME_UNSUPPORTED",
					fix: 'Set provider runtime to "browser" to use ctx.browser.solveChallenge',
				},
			);
		},
	};
}

async function promptForField(fieldName: string): Promise<string> {
	throw new ProviderError(`Auth prompt is unavailable for ${fieldName}`, {
		code: "AUTH_PROMPT_UNAVAILABLE",
	});
}

function createUnsupportedAuthStub() {
	return {
		requestField: promptForField,
	};
}

function assertProviderDefinition(
	value: unknown,
	providerPath: string,
): ProviderDefinition {
	if (!isProviderDefinition(value)) {
		throw new Error(
			`Expected ${resolve(providerPath, "index.ts")} to export default defineProvider(...)`,
		);
	}

	return value;
}

function isProviderDefinition(value: unknown): value is ProviderDefinition {
	if (
		!isRecord(value) ||
		!isRecord(value.meta) ||
		!isRecord(value.operations)
	) {
		return false;
	}

	return (
		typeof value.id === "string" &&
		typeof value.version === "string" &&
		(value.runtime === "standard" || value.runtime === "browser") &&
		typeof value.meta.displayName === "string" &&
		typeof value.meta.category === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
