import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const BIN = join(REPO_ROOT, "bin", "apifuse-migrate-deployment.ts");

const INDEX = `import { defineProvider } from "@apifuse/provider-sdk/provider";

const buildProvider = defineProvider({
  id: "probe",
  version: "1.0.0",
  runtime: "standard",
  auth: { mode: "none" },
  meta: { displayName: "Probe", category: "other" },
});

export default buildProvider({ operations: {} });
`;
const ZERO_CONFIG_DEPLOY = `export default {
  "runtime": "shared",
  "language": "typescript",
  "replicas": 1,
  "hpa": { "enabled": true, "minReplicas": 1, "maxReplicas": 1, "targetCPUUtilizationPercentage": 70 },
  "resources": { "cpu": "25m", "memory": "128Mi" }
};
`;

interface BinReport {
	readonly status: string;
	readonly reason?: string;
	readonly touchedPaths?: readonly string[];
}

function runBin(args: readonly string[]): {
	readonly exitCode: number;
	readonly report: BinReport;
} {
	const result = Bun.spawnSync({
		cmd: ["bun", BIN, ...args, "--json"],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(result.stdout).trim();
	const line = stdout.split("\n").at(-1) ?? "";
	return { exitCode: result.exitCode, report: JSON.parse(line) as BinReport };
}

describe("apifuse migrate-deployment (command)", () => {
	it("refuses while another repository source imports the deploy module, then migrates", () => {
		const root = mkdtempSync(join(tmpdir(), "apifuse-migrate-deployment-"));
		try {
			writeFileSync(join(root, "index.ts"), INDEX);
			writeFileSync(join(root, "deploy.ts"), ZERO_CONFIG_DEPLOY);
			mkdirSync(join(root, "__tests__"));
			mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
			// Ignored tree: never a reason to refuse.
			writeFileSync(
				join(root, "node_modules", "dep", "index.ts"),
				'import d from "../../deploy";\n',
			);
			const consumer = join(root, "__tests__", "ready-promotion.test.ts");
			writeFileSync(
				consumer,
				'import deployment from "../deploy";\nexport const d = deployment;\n',
			);
			const jsxConsumer = join(root, "__tests__", "panel.jsx");
			writeFileSync(
				jsxConsumer,
				'import deployment from "../deploy";\nexport const P = () => <div>{deployment.runtime}</div>;\n',
			);

			const refused = runBin([root, "--check"]);
			expect(refused.exitCode).toBe(1);
			expect(refused.report.status).toBe("refused");
			expect(refused.report.reason).toContain("__tests__/ready-promotion.test.ts");
			expect(refused.report.reason).toContain("__tests__/panel.jsx");
			expect(existsSync(join(root, "deploy.ts"))).toBe(true);

			rmSync(consumer);
			rmSync(jsxConsumer);
			const check = runBin([root, "--check"]);
			expect(check.exitCode).toBe(0);
			expect(check.report.status).toBe("would-migrate");
			expect(check.report.touchedPaths).toEqual(["deploy.ts"]);
			expect(existsSync(join(root, "deploy.ts"))).toBe(true);

			const applied = runBin([root]);
			expect(applied.exitCode).toBe(0);
			expect(applied.report.status).toBe("migrated");
			expect(existsSync(join(root, "deploy.ts"))).toBe(false);

			const again = runBin([root]);
			expect(again.exitCode).toBe(0);
			expect(again.report.status).toBe("unchanged");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
