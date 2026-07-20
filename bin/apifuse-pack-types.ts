#!/usr/bin/env bun

// Guards the published artifact against the nodenext type-resolution regression
// shipped in 2.2.0-beta.1/beta.2: emitted dist/*.d.ts (and dist/*.js) carried
// EXTENSIONLESS relative imports, so external provider repos compiling with
// moduleResolution nodenext could not resolve them. With skipLibCheck the
// errors were masked and types silently degraded — re-exported ProviderError
// lost its inherited Error members (name/message) and re-exported zod stopped
// inferring .refine() callback params (~17 false type errors in
// apifuse-provider-tabelog, see its PR #16).
//
// Three layers, all against the packed tarball (what consumers actually get):
//   1. @arethetypeswrong/cli — resolution/module-kind audit of every exports
//      subpath, including internal resolution of relative specifiers in d.ts.
//   2. A fixture consumer compiled with real tsc under moduleResolution
//      nodenext and skipLibCheck:false, asserting ProviderError keeps
//      inherited Error members and zod re-exports keep .refine() inference.
//   3. A Node (not bun) ESM runtime import — node does not tolerate
//      extensionless relative specifiers, bun does.
//
// A deliberate negative control proves the fixture compiler actually fails on
// type errors, so this check cannot rot into a false-positive green.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const PACK_RESULT_SCHEMA = z.array(
	z.object({
		filename: z.string(),
	}),
);

const KEEP_TEMP = process.env.APIFUSE__PACK_TYPES__KEEP_TEMP === "1";
const sdkRoot = process.cwd();

const tempRoot = mkdtempSync(join(tmpdir(), "apifuse-provider-sdk-pack-types-"));
const packDir = join(tempRoot, "pack");
const consumerDir = join(tempRoot, "consumer");

