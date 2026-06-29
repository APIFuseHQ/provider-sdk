import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

type LaunchCall = {
	args?: string[];
	executablePath?: string;
	headless?: boolean;
	proxy?: { server: string };
};

type MockRouteFulfillOptions = {
	body?: Buffer | string;
	headers?: Record<string, string>;
	status?: number;
};

type MockResourceDispatch = {
	body?: string;
	headers?: Record<string, string>;
	method?: string;
	resourceType?: string;
	url: string;
};

type MockRouteHandler = (route: MockRoute) => Promise<void>;

type MockRouteRegistration = {
	handler: MockRouteHandler;
	pattern: string;
};

type MockResourceRequest = {
	allHeaders: () => Promise<Record<string, string>>;
	method: () => string;
	postData: () => string | undefined;
	resourceType: () => string;
	url: () => string;
};

type MockCdpFetchFulfillRequest = {
	body?: string;
	requestId: string;
	responseCode: number;
	responseHeaders?: Array<{ name: string; value: string }>;
};

type MockCdpFetchFailure = {
	errorReason: string;
	requestId: string;
};

type MockRoute = {
	abort: (errorCode?: string) => Promise<void>;
	fulfill: (options: MockRouteFulfillOptions) => Promise<void>;
	request: () => MockResourceRequest;
};

