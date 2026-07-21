import { describe, expect, it } from "bun:test";
import { lintProvider } from "../lint.js";
import {
	CURRENT_BOUNTY_CDP_SOURCE,
	FixtureBrowser,
	MANAGED_CDP_PORT_SOURCE,
	runAmazonJpAuthenticatedSmoke,
	runAmazonJpPublicSmoke,
} from "./amazon-jp-managed-cdp-acceptance-fixture.js";

describe("Amazon JP managed CDP acceptance harness", () => {
	it("blocks the current bounty self-hosted CDP patterns in official provider mode", () => {
		const diagnostics = lintProvider({
			id: "amazon-jp",
			allowedHosts: ["www.amazon.co.jp"],
			providerSourceFiles: {
				"entrypoint.sh": CURRENT_BOUNTY_CDP_SOURCE,
				"operations/index.ts": CURRENT_BOUNTY_CDP_SOURCE,
			},
			reviewed: "community",
		});

		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				level: "error",
				rule: "browser-provider-local-cdp-env",
			}),
		);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				level: "error",
				rule: "browser-direct-cdp-version-poll",
			}),
		);
		expect(diagnostics).toContainEqual(
			expect.objectContaining({
				level: "error",
				rule: "browser-self-hosted-child-process",
			}),
		);
	});

	it("keeps the managed ctx.browser port shape lint-clean for official import", () => {
		const diagnostics = lintProvider({
			id: "amazon-jp",
			allowedHosts: ["www.amazon.co.jp"],
			providerSourceFiles: {
				"operations/browser.ts": MANAGED_CDP_PORT_SOURCE,
			},
			reviewed: "community",
		});

		expect(diagnostics.filter((item) => item.rule.startsWith("browser-"))).toEqual([]);
	});

	it("uses ctx.browser.newPage for public smoke and fails closed on bot-wall or empty pages", async () => {
		const goodBrowser = new FixtureBrowser([
			{
				html: '<div data-asin="B000000001">Kindle</div>',
				resultCount: 1,
				title: "Amazon.co.jp : kindle",
				url: "https://www.amazon.co.jp/s?k=kindle",
			},
		]);

		await expect(runAmazonJpPublicSmoke({ browser: goodBrowser }, "kindle")).resolves.toEqual({
			title: "Amazon.co.jp : kindle",
			url: "https://www.amazon.co.jp/s?k=kindle",
		});
		expect(goodBrowser.pages[0]?.closed).toBe(true);
		expect(goodBrowser.pages[0]?.visitedUrls[0]).toContain("https://www.amazon.co.jp/s?k=kindle");

		const akamaiBrowser = new FixtureBrowser([
			{
				html: "Reference #18. AkamaiGHost",
				resultCount: 0,
				title: "Robot Check",
				url: "https://www.amazon.co.jp/errors/validateCaptcha",
			},
		]);
		await expect(
			runAmazonJpPublicSmoke({ browser: akamaiBrowser }, "kindle"),
		).rejects.toMatchObject({ code: "AMAZON_JP_AKAMAI_INTERSTITIAL" });

		const emptyBrowser = new FixtureBrowser([
			{
				html: "<main></main>",
				resultCount: 0,
				title: "Amazon.co.jp : kindle",
				url: "https://www.amazon.co.jp/s?k=kindle",
			},
		]);
		await expect(runAmazonJpPublicSmoke({ browser: emptyBrowser }, "kindle")).rejects.toMatchObject(
			{ code: "AMAZON_JP_EMPTY_PUBLIC_RESULTS" },
		);
	});

	it("uses ctx.browser.withIsolatedContext for authenticated smoke and fails closed on rejected sessions", async () => {
		const goodBrowser = new FixtureBrowser([
			{
				html: '<div class="js-order-card">order</div>',
				resultCount: 1,
				title: "注文履歴",
				url: "https://www.amazon.co.jp/gp/css/order-history",
			},
		]);

		await expect(runAmazonJpAuthenticatedSmoke({ browser: goodBrowser })).resolves.toEqual({
			title: "注文履歴",
			url: "https://www.amazon.co.jp/gp/css/order-history",
		});
		expect(goodBrowser.isolatedContextCalls).toBe(1);
		expect(goodBrowser.pages[0]?.closed).toBe(true);

		const signInBrowser = new FixtureBrowser([
			{
				html: "<form id='ap_signin_form'></form>",
				resultCount: 0,
				title: "Amazon Sign-In",
				url: "https://www.amazon.co.jp/ap/signin",
			},
		]);
		await expect(runAmazonJpAuthenticatedSmoke({ browser: signInBrowser })).rejects.toMatchObject({
			code: "AMAZON_JP_AUTH_SIGN_IN_REDIRECT",
		});
		expect(signInBrowser.pages[0]?.closed).toBe(true);
	});
});
