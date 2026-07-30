import { describe, expect, it } from "bun:test";

import { createProviderCache } from "../runtime/cache.js";
import { createTestProviderChoiceContext } from "../runtime/choice.js";
import { createMemoryProviderRuntimeState } from "../runtime/state.js";
import { createUnsupportedSttClient } from "../runtime/stt.js";
import { safeParseSchemaSync } from "../schema.js";
import { requestPathForFixture } from "../fixture-sanitization.js";
import { findStreamCaptureGroup, replayStreamEvidence } from "../stream-evidence.js";
import type {
	AuthMode,
	BrowserPage,
	CredentialContext,
	HttpResponse,
	NativeNetworkConnection,
	ProviderContext,
	ProviderDefinition,
	StealthCookieStoreV1,
	StealthResponse,
} from "../types.js";

// Mirrors CONNECTOR_ID_REGEX in ../define.ts, which defineProvider() enforces.
// A single lowercase segment (no hyphen) is a valid id, so the trailing group
// is optional (`*`), matching providers like `kakaomap`, `kstartup`, `triple`.
const CONNECTOR_ID_REGEX = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/;
const VALID_AUTH_MODES = ["none", "platform-managed", "credentials", "oauth2"] as const;
const UPDATE_SNAPSHOT_ARGS = new Set(["-u", "--update-snapshots"]);

export interface StandardTestsManifest {
	id?: string;
	displayName?: string;
	category?: string;
	version?: string;
	runtime?: ProviderDefinition["runtime"];
	sdkVersion?: number;
	auth?: AuthMode;
	language?: string;
	signature?: string;
	signatureUri?: string;
}

export interface StandardTestsOptions {
	/** Validate operation request/response fixtures and JSON raw fixture shape. */
	validateFixture?: boolean;
	/** Write/read __fixtures__/transform.snap.json for handler(raw fixture) output. */
	snapshot?: boolean;
	/** Opt-in integration-only manifest signature assertion. */
	verifyManifest?: boolean;
	/** Opt-in auth mode/operation consistency assertion. */
	validateAuthMode?: boolean;
	/** Override inferred __fixtures__ directory for tests generated outside providers/<id>. */
	fixtureDir?: string;
	/** Opt in to real-handler E2E with strict, offline canned upstream responses. */
	upstreamStub?: StandardTestsUpstreamStub;
}

export interface StandardTestsUpstreamCall {
	/** Operation whose real handler initiated the call. */
	operationName: string;
	/** ProviderContext transport surface used by the handler. */
	transport: "http" | "stealth" | "browser" | "native";
	method: string;
	url?: string;
	body?: unknown;
	options?: unknown;
}

export interface StandardTestsUpstreamResponse {
	status?: number;
	headers?: Readonly<Record<string, string>>;
	/** JSON-compatible values are encoded as JSON; strings and bytes are preserved. */
	body?: unknown;
}

export type StandardTestsUpstreamStub = (
	call: StandardTestsUpstreamCall,
) =>
	| Response
	| StandardTestsUpstreamResponse
	| undefined
	| Promise<Response | StandardTestsUpstreamResponse | undefined>;

export interface StandardTestsResult {
	warnings: readonly string[];
}

interface FixtureEnvelope {
	request?: unknown;
	response?: unknown;
}

function isFixtureEnvelope(value: unknown): value is FixtureEnvelope {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		("request" in value || "response" in value)
	);
}

function isJsonCompatible(value: unknown): boolean {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return Number.isFinite(value) || typeof value !== "number";
	}

	if (Array.isArray(value)) {
		return value.every(isJsonCompatible);
	}

	if (typeof value === "object" && value !== null) {
		return Object.values(value).every(isJsonCompatible);
	}

	return false;
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortJson);
	}

	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, sortJson(entry)]),
		);
	}

	return value;
}

