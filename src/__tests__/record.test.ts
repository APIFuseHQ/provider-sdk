import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { prepareFixturePayload } from "../../bin/apifuse-record.js";

const repoRoot = dirname(dirname(import.meta.dir));
const tempRoot = join(repoRoot, ".tmp-provider-sdk-record-tests");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	mkdirSync(tempRoot, { recursive: true });
	const directory = mkdtempSync(join(tempRoot, prefix));
	tempDirs.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("prepareFixturePayload", () => {
	it("appends to an existing array fixture", async () => {
		const fixturePath = join(makeTempDir("append-array-"), "raw.json");
		writeFileSync(fixturePath, JSON.stringify([{ capture: 1 }]));

		expect(await prepareFixturePayload(fixturePath, { capture: 2 }, true)).toEqual([
			{ capture: 1 },
			{ capture: 2 },
		]);
	});

	it("promotes an existing scalar fixture before appending", async () => {
		const fixturePath = join(makeTempDir("append-scalar-"), "raw.json");
		writeFileSync(fixturePath, JSON.stringify("date,name\n2026-01-01,New Year"));

		expect(await prepareFixturePayload(fixturePath, "next capture", true)).toEqual([
			"date,name\n2026-01-01,New Year",
			"next capture",
		]);
	});

	it("promotes an existing object fixture before appending", async () => {
		const fixturePath = join(makeTempDir("append-object-"), "raw.json");
		writeFileSync(fixturePath, JSON.stringify({ capture: 1 }));

		expect(await prepareFixturePayload(fixturePath, { capture: 2 }, true)).toEqual([
			{ capture: 1 },
			{ capture: 2 },
		]);
	});

	it("refuses to overwrite a corrupt fixture while appending", async () => {
		const fixturePath = join(makeTempDir("append-corrupt-"), "raw.json");
		writeFileSync(fixturePath, '{"capture":');

		await expect(prepareFixturePayload(fixturePath, { capture: 2 }, true)).rejects.toThrow(
			/corrupt fixture.*not valid JSON.*Fix or delete the fixture/,
		);
		expect(readFileSync(fixturePath, "utf8")).toBe('{"capture":');
	});
});

describe("record CLI", () => {
	it("invokes the operation once through the apifuse command dispatcher", async () => {
		let requestCount = 0;
		const upstream = createServer((_request, response) => {
			requestCount += 1;
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("recorded upstream body");
		});
		await new Promise<void>((resolve, reject) => {
			upstream.once("error", reject);
			upstream.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = upstream.address();
			if (address === null || typeof address === "string") {
				throw new Error(`Expected an IP upstream address, received ${String(address)}`);
			}
			const providerDir = makeTempDir("single-invocation-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "src", "index.ts")).href)};

export default {
  id: "record-single-invocation",
  version: "1.0.0",
  runtime: "standard",
  operations: {
    lookup: {
      input: z.object({}),
      output: z.string(),
      upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
      handler: async (ctx) => (await ctx.http.get("/payload")).data,
    },
  },
};
`,
			);

			const process = Bun.spawn({
				cmd: [
					"bun",
					join(repoRoot, "bin", "apifuse.ts"),
					"record",
					providerDir,
					"--operation",
					"lookup",
				],
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(process.stdout).text(),
				new Response(process.stderr).text(),
				process.exited,
			]);

			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Saved to");
			expect(requestCount).toBe(1);
			expect(JSON.parse(readFileSync(join(providerDir, "__fixtures__", "raw.json"), "utf8"))).toBe(
				"recorded upstream body",
			);
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("always redacts sensitiveParams from an echoed upstream request URL", async () => {
		let requestedUrl: string | undefined;
		const upstream = createServer((request, response) => {
			requestedUrl = request.url;
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					page: url.searchParams.get("page"),
					requestUrl: request.url,
					unrelatedEcho: url.searchParams.get("serviceKey"),
				}),
			);
		});
		await new Promise<void>((resolve, reject) => {
			upstream.once("error", reject);
			upstream.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = upstream.address();
			if (address === null || typeof address === "string") {
				throw new Error(`Expected an IP upstream address, received ${String(address)}`);
			}
			const providerDir = makeTempDir("sensitive-query-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "src", "index.ts")).href)};

export default {
  id: "record-sensitive-query",
  version: "1.0.0",
  runtime: "standard",
  operations: {
    lookup: {
      input: z.object({}),
      output: z.unknown(),
      upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
      handler: async (ctx) => (await ctx.http.get("/payload", {
        params: { page: 1 },
        sensitiveParams: { serviceKey: "record-test-secret" },
      })).data,
    },
  },
};
`,
			);

			const process = Bun.spawn({
				cmd: [
					"bun",
					join(repoRoot, "bin", "apifuse.ts"),
					"record",
					providerDir,
					"--operation",
					"lookup",
					"--no-sanitize",
				],
				cwd: repoRoot,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stderr, exitCode] = await Promise.all([
				new Response(process.stderr).text(),
				process.exited,
			]);

			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(requestedUrl).toBe("/payload?page=1&serviceKey=record-test-secret");
			const fixtureSource = readFileSync(join(providerDir, "__fixtures__", "raw.json"), "utf8");
			expect(fixtureSource).not.toContain("record-test-secret");
			expect(JSON.parse(fixtureSource)).toEqual({
				page: "1",
				requestUrl: "/payload?page=1&serviceKey=[REDACTED]",
				unrelatedEcho: "[REDACTED]",
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});
