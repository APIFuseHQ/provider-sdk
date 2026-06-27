import { describe, expect, it } from "bun:test";

import { createProviderCache } from "../runtime/cache";
import { createTestProviderChoiceContext } from "../runtime/choice";
import { createMemoryProviderRuntimeState } from "../runtime/state";
import { createUnsupportedSttClient } from "../runtime/stt";
import { safeParseSchemaSync } from "../schema";
import type {
	AuthMode,
	CredentialContext,
	HttpResponse,
	ProviderContext,
	ProviderDefinition,
} from "../types";

// Mirrors CONNECTOR_ID_REGEX in ../define.ts, which defineProvider() enforces.
// A single lowercase segment (no hyphen) is a valid id, so the trailing group
// is optional (`*`), matching providers like `kakaomap`, `kstartup`, `triple`.
const CONNECTOR_ID_REGEX = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/;
const VALID_AUTH_MODES = [
	"none",
	"platform-managed",
	"credentials",
	"oauth2",
] as const;
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
		const pathname = testFile.startsWith("file://")
			? new URL(testFile).pathname
			: testFile;
		return `${pathname.replace(/\/[^/]+$/, "")}/../__fixtures__`;
	}

	return `providers/${providerId}/__fixtures__`;
}

function jsonResponse(data: unknown): HttpResponse {
	return {
		status: 200,
		ok: true,
		headers: {},
		data,
		json: async <_T = unknown>() => JSON.parse(JSON.stringify(data)),
		text: async () => JSON.stringify(data),
	};
}

function unsupported(name: string): never {
	throw new Error(`Standard test snapshot context does not support ${name}`);
}

function createSnapshotContext(rawFixture: unknown): ProviderContext {
	const credential: CredentialContext = {
		mode: "none",
		get: () => undefined,
		getAll: () => ({}),
		getAccessToken: () => undefined,
		getScopes: () => [],
	};
	const request = { headers: {} };
	const state = createMemoryProviderRuntimeState();

	return {
		env: { get: () => undefined },
		credential,
		request,
		http: {
			request: async () => jsonResponse(rawFixture),
			get: async () => jsonResponse(rawFixture),
			post: async () => jsonResponse(rawFixture),
			put: async () => jsonResponse(rawFixture),
			delete: async () => jsonResponse(rawFixture),
			stream: async () => unsupported("ctx.http.stream"),
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
			withIsolatedContext: async () =>
				unsupported("ctx.browser.withIsolatedContext"),
			solveChallenge: async () => unsupported("ctx.browser.solveChallenge"),
		},
		trace: {
			span: async (_name, fn) => fn(),
		},
		auth: {
			requestField: async (name) =>
				unsupported(`ctx.auth.requestField(${name})`),
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
	const context = createSnapshotContext(rawFixture);
	const outputs = await Promise.all(
		entries.map(async ([operationName, operation]) => {
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
		safeParseSchemaSync(
			schema,
			fixture,
			`operations.${operationName}.fixtures.${fieldName}`,
		),
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
	rawFixture?: unknown,
	manifest?: StandardTestsManifest,
	options: StandardTestsOptions = {},
): void {
	const operations = Object.entries(provider.operations);

	const assertFixtureValidation = (): void => {
		expect(rawFixture).toBeDefined();
		expect(isJsonCompatible(rawFixture)).toBe(true);

		for (const [operationName, op] of operations) {
			if (op.fixtures?.request !== undefined) {
				parseSchemaFixture(
					operationName,
					"request",
					op.input,
					op.fixtures.request,
				);
			}

			if (op.fixtures?.response !== undefined) {
				parseSchemaFixture(
					operationName,
					"response",
					op.output,
					op.fixtures.response,
				);
			}

			if (isFixtureEnvelope(rawFixture)) {
				if (rawFixture.request !== undefined) {
					parseSchemaFixture(
						operationName,
						"request",
						op.input,
						rawFixture.request,
					);
				}

				if (rawFixture.response !== undefined) {
					parseSchemaFixture(
						operationName,
						"response",
						op.output,
						rawFixture.response,
					);
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
					parseSchemaFixture(
						operationName,
						"request",
						op.input,
						op.fixtures.request,
					);
				}

				if (op.fixtures?.response !== undefined && op.output) {
					parseSchemaFixture(
						operationName,
						"response",
						op.output,
						op.fixtures.response,
					);
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

				const expected: unknown = JSON.parse(
					await Bun.file(snapshotPath).text(),
				);
				expect(actual).toEqual(expected);
			});
		}
	});
}