function stableStringify(value: unknown): string {
	return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function shouldUpdateSnapshots(): boolean {
	return process.argv.some((arg) => UPDATE_SNAPSHOT_ARGS.has(arg));
}

function inferFixtureDir(providerId: string): string {
	const stack = new Error().stack ?? "";
	const testFile = stack
		.split("\n")
		.map((line) => line.match(/\(?((?:file:\/\/)?[^():]+\.test\.ts)/)?.[1])
		.find((file) => file !== undefined);

	if (testFile) {
		const pathname = testFile.startsWith("file://") ? new URL(testFile).pathname : testFile;
		return `${pathname.replace(/\/[^/]+$/, "")}/../__fixtures__`;
	}

	return `providers/${providerId}/__fixtures__`;
}

function jsonResponse(data: unknown): HttpResponse {
	const body = JSON.stringify(data);
	const bodyBytes = new TextEncoder().encode(body);
	return {
		status: 200,
		ok: true,
		headers: {},
		data,
		json: async <_T = unknown>() => JSON.parse(JSON.stringify(data)),
		text: async () => body,
		arrayBuffer: async () =>
			bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength),
		bytes: async () => bodyBytes.slice(0),
	};
}

interface NormalizedUpstreamResponse {
	status: number;
	headers: Record<string, string>;
	data: unknown;
	text: string;
	bytes: Uint8Array;
}

function headersToRecord(headers: Headers): Record<string, string> {
	return Object.fromEntries(headers.entries());
}

async function normalizeUpstreamResponse(
	response: Response | StandardTestsUpstreamResponse,
): Promise<NormalizedUpstreamResponse> {
	if (response instanceof Response) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		const text = new TextDecoder().decode(bytes);
		const headers = headersToRecord(response.headers);
		let data: unknown = text;
		if (response.headers.get("content-type")?.includes("application/json")) {
			data = text.length > 0 ? JSON.parse(text) : null;
		}
		return { status: response.status, headers, data, text, bytes };
	}

	const headers = { ...(response.headers ?? {}) };
	const body = response.body ?? null;
	let bytes: Uint8Array;
	let text: string;
	let data: unknown;
	if (body instanceof Uint8Array) {
		bytes = body.slice(0);
		text = new TextDecoder().decode(bytes);
		data = text;
	} else if (body instanceof ArrayBuffer) {
		bytes = new Uint8Array(body.slice(0));
		text = new TextDecoder().decode(bytes);
		data = text;
	} else if (typeof body === "string") {
		text = body;
		bytes = new TextEncoder().encode(text);
		data = body;
	} else {
		text = JSON.stringify(body);
		bytes = new TextEncoder().encode(text);
		data = body;
		if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
			headers["content-type"] = "application/json";
		}
	}
	return { status: response.status ?? 200, headers, data, text, bytes };
}

function toHttpResponse(response: NormalizedUpstreamResponse): HttpResponse {
	return {
		status: response.status,
		ok: response.status >= 200 && response.status < 300,
		headers: response.headers,
		data: response.data,
		json: async <T = unknown>() => JSON.parse(response.text) as T,
		text: async () => response.text,
		arrayBuffer: async () => response.bytes.slice(0).buffer,
		bytes: async () => response.bytes.slice(0),
	};
}

const emptyCookieJar = {
	get: () => undefined,
	getAll: () => ({}),
	toString: () => "",
};

function emptyCookieStore(): StealthCookieStoreV1 {
	return {
		version: 1,
		jar: { cookies: [] } as unknown as StealthCookieStoreV1["jar"],
	};
}

function toStealthResponse(response: NormalizedUpstreamResponse, url?: string): StealthResponse {
	return {
		status: response.status,
		ok: response.status >= 200 && response.status < 300,
		url,
		redirected: false,
		headers: response.headers,
		rawHeaders: Object.entries(response.headers),
		body: response.text,
		cookies: emptyCookieJar,
		json: async <T>() => JSON.parse(response.text) as T,
		arrayBuffer: async () => response.bytes.slice(0).buffer,
		bytes: async () => response.bytes.slice(0),
	};
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes.slice(0));
			controller.close();
		},
	});
}

async function* singleBytes(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	yield bytes.slice(0);
}

async function* singleText(textValue: string): AsyncIterable<string> {
	yield textValue;
}

