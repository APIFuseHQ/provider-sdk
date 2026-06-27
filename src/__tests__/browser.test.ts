import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

type LaunchCall = {
	args?: string[];
	executablePath?: string;
	headless?: boolean;
	proxy?: { server: string };
};

type MockPlaywrightPage = {
	click: (selector: string) => Promise<void>;
	close: () => Promise<void>;
	content: () => Promise<string>;
	evaluate: <T>(fn: string | (() => T)) => Promise<T>;
	fill: (selector: string, text: string) => Promise<void>;
	frames: () => MockPlaywrightFrame[];
	goto: (url: string) => Promise<void>;
	locator: (selector: string) => MockPlaywrightLocator;
	screenshot: (options?: { fullPage?: boolean }) => Promise<Buffer>;
	title: () => Promise<string>;
	type: (selector: string, text: string) => Promise<void>;
	url: () => string;
	waitForSelector: (
		selector: string,
		options?: { timeout?: number },
	) => Promise<void>;
	state: {
		clicks: string[];
		closed: boolean;
		content: string;
		fills: Array<{ selector: string; text: string }>;
		gotoUrls: string[];
		screenshots: Array<{ fullPage?: boolean }>;
		types: Array<{ selector: string; text: string }>;
		waits: Array<{ selector: string; timeout?: number }>;
	};
};

type MockPlaywrightLocator = {
	click: () => Promise<void>;
	fill: (value: string) => Promise<void>;
	textContent: () => Promise<string | null>;
	waitFor: (options?: { timeout?: number }) => Promise<void>;
};

type MockPlaywrightFrame = {
	content: () => Promise<string>;
	evaluate: <T>(fn: string | (() => T)) => Promise<T>;
	locator: (selector: string) => MockPlaywrightLocator;
	name: () => string;
	parentFrame: () => MockPlaywrightFrame | null;
	url: () => string;
	state: {
		clicks: string[];
		url: string;
	};
};

type MockBrowserState = {
	browser: {
		close: () => Promise<void>;
		isConnected: () => boolean;
		newContext: () => Promise<MockBrowserContext>;
		newPage: () => Promise<MockPlaywrightPage>;
	};
	closeCalls: number;
	connected: boolean;
	contexts: MockBrowserContext[];
	newPageCalls: number;
	pages: MockPlaywrightPage[];
	launchOptions?: LaunchCall;
};

type MockBrowserContext = {
	close: () => Promise<void>;
	newPage: () => Promise<MockPlaywrightPage>;
	state: {
		closeCalls: number;
		newPageCalls: number;
		pages: MockPlaywrightPage[];
	};
};

const browserState = {
	browsers: [] as MockBrowserState[],
	launchCalls: [] as LaunchCall[],
	requireError: null as Error | null,
};

const stealthState = {
	callCount: 0,
	pluginFactoryCalls: 0,
	pages: [] as MockPlaywrightPage[],
	useCalls: 0,
};

const optionalModuleState = {
	nodriverError: null as Error | null,
	nodriverImports: 0,
	seleniumBaseError: null as Error | null,
	seleniumBaseImports: 0,
};

const cdpState = {
	acquireCalls: 0,
	acquireParams: [] as Array<Record<string, unknown> | undefined>,
	clicks: [] as string[],
	closedEndpoints: [] as string[],
	focusedSelectors: [] as string[],
	insertedTexts: [] as string[],
	frameClicks: [] as string[],
	frameContextIds: [] as number[],
	failWebdriverPatch: false,
	navigateUrls: [] as string[],
	poolReleaseCalls: [] as string[],
	poolReleaseRequests: [] as Array<Record<string, unknown>>,
	runtimeEnabled: 0,
	pageEnabled: 0,
	screenshotCalls: [] as boolean[],
	webdriverPatches: 0,
};

const originalWebSocket = globalThis.WebSocket;
const originalCdpPoolUrl = process.env.APIFUSE__CDP_POOL__URL;