try {
	mkdirSync(packDir, { recursive: true });
	mkdirSync(consumerDir, { recursive: true });

	const packed = packSdk(packDir);
	const tarballPath = resolve(packDir, packed.filename);

	runAreTheTypesWrong(tarballPath);
	setUpFixtureConsumer(consumerDir, tarballPath);
	run("bun", ["install"], consumerDir);
	compileFixtureConsumer(consumerDir);
	assertNegativeControlFails(consumerDir);
	runNodeRuntimeImport(consumerDir);

	console.log(`Packed artifact types OK under nodenext: ${tarballPath}`);
} finally {
	if (KEEP_TEMP) {
		console.log(`Keeping pack-types temp directory: ${tempRoot}`);
	} else {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function runAreTheTypesWrong(tarballPath: string): void {
	// esm-only profile: this package publishes ESM only, so CJS-consumer
	// resolution failures are expected and out of scope for this guard.
	run(
		"bun",
		[join(sdkRoot, "node_modules", ".bin", "attw"), tarballPath, "--profile", "esm-only"],
		sdkRoot,
	);
}

function setUpFixtureConsumer(consumerDir: string, tarballPath: string): void {
	writeFileSync(
		join(consumerDir, "package.json"),
		`${JSON.stringify(
			{
				private: true,
				type: "module",
				dependencies: {
					"@apifuse/provider-sdk": `file:${tarballPath}`,
				},
				devDependencies: {
					// Real tsc, not tsgo: this must reflect what external provider
					// polyrepos (e.g. apifuse-provider-tabelog) run in their CI.
					typescript: "^5.9.3",
					// skipLibCheck:false type-checks transitive deps too (ioredis
					// references Buffer), so the fixture needs node types like any
					// real provider repo.
					"@types/node": "^25.9.3",
				},
			},
			null,
			2,
		)}\n`,
	);

	writeFileSync(
		join(consumerDir, "tsconfig.json"),
		`${JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "nodenext",
					moduleResolution: "nodenext",
					strict: true,
					// skipLibCheck must stay off: it is exactly what masked the
					// extensionless-d.ts regression downstream.
					skipLibCheck: false,
					noEmit: true,
				},
				include: ["consumer.ts"],
			},
			null,
			2,
		)}\n`,
	);

	writeFileSync(
		join(consumerDir, "consumer.ts"),
		[
			'import { ProviderError, SessionExpiredError, z } from "@apifuse/provider-sdk";',
			'import { defineCredentialsAuth } from "@apifuse/provider-sdk/provider";',
			'import { extractProviderContract } from "@apifuse/provider-sdk/contract";',
			'import { AUTH_TURN_SCHEMA } from "@apifuse/provider-sdk/auth-turn";',
			'import { serve } from "@apifuse/provider-sdk/server";',
			'import { runStandardTests } from "@apifuse/provider-sdk/testing";',
			"",
			"// ProviderError must keep its inherited Error members under nodenext.",
			"// When dist d.ts imports fail to resolve, the class type degrades and",
			"// name/message disappear (the tabelog false-error mode).",
			'const providerError = new ProviderError("boom");',
			"const inheritedName: string = providerError.name;",
			"const inheritedMessage: string = providerError.message;",
			"const inheritedStack: string | undefined = providerError.stack;",
			"const isError: Error = providerError;",
			"const sessionExpired: ProviderError = new SessionExpiredError();",
			"",
			"// Re-exported zod must keep .refine() callback parameter inference.",
			"const refined = z.object({ shopId: z.string() }).refine((value) => value.shopId.length > 0);",
			'const refinedString = z.string().refine((value) => value.startsWith("tabelog:"));',
			"",
			"export const witnesses = {",
			"	inheritedName,",
			"	inheritedMessage,",
			"	inheritedStack,",
			"	isError,",
			"	sessionExpired,",
			"	refined,",
			"	refinedString,",
			"	defineCredentialsAuth,",
			"	extractProviderContract,",
			"	AUTH_TURN_SCHEMA,",
			"	serve,",
			"	runStandardTests,",
			"};",
			"",
		].join("\n"),
	);

	writeFileSync(
		join(consumerDir, "negative-control.ts"),
		[
			'import { ProviderError } from "@apifuse/provider-sdk";',
			"",
			"// Intentionally wrong: name is a string. If this file compiles, the",
			"// fixture consumer is not actually type-checking and the guard is void.",
			'export const mustNotCompile: number = new ProviderError("boom").name;',
			"",
		].join("\n"),
	);
}

function compileFixtureConsumer(consumerDir: string): void {
	run(
		"bun",
		[join(consumerDir, "node_modules", ".bin", "tsc"), "-p", "tsconfig.json"],
		consumerDir,
	);
}

function assertNegativeControlFails(consumerDir: string): void {
	const result = spawnSync(
		"bun",
		[
			join(consumerDir, "node_modules", ".bin", "tsc"),
			"--target",
			"ES2022",
			"--module",
			"nodenext",
			"--moduleResolution",
			"nodenext",
			"--strict",
			"--noEmit",
			"negative-control.ts",
		],
		{ cwd: consumerDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (result.status === 0) {
		throw new Error(
			"Negative control compiled cleanly: the fixture consumer is not detecting type errors, so the nodenext guard proves nothing.",
		);
	}
	if (!`${result.stdout}\n${result.stderr}`.includes("TS2322")) {
		throw new Error(
			`Negative control failed for an unexpected reason (wanted TS2322):\n${result.stdout}\n${result.stderr}`,
		);
	}
}

function runNodeRuntimeImport(consumerDir: string): void {
	// Node, not bun: bun resolves extensionless relative specifiers in
	// published dist/*.js, node correctly refuses them (ERR_MODULE_NOT_FOUND).
	run(
		"node",
		[
			"--input-type=module",
			"-e",
			[
				'const sdk = await import("@apifuse/provider-sdk");',
				'const error = new sdk.ProviderError("boom");',
				'if (error.name !== "ProviderError" || error.message !== "boom" || !(error instanceof Error)) {',
				'	throw new Error("ProviderError runtime shape is wrong: " + JSON.stringify({ name: error.name, message: error.message }));',
				"}",
				'console.log("node ESM runtime import OK");',
			].join("\n"),
		],
		consumerDir,
	);
}

function packSdk(destination: string): { filename: string } {
	const raw = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
		cwd: sdkRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
	const parsed = PACK_RESULT_SCHEMA.parse(JSON.parse(raw));
	const first = parsed[0];
	if (!first) {
		throw new Error("npm pack --json returned no package metadata.");
	}
	return first;
}

function run(command: string, args: string[], cwd: string): void {
	const result = spawnSync(command, args, {
		cwd,
		env: process.env,
		stdio: "inherit",
	});

	if (result.error) {
		throw result.error;
	}

	if (result.status !== 0) {
		throw new Error(
			`Command failed (${[command, ...args].join(" ")}) in ${cwd} with exit code ${result.status}`,
		);
	}
}
