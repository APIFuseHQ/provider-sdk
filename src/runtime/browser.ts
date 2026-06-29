import { createRequire } from "node:module";
import type { Frame, LaunchOptions, Locator, Page, Request, Route } from "playwright";

import { ProviderError } from "../errors";
import type {
	BrowserChallengeRequest,
	BrowserChallengeResult,
	BrowserClient as BrowserClientContract,
	BrowserEngine,
	BrowserFrame,
	BrowserLocator,
	BrowserOptions,
	BrowserPage,
	BrowserResourceBody,
	BrowserResourceDecision,
	BrowserResourceMethod,
	BrowserResourcePolicy,
	BrowserResourceRequest,
} from "../types";

const require = createRequire(import.meta.url);
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const SELECTOR_POLL_INTERVAL_MS = 100;
const RESOURCE_POLICY_ROUTE_PATTERN = "**/*";
const DEFAULT_RESOURCE_METHODS = ["GET", "HEAD"] as const;

type PlaywrightModule = typeof import("playwright");
type PlaywrightExtraModule = {
	chromium: PlaywrightModule["chromium"] & { use(plugin: unknown): unknown };
};

type StealthPluginFactory = (options?: {
	enabledEvasions?: Set<string>;
}) => unknown;

type PoolAcquireResponse = {
	browserContextId?: string;
	pageId: string;
	wsEndpoint: string;
};

type PoolReleaseRequest = {
	browserContextId?: string;
	pageId: string;
};

type JsonRpcId = number;

type JsonRpcError = {
	code?: number;
	message?: string;
};

type JsonRpcMessage = {
	error?: JsonRpcError;
	id?: JsonRpcId;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
};

type CdpFrameTreeNode = {
	childFrames?: CdpFrameTreeNode[];
	frame: {
		id: string;
		name?: string;
		parentId?: string;
		url?: string;
	};
};

type CdpFetchFulfillParams = {
	readonly requestId: string;
	readonly responseCode: number;
	readonly responseHeaders?: readonly {
		readonly name: string;
		readonly value: string;
	}[];
	readonly body?: string;
};

type BrowserPageContract = BrowserPage;

function toResourceBody(
	body: BrowserResourceBody | undefined,
): Buffer | string | undefined {
	if (body === undefined || typeof body === "string" || Buffer.isBuffer(body)) {
		return body;
	}

	if (body instanceof ArrayBuffer) {
		return Buffer.from(new Uint8Array(body));
	}

	return Buffer.from(body);
}

function isResourceMethod(method: string): method is BrowserResourceMethod {
	return method === "GET" || method === "HEAD";
}

async function toResourceRequest(
	request: Request,
): Promise<BrowserResourceRequest | null> {
	const method = request.method().toUpperCase();
	if (!isResourceMethod(method)) {
		return null;
	}

	return {
		headers: await request.allHeaders(),
		method,
		resourceType: request.resourceType(),
		url: request.url(),
	};
}

function toCdpResourceRequest(
	params: unknown,
): { requestId: string; request: BrowserResourceRequest } | null {
	if (!isRecord(params)) {
		return null;
	}

	const requestId = params.requestId;
	const rawRequest = params.request;
	if (typeof requestId !== "string" || !isRecord(rawRequest)) {
		return null;
	}

	const url = rawRequest.url;
	const method = String(rawRequest.method ?? "").toUpperCase();
	if (typeof url !== "string" || !isResourceMethod(method)) {
		return null;
	}

	return {
		requestId,
		request: {
			headers: toCdpResourceHeaders(rawRequest.headers),
			method,
			resourceType:
				typeof params.resourceType === "string" ? params.resourceType : undefined,
			url,
		},
	};
}

function getCdpPausedRequestId(params: unknown): string | null {
	if (!isRecord(params) || typeof params.requestId !== "string") {
		return null;
	}

	return params.requestId;
}

function toCdpResourceHeaders(value: unknown): Record<string, string> {
	if (!isRecord(value)) {
		return {};
	}

	const headers: Record<string, string> = {};
	for (const [name, headerValue] of Object.entries(value)) {
		if (typeof headerValue === "string") {
			headers[name] = headerValue;
		}
	}

	return headers;
}

function matchesResourceRoute(
	match: BrowserResourcePolicy["routes"][number]["match"],
	request: BrowserResourceRequest,
): boolean {
	if (typeof match === "string") {
		return request.url === match;
	}
	if (match instanceof RegExp) {
		return match.test(request.url);
	}

	return match(request);
}

function toCdpFulfillParams(
	requestId: string,
	decision: Extract<BrowserResourceDecision, { readonly action: "fulfill" }>,
): CdpFetchFulfillParams {
	const body = toResourceBody(decision.body);
	return {
		...(body === undefined
			? {}
			: { body: Buffer.from(body).toString("base64") }),
		...(decision.headers === undefined
			? {}
			: {
					responseHeaders: Object.entries(decision.headers).map(
						([name, value]) => ({ name, value }),
					),
				}),
		requestId,
		responseCode: decision.status ?? 200,
	};
}

async function fulfillResourceRoute(
	route: Route,
	decision: Extract<BrowserResourceDecision, { readonly action: "fulfill" }>,
): Promise<void> {
	const body = toResourceBody(decision.body);
	await route.fulfill({
		...(body === undefined ? {} : { body }),
		...(decision.headers === undefined ? {} : { headers: decision.headers }),
		status: decision.status ?? 200,
	});
}

export type BrowserClientOptions = BrowserOptions & {
	allowedHosts?: string[];
	cdpUrl?: string;
	executablePath?: string;
	extraArgs?: string[];
};

