#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	createBypassProviderCache,
	createHttpClient,
	createProviderChoiceContext,
	createStealthClient,
	createSttClientFromEnv,
	executeOperation,
	type HttpClient,
	type HttpResponse,
	type HttpStreamResponse,
	type ProviderContext,
	type ProviderDefinition,
	ProviderError,
	type StealthClient,
	TransportError,
	ValidationError,
} from "../src/index.js";
import { createMemoryProviderRuntimeState } from "../src/runtime/state.js";
import { parseSchema } from "../src/schema.js";
import {
	captureStreamEvidence,
	STREAM_PREVIEW_BYTES,
	type StreamEvidenceCapture,
} from "../src/stream-evidence.js";

type CliArgs = {
	append: boolean;
	providerPath?: string;
	operation?: string;
	params: string;
	sanitize: boolean;
};

type ProviderRuntime = ProviderDefinition;

type MutableRecord = Record<string, unknown>;

const HELP_TEXT = `Usage: apifuse record [path] --operation <operation> --params '<json>'

Calls a real upstream-backed operation through ctx.http or ctx.stealth and writes __fixtures__/raw.json.

Streaming responses are recorded as evidence (status, selected headers, full-body SHA-256 and byte
count, plus a ${STREAM_PREVIEW_BYTES}-byte base64 preview). Test replay is evidence-only: ctx.http.stream exposes the
preview as its body and the original body_sha256/body_bytes as response metadata.

Options:
  --operation, -o <name>   operation to call
  --params, -p <json>      JSON input passed to the operation (default: {})
  --append                 preserve the existing fixture and append this capture
  --sanitize               redact common token/header fields (default)
  --no-sanitize            write the captured upstream payload as-is
  --help, -h               show this help

Example:
  apifuse record providers/korea-air-quality --operation realtime --params '{"stationName":"jongno"}'`;

export async function main() {
	try {
		const args = parseArgs(normalizeArgs(process.argv.slice(2)));
		const location = resolveProviderLocation(args.providerPath);
		const provider = await loadProvider(location.rootDir);
		const operationName = resolveOperationName(provider, args.operation);
		const operation = provider.operations[operationName];
		const parsedParams = await parseParams(operation, args.params);

		const capture = createCaptureContext(
			provider,
			resolveOperationBaseUrl(provider, operationName),
			args.sanitize,
		);

		console.log(`[apifuse record] Calling ${operationName} on ${provider.id}...`);

		const result = await executeOperation(provider, operationName, capture.ctx, parsedParams);
		const captured = await capture.getCapturedRaw();

		if (captured === undefined) {
			throw new Error(`No upstream response was captured for ${provider.id}.${operationName}.`);
		}

		const rawPayload = args.sanitize ? sanitizeFixture(captured) : captured;
		const fixturePath = resolve(location.rootDir, "__fixtures__", "raw.json");
		const nextPayload = await prepareFixturePayload(fixturePath, rawPayload, args.append);

		await mkdir(dirname(fixturePath), { recursive: true });
		await writeFile(fixturePath, `${JSON.stringify(nextPayload, null, 2)}\n`);

		console.log(
			`[apifuse record] Captured response (${formatBytes(
				Buffer.byteLength(JSON.stringify(rawPayload)),
			)})`,
		);
		console.log(`[apifuse record] Saved to ${relative(process.cwd(), fixturePath)}`);

		void result;
	} catch (error) {
		handleCliError(error);
	}
}

function normalizeArgs(argv: string[]): string[] {
	return argv[0] === "record" ? argv.slice(1) : argv;
}

function parseArgs(argv: string[]): CliArgs {
	let providerPath: string | undefined;
	let operation: string | undefined;
	let params = "{}";
	let sanitize = true;
	let append = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];

		if (arg === "--operation" || arg === "-o") {
			const value = argv[index + 1];
			if (!value) {
				throw new Error("Missing value for --operation.");
			}

			operation = value;
			index += 1;
			continue;
		}

		if (arg === "--help" || arg === "-h") {
			console.log(HELP_TEXT);
			process.exit(0);
		}

		if (arg.startsWith("--operation=")) {
			operation = arg.slice("--operation=".length);
			continue;
		}

		if (arg === "--params" || arg === "-p") {
			const value = argv[index + 1];
			if (!value) {
				throw new Error("Missing value for --params.");
			}

			params = value;
			index += 1;
			continue;
		}

		if (arg.startsWith("--params=")) {
			params = arg.slice("--params=".length);
			continue;
		}

		if (arg === "--sanitize") {
			sanitize = true;
			continue;
		}

		if (arg === "--no-sanitize") {
			sanitize = false;
			continue;
		}

		if (arg === "--append") {
			append = true;
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

	return { append, providerPath, operation, params, sanitize };
}

function handleCliError(error: unknown): never {
	const message = formatCliError(error);
	console.error(`[apifuse record] ${message}`);
	process.exit(1);
}

