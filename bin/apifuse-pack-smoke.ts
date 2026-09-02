#!/usr/bin/env bun

import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { startProviderEngineStub } from "../scripts/test-support/provider-engine-stub.js";

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
const PACK_ENGINE_API_KEY = "apifuse_pack_smoke_workspace_key";

const tempRoot = mkdtempSync(join(tmpdir(), "apifuse-provider-sdk-pack-smoke-"));
const packDir = join(tempRoot, "pack");
const consumerDir = join(tempRoot, "consumer");
const externalWorkspaceDir = join(tempRoot, "external-workspace");
const providerEngine = startProviderEngineStub(PACK_ENGINE_API_KEY);
const providerEngineEnvironment = {
	...process.env,
	APIFUSE__ENGINE__API_KEY: PACK_ENGINE_API_KEY,
	APIFUSE__ENGINE__URL: providerEngine.url,
};

try {
	await assertProviderEngineStubRejectsMissingAuthentication(providerEngine.url);
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

	await run("bun", ["install"], consumerDir);
	await run(
		"bun",
		[
			"--eval",
			[
				'import { resolveProxy } from "@apifuse/provider-sdk";',
				'if (typeof resolveProxy !== "function") throw new Error("resolveProxy is not exported");',
				'const resolved = await resolveProxy({ proxy: "http://127.0.0.1:8080" });',
				'if (resolved.url !== "http://127.0.0.1:8080") throw new Error("resolveProxy returned the wrong URL");',
				'console.log("packed root resolveProxy export OK");',
			].join("\n"),
		],
		consumerDir,
	);
	await smokePackedStealthNative(consumerDir);

	const cliBin = join(consumerDir, "node_modules", ".bin", "apifuse");
	if (!existsSync(cliBin)) {
		throw new Error(`Expected CLI bin at ${cliBin}`);
	}

	await run(
		"bun",
		[cliBin, "create", "dx-smoke", "--yes", "--json", "--sdk-specifier", tarballSpecifier],
		consumerDir,
		providerEngineEnvironment,
	);

	const generatedProviderDir = join(consumerDir, "dx-smoke");
	await run("bun", ["run", "check"], generatedProviderDir, providerEngineEnvironment);
	await run("bun", ["run", "submit-check"], generatedProviderDir, providerEngineEnvironment);
	await run("bun", ["run", "test"], generatedProviderDir, providerEngineEnvironment);
	assertGeneratedReadme(generatedProviderDir);
	await assertGeneratedDevRejectsWrongEngineKey(generatedProviderDir, providerEngine.url);
	await smokeGeneratedDevServer(generatedProviderDir, providerEngine.url, PACK_ENGINE_API_KEY);
	await assertExternalWorkspaceTopology(
		cliBin,
		externalWorkspaceDir,
		tarballSpecifier,
		providerEngineEnvironment,
	);
	if (
		providerEngine.stats.acceptedHandshakes === 0 ||
		providerEngine.stats.acceptedTraceSubscriptions === 0 ||
		providerEngine.stats.rejectedAuthentications < 2
	) {
		throw new Error(
			`Provider engine stub coverage was incomplete: ${JSON.stringify(providerEngine.stats)}`,
		);
	}
	console.log(
		`Packed remote-engine attachment passed: handshakes=${providerEngine.stats.acceptedHandshakes} traceSubscriptions=${providerEngine.stats.acceptedTraceSubscriptions} authRejections=${providerEngine.stats.rejectedAuthentications}`,
	);

	console.log(
		`Provider SDK packed-artifact smoke passed: ${tarballPath} -> ${generatedProviderDir}`,
	);
} finally {
	await providerEngine.stop();
	if (KEEP_TEMP) {
		console.log(`Keeping smoke temp directory: ${tempRoot}`);
	} else {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

async function assertExternalWorkspaceTopology(
	cliBin: string,
	externalWorkspaceDir: string,
	tarballSpecifier: string,
	providerEngineEnvironment: NodeJS.ProcessEnv,
): Promise<void> {
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

	await run(
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
		providerEngineEnvironment,
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

	await run("bun", ["install"], generatedProviderDir, providerEngineEnvironment);
	await run("bun", ["run", "check"], generatedProviderDir, providerEngineEnvironment);
	await run("bun", ["run", "submit-check"], generatedProviderDir, providerEngineEnvironment);
	await run("bun", ["run", "test"], generatedProviderDir, providerEngineEnvironment);

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

async function run(
	command: string,
	args: string[],
	cwd: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	await new Promise<void>((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			cwd,
			env: environment,
			stdio: "inherit",
		});
		child.once("error", rejectPromise);
		child.once("close", (code) => {
			if (code === 0) {
				resolvePromise();
				return;
			}
			rejectPromise(
				new Error(
					`Command failed (${[command, ...args].join(" ")}) in ${cwd} with exit code ${code}`,
				),
			);
		});
	});
}

async function smokePackedStealthNative(consumerDir: string): Promise<void> {
	await run(
		"bun",
		[
			"--eval",
			[
				'import { createServer } from "node:http";',
				'import { createStealthClient } from "@apifuse/provider-sdk/runtime/stealth";',
				"const server = createServer((_request, response) => {",
				'  response.setHeader("set-cookie", "pack_native_cookie=landed; Path=/");',
				'  response.end("packed native stealth ok");',
				"});",
				"await new Promise((resolve, reject) => {",
				'  server.once("error", reject);',
				'  server.listen(0, "127.0.0.1", resolve);',
				"});",
				"const address = server.address();",
				'if (!address || typeof address === "string") throw new Error("Local server has no TCP address");',
				'const baseUrl = "http://127.0.0.1:" + address.port;',
				'const session = createStealthClient(baseUrl).createSession({ stealth: { browser: "safari", os: "macos" } });',
				"try {",
				'  const response = await session.fetch("/native");',
				'  if (response.body !== "packed native stealth ok") throw new Error("Unexpected stealth body: " + response.body);',
				'  if (session.cookies.get("pack_native_cookie", baseUrl + "/native") !== "landed") {',
				'    throw new Error("Packed stealth Set-Cookie did not land in the SDK jar");',
				"  }",
				'  console.log("packed native Safari stealth request OK");',
				"} finally {",
				"  session.close();",
				"  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));",
				"}",
			].join("\n"),
		],
		consumerDir,
	);
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
	if (!readme.includes("wreq-js")) {
		throw new Error("Generated README is missing wreq-js stealth runtime guidance.");
	}
	if (!readme.includes("Chrome, Firefox, and Safari")) {
		throw new Error("Generated README is missing supported stealth browser families.");
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

async function assertProviderEngineStubRejectsMissingAuthentication(
	providerEngineUrl: string,
): Promise<void> {
	const response = await fetch(`${providerEngineUrl}/v1/provider-engine/request`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			version: "provider-engine.v1",
			lane: "request",
			providerId: "dx-smoke",
			requestId: "req_pack_smoke_missing_key",
			capability: "attachment",
			method: "attach",
			payload: {},
		}),
	});
	const payload = (await response.json()) as {
		readonly error?: { readonly code?: string };
	};
	if (response.status !== 401 || payload.error?.code !== "PROVIDER_ENGINE_AUTHENTICATION_FAILED") {
		throw new Error(
			`Provider engine stub accepted missing authentication: ${response.status} ${JSON.stringify(payload)}`,
		);
	}
}

async function assertGeneratedDevRejectsWrongEngineKey(
	providerDir: string,
	providerEngineUrl: string,
): Promise<void> {
	const port = await getAvailablePort();
	const wrongKey = `${PACK_ENGINE_API_KEY}_wrong`;
	const server = spawn("bun", ["run", "dev"], {
		cwd: providerDir,
		env: {
			...process.env,
			APIFUSE__ENGINE__API_KEY: wrongKey,
			APIFUSE__ENGINE__URL: providerEngineUrl,
			APIFUSE__RUNTIME__PORT: String(port),
		},
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
		const exitCode = await waitForExit(server, 10_000);
		if (exitCode === 0) {
			throw new Error("Packed consumer dev server accepted the wrong workspace API key.");
		}
		if (
			!output.includes("ProviderEngineAuthenticationError") ||
			!output.includes("rejected the workspace API key")
		) {
			throw new Error(`Unexpected wrong-key dev failure (exit ${exitCode}):\n${output}`);
		}
		if (output.includes(wrongKey)) {
			throw new Error("Wrong workspace API key leaked into packed consumer dev output.");
		}
	} finally {
		await stopServer(server);
	}
}

async function smokeGeneratedDevServer(
	providerDir: string,
	providerEngineUrl: string,
	providerEngineApiKey: string,
): Promise<void> {
	const port = await getAvailablePort();
	const server = spawn("bun", ["run", "dev"], {
		cwd: providerDir,
		env: {
			...process.env,
			APIFUSE__ENGINE__API_KEY: providerEngineApiKey,
			APIFUSE__ENGINE__URL: providerEngineUrl,
			APIFUSE__RUNTIME__PORT: String(port),
		},
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

async function waitForExit(server: ChildProcess, timeoutMs: number): Promise<number | null> {
	if (server.exitCode !== null) return server.exitCode;
	return await new Promise((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(() => {
			rejectPromise(new Error(`Timed out waiting ${timeoutMs}ms for child process to exit.`));
		}, timeoutMs);
		server.once("error", (error) => {
			clearTimeout(timeout);
			rejectPromise(error);
		});
		server.once("exit", (code) => {
			clearTimeout(timeout);
			resolvePromise(code);
		});
	});
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
