/**
 * Child-process bridge for the deprecated `lintRuntimeBoundarySources` shim.
 *
 * The retired entry point was synchronous and `Bun.build` is not, so the shim
 * runs this script with `Bun.spawnSync` and reads the `ProviderBundle` as
 * JSON from stdout. Removed with the shim in the next major.
 *
 * Usage: bun bundle-worker.ts <providerRoot> <official|standalone> [<roots file>]
 * With a roots file (root-relative, importing every file to judge) the graph
 * is judged as a source set; without one, as a provider checkout.
 */

import { bundleProvider, bundleSourceSet } from "./bundle.js";

const [providerRoot, mode, rootsFile] = process.argv.slice(2);
if (providerRoot === undefined || (mode !== "official" && mode !== "standalone")) {
	process.stderr.write("usage: bundle-worker <providerRoot> <official|standalone> [<roots file>]\n");
	process.exit(2);
}

const bundle =
	rootsFile === undefined
		? await bundleProvider(providerRoot, { mode })
		: await bundleSourceSet(providerRoot, rootsFile, mode);
process.stdout.write(JSON.stringify(bundle));