function createUpstreamContext(
	provider: ProviderDefinition,
	operationName: string,
	upstreamStub: StandardTestsUpstreamStub,
): ProviderContext {
	const credential: CredentialContext = {
		mode: "none",
		get: () => undefined,
		getAll: () => ({}),
		getAccessToken: () => undefined,
		getScopes: () => [],
	};
	const request = { headers: {} };
	const state = createMemoryProviderRuntimeState();
	const dispatch = async (
		call: Omit<StandardTestsUpstreamCall, "operationName">,
	): Promise<NormalizedUpstreamResponse> => {
		const canned = await upstreamStub({ operationName, ...call });
		if (canned === undefined) {
			throw new Error(
				`Unmatched upstream call for operation "${operationName}": ${call.transport}.${call.method}${call.url ? ` ${call.url}` : ""}. Add a canned response to upstreamStub; live network passthrough is disabled.`,
			);
		}
		return normalizeUpstreamResponse(canned);
	};
	const httpCall = async (
		method: string,
		url: string,
		body?: unknown,
		options?: unknown,
	): Promise<HttpResponse> =>
		toHttpResponse(await dispatch({ transport: "http", method, url, body, options }));
	const stealthCall = async (url: string, options?: { method?: string; body?: unknown }) =>
		toStealthResponse(
			await dispatch({
				transport: "stealth",
				method: options?.method?.toUpperCase() ?? "GET",
				url,
				body: options?.body,
				options,
			}),
			url,
		);

	const createBrowserPage = (): BrowserPage => {
		let currentUrl = "about:blank";
		let currentResponse: NormalizedUpstreamResponse | undefined;
		const browserAction = async (method: string, body?: unknown) => {
			currentResponse = await dispatch({
				transport: "browser",
				method,
				url: currentUrl,
				body,
			});
			return currentResponse;
		};
		const page: BrowserPage = {
			id: `standard-test-${operationName}`,
			url: async () => currentUrl,
			title: async () => currentResponse?.text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "",
			content: async () => currentResponse?.text ?? "",
			evaluate: async <T>(fn: string | (() => T)) =>
				(await browserAction("evaluate", typeof fn === "string" ? fn : String(fn))).data as T,
			locator: (selector) => ({
				click: async () => {
					await browserAction("locator.click", { selector });
				},
				fill: async (textValue) => {
					await browserAction("locator.fill", { selector, text: textValue });
				},
				textContent: async () => {
					const value = (await browserAction("locator.textContent", { selector })).data;
					return value === null || value === undefined ? null : String(value);
				},
				waitFor: async (options) => {
					await browserAction("locator.waitFor", { selector, options });
				},
			}),
			close: async () => {},
			fill: async (selector, textValue) => {
				await browserAction("fill", { selector, text: textValue });
			},
			goto: async (url) => {
				currentUrl = url;
				await browserAction("goto");
			},
			screenshot: async (options) =>
				Buffer.from((await browserAction("screenshot", options)).bytes),
			click: async (selector) => {
				await browserAction("click", { selector });
			},
			type: async (selector, textValue) => {
				await browserAction("type", { selector, text: textValue });
			},
			waitForSelector: async (selector, options) => {
				await browserAction("waitForSelector", { selector, options });
			},
			frames: async () => [page],
			withResourcePolicy: async (_policy, run) => run(),
		};
		return page;
	};

	const createStealthSession = (): ReturnType<ProviderContext["stealth"]["createSession"]> => ({
		fetch: stealthCall,
		cookies: {
			...emptyCookieJar,
			has: () => false,
			setFromCookieStrings: () => {},
			toHeader: () => "",
			snapshot: () => ({}),
			restore: () => {},
			serialize: emptyCookieStore,
			deserialize: () => {},
			clear: () => {},
		},
		redirects: {
			run: async (options) => {
				const final = await stealthCall(options.url, options);
				return {
					final,
					hops: [],
					reason: "completed",
					cookies: {},
					cookieStore: emptyCookieStore(),
				};
			},
		},
		close: () => {},
	});

	return {
		env: { get: () => undefined },
		credential,
		request,
		http: {
			request: (url, options) =>
				httpCall(options?.method?.toUpperCase() ?? "GET", url, options?.body, options),
			get: (url, options) => httpCall("GET", url, undefined, options),
			post: (url, body, options) => httpCall("POST", url, body, options),
			put: (url, body, options) => httpCall("PUT", url, body, options),
			delete: (url, options) => httpCall("DELETE", url, undefined, options),
			stream: async (url, options) => {
				const response = await dispatch({
					transport: "http",
					method: options?.method?.toUpperCase() ?? "GET",
					url,
					body: options?.body,
					options,
				});
				return {
					status: response.status,
					ok: response.status >= 200 && response.status < 300,
					headers: response.headers,
					body: streamFromBytes(response.bytes),
					bytes: () => singleBytes(response.bytes),
					textChunks: () => singleText(response.text),
					lines: () => singleText(response.text),
				};
			},
			sse: async (url, options) => {
				const response = await dispatch({
					transport: "http",
					method: options?.method?.toUpperCase() ?? "GET",
					url,
					body: options?.body,
					options,
				});
				async function* messages() {
					for (const block of response.text.split(/\r?\n\r?\n/)) {
						const data = block
							.split(/\r?\n/)
							.filter((line) => line.startsWith("data:"))
							.map((line) => line.slice(5).trimStart())
							.join("\n");
						if (!data) continue;
						yield { event: "message", data, json: <T>() => JSON.parse(data) as T };
					}
				}
				return messages();
			},
		},
		cache: createProviderCache({ providerId: `standard-test-${operationName}` }),
		state,
		stealth: {
			fetch: stealthCall,
			createSession: createStealthSession,
		},
		browser: {
			engine: "playwright-stealth",
			newPage: async () => createBrowserPage(),
			rawPage: async () => createBrowserPage(),
			withIsolatedContext: async (handler) => handler(createBrowserPage()),
			solveChallenge: async (challenge) =>
				(
					await dispatch({
						transport: "browser",
						method: "solveChallenge",
						body: challenge,
					})
				).data as Awaited<ReturnType<ProviderContext["browser"]["solveChallenge"]>>,
		},
		...(provider.native
			? {
					native: {
						network: {
							connectTcp: async (options) =>
								createNativeConnection(
									await dispatch({
										transport: "native",
										method: "connectTcp",
										url: `tcp://${options.host}:${options.port}`,
										options,
									}),
									dispatch,
									`tcp://${options.host}:${options.port}`,
								),
							connectTls: async (options) =>
								createNativeConnection(
									await dispatch({
										transport: "native",
										method: "connectTls",
										url: `tls://${options.host}:${options.port}`,
										options,
									}),
									dispatch,
									`tls://${options.host}:${options.port}`,
								),
							grantTcpEgress: () => ({ revoke: () => {} }),
						},
					},
				}
			: {}),
		trace: { span: async (_name, fn) => fn() },
		auth: { requestField: async (name) => unsupported(`ctx.auth.requestField(${name})`) },
		stt: createUnsupportedSttClient(
			"Standard test upstream context does not support ctx.stt.transcribe",
		),
		choice: createTestProviderChoiceContext({
			providerId: `standard-test-${operationName}`,
			request,
			credential,
			state,
		}),
	};
}

