#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	createBypassProviderCache,
	createHttpClient,
	createOcrClientFromEnv,
	createProviderChoiceContext,
	createSttClientFromEnv,
	createUnsupportedResolverClient,
	executeOperation,
	type HttpClient,
	type HttpResponse,
	type HttpStreamResponse,
	type ProviderContext,
	type ProviderDefinition,
	ProviderError,
	type ProviderProxyPolicy,
	type RequestOptions,
	type StealthClient,
	TransportError,
	ValidationError,
} from "../src/index.js";
import type { JsonValue } from "../src/contract-json.js";
import {
	isSensitiveFixtureKey,
	requestPathForFixture,
	sanitizeDiagnosticText,
	sanitizeFixtureString,
} from "../src/fixture-sanitization.js";
import { createResolverClientFromEnv } from "../src/runtime/resolver.js";
import {
	isSensitiveKey,
	normalizeSensitiveParams,
	parseHttpRequestInvocation,
	REDACTED_QUERY_VALUE,
	redactSensitiveError,
	redactSensitiveText,
	redactUrlQueryParams,
	replaceRequestOptionsInHttpInvocation,
	requestOptionsFromHttpInvocation,
	serializeRequestUrl,
} from "../src/runtime/request-options.js";
import { createMemoryProviderRuntimeState } from "../src/runtime/state.js";
import { createStealthClient } from "../src/runtime/stealth.js";
import { parseSchema } from "../src/schema.js";
import { getStealthProfile } from "../src/stealth/profiles.js";
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

type MutableRecord = Record<string, unknown>;

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
  --no-sanitize            disable common-field redaction (sensitiveParams are always redacted)
  --help, -h               show this help

