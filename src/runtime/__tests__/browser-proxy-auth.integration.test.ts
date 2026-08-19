import { describe, expect, it } from "bun:test";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const realBrowserTest = fileURLToPath(
	new URL("../../__tests__/fixtures/browser-proxy-auth-real.ts", import.meta.url),
);

describe("authenticated proxy resource-policy interception", () => {
	it("covers successful and wrong-credential Chromium navigation in an isolated process", async () => {
		const child = Bun.spawn([process.execPath, "test", `./${relative(process.cwd(), realBrowserTest)}`], {
			cwd: process.cwd(),
			env: { ...process.env },
			stderr: "pipe",
			stdout: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);

		expect(`${stdout}\n${stderr}`).toContain("2 pass");
		expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
	}, 30_000);
});