function createMockPlaywrightPage(): MockPlaywrightPage {
	const recaptchaFrame: MockPlaywrightFrame = {
		state: {
			clicks: [] as string[],
			url: "https://www.google.com/recaptcha/api2/anchor?k=site-key",
		},
		async content() {
			return '<html><body><span id="recaptcha-anchor"></span></body></html>';
		},
		async evaluate<T>(fn: string | (() => T)) {
			if (typeof fn === "function") {
				return fn();
			}
			if (fn === "document.title") {
				return "recaptcha-title" as T;
			}
			if (fn === "window.location.href") {
				return recaptchaFrame.state.url as T;
			}
			throw new Error(`Unexpected frame evaluate expression: ${fn}`);
		},
		locator(selector) {
			return {
				async click() {
					recaptchaFrame.state.clicks.push(selector);
				},
				async fill() {},
				async textContent() {
					return "recaptcha";
				},
				async waitFor() {},
			};
		},
		name: () => "recaptcha",
		parentFrame: () => null,
		url: () => recaptchaFrame.state.url,
	};
	const state = {
		clicks: [] as string[],
		closed: false,
		content: "<html><body>local</body></html>",
		fills: [] as Array<{ selector: string; text: string }>,
		gotoUrls: [] as string[],
		screenshots: [] as Array<{ fullPage?: boolean }>,
		types: [] as Array<{ selector: string; text: string }>,
		waits: [] as Array<{ selector: string; timeout?: number }>,
	};

	return {
		state,
		async click(selector) {
			state.clicks.push(selector);
		},
		async close() {
			state.closed = true;
		},
		async content() {
			return state.content;
		},
		async evaluate<T>(fn: string | (() => T)) {
			if (typeof fn === "function") {
				return fn();
			}

			if (fn === "document.title") {
				return "local-title" as T;
			}

			throw new Error(`Unexpected local evaluate expression: ${fn}`);
		},
		async fill(selector, text) {
			state.fills.push({ selector, text });
		},
		frames() {
			return [recaptchaFrame];
		},
		async goto(url) {
			state.gotoUrls.push(url);
		},
		locator(selector) {
			return {
				async click() {
					state.clicks.push(selector);
				},
				async fill(value) {
					state.fills.push({ selector, text: value });
				},
				async textContent() {
					return "local text";
				},
				async waitFor(options) {
					state.waits.push({ selector, timeout: options?.timeout });
				},
			};
		},
		async screenshot(options) {
			state.screenshots.push(options ?? {});
			return Buffer.from("local-shot");
		},
		async title() {
			return "local-title";
		},
		async type(selector, text) {
			state.types.push({ selector, text });
		},
		url() {
			return state.gotoUrls.at(-1) ?? "about:blank";
		},
		async waitForSelector(selector, options) {
			state.waits.push({ selector, timeout: options?.timeout });
		},
	};
}

function createMockBrowserLauncher(
	options: { applyStealthOnPage?: () => boolean } = {},
) {
	return {
		launch: async (launchOptions: LaunchCall = {}) => {
			browserState.launchCalls.push(launchOptions);

			const state: MockBrowserState = {
				connected: true,
				closeCalls: 0,
				contexts: [],
				newPageCalls: 0,
				pages: [],
				launchOptions,
				browser: {
					close: async () => {
						state.closeCalls += 1;
						state.connected = false;
					},
					isConnected: () => state.connected,
					newContext: async () => {
						const contextState = {
							closeCalls: 0,
							newPageCalls: 0,
							pages: [] as MockPlaywrightPage[],
						};
						const context: MockBrowserContext = {
							state: contextState,
							close: async () => {
								contextState.closeCalls += 1;
							},
							newPage: async () => {
								contextState.newPageCalls += 1;
								const page = createMockPlaywrightPage();
								contextState.pages.push(page);
								if (options.applyStealthOnPage?.()) {
									stealthState.callCount += 1;
									stealthState.pages.push(page);
								}
								return page;
							},
						};
						state.contexts.push(context);
						return context;
					},
					newPage: async () => {
						state.newPageCalls += 1;
						const page = createMockPlaywrightPage();
						state.pages.push(page);
						if (options.applyStealthOnPage?.()) {
							stealthState.callCount += 1;
							stealthState.pages.push(page);
						}
						return page;
					},
				},
			};

			browserState.browsers.push(state);
			return state.browser;
		},
	};
}

