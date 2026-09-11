import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sdkRoot = join(import.meta.dir, "../..");

async function runCli(args: string[], root: string, env: Record<string, string>): Promise<number> {
	const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: "ignore" });
	return await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code) => resolve(code ?? 1));
	});
}

describe("apifuse test entry", () => {
	it("runs the fixture once through dispatcher and direct CLI", async () => {
		const root = mkdtempSync(join(tmpdir(), "apifuse-test-entry-"));
		const countPath = join(root, "test-bodies");
		const invocationPath = join(root, "bun-invocations");
		const binPath = join(root, "bin");
		try {
			mkdirSync(join(root, "__tests__"));
			mkdirSync(binPath);
			writeFileSync(join(root, "index.ts"), "export const fixture = true;\n");
			writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
			writeFileSync(join(root, "__tests__/index.test.ts"), `import { appendFileSync } from "node:fs";\nimport { expect, it } from "bun:test";\nappendFileSync(process.env.COUNT_PATH!, String(process.pid) + "\\n");\nit("passes", () => expect(true).toBe(true));\n`);
			const wrapper = join(binPath, "bun");
			writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$INVOCATION_PATH"\nexec ${process.execPath} "$@"\n`);
			chmodSync(wrapper, 0o755);
			const env = { PATH: `${binPath}:${process.env.PATH}`, COUNT_PATH: countPath, INVOCATION_PATH: invocationPath };
			expect(await runCli([join(sdkRoot, "bin/apifuse.ts"), "test", root], root, env)).toBe(0);
			expect(readFileSync(countPath, "utf8").trim().split("\n")).toHaveLength(1);
			expect(readFileSync(invocationPath, "utf8").trim().split("\n")).toHaveLength(1);
			rmSync(countPath); rmSync(invocationPath);
			expect(await runCli([join(sdkRoot, "bin/apifuse-test.ts"), root], root, env)).toBe(0);
			expect(readFileSync(countPath, "utf8").trim().split("\n")).toHaveLength(1);
			expect(readFileSync(invocationPath, "utf8").trim().split("\n")).toHaveLength(1);
			rmSync(countPath); rmSync(invocationPath);
			expect(await runCli([join(sdkRoot, "bin/apifuse.ts"), "test", root, "--json"], root, env)).toBe(0);
			expect(readFileSync(countPath, "utf8").trim().split("\n")).toHaveLength(1);
			expect(readFileSync(invocationPath, "utf8").trim().split("\n")).toHaveLength(1);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});
