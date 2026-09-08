import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let scratch: string;
let entrypoint: string;
beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "http-telemetry-promise-"));
	entrypoint = join(scratch, "probe.mjs");
	const build = await Bun.build({
		entrypoints: [
			new URL("./fixtures/http-telemetry-promise-process.ts", import.meta.url).pathname,
		],
		target: "node",
		format: "esm",
		outdir: scratch,
		naming: "probe.mjs",
	});
	if (!build.success) throw new AggregateError(build.logs, "observer subprocess build failed");
});
afterAll(async () => {
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

it.each([
	"off",
	"species-start",
	"species-marker",
	"throwing-then",
	"sync-reject-thenable",
	"throwing-then-promise",
	"own-constructor",
	"frozen-promise",
])("Node stays alive during a pending fetch after observer return %s", async (mode) => {
	const probe = Bun.spawn({
		cmd: ["node", "--unhandled-rejections=strict", entrypoint, mode],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(probe.stdout).text(),
		new Response(probe.stderr).text(),
		probe.exited,
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	expect(JSON.parse(stdout)).toEqual({
		status: 200,
		fetches: 1,
		body: "ok",
		markers: mode === "off" ? 0 : 1,
		thenCalls: 0,
		speciesReads: 0,
		constructorRestored: true,
	});
});