function createNativeConnection(
	initialResponse: NormalizedUpstreamResponse,
	dispatch: (
		call: Omit<StandardTestsUpstreamCall, "operationName">,
	) => Promise<NormalizedUpstreamResponse>,
	url: string,
): NativeNetworkConnection {
	let unread = initialResponse.bytes.slice(0);
	return {
		read: async () => {
			if (unread.byteLength === 0) return null;
			const bytes = unread;
			unread = new Uint8Array();
			return bytes;
		},
		write: async (body) => {
			const response = await dispatch({ transport: "native", method: "write", url, body });
			unread = response.bytes.slice(0);
		},
		close: async () => {},
	};
}

function unsupported(name: string): never {
	throw new Error(`Standard test snapshot context does not support ${name}`);
}

export function createSnapshotContext(rawFixture: unknown): ProviderContext {
	const credential: CredentialContext = {
		mode: "none",
		get: () => undefined,
		getAll: () => ({}),
		getAccessToken: () => undefined,
		getScopes: () => [],
	};
	const request = { headers: {} };
	const state = createMemoryProviderRuntimeState();
	const streamCaptureGroup = findStreamCaptureGroup(rawFixture);
	const streamEvidence = (streamCaptureGroup?.items ?? []).flatMap((item) =>
		item.kind === "stream" ? [item.evidence] : [],
	);
	const ordinaryResponses = (streamCaptureGroup?.items ?? []).flatMap((item) =>
		item.kind === "response" ? [item.value] : [],
	);
	let nextStreamResponse = 0;
	let nextOrdinaryResponse = 0;
	const replayJsonResponse = () => {
		if (!streamCaptureGroup) return jsonResponse(rawFixture);
		const response = ordinaryResponses[nextOrdinaryResponse];
		if (response === undefined) return jsonResponse(rawFixture);
		nextOrdinaryResponse += 1;
		return jsonResponse(response);
	};

	return {
		env: { get: () => undefined },
		credential,
		request,
		http: {
			request: async () => replayJsonResponse(),
			get: async () => replayJsonResponse(),
			post: async () => replayJsonResponse(),
			put: async () => replayJsonResponse(),
			delete: async () => replayJsonResponse(),
			stream: async (...args) => {
				const evidence = streamEvidence[nextStreamResponse];
				nextStreamResponse += 1;
				if (!evidence) return unsupported("ctx.http.stream");
				if (evidence.request) {
					const actual = {
						ordinal: nextStreamResponse,
						method: (args[1]?.method ?? "GET").toUpperCase(),
						path: requestPathForFixture(args[0]),
					};
					if (
						actual.ordinal !== evidence.request.ordinal ||
						actual.method !== evidence.request.method ||
						actual.path !== evidence.request.path
					) {
						throw new Error(
							`Stream fixture request mismatch: expected ${evidence.request.method} ${evidence.request.path} (ordinal ${evidence.request.ordinal}), received ${actual.method} ${actual.path} (ordinal ${actual.ordinal}).`,
						);
					}
				}
				return replayStreamEvidence(evidence);
			},
			sse: async () => unsupported("ctx.http.sse"),
		},
		cache: createProviderCache({ providerId: "standard-test" }),
		state,
		stealth: {
			fetch: async () => unsupported("ctx.stealth.fetch"),
			createSession: () => unsupported("ctx.stealth.createSession"),
		},
		browser: {
			engine: "playwright-stealth",
			newPage: async () => unsupported("ctx.browser.newPage"),
			rawPage: async () => unsupported("ctx.browser.rawPage"),
			withIsolatedContext: async () => unsupported("ctx.browser.withIsolatedContext"),
			solveChallenge: async () => unsupported("ctx.browser.solveChallenge"),
		},
		trace: {
			span: async (_name, fn) => fn(),
		},
		auth: {
			requestField: async (name) => unsupported(`ctx.auth.requestField(${name})`),
		},
		stt: createUnsupportedSttClient(
			"Standard test snapshot context does not support ctx.stt.transcribe",
		),
		choice: createTestProviderChoiceContext({
			providerId: "standard-test",
			request,
			credential,
			state,
		}),
	};
}

