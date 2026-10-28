import { writeFileSync } from "node:fs";

import { type RunChecksOptions, runChecks } from "../../../bin/apifuse-check.js";

// Runs `apifuse check` on one provider directory in a process of its own and
// writes the results as JSON to the given file. runChecks imports the
// provider's index.ts, so every module the provider reaches (a browser driver
// such as playwright, say) is loaded here instead of in the test process,
// whose other files replace those modules with test doubles.
const [providerDir, resultPath, lintMode] = process.argv.slice(2);
if (!providerDir || !resultPath) {
	throw new Error("usage: run-checks-runner.ts <providerDir> <resultPath> [official|standalone]");
}
if (lintMode !== undefined && lintMode !== "official" && lintMode !== "standalone") {
	throw new Error(`unknown lint mode: ${lintMode}`);
}
const options: RunChecksOptions = lintMode ? { lintMode } : {};
writeFileSync(resultPath, JSON.stringify(await runChecks(providerDir, options)));
