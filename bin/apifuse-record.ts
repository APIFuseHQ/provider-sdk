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
import type { JsonValue } from "../src/contract-json.js";
import {
	requestPathForFixture,
	sanitizeDiagnosticText,
	sanitizeFixture,
	sanitizeOrdinaryFixture,
} from "../src/fixture-sanitization.js";
import { createMemoryProviderRuntimeState } from "../src/runtime/state.js";
import {
	captureStreamEvidence,
	createStreamCaptureEnvelope,
	findStreamCaptureGroup,
	findStreamEvidenceRecords,
	hasStreamEvidenceMarker,
	parseStreamEvidenceRecord,
	STREAM_PREVIEW_BYTES,
	type StreamCaptureGroupItem,
	type StreamEvidenceCapture,
	type StreamEvidenceRequest,
} from "../src/stream-evidence.js";

type CliArgs = {
	append: boolean;
	providerPath?: string;
	operation?: string;
	params: string;
	sanitize: boolean;
};

type ProviderRuntime = ProviderDefinition;

const HELP_TEXT = `Usage: apifuse record [path] --operation <operation> --params '<json>'

Calls a real upstream-backed operation through ctx.http or ctx.stealth and writes __fixtures__/raw.json.

Streaming responses are recorded as evidence (status, selected headers, full-body SHA-256 and byte
count, plus a ${STREAM_PREVIEW_BYTES}-byte base64 preview). Test replay is evidence-only: ctx.http.stream exposes the
preview as its body and the original body_sha256/body_bytes as response metadata.
When an operation opens multiple streams, all evidence records are saved in stream call order.
Mixed JSON/stream operations save a tagged call-ordered envelope so snapshot replay can route each response.
ctx.http.sse() recording is unsupported and fails explicitly.

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
		const parsedParams = parseParams(operation, args.params);

		const capture = createCaptureContext(
			provider,
			resolveOperationBaseUrl(provider, operationName),
			args.sanitize,
		);

		console.log(`[apifuse record] Calling ${operationName} on ${provider.id}...`);

		let result: unknown;
		try {
			result = await executeOperation(provider, operationName, capture.ctx, parsedParams);
		} catch (operationError) {
			let partial: unknown;
			try {
				partial = await capture.getCapturedRaw();
			} catch (finalizationError) {
				throw new StreamRecorderError("Operation and stream finalization both failed.", [
					operationError,
					finalizationError,
				]);
			}
			const streamCount = findStreamEvidenceRecords(partial).length;
			if (streamCount > 0) {
				throw new StreamRecorderError(
					`Operation failed after finalizing ${streamCount} stream capture${streamCount === 1 ? "" : "s"}.`,
					[operationError],
				);
			}
			throw operationError;
		}
		const captured = await capture.getCapturedRaw();

		if (captured === undefined) {
			throw new Error(`No upstream response was captured for ${provider.id}.${operationName}.`);
		}

		const rawPayload = jsonFixtureValue(captured);
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

class StreamRecorderError extends Error {
	readonly diagnosticCauses: readonly unknown[];

	constructor(message: string, diagnosticCauses: readonly unknown[]) {
		super(message, { cause: diagnosticCauses[0] });
		this.name = "StreamRecorderError";
		this.diagnosticCauses = diagnosticCauses;
	}
}

export function formatCliError(error: unknown): string {
	if (error instanceof StreamRecorderError) {
		return [
			sanitizeDiagnosticText(error.message),
			...error.diagnosticCauses.map((cause) => `cause=${formatDiagnosticCause(cause)}`),
		].join(" ");
	}
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
		if (/^Stream capture\b/.test(error.message) && error.cause !== undefined) {
			return `${sanitizeDiagnosticText(error.message)} cause=${formatDiagnosticCause(error.cause)}`;
		}
		return error.message;
	}

	return String(error);
}

function formatDiagnosticCause(cause: unknown): string {
	if (cause instanceof StreamRecorderError) {
		return [
			sanitizeDiagnosticText(cause.message),
			...cause.diagnosticCauses.map((nested) => `cause=${formatDiagnosticCause(nested)}`),
		].join(" ");
	}
	if (!(cause instanceof Error)) return sanitizeDiagnosticText(String(cause));
	const code =
		"code" in cause && typeof cause.code === "string"
			? ` code=${sanitizeDiagnosticText(cause.code)}`
			: "";
	const nestedCause =
		cause.cause === undefined ? "" : ` cause=${formatDiagnosticCause(cause.cause)}`;
	return `${sanitizeDiagnosticText(cause.message)}${code}${nestedCause}`;
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

	return operation.input
		? (operation.input as { parse(value: unknown): unknown }).parse(parsed)
		: parsed;
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
	let nextStreamOrdinal = 0;
	let capturedRaw: JsonValue | undefined;
	const rawCaptures: Array<{ order: number; value: JsonValue }> = [];
	const streamCaptures: Array<{
		order: number;
		request: StreamEvidenceRequest;
		capture: StreamEvidenceCapture;
	}> = [];
	let capturedSse: { order: number; method: string; path: string } | undefined;
	const reserveCaptureOrder = () => {
		nextCaptureOrder += 1;
		return nextCaptureOrder;
	};
	const retainRawCapture = (order: number, value: unknown) => {
		const json = jsonFixtureValue(value);
		const retained = sanitize ? sanitizeOrdinaryFixture(json) : json;
		capturedRaw = retained;
		rawCaptures.push({ order, value: retained });
	};

	const http = captureHttpClient(createHttpClient(baseUrl), {
		reserveOrder: reserveCaptureOrder,
		reserveStreamOrdinal: () => {
			nextStreamOrdinal += 1;
			return nextStreamOrdinal;
		},
		onResponse: (order, response) => retainRawCapture(order, response.data),
		onStreamResponse: (order, ordinal, requestUrl, method, response) => {
			const resolvedRequestUrl = new URL(requestUrl, baseUrl).toString();
			const request = {
				ordinal,
				method,
				path: requestPathForFixture(resolvedRequestUrl),
			};
			const capture = captureStreamEvidence(response, {
				requestUrl: resolvedRequestUrl,
				request,
				...(sanitize ? { sanitizeFixture } : {}),
			});
			streamCaptures.push({ order, request, capture });
			return capture.response;
		},
		onSseResponse: (order, requestUrl, method) => {
			capturedSse = {
				order,
				method,
				path: requestPathForFixture(new URL(requestUrl, baseUrl).toString()),
			};
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
		getCapturedRaw: async () => {
			if (streamCaptures.length === 0) {
				if (capturedSse) throw unsupportedSseCaptureError(capturedSse);
				return capturedRaw;
			}

			const settled = await Promise.allSettled(
				streamCaptures.map(async ({ order, request, capture }) => ({
					order,
					request,
					value: await capture.getEvidence(),
				})),
			);
			const failures = settled.flatMap((result, index) =>
				result.status === "rejected"
					? [
							new StreamRecorderError(
								`Stream finalization failed: method=${streamCaptures[index]!.request.method} path=${streamCaptures[index]!.request.path} ordinal=${streamCaptures[index]!.request.ordinal}.`,
								[result.reason],
							),
						]
					: [],
			);
			if (failures.length > 0) {
				throw new StreamRecorderError(
					`${failures.length} stream capture${failures.length === 1 ? "" : "s"} failed to finalize.`,
					failures,
				);
			}
			const evidence = settled.flatMap((result) =>
				result.status === "fulfilled" ? [result.value] : [],
			);
			if (capturedSse) throw unsupportedSseCaptureError(capturedSse);
			const timeline: StreamCaptureGroupItem[] = [...rawCaptures, ...evidence]
				.sort((left, right) => left.order - right.order)
				.map((item) =>
					"request" in item
						? { kind: "stream" as const, evidence: item.value }
						: { kind: "response" as const, value: item.value },
				);
			return createStreamCaptureEnvelope(timeline);
		},
	};
}

type HttpCaptureCallbacks = {
	reserveOrder(): number;
	reserveStreamOrdinal(): number;
	onResponse(order: number, response: HttpResponse): void;
	onStreamResponse(
		order: number,
		ordinal: number,
		requestUrl: string,
		method: string,
		response: HttpStreamResponse,
	): HttpStreamResponse;
	onSseResponse(order: number, requestUrl: string, method: string): void;
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
			const ordinal = callbacks.reserveStreamOrdinal();
			const method = (args[1]?.method ?? "GET").toUpperCase();
			const response = await client.stream(...args);
			return callbacks.onStreamResponse(order, ordinal, args[0], method, response);
		},
		sse: async (...args: Parameters<HttpClient["sse"]>) => {
			const order = callbacks.reserveOrder();
			const response = await client.sse(...args);
			callbacks.onSseResponse(order, args[0], (args[1]?.method ?? "GET").toUpperCase());
			return response;
		},
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
		close: () => session.close(),
	} as StealthSession;
}

function normalizeCapturedStealthResponse(response: Awaited<ReturnType<StealthClient["fetch"]>>) {
	try {
		return JSON.parse(response.body);
	} catch {
		return response.body;
	}
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

	if (hasStreamEvidenceMarker(existing)) {
		const evidence = parseStreamEvidenceRecord(existing);
		return [createStreamCaptureEnvelope([{ kind: "stream", evidence }]), payload];
	}
	if (Array.isArray(existing)) {
		if (existing.some((item) => hasStreamEvidenceMarker(item))) {
			const legacyGroup = findStreamCaptureGroup(existing);
			if (legacyGroup) {
				return [createStreamCaptureEnvelope(legacyGroup.items), payload];
			}
		}
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

function jsonFixtureValue(value: unknown): JsonValue {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new Error("Captured upstream response is not JSON-serializable.");
	}
	return JSON.parse(serialized) as JsonValue;
}

function unsupportedSseCaptureError(request: {
	order: number;
	method: string;
	path: string;
}): Error {
	return new Error(
		`apifuse record does not support ctx.http.sse(): method=${request.method} path=${request.path} call=${request.order}.`,
	);
}

if (import.meta.main) {
	await main();
}
