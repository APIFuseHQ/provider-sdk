import { describe, expect, it } from "bun:test";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
	realBrowserAvailable,
	realBrowserRequired,
} from "../../__tests__/fixtures/real-browser-availability.js";

const realBrowserTest = fileURLToPath(
	new URL("../../__tests__/fixtures/resolver-browser-egress-real.ts", import.meta.url),
);

describe.skipIf(!realBrowserAvailable && !realBrowserRequired)(
	"real resolver browser egress policy",
	() => {
		it("enforces redirect, subresource, popup, and service-worker boundaries in Chromium", async () => {
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
			for (const testName of [
				"blocks an allowed navigation before dialing its undeclared redirect target",
				"allows an authorized multi-hop navigation and preserves its intermediate cookie",
				"blocks an undeclared subresource redirect target before it is dialed",
				"blocks an allowed popup before dialing its undeclared redirect target",
				"blocks service workers in the resolver context",
			]) {
				expect(output).toContain(`(pass) real resolver browser egress policy > ${testName}`);
			}
			console.log("APIFUSE_REAL_BROWSER_TESTS_COMPLETED: resolver-egress");
		}, 30_000);
	},
);
