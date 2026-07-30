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

	it("redacts every declared-key value, scalar echo, and property key while preserving append history", async () => {
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
					embeddedShortEcho: "prefix-api-suffix",
					numericEcho: 123456,
					serviceKey: "public-result",
					"prefix-record-test-secret-suffix": true,
					"prefix-[REDACTED]-suffix": false,
					encodedUrl: request.url?.replaceAll("%2F", "%2f").replaceAll("%3D", "%3d"),
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
			  handler: async (ctx) => (await ctx.http.get("/payload?serviceKey=url-secret", {
			    params: { page: 1, serviceKey: ["params-secret", 123456] },
			    sensitiveParams: {
			      serviceKey: "record-test-secret",
			      encodedKey: "space +/%=",
			      shortKey: "api",
			    },
      })).data,
    },
  },
};
`,
			);
			mkdirSync(join(providerDir, "__fixtures__"), { recursive: true });
			writeFileSync(
				join(providerDir, "__fixtures__", "raw.json"),
				JSON.stringify({ legacy: "/payload?serviceKey=params-secret" }),
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
					"--append",
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
			expect(requestedUrl).toBe(
				"/payload?serviceKey=url-secret&page=1&serviceKey=params-secret&serviceKey=123456&serviceKey=record-test-secret&encodedKey=space+%2B%2F%25%3D&shortKey=api",
			);
			const fixtureSource = readFileSync(join(providerDir, "__fixtures__", "raw.json"), "utf8");
			expect(fixtureSource).not.toContain("record-test-secret");
			// Append preserves existing fixture bytes, including captures that were
			// intentionally recorded under an earlier sanitization policy.
			expect(fixtureSource).toContain("params-secret");
			expect(fixtureSource).not.toContain("url-secret");
			expect(fixtureSource).not.toContain("space +/%=");
			expect(fixtureSource).not.toContain("space+%2B%2f%25%3d");
			expect(JSON.parse(fixtureSource)).toEqual([
				{ legacy: "/payload?serviceKey=params-secret" },
				{
					page: "1",
					requestUrl:
						"/payload?serviceKey=[REDACTED]&page=1&serviceKey=[REDACTED]&serviceKey=[REDACTED]&serviceKey=[REDACTED]&encodedKey=[REDACTED]&shortKey=[REDACTED]",
					unrelatedEcho: "[REDACTED]",
					embeddedShortEcho: "prefix-[REDACTED]-suffix",
					numericEcho: 123456,
					serviceKey: "public-result",
					"prefix-[REDACTED]-suffix": true,
					"prefix-[REDACTED]-suffix#2": false,
					encodedUrl:
						"/payload?serviceKey=[REDACTED]&page=1&serviceKey=[REDACTED]&serviceKey=[REDACTED]&serviceKey=[REDACTED]&encodedKey=[REDACTED]&shortKey=[REDACTED]",
				},
			]);
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("captures post and put options from their third argument", async () => {
		let postSecret: string | undefined;
		const upstream = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (request.method === "POST") postSecret = url.searchParams.get("postKey") ?? undefined;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					postEcho: postSecret,
					putEcho: url.searchParams.get("putKey"),
					numericEcho: 654321,
				}),
			);
		});
		await new Promise<void>((resolve, reject) => {
			upstream.once("error", reject);
			upstream.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = upstream.address();
			if (address === null || typeof address === "string") throw new Error("Expected IP address");
			const providerDir = makeTempDir("post-put-sensitive-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "src", "index.ts")).href)};
export default {
  id: "record-post-put", version: "1.0.0", runtime: "standard",
  operations: { lookup: { input: z.object({}), output: z.unknown(),
    upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
    handler: async (ctx) => {
      await ctx.http.post("/post", {}, { sensitiveParams: { postKey: "post-secret" } });
      return (await ctx.http.put("/put", {}, { sensitiveParams: { putKey: "654321" } })).data;
    },
  } },
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
			const fixtureSource = readFileSync(join(providerDir, "__fixtures__", "raw.json"), "utf8");
			expect(fixtureSource).not.toContain("post-secret");
			expect(fixtureSource).toContain("654321");
			expect(JSON.parse(fixtureSource)).toEqual({
				postEcho: "[REDACTED]",
				putEcho: "[REDACTED]",
				numericEcho: 654321,
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("captures stealth.fetch, session.fetch, and redirects.run sensitive values", async () => {
		const receivedSecrets: string[] = [];
		const upstream = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			for (const key of ["directKey", "sessionKey", "redirectKey"]) {
				const value = url.searchParams.get(key);
				if (value) receivedSecrets.push(value);
			}
			if (url.pathname === "/redirect") {
				response.writeHead(302, { location: "/final" });
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ receivedSecrets }));
		});
		await new Promise<void>((resolve, reject) => {
			upstream.once("error", reject);
			upstream.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = upstream.address();
			if (address === null || typeof address === "string") throw new Error("Expected IP address");
			const providerDir = makeTempDir("stealth-sensitive-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "src", "index.ts")).href)};
export default {
  id: "record-stealth", version: "1.0.0", runtime: "standard",
  operations: { lookup: { input: z.object({}), output: z.unknown(),
    upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
    handler: async (ctx) => {
      await ctx.stealth.fetch("/direct", { sensitiveParams: { directKey: "direct-secret" } });
      const session = ctx.stealth.createSession();
      await session.fetch("/session", { sensitiveParams: { sessionKey: "session-secret" } });
      const result = await session.redirects.run({
        url: "/redirect", sensitiveParams: { redirectKey: "redirect-secret" },
      });
      session.close();
      return result.final.json();
    },
  } },
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
			expect(receivedSecrets).toEqual(["direct-secret", "session-secret", "redirect-secret"]);
			const fixtureSource = readFileSync(join(providerDir, "__fixtures__", "raw.json"), "utf8");
			for (const secret of receivedSecrets) expect(fixtureSource).not.toContain(secret);
			expect(JSON.parse(fixtureSource)).toEqual({
				receivedSecrets: ["[REDACTED]", "[REDACTED]", "[REDACTED]"],
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("keeps sensitiveParams redaction in the default sanitizer without discarding unrelated same-name data", async () => {
		const upstream = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					authorization: "public-header",
					serviceKey: "public-result",
					echo: "default-secret",
					exactShortEcho: "api",
					embeddedShortEcho: "prefix-api-suffix",
					unrelatedShortText: "rapid response",
					unrelatedLongText: "contest result",
				}),
			);
		});
		await new Promise<void>((resolve, reject) => {
			upstream.once("error", reject);
			upstream.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = upstream.address();
			if (address === null || typeof address === "string") throw new Error("Expected IP address");
			const providerDir = makeTempDir("default-sanitize-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "src", "index.ts")).href)};
export default { id: "record-default", version: "1.0.0", runtime: "standard",
 operations: { lookup: { input: z.object({}), output: z.unknown(),
 upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
 handler: async (ctx) => (await ctx.http.get("/", {
   sensitiveParams: { serviceKey: "default-secret", shortKey: "api", longKey: "test" },
 })).data,
 } } };
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
			const [stderr, exitCode] = await Promise.all([
				new Response(process.stderr).text(),
				process.exited,
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(
				JSON.parse(readFileSync(join(providerDir, "__fixtures__", "raw.json"), "utf8")),
			).toEqual({
				authorization: "[REDACTED]",
				serviceKey: "public-result",
				echo: "[REDACTED]",
				exactShortEcho: "[REDACTED]",
				embeddedShortEcho: "prefix-[REDACTED]-suffix",
				unrelatedShortText: "rapid response",
				unrelatedLongText: "contest result",
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("fails closed when runtime sensitiveParams values are not strings", async () => {
		let requestCount = 0;
		const upstream = createServer((_request, response) => {
			requestCount += 1;
			response.end("unexpected");
		});
		await new Promise<void>((resolve, reject) => {
			upstream.once("error", reject);
			upstream.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = upstream.address();
			if (address === null || typeof address === "string") throw new Error("Expected IP address");
			const providerDir = makeTempDir("invalid-sensitive-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "src", "index.ts")).href)};
export default { id: "record-invalid", version: "1.0.0", runtime: "standard",
 operations: { lookup: { input: z.object({}), output: z.unknown(),
 upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
 handler: async (ctx) => (await ctx.http.get("/", {
   sensitiveParams: { pin: 123456 } as any,
 })).data,
 } } };
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
			const [stderr, exitCode] = await Promise.all([
				new Response(process.stderr).text(),
				process.exited,
			]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("sensitiveParams.pin must be a string");
			expect(stderr).not.toContain("123456");
			expect(requestCount).toBe(0);
			expect(() => readFileSync(join(providerDir, "__fixtures__", "raw.json"), "utf8")).toThrow();
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});