type SupportedBrowserClient = {
	readonly engine: BrowserEngine;
	close(): Promise<void>;
	newPage(): Promise<BrowserPageContract>;
	rawPage(): Promise<BrowserPageContract>;
	withIsolatedContext<T>(
		handler: (page: BrowserPageContract) => Promise<T>,
	): Promise<T>;
};

function getDefaultCdpPoolUrl(env = process.env): string | undefined {
	return env.APIFUSE__CDP_POOL__URL;
}

async function importOptionalModule<T extends object>(
	moduleName: string,
): Promise<T> {
	return (await import(moduleName)) as T;
}

function unwrapModuleDefault<T extends object>(module: T): T {
	if ("default" in module) {
		const defaultExport = module.default as unknown;
		if (
			(typeof defaultExport === "object" && defaultExport !== null) ||
			typeof defaultExport === "function"
		) {
			return defaultExport as T;
		}
	}

	return module;
}

function isModuleNotFoundError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	const code = "code" in error ? error.code : undefined;
	return (
		code === "MODULE_NOT_FOUND" ||
		code === "ERR_MODULE_NOT_FOUND" ||
		error.message.includes("Cannot find module") ||
		error.message.includes("Cannot find package")
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatExpression<T>(fn: string | (() => T)): string {
	if (typeof fn === "string") {
		return fn;
	}

	return `(${fn.toString()})()`;
}

function toLaunchOptions(options: BrowserClientOptions): LaunchOptions {
	return {
		args: options.extraArgs,
		executablePath: options.executablePath,
		headless: options.headless ?? true,
		proxy: options.proxy ? { server: options.proxy } : undefined,
	};
}

class PlaywrightBrowserLocator implements BrowserLocator {
	constructor(private readonly locator: Locator) {}

	async click(): Promise<void> {
		await this.locator.click();
	}

	async fill(text: string): Promise<void> {
		await this.locator.fill(text);
	}

	async textContent(): Promise<string | null> {
		return await this.locator.textContent();
	}

	async waitFor(options?: { timeout?: number }): Promise<void> {
		await this.locator.waitFor(options);
	}
}

class PlaywrightBrowserFrame implements BrowserFrame {
	constructor(private readonly frame: Frame) {}

	get id(): string {
		return this.frame.name() || this.frame.url();
	}

	get name(): string | undefined {
		const name = this.frame.name();
		return name.length > 0 ? name : undefined;
	}

	get parentId(): string | undefined {
		const parent = this.frame.parentFrame();
		return parent ? parent.name() || parent.url() : undefined;
	}

	async url(): Promise<string> {
		return this.frame.url();
	}

	async title(): Promise<string> {
		return await this.frame.evaluate("document.title");
	}

	async content(): Promise<string> {
		return await this.frame.content();
	}

	async evaluate<T>(fn: string | (() => T)): Promise<T> {
		if (typeof fn === "string") {
			return await this.frame.evaluate(fn);
		}

		return await this.frame.evaluate(fn);
	}

	locator(selector: string): BrowserLocator {
		return new PlaywrightBrowserLocator(this.frame.locator(selector));
	}
}

async function loadPlaywright(): Promise<PlaywrightModule> {
	try {
		await importOptionalModule<PlaywrightModule>("playwright");
	} catch (error) {
		if (isModuleNotFoundError(error)) {
			throw new ProviderError("Playwright is not installed", {
				cause: error instanceof Error ? error : undefined,
				fix: "Run: bun add playwright",
			});
		}

		throw error;
	}

	try {
		return unwrapModuleDefault(
			await importOptionalModule<PlaywrightModule>("playwright"),
		);
	} catch (error) {
		if (isModuleNotFoundError(error)) {
			throw new ProviderError("Playwright is not installed", {
				cause: error instanceof Error ? error : undefined,
				fix: "Run: bun add playwright",
			});
		}

		throw error;
	}
}

const playwrightExtraStealthLaunchers = new WeakSet<object>();

async function loadPlaywrightExtra(): Promise<PlaywrightExtraModule> {
	try {
		require("playwright");
	} catch (error) {
		if (isModuleNotFoundError(error)) {
			throw new ProviderError("Playwright is not installed", {
				cause: error instanceof Error ? error : undefined,
				fix: "Run: bun add playwright",
			});
		}

		throw error;
	}

	try {
		return unwrapModuleDefault(
			await importOptionalModule<PlaywrightExtraModule>("playwright-extra"),
		);
	} catch (error) {
		if (isModuleNotFoundError(error)) {
			throw new ProviderError("playwright-extra is not installed", {
				cause: error instanceof Error ? error : undefined,
				fix: "Run: bun add playwright-extra puppeteer-extra-plugin-stealth",
			});
		}

		throw error;
	}
}

async function loadStealthPluginFactory(): Promise<StealthPluginFactory> {
	try {
		return unwrapModuleDefault(
			await importOptionalModule<StealthPluginFactory>(
				"puppeteer-extra-plugin-stealth",
			),
		);
	} catch (error) {
		if (isModuleNotFoundError(error)) {
			throw new ProviderError(
				"puppeteer-extra-plugin-stealth is not installed",
				{
					cause: error instanceof Error ? error : undefined,
					fix: "Run: bun add playwright-extra puppeteer-extra-plugin-stealth",
				},
			);
		}

		throw error;
	}
}

async function loadChromiumLauncher(
	options: BrowserClientOptions,
): Promise<PlaywrightModule["chromium"]> {
	if (!(options.stealth ?? true)) {
		return (await loadPlaywright()).chromium;
	}

	const playwrightExtra = await loadPlaywrightExtra();
	if (!playwrightExtraStealthLaunchers.has(playwrightExtra.chromium)) {
		const createStealthPlugin = await loadStealthPluginFactory();
		playwrightExtra.chromium.use(createStealthPlugin());
		playwrightExtraStealthLaunchers.add(playwrightExtra.chromium);
	}

	return playwrightExtra.chromium;
}

async function loadNodriver(): Promise<void> {
	try {
		await importOptionalModule("nodriver");
	} catch (error) {
		if (isModuleNotFoundError(error)) {
			throw new ProviderError("nodriver is not installed", {
				cause: error instanceof Error ? error : undefined,
				fix: "Run: pip install nodriver (Python) or bun add nodriver",
			});
		}

		throw error;
	}
}

async function loadSeleniumBase(): Promise<void> {
	try {
		await importOptionalModule("seleniumbase");
	} catch (error) {
		if (isModuleNotFoundError(error)) {
			throw new ProviderError("seleniumbase is not installed", {
				cause: error instanceof Error ? error : undefined,
				fix: "Run: pip install seleniumbase",
			});
		}

		throw error;
	}
}

class PlaywrightBrowserPage implements BrowserPageContract {
	readonly id = "main";
	readonly pageId?: string;

	constructor(private readonly page: Page) {}

	async goto(url: string): Promise<void> {
		await this.page.goto(url);
	}

	async evaluate<T>(fn: string | (() => T)): Promise<T> {
		if (typeof fn === "string") {
			return await this.page.evaluate(fn);
		}

		return await this.page.evaluate(fn);
	}

	async waitForSelector(
		selector: string,
		options?: { timeout?: number },
	): Promise<void> {
		await this.page.waitForSelector(selector, options);
	}

	async click(selector: string): Promise<void> {
		await this.page.click(selector);
	}

	async type(selector: string, text: string): Promise<void> {
		await this.page.locator(selector).fill("");
		await this.page.type(selector, text);
	}

	async fill(selector: string, text: string): Promise<void> {
		await this.page.fill(selector, text);
	}

	async frames(): Promise<BrowserFrame[]> {
		return this.page.frames().map((frame) => new PlaywrightBrowserFrame(frame));
	}

	locator(selector: string): BrowserLocator {
		return new PlaywrightBrowserLocator(this.page.locator(selector));
	}

	async title(): Promise<string> {
		return await this.page.title();
	}

	async url(): Promise<string> {
		return this.page.url();
	}

	async content(): Promise<string> {
		return await this.page.content();
	}

	async screenshot(options?: { fullPage?: boolean }): Promise<Buffer> {
		return await this.page.screenshot(options);
	}

	async close(): Promise<void> {
		await this.page.close();
	}

	async withResourcePolicy<T>(
		policy: BrowserResourcePolicy,
		run: () => Promise<T>,
	): Promise<T> {
		const allowedMethods = new Set(
			policy.allowedMethods ?? DEFAULT_RESOURCE_METHODS,
		);
		const handler = async (route: Route): Promise<void> => {
			const request = await toResourceRequest(route.request());
			if (!request || !allowedMethods.has(request.method)) {
				await route.abort("blockedbyclient");
				return;
			}

			for (const resourceRoute of policy.routes) {
				if (!matchesResourceRoute(resourceRoute.match, request)) {
					continue;
				}

				const decision = await resourceRoute.handle(request);
				switch (decision.action) {
					case "fulfill":
						await fulfillResourceRoute(route, decision);
						return;
					case "block":
						await route.abort("blockedbyclient");
						return;
				}
			}

			await route.abort("blockedbyclient");
		};

		await this.page.route(RESOURCE_POLICY_ROUTE_PATTERN, handler);
		try {
			return await run();
		} finally {
			await this.page.unroute(RESOURCE_POLICY_ROUTE_PATTERN, handler);
		}
	}
}

class PlaywrightBrowserClient implements SupportedBrowserClient {
	private browser: import("playwright").Browser | null = null;
	readonly engine = "playwright-stealth" satisfies BrowserEngine;

	constructor(private readonly options: BrowserClientOptions = {}) {}

	private async ensureBrowser(): Promise<import("playwright").Browser> {
		if (this.browser?.isConnected()) {
			return this.browser;
		}

		const chromium = await loadChromiumLauncher(this.options);
		this.browser = await chromium.launch(toLaunchOptions(this.options));
		return this.browser;
	}

	async newPage(): Promise<BrowserPageContract> {
		const browser = await this.ensureBrowser();
		const page = await browser.newPage();

		return new PlaywrightBrowserPage(page);
	}

	async rawPage(): Promise<BrowserPageContract> {
		throw new ProviderError("ctx.browser.rawPage() requires a CDP pool", {
			code: "BROWSER_RUNTIME_UNSUPPORTED",
			fix: "Set APIFUSE__CDP_POOL__URL and use the SDK CDP pool-backed browser runtime. Local Chromium launch is not allowed for rawPage().",
		});
	}

	async withIsolatedContext<T>(
		handler: (page: BrowserPageContract) => Promise<T>,
	): Promise<T> {
		const browser = await this.ensureBrowser();
		const context = await browser.newContext();
		const page = await context.newPage();
		const browserPage = new PlaywrightBrowserPage(page);

		try {
			return await handler(browserPage);
		} finally {
			try {
				await browserPage.close();
			} finally {
				await context.close();
			}
		}
	}

	async close(): Promise<void> {
		const browser = this.browser;
		this.browser = null;

		if (!browser) {
			return;
		}

		await browser.close();
	}
}

function normalizeWebSocketEndpoint(endpoint: string): string {
	const url = new URL(endpoint);
	if (url.protocol === "http:") {
		url.protocol = "ws:";
		return url.toString();
	}
	if (url.protocol === "https:") {
		url.protocol = "wss:";
		return url.toString();
	}
	if (url.protocol === "ws:" || url.protocol === "wss:") {
		return endpoint;
	}
	throw new Error(`Unsupported WebSocket endpoint protocol: ${url.protocol}`);
}

class JsonRpcWebSocketClient {
	private nextId = 1;
	private readonly endpoint: string;
	private readonly listeners = new Map<
		string,
		Set<(params: unknown) => void>
	>();
	private readonly pending = new Map<
		JsonRpcId,
		{
			reject: (reason?: unknown) => void;
			resolve: (value: Record<string, unknown>) => void;
		}
	>();
	private socket?: WebSocket;
	private socketPromise?: Promise<WebSocket>;

	constructor(endpoint: string) {
		this.endpoint = normalizeWebSocketEndpoint(endpoint);
	}

	on(method: string, listener: (params: unknown) => void): () => void {
		const listeners = this.listeners.get(method) ?? new Set();
		listeners.add(listener);
		this.listeners.set(method, listeners);

		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) {
				this.listeners.delete(method);
			}
		};
	}

	async send(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		const socket = await this.getSocket();
		const id = this.nextId++;

		return await new Promise<Record<string, unknown>>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });

			socket.send(
				JSON.stringify({
					id,
					jsonrpc: "2.0",
					method,
					params,
				}),
			);
		});
	}

	async close(): Promise<void> {
		for (const pending of this.pending.values()) {
			pending.reject(new Error(`WebSocket closed: ${this.endpoint}`));
		}

		this.pending.clear();
		this.listeners.clear();
		this.socket?.close();
		this.socket = undefined;
		this.socketPromise = undefined;
	}

	private async getSocket(): Promise<WebSocket> {
		if (this.socket?.readyState === WebSocket.OPEN) {
			return this.socket;
		}

		if (this.socketPromise) {
			return this.socketPromise;
		}

		this.socketPromise = new Promise<WebSocket>((resolve, reject) => {
			const socket = new WebSocket(this.endpoint);

			socket.addEventListener("open", () => {
				this.socket = socket;
				resolve(socket);
			});

			socket.addEventListener("message", (event) => {
				const rawData =
					typeof event.data === "string"
						? event.data
						: Buffer.from(event.data as ArrayBufferLike).toString("utf8");
				const payload = JSON.parse(rawData) as JsonRpcMessage;

				if (typeof payload.id === "number") {
					const pending = this.pending.get(payload.id);
					if (!pending) {
						return;
					}

					this.pending.delete(payload.id);

					if (payload.error) {
						pending.reject(
							new Error(payload.error.message ?? "JSON-RPC command failed"),
						);
						return;
					}

					pending.resolve(payload.result ?? {});
					return;
				}

				if (!payload.method) {
					return;
				}

				for (const listener of this.listeners.get(payload.method) ?? []) {
					listener(payload.params);
				}
			});

			socket.addEventListener("close", () => {
				for (const pending of this.pending.values()) {
					pending.reject(new Error(`WebSocket closed: ${this.endpoint}`));
				}

				this.pending.clear();
				this.socket = undefined;
				this.socketPromise = undefined;
			});

			socket.addEventListener("error", () => {
				reject(
					new Error(
						`Unable to connect to WebSocket endpoint: ${this.endpoint}`,
					),
				);
			});
		});

		return this.socketPromise;
	}
}

