import { describe, expect, it, mock } from "bun:test";

// browser.test.ts runs each case here in a fresh bun process. mock.module can make an
// import fail only while the process has not imported that module yet: once another
// test file has loaded the real playwright, the factory runs when the mock is
// registered and the runtime's import returns the module that is already loaded.
let missingModuleError: Error | undefined;

function exportsUnlessMissing(): Record<string, unknown> {
	if (missingModuleError) throw missingModuleError;
	return {};
}

mock.module("playwright", exportsUnlessMissing);
mock.module("playwright-extra", exportsUnlessMissing);

delete process.env.APIFUSE__CDP_POOL__URL;

describe("createBrowserClient without the browser driver installed", () => {
	it("throws ProviderError with install hint when the stealth browser launcher is unavailable", async () => {
		missingModuleError = Object.assign(new Error("Cannot find module 'playwright'"), {
			code: "MODULE_NOT_FOUND",
		});

		const { ProviderError } = await import("../../errors.js");
		const { createBrowserClient } = await import("../../runtime/browser.js");
		const client = createBrowserClient();
		const pagePromise = client.newPage();

		await expect(pagePromise).rejects.toBeInstanceOf(ProviderError);
		await expect(pagePromise).rejects.toMatchObject({
			fix: "Run: bun add playwright-extra puppeteer-extra-plugin-stealth",
			message: "playwright-extra is not installed",
		});
	});

	it("throws ProviderError with install hint for ESM missing Playwright when stealth is disabled", async () => {
		missingModuleError = Object.assign(
			new Error("Cannot find package 'playwright' imported from runtime/browser"),
			{
				code: "ERR_MODULE_NOT_FOUND",
			},
		);

		const { ProviderError } = await import("../../errors.js");
		const { createBrowserClient } = await import("../../runtime/browser.js");
		const client = createBrowserClient({ stealth: false });
		const pagePromise = client.newPage();

		await expect(pagePromise).rejects.toBeInstanceOf(ProviderError);
		await expect(pagePromise).rejects.toMatchObject({
			fix: "Run: bun add playwright",
			message: "Playwright is not installed",
		});
	});
});