async function transformSnapshotOutput(
	provider: ProviderDefinition,
	rawFixture: unknown,
): Promise<unknown> {
	const entries = Object.entries(provider.operations);
	const outputs = await Promise.all(
		entries.map(async ([operationName, operation]) => {
			const context = createSnapshotContext(rawFixture);
			const request = operation.fixtures?.request ?? {};
			const output = await operation.handler(context, request);
			return [operationName, output] as const;
		}),
	);

	if (outputs.length === 1) {
		return outputs[0]?.[1];
	}

	return Object.fromEntries(outputs);
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function formatJsonDiff(current: unknown, expected: unknown): string {
	const currentLines = formatJson(current).split("\n");
	const expectedLines = formatJson(expected).split("\n");
	const lineCount = Math.max(currentLines.length, expectedLines.length);
	const lines = ["JSON diff (- current, + expected):"];

	for (let index = 0; index < lineCount; index += 1) {
		const currentLine = currentLines[index];
		const expectedLine = expectedLines[index];

		if (currentLine === expectedLine) {
			if (currentLine !== undefined) {
				lines.push(`  ${currentLine}`);
			}
			continue;
		}

		if (currentLine !== undefined) {
			lines.push(`- ${currentLine}`);
		}
		if (expectedLine !== undefined) {
			lines.push(`+ ${expectedLine}`);
		}
	}

	return lines.join("\n");
}

function expectSchemaFixture(
	operationName: string,
	fieldName: "request" | "response",
	fixture: unknown,
	result: ReturnType<typeof safeParseSchemaSync>,
): void {
	if (result.success) {
		expect(result.success).toBe(true);
		return;
	}

	throw new Error(
		[
			`Fixture ${operationName}.${fieldName} failed schema validation.`,
			formatJsonDiff(
				{ valid: false, value: fixture, error: result.error },
				{ valid: true, value: fixture },
			),
		].join("\n"),
	);
}

function parseSchemaFixture(
	operationName: string,
	fieldName: "request" | "response",
	schema: ProviderDefinition["operations"][string]["input"],
	fixture: unknown,
): void {
	expectSchemaFixture(
		operationName,
		fieldName,
		fixture,
		safeParseSchemaSync(schema, fixture, `operations.${operationName}.fixtures.${fieldName}`),
	);
}

async function materializeHandlerOutput(output: unknown): Promise<unknown> {
	if (!(output instanceof Response)) return output;
	const contentType = output.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) return output.json();
	return output.text();
}