function flattenCdpFrameTree(
	node: CdpFrameTreeNode | undefined,
	out: CdpFrameTreeNode["frame"][] = [],
): CdpFrameTreeNode["frame"][] {
	if (!node) {
		return out;
	}

	out.push(node.frame);
	for (const child of node.childFrames ?? []) {
		flattenCdpFrameTree(child, out);
	}

	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePoolAcquireResponse(value: unknown): PoolAcquireResponse {
	if (
		!isRecord(value) ||
		typeof value.pageId !== "string" ||
		typeof value.wsEndpoint !== "string"
	) {
		throw new ProviderError("CDP Pool returned an invalid acquire response", {
			code: "BROWSER_RUNTIME_UNSUPPORTED",
		});
	}

	if (
		value.browserContextId !== undefined &&
		typeof value.browserContextId !== "string"
	) {
		throw new ProviderError("CDP Pool returned an invalid acquire response", {
			code: "BROWSER_RUNTIME_UNSUPPORTED",
		});
	}

	return {
		...(value.browserContextId
			? { browserContextId: value.browserContextId }
			: {}),
		pageId: value.pageId,
		wsEndpoint: value.wsEndpoint,
	};
}

function parseCdpFrameTreeNode(value: unknown): CdpFrameTreeNode | undefined {
	if (!isRecord(value) || !isRecord(value.frame)) {
		return undefined;
	}

	const frameId = value.frame.id;
	if (typeof frameId !== "string") {
		return undefined;
	}

	const childFrames = Array.isArray(value.childFrames)
		? value.childFrames
				.map(parseCdpFrameTreeNode)
				.filter((child): child is CdpFrameTreeNode => child !== undefined)
		: undefined;

	return {
		frame: {
			id: frameId,
			name: typeof value.frame.name === "string" ? value.frame.name : undefined,
			parentId:
				typeof value.frame.parentId === "string"
					? value.frame.parentId
					: undefined,
			url: typeof value.frame.url === "string" ? value.frame.url : undefined,
		},
		...(childFrames ? { childFrames } : {}),
	};
}

function getCdpExecutionContext(params: unknown): {
	frameId?: string;
	id?: number;
} {
	if (!isRecord(params) || !isRecord(params.context)) {
		return {};
	}

	const contextId = params.context.id;
	const auxData = params.context.auxData;
	return {
		frameId:
			isRecord(auxData) && typeof auxData.frameId === "string"
				? auxData.frameId
				: undefined,
		id: typeof contextId === "number" ? contextId : undefined,
	};
}

class CdpBrowserLocator implements BrowserLocator {
	constructor(
		private readonly frame: {
			evaluate<T>(fn: string | (() => T)): Promise<T>;
			waitForSelector?(
				selector: string,
				options?: { timeout?: number },
			): Promise<void>;
		},
		private readonly selector: string,
	) {}

	async click(): Promise<void> {
		await this.waitFor();
		await this.frame.evaluate(
			`(() => {
				const element = document.querySelector(${JSON.stringify(this.selector)});
				if (!(element instanceof HTMLElement)) {
					throw new Error(${JSON.stringify(`Selector not found: ${this.selector}`)});
				}
				element.click();
			})()`,
		);
	}

	async fill(text: string): Promise<void> {
		await this.waitFor();
		await this.frame.evaluate(
			`(() => {
				const element = document.querySelector(${JSON.stringify(this.selector)});
				if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
					throw new Error(${JSON.stringify(`Unsupported input target: ${this.selector}`)});
				}
				element.focus();
				element.value = ${JSON.stringify(text)};
				element.dispatchEvent(new Event("input", { bubbles: true }));
				element.dispatchEvent(new Event("change", { bubbles: true }));
			})()`,
		);
	}

	async textContent(): Promise<string | null> {
		return await this.frame.evaluate<string | null>(
			`document.querySelector(${JSON.stringify(this.selector)})?.textContent ?? null`,
		);
	}

	async waitFor(options?: { timeout?: number }): Promise<void> {
		if (this.frame.waitForSelector) {
			await this.frame.waitForSelector(this.selector, options);
			return;
		}

		const timeout = options?.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const exists = await this.frame.evaluate<boolean>(
				`Boolean(document.querySelector(${JSON.stringify(this.selector)}))`,
			);
			if (exists) {
				return;
			}
			await delay(SELECTOR_POLL_INTERVAL_MS);
		}

		throw new Error(`Timed out waiting for selector: ${this.selector}`);
	}
}

