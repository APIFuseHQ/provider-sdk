#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
	createCredentialContext,
	createEnvContext,
	createHttpClient,
	createOcrClientFromEnv,
	createProviderCache,
	createProviderChoiceContext,
	createProviderEnvironment,
	createRemoteProviderEngineFromEnv,
	createSttClientFromEnv,
	createUnsupportedResolverClient,
	PROVIDER_RUNTIME_CHOICE_TOKEN_MASTER_SECRET_ENV,
	readEngineProxyCredentials,
	type ProviderDefinition,
	type ProviderEngine,
	type ProviderEngineBindingCandidates,
	ProviderError,
	type ProviderProxyPolicy,
	workspaceApiKeyFromEnv,
} from "../src/index.js";
import { createBrowserClient } from "../src/runtime/browser.js";
import { isRemoteProviderEngine } from "../src/engine-private.js";
import { createResolverClientFromEnv } from "../src/runtime/resolver.js";
import { createMemoryProviderRuntimeState } from "../src/runtime/state.js";
import { createStealthClient } from "../src/runtime/stealth.js";
import { createTraceContext } from "../src/runtime/trace.js";
import { getStealthProfile } from "../src/stealth/profiles.js";
import type { BrowserClient, ProviderContext } from "../src/types.js";

const HELP_TEXT = `Usage: apifuse dev [path]
Example: apifuse dev providers/korea-air-quality
Default: apifuse dev .`;

export async function main() {
	const args = normalizeArgs(process.argv.slice(2));

	if (args.includes("--help") || args.includes("-h")) {
		console.log(HELP_TEXT);
		return;
	}
	workspaceApiKeyFromEnv();

	const providerPath = resolveProviderPath(args[0] ?? ".");
	const providerModule = await import(resolve(providerPath, "index.ts"));
	const provider = assertProviderDefinition(providerModule.default, providerPath);

	const { startDevServer } = await import("../src/dev.js");
	const port = Number(process.env.APIFUSE__RUNTIME__PORT) || 3900;

	await startDevServer(provider, { port });

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
		const sampleInput = provider.operations[firstOperation]?.fixtures?.request ?? {};
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

export function createProviderContext(
	provider: ProviderDefinition,
	engine: ProviderEngine = createRemoteProviderEngineFromEnv(provider),
): {
	ctx: ProviderContext;
} {
	const providerEnvironment = createProviderEnvironment(process.env, provider.secrets ?? []);
	const providerEnv = { get: (key: string) => providerEnvironment[key] };
	const candidates: ProviderEngineBindingCandidates = {
		env: providerEnv,
		credential: createCredentialContext(),
		auth: createUnsupportedAuthStub(),
		trace: createTraceContext(),
	};
	if (!isRemoteProviderEngine(engine)) {
		const engineEnv = createEnvContext([PROVIDER_RUNTIME_CHOICE_TOKEN_MASTER_SECRET_ENV]);
		const engineCredentials = readEngineProxyCredentials();
		const credential = createCredentialContext();
		const state = createMemoryProviderRuntimeState();
		const cache = createProviderCache({ providerId: provider.id });
		const proxyPolicy = resolveNativeProxyPolicy(provider);
		const stealthProfile = provider.stealth ? getStealthProfile(provider.stealth) : undefined;
		Object.assign(candidates, {
			credential,
			browser:
				provider.runtime === "browser"
					? createBrowserClient({
							allowedHosts: provider.allowedHosts,
							engine: provider.browser?.engine ?? "playwright-stealth",
						})
					: createUnsupportedBrowserStub(),
			http: createHttpClient(),
			cache,
			state,
			stealth: createStealthClient("http://localhost", {
				...(provider.stealth ? { stealth: provider.stealth } : {}),
			}),
			ocr: createOcrClientFromEnv(provider.ocr),
			stt: createSttClientFromEnv(provider.stt),
			resolver: provider.resolver
				? createResolverClientFromEnv(provider.resolver, engineCredentials, {
						allowedHosts: provider.allowedHosts,
						cache,
						...(proxyPolicy
							? {
									proxyIntent: {
										mode: proxyPolicy.mode,
										upstream: { proxy: provider.proxy },
										...(stealthProfile ? { userAgent: stealthProfile.userAgent } : {}),
									},
								}
							: {}),
					})
				: createUnsupportedResolverClient("Provider does not declare resolver capability"),
			choice: createProviderChoiceContext({
				providerId: provider.id,
				env: engineEnv,
				credential,
				state,
			}),
		});
	}
	const ctx = engine.attach({
		provider,
		bindings: candidates,
	}) as ProviderContext;

	return { ctx };
}

function resolveNativeProxyPolicy(provider: ProviderDefinition): ProviderProxyPolicy | undefined {
	if (typeof provider.proxy === "object") return provider.proxy;
	if (provider.proxy === true) return { mode: "optional" };
	if (provider.proxy === false) return { mode: "disabled" };
	return undefined;
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
		const portPrefix = process.env.APIFUSE__RUNTIME__PORT ? `APIFUSE__RUNTIME__PORT=${port} ` : "";
		return `${portPrefix}bun --hot ${relativeDevEntry}`;
	}
	return "rerun `apifuse dev` after edits (no dev.ts entrypoint found)";
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function createUnsupportedBrowserStub(): BrowserClient {
	const unavailable = async () => {
		throw new ProviderError("Browser runtime is not enabled for this provider", {
			code: "BROWSER_RUNTIME_UNSUPPORTED",
		});
	};
	return {
		engine: "playwright-stealth",
		async close() {},
		newPage: unavailable,
		rawPage: unavailable,
		withIsolatedContext: unavailable,
		solveChallenge: unavailable,
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

function assertProviderDefinition(value: unknown, providerPath: string): ProviderDefinition {
	if (!isProviderDefinition(value)) {
		throw new Error(
			`Expected ${resolve(providerPath, "index.ts")} to export default defineProvider(...)`,
		);
	}

	return value;
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

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