/** Internal execution seam exported for focused SDK tests; use runStandardTests as public API. */
export async function executeStandardTestHandler(
	provider: ProviderDefinition,
	operationName: string,
	upstreamStub: StandardTestsUpstreamStub,
): Promise<unknown> {
	const operation = provider.operations[operationName];
	if (!operation) throw new Error(`Unknown operation "${operationName}".`);
	if (operation.fixtures?.request === undefined) {
		throw new Error(
			`Operation "${operationName}" has no fixtures.request for handler E2E execution.`,
		);
	}
	const context = createUpstreamContext(provider, operationName, upstreamStub);
	const output = await materializeHandlerOutput(
		await operation.handler(context, operation.fixtures.request),
	);
	const result = safeParseSchemaSync(
		operation.output,
		output,
		`operations.${operationName}.handler.output`,
	);
	if (!result.success) {
		throw new Error(
			[
				`Handler output for operation "${operationName}" failed schema validation.`,
				formatJsonDiff(
					{ valid: false, value: output, error: result.error },
					{ valid: true, value: output },
				),
			].join("\n"),
		);
	}
	return output;
}

function isOptionsShortcut(value: unknown): value is StandardTestsOptions {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.hasOwn(value, "upstreamStub")
	);
}

/**
 * Run standard SDK tests for a provider in one line.
 *
 * Usage:
 * import { myProvider } from "../index";
 * import { runStandardTests } from "@apifuse/provider-sdk/testing";
 * runStandardTests(myProvider, rawFixture, manifest, { snapshot: true });
 */
