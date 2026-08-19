import { describe, expect, it } from "bun:test";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
	realBrowserAvailable,
	realBrowserRequired,
} from "../../__tests__/fixtures/real-browser-wrapper-availability.js";

const realBrowserTest = fileURLToPath(
	new URL("../../__tests__/fixtures/browser-proxy-auth-real.ts", import.meta.url),
);

describe.skipIf(!realBrowserAvailable && !realBrowserRequired)(
	"authenticated proxy resource-policy interception",
	() => {
		it("covers successful and wrong-credential Chromium navigation in an isolated process", async () => {
			const child = Bun.spawn(
				[process.execPath, "test", `./${relative(process.cwd(), realBrowserTest)}`],
				{
					cwd: process.cwd(),
					env: { ...process.env },
					stderr: "pipe",
					stdout: "pipe",
				},
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);

			const output = `${stdout}\n${stderr}`;
			expect(exitCode, output).toBe(0);
			expect(output).toContain(
				"(pass) authenticated proxy resource-policy interception > completes navigation through a local authenticating proxy",
			);
			expect(output).toContain(
				"(pass) authenticated proxy resource-policy interception > wrong proxy credentials fail promptly instead of hanging",
			);
			console.log("APIFUSE_REAL_BROWSER_TESTS_COMPLETED: proxy-auth");
		}, 30_000);
	},
);