Example:
  apifuse record providers/korea-air-quality --operation realtime --params '{"stationName":"jongno"}'`;

export async function main() {
	let capture: ReturnType<typeof createCaptureContext> | undefined;
	try {
		const args = parseArgs(normalizeArgs(process.argv.slice(2)));
		const location = resolveProviderLocation(args.providerPath);
		const provider = await loadProvider(location.rootDir);
		const operationName = resolveOperationName(provider, args.operation);
		const operation = provider.operations[operationName];
		const parsedParams = await parseParams(operation, args.params);

		capture = createCaptureContext(
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

		const sensitiveParams = capture.getCapturedSensitiveParams();
		const rawPayload = jsonFixtureValue(captured);
		const fixturePath = resolve(location.rootDir, "__fixtures__", "raw.json");
		const redactedCapture = redactFixture(rawPayload, sensitiveParams, args.sanitize);
		const mergedPayload = await prepareFixturePayload(fixturePath, redactedCapture, args.append);
		// Mandatory query-secret redaction applies to the merged history, including
		// values discovered in older declared-key URL positions. Optional common-
		// field sanitization applies only to this run's new capture so --append does
		// not rewrite deliberately preserved historical fields.
		const historicalSensitiveParams = discoverSensitiveQueryValues(mergedPayload, sensitiveParams);
		const nextPayload = redactFixture(mergedPayload, historicalSensitiveParams, false);

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
		handleCliError(error, capture?.getCapturedSensitiveParams().values);
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

function handleCliError(error: unknown, sensitiveValues: readonly string[] = []): never {
	const message = redactSensitiveText(formatCliError(error), sensitiveValues);
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

	return operation.input ? parseSchema(operation.input, parsed, "record.params") : parsed;
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

function resolveNativeProxyPolicy(provider: ProviderDefinition): ProviderProxyPolicy | undefined {
	if (typeof provider.proxy === "object") return provider.proxy;
	if (provider.proxy === true) return { mode: "optional" };
	if (provider.proxy === false) return { mode: "disabled" };
	return undefined;
}

export function createCaptureContext(
	provider: ProviderRuntime,
	baseUrl: string,
	sanitize: boolean,
) {
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
	const sensitiveParamNames = new Set<string>();
	const sensitiveParamValues = new Set<string>();
	const captureSensitiveParams = (url: string, options?: RequestOptions) => {
		captureSensitiveRequestValues(url, options, sensitiveParamNames, sensitiveParamValues);
	};
	const getCapturedSensitiveParams = (): CapturedSensitiveParams => ({
		names: [...sensitiveParamNames],
		values: [...sensitiveParamValues],
	});
	const reserveCaptureOrder = () => {
		nextCaptureOrder += 1;
		return nextCaptureOrder;
	};
	const retainRawCapture = (order: number, value: unknown) => {
		const json = jsonFixtureValue(value);
		capturedRaw = json;
		rawCaptures.push({ order, value: json });
	};

	const http = captureHttpClient(createHttpClient(baseUrl), {
		reserveOrder: reserveCaptureOrder,
		reserveStreamOrdinal: () => {
			nextStreamOrdinal += 1;
			return nextStreamOrdinal;
		},
		onSensitiveParams: captureSensitiveParams,
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
				...(sanitize
					? {
							sanitizeFixture: (value: JsonValue) =>
								jsonFixtureValue(sanitizeStreamFixture(value, getCapturedSensitiveParams())),
						}
					: {}),
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
		createStealthClient(baseUrl, {
			...(provider.stealth ? { stealth: provider.stealth } : {}),
		}),
		captureSensitiveParams,
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
	const cache = createBypassProviderCache({ providerId: provider.id });
	const proxyPolicy = resolveNativeProxyPolicy(provider);
	const stealthProfile = provider.stealth ? getStealthProfile(provider.stealth) : undefined;
	const ctx: ProviderContext = {
		env,
		credential,
		request: { headers: {} },
		http,
		cache,
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
		ocr: createOcrClientFromEnv(provider.ocr),
		stt: createSttClientFromEnv(provider.stt),
		resolver: provider.resolver
			? createResolverClientFromEnv(provider.resolver, undefined, {
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
			env,
			request: { headers: {} },
			credential,
			state,
		}),
	} satisfies Omit<ProviderContext, "native"> as unknown as ProviderContext;

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
					value: redactStreamEvidence(await capture.getEvidence(), getCapturedSensitiveParams()),
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
		getCapturedSensitiveParams,
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
		serializedUrl = serializeRequestUrl(absoluteUrl, options?.params, sensitiveParams);
	} catch (error) {
		const structural = redactUrlQueryParams(String(url), [...names]);
		const safeUrl = redactSensitiveText(structural.redactedUrl, [
			...values,
			...structural.sensitiveValues,
		]);
		const causeKind = error instanceof Error ? error.name : typeof error;
		throw new TypeError(`Cannot securely record sensitiveParams for "${safeUrl}" (${causeKind}).`, {
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

type HttpCaptureCallbacks = {
	reserveOrder(): number;
	reserveStreamOrdinal(): number;
	onSensitiveParams(url: string, options?: RequestOptions): void;
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
	const captureRequestOptions = (method: PropertyKey, args: unknown[]) => {
		const invocation = parseHttpRequestInvocation(method, args);
		const options = invocation ? requestOptionsFromHttpInvocation(invocation) : undefined;
		if (!invocation || !options) return;
		const snapshot = snapshotRequestOptions(options);
		callbacks.onSensitiveParams(String(args[0]), snapshot);
		replaceRequestOptionsInHttpInvocation(invocation, snapshot);
	};

	return {
		request: (...args: Parameters<HttpClient["request"]>) => {
			captureRequestOptions("request", args);
			return captureResponse(callbacks.reserveOrder(), client.request(...args));
		},
		get: (...args: Parameters<HttpClient["get"]>) => {
			captureRequestOptions("get", args);
			return captureResponse(callbacks.reserveOrder(), client.get(...args));
		},
		post: (...args: Parameters<HttpClient["post"]>) => {
			captureRequestOptions("post", args);
			return captureResponse(callbacks.reserveOrder(), client.post(...args));
		},
		put: (...args: Parameters<HttpClient["put"]>) => {
			captureRequestOptions("put", args);
			return captureResponse(callbacks.reserveOrder(), client.put(...args));
		},
		delete: (...args: Parameters<HttpClient["delete"]>) => {
			captureRequestOptions("delete", args);
			return captureResponse(callbacks.reserveOrder(), client.delete(...args));
		},
		stream: async (...args: Parameters<HttpClient["stream"]>) => {
			captureRequestOptions("stream", args);
			const order = callbacks.reserveOrder();
			const ordinal = callbacks.reserveStreamOrdinal();
			const method = (args[1]?.method ?? "GET").toUpperCase();
			const response = await client.stream(...args);
			return callbacks.onStreamResponse(order, ordinal, args[0], method, response);
		},
		sse: async (...args: Parameters<HttpClient["sse"]>) => {
			captureRequestOptions("sse", args);
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
	onSensitiveParams: (url: string, options?: RequestOptions) => void,
	onResponse: (order: number, response: Awaited<ReturnType<StealthClient["fetch"]>>) => void,
	reserveOrder: () => number,
): StealthClient {
	return {
		fetch: async (...args: Parameters<StealthClient["fetch"]>) => {
			const order = reserveOrder();
			if (args[1]) args[1] = snapshotRequestOptions(args[1]);
			onSensitiveParams(args[0], args[1]);
			const response = await client.fetch(...args);
			if (response.url) onSensitiveParams(response.url, args[1]);
			onResponse(order, response);
			return response;
		},
		createSession: (...args: Parameters<StealthClient["createSession"]>) =>
			proxyStealthSession(
				client.createSession(...args),
				onSensitiveParams,
				onResponse,
				reserveOrder,
			),
	};
}

function proxyStealthSession(
	session: StealthSession,
	onSensitiveParams: (url: string, options?: RequestOptions) => void,
	onResponse: (order: number, response: Awaited<ReturnType<StealthClient["fetch"]>>) => void,
	reserveOrder: () => number,
): StealthSession {
	return {
		fetch: async (...args: Parameters<StealthSession["fetch"]>) => {
			const order = reserveOrder();
			if (args[1]) args[1] = snapshotRequestOptions(args[1]);
			onSensitiveParams(args[0], args[1]);
			const response = await session.fetch(...args);
			if (response.url) onSensitiveParams(response.url, args[1]);
			onResponse(order, response);
			return response;
		},
		cookies: session.cookies,
		redirects: {
			run: async (...args: Parameters<StealthSession["redirects"]["run"]>) => {
				const order = reserveOrder();
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
				if (result.final.url) onSensitiveParams(result.final.url, args[0]);
				onResponse(order, result.final);
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

function redactStreamEvidence(
	evidence: Awaited<ReturnType<StreamEvidenceCapture["getEvidence"]>>,
	sensitiveParams: CapturedSensitiveParams,
): Awaited<ReturnType<StreamEvidenceCapture["getEvidence"]>> {
	return parseStreamEvidenceRecord(redactFixture(evidence, sensitiveParams, false));
}

function sanitizeStreamFixture(value: unknown, sensitiveParams: CapturedSensitiveParams): unknown {
	if (typeof value === "string") {
		if (value !== "" && sensitiveParams.values.includes(value)) return REDACTED_QUERY_VALUE;
		return sanitizeFixtureString(redactFixtureText(value, sensitiveParams));
	}
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeStreamFixture(item, sensitiveParams));
	}
	if (!value || typeof value !== "object") {
		return redactFixture(value, sensitiveParams, false);
	}

	const result: MutableRecord = Object.create(null) as MutableRecord;
	for (const [key, entryValue] of Object.entries(value as MutableRecord)) {
		const redactedKey = sensitiveParams.values.includes(key)
			? REDACTED_QUERY_VALUE
			: redactFixtureText(key, sensitiveParams);
		const uniqueKey = collisionSafeKey(result, redactedKey);
		result[uniqueKey] =
			isSensitiveFixtureKey(key) && !sensitiveParams.names.includes(key)
				? REDACTED_QUERY_VALUE
				: sanitizeStreamFixture(entryValue, sensitiveParams);
	}
	return result;
}

function redactStreamPreview(
	bodyPreviewBase64: string,
	sensitiveParams: CapturedSensitiveParams,
): { bodyPreviewBase64: string; changed: boolean } {
	const preview = Buffer.from(bodyPreviewBase64, "base64");
	if (preview.byteLength === 0) return { bodyPreviewBase64, changed: false };

	const text = new TextDecoder().decode(preview);
	let redactedText = redactFixtureText(text, sensitiveParams);
	const trimmed = text.trimEnd();
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		const structurallyRedacted = JSON.stringify(redactFixture(parsed, sensitiveParams, false));
		if (structurallyRedacted !== JSON.stringify(parsed)) redactedText = structurallyRedacted;
	} catch {
		// Non-JSON previews still use the shared free-text sensitive-value policy.
	}
	if (redactedText === text) return { bodyPreviewBase64, changed: false };

	const fitted = Buffer.alloc(preview.byteLength, 0x20);
	let redactedBytes = Buffer.from(redactedText);
	if (redactedBytes.byteLength > fitted.byteLength) {
		redactedBytes = Buffer.from(REDACTED_QUERY_VALUE);
	}
	redactedBytes.copy(fitted, 0, 0, Math.min(redactedBytes.byteLength, fitted.byteLength));
	return { bodyPreviewBase64: fitted.toString("base64"), changed: true };
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
			sanitizeCommonFields &&
			(isSensitiveKey(key) || isSensitiveFixtureKey(key)) &&
			!sensitiveParams.names.includes(key)
				? REDACTED_QUERY_VALUE
				: redactFixture(entryValue, sensitiveParams, sanitizeCommonFields);
	}
	const record = value as MutableRecord;
	if (record.__apifuse_stream__ === true && typeof record.body_preview_base64 === "string") {
		const preview = redactStreamPreview(record.body_preview_base64, sensitiveParams);
		result.body_preview_base64 = preview.bodyPreviewBase64;
		if (preview.changed) result.preview_sanitized = true;
	}
	return result;
}

function redactFixtureText(text: string, sensitiveParams: CapturedSensitiveParams): string {
	// Shared free-text policy: long values are unconditional substrings; values
	// shorter than four characters require token boundaries. Exact scalar echoes
	// and declared query-key positions are structurally redacted for every length.
	let redacted = redactSensitiveText(text, sensitiveParams.values);
	for (const name of sensitiveParams.names) {
		let componentEncodedName = name;
		try {
			componentEncodedName = encodeURIComponent(name);
		} catch {
			// Lone surrogates remain covered by the raw and form-encoded variants.
		}
		const keyVariants = new Set([
			name,
			componentEncodedName,
			new URLSearchParams({ [name]: "" }).toString().slice(0, -1),
		]);
		for (const key of keyVariants) {
			const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const queryValue = new RegExp(`(^|[?&])(${escapedKey}=)[^&#\\s"]*`, "g");
			redacted = redacted.replace(queryValue, (_match, prefix, assignment) => {
				return `${prefix}${assignment}${REDACTED_QUERY_VALUE}`;
			});
		}
	}
	return redacted;
}

