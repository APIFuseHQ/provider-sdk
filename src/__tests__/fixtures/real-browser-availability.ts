import { existsSync } from "node:fs";

import { chromium } from "playwright";

export const realBrowserExecutablePath =
	process.env.APIFUSE_TEST_BROWSER_EXECUTABLE_PATH ?? chromium.executablePath();
export const realBrowserAvailable = existsSync(realBrowserExecutablePath);

const realBrowserRequired = process.env.APIFUSE_TEST_REQUIRE_REAL_BROWSER === "1";

// The wrapper tests keep running when the browser is required but absent so the
// child can report the gap itself; fail here with the resolved path instead of
// letting `describe.skipIf(!realBrowserAvailable)` skip every subtest and exit 0.
if (realBrowserRequired && !realBrowserAvailable) {
	throw new Error(
		`APIFUSE_TEST_REQUIRE_REAL_BROWSER=1 but no Chromium executable exists at ${realBrowserExecutablePath}; ` +
			"run `bunx playwright install chromium` or set APIFUSE_TEST_BROWSER_EXECUTABLE_PATH.",
	);
}
