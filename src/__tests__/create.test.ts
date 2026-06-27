import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { buildSubmitCheckReport } from "../../bin/apifuse-submit-check";
import { COMMAND_MANIFEST } from "../cli/commands";
import {
	buildProviderCreatePlan,
	type CreateResolvedOptions,
	toDisplayName,
} from "../cli/create";

const SDK_NATIVE_CATEGORY = "sdk-native";

function materializePlan(
	plan: Awaited<ReturnType<typeof buildProviderCreatePlan>>,
): string {
	for (const file of plan.files) {
		mkdirSync(dirname(file.path), { recursive: true });
		writeFileSync(file.path, file.content);
	}
	return plan.providerRoot;
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

function createOptions(
	overrides: Partial<CreateResolvedOptions> = {},
): CreateResolvedOptions {
	return {
		name: "weather-provider",
		displayName: "Weather Provider",
		category: "data",
		authMode: "none",
		runtime: "standard",
		preset: "standalone",
		dryRun: true,
		json: false,
		yes: true,
		...overrides,
	};
}

function findGeneratedFile(
	plan: Awaited<ReturnType<typeof buildProviderCreatePlan>>,
	relativePath: string,
) {
	return plan.files.find(
		(file) => file.path === join(plan.providerRoot, relativePath),
	);
}

describe("provider create planning", () => {
	it("renders standalone providers without workspace dependencies", async () => {
		const cwd = makeTempDir("apifuse-create-standalone-");
		const plan = await buildProviderCreatePlan(createOptions(), cwd);
		const packageJson = plan.files.find((file) =>
			file.path.endsWith("package.json"),
		);

		expect(plan.preset).toBe("standalone");
		expect(plan.providerRoot).toBe(join(cwd, "weather-provider"));
		expect(
			packageJson?.content.includes('"@apifuse/provider-sdk": "workspace:*"'),
		).toBeFalse();
		expect(
			packageJson?.content.includes(
				'"check": "apifuse check . && bun run type-check"',
			),
		).toBeTrue();
		expect(
			packageJson?.content.includes('"type-check": "tsc --noEmit"'),
		).toBeTrue();
		expect(
			packageJson?.content.includes('"record": "apifuse record ."'),
		).toBeTrue();
		expect(
			packageJson?.content.includes(
				'"submit-check": "apifuse submit-check . --markdown submission-report.md"',
			),
		).toBeTrue();
		expect(packageJson?.content).not.toContain("record:sample");
		expect(packageJson?.content).toContain('"typescript": "');
		expect(packageJson?.content).toContain('"@types/bun": "');
		expect(plan.validationCommands).toContain("bun run submit-check");
		expect(plan.validationCommands).toContain("bun run type-check");
		expect(plan.nextDevCommand).toContain("bun run dev");
	});

	it("renders standalone ignore files for local-only artifacts", async () => {
		const cwd = makeTempDir("apifuse-create-ignore-files-");
		const plan = await buildProviderCreatePlan(createOptions(), cwd);
		const gitignore = findGeneratedFile(plan, ".gitignore");
		const dockerignore = findGeneratedFile(plan, ".dockerignore");

		expect(gitignore?.content).toContain("node_modules/");
		expect(gitignore?.content).toContain(".env");
		expect(gitignore?.content).toContain("coverage/");
		expect(gitignore?.content).toContain("dist/");
		expect(gitignore?.content).toContain("submission-report.md");
		expect(gitignore?.content).toContain(".DS_Store");
		expect(dockerignore?.content).toContain("node_modules/");
		expect(dockerignore?.content).toContain(".git/");
		expect(dockerignore?.content).toContain(".env");
		expect(dockerignore?.content).toContain("submission-report.md");
		expect(dockerignore?.content).toContain("coverage/");
	});

	it("renders monorepo providers under providers/<name> with workspace dependencies only inside the APIFuse monorepo", async () => {
		const cwd = makeTempDir("apifuse-create-monorepo-");
		mkdirSync(join(cwd, "providers"), { recursive: true });
		mkdirSync(join(cwd, "packages", "provider-sdk"), { recursive: true });
		writeFileSync(
			join(cwd, "package.json"),
			JSON.stringify({
				name: "@apifuse/root",
				workspaces: ["providers/*", "packages/*"],
			}),
		);
		writeFileSync(
			join(cwd, "packages", "provider-sdk", "package.json"),
			JSON.stringify({ name: "@apifuse/provider-sdk" }),
		);

		const plan = await buildProviderCreatePlan(
			createOptions({ preset: "monorepo" }),
			cwd,
		);
		const packageJson = plan.files.find((file) =>
			file.path.endsWith("package.json"),
		);

		expect(plan.providerRoot).toBe(join(cwd, "providers", "weather-provider"));
		expect(
			packageJson?.content.includes('"@apifuse/provider-sdk": "workspace:*"'),
		).toBeTrue();
		expect(plan.installCwd).toBe(cwd);
	});

	it("keeps external provider workspaces on the standalone one-provider-repo shape", async () => {
		const cwd = makeTempDir("apifuse-create-external-workspace-");
		mkdirSync(join(cwd, "providers"), { recursive: true });
		writeFileSync(
			join(cwd, "package.json"),
			JSON.stringify({
				name: "external-bounty-workspace",
				workspaces: ["providers/*"],
			}),
		);

		const plan = await buildProviderCreatePlan(createOptions(), cwd);
		const packageJson = plan.files.find((file) =>
			file.path.endsWith("package.json"),
		);

		expect(plan.preset).toBe("standalone");
		expect(plan.providerRoot).toBe(join(cwd, "weather-provider"));
		expect(packageJson?.content).not.toContain('"workspace:*"');
		expect(packageJson?.content).toContain('"@apifuse/provider-sdk": "^');
		expect(plan.installCwd).toBe(join(cwd, "weather-provider"));
	});

	it("rejects monorepo preset outside the APIFuse monorepo", async () => {
		const cwd = makeTempDir("apifuse-create-external-monorepo-");
		mkdirSync(join(cwd, "providers"), { recursive: true });
		writeFileSync(
			join(cwd, "package.json"),
			JSON.stringify({
				name: "external-bounty-workspace",
				workspaces: ["providers/*"],
			}),
		);

		expect(
			buildProviderCreatePlan(createOptions({ preset: "monorepo" }), cwd),
		).rejects.toThrow("Monorepo preset is internal to the APIFuse repository");
	});

	it("renders browser providers with the supported TypeScript browser engine", async () => {
		const cwd = makeTempDir("apifuse-create-browser-");
		const plan = await buildProviderCreatePlan(
			createOptions({ runtime: "browser" }),
			cwd,
		);
		const index = findGeneratedFile(plan, "index.ts");
		const readme = findGeneratedFile(plan, "README.md");

		expect(index?.content).toContain('runtime: "browser"');
		expect(index?.content).toContain('engine: "playwright-stealth"');
		expect(index?.content).not.toContain('engine: "nodriver"');
		expect(readme?.content).toContain('browser.engine: "playwright-stealth"');
		expect(readme?.content).toContain("nodriver` is Python-runtime only");
	});

	it("keeps top-level CLI examples aligned with generated starter limits", () => {
		expect(COMMAND_MANIFEST.record.examples.join("\n")).not.toContain(
			"apifuse record . --operation ping",
		);
		expect(COMMAND_MANIFEST.perf.usage).toContain("--params");
	});

	it("renders provider server contract docs with disconnect endpoint and split ports", async () => {
		const cwd = makeTempDir("apifuse-create-contract-");
		const plan = await buildProviderCreatePlan(createOptions(), cwd);
		const readme = findGeneratedFile(plan, "README.md");
		const devFile = plan.files.find((file) => file.path.endsWith("dev.ts"));
		const dockerfile = plan.files.find((file) =>
			file.path.endsWith("Dockerfile"),
		);

		expect(readme?.content).toContain("POST /auth/disconnect");
		expect(readme?.content).toContain('"requestId":"req_local_ping"');
		expect(readme?.content).not.toContain('"connection":null');
		expect(readme?.content).toContain("3900");
		expect(readme?.content).toContain("3000");
		expect(devFile?.content).toContain("3900");
		expect(dockerfile?.content).toContain("EXPOSE 3000");
		expect(findGeneratedFile(plan, "tsconfig.json")?.content).toContain(
			'"types": [',
		);
		expect(findGeneratedFile(plan, "tsconfig.json")?.content).toContain(
			'"bun"',
		);
	});

	it("renders starter health-check guidance that passes current provider validation contract", async () => {
		const cwd = makeTempDir("apifuse-create-health-coverage-");
		const plan = await buildProviderCreatePlan(createOptions(), cwd);
		const operation = findGeneratedFile(plan, join("operations", "ping.ts"));
		const readme = findGeneratedFile(plan, "README.md");

		expect(operation?.content).toContain("healthCheckUnsupported");
		expect(operation?.content).toContain(
			"Generated local-only scaffold operation",
		);
		expect(operation?.content).not.toContain("healthCheck: {");
		expect(readme?.content).toContain(
			"Every operation must declare exactly one",
		);
		expect(readme?.content).toContain(
			"preferred for safe read-only upstream probes",
		);
		expect(readme?.content).toContain(
			"apifuse record` is not expected to work with the generated local-only `ping`",
		);
		expect(readme?.content).toContain(
			"bun run record -- --operation <operation>",
		);
		expect(readme?.content).toContain("impit");
		expect(readme?.content).toContain("bunx playwright install chromium");
		expect(readme?.content).toContain("bun run submit-check");
	});

	it("renders split provider module layout with index as composition root", async () => {
		const cwd = makeTempDir("apifuse-create-module-layout-");
		const plan = await buildProviderCreatePlan(createOptions(), cwd);
		const generatedPaths = plan.files
			.map((file) => file.path.slice(plan.providerRoot.length + 1))
			.sort();
		const index = findGeneratedFile(plan, "index.ts");
		const operation = findGeneratedFile(plan, join("operations", "ping.ts"));
		const schema = findGeneratedFile(plan, join("schemas", "ping.ts"));
		const readme = findGeneratedFile(plan, "README.md");

		expect(generatedPaths).toContain("index.ts");
		expect(generatedPaths).toContain(".dockerignore");
		expect(generatedPaths).toContain(".gitignore");
		expect(generatedPaths).toContain("meta.ts");
		expect(generatedPaths).toContain(join("operations", "index.ts"));
		expect(generatedPaths).toContain(join("operations", "ping.ts"));
		expect(generatedPaths).toContain(join("schemas", "ping.ts"));
		expect(generatedPaths).toContain(join("upstream", "README.md"));
		expect(generatedPaths).toContain(join("mappers", "README.md"));
		expect(generatedPaths).toContain(join("domain", "README.md"));
		expect(index?.content).toContain('import { providerMeta } from "./meta";');
		expect(index?.content).toContain(
			'import { defineProvider } from "@apifuse/provider-sdk/provider";',
		);
		expect(index?.content).toContain(
			'import { operations } from "./operations";',
		);
		expect(index?.content).toContain("defineProvider({");
		expect(index?.content).toContain("meta: providerMeta");
		expect(index?.content).toContain("operations: operations");
		expect(index?.content).not.toContain("pingInputSchema");
		expect(index?.content).not.toContain("handler: async");
		expect(operation?.content).toContain(
			'import { defineOperation } from "@apifuse/provider-sdk/provider";',
		);
		expect(operation?.content).toContain("defineOperation({");
		expect(operation?.content).toContain(
			'import { pingInputSchema, pingOutputSchema } from "../schemas/ping";',
		);
		expect(schema?.content).toContain(
			'import { describeKey, z } from "@apifuse/provider-sdk/provider";',
		);
		expect(schema?.content).toContain("export const pingInputSchema");
		expect(schema?.content).not.toContain(".describeKey(");
		expect(schema?.content).toContain(
			'describeKey(z.string(), "schemaDescriptions.input.value")',
		);
		expect(readme?.content).toContain(
			"index.ts              # composition root",
		);
	});

	it("publishes CLI runtime prompt dependency as a production dependency", () => {
		const packageJson = JSON.parse(
			readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
		) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};

		expect(packageJson.dependencies?.["@clack/prompts"]).toBeString();
		expect(packageJson.devDependencies?.["@clack/prompts"]).toBeUndefined();
	});

	it("formats display names from kebab-case", () => {
		expect(toDisplayName("sample-provider")).toBe("Sample Provider");
	});

	it("generates a scaffold that passes every sdk-native submit-check rule", async () => {
		const cwd = makeTempDir("apifuse-create-sdk-native-");
		const plan = await buildProviderCreatePlan(
			createOptions({ dryRun: false, outputDir: join(cwd, "provider") }),
			cwd,
		);
		const providerRoot = materializePlan(plan);

		const report = await buildSubmitCheckReport(providerRoot);
		const sdkNativeChecks = report.checks.filter(
			(check) => check.category === SDK_NATIVE_CATEGORY,
		);

		// The scaffold must ship the four sdk-native rules and pass all of them:
		// id-slug, no-vendor-shim, no-vendor-import, describe-key.
		expect(sdkNativeChecks.length).toBeGreaterThanOrEqual(4);
		for (const check of sdkNativeChecks) {
			expect(check.status).toBe("pass");
		}
		expect(sdkNativeChecks.some((check) => check.id === "id-slug")).toBeTrue();
		expect(
			sdkNativeChecks.some((check) => check.id === "no-vendor-shim"),
		).toBeTrue();
		expect(
			sdkNativeChecks.some((check) => check.id === "no-vendor-import"),
		).toBeTrue();
		expect(
			sdkNativeChecks.some((check) => check.id === "describe-key"),
		).toBeTrue();
	});

	it("generates a browser-runtime scaffold that passes every sdk-native rule", async () => {
		const cwd = makeTempDir("apifuse-create-sdk-native-browser-");
		const plan = await buildProviderCreatePlan(
			createOptions({
				dryRun: false,
				runtime: "browser",
				outputDir: join(cwd, "provider"),
			}),
			cwd,
		);
		const providerRoot = materializePlan(plan);

		const report = await buildSubmitCheckReport(providerRoot);
		const sdkNativeChecks = report.checks.filter(
			(check) => check.category === SDK_NATIVE_CATEGORY,
		);

		expect(sdkNativeChecks.length).toBeGreaterThanOrEqual(4);
		for (const check of sdkNativeChecks) {
			expect(check.status).toBe("pass");
		}
	});

	it("detects sdk-native regressions when the scaffold is tampered", async () => {
		// Guard the guard: prove the assertion above actually fails when a
		// scaffold drifts away from the sdk-native shape. We inject each kind of
		// violation and require submit-check to flag it as a blocker.
		const cwd = makeTempDir("apifuse-create-sdk-native-regress-");
		const plan = await buildProviderCreatePlan(
			createOptions({ dryRun: false, outputDir: join(cwd, "provider") }),
			cwd,
		);
		const providerRoot = materializePlan(plan);

		// 1) vendor/ shim directory + vendor import
		mkdirSync(join(providerRoot, "vendor"), { recursive: true });
		writeFileSync(
			join(providerRoot, "vendor", "provider-sdk.ts"),
			"export const shim = 1;\n",
		);
		writeFileSync(
			join(providerRoot, "tampered.ts"),
			'import { shim } from "./vendor/provider-sdk";\nexport const apifuseProviderId = "apifuse-provider-test-scaffold";\nexport const used = shim;\n',
		);

		const report = await buildSubmitCheckReport(providerRoot);
		const failedSdkNative = report.checks.filter(
			(check) =>
				check.category === SDK_NATIVE_CATEGORY && check.status === "fail",
		);
		const failedIds = new Set(failedSdkNative.map((check) => check.id));

		expect(failedIds.has("no-vendor-shim")).toBeTrue();
		expect(failedIds.has("no-vendor-import")).toBeTrue();
		expect(failedIds.has("id-slug")).toBeTrue();
		expect(report.score.verdict).toBe("blocked");
	});
});
