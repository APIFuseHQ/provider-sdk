#!/usr/bin/env bun

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const PACK_RESULT_SCHEMA = z.array(
	z.object({
		filename: z.string(),
	}),
);
const HEALTH_RESPONSE_SCHEMA = z.object({
	status: z.string(),
	provider: z.string(),
	version: z.string().optional(),
});
const PING_RESPONSE_SCHEMA = z.object({
	data: z
		.object({
			ok: z.boolean(),
			message: z.string(),
		})
		.optional(),
	error: z.unknown().optional(),
});

const KEEP_TEMP = process.env.APIFUSE__PACK_SMOKE__KEEP_TEMP === "1";

const tempRoot = mkdtempSync(join(tmpdir(), "apifuse-provider-sdk-pack-smoke-"));
const packDir = join(tempRoot, "pack");
const consumerDir = join(tempRoot, "consumer");
const externalWorkspaceDir = join(tempRoot, "external-workspace");

try {
	mkdirSync(packDir, { recursive: true });
	mkdirSync(consumerDir, { recursive: true });
	mkdirSync(join(externalWorkspaceDir, "providers"), { recursive: true });

	const packed = packSdk(packDir);
	const tarballPath = resolve(packDir, packed.filename);
	const tarballSpecifier = `file:${tarballPath}`;

	writeFileSync(
		join(consumerDir, "package.json"),
		`${JSON.stringify(
			{
				private: true,
				type: "module",
				dependencies: {
					"@apifuse/provider-sdk": tarballSpecifier,
				},
			},
			null,
			2,
		)}\n`,
	);

	run("bun", ["install"], consumerDir);

	const cliBin = join(consumerDir, "node_modules", ".bin", "apifuse");
	if (!existsSync(cliBin)) {
		throw new Error(`Expected CLI bin at ${cliBin}`);
	}

	run(
		"bun",
		[cliBin, "create", "dx-smoke", "--yes", "--json", "--sdk-specifier", tarballSpecifier],
		consumerDir,
	);

	const generatedProviderDir = join(consumerDir, "dx-smoke");
	run("bun", ["run", "check"], generatedProviderDir);
	run("bun", ["run", "submit-check"], generatedProviderDir);
	run("bun", ["run", "test"], generatedProviderDir);
	assertGeneratedReadme(generatedProviderDir);
	await smokeGeneratedDevServer(generatedProviderDir);
	assertExternalWorkspaceTopology(cliBin, externalWorkspaceDir, tarballSpecifier);

	console.log(
		`Provider SDK packed-artifact smoke passed: ${tarballPath} -> ${generatedProviderDir}`,
	);
} finally {
	if (KEEP_TEMP) {
		console.log(`Keeping smoke temp directory: ${tempRoot}`);
	} else {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function assertExternalWorkspaceTopology(
	cliBin: string,
	externalWorkspaceDir: string,
	tarballSpecifier: string,
): void {
	writeFileSync(
		join(externalWorkspaceDir, "package.json"),
		`${JSON.stringify(
			{
				private: true,
				type: "module",
				workspaces: ["providers/*"],
			},
			null,
			2,
		)}\n`,
	);

	run(
		"bun",
		[
			cliBin,
			"create",
			"external-workspace-smoke",
			"--yes",
			"--json",
			"--sdk-specifier",
			tarballSpecifier,
		],
		externalWorkspaceDir,
	);

	const generatedProviderDir = join(externalWorkspaceDir, "external-workspace-smoke");
	const forbiddenProviderDir = join(externalWorkspaceDir, "providers", "external-workspace-smoke");
	if (!existsSync(generatedProviderDir)) {
		throw new Error(
			"Public create must generate a one-provider repository at <name>/ even when providers/ exists.",
		);
	}
	if (existsSync(forbiddenProviderDir)) {
		throw new Error(
			"Public create must not generate providers/<name>/ in external bounty workspaces.",
		);
	}

	const packageJson = JSON.parse(readFileSync(join(generatedProviderDir, "package.json"), "utf8"));
	const sdkDependency = packageJson?.dependencies?.["@apifuse/provider-sdk"];
	if (sdkDependency !== tarballSpecifier) {
		throw new Error(
			`Expected generated provider to depend on packed SDK ${tarballSpecifier}, got ${sdkDependency}`,
		);
	}
	if (JSON.stringify(packageJson).includes("workspace:")) {
		throw new Error("External bounty workspace scaffold must not contain workspace: dependencies.");
	}

	run("bun", ["install"], generatedProviderDir);
	run("bun", ["run", "check"], generatedProviderDir);
	run("bun", ["run", "submit-check"], generatedProviderDir);
	run("bun", ["run", "test"], generatedProviderDir);

	const monorepoAttempt = spawnSync(
		"bun",
		[cliBin, "create", "bad-monorepo-smoke", "--preset", "monorepo", "--yes"],
		{
			cwd: externalWorkspaceDir,
			env: { ...process.env, APIFUSE__SDK__SPECIFIER: tarballSpecifier },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	if (monorepoAttempt.status === 0) {
		throw new Error("--preset monorepo must reject outside the private APIFuse monorepo.");
	}
	const rejectionOutput = `${monorepoAttempt.stdout}\n${monorepoAttempt.stderr}`;
	if (!rejectionOutput.includes("Monorepo preset is internal to the APIFuse repository")) {
		throw new Error(`Unexpected monorepo rejection output: ${rejectionOutput}`);
	}
}

function packSdk(destination: string): { filename: string } {
	const raw = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
		cwd: process.cwd(),
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

function assertGeneratedReadme(providerDir: string): void {
	const readme = readFileSync(join(providerDir, "README.md"), "utf8");
	if (!readme.includes('"requestId":"req_local_ping"')) {
		throw new Error("Generated README is missing requestId in local smoke docs.");
	}
	if (readme.includes('"connection":null')) {
		throw new Error("Generated README must not document connection:null for no-auth local smoke.");
	}
	if (!readme.includes("bunx playwright install chromium")) {
		throw new Error("Generated README is missing browser runtime troubleshooting guidance.");
	}
	if (!readme.includes("impit")) {
		throw new Error("Generated README is missing impit stealth runtime guidance.");
	}
	if (!readme.includes("bun run submit-check")) {
		throw new Error("Generated README must document the submit-check pre-submission workflow.");
	}
	if (!readme.includes("bun run record -- --operation <operation>")) {
		throw new Error(
			"Generated README must document fixture recording through the generated record script.",
		);
	}
}

async function smokeGeneratedDevServer(providerDir: string): Promise<void> {
	const port = await getAvailablePort();
	const server = spawn("bun", ["run", "dev"], {
		cwd: providerDir,
		env: { ...process.env, APIFUSE__RUNTIME__PORT: String(port) },
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	server.stdout?.on("data", (chunk) => {
		output += chunk.toString();
	});
	server.stderr?.on("data", (chunk) => {
		output += chunk.toString();
	});

	try {
		const baseUrl = `http://127.0.0.1:${port}`;
		await waitForHttp(`${baseUrl}/health`, server, () => output);

		const health = await fetchJson(`${baseUrl}/health`, HEALTH_RESPONSE_SCHEMA);
		if (health.status !== "ok" || health.provider !== "dx-smoke") {
			throw new Error(`Unexpected /health payload: ${JSON.stringify(health)}`);
		}

		const response = await fetch(`${baseUrl}/v1/ping`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId: "req_pack_smoke_ping",
				input: { value: "hello" },
				headers: {},
			}),
		});
		const payload = PING_RESPONSE_SCHEMA.parse(await response.json());

		if (!response.ok || payload.data?.ok !== true) {
			throw new Error(
				`Unexpected /v1/ping response (${response.status}): ${JSON.stringify(payload)}`,
			);
		}
	} finally {
		await stopServer(server);
	}
}

async function getAvailablePort(): Promise<number> {
	return await new Promise((resolvePromise, rejectPromise) => {
		const server = createServer();
		server.once("error", rejectPromise);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close((error) => {
				if (error) {
					rejectPromise(error);
					return;
				}
				if (!address || typeof address === "string") {
					rejectPromise(new Error("Could not allocate a local TCP port."));
					return;
				}
				resolvePromise(address.port);
			});
		});
	});
}

async function fetchJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`${url} returned ${response.status}`);
	}
	return schema.parse(await response.json());
}

async function waitForHttp(
	url: string,
	server: ChildProcess,
	getOutput: () => string,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	let lastError: unknown;

	while (Date.now() < deadline) {
		if (server.exitCode !== null) {
			throw new Error(`Dev server exited early with code ${server.exitCode}\n${getOutput()}`);
		}

		try {
			await fetchJson(url, HEALTH_RESPONSE_SCHEMA);
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}

	throw new Error(
		`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${getOutput()}`,
	);
}

async function stopServer(server: ChildProcess): Promise<void> {
	if (server.exitCode !== null) {
		return;
	}
	killProcessTree(server, "SIGTERM");
	await new Promise<void>((resolvePromise) => {
		const timeout = setTimeout(() => {
			if (server.exitCode === null) {
				killProcessTree(server, "SIGKILL");
			}
			resolvePromise();
		}, 2_000);
		server.once("exit", () => {
			clearTimeout(timeout);
			resolvePromise();
		});
	});
}

function killProcessTree(server: ChildProcess, signal: NodeJS.Signals): void {
	if (server.pid === undefined) {
		return;
	}

	try {
		if (process.platform === "win32") {
			server.kill(signal);
			return;
		}
		process.kill(-server.pid, signal);
	} catch {
		server.kill(signal);
	}
}
