#!/usr/bin/env bun

import { main as runMain } from "../src/cli/create.js";

export { runMain as main };

if (import.meta.main) {
	await runMain().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