class CdpBrowserFrame implements BrowserFrame {
	constructor(
		readonly id: string,
		private readonly page: CdpPoolBrowserPage,
		private readonly initialUrl = "",
		readonly name?: string,
		readonly parentId?: string,
	) {}

	async url(): Promise<string> {
		const evaluatedUrl = await this.evaluate<string | undefined>(
			"window.location.href",
		);
		return evaluatedUrl || this.initialUrl;
	}

	async title(): Promise<string> {
		return await this.evaluate<string>("document.title");
	}

	async content(): Promise<string> {
		return await this.evaluate<string>("document.documentElement.outerHTML");
	}

	async evaluate<T>(fn: string | (() => T)): Promise<T> {
		return await this.page.evaluateInFrame<T>(this.id, fn);
	}

	locator(selector: string): BrowserLocator {
		return new CdpBrowserLocator(this, selector);
	}

	async waitForSelector(
		selector: string,
		options?: { timeout?: number },
	): Promise<void> {
		await this.page.waitForSelectorInFrame(this.id, selector, options);
	}

	fallbackUrl(): string {
		return this.initialUrl;
	}
}

class CdpPoolBrowserPage implements BrowserPageContract {
	private closed = false;
	private initialized = false;
	private readonly frameExecutionContexts = new Map<string, number>();