export function runStandardTests(
	provider: ProviderDefinition,
	options: StandardTestsOptions & { upstreamStub: StandardTestsUpstreamStub },
): StandardTestsResult;
export function runStandardTests(
	provider: ProviderDefinition,
	rawFixture?: unknown,
	manifest?: StandardTestsManifest,
	options?: StandardTestsOptions,
): StandardTestsResult;
export function runStandardTests(
	provider: ProviderDefinition,
	rawFixtureOrOptions?: unknown,
	manifest?: StandardTestsManifest,
	legacyOptions?: StandardTestsOptions,
): StandardTestsResult {
	const shortcut =
		manifest === undefined && legacyOptions === undefined && isOptionsShortcut(rawFixtureOrOptions);
	const rawFixture = shortcut ? undefined : rawFixtureOrOptions;
	const options = shortcut ? rawFixtureOrOptions : (legacyOptions ?? {});
	const operations = Object.entries(provider.operations);
	const warnings = options.upstreamStub
		? operations
				.filter(([, operation]) => operation.fixtures?.request === undefined)
				.map(
					([operationName]) =>
						`[provider-sdk] Operation "${provider.id}.${operationName}" has no fixtures.request, so runStandardTests cannot invoke its handler E2E.`,
				)
		: operations.map(
				([operationName]) =>
					`[provider-sdk] Operation "${provider.id}.${operationName}" has no handler E2E coverage in runStandardTests; configure upstreamStub to invoke the real handler.`,
			);
	for (const warning of warnings) console.warn(warning);

	const assertFixtureValidation = (): void => {
		expect(rawFixture).toBeDefined();
		expect(isJsonCompatible(rawFixture)).toBe(true);

		for (const [operationName, op] of operations) {
			if (op.fixtures?.request !== undefined) {
				parseSchemaFixture(operationName, "request", op.input, op.fixtures.request);
			}

			if (op.fixtures?.response !== undefined) {
				parseSchemaFixture(operationName, "response", op.output, op.fixtures.response);
			}

			if (isFixtureEnvelope(rawFixture)) {
				if (rawFixture.request !== undefined) {
					parseSchemaFixture(operationName, "request", op.input, rawFixture.request);
				}

				if (rawFixture.response !== undefined) {
					parseSchemaFixture(operationName, "response", op.output, rawFixture.response);
				}
			}
		}
	};

	const assertManifestSignature = (): void => {
		expect(manifest).toBeDefined();
		expect(Boolean(manifest?.signature ?? manifest?.signatureUri)).toBe(true);
	};

	const assertAuthModeContract = (): void => {
		const authMode = provider.auth?.mode ?? "none";
		expect(VALID_AUTH_MODES).toContain(authMode);

		if (manifest?.auth !== undefined) {
			expect(manifest.auth).toBe(authMode);
		}

		if (authMode === "credentials" || authMode === "oauth2") {
			expect(provider.auth?.flow).toBeTruthy();
			expect(Object.keys(provider.operations).length).toBeGreaterThan(0);
			expect(provider.credential?.keys.length ?? 0).toBeGreaterThan(0);
			return;
		}

		expect(provider.credential?.keys ?? []).toHaveLength(0);
	};

	describe(`[SDK Standard Tests] ${provider.id}`, () => {
		it("id follows kebab-case format", () => {
			expect(CONNECTOR_ID_REGEX.test(provider.id)).toBe(true);
		});

		it("has required meta fields", () => {
			expect(provider.meta.displayName).toBeTruthy();
			expect(provider.meta.category).toBeTruthy();
			expect(provider.version).toBeTruthy();
			expect(["standard", "shared", "browser"]).toContain(provider.runtime);
		});

		it("has at least one operation", () => {
			expect(Object.keys(provider.operations).length).toBeGreaterThan(0);
		});

		it("all operations have handler, input, and output", () => {
			for (const [, op] of operations) {
				expect(op.input).toBeTruthy();
				expect(op.output).toBeTruthy();
				expect(typeof op.handler).toBe("function");
			}
		});

		it("operation schemas can parse fixture data", () => {
			for (const [operationName, op] of operations) {
				if (op.fixtures?.request !== undefined && op.input) {
					parseSchemaFixture(operationName, "request", op.input, op.fixtures.request);
				}

				if (op.fixtures?.response !== undefined && op.output) {
					parseSchemaFixture(operationName, "response", op.output, op.fixtures.response);
				}

				expect(operationName).toBeTruthy();
			}
		});

		it("provider metadata is declared in defineProvider", () => {
			expect(provider.id).toBeTruthy();
			expect(provider.meta.displayName).toBeTruthy();
			expect(provider.meta.category).toBeTruthy();
			expect(provider.version).toBeTruthy();
			expect(VALID_AUTH_MODES).toContain(provider.auth?.mode ?? "none");
		});

		if (options.validateFixture) {
			it("validates raw and declared operation fixtures", () => {
				assertFixtureValidation();
			});
		}

		if (options.verifyManifest) {
			it("verifies manifest signature metadata", () => {
				assertManifestSignature();
			});
		}

		if (options.validateAuthMode) {
			it("validates auth mode contract", () => {
				assertAuthModeContract();
			});
		}

		if (options.snapshot) {
			it("matches transform snapshot", async () => {
				expect(rawFixture).toBeDefined();
				const fixtureDir = options.fixtureDir ?? inferFixtureDir(provider.id);
				const snapshotPath = `${fixtureDir}/transform.snap.json`;
				const actual = await transformSnapshotOutput(provider, rawFixture);
				const serialized = stableStringify(actual);
				const snapshotFile = Bun.file(snapshotPath);

				if (shouldUpdateSnapshots() || !(await snapshotFile.exists())) {
					await Bun.write(snapshotPath, serialized);
				}

				const expected: unknown = JSON.parse(await Bun.file(snapshotPath).text());
				expect(actual).toEqual(expected);
			});
		}

		if (options.upstreamStub) {
			for (const [operationName, operation] of operations) {
				if (operation.fixtures?.request === undefined) continue;
				it(`invokes the real ${operationName} handler with canned upstream responses`, async () => {
					await executeStandardTestHandler(
						provider,
						operationName,
						options.upstreamStub as StandardTestsUpstreamStub,
					);
				});
			}
		}
	});

	return { warnings };
}
