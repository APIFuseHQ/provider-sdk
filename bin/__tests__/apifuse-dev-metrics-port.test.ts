import { afterAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import {
	PROVIDER_METRICS_CONTENT_TYPE,
	PROVIDER_METRICS_ROUTE,
	PROVIDER_RUNTIME_METRICS_PORT_ENV,
} from "../../src/server/provider-metrics.js";
import { STATEFUL_PROVIDER_METRIC_NAMES } from "../../src/stateful/index.js";
import { STATEFUL_PROVIDER_METRIC_KINDS } from "../../src/stateful/stateful-provider-metric-registry.js";
import { parseDevArgs } from "../apifuse-dev.js";

const sdkRoot = join(import.meta.dir, "../..");
// Under the repo so the fixture's `zod` import resolves from the SDK's node_modules.
const tempRoot = join(sdkRoot, ".tmp");
const tempDirs: string[] = [];
const DEV_START_TIMEOUT_MS = 20_000;

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function writeProviderDir(): string {
	mkdirSync(tempRoot, { recursive: true });
	const dir = mkdtempSync(join(tempRoot, "apifuse-dev-metrics-port-"));
	tempDirs.push(dir);
	writeFileSync(
		join(dir, "index.ts"),
		`import { z } from "zod";

export default {
	id: "dev-metrics-port-provider",
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Dev Metrics Port Provider",
		descriptionKey: "providers.devMetricsPort.description",
		category: "test",
	},
	operations: {
		ping: {
			riskClass: "read",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			handler: async () => ({ ok: true }),
		},
	},
};
`,
	);
	return dir;
}

/** Distinct ports the OS reports free, all held open together so none repeats. */
async function freePorts(count: number): Promise<number[]> {
	const servers: Server[] = [];
	try {
		const ports: number[] = [];
		for (let index = 0; index < count; index += 1) {
			const server = createServer();
			servers.push(server);
			await new Promise<void>((resolve) => server.listen(0, resolve));
			const address = server.address();
			if (address === null || typeof address === "string") {
				throw new Error("Expected a TCP address from the port probe.");
			}
			ports.push(address.port);
		}
		return ports;
	} finally {
		await Promise.all(
			servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
		);
	}
}

type DevProcess = {
	readonly child: ChildProcess;
	readonly output: () => string;
};

function startApifuseDev(args: string[], cwd: string, env: Record<string, string>): DevProcess {
	const child = spawn(process.execPath, [join(sdkRoot, "bin/apifuse.ts"), "dev", ...args], {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk) => {
		output += chunk.toString();
	});
	return { child, output: () => output };
}

function hasExited(dev: DevProcess): boolean {
	return dev.child.exitCode !== null || dev.child.signalCode !== null;
}

async function waitForHealth(dev: DevProcess, port: number): Promise<void> {
	const deadline = Date.now() + DEV_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (hasExited(dev)) {
			throw new Error(
				`apifuse dev exited (${dev.child.exitCode}) before serving:\n${dev.output()}`,
			);
		}
		try {
			if ((await fetch(`http://127.0.0.1:${port}/health`)).status === 200) return;
		} catch {
			// Not listening yet.
		}
		await Bun.sleep(100);
	}
	throw new Error(`apifuse dev did not answer /health on ${port}:\n${dev.output()}`);
}

async function stopApifuseDev(dev: DevProcess): Promise<void> {
	if (hasExited(dev)) return;
	const exited = new Promise<void>((resolve) => dev.child.once("exit", () => resolve()));
	dev.child.kill("SIGKILL");
	await exited;
}

async function runApifuseDevToExit(
	args: string[],
	cwd: string,
): Promise<{ code: number | null; output: string }> {
	const dev = startApifuseDev(args, cwd, {});
	const code = await new Promise<number | null>((resolve, reject) => {
		dev.child.once("error", reject);
		dev.child.once("close", (exitCode) => resolve(exitCode));
	});
	return { code, output: dev.output() };
}

describe("apifuse dev --metrics-port", () => {
	it(
		"runs two dev servers on one host, each serving /metrics on its own port",
		async () => {
			const providerDir = writeProviderDir();
			const [firstApp, secondApp, firstMetrics, secondMetrics, sharedEnvMetrics] =
				await freePorts(5);
			// Both processes inherit the same metrics port from the shell; on its
			// own that makes the second one fail to bind. The flag outranks it.
			const sharedEnv = { [PROVIDER_RUNTIME_METRICS_PORT_ENV]: String(sharedEnvMetrics) };
			const first = startApifuseDev(
				[providerDir, "--metrics-port", String(firstMetrics)],
				providerDir,
				{ ...sharedEnv, APIFUSE__RUNTIME__PORT: String(firstApp) },
			);
			const second = startApifuseDev(
				[`--metrics-port=${secondMetrics}`, providerDir],
				providerDir,
				{
					...sharedEnv,
					APIFUSE__RUNTIME__PORT: String(secondApp),
				},
			);

			try {
				await Promise.all([waitForHealth(first, firstApp), waitForHealth(second, secondApp)]);

				for (const metricsPort of [firstMetrics, secondMetrics]) {
					const response = await fetch(`http://127.0.0.1:${metricsPort}${PROVIDER_METRICS_ROUTE}`);
					expect(response.status).toBe(200);
					expect(response.headers.get("content-type")).toBe(PROVIDER_METRICS_CONTENT_TYPE);
					const body = await response.text();
					for (const name of STATEFUL_PROVIDER_METRIC_NAMES) {
						expect(body).toContain(`# TYPE ${name} ${STATEFUL_PROVIDER_METRIC_KINDS[name]}\n`);
					}
				}
				expect(hasExited(first)).toBe(false);
				expect(hasExited(second)).toBe(false);
				await expect(
					fetch(`http://127.0.0.1:${sharedEnvMetrics}${PROVIDER_METRICS_ROUTE}`),
				).rejects.toThrow();
			} finally {
				await Promise.all([stopApifuseDev(first), stopApifuseDev(second)]);
			}
		},
		DEV_START_TIMEOUT_MS * 2,
	);

	it(
		"exits with the option name when the port is out of range",
		async () => {
			const providerDir = writeProviderDir();
			const result = await runApifuseDevToExit(
				[providerDir, "--metrics-port", "70000"],
				providerDir,
			);
			expect(result.code).toBe(1);
			expect(result.output).toContain("Invalid value for --metrics-port: 70000");
		},
		DEV_START_TIMEOUT_MS,
	);
});

describe("parseDevArgs", () => {
	it("reads both flag forms and keeps the first other argument as the provider path", () => {
		expect(parseDevArgs(["providers/a", "--metrics-port", "9191"])).toEqual({
			providerPath: "providers/a",
			metricsPort: 9191,
		});
		expect(parseDevArgs(["--metrics-port=9191", "providers/a"])).toEqual({
			providerPath: "providers/a",
			metricsPort: 9191,
		});
		expect(parseDevArgs([])).toEqual({ providerPath: ".", metricsPort: undefined });
	});

	it("rejects a missing value and anything outside 1 to 65535", () => {
		expect(() => parseDevArgs(["--metrics-port"])).toThrow("Missing value for --metrics-port");
		for (const value of ["0", "65536", "91a", "-1", ""]) {
			expect(() => parseDevArgs([`--metrics-port=${value}`])).toThrow(
				`Invalid value for --metrics-port: ${value}`,
			);
		}
	});
});
