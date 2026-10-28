/**
 * Child-process bridge for the deprecated `lintRuntimeBoundarySources` shim.
 *
 * The retired entry point was synchronous and `Bun.build` is not, so the shim
 * runs this script with `Bun.spawnSync` and reads the `ProviderBundle` as
 * JSON from stdout. Removed with the shim in the next major.
 *
 * Usage: bun bundle-worker.ts <providerRoot> <official|standalone>
 */

import { bundleProvider } from "./bundle.js";

const [providerRoot, mode] = process.argv.slice(2);
if (providerRoot === undefined || (mode !== "official" && mode !== "standalone")) {
	process.stderr.write("usage: bundle-worker <providerRoot> <official|standalone>\n");
	process.exit(2);
}

const bundle = await bundleProvider(providerRoot, { mode });
process.stdout.write(JSON.stringify(bundle));
