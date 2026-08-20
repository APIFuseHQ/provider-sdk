import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const configDir = join(root, "config", "api-extractor");
const tempDir = join(root, "temp", "api");
const reportDir = join(root, "api-reports");
const mode = process.argv[2];

type PackageJson = {
	exports?: Record<string, unknown>;
};

type ApiExtractorConfig = {
	mainEntryPointFilePath: string;
	apiReport: { reportFileName: string };
};

type NonTypedExportExemption = {
	reason: string;
	targets: string[];
};

const nonTypedExportExemptions: Record<string, NonTypedExportExemption> = {
	"./auth-turn/auth-turn.v1.schema.json": {
		reason: "JSON Schema asset; API Extractor only reports TypeScript declaration entry points.",
		targets: ["./dist/auth-turn/auth-turn.v1.schema.json"],
	},
};

if (mode !== "update" && mode !== "check") {
	console.error("Usage: bun scripts/api-reports.ts <update|check>");
	process.exit(2);
}

mkdirSync(tempDir, { recursive: true });
mkdirSync(reportDir, { recursive: true });

const configs = readdirSync(configDir)
	.filter((name) => name.endsWith(".json"))
	.sort();

function collectStringTargets(target: unknown): string[] {
	if (typeof target === "string") return [target];
	if (Array.isArray(target)) return target.flatMap(collectStringTargets);
	if (typeof target !== "object" || target === null) return [];
	return Object.values(target).flatMap(collectStringTargets);
}

function collectTypesTargets(target: unknown): string[] {
	if (Array.isArray(target)) return target.flatMap(collectTypesTargets);
	if (typeof target !== "object" || target === null) return [];
	return Object.entries(target).flatMap(([condition, value]) =>
		condition === "types" ? collectStringTargets(value) : collectTypesTargets(value),
	);
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
const packageExports = Object.entries(packageJson.exports ?? {});
const typedExports = packageExports.flatMap(([exportName, value]) => {
	const typesTargets = [...new Set(collectTypesTargets(value))];
	return typesTargets.map((types) => ({
		exportName,
		types: types.replace(/^\.\//, ""),
	}));
});
const exemptExports = packageExports.flatMap(([exportName, value]) => {
	if (collectTypesTargets(value).length > 0) return [];
	const exemption = nonTypedExportExemptions[exportName];
	if (!exemption) return [];
	const actualTargets = [...new Set(collectStringTargets(value))].sort();
	const expectedTargets = [...exemption.targets].sort();
	if (JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets)) return [];
	return [{ exportName, ...exemption }];
});
const unclassifiedExports = packageExports.filter(([exportName, value]) => {
	if (collectTypesTargets(value).length > 0) return false;
	return !exemptExports.some((entry) => entry.exportName === exportName);
});
const staleExemptions = Object.entries(nonTypedExportExemptions).filter(
	([exportName]) => !exemptExports.some((entry) => entry.exportName === exportName),
);

console.log("Public export classification:");
for (const { exportName, types } of typedExports) {
	console.log(`  typed: ${exportName} (${types})`);
}
for (const { exportName, reason, targets } of exemptExports) {
	console.log(`  exempt asset: ${exportName} (${targets.join(", ")}) — ${reason}`);
}

if (unclassifiedExports.length > 0 || staleExemptions.length > 0) {
	console.error("Public export classification is incomplete or stale.");
	if (unclassifiedExports.length > 0) {
		console.error("Exports without a types condition or an exact non-typed asset exemption:");
		for (const [exportName] of unclassifiedExports) console.error(`  ${exportName}`);
	}
	if (staleExemptions.length > 0) {
		console.error("Non-typed asset exemptions that are absent, typed, or have different targets:");
		for (const [exportName] of staleExemptions) console.error(`  ${exportName}`);
	}
	process.exit(1);
}

const parsedConfigs = configs.map((configName) => {
	const configPath = join(configDir, configName);
	const config = JSON.parse(readFileSync(configPath, "utf8")) as ApiExtractorConfig;
	return {
		config,
		configName,
		configPath,
		types: config.mainEntryPointFilePath.replace(/^<projectFolder>\//, "").replace(/^\.\//, ""),
	};
});

const missingConfigs = typedExports.filter(
	({ types }) => !parsedConfigs.some((config) => config.types === types),
);
const extraConfigs = parsedConfigs.filter(
	({ types }) => !typedExports.some((entry) => entry.types === types),
);
const nonUniqueExports = [...new Set(typedExports.map(({ exportName }) => exportName))]
	.map((exportName) => ({
		exportName,
		types: typedExports
			.filter((entry) => entry.exportName === exportName)
			.map(({ types }) => types),
	}))
	.filter((entry) => entry.types.length > 1);
const nonUniqueTypes = [
	...new Set([
		...typedExports.map(({ types }) => types),
		...parsedConfigs.map(({ types }) => types),
	]),
]
	.map((types) => ({
		configs: parsedConfigs.filter((config) => config.types === types),
		exports: typedExports.filter((entry) => entry.types === types),
		types,
	}))
	.filter((entry) => entry.configs.length > 1 || entry.exports.length > 1);

if (
	missingConfigs.length > 0 ||
	extraConfigs.length > 0 ||
	nonUniqueExports.length > 0 ||
	nonUniqueTypes.length > 0
) {
	console.error("API Extractor config coverage does not match package.json typed exports.");
	if (missingConfigs.length > 0) {
		console.error("Missing configs for typed exports:");
		for (const entry of missingConfigs) console.error(`  ${entry.exportName} (${entry.types})`);
	}
	if (extraConfigs.length > 0) {
		console.error("Extra configs without typed exports:");
		for (const entry of extraConfigs) console.error(`  ${entry.configName} (${entry.types})`);
	}
	if (nonUniqueExports.length > 0) {
		console.error("Typed exports with multiple declaration entry points:");
		for (const entry of nonUniqueExports) {
			console.error(`  ${entry.exportName} (${entry.types.join(", ")})`);
		}
	}
	if (nonUniqueTypes.length > 0) {
		console.error("Typed entry points without one-to-one mappings:");
		for (const entry of nonUniqueTypes) {
			console.error(
				`  ${entry.types}: exports [${entry.exports.map(({ exportName }) => exportName).join(", ")}], configs [${entry.configs.map(({ configName }) => configName).join(", ")}]`,
			);
		}
	}
	process.exit(1);
}

for (const { config, configPath } of parsedConfigs) {
	const reportName = config.apiReport.reportFileName;
	const committed = join(reportDir, reportName);
	const committedBefore = mode === "check" ? readFileSync(committed, "utf8") : undefined;
	const result = Bun.spawnSync(
		["bunx", "api-extractor", "run", "--local", "--config", configPath],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);

	if (result.exitCode !== 0) {
		process.stderr.write(new TextDecoder().decode(result.stdout));
		process.stderr.write(new TextDecoder().decode(result.stderr));
		process.exit(result.exitCode ?? 1);
	}

	const generated = readFileSync(committed, "utf8");
	if (mode === "update") {
		console.log(`updated ${reportName}`);
	} else {
		writeFileSync(committed, committedBefore);
		if (committedBefore !== generated) {
			console.error(`API surface differs: ${reportName}`);
			console.error("Run `bun run api:update` and commit the resulting api-reports diff.");
			process.exitCode = 1;
		} else {
			console.log(`verified ${reportName}`);
		}
	}
}

if (mode === "check" && process.exitCode) {
	process.exit(process.exitCode);
}
