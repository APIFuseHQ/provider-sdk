#!/usr/bin/env bun
// @ts-nocheck

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
	type ProviderContext,
	type ProviderDefinition,
	ProviderError,
	type RequestOptions,
	type StealthClient,
	TransportError,
	ValidationError,
} from "../src/index.js";
import { createMemoryProviderRuntimeState } from "../src/runtime/state.js";
import {
	REDACTED_QUERY_VALUE,
	normalizeSensitiveParams,
	redactSensitiveError,
	redactSensitiveText,
	redactUrlQueryParams,
	replaceRequestOptionsInHttpInvocation,
	requestOptionsFromHttpInvocation,
	serializeRequestUrl,
} from "../src/runtime/request-options.js";

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

Options:
  --operation, -o <name>   operation to call
  --params, -p <json>      JSON input passed to the operation (default: {})
  --append                 preserve the existing fixture and append this capture
  --sanitize               redact common token/header fields (default)
  --no-sanitize            disable common-field redaction (sensitiveParams are always redacted)
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
		const parsedParams = parseParams(operation, args.params);

		const capture = createCaptureContext(
			provider,
			resolveOperationBaseUrl(provider, operationName),
		);

		console.log(`[apifuse record] Calling ${operationName} on ${provider.id}...`);

		const result = await executeOperation(provider, operationName, capture.ctx, parsedParams);
		const captured = capture.getCapturedRaw();

		if (captured === undefined) {
			throw new Error(`No upstream response was captured for ${provider.id}.${operationName}.`);
		}

		const sensitiveParams = capture.getCapturedSensitiveParams();
		const fixturePath = resolve(location.rootDir, "__fixtures__", "raw.json");
		const mergedPayload = await prepareFixturePayload(fixturePath, captured, args.append);
		// Redact after append history has been merged. A credential moved from
		// ordinary params to sensitiveParams must also be removed from older entries.
		const nextPayload = redactFixture(mergedPayload, sensitiveParams, args.sanitize);
		const redactedCapture = redactFixture(captured, sensitiveParams, args.sanitize);

		await mkdir(dirname(fixturePath), { recursive: true });
		await writeFile(fixturePath, `${JSON.stringify(nextPayload, null, 2)}\n`);

		console.log(
			`[apifuse record] Captured response (${formatBytes(
				Buffer.byteLength(JSON.stringify(redactedCapture)),
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

function parseParams(operation: ProviderRuntime["operations"][string], value: string): unknown {
	let parsed: unknown;

	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new Error(
			`Failed to parse --params JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return operation.input ? operation.input.parse(parsed) : parsed;
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

function createCaptureContext(provider: ProviderRuntime, baseUrl: string) {
	let capturedRaw: unknown;
	const sensitiveParamNames = new Set<string>();
	const sensitiveParamValues = new Set<string>();
	const captureSensitiveParams = (url: string, options?: RequestOptions) => {
		captureSensitiveRequestValues(url, options, sensitiveParamNames, sensitiveParamValues);
	};

	const http = proxyHttpClient(createHttpClient(baseUrl), captureSensitiveParams, (response) => {
		capturedRaw = response.data;
	});
	const stealth = proxyStealthClient(
		createStealthClient(baseUrl),
		captureSensitiveParams,
		(response) => {
			capturedRaw = normalizeCapturedStealthResponse(response);
		},
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
		getCapturedRaw: () => capturedRaw,
		getCapturedSensitiveParams: () => ({
			names: [...sensitiveParamNames],
			values: [...sensitiveParamValues],
		}),
	};
}

type CapturedSensitiveParams = {
	names: readonly string[];
	values: readonly string[];
};

function captureSensitiveRequestValues(
	url: string,
	options: RequestOptions | undefined,
	names: Set<string>,
	values: Set<string>,
): void {
	const sensitiveParams = normalizeSensitiveParams(options?.sensitiveParams);
	if (sensitiveParams === undefined) return;
	if (!sensitiveParams || typeof sensitiveParams !== "object" || Array.isArray(sensitiveParams)) {
		throw new TypeError("sensitiveParams must be an object whose values are strings.");
	}

	const entries = Object.entries(sensitiveParams);
	for (const [key, value] of entries) {
		if (typeof value !== "string") {
			throw new TypeError(`sensitiveParams.${key} must be a string.`);
		}
		names.add(key);
		if (value !== "") values.add(value);
	}

	let serializedUrl: ReturnType<typeof serializeRequestUrl>;
	try {
		const absoluteUrl = new URL(String(url), "http://apifuse.invalid").toString();
		serializedUrl = serializeRequestUrl(absoluteUrl, options.params, sensitiveParams);
	} catch (error) {
		const structural = redactUrlQueryParams(String(url), [...names]);
		throw new TypeError("Cannot securely record sensitiveParams for an invalid request URL.", {
			cause: redactSensitiveError(
				error,
				[...values, ...structural.sensitiveValues],
				String(url),
				structural.redactedUrl,
			),
		});
	}

	for (const value of serializedUrl.sensitiveValues) {
		if (value !== "") values.add(value);
	}
}

function snapshotRequestOptions<T extends RequestOptions>(options: T): T {
	return {
		...options,
		...(options.params
			? {
					params: Object.fromEntries(
						Object.entries(options.params).map(([key, value]) => [
							key,
							Array.isArray(value) ? [...value] : value,
						]),
					),
				}
			: {}),
		...(normalizeSensitiveParams(options.sensitiveParams)
			? { sensitiveParams: { ...options.sensitiveParams } }
			: {}),
	};
}

function proxyHttpClient(
	client: HttpClient,
	onSensitiveParams: (url: string, options?: RequestOptions) => void,
	onResponse: (response: Awaited<ReturnType<HttpClient["get"]>>) => void,
): HttpClient {
	return new Proxy(client, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);

			if (typeof value !== "function") {
				return value;
			}

			return async (...args: unknown[]) => {
				const options = requestOptionsFromHttpInvocation(prop, args);
				if (options) {
					const snapshot = snapshotRequestOptions(options);
					onSensitiveParams(String(args[0]), snapshot);
					replaceRequestOptionsInHttpInvocation(prop, args, snapshot);
				}
				const response = await value.apply(target, args);
				onResponse(response);
				return response;
			};
		},
	}) as HttpClient;
}

