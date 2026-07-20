import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import * as sdkPublicSurface from "../index.js";

const PUBLIC_INDEX_PATH = join(import.meta.dir, "..", "index.ts");
const PACKAGE_ROOT = dirname(dirname(import.meta.dir));
const REPO_ROOT = findRepositoryRoot();

const FORBIDDEN_RUNTIME_TOKENS = [
	"ProbeRecorder",
	"ProbeScheduler",
	"GatewayClient",
	"RegistryProbe",
	"HealthMonitorRuntime",
	"ProbeError",
	"ProbeFailureKind",
	"ProviderProbeEntry",
	"apps/health-monitor",
	"apps/status",
	"apps/gateway",
	"@apifuse/health-monitor",
	"@apifuse/health-check-runtime",
	"__generated__",
	"packages/provider-registry/generated",
	"buildHealthCheckProjection",
	"probeId",
];

describe("provider-sdk public surface (architectural invariant)", () => {
	it("re-exports HealthCheck authoring types (positive surface)", () => {
		expect(sdkPublicSurface).toHaveProperty("PROBE_INTERVALS");
		expect(Array.isArray(sdkPublicSurface.PROBE_INTERVALS)).toBe(true);
		expect(sdkPublicSurface.PROBE_INTERVALS).toContain("1m");
	});

	it("exports canonical STT env constants", () => {
		expect(sdkPublicSurface.APIFUSE__STT__BACKEND_ENV).toBe("APIFUSE__STT__BACKEND");
		expect(sdkPublicSurface.APIFUSE__STT__MODEL_ENV).toBe("APIFUSE__STT__MODEL");
		expect(sdkPublicSurface.APIFUSE__STT__CLOUDFLARE_API_TOKEN_ENV).toBe(
			"APIFUSE__STT__CLOUDFLARE_API_TOKEN",
		);
	});

	it("never re-exports health-monitor runtime tokens from public index", () => {
		const indexSource = readFileSync(PUBLIC_INDEX_PATH, "utf8");
		for (const forbidden of FORBIDDEN_RUNTIME_TOKENS) {
			expect(
				indexSource.includes(forbidden),
				`public index.ts must not reference runtime token "${forbidden}" (provider-sdk-core: "Provider declarations remain runtime-agnostic at build time")`,
			).toBe(false);
		}
	});

	it("does not import any apps/health-monitor or __generated__ source", () => {
		const indexSource = readFileSync(PUBLIC_INDEX_PATH, "utf8");
		expect(indexSource.match(/from\s+["']apps\/health-monitor/)).toBeNull();
		expect(indexSource.match(/from\s+["']\.\.\/\.\.\/\.\.\/__generated__/)).toBeNull();
		expect(indexSource.match(/from\s+["'].*provider-registry\/generated/)).toBeNull();
		expect(indexSource.match(/from\s+["']apps\/status/)).toBeNull();
		expect(indexSource.match(/from\s+["']apps\/gateway/)).toBeNull();
	});

	it("HealthCheckCase type re-export does not pull in runtime modules", () => {
		const typesPath = join(import.meta.dir, "..", "types.ts");
		const typesSource = readFileSync(typesPath, "utf8");
		expect(typesSource.match(/from\s+["']apps\//)).toBeNull();
		expect(typesSource.match(/from\s+["']\.\.\/\.\.\/\.\.\/apps\//)).toBeNull();
		expect(typesSource.match(/from\s+["'].*\/__generated__/)).toBeNull();
		expect(typesSource.match(/from\s+["']@apifuse\/health-monitor/)).toBeNull();
	});

	it("provider-owned health journeys do not import runtime-only modules", () => {
		const journeyFiles = collectProviderHealthJourneyFiles(join(REPO_ROOT, "providers"));
		if (journeyFiles.length === 0) {
			return;
		}

		const forbiddenImportPattern =
			/(?:from\s+["'][^"']*(?:apps\/health-monitor|apps\/sms-inbox|__generated__|provider-registry\/generated|@apifuse\/health-monitor)|import\(\s*["'][^"']*(?:apps\/health-monitor|apps\/sms-inbox|__generated__|provider-registry\/generated|@apifuse\/health-monitor))/;

		for (const filePath of journeyFiles) {
			const source = readFileSync(filePath, "utf8");
			expect(
				source.match(forbiddenImportPattern),
				`${filePath} must keep provider-owned journey declarations independent from health-monitor runtime/generated modules`,
			).toBeNull();
		}
	});

	it("provider auth start flow type-check rejects input parameters", () => {
		const fixture = join(import.meta.dir, "fixtures", "auth-start-accepts-input.ts");
		const result = spawnSync(
			"bunx",
			[
				"tsgo",
				"--noEmit",
				"--strict",
				"--moduleResolution",
				"bundler",
				"--module",
				"ESNext",
				"--target",
				"ES2022",
				"--skipLibCheck",
				"--typeRoots",
				join(REPO_ROOT, "node_modules", "@types"),
				"--types",
				"bun",
				fixture,
			],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		);

		expect(
			result.status,
			`auth start fixture unexpectedly type-checked\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		).not.toBe(0);
	});

	it("provider-owned health journey files type-check against the provider authoring subpath", () => {
		const journeyFiles = collectProviderHealthJourneyFiles(join(REPO_ROOT, "providers"));
		if (journeyFiles.length === 0) {
			return;
		}

		const result = spawnSync(
			"bunx",
			[
				"tsgo",
				"--noEmit",
				"--strict",
				"--moduleResolution",
				"bundler",
				"--module",
				"ESNext",
				"--target",
				"ES2022",
				"--skipLibCheck",
				"--typeRoots",
				join(REPO_ROOT, "node_modules", "@types"),
				"--types",
				"bun",
				...journeyFiles,
			],
			{ cwd: REPO_ROOT, encoding: "utf8" },
		);

		expect(
			result.status,
			`provider health journey type-check failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		).toBe(0);
	});
});

function collectProviderHealthJourneyFiles(root: string): string[] {
	const files: string[] = [];
	if (!existsSync(root)) {
		return files;
	}
	for (const entry of readdirSync(root)) {
		if (entry === "__tests__" || entry === "node_modules") continue;
		const path = join(root, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...collectProviderHealthJourneyFiles(path));
			continue;
		}
		if (
			stat.isFile() &&
			path.endsWith(".ts") &&
			(path.endsWith("health-journeys.ts") || path.includes("/health-journeys/"))
		) {
			files.push(path);
		}
	}
	return files;
}

function findRepositoryRoot(): string {
	let current = PACKAGE_ROOT;
	while (true) {
		if (existsSync(join(current, "providers"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return PACKAGE_ROOT;
		}
		current = parent;
	}
}