	constructor(
		readonly pageId: string,
		private readonly browserContextId: string | undefined,
		private readonly pageClient: JsonRpcWebSocketClient,
		private readonly release: (request: PoolReleaseRequest) => Promise<void>,
	) {}

	get id(): string {
		return this.pageId;
	}

	async goto(url: string): Promise<void> {
		await this.initialize();
		const startedAt = Date.now();
		let loadEventSeen = false;
		const unsubscribe = this.pageClient.on("Page.loadEventFired", () => {
			loadEventSeen = true;
		});

		try {
			await this.pageClient.send("Page.navigate", { url });
			await this.waitForDocumentReady(
				startedAt + DEFAULT_WAIT_TIMEOUT_MS,
				() => loadEventSeen,
			);
		} finally {
			unsubscribe();
		}
	}

	async evaluate<T>(fn: string | (() => T)): Promise<T> {
		await this.initialize();
		return await this.evaluateWithContext<T>(fn);
	}

	async evaluateInFrame<T>(
		frameId: string,
		fn: string | (() => T),
	): Promise<T> {
		await this.initialize();
		const contextId = await this.getFrameExecutionContextId(frameId);
		return await this.evaluateWithContext<T>(fn, contextId);
	}

	async waitForSelectorInFrame(
		frameId: string,
		selector: string,
		options?: { timeout?: number },
	): Promise<void> {
		const timeout = options?.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
		const deadline = Date.now() + timeout;

		while (Date.now() < deadline) {
			const exists = await this.evaluateInFrame<boolean>(
				frameId,
				`Boolean(document.querySelector(${JSON.stringify(selector)}))`,
			);

			if (exists) {
				return;
			}

			await delay(SELECTOR_POLL_INTERVAL_MS);
		}

		throw new Error(`Timed out waiting for selector: ${selector}`);
	}

