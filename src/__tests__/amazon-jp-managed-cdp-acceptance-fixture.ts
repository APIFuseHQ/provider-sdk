import { ProviderError } from "../errors.js";
import type { BrowserPage } from "../types.js";

type AcceptancePage = Pick<BrowserPage, "close" | "content" | "goto" | "title" | "url">;

type AcceptanceBrowser = {
	readonly newPage: () => Promise<AcceptancePage>;
	readonly withIsolatedContext: <T>(handler: (page: AcceptancePage) => Promise<T>) => Promise<T>;
};

export type AcceptanceContext = {
	readonly browser: AcceptanceBrowser;
};

type AmazonPageSnapshot = {
	readonly html: string;
	readonly resultCount: number;
	readonly title: string;
	readonly url: string;
};

export type AmazonAcceptanceResult = {
	readonly title: string;
	readonly url: string;
};

export const CURRENT_BOUNTY_CDP_SOURCE = `
const AMAZON_CDP_URL = process.env.AMAZON_CDP_URL;
await fetch("http://127.0.0.1:9222/json/version");
Bun.spawn(["google-chrome", "--remote-debugging-port=9222"]);
`;

export const MANAGED_CDP_PORT_SOURCE = `
export async function amazonJpSearch(ctx, url) {
  const page = await ctx.browser.newPage();
  try {
    await page.goto(url);
    return await page.content();
  } finally {
    await page.close();
  }
}

export async function amazonJpOrders(ctx, url) {
  return await ctx.browser.withIsolatedContext(async (page) => {
    await page.goto(url);
    return await page.content();
  });
}
`;

function containsAkamaiInterstitial(snapshot: AmazonPageSnapshot): boolean {
	const haystack = `${snapshot.title}\n${snapshot.html}`;
	return (
		/AkamaiGHost|Reference #|api-services-support@amazon|Robot Check/i.test(haystack) ||
		snapshot.url.includes("/errors/validateCaptcha")
	);
}

function isSignInRedirect(snapshot: AmazonPageSnapshot): boolean {
	return (
		/(?:\/ap\/signin\b|\/gp\/sign-in\b)/.test(snapshot.url) ||
		/Amazon Sign-In|ログイン|サインイン/i.test(snapshot.title)
	);
}

function assertPublicAmazonPage(snapshot: AmazonPageSnapshot): void {
	if (containsAkamaiInterstitial(snapshot)) {
		throw new ProviderError("Amazon JP browser smoke reached a bot wall", {
			code: "AMAZON_JP_AKAMAI_INTERSTITIAL",
			details: { title: snapshot.title, url: snapshot.url },
			fix: "Use ctx.browser through the managed CDP Pool and report the safe page title/url for runtime diagnostics.",
		});
	}

	if (isSignInRedirect(snapshot)) {
		throw new ProviderError("Amazon JP public smoke redirected to sign-in", {
			code: "AMAZON_JP_SIGN_IN_REDIRECT",
			details: { title: snapshot.title, url: snapshot.url },
			fix: "Fail closed instead of returning an empty public result set.",
		});
	}

	if (snapshot.resultCount === 0) {
		throw new ProviderError("Amazon JP public smoke returned no result markers", {
			code: "AMAZON_JP_EMPTY_PUBLIC_RESULTS",
			details: { title: snapshot.title, url: snapshot.url },
			fix: "Treat empty browser pages as runtime failures until expected Amazon JP result markers are present.",
		});
	}
}

function assertAuthenticatedAmazonPage(snapshot: AmazonPageSnapshot): void {
	if (isSignInRedirect(snapshot)) {
		throw new ProviderError("Amazon JP authenticated smoke redirected to sign-in", {
			code: "AMAZON_JP_AUTH_SIGN_IN_REDIRECT",
			details: { title: snapshot.title, url: snapshot.url },
			fix: "Use ctx.browser.withIsolatedContext for authenticated cookies and fail closed when the session is rejected.",
		});
	}

	if (snapshot.resultCount === 0) {
		throw new ProviderError("Amazon JP authenticated smoke returned no account markers", {
			code: "AMAZON_JP_EMPTY_AUTHENTICATED_RESULTS",
			details: { title: snapshot.title, url: snapshot.url },
			fix: "Do not convert an empty authenticated browser page into a successful empty result.",
		});
	}
}

async function snapshotPage(page: AcceptancePage): Promise<AmazonPageSnapshot> {
	const html = await page.content();
	return {
		html,
		resultCount: (html.match(/data-asin=|js-order-card|order-card/g) ?? []).length,
		title: await page.title(),
		url: await page.url(),
	};
}

export async function runAmazonJpPublicSmoke(
	ctx: AcceptanceContext,
	query: string,
): Promise<AmazonAcceptanceResult> {
	const page = await ctx.browser.newPage();
	try {
		await page.goto(`https://www.amazon.co.jp/s?k=${encodeURIComponent(query)}`);
		const snapshot = await snapshotPage(page);
		assertPublicAmazonPage(snapshot);
		return { title: snapshot.title, url: snapshot.url };
	} finally {
		await page.close();
	}
}

export async function runAmazonJpAuthenticatedSmoke(
	ctx: AcceptanceContext,
): Promise<AmazonAcceptanceResult> {
	return await ctx.browser.withIsolatedContext(async (page) => {
		await page.goto("https://www.amazon.co.jp/gp/css/order-history");
		const snapshot = await snapshotPage(page);
		assertAuthenticatedAmazonPage(snapshot);
		return { title: snapshot.title, url: snapshot.url };
	});
}

export class FixtureBrowserPage implements AcceptancePage {
	closed = false;
	readonly visitedUrls: string[] = [];

	constructor(private readonly snapshot: AmazonPageSnapshot) {}

	async close(): Promise<void> {
		this.closed = true;
	}

	async content(): Promise<string> {
		return this.snapshot.html;
	}

	async goto(url: string): Promise<void> {
		this.visitedUrls.push(url);
	}

	async title(): Promise<string> {
		return this.snapshot.title;
	}

	async url(): Promise<string> {
		return this.snapshot.url;
	}
}

export class FixtureBrowser implements AcceptanceBrowser {
	readonly pages: FixtureBrowserPage[] = [];
	isolatedContextCalls = 0;

	constructor(private readonly snapshots: readonly AmazonPageSnapshot[]) {}

	async newPage(): Promise<AcceptancePage> {
		return this.createPage();
	}

	async withIsolatedContext<T>(handler: (page: AcceptancePage) => Promise<T>): Promise<T> {
		this.isolatedContextCalls += 1;
		const page = this.createPage();
		try {
			return await handler(page);
		} finally {
			await page.close();
		}
	}

	private createPage(): FixtureBrowserPage {
		const snapshot = this.snapshots[this.pages.length];
		if (!snapshot) {
			throw new Error("Missing Amazon JP acceptance page fixture");
		}
		const page = new FixtureBrowserPage(snapshot);
		this.pages.push(page);
		return page;
	}
}