type StealthSession = ReturnType<StealthClient["createSession"]>;

function proxyStealthClient(
	client: StealthClient,
	onSensitiveParams: (url: string, options?: RequestOptions) => void,
	onResponse: (response: Awaited<ReturnType<StealthClient["fetch"]>>) => void,
): StealthClient {
	return {
		fetch: async (...args: Parameters<StealthClient["fetch"]>) => {
			if (args[1]) args[1] = snapshotRequestOptions(args[1]);
			onSensitiveParams(args[0], args[1]);
			const response = await client.fetch(...args);
			onResponse(response);
			return response;
		},
		createSession: (...args: Parameters<StealthClient["createSession"]>) =>
			proxyStealthSession(client.createSession(...args), onSensitiveParams, onResponse),
	};
}

function proxyStealthSession(
	session: StealthSession,
	onSensitiveParams: (url: string, options?: RequestOptions) => void,
	onResponse: (response: Awaited<ReturnType<StealthClient["fetch"]>>) => void,
): StealthSession {
	return {
		fetch: async (...args: Parameters<StealthSession["fetch"]>) => {
			if (args[1]) args[1] = snapshotRequestOptions(args[1]);
			onSensitiveParams(args[0], args[1]);
			const response = await session.fetch(...args);
			onResponse(response);
			return response;
		},
		redirects: {
			run: async (...args: Parameters<StealthSession["redirects"]["run"]>) => {
				args[0] = snapshotRequestOptions(args[0]);
				onSensitiveParams(args[0].url, args[0]);
				const callerStopWhen = args[0].stopWhen;
				args[0].stopWhen = async (hop) => {
					for (const url of [hop.url, hop.location, hop.nextUrl]) {
						if (url) onSensitiveParams(url, args[0]);
					}
					return callerStopWhen ? await callerStopWhen(hop) : false;
				};
				const result = await session.redirects.run(...args);
				onResponse(result.final);
				return result;
			},
		},
		close: () => session.close(),
	};
}

function normalizeCapturedStealthResponse(response: Awaited<ReturnType<StealthClient["fetch"]>>) {
	try {
		return JSON.parse(response.body);
	} catch {
		return response.body;
	}
}

function redactFixture(
	value: unknown,
	sensitiveParams: CapturedSensitiveParams,
	sanitizeCommonFields: boolean,
): unknown {
	if (typeof value === "string") {
		if (value !== "" && sensitiveParams.values.includes(value)) return REDACTED_QUERY_VALUE;
		return redactFixtureText(value, sensitiveParams);
	}

	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
		return sensitiveParams.values.includes(String(value)) ? REDACTED_QUERY_VALUE : value;
	}

	if (Array.isArray(value)) {
		return value.map((item) => redactFixture(item, sensitiveParams, sanitizeCommonFields));
	}

	if (!value || typeof value !== "object") return value;

	const result: MutableRecord = Object.create(null) as MutableRecord;
	for (const [key, entryValue] of Object.entries(value as MutableRecord)) {
		const redactedKey = sensitiveParams.values.includes(key)
			? REDACTED_QUERY_VALUE
			: redactFixtureText(key, sensitiveParams);
		const uniqueKey = collisionSafeKey(result, redactedKey);
		result[uniqueKey] =
			sanitizeCommonFields && isSensitiveKey(key)
				? REDACTED_QUERY_VALUE
				: redactFixture(entryValue, sensitiveParams, sanitizeCommonFields);
	}
	return result;
}

function redactFixtureText(text: string, sensitiveParams: CapturedSensitiveParams): string {
	// Shared free-text policy: long values are unconditional substrings; values
	// shorter than four characters require token boundaries. Exact scalar echoes
	// and declared query-key positions are structurally redacted for every length.
	let redacted = redactSensitiveText(text, sensitiveParams.values);
	for (const name of sensitiveParams.names) {
		const keyVariants = new Set([
			name,
			encodeURIComponent(name),
			new URLSearchParams({ [name]: "" }).toString().slice(0, -1),
		]);
		for (const key of keyVariants) {
			const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const queryValue = new RegExp(`(^|[?&])(${escapedKey}=)[^&#\\s"]*`, "gi");
			redacted = redacted.replace(queryValue, (_match, prefix, assignment) => {
				return `${prefix}${assignment}${REDACTED_QUERY_VALUE}`;
			});
		}
	}
	return redacted;
}

function collisionSafeKey(record: MutableRecord, preferredKey: string): string {
	if (!(preferredKey in record)) return preferredKey;
	let suffix = 2;
	while (`${preferredKey}#${suffix}` in record) suffix += 1;
	return `${preferredKey}#${suffix}`;
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