function formatCliError(error: unknown): string {
	if (error instanceof TransportError) {
		return [
			error.message,
			error.upstreamStatus ? `status=${error.upstreamStatus}` : undefined,
			error.options?.retryable !== undefined
				? `retryable=${String(error.options.retryable)}`
				: undefined,
			error.fix ? `fix=${error.fix}` : undefined,
		]
			.filter(Boolean)
			.join(" ");
	}

	if (error instanceof ProviderError || error instanceof ValidationError) {
		return [error.message, error.code ? `code=${error.code}` : undefined, error.fix]
			.filter(Boolean)
			.join(" ");
	}

	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function resolveProviderLocation(inputPath?: string) {
	const originalInput = inputPath ?? process.cwd();
	const resolvedInput = resolve(process.cwd(), originalInput);

	if (!existsSync(resolvedInput)) {
		throw new Error(`Provider path not found: ${originalInput}`);
	}

	const initialDirectory = statSync(resolvedInput).isDirectory()
		? resolvedInput
		: dirname(resolvedInput);
	const providerRoot = findProviderRoot(initialDirectory);

	if (!providerRoot) {
		throw new Error(`Could not find provider root under: ${originalInput}`);
	}

	return {
		inputPath: originalInput,
		label: basename(providerRoot),
		rootDir: providerRoot,
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

function looksLikeProviderRoot(directory: string): boolean {
	return (
		existsSync(resolve(directory, "index.ts")) && existsSync(resolve(directory, "package.json"))
	);
}

async function loadProvider(rootDir: string): Promise<ProviderRuntime> {
	const entryPath = resolve(rootDir, "index.ts");
	const module = (await import(pathToFileURL(entryPath).href)) as {
		default?: ProviderRuntime;
	};

	if (!module.default) {
		throw new Error(`Provider must default-export a definition: ${entryPath}`);
	}

	return module.default;
}

function resolveOperationName(provider: ProviderRuntime, operationName?: string): string {
	if (operationName) {
		if (!(operationName in provider.operations)) {
			throw new Error(`Unknown operation "${operationName}" for provider "${provider.id}".`);
		}

		return operationName;
	}

	const [firstOperation] = Object.keys(provider.operations);
	if (!firstOperation) {
		throw new Error(`Provider "${provider.id}" has no operations.`);
	}

	return firstOperation;
}

async function parseParams(
	operation: ProviderRuntime["operations"][string],
	value: string,
): Promise<unknown> {
	let parsed: unknown;

	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error(
			`Failed to parse --params JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return operation.input ? await parseSchema(operation.input, parsed, "operation input") : parsed;
}

function resolveOperationBaseUrl(provider: ProviderRuntime, operationName: string): string {
	const baseUrl = provider.operations[operationName]?.upstream?.baseUrl;
	if (!baseUrl) {
		throw new Error(
			`Operation "${operationName}" for provider "${provider.id}" must define upstream.baseUrl.`,
		);
	}

	return baseUrl;
}

function createCaptureContext(provider: ProviderRuntime, baseUrl: string, sanitize: boolean) {
	let nextCaptureOrder = 0;
	let capturedRaw: { order: number; value: unknown } | undefined;
	let capturedStream: { order: number; capture: StreamEvidenceCapture } | undefined;
	const reserveCaptureOrder = () => {
		nextCaptureOrder += 1;
		return nextCaptureOrder;
	};
	const retainRawCapture = (order: number, value: unknown) => {
		if (!capturedRaw || order > capturedRaw.order) capturedRaw = { order, value };
	};

	const http = captureHttpClient(createHttpClient(baseUrl), {
		reserveOrder: reserveCaptureOrder,
		onResponse: (order, response) => retainRawCapture(order, response.data),
		onStreamResponse: (order, requestUrl, response) => {
			const capture = captureStreamEvidence(response, {
				requestUrl: resolveCaptureUrl(baseUrl, requestUrl),
				...(sanitize ? { sanitizeFixture } : {}),
			});
			if (!capturedStream || order > capturedStream.order) capturedStream = { order, capture };
			return capture.response;
		},
	});
	const stealth = proxyStealthClient(
		createStealthClient(baseUrl),
		(order, response) => retainRawCapture(order, normalizeCapturedStealthResponse(response)),
		reserveCaptureOrder,
	);

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
	const ctx: ProviderContext = {
		env,
		credential,
		request: { headers: {} },
		http,
		cache: createBypassProviderCache({ providerId: provider.id }),
		state,
		stealth,
		browser: {
			engine: "playwright-stealth",
			close: async () => {},
			newPage: async () => {
				throw new Error("Browser client is not available in apifuse record.");
			},
			rawPage: async () => {
				throw new Error("Browser client is not available in apifuse record.");
			},
			withIsolatedContext: async () => {
				throw new Error("Browser client is not available in apifuse record.");
			},
			solveChallenge: async () => {
				throw new Error("Browser client is not available in apifuse record.");
			},
		},
		trace: {
			span: async (_name, fn) => fn(),
		},
		auth: {
			requestField: async () => {
				throw new Error("Auth prompts are not available in apifuse record.");
			},
		},
		stt: createSttClientFromEnv(provider.stt),
		choice: createProviderChoiceContext({
			providerId: provider.id,
			env,
			request: { headers: {} },
			credential,
			state,
		}),
	};

	return {
		ctx,
		getCapturedRaw: async () =>
			capturedStream ? await capturedStream.capture.getEvidence() : capturedRaw?.value,
	};
}

type HttpCaptureCallbacks = {
	reserveOrder(): number;
	onResponse(order: number, response: HttpResponse): void;
	onStreamResponse(
		order: number,
		requestUrl: string,
		response: HttpStreamResponse,
	): HttpStreamResponse;
};

function captureHttpClient(client: HttpClient, callbacks: HttpCaptureCallbacks): HttpClient {
	const captureResponse = async (
		order: number,
		responsePromise: Promise<HttpResponse>,
	): Promise<HttpResponse> => {
		const response = await responsePromise;
		callbacks.onResponse(order, response);
		return response;
	};

	return {
		request: (...args: Parameters<HttpClient["request"]>) =>
			captureResponse(callbacks.reserveOrder(), client.request(...args)),
		get: (...args: Parameters<HttpClient["get"]>) =>
			captureResponse(callbacks.reserveOrder(), client.get(...args)),
		post: (...args: Parameters<HttpClient["post"]>) =>
			captureResponse(callbacks.reserveOrder(), client.post(...args)),
		put: (...args: Parameters<HttpClient["put"]>) =>
			captureResponse(callbacks.reserveOrder(), client.put(...args)),
		delete: (...args: Parameters<HttpClient["delete"]>) =>
			captureResponse(callbacks.reserveOrder(), client.delete(...args)),
		stream: async (...args: Parameters<HttpClient["stream"]>) => {
			const order = callbacks.reserveOrder();
			const response = await client.stream(...args);
			return callbacks.onStreamResponse(order, args[0], response);
		},
		sse: (...args: Parameters<HttpClient["sse"]>) => client.sse(...args),
	};
}

type StealthSession = ReturnType<StealthClient["createSession"]>;

function proxyStealthClient(
	client: StealthClient,
	onResponse: (order: number, response: Awaited<ReturnType<StealthClient["fetch"]>>) => void,
	reserveOrder: () => number,
): StealthClient {
	return {
		fetch: async (...args: Parameters<StealthClient["fetch"]>) => {
			const order = reserveOrder();
			const response = await client.fetch(...args);
			onResponse(order, response);
			return response;
		},
		createSession: (...args: Parameters<StealthClient["createSession"]>) =>
			proxyStealthSession(client.createSession(...args), onResponse, reserveOrder),
	};
}

function proxyStealthSession(
	session: StealthSession,
	onResponse: (order: number, response: Awaited<ReturnType<StealthClient["fetch"]>>) => void,
	reserveOrder: () => number,
): StealthSession {
	return {
		fetch: async (...args: Parameters<StealthSession["fetch"]>) => {
			const order = reserveOrder();
			const response = await session.fetch(...args);
			onResponse(order, response);
			return response;
		},
		cookies: session.cookies,
		redirects: session.redirects,
		close: () => session.close(),
	};
}

function resolveCaptureUrl(baseUrl: string, requestUrl: string): string {
	try {
		return new URL(requestUrl, baseUrl).toString();
	} catch {
		return requestUrl;
	}
}

function normalizeCapturedStealthResponse(response: Awaited<ReturnType<StealthClient["fetch"]>>) {
	try {
		return JSON.parse(response.body);
	} catch {
		return response.body;
	}
}

function sanitizeFixture(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeFixture(item));
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	const entries = Object.entries(value as MutableRecord).map(([key, entryValue]) => {
		if (isSensitiveKey(key)) {
			return [key, "[REDACTED]"] as const;
		}

		return [key, sanitizeFixture(entryValue)] as const;
	});

	return Object.fromEntries(entries);
}

function isSensitiveKey(key: string): boolean {
	return /authorization|token|api[-_]?key/i.test(key);
}

export async function prepareFixturePayload(
	fixturePath: string,
	payload: unknown,
	append: boolean,
): Promise<unknown> {
	if (!append || !existsSync(fixturePath)) {
		return payload;
	}

	let fixtureSource: string;
	try {
		fixtureSource = readFileSync(fixturePath, "utf8");
	} catch (error) {
		throw new Error(
			`Cannot append to existing fixture "${fixturePath}" because it could not be read: ${
				error instanceof Error ? error.message : String(error)
			}. Fix its permissions or delete it, then run apifuse record --append again.`,
		);
	}

	let existing: unknown;
	try {
		existing = JSON.parse(fixtureSource) as unknown;
	} catch (error) {
		throw new Error(
			`Cannot append to corrupt fixture "${fixturePath}" because it is not valid JSON: ${
				error instanceof Error ? error.message : String(error)
			}. Fix or delete the fixture, then run apifuse record --append again.`,
		);
	}

	if (Array.isArray(existing)) {
		return [...existing, payload];
	}
	if (existing !== null) {
		return [existing, payload];
	}
	return payload;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}

	return `${(bytes / 1024).toFixed(1)} KB`;
}

if (import.meta.main) {
	await main();
}
