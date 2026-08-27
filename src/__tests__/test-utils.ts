import type {
	BrowserClient,
	BrowserLocator,
	BrowserPage,
	BrowserResourcePolicy,
	ProviderContext,
	ProviderDefinition,
} from "../types.js";
import { defineProvider, type ProviderDeclaration } from "../define.js";
import { createProviderCache } from "../runtime/cache.js";
import { createTestProviderChoiceContext } from "../runtime/choice.js";
import { createCredentialContext } from "../runtime/credential.js";
import { createEnvContext } from "../runtime/env.js";
import { createHttpClient } from "../runtime/http.js";
import { createUnsupportedOcrClient } from "../runtime/ocr.js";
import { createUnsupportedResolverClient } from "../runtime/resolver-shared.js";
import { createMemoryProviderRuntimeState } from "../runtime/state.js";
import { createUnsupportedSttClient } from "../runtime/stt.js";
import { createTraceContext } from "../runtime/trace.js";

export function assertIsError(value: unknown): asserts value is Error {
	if (!(value instanceof Error)) {
		throw new Error(`Expected an Error, received ${String(value)}`);
	}
}

export function emptyArray<T>(): T[] {
	return [];
}

/** Runtime-validation adapter for fixtures that intentionally construct invalid configs. */
export function defineTestProvider<
	TConfig extends { operations: Record<string, unknown> },
>(config: TConfig): Omit<ProviderDefinition, "operations"> &
	Omit<TConfig, "operations"> & {
		operations: ProviderDefinition["operations"] & TConfig["operations"];
	} {
	const { operations, ...declaration } = config;
	const buildProvider = defineProvider(declaration as unknown as ProviderDeclaration);
	return buildProvider({ operations: operations as never }) as Omit<
		ProviderDefinition,
		"operations"
	> &
		Omit<TConfig, "operations"> & {
			operations: ProviderDefinition["operations"] & TConfig["operations"];
		};
}

export async function capturedError(operation: Promise<unknown>): Promise<Error> {
	return await operation.then(
		() => {
			throw new Error("Expected operation to reject");
		},
		(error: unknown) => {
			assertIsError(error);
			return error;
		},
	);
}

function createBrowserLocatorDouble(): BrowserLocator {
	return {
		async click() {},
		async fill() {},
		async textContent() {
			return null;
		},
		async waitFor() {},
	};
}

export function createBrowserPageDouble(overrides: Partial<BrowserPage> = {}): BrowserPage {
	return {
		id: "test-page",
		async click() {},
		async close() {},
		async content() {
			return "";
		},
		async cookies() {
			return [];
		},
		async evaluate<T>(fn: string | (() => T)): Promise<T> {
			if (typeof fn === "function") return fn();
			throw new Error(`No evaluation result configured for ${fn}`);
		},
		async fill() {},
		async frames() {
			return [];
		},
		async goto() {},
		locator() {
			return createBrowserLocatorDouble();
		},
		async screenshot() {
			return Buffer.alloc(0);
		},
		async title() {
			return "";
		},
		async userAgent() {
			return "TestBrowser/1.0";
		},
		async type() {},
		async url() {
			return "about:blank";
		},
		async waitForSelector() {},
		async withResourcePolicy<T>(
			_policy: BrowserResourcePolicy,
			run: () => Promise<T>,
		): Promise<T> {
			return await run();
		},
		...overrides,
	};
}

export function createBrowserClientDouble(
	overrides: Partial<BrowserClient> = {},
): BrowserClient {
	const page = createBrowserPageDouble();
	return {
		engine: "playwright-stealth",
		async close() {},
		async newPage() {
			return page;
		},
		async rawPage() {
			return page;
		},
		async solveChallenge(request) {
			return { type: request.type, solved: false };
		},
		async withIsolatedContext<T>(handler: (isolatedPage: BrowserPage) => Promise<T>) {
			return await handler(page);
		},
		...overrides,
	};
}

export function createProviderContextDouble(
	overrides: Partial<ProviderContext> = {},
): ProviderContext {
	return {
		auth: {
			async requestField() {
				throw new Error("No auth field configured for this test context");
			},
		},
		browser: createBrowserClientDouble(),
		cache: createProviderCache({ providerId: "test-provider" }),
		choice: createTestProviderChoiceContext({ providerId: "test-provider" }),
		credential: createCredentialContext(),
		env: createEnvContext(),
		http: createHttpClient(),
		ocr: createUnsupportedOcrClient(),
		resolver: createUnsupportedResolverClient(),
		state: createMemoryProviderRuntimeState(),
		stealth: {
			async fetch() {
				throw new Error("No stealth response configured for this test context");
			},
			createSession() {
				throw new Error("No stealth session configured for this test context");
			},
		},
		stt: createUnsupportedSttClient(),
		trace: createTraceContext(),
		...overrides,
	};
}

export function createProviderDefinitionDouble(
	overrides: Partial<ProviderDefinition> = {},
): ProviderDefinition {
	return {
		id: "test-provider",
		version: "1.0.0",
		runtime: "standard",
		meta: {
			displayName: "Test Provider",
			descriptionKey: "test-provider.description",
			category: "test",
		},
		operations: {},
		...overrides,
	};
}

export function createFetchDouble(implementation: typeof fetch): typeof fetch {
	return implementation;
}
