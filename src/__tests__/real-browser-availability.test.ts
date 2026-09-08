import { describe, expect, it } from "bun:test";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./fixtures/browser-proxy-auth-real.ts", import.meta.url));
const missingExecutablePath = "/nonexistent/apifuse-test-chromium";

async function runFixture(env: Record<string, string | undefined>) {
	// Bun colours its summary when FORCE_COLOR is inherited; keep the child output
	// plain so the line-anchored summary assertions below match.
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		FORCE_COLOR: undefined,
		NO_COLOR: "1",
		...env,
	};
	for (const [key, value] of Object.entries(childEnv)) {
		if (value === undefined) delete childEnv[key];
	}
	const child = Bun.spawn([process.execPath, "test", `./${relative(process.cwd(), fixture)}`], {
		cwd: process.cwd(),
		env: childEnv,
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, output: `${stdout}\n${stderr}` };
}

describe("real-browser fixture availability helper", () => {
	it("fails the child with the resolved path when the browser is required but missing", async () => {
		const { exitCode, output } = await runFixture({
			APIFUSE_TEST_BROWSER_EXECUTABLE_PATH: missingExecutablePath,
			APIFUSE_TEST_REQUIRE_REAL_BROWSER: "1",
		});

		expect(exitCode, output).not.toBe(0);
		expect(output).toContain("APIFUSE_TEST_REQUIRE_REAL_BROWSER=1");
		expect(output).toContain(missingExecutablePath);
		expect(output).toMatch(/^ 1 error$/m);
		expect(output).not.toMatch(/^ \d+ skip$/m);
	}, 30_000);

	it("skips the real-browser subtests when the browser is missing and not required", async () => {
		const { exitCode, output } = await runFixture({
			APIFUSE_TEST_BROWSER_EXECUTABLE_PATH: missingExecutablePath,
			APIFUSE_TEST_REQUIRE_REAL_BROWSER: undefined,
		});

		expect(exitCode, output).toBe(0);
		expect(output).toMatch(/^ 0 pass$/m);
		expect(output).toMatch(/^ 2 skip$/m);
		expect(output).toMatch(/^ 0 fail$/m);
		expect(output).not.toContain(missingExecutablePath);
	}, 30_000);
});