	private async evaluateWithContext<T>(
		fn: string | (() => T),
		contextId?: number,
	): Promise<T> {
		const result = await this.pageClient.send("Runtime.evaluate", {
			awaitPromise: true,
			...(contextId === undefined ? {} : { contextId }),
			expression: formatExpression(fn),
			returnByValue: true,
		});

		if (result.exceptionDetails) {
			throw new Error(
				String(
					(result.exceptionDetails as { text?: string }).text ??
						"Browser evaluation failed",
				),
			);
		}

		return (result.result as { value?: T } | undefined)?.value as T;
	}

	async waitForSelector(
		selector: string,
		options?: { timeout?: number },
	): Promise<void> {
		const timeout = options?.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
		const deadline = Date.now() + timeout;

		while (Date.now() < deadline) {
			const exists = await this.evaluate<boolean>(
				`Boolean(document.querySelector(${JSON.stringify(selector)}))`,
			);

			if (exists) {
				return;
			}

			await delay(SELECTOR_POLL_INTERVAL_MS);
		}

		throw new Error(`Timed out waiting for selector: ${selector}`);
	}

	async click(selector: string): Promise<void> {
		await this.waitForSelector(selector);
		await this.evaluate(
			`(() => {
				const element = document.querySelector(${JSON.stringify(selector)});
				if (!(element instanceof HTMLElement)) {
					throw new Error(${JSON.stringify(`Selector not found: ${selector}`)});
				}
				element.click();
			})()`,
		);
	}

	async type(selector: string, text: string): Promise<void> {
		await this.fill(selector, text);
	}

	async fill(selector: string, text: string): Promise<void> {
		await this.waitForSelector(selector);
		await this.evaluate(
			`(() => {
				const element = document.querySelector(${JSON.stringify(selector)});
				if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
					throw new Error(${JSON.stringify(`Unsupported input target: ${selector}`)});
				}
				element.focus();
				element.value = "";
			})()`,
		);
		await this.pageClient.send("Input.insertText", { text });
		await this.evaluate(
			`(() => {
				const element = document.querySelector(${JSON.stringify(selector)});
				if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
					throw new Error(${JSON.stringify(`Unsupported input target: ${selector}`)});
				}
				element.dispatchEvent(new Event("input", { bubbles: true }));
				element.dispatchEvent(new Event("change", { bubbles: true }));
			})()`,
		);
	}

	async frames(): Promise<BrowserFrame[]> {
		await this.initialize();
		const result = await this.pageClient.send("Page.getFrameTree");
		const frames = flattenCdpFrameTree(parseCdpFrameTreeNode(result.frameTree));
		return frames.map(
			(frame) =>
				new CdpBrowserFrame(
					frame.id,
					this,
					frame.url ?? "",
					frame.name,
					frame.parentId,
				),
		);
	}

	locator(selector: string): BrowserLocator {
		return new CdpBrowserLocator(this, selector);
	}

	async title(): Promise<string> {
		return await this.evaluate<string>("document.title");
	}

	async url(): Promise<string> {
		const [mainFrame] = await this.frames();
		const frameUrl =
			mainFrame instanceof CdpBrowserFrame ? mainFrame.fallbackUrl() : "";
		return frameUrl || (await this.evaluate<string>("window.location.href"));
	}

	async content(): Promise<string> {
		return await this.evaluate<string>("document.documentElement.outerHTML");
	}

	async screenshot(options?: { fullPage?: boolean }): Promise<Buffer> {
		await this.initialize();
		const result = await this.pageClient.send("Page.captureScreenshot", {
			captureBeyondViewport: options?.fullPage ?? false,
			format: "png",
			fromSurface: true,
		});

		return Buffer.from(String(result.data ?? ""), "base64");
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}

		this.closed = true;