function registerBrowserMocks() {
	mock.module("playwright", () => {
		if (browserState.requireError) {
			throw browserState.requireError;
		}

		return {
			chromium: createMockBrowserLauncher(),
		};
	});

	mock.module("playwright-extra", () => {
		if (browserState.requireError) {
			throw browserState.requireError;
		}

		const plugins: unknown[] = [];
		return {
			chromium: {
				...createMockBrowserLauncher({
					applyStealthOnPage: () => plugins.length > 0,
				}),
				use(plugin: unknown) {
					plugins.push(plugin);
					stealthState.useCalls += 1;
					return this;
				},
			},
		};
	});

	mock.module("puppeteer-extra-plugin-stealth", () => ({
		default: () => {
			stealthState.pluginFactoryCalls += 1;
			return { _isPuppeteerExtraPlugin: true, name: "stealth" };
		},
	}));

	mock.module("nodriver", () => {
		optionalModuleState.nodriverImports += 1;
		if (optionalModuleState.nodriverError) {
			throw optionalModuleState.nodriverError;
		}

		return {};
	});

	mock.module("seleniumbase", () => {
		optionalModuleState.seleniumBaseImports += 1;
		if (optionalModuleState.seleniumBaseError) {
			throw optionalModuleState.seleniumBaseError;
		}

		return {};
	});
}

function parseSelector(expression: string): string | null {
	const match = expression.match(/document\.querySelector\((".*?")\)/);
	if (!match?.[1]) {
		return null;
	}

	return JSON.parse(match[1]) as string;
}

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	readyState = MockWebSocket.CONNECTING;
	private listeners = new Map<
		string,
		Set<(event?: { data?: string }) => void>
	>();

	constructor(private readonly endpoint: string) {
		queueMicrotask(() => {
			this.readyState = MockWebSocket.OPEN;
			this.emit("open");
		});
	}

	addEventListener(
		event: string,
		listener: (event?: { data?: string }) => void,
	) {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
	}

	close() {
		this.readyState = MockWebSocket.CLOSED;
		cdpState.closedEndpoints.push(this.endpoint);
		this.emit("close");
	}

	send(raw: string) {
		const message = JSON.parse(raw) as {
			id: number;
			method: string;
			params?: Record<string, unknown>;
		};

		if (
			this.endpoint === "ws://pool.test" ||
			this.endpoint === "ws://pool.test/"
		) {
			this.handlePoolMessage(message);
			return;
		}

		this.handlePageMessage(message);
	}

	private emit(event: string, payload?: { data?: string }) {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(payload);
		}
	}

	private reply(id: number, result: Record<string, unknown>) {
		this.emit("message", {
			data: JSON.stringify({ id, jsonrpc: "2.0", result }),
		});
	}

	private emitPageEvent(method: string, params: Record<string, unknown> = {}) {
		this.emit("message", {
			data: JSON.stringify({ jsonrpc: "2.0", method, params }),
		});
	}

	private handlePoolMessage(message: {
		id: number;
		method: string;
		params?: Record<string, unknown>;
	}) {
		switch (message.method) {
			case "acquire": {
				cdpState.acquireCalls += 1;
				const pageNumber = cdpState.acquireCalls;
				cdpState.acquireParams.push(message.params);
				this.reply(message.id, {
					...(message.params?.isolationMode === "browserContext"
						? { browserContextId: `pool-context-${pageNumber}` }
						: {}),
					pageId: `pool-page-${pageNumber}`,
					wsEndpoint: `ws://page.test/devtools/page/pool-page-${pageNumber}`,
				});
				break;
			}
			case "release":
				cdpState.poolReleaseCalls.push(String(message.params?.pageId ?? ""));
				cdpState.poolReleaseRequests.push(message.params ?? {});
				this.reply(message.id, { released: true });
				break;
			default:
				this.reply(message.id, {});
		}
	}

	private handlePageMessage(message: {
		id: number;
		method: string;
		params?: Record<string, unknown>;
	}) {
		switch (message.method) {
			case "Page.enable":
				cdpState.pageEnabled += 1;
				this.reply(message.id, {});
				break;
			case "Runtime.enable":
				cdpState.runtimeEnabled += 1;
				this.reply(message.id, {});
				break;
			case "Page.getFrameTree":
				this.reply(message.id, {
					frameTree: {
						frame: {
							id: "main-frame",
							url: "https://bank.example.com/login",
						},
						childFrames: [
							{
								frame: {
									id: "recaptcha-frame",
									name: "recaptcha",
									parentId: "main-frame",
									url: "https://www.google.com/recaptcha/api2/anchor?k=site-key",
								},
							},
						],
					},
				});
				break;
			case "Page.createIsolatedWorld":
				this.reply(message.id, {
					executionContextId:
						message.params?.frameId === "recaptcha-frame" ? 42 : 7,
				});
				break;
			case "Page.navigate":
				cdpState.navigateUrls.push(String(message.params?.url ?? ""));
				this.reply(message.id, {});
				queueMicrotask(() => this.emitPageEvent("Page.loadEventFired"));
				break;
			case "Runtime.evaluate": {
				const expression = String(message.params?.expression ?? "");
				const contextId =
					typeof message.params?.contextId === "number"
						? message.params.contextId
						: undefined;
				const selector = parseSelector(expression);
				if (contextId !== undefined) {
					cdpState.frameContextIds.push(contextId);
				}

				if (expression.includes('window.navigator, "webdriver"')) {
					if (cdpState.failWebdriverPatch) {
						this.emit("message", {
							data: JSON.stringify({
								error: { code: -32000, message: "Runtime init failed" },
								id: message.id,
								jsonrpc: "2.0",
							}),
						});
						break;
					}

					cdpState.webdriverPatches += 1;
					this.reply(message.id, { result: { value: undefined } });
					break;
				}

				if (contextId === 42 && expression === "window.location.href") {
					this.reply(message.id, {
						result: {
							value: "https://www.google.com/recaptcha/api2/anchor?k=site-key",
						},
					});
					break;
				}

				if (expression === "document.readyState") {
					this.reply(message.id, { result: { value: "complete" } });
					break;
				}

				if (expression === "document.documentElement.outerHTML") {
					this.reply(message.id, {
						result: { value: '<html><body><input id="name" /></body></html>' },
					});
					break;
				}

				if (expression === "document.title") {
					this.reply(message.id, { result: { value: "remote-title" } });
					break;
				}

				if (expression.includes("Boolean(document.querySelector")) {
					this.reply(message.id, { result: { value: Boolean(selector) } });
					break;
				}

				if (expression.includes("?.textContent ?? null")) {
					this.reply(message.id, { result: { value: null } });
					break;
				}

				if (expression.includes("element.click()") && selector) {
					if (contextId === 42) {
						cdpState.frameClicks.push(selector);
					} else {
						cdpState.clicks.push(selector);
					}
					this.reply(message.id, { result: { value: undefined } });
					break;
				}

				if (expression.includes("element.focus()") && selector) {
					cdpState.focusedSelectors.push(selector);
					this.reply(message.id, { result: { value: undefined } });
					break;
				}

				this.reply(message.id, { result: { value: undefined } });
				break;
			}
			case "Input.insertText":
				cdpState.insertedTexts.push(String(message.params?.text ?? ""));
				this.reply(message.id, {});
				break;
			case "Page.captureScreenshot":
				cdpState.screenshotCalls.push(
					Boolean(message.params?.captureBeyondViewport),
				);
				this.reply(message.id, {
					data: Buffer.from("remote-shot").toString("base64"),
				});
				break;
			default:
				this.reply(message.id, {});
		}
	}
}

