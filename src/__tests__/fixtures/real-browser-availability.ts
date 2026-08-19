import { existsSync } from "node:fs";

import { chromium } from "playwright";

export const realBrowserExecutablePath =
	process.env.APIFUSE_TEST_BROWSER_EXECUTABLE_PATH ?? chromium.executablePath();
export const realBrowserAvailable = existsSync(realBrowserExecutablePath);
