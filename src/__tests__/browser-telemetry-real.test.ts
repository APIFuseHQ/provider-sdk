import { describe, expect, it } from "bun:test";
import {
	realBrowserAvailable,
	realBrowserRequired,
} from "./fixtures/real-browser-wrapper-availability.js";

describe.skipIf(!realBrowserAvailable && !realBrowserRequired)(
	"browser telemetry real cookie probes",
	() => {
		it("runs Playwright and CDP pool Set-Cookie echo probes in Chromium", async () => {
			const child = Bun.spawn(
				[process.execPath, "test", "./src/__tests__/fixtures/browser-telemetry-real.ts"],
				{ cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
			);
			const [exit, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			const output = `${stdout}\n${stderr}`;
			expect(exit, output).toBe(0);
			expect(output).toContain("APIFUSE_BROWSER_COOKIE_PROBE: playwright");
			expect(output).toContain("APIFUSE_BROWSER_COOKIE_PROBE: cdp-pool");
			console.log(output);
		}, 60000);
	},
);