describe("createBrowserClient", () => {
	beforeEach(() => {
		browserState.browsers.length = 0;
		browserState.launchCalls.length = 0;
		browserState.requireError = null;
		stealthState.callCount = 0;
		stealthState.pluginFactoryCalls = 0;
		stealthState.pages.length = 0;
		stealthState.useCalls = 0;
		optionalModuleState.nodriverError = null;
		optionalModuleState.nodriverImports = 0;
		optionalModuleState.seleniumBaseError = null;
		optionalModuleState.seleniumBaseImports = 0;
		cdpState.acquireCalls = 0;
		cdpState.acquireParams.length = 0;
		cdpState.clicks.length = 0;
		cdpState.closedEndpoints.length = 0;
		cdpState.focusedSelectors.length = 0;
		cdpState.frameClicks.length = 0;
		cdpState.frameContextIds.length = 0;
		cdpState.failWebdriverPatch = false;
		cdpState.insertedTexts.length = 0;
		cdpState.navigateUrls.length = 0;
		cdpState.poolReleaseCalls.length = 0;
		cdpState.poolReleaseRequests.length = 0;
		cdpState.runtimeEnabled = 0;
		cdpState.pageEnabled = 0;
		cdpState.screenshotCalls.length = 0;
		cdpState.webdriverPatches = 0;
		process.env.APIFUSE__CDP_POOL__URL = undefined;
		globalThis.WebSocket = originalWebSocket;
		registerBrowserMocks();
	});

	afterEach(() => {
		if (originalCdpPoolUrl === undefined) {
			delete process.env.APIFUSE__CDP_POOL__URL;
		} else {
			process.env.APIFUSE__CDP_POOL__URL = originalCdpPoolUrl;
		}

		globalThis.WebSocket = originalWebSocket;
	});

	it("throws ProviderError with install hint when the stealth browser launcher is unavailable", async () => {
		browserState.requireError = Object.assign(
			new Error("Cannot find module 'playwright'"),
			{
				code: "MODULE_NOT_FOUND",
			},
		);
		registerBrowserMocks();

		const { ProviderError } = await import("../errors");
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const pagePromise = client.newPage();

		await expect(pagePromise).rejects.toBeInstanceOf(ProviderError);
		await expect(pagePromise).rejects.toMatchObject({
			fix: "Run: bun add playwright-extra puppeteer-extra-plugin-stealth",
			message: "playwright-extra is not installed",
		});
	});

	it("throws ProviderError with install hint for ESM missing Playwright when stealth is disabled", async () => {
		browserState.requireError = Object.assign(
			new Error(
				"Cannot find package 'playwright' imported from runtime/browser",
			),
			{
				code: "ERR_MODULE_NOT_FOUND",
			},
		);
		registerBrowserMocks();

		const { ProviderError } = await import("../errors");
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient({ stealth: false });
		const pagePromise = client.newPage();

		await expect(pagePromise).rejects.toBeInstanceOf(ProviderError);
		await expect(pagePromise).rejects.toMatchObject({
			fix: "Run: bun add playwright",
			message: "Playwright is not installed",
		});
	});

	it("falls back to local Playwright and implements browser page methods", async () => {
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();

		const page = (await client.newPage()) as {
			click(selector: string): Promise<void>;
			content(): Promise<string>;
			evaluate<T>(fn: string | (() => T)): Promise<T>;
			fill(selector: string, text: string): Promise<void>;
			frames(): Promise<Array<{ url(): Promise<string> }>>;
			goto(url: string): Promise<void>;
			locator(selector: string): {
				textContent(): Promise<string | null>;
				waitFor(options?: { timeout?: number }): Promise<void>;
			};
			screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
			title(): Promise<string>;
			type(selector: string, text: string): Promise<void>;
			url(): Promise<string>;
			waitForSelector(
				selector: string,
				options?: { timeout?: number },
			): Promise<void>;
			close(): Promise<void>;
		};

		await page.goto("https://example.com/login");
		await page.waitForSelector("#email", { timeout: 1234 });
		await page.click("button[type=submit]");
		await page.type("#email", "demo@example.com");
		await page.fill("#otp", "123456");
		const html = await page.content();
		const title = await page.evaluate<string>("document.title");
		const pageTitle = await page.title();
		const currentUrl = await page.url();
		const frames = await page.frames();
		const frameUrl = await frames[0]?.url();
		await page.locator("#status").waitFor({ timeout: 99 });
		const locatorText = await page.locator("#status").textContent();
		const challenge = await client.solveChallenge({
			type: "recaptcha",
			siteKey: "site-key",
		});
		const screenshot = await page.screenshot({ fullPage: true });
		await page.close();

		expect(browserState.launchCalls).toEqual([
			{
				args: undefined,
				executablePath: undefined,
				headless: true,
				proxy: undefined,
			},
		]);
		expect(stealthState.callCount).toBe(1);
		expect(stealthState.pages).toHaveLength(1);
		expect(browserState.browsers[0]?.newPageCalls).toBe(1);
		expect(browserState.browsers[0]?.pages[0]?.state.gotoUrls).toEqual([
			"https://example.com/login",
		]);
		expect(browserState.browsers[0]?.pages[0]?.state.waits).toEqual([
			{ selector: "#email", timeout: 1234 },
			{ selector: "#status", timeout: 99 },
		]);
		expect(browserState.browsers[0]?.pages[0]?.state.clicks).toEqual([
			"button[type=submit]",
		]);
		expect(browserState.browsers[0]?.pages[0]?.state.types).toEqual([
			{ selector: "#email", text: "demo@example.com" },
		]);
		expect(browserState.browsers[0]?.pages[0]?.state.fills).toEqual([
			{ selector: "#email", text: "" },
			{ selector: "#otp", text: "123456" },
		]);
		expect(html).toBe("<html><body>local</body></html>");
		expect(title).toBe("local-title");
		expect(pageTitle).toBe("local-title");
		expect(currentUrl).toBe("https://example.com/login");
		expect(frameUrl).toBe(
			"https://www.google.com/recaptcha/api2/anchor?k=site-key",
		);
		expect(locatorText).toBe("local text");
		expect(challenge).toEqual({
			type: "recaptcha",
			solved: true,
			frameUrl: "https://www.google.com/recaptcha/api2/anchor?k=site-key",
		});
		expect(screenshot.toString()).toBe("local-shot");
		expect(browserState.browsers[0]?.pages[0]?.state.closed).toBeTrue();
	});

	it("requires the managed CDP pool when production mode is explicit", async () => {
		const { ProviderError } = await import("../errors");
		const { createBrowserClient } = await import("../runtime/browser");

		expect(() => createBrowserClient({ requireCdpPool: true })).toThrow(
			ProviderError,
		);
		expect(() => createBrowserClient({ requireCdpPool: true })).toThrow(
			"Managed CDP Pool is required for browser providers in production",
		);
		expect(browserState.launchCalls).toHaveLength(0);
	});

	it("uses local Playwright for isolated contexts outside production pool mode", async () => {
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();

		const title = await client.withIsolatedContext(async (page) => {
			await page.goto("https://example.com/account");
			return await page.title();
		});

		expect(title).toBe("local-title");
		expect(browserState.launchCalls).toHaveLength(1);
		expect(browserState.browsers[0]?.contexts).toHaveLength(1);
		expect(browserState.browsers[0]?.contexts[0]?.state.newPageCalls).toBe(1);
		expect(
			browserState.browsers[0]?.contexts[0]?.state.pages[0]?.state.closed,
		).toBeTrue();
		expect(browserState.browsers[0]?.contexts[0]?.state.closeCalls).toBe(1);
	});

	it("closes the page it creates for standalone challenge solving", async () => {
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();

		const challenge = await client.solveChallenge({
			type: "recaptcha",
			siteKey: "site-key",
		});

		expect(challenge).toEqual({
			type: "recaptcha",
			solved: true,
			frameUrl: "https://www.google.com/recaptcha/api2/anchor?k=site-key",
		});
		expect(browserState.browsers[0]?.newPageCalls).toBe(1);
		expect(browserState.browsers[0]?.pages[0]?.state.closed).toBeTrue();
	});

	it("does not reuse a closed active page for later challenge solving", async () => {
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();

		await page.close();
		const challenge = await client.solveChallenge({
			type: "recaptcha",
			siteKey: "site-key",
		});

		expect(challenge).toEqual({
			type: "recaptcha",
			solved: true,
			frameUrl: "https://www.google.com/recaptcha/api2/anchor?k=site-key",
		});
		expect(browserState.browsers[0]?.newPageCalls).toBe(2);
		expect(browserState.browsers[0]?.pages[0]?.state.closed).toBeTrue();
		expect(browserState.browsers[0]?.pages[1]?.state.closed).toBeTrue();
	});

	it("passes launch options through and can disable stealth", async () => {
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient({
			extraArgs: ["--disable-dev-shm-usage"],
			executablePath:
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			headless: false,
			proxy: "http://127.0.0.1:8080",
			stealth: false,
		});

		await client.newPage();

		expect(browserState.launchCalls).toEqual([
			{
				args: ["--disable-dev-shm-usage"],
				executablePath:
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				headless: false,
				proxy: { server: "http://127.0.0.1:8080" },
			},
		]);
		expect(stealthState.callCount).toBe(0);
	});

	it("uses CDP Pool when APIFUSE__CDP_POOL__URL is configured", async () => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "http://pool.test";

		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient({
			allowedHosts: ["bank.example.com", "www.google.com"],
		});
		const page = (await client.newPage()) as {
			pageId: string;
			click(selector: string): Promise<void>;
			content(): Promise<string>;
			evaluate<T>(fn: string | (() => T)): Promise<T>;
			frames(): Promise<
				Array<{ url(): Promise<string>; title(): Promise<string> }>
			>;
			goto(url: string): Promise<void>;
			locator(selector: string): { textContent(): Promise<string | null> };
			screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
			title(): Promise<string>;
			type(selector: string, text: string): Promise<void>;
			url(): Promise<string>;
			waitForSelector(selector: string): Promise<void>;
			close(): Promise<void>;
		};

		await page.goto("https://bank.example.com/login");
		await page.waitForSelector("#name");
		await page.click("#submit");
		await page.type("#name", "demo");
		const title = await page.evaluate<string>("document.title");
		const pageTitle = await page.title();
		const currentUrl = await page.url();
		const frames = await page.frames();
		const frameUrl = await frames[1]?.url();
		const locatorText = await page.locator("#name").textContent();
		const challenge = await client.solveChallenge({
			type: "recaptcha",
			siteKey: "site-key",
		});
		const html = await page.content();
		const screenshot = await page.screenshot({ fullPage: true });
		await page.close();
		await client.close();

		expect(page.pageId).toBe("pool-page-1");
		expect(browserState.launchCalls).toHaveLength(0);
		expect(cdpState.acquireCalls).toBe(1);
		expect(cdpState.acquireParams).toEqual([
			{
				allowedHosts: ["bank.example.com", "www.google.com"],
				isolationMode: "browserContext",
			},
		]);
		expect(cdpState.pageEnabled).toBe(1);
		expect(cdpState.runtimeEnabled).toBe(1);
		expect(cdpState.webdriverPatches).toBe(1);
		expect(cdpState.navigateUrls).toEqual(["https://bank.example.com/login"]);
		expect(cdpState.clicks).toEqual(["#submit"]);
		expect(cdpState.focusedSelectors).toEqual(["#name"]);
		expect(cdpState.insertedTexts).toEqual(["demo"]);
		expect(cdpState.screenshotCalls).toEqual([true]);
		expect(cdpState.poolReleaseCalls).toEqual(["pool-page-1"]);
		expect(title).toBe("remote-title");
		expect(pageTitle).toBe("remote-title");
		expect(currentUrl).toBe("https://bank.example.com/login");
		expect(frameUrl).toBe(
			"https://www.google.com/recaptcha/api2/anchor?k=site-key",
		);
		expect(locatorText).toBeNull();
		expect(challenge).toEqual({
			type: "recaptcha",
			solved: true,
			frameUrl: "https://www.google.com/recaptcha/api2/anchor?k=site-key",
		});
		expect(cdpState.frameClicks).toEqual(["#recaptcha-anchor"]);
		expect(cdpState.frameContextIds).toContain(42);
		expect(html).toContain('<input id="name" />');
		expect(screenshot.toString()).toBe("remote-shot");
		expect(cdpState.closedEndpoints).toContain(
			"ws://page.test/devtools/page/pool-page-1",
		);
		expect(cdpState.closedEndpoints).toContain("ws://pool.test/");
	});

	it("enforces the CDP pool for rawPage and never launches local Chromium", async () => {
		const { ProviderError } = await import("../errors");
		const { createBrowserClient } = await import("../runtime/browser");
		const localClient = createBrowserClient();

		await expect(localClient.rawPage()).rejects.toBeInstanceOf(ProviderError);
		await expect(localClient.rawPage()).rejects.toMatchObject({
			message: "ctx.browser.rawPage() requires a CDP pool",
		});
		expect(browserState.launchCalls).toHaveLength(0);

		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "ws://pool.test";
		const cdpClient = createBrowserClient();
		const page = await cdpClient.rawPage();
		await page.close();
		await cdpClient.close();

		expect(browserState.launchCalls).toHaveLength(0);
		expect(cdpState.acquireCalls).toBe(1);
		expect(cdpState.poolReleaseCalls).toEqual(["pool-page-1"]);
	});

	it("releases a pool lease exactly once when page.close() is repeated", async () => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "ws://pool.test";
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();

		await page.close();
		await page.close();
		await client.close();

		expect(cdpState.acquireCalls).toBe(1);
		expect(cdpState.poolReleaseCalls).toEqual(["pool-page-1"]);
	});

	it("releases a pool lease exactly once when browser.close() owns the active page", async () => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "ws://pool.test";
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();

		await client.newPage();
		await client.close();
		await client.close();

		expect(cdpState.acquireCalls).toBe(1);
		expect(cdpState.poolReleaseCalls).toEqual(["pool-page-1"]);
	});

	it("releases every tracked pool lease when browser.close() owns multiple pages", async () => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "ws://pool.test";
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();

		await client.newPage();
		await client.rawPage();
		await client.close();
		await client.close();

		expect(cdpState.acquireCalls).toBe(2);
		expect(cdpState.poolReleaseCalls).toEqual(["pool-page-1", "pool-page-2"]);
		expect(cdpState.closedEndpoints).toContain(
			"ws://page.test/devtools/page/pool-page-1",
		);
		expect(cdpState.closedEndpoints).toContain(
			"ws://page.test/devtools/page/pool-page-2",
		);
	});

	it("uses isolated browser context pool acquire and disposes it after success", async () => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "ws://pool.test";
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();

		const title = await client.withIsolatedContext(async (page) => {
			await page.goto("https://bank.example.com/account");
			return await page.title();
		});
		await client.close();

		expect(title).toBe("remote-title");
		expect(cdpState.acquireParams).toEqual([
			{ isolationMode: "browserContext" },
		]);
		expect(cdpState.poolReleaseCalls).toEqual(["pool-page-1"]);
		expect(cdpState.poolReleaseRequests).toEqual([
			{ browserContextId: "pool-context-1", pageId: "pool-page-1" },
		]);
	});

	it("cleans up isolated browser context pool leases when the handler fails", async () => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "ws://pool.test";
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();

		await expect(
			client.withIsolatedContext(async (page) => {
				await page.title();
				throw new Error("parse failed");
			}),
		).rejects.toThrow("parse failed");
		await client.close();

		expect(cdpState.acquireParams).toEqual([
			{ isolationMode: "browserContext" },
		]);
		expect(cdpState.poolReleaseCalls).toEqual(["pool-page-1"]);
		expect(cdpState.poolReleaseRequests).toEqual([
			{ browserContextId: "pool-context-1", pageId: "pool-page-1" },
		]);
	});

	it("releases isolated pool leases when page initialization fails", async () => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "ws://pool.test";
		cdpState.failWebdriverPatch = true;
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();

		await expect(
			client.withIsolatedContext(async () => undefined),
		).rejects.toThrow("Runtime init failed");
		await client.close();

		expect(cdpState.acquireParams).toEqual([
			{ isolationMode: "browserContext" },
		]);
		expect(cdpState.poolReleaseCalls).toEqual(["pool-page-1"]);
		expect(cdpState.poolReleaseRequests).toEqual([
			{ browserContextId: "pool-context-1", pageId: "pool-page-1" },
		]);
		expect(cdpState.closedEndpoints).toContain(
			"ws://page.test/devtools/page/pool-page-1",
		);
	});

	it("exposes the resolved engine on the browser client", async () => {
		const { createBrowserClient } = await import("../runtime/browser");
		const defaultClient = createBrowserClient();
		const nodriverClient = createBrowserClient({ engine: "nodriver" });

		expect(defaultClient.engine).toBe("playwright-stealth");
		expect(nodriverClient.engine).toBe("nodriver");
	});

	it("throws a Python runtime error for the nodriver engine", async () => {
		const { ProviderError } = await import("../errors");
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient({ engine: "nodriver" });
		const pagePromise = client.newPage();

		await expect(pagePromise).rejects.toBeInstanceOf(ProviderError);
		await expect(pagePromise).rejects.toMatchObject({
			fix: "Use provider language: python and ctx.browser in Python",
			message: "nodriver engine requires Python runtime",
		});
		expect(optionalModuleState.nodriverImports).toBe(1);
	});

	it("throws a Python runtime error for the selenium-uc engine", async () => {
		const { ProviderError } = await import("../errors");
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient({ engine: "selenium-uc" });
		const pagePromise = client.newPage();

		await expect(pagePromise).rejects.toBeInstanceOf(ProviderError);
		await expect(pagePromise).rejects.toMatchObject({
			fix: "Use provider language: python",
			message: "selenium-uc engine requires Python runtime",
		});
		expect(optionalModuleState.seleniumBaseImports).toBe(1);
	});

	it("closes the underlying local browser instance", async () => {
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();

		await client.newPage();
		await client.close();

		expect(browserState.browsers[0]?.closeCalls).toBe(1);
		expect(browserState.browsers[0]?.connected).toBeFalse();
	});
});
