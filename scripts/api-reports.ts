import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const configDir = join(root, "config", "api-extractor");
const tempDir = join(root, "temp", "api");
const reportDir = join(root, "api-reports");
const mode = process.argv[2];

if (mode !== "update" && mode !== "check") {
  console.error("Usage: bun scripts/api-reports.ts <update|check>");
  process.exit(2);
}

mkdirSync(tempDir, { recursive: true });
mkdirSync(reportDir, { recursive: true });

const configs = readdirSync(configDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

for (const configName of configs) {
  const configPath = join(configDir, configName);
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    apiReport: { reportFileName: string };
  };
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
