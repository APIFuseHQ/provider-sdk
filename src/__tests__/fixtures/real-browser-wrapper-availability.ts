import { existsSync } from "node:fs";

function resolveRealBrowserExecutablePath(): string {
	const configuredPath = process.env.APIFUSE_TEST_BROWSER_EXECUTABLE_PATH;
	if (configuredPath !== undefined) return configuredPath;

	const probe = Bun.spawnSync([
		process.execPath,
		"-e",
		'import { chromium } from "playwright"; process.stdout.write(chromium.executablePath())',
	]);
	if (probe.exitCode !== 0) return "";

	return new TextDecoder().decode(probe.stdout).trim();
}

export const realBrowserAvailable = existsSync(resolveRealBrowserExecutablePath());
export const realBrowserRequired = process.env.APIFUSE_TEST_REQUIRE_REAL_BROWSER === "1";
