#!/usr/bin/env bun

import packageJson from "../package.json";
import { COMMAND_MANIFEST, COMMAND_ORDER } from "../src/cli/commands.js";

const command = process.argv[2];

if (command === undefined || command === "--help" || command === "-h") {
	printHelp();
	process.exit(0);
}

if (command === "--version" || command === "-v") {
	console.log(packageJson.version);
	process.exit(0);
}

const manifest = COMMAND_MANIFEST[command as keyof typeof COMMAND_MANIFEST];

if (!manifest) {
	console.error(`Unknown command: ${command}`);
	printHelp();
	process.exit(1);
}

const module = await import(manifest.modulePath);
await module.main();

function printHelp() {
	console.log(`
apifuse - APIFuse Provider SDK CLI

Commands:`);
	for (const name of COMMAND_ORDER) {
		const item = COMMAND_MANIFEST[name];
		console.log(`  ${item.name.padEnd(8)} ${item.summary}`);
	}

	console.log(`
Examples:`);
	for (const name of COMMAND_ORDER) {
		const item = COMMAND_MANIFEST[name];
		for (const example of item.examples.slice(0, 1)) {
			console.log(`  ${example}`);
		}
	}

	console.log(`
Options:
  --help         Show this help
  --version      Show version`);
}
