import { expect, it } from "bun:test";

it("keeps SDK imports usable without a wreq-js native binary", async () => {
	const subprocess = Bun.spawn({
		cmd: [
			process.execPath,
			"--preload",
			new URL("./fixtures/missing-wreq-preload.ts", import.meta.url).pathname,
			new URL("./fixtures/missing-wreq-runner.ts", import.meta.url).pathname,
		],
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stderr).text(),
	]);

	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
});