function discoverSensitiveQueryValues(
	value: unknown,
	sensitiveParams: CapturedSensitiveParams,
): CapturedSensitiveParams {
	const values = new Set(sensitiveParams.values);
	const absoluteUrl = /\b[A-Za-z][A-Za-z\d+.-]*:\/\/[^\s<>"']+/g;
	const discoverFromUrl = (url: string) => {
		for (const discovered of redactUrlQueryParams(url, sensitiveParams.names).sensitiveValues) {
			if (discovered !== "" && discovered !== REDACTED_QUERY_VALUE) values.add(discovered);
		}
	};
	const visitText = (text: string) => {
		if (!/\s/.test(text)) {
			try {
				new URL(text, "http://apifuse.invalid");
				discoverFromUrl(text);
				return;
			} catch {
				// Fall through to extracting absolute URL spans from prose.
			}
		}
		for (const match of text.matchAll(absoluteUrl)) {
			try {
				new URL(match[0]);
				discoverFromUrl(match[0]);
			} catch {
				// Ignore URI-like prose that is not a parseable URL.
			}
		}
	};
	const visit = (current: unknown): void => {
		if (typeof current === "string") {
			visitText(current);
			return;
		}
		if (Array.isArray(current)) {
			for (const item of current) visit(item);
			return;
		}
		if (!current || typeof current !== "object") return;
		for (const [key, entryValue] of Object.entries(current as MutableRecord)) {
			visitText(key);
			visit(entryValue);
		}
	};
	visit(value);
	return { names: sensitiveParams.names, values: [...values] };
}

function collisionSafeKey(record: MutableRecord, preferredKey: string): string {
	if (!(preferredKey in record)) return preferredKey;
	let suffix = 2;
	while (`${preferredKey}#${suffix}` in record) suffix += 1;
	return `${preferredKey}#${suffix}`;
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
				const prefix = existing.slice(0, -legacyGroup.items.length);
				return [...prefix, createStreamCaptureEnvelope(legacyGroup.items), payload];
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
