import type {
	BrowserClient,
	BrowserLocator,
	BrowserPage,
	BrowserResourcePolicy,
} from "../types.js";

export function assertIsError(value: unknown): asserts value is Error {
	if (!(value instanceof Error)) {
		throw new Error(`Expected an Error, received ${String(value)}`);
	}
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

export function createFetchDouble(implementation: typeof fetch): typeof fetch {
	return implementation;
}