type MockPlaywrightPage = {
	click: (selector: string) => Promise<void>;
	close: () => Promise<void>;
	content: () => Promise<string>;
	dispatchResourceRequest: (
		dispatch: MockResourceDispatch,
	) => Promise<"handled" | "unhandled">;
	evaluate: <T>(fn: string | (() => T)) => Promise<T>;
	fill: (selector: string, text: string) => Promise<void>;
	frames: () => MockPlaywrightFrame[];
	goto: (url: string) => Promise<void>;
	locator: (selector: string) => MockPlaywrightLocator;
	route: (pattern: string, handler: MockRouteHandler) => Promise<void>;
	screenshot: (options?: { fullPage?: boolean }) => Promise<Buffer>;
	title: () => Promise<string>;
	type: (selector: string, text: string) => Promise<void>;
	unroute: (pattern: string, handler: MockRouteHandler) => Promise<void>;
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
		resourceAborts: Array<{ errorCode?: string; url: string }>;
		resourceFulfillments: Array<MockRouteFulfillOptions & { url: string }>;
		resourceRequests: MockResourceDispatch[];
		routes: MockRouteRegistration[];
		unhandledResourceRequests: MockResourceDispatch[];
		unrouteCalls: string[];
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
	fetchDisabled: 0,
	fetchEnabled: 0,
	fetchEnableParams: [] as Array<Record<string, unknown>>,
	fetchFailures: [] as MockCdpFetchFailure[],
	fetchFulfillments: [] as MockCdpFetchFulfillRequest[],
	navigateUrls: [] as string[],
	pageSockets: [] as MockWebSocket[],
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
		resourceAborts: [] as Array<{ errorCode?: string; url: string }>,
		resourceFulfillments: [] as Array<MockRouteFulfillOptions & { url: string }>,
		resourceRequests: [] as MockResourceDispatch[],
		routes: [] as MockRouteRegistration[],
		unhandledResourceRequests: [] as MockResourceDispatch[],
		unrouteCalls: [] as string[],
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
		async dispatchResourceRequest(dispatch) {
			state.resourceRequests.push(dispatch);
			const registration = state.routes.at(-1);
			if (!registration) {
				state.unhandledResourceRequests.push(dispatch);
				return "unhandled";
			}

			const request = {
				async allHeaders() {
					return dispatch.headers ?? {};
				},
				method() {
					return dispatch.method ?? "GET";
				},
				postData() {
					return dispatch.body;
				},
				resourceType() {
					return dispatch.resourceType ?? "document";
				},
				url() {
					return dispatch.url;
				},
			};
			const route = {
				async abort(errorCode?: string) {
					state.resourceAborts.push({ errorCode, url: dispatch.url });
				},
				async fulfill(options: MockRouteFulfillOptions) {
					state.resourceFulfillments.push({ ...options, url: dispatch.url });
				},
				request() {
					return request;
				},
			};

			await registration.handler(route);
			return "handled";
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
			await this.dispatchResourceRequest({
				method: "GET",
				resourceType: "document",
				url,
			});
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
		async route(pattern, handler) {
			state.routes.push({ handler, pattern });
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
		async unroute(pattern, handler) {
			state.unrouteCalls.push(pattern);
			state.routes = state.routes.filter(
				(registration) =>
					registration.pattern !== pattern || registration.handler !== handler,
			);
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

async function waitForCondition(
	condition: () => boolean,
	message: string,
): Promise<void> {
	const deadline = Date.now() + 500;
	while (Date.now() < deadline) {
		if (condition()) {
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	throw new Error(message);
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
		if (endpoint.startsWith("ws://page.test/")) {
			cdpState.pageSockets.push(this);
		}

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

	dispatchFetchRequest(dispatch: MockResourceDispatch): string {
		const requestId = `fetch-request-${cdpState.fetchFailures.length + cdpState.fetchFulfillments.length + 1}`;
		this.emitPageEvent("Fetch.requestPaused", {
			request: {
				headers: dispatch.headers ?? {},
				method: dispatch.method ?? "GET",
				postData: dispatch.body,
				url: dispatch.url,
			},
			requestId,
			resourceType: dispatch.resourceType ?? "Document",
		});
		return requestId;
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
			case "Fetch.enable":
				cdpState.fetchEnabled += 1;
				cdpState.fetchEnableParams.push(message.params ?? {});
				this.reply(message.id, {});
				break;
			case "Fetch.disable":
				cdpState.fetchDisabled += 1;
				this.reply(message.id, {});
				break;
			case "Fetch.fulfillRequest":
				cdpState.fetchFulfillments.push({
					...(typeof message.params?.body === "string"
						? { body: message.params.body }
						: {}),
					requestId: String(message.params?.requestId ?? ""),
					responseCode:
						typeof message.params?.responseCode === "number"
							? message.params.responseCode
							: 0,
					...(Array.isArray(message.params?.responseHeaders)
						? {
								responseHeaders: message.params.responseHeaders.filter(
									(header): header is { name: string; value: string } =>
										typeof header === "object" &&
										header !== null &&
										"name" in header &&
										"value" in header &&
										typeof header.name === "string" &&
										typeof header.value === "string",
								),
							}
						: {}),
				});
				this.reply(message.id, {});
				break;
			case "Fetch.failRequest":
				cdpState.fetchFailures.push({
					errorReason: String(message.params?.errorReason ?? ""),
					requestId: String(message.params?.requestId ?? ""),
				});
				this.reply(message.id, {});
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
		cdpState.fetchDisabled = 0;
		cdpState.fetchEnabled = 0;
		cdpState.fetchEnableParams.length = 0;
		cdpState.fetchFailures.length = 0;
		cdpState.fetchFulfillments.length = 0;
		cdpState.insertedTexts.length = 0;
		cdpState.navigateUrls.length = 0;
		cdpState.pageSockets.length = 0;
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

	it("fulfills a document-like request under a scoped resource policy", async () => {
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();

		const result = await page.withResourcePolicy(
			{
				routes: [
					{
						match: "https://example.test/__sandbox",
						handle: (request) => ({
							action: "fulfill",
							body: `<html><title>${request.resourceType}</title></html>`,
							headers: { "content-type": "text/html" },
							status: 200,
						}),
					},
				],
			},
			async () => {
				await page.goto("https://example.test/__sandbox");
				return "loaded";
			},
		);

		const rawPage = browserState.browsers[0]?.pages[0];
		expect(result).toBe("loaded");
		expect(rawPage?.state.resourceFulfillments).toEqual([
			{
				body: "<html><title>document</title></html>",
				headers: { "content-type": "text/html" },
				status: 200,
				url: "https://example.test/__sandbox",
			},
		]);
		expect(rawPage?.state.resourceAborts).toEqual([]);
		expect(rawPage?.state.unrouteCalls).toEqual(["**/*"]);
		expect(rawPage?.state.routes).toEqual([]);
	});

	it("blocks unhandled resource requests by default", async () => {
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();

		await page.withResourcePolicy({ routes: [] }, async () => {
			await page.goto("https://example.test/unhandled");
		});

		const rawPage = browserState.browsers[0]?.pages[0];
		expect(rawPage?.state.resourceFulfillments).toEqual([]);
		expect(rawPage?.state.resourceAborts).toEqual([
			{
				errorCode: "blockedbyclient",
				url: "https://example.test/unhandled",
			},
		]);
		expect(rawPage?.state.routes).toEqual([]);
	});

	it("cleans up the resource policy after a successful callback", async () => {
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();
		const rawPage = browserState.browsers[0]?.pages[0];

		await page.withResourcePolicy(
			{
				routes: [
					{
						match: /\/inside$/,
						handle: () => ({ action: "fulfill", body: "inside" }),
					},
				],
			},
			async () => {
				await page.goto("https://example.test/inside");
			},
		);
		await page.goto("https://example.test/outside");

		expect(rawPage?.state.resourceFulfillments).toEqual([
			{ body: "inside", status: 200, url: "https://example.test/inside" },
		]);
		expect(rawPage?.state.unhandledResourceRequests).toEqual([
			{
				method: "GET",
				resourceType: "document",
				url: "https://example.test/outside",
			},
		]);
		expect(rawPage?.state.resourceAborts).toEqual([]);
		expect(rawPage?.state.routes).toEqual([]);
	});

	it("cleans up the resource policy when the callback throws", async () => {
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();
		const rawPage = browserState.browsers[0]?.pages[0];

		await expect(
			page.withResourcePolicy({ routes: [] }, async () => {
				await page.goto("https://example.test/fail-closed");
				throw new Error("resource evaluation failed");
			}),
		).rejects.toThrow("resource evaluation failed");
		await page.goto("https://example.test/after-error");

		expect(rawPage?.state.resourceAborts).toEqual([
			{
				errorCode: "blockedbyclient",
				url: "https://example.test/fail-closed",
			},
		]);
		expect(rawPage?.state.unhandledResourceRequests).toEqual([
			{
				method: "GET",
				resourceType: "document",
				url: "https://example.test/after-error",
			},
		]);
		expect(rawPage?.state.unrouteCalls).toEqual(["**/*"]);
		expect(rawPage?.state.routes).toEqual([]);
	});

	it("blocks non-GET and non-HEAD requests before provider handlers run", async () => {
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();
		const rawPage = browserState.browsers[0]?.pages[0];
		let handlerCalls = 0;

		await page.withResourcePolicy(
			{
				routes: [
					{
						match: () => true,
						handle: () => {
							handlerCalls += 1;
							return { action: "fulfill", body: "unexpected" };
						},
					},
				],
			},
			async () => {
				await rawPage?.dispatchResourceRequest({
					body: "secret=not-exposed",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					method: "POST",
					resourceType: "fetch",
					url: "https://example.test/post",
				});
			},
		);

		expect(handlerCalls).toBe(0);
		expect(rawPage?.state.resourceFulfillments).toEqual([]);
		expect(rawPage?.state.resourceAborts).toEqual([
			{ errorCode: "blockedbyclient", url: "https://example.test/post" },
		]);
	});

	it("passes only safe request metadata to provider handlers", async () => {
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();
		const rawPage = browserState.browsers[0]?.pages[0];
		let receivedKeys: string[] = [];
		let postDataExposed = true;

		await page.withResourcePolicy(
			{
				routes: [
					{
						match: () => true,
						handle: (request) => {
							receivedKeys = Object.keys(request).sort();
							postDataExposed = "postData" in request || "body" in request;
							return { action: "fulfill", body: "safe" };
						},
					},
				],
			},
			async () => {
				await rawPage?.dispatchResourceRequest({
					body: "secret=not-exposed",
					headers: { accept: "text/html" },
					method: "GET",
					resourceType: "document",
					url: "https://example.test/safe",
				});
			},
		);

		expect(receivedKeys).toEqual(["headers", "method", "resourceType", "url"]);
		expect(postDataExposed).toBeFalse();
		expect(rawPage?.state.resourceFulfillments).toEqual([
			{ body: "safe", status: 200, url: "https://example.test/safe" },
		]);
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

	it("enables and disables CDP Fetch around resource policy callbacks", async () => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "ws://pool.test";
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();

		const result = await page.withResourcePolicy({ routes: [] }, async () => {
			expect(cdpState.fetchEnabled).toBe(1);
			expect(cdpState.fetchDisabled).toBe(0);
			return "scoped";
		});
		await page.close();
		await client.close();

		expect(result).toBe("scoped");
		expect(cdpState.fetchEnableParams).toEqual([
			{ patterns: [{ requestStage: "Request", urlPattern: "*" }] },
		]);
		expect(cdpState.fetchDisabled).toBe(1);
		expect(cdpState.poolReleaseCalls).toEqual(["pool-page-1"]);
	});

	it("fulfills a matching CDP Fetch request under a resource policy", async () => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "ws://pool.test";
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();

		await page.withResourcePolicy(
			{
				routes: [
					{
						match: "https://example.test/document",
						handle: (request) => ({
							action: "fulfill",
							body: `<title>${request.resourceType}</title>`,
							headers: { "content-type": "text/html" },
							status: 202,
						}),
					},
				],
			},
			async () => {
				const socket = cdpState.pageSockets[0];
				if (!socket) {
					throw new Error("CDP page socket was not opened");
				}

				socket.dispatchFetchRequest({
					headers: { accept: "text/html" },
					method: "GET",
					resourceType: "Document",
					url: "https://example.test/document",
				});
				await waitForCondition(
					() => cdpState.fetchFulfillments.length === 1,
					"CDP Fetch request was not fulfilled",
				);
			},
		);
		await page.close();
		await client.close();

		expect(cdpState.fetchFailures).toEqual([]);
		expect(cdpState.fetchFulfillments).toEqual([
			{
				body: Buffer.from("<title>Document</title>").toString("base64"),
				requestId: "fetch-request-1",
				responseCode: 202,
				responseHeaders: [{ name: "content-type", value: "text/html" }],
			},
		]);
	});

	it("blocks unmatched CDP Fetch requests by default", async () => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "ws://pool.test";
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();

		await page.withResourcePolicy({ routes: [] }, async () => {
			const socket = cdpState.pageSockets[0];
			if (!socket) {
				throw new Error("CDP page socket was not opened");
			}

			socket.dispatchFetchRequest({
				method: "GET",
				resourceType: "Script",
				url: "https://example.test/app.js",
			});
			await waitForCondition(
				() => cdpState.fetchFailures.length === 1,
				"CDP Fetch request was not blocked",
			);
		});
		await page.close();
		await client.close();

		expect(cdpState.fetchFulfillments).toEqual([]);
		expect(cdpState.fetchFailures).toEqual([
			{ errorReason: "BlockedByClient", requestId: "fetch-request-1" },
		]);
	});

	it("blocks non-GET CDP Fetch requests before provider handlers run", async () => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "ws://pool.test";
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();
		let handlerCalls = 0;

		await page.withResourcePolicy(
			{
				routes: [
					{
						match: () => true,
						handle: () => {
							handlerCalls += 1;
							return { action: "fulfill", body: "unexpected" };
						},
					},
				],
			},
			async () => {
				const socket = cdpState.pageSockets[0];
				if (!socket) {
					throw new Error("CDP page socket was not opened");
				}

				socket.dispatchFetchRequest({
					body: "secret=not-exposed",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					method: "POST",
					resourceType: "Fetch",
					url: "https://example.test/post",
				});
				await waitForCondition(
					() => cdpState.fetchFailures.length === 1,
					"CDP POST request was not blocked",
				);
			},
		);
		await page.close();
		await client.close();

		expect(handlerCalls).toBe(0);
		expect(cdpState.fetchFulfillments).toEqual([]);
		expect(cdpState.fetchFailures).toEqual([
			{ errorReason: "BlockedByClient", requestId: "fetch-request-1" },
		]);
	});

	it("disables CDP Fetch when a resource policy callback throws", async () => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "ws://pool.test";
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();

		await expect(
			page.withResourcePolicy({ routes: [] }, async () => {
				throw new Error("resource policy callback failed");
			}),
		).rejects.toThrow("resource policy callback failed");
		await page.close();
		await client.close();

		expect(cdpState.fetchEnabled).toBe(1);
		expect(cdpState.fetchDisabled).toBe(1);
	});

	it("passes only safe CDP Fetch request metadata to provider handlers", async () => {
		globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
		process.env.APIFUSE__CDP_POOL__URL = "ws://pool.test";
		const { createBrowserClient } = await import("../runtime/browser");
		const client = createBrowserClient();
		const page = await client.newPage();
		let receivedKeys: string[] = [];
		let postDataExposed = true;

		await page.withResourcePolicy(
			{
				routes: [
					{
						match: () => true,
						handle: (request) => {
							receivedKeys = Object.keys(request).sort();
							postDataExposed = "postData" in request || "body" in request;
							return { action: "fulfill", body: "safe" };
						},
					},
				],
			},
			async () => {
				const socket = cdpState.pageSockets[0];
				if (!socket) {
					throw new Error("CDP page socket was not opened");
				}

				socket.dispatchFetchRequest({
					body: "secret=not-exposed",
					headers: { accept: "text/html" },
					method: "GET",
					resourceType: "Document",
					url: "https://example.test/safe",
				});
				await waitForCondition(
					() => cdpState.fetchFulfillments.length === 1,
					"CDP Fetch request was not fulfilled",
				);
			},
		);
		await page.close();
		await client.close();

		expect(receivedKeys).toEqual(["headers", "method", "resourceType", "url"]);
		expect(postDataExposed).toBeFalse();
		expect(cdpState.fetchFulfillments).toEqual([
			{
				body: Buffer.from("safe").toString("base64"),
				requestId: "fetch-request-1",
				responseCode: 200,
			},
		]);
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