		try {
			await this.release({
				...(this.browserContextId
					? { browserContextId: this.browserContextId }
					: {}),
				pageId: this.pageId,
			});
		} finally {
			await this.pageClient.close();
		}
	}

	async withResourcePolicy<T>(
		policy: BrowserResourcePolicy,
		run: () => Promise<T>,
	): Promise<T> {
		const allowedMethods = new Set(
			policy.allowedMethods ?? DEFAULT_RESOURCE_METHODS,
		);
		const handlePausedRequest = (params: unknown): void => {
			void this.handleResourcePolicyPausedRequest(
				params,
				policy,
				allowedMethods,
			);
		};

		const unsubscribe = this.pageClient.on(
			"Fetch.requestPaused",
			handlePausedRequest,
		);

		try {
			await this.pageClient.send("Fetch.enable", {
				patterns: [{ requestStage: "Request", urlPattern: "*" }],
			});
		} catch (error) {
			unsubscribe();
			throw new ProviderError(
				"CDP browser target does not support BrowserPage.withResourcePolicy()",
				{
					cause: error instanceof Error ? error : undefined,
					code: "BROWSER_RUNTIME_UNSUPPORTED",
					fix: "Use a Chromium CDP target with the Fetch domain enabled, or use the local Playwright browser runtime.",
				},
			);
		}

		try {
			return await run();
		} finally {
			unsubscribe();
			await this.pageClient.send("Fetch.disable");
		}
	}

	private async handleResourcePolicyPausedRequest(
		params: unknown,
		policy: BrowserResourcePolicy,
		allowedMethods: ReadonlySet<BrowserResourceMethod>,
	): Promise<void> {
		const requestId = getCdpPausedRequestId(params);
		if (requestId === null) {
			return;
		}

		try {
			const parsed = toCdpResourceRequest(params);
			if (!parsed || !allowedMethods.has(parsed.request.method)) {
				await this.failCdpResourceRequest(requestId);
				return;
			}

			for (const resourceRoute of policy.routes) {
				if (!matchesResourceRoute(resourceRoute.match, parsed.request)) {
					continue;
				}

				const decision = await resourceRoute.handle(parsed.request);
				switch (decision.action) {
					case "fulfill":
						await this.pageClient.send(
							"Fetch.fulfillRequest",
							toCdpFulfillParams(parsed.requestId, decision),
						);
						return;
					case "block":
						await this.failCdpResourceRequest(parsed.requestId);
						return;
				}
			}

			await this.failCdpResourceRequest(parsed.requestId);
		} catch {
			await this.failCdpResourceRequest(requestId);
		}
	}

	private async failCdpResourceRequest(requestId: string): Promise<void> {
		try {
			await this.pageClient.send("Fetch.failRequest", {
				errorReason: "BlockedByClient",
				requestId,
			});
		} catch (error) {
			if (error instanceof Error) {
				return;
			}
		}
	}

	private async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		this.pageClient.on("Runtime.executionContextCreated", (params) => {
			const context = getCdpExecutionContext(params);
			if (context.frameId && context.id !== undefined) {
				this.frameExecutionContexts.set(context.frameId, context.id);
			}
		});
		await this.pageClient.send("Page.enable");
		await this.pageClient.send("Runtime.enable");
		this.initialized = true;
	}

	private async getFrameExecutionContextId(frameId: string): Promise<number> {
		const existing = this.frameExecutionContexts.get(frameId);
		if (existing !== undefined) {
			return existing;
		}

		const result = await this.pageClient.send("Page.createIsolatedWorld", {
			frameId,
			grantUniveralAccess: true,
			worldName: "apifuse-provider-sdk",
		});
		const contextId = result.executionContextId;
		if (typeof contextId !== "number") {
			throw new Error(
				`Unable to resolve execution context for frame: ${frameId}`,
			);
		}

		this.frameExecutionContexts.set(frameId, contextId);
		return contextId;
	}

	private async waitForDocumentReady(
		deadline: number,
		isLoadEventSeen: () => boolean,
	): Promise<void> {
		while (Date.now() < deadline) {
			const readyState = await this.evaluate<string>("document.readyState");
			if (readyState === "complete" || readyState === "interactive") {
				if (isLoadEventSeen() || readyState === "complete") {
					return;
				}
			}

			await delay(SELECTOR_POLL_INTERVAL_MS);
		}

		throw new Error("Timed out waiting for page load");
	}
}

class CdpPoolBrowserClient implements SupportedBrowserClient {
	private readonly allowedHosts: string[];
	private readonly poolClient: JsonRpcWebSocketClient;
	readonly engine = "playwright-stealth" satisfies BrowserEngine;

	constructor(options: BrowserClientOptions) {
		if (!options.cdpUrl) {
			throw new ProviderError("CDP Pool URL is required", {
				code: "BROWSER_RUNTIME_UNSUPPORTED",
			});
		}

		this.allowedHosts = [...new Set(options.allowedHosts ?? [])];
		this.poolClient = new JsonRpcWebSocketClient(options.cdpUrl);
	}

	async newPage(): Promise<BrowserPageContract> {
		return await this.acquirePage({ isolatedContext: true });
	}

	private async acquirePage(options?: {
		isolatedContext?: boolean;
	}): Promise<BrowserPageContract> {
		const acquireResult = parsePoolAcquireResponse(
			await this.poolClient.send("acquire", {
				...(this.allowedHosts.length > 0
					? { allowedHosts: this.allowedHosts }
					: {}),
				...(options?.isolatedContext
					? { isolationMode: "browserContext" }
					: {}),
			}),
		);
		const pageClient = new JsonRpcWebSocketClient(acquireResult.wsEndpoint);
		const page = new CdpPoolBrowserPage(
			acquireResult.pageId,
			acquireResult.browserContextId,
			pageClient,
			async (request) => {
				await this.poolClient.send("release", request);
			},
		);

		try {
			await page.evaluate(
				`window.navigator.webdriver === true ? Object.defineProperty(window.navigator, "webdriver", { configurable: true, get: () => undefined }) : undefined`,
			);
		} catch (error) {
			await page.close().catch(() => undefined);
			throw error;
		}

		return page;
	}

	async rawPage(): Promise<BrowserPageContract> {
		return await this.newPage();
	}

	async withIsolatedContext<T>(
		handler: (page: BrowserPageContract) => Promise<T>,
	): Promise<T> {
		const page = await this.acquirePage({ isolatedContext: true });

		try {
			return await handler(page);
		} finally {
			await page.close();
		}
	}

	async close(): Promise<void> {
		await this.poolClient.close();
	}
}

class UnsupportedBrowserEngineClient implements SupportedBrowserClient {
	constructor(
		readonly engine: Extract<BrowserEngine, "nodriver" | "selenium-uc">,
	) {}

	async newPage(): Promise<never> {
		if (this.engine === "nodriver") {
			await loadNodriver();
			throw new ProviderError("nodriver engine requires Python runtime", {
				fix: "Use provider language: python and ctx.browser in Python",
			});
		}

		await loadSeleniumBase();
		throw new ProviderError("selenium-uc engine requires Python runtime", {
			fix: "Use provider language: python",
		});
	}

	async rawPage(): Promise<never> {
		return await this.newPage();
	}

	async withIsolatedContext<T>(): Promise<T> {
		return await this.newPage();
	}

	async close(): Promise<void> {}
}

function createPlaywrightStealthClient(
	options: BrowserClientOptions = {},
): SupportedBrowserClient {
	return new PlaywrightBrowserClient(options);
}

function createCdpPoolBrowserClient(
	options: BrowserClientOptions,
): SupportedBrowserClient {
	return new CdpPoolBrowserClient(options);
}

function createNodriverClient(): SupportedBrowserClient {
	return new UnsupportedBrowserEngineClient("nodriver");
}

function createSeleniumUCClient(): SupportedBrowserClient {
	return new UnsupportedBrowserEngineClient("selenium-uc");
}

export class BrowserClient implements BrowserClientContract {
	private readonly client: SupportedBrowserClient;
	private readonly cdpUrl?: string;
	private activePage?: BrowserPageContract;
	private readonly activePages = new Set<BrowserPageContract>();
	private readonly _engine: BrowserEngine;

	constructor(options: BrowserClientOptions = {}) {
		const resolvedOptions = {
			...options,
			cdpUrl: options.cdpUrl ?? getDefaultCdpPoolUrl(),
		};
		const engine = resolvedOptions.engine ?? "playwright-stealth";
		this._engine = engine;
		this.cdpUrl = resolvedOptions.cdpUrl;

		if (resolvedOptions.requireCdpPool && !resolvedOptions.cdpUrl) {
			throw new ProviderError(
				"Managed CDP Pool is required for browser providers in production",
				{
					code: "BROWSER_CDP_POOL_REQUIRED",
					fix: "Set APIFUSE__CDP_POOL__URL for deployed browser providers. Local standalone development may omit it.",
				},
			);
		}

		switch (engine) {
			case "nodriver":
				this.client = createNodriverClient();
				break;
			case "selenium-uc":
				this.client = createSeleniumUCClient();
				break;
			default:
				this.client = resolvedOptions.cdpUrl
					? createCdpPoolBrowserClient(resolvedOptions)
					: createPlaywrightStealthClient(resolvedOptions);
		}
	}

	get engine(): BrowserEngine {
		return this._engine;
	}

	async newPage(): Promise<BrowserPageContract> {
		const page = await this.client.newPage();
		return this.activatePage(page);
	}

	async rawPage(): Promise<BrowserPageContract> {
		if (!this.cdpUrl) {
			throw new ProviderError("ctx.browser.rawPage() requires a CDP pool", {
				code: "BROWSER_RUNTIME_UNSUPPORTED",
				fix: "Set APIFUSE__CDP_POOL__URL. The SDK escape hatch is CDP pool-backed only and never launches local Chromium.",
			});
		}

		const page = await this.client.rawPage();
		return this.activatePage(page);
	}

	async withIsolatedContext<T>(
		handler: (page: BrowserPageContract) => Promise<T>,
	): Promise<T> {
		const previousActivePage = this.activePage;
		let trackedPage: BrowserPageContract | undefined;

		return await this.client.withIsolatedContext(async (page) => {
			trackedPage = this.activatePage(page);
			try {
				return await handler(trackedPage);
			} finally {
				this.activePages.delete(trackedPage);
				if (this.activePage === trackedPage) {
					this.activePage = previousActivePage;
				}
			}
		});
	}

	private activatePage(page: BrowserPageContract): BrowserPageContract {
		let closed = false;
		const originalClose = page.close.bind(page);
		const trackedPage = new Proxy(page, {
			get: (target, property, receiver) => {
				if (property === "close") {
					return async () => {
						if (closed) return;
						closed = true;
						try {
							await originalClose();
						} finally {
							this.activePages.delete(trackedPage);
							if (this.activePage === trackedPage) {
								this.activePage = undefined;
							}
						}
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		this.activePages.add(trackedPage);
		this.activePage = trackedPage;
		return trackedPage;
	}

	async solveChallenge(
		request: BrowserChallengeRequest,
	): Promise<BrowserChallengeResult> {
		if (request.type !== "recaptcha") {
			throw new ProviderError(
				`Unsupported browser challenge: ${request.type}`,
				{
					code: "BROWSER_RUNTIME_UNSUPPORTED",
				},
			);
		}

		if (this.activePage) {
			return await solveRecaptchaChallenge(this.activePage, request);
		}

		const page = await this.client.newPage();
		try {
			return await solveRecaptchaChallenge(page, request);
		} finally {
			if (this.activePage === page) {
				this.activePage = undefined;
			}
			await page.close();
		}
	}

	async close(): Promise<void> {
		const pages = Array.from(this.activePages);
		this.activePages.clear();
		this.activePage = undefined;
		try {
			await Promise.all(pages.map((page) => page.close()));
		} finally {
			await this.client.close();
		}
	}
}

async function solveRecaptchaChallenge(
	page: BrowserPageContract,
	request: BrowserChallengeRequest,
): Promise<BrowserChallengeResult> {
	const timeout = request.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
	const deadline = Date.now() + timeout;

	while (Date.now() < deadline) {
		const frames = await page.frames();
		const recaptchaFrame = await findRecaptchaFrame(frames, request.siteKey);
		if (recaptchaFrame) {
			await recaptchaFrame.locator("#recaptcha-anchor").click();
			return {
				type: "recaptcha",
				solved: true,
				frameUrl: await recaptchaFrame.url(),
			};
		}

		await delay(SELECTOR_POLL_INTERVAL_MS);
	}

	throw new Error("Timed out waiting for reCAPTCHA iframe");
}

async function findRecaptchaFrame(
	frames: BrowserFrame[],
	siteKey?: string,
): Promise<BrowserFrame | undefined> {
	for (const frame of frames) {
		const url = await frame.url();
		const matchesRecaptcha =
			url.includes("google.com/recaptcha") ||
			url.includes("recaptcha.net/recaptcha");
		const matchesSiteKey = !siteKey || url.includes(siteKey);
		if (matchesRecaptcha && matchesSiteKey) {
			return frame;
		}
	}

	return undefined;
}

export function createBrowserClient(
	options: BrowserClientOptions = {},
): BrowserClient {
	return new BrowserClient(options);
}
