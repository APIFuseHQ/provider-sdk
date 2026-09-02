import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { formatCliError, prepareFixturePayload } from "../../bin/apifuse-record.js";
import {
	findStreamCaptureGroup,
	findStreamEvidenceRecord,
	parseStreamEvidenceRecord,
	STREAM_PREVIEW_BYTES,
} from "../stream-evidence.js";

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
	it("includes a sanitized cause chain in CLI errors", () => {
		const token = "qJ8nV2xK9mP4sT7yB3cD6fG1hL5zX0aS8dF2gH7jK4lM9nP6qR1tV5wY8z";
		const cause = Object.assign(new Error(`socket reset token=${token}`), { code: "ECONNRESET" });
		const formatted = formatCliError(new Error("Stream capture read failed", { cause }));
		expect(formatted).toContain("cause=socket reset token=[REDACTED]");
		expect(formatted).toContain("code=ECONNRESET");
		expect(formatted).not.toContain(token);
	});

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

	it("migrates legacy stream evidence before appending a later ordinary invocation", async () => {
		const fixturePath = join(makeTempDir("append-legacy-stream-"), "raw.json");
		const evidence = {
			__apifuse_stream__: true,
			status: 200,
			ok: true,
			headers: {},
			body_sha256: createHash("sha256").update("").digest("hex"),
			body_bytes: 0,
			body_preview_base64: "",
		};
		writeFileSync(fixturePath, JSON.stringify(evidence));

		const appended = await prepareFixturePayload(fixturePath, { latest: "ordinary" }, true);
		expect(findStreamCaptureGroup(appended)).toBeUndefined();
		expect(appended).toEqual([
			{
				__apifuse_capture__: true,
				items: [{ kind: "stream", evidence }],
			},
			{ latest: "ordinary" },
		]);
	});

	it("preserves ordinary captures before legacy stream evidence during append migration", async () => {
		const fixturePath = join(makeTempDir("append-prefixed-legacy-stream-"), "raw.json");
		const ordinaryCapture = { capture: "ordinary-before-stream" };
		const evidence = {
			__apifuse_stream__: true,
			status: 200,
			ok: true,
			headers: {},
			body_sha256: createHash("sha256").update("").digest("hex"),
			body_bytes: 0,
			body_preview_base64: "",
		};
		writeFileSync(fixturePath, JSON.stringify([ordinaryCapture, evidence]));

		expect(await prepareFixturePayload(fixturePath, { latest: "ordinary" }, true)).toEqual([
			ordinaryCapture,
			{
				__apifuse_capture__: true,
				items: [{ kind: "stream", evidence }],
			},
			{ latest: "ordinary" },
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
	it("accepts operation params through a Standard Schema input", async () => {
		const upstream = createServer((request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ path: request.url }));
		});
		await new Promise<void>((resolve, reject) => {
			upstream.once("error", reject);
			upstream.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = upstream.address();
			if (address === null || typeof address === "string") throw new Error("Expected IP address");
			const providerDir = makeTempDir("standard-schema-input-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "index.js")).href)};
const input = {
  "~standard": {
    version: 1,
    vendor: "record-test",
    validate(value) {
      if (value && typeof value === "object" && typeof value.slug === "string") {
        return { value: { slug: value.slug } };
      }
      return { issues: [{ message: "slug must be a string" }] };
    },
  },
};
export default {
  id: "record-standard-schema", version: "1.0.0", runtime: "standard", http: true,
  operations: { lookup: {
    input, output: z.object({ path: z.string() }),
    upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
    handler: async (ctx, params) => (await ctx.http.get(\`/\${params.slug}\`)).data,
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
					"--params",
					'{"slug":"standard-schema"}',
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
			).toEqual({ path: "/standard-schema" });
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("forwards session cookies while recording an operation", async () => {
		const upstream = createServer((request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ received: request.headers.cookie ?? "" }));
		});
		await new Promise<void>((resolve, reject) => {
			upstream.once("error", reject);
			upstream.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = upstream.address();
			if (address === null || typeof address === "string") throw new Error("Expected IP address");
			const providerDir = makeTempDir("stealth-session-cookies-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "index.js")).href)};
export default {
  id: "record-stealth-session-cookies", version: "1.0.0", runtime: "standard", http: true,
  stealth: { browser: "chrome", os: "macos" },
  operations: { lookup: {
    input: z.object({}), output: z.object({ received: z.string() }),
    upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
    handler: async (ctx) => {
      const session = ctx.stealth.createSession();
      try {
        session.cookies.restore({ sid: "session-cookie-value" });
        if (typeof session.redirects.run !== "function") throw new Error("missing redirects API");
        return (await ctx.http.get("/cookie", {
          headers: { cookie: session.cookies.toHeader() },
        })).data;
      } finally {
        session.close();
      }
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
			).toEqual({ received: "sid=session-cookie-value" });
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("sanitizes ordinary JSON with the shared credential-key policy", async () => {
		const upstream = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					password: "hunter2",
					client_secret: "short-client-secret",
					cookie: "session=ordinary-value",
					public: "retained",
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
			const providerDir = makeTempDir("ordinary-sanitize-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "index.js")).href)};
export default {
  id: "record-ordinary-sanitize", version: "1.0.0", runtime: "standard", http: true,
  operations: { lookup: {
    input: z.object({}), output: z.object({ public: z.string() }),
    upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
    handler: async (ctx) => (await ctx.http.get("/payload")).data,
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
				password: "[REDACTED]",
				client_secret: "[REDACTED]",
				cookie: "[REDACTED]",
				public: "retained",
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("rejects SSE after an ordinary response without persisting the earlier capture", async () => {
		const upstream = createServer((request, response) => {
			if (request.url === "/ordinary") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end('{"retained":true}');
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end("event: ready\ndata: {}\n\n");
		});
		await new Promise<void>((resolve, reject) => {
			upstream.once("error", reject);
			upstream.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = upstream.address();
			if (address === null || typeof address === "string") throw new Error("Expected IP address");
			const providerDir = makeTempDir("ordinary-then-sse-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "index.js")).href)};
export default {
  id: "record-ordinary-then-sse", version: "1.0.0", runtime: "standard", http: true,
  operations: { events: {
    input: z.object({}), output: z.object({ ok: z.boolean() }),
    upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
    handler: async (ctx) => {
      await ctx.http.get("/ordinary");
      await ctx.http.sse("/events");
      return { ok: true };
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
					"events",
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
			expect(stderr).toContain("does not support ctx.http.sse(): method=GET path=/events call=2");
			expect(existsSync(join(providerDir, "__fixtures__", "raw.json"))).toBeFalse();
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

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
  http: true,
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

	it("captures stream evidence and gives the handler a complete replacement stream", async () => {
		const upstreamBody = Buffer.allocUnsafe(6000);
		for (let index = 0; index < upstreamBody.byteLength; index += 1) {
			upstreamBody[index] = [0xff, 0x00, 0x10, 0x80][index % 4] as number;
		}
		upstreamBody.set([0x89, 0x50, 0x4e, 0x47]);
		const expectedSha256 = createHash("sha256").update(upstreamBody).digest("hex");
		const upstream = createServer((request, response) => {
			if (request.url === "/status") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end('{"cleanup":"complete"}');
				return;
			}
			response.writeHead(200, {
				"content-disposition": 'attachment; filename="evidence.bin"',
				"content-length": String(upstreamBody.byteLength),
				"content-type": "application/octet-stream",
				"x-api-token": "must-not-be-recorded",
			});
			response.end(upstreamBody);
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
			const providerDir = makeTempDir("stream-capture-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "index.js")).href)};
import { createHash } from "node:crypto";

export default {
  id: "record-stream-capture",
  version: "1.0.0",
  runtime: "standard",
  http: true,
  operations: {
    download: {
      input: z.object({}),
      output: z.object({ bodyBytes: z.number(), bodySha256: z.string() }),
      upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
      handler: async (ctx) => {
        const response = await ctx.http.stream("/payload");
        const chunks = [];
        let bodyBytes = 0;
        for await (const chunk of response.bytes()) {
          chunks.push(chunk);
          bodyBytes += chunk.byteLength;
        }
        const body = Buffer.concat(chunks, bodyBytes);
        const bodySha256 = createHash("sha256").update(body).digest("hex");
        if (bodyBytes !== ${upstreamBody.byteLength} || bodySha256 !== ${JSON.stringify(expectedSha256)}) {
          throw new Error("record handler received an incomplete replacement stream");
        }
        await ctx.http.get("/status");
        return { bodyBytes, bodySha256 };
      },
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
					"download",
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
			const recordedCapture = JSON.parse(
				readFileSync(join(providerDir, "__fixtures__", "raw.json"), "utf8"),
			) as unknown;
			const recordedTimeline = findStreamCaptureGroup(recordedCapture)?.items;
			expect(recordedTimeline).toHaveLength(2);
			expect(recordedTimeline?.[0]?.kind).toBe("stream");
			const firstEvidence = recordedTimeline?.[0];
			if (firstEvidence?.kind !== "stream") {
				throw new Error("Expected first recorded item to be stream evidence.");
			}
			expect(parseStreamEvidenceRecord(firstEvidence.evidence)).toEqual({
				__apifuse_stream__: true,
				status: 200,
				ok: true,
				headers: {
					"content-disposition": 'attachment; filename="evidence.bin"',
					"content-length": String(upstreamBody.byteLength),
					"content-type": "application/octet-stream",
				},
				body_sha256: expectedSha256,
				body_bytes: upstreamBody.byteLength,
				body_preview_base64: upstreamBody.subarray(0, STREAM_PREVIEW_BYTES).toString("base64"),
				request: { ordinal: 1, method: "GET", path: "/payload" },
			});
			expect(recordedTimeline?.[1]).toEqual({
				kind: "response",
				value: { cleanup: "complete" },
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("records and finalizes every stream opened by one operation in call order", async () => {
		const firstBody = Buffer.from("first stream body");
		const secondBody = Buffer.from("second stream body");
		const responseResolutionOrder: string[] = [];
		let firstResponse: import("node:http").ServerResponse | undefined;
		const upstream = createServer((request, response) => {
			if (request.url === "/first") {
				firstResponse = response;
				return;
			}
			responseResolutionOrder.push("second");
			response.writeHead(200, {
				"content-length": String(secondBody.byteLength),
				"content-type": "application/octet-stream",
			});
			response.end(secondBody);
			setTimeout(() => {
				responseResolutionOrder.push("first");
				firstResponse?.writeHead(200, {
					"content-length": String(firstBody.byteLength),
					"content-type": "application/octet-stream",
				});
				firstResponse?.end(firstBody);
			}, 10);
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
			const providerDir = makeTempDir("multi-stream-capture-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "index.js")).href)};

export default {
  id: "record-multi-stream-capture",
  version: "1.0.0",
  runtime: "standard",
  http: true,
  operations: {
    download: {
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
      handler: async (ctx) => {
		const firstPromise = ctx.http.stream("/first");
		const secondPromise = ctx.http.stream("/second");
		const [first, second] = await Promise.all([firstPromise, secondPromise]);
        const firstReader = first.body.getReader();
        await firstReader.read();
        await firstReader.cancel("probe complete");
        for await (const _chunk of second.bytes()) {}
        return { ok: true };
      },
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
					"download",
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
			const rawFixture = JSON.parse(
				readFileSync(join(providerDir, "__fixtures__", "raw.json"), "utf8"),
			) as unknown;
			const records = (findStreamCaptureGroup(rawFixture)?.items ?? []).flatMap((item) =>
				item.kind === "stream" ? [item.evidence] : [],
			);
			expect(records.map((record) => record.request)).toEqual([
				{ ordinal: 1, method: "GET", path: "/first" },
				{ ordinal: 2, method: "GET", path: "/second" },
			]);
			expect(records.map((record) => record.body_sha256)).toEqual([
				createHash("sha256").update(firstBody).digest("hex"),
				createHash("sha256").update(secondBody).digest("hex"),
			]);
			expect(responseResolutionOrder).toEqual(["second", "first"]);
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("sanitizes credentials in streamed JSON with no content type before base64 encoding", async () => {
		const accessToken = "streamed-access-token-that-must-never-reach-the-fixture";
		const apiKey = "streamed-api-key-that-must-never-reach-the-fixture";
		const pathToken = "bot123456789:AAE9c8QvL1nX7wZ2rP6sT4uY5iO0aB3c";
		const upstreamBody = Buffer.from(
			JSON.stringify({ access_token: accessToken, nested: { apiKey }, public: "retained" }),
		);
		const upstream = createServer((_request, response) => {
			response.writeHead(200, {
				"content-length": String(upstreamBody.byteLength),
			});
			response.end(upstreamBody);
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
			const providerDir = makeTempDir("stream-json-sanitize-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "index.js")).href)};

export default {
  id: "record-stream-json-sanitize",
  version: "1.0.0",
  runtime: "standard",
  http: true,
  operations: {
    download: {
      input: z.object({}),
      output: z.object({ public: z.string() }),
      upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
      handler: async (ctx) => {
        const response = await ctx.http.stream(${JSON.stringify(`/${pathToken}/download`)});
        const chunks = [];
        for await (const chunk of response.bytes()) chunks.push(chunk);
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed.access_token !== ${JSON.stringify(accessToken)} || parsed.nested.apiKey !== ${JSON.stringify(apiKey)}) {
          throw new Error("record handler did not receive the original streamed JSON body");
        }
        return { public: parsed.public };
      },
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
					"download",
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
			const rawCapture = JSON.parse(
				readFileSync(join(providerDir, "__fixtures__", "raw.json"), "utf8"),
			) as unknown;
			const rawFixture = findStreamEvidenceRecord(rawCapture);
			if (!rawFixture) throw new Error("Expected recorded stream evidence.");
			const fixtureSource = readFileSync(join(providerDir, "__fixtures__", "raw.json"), "utf8");
			const decodedPreview = Buffer.from(rawFixture.body_preview_base64, "base64");

			expect(fixtureSource).not.toContain(accessToken);
			expect(fixtureSource).not.toContain(apiKey);
			expect(fixtureSource).not.toContain(pathToken);
			expect(rawFixture.request?.path).toBe("/[REDACTED]/download");
			expect(decodedPreview).toHaveLength(rawFixture.body_bytes);
			expect(decodedPreview.toString("utf8")).not.toContain(accessToken);
			expect(decodedPreview.toString("utf8")).not.toContain(apiKey);
			expect(JSON.parse(decodedPreview.toString("utf8"))).toEqual({
				access_token: "[REDACTED]",
				nested: { apiKey: "[REDACTED]" },
				public: "retained",
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("redacts sensitiveParams from stream evidence under --no-sanitize", async () => {
		const secret = "stream-secret";
		const upstream = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			response.writeHead(200, {
				"content-disposition": `attachment; filename=${secret}.json`,
				"content-type": "application/json",
			});
			response.end(
				JSON.stringify({
					echo: url.searchParams.get("api_key"),
					prose: `request ${url.pathname}?api_key=${secret} completed`,
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
			const providerDir = makeTempDir("stream-sensitive-params-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "dist", "index.js")).href)};
export default { id: "record-stream-sensitive-params", version: "1.0.0", runtime: "standard", http: true,
 operations: { download: { input: z.object({}), output: z.object({ ok: z.boolean() }),
 upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
 handler: async (ctx) => {
   const response = await ctx.http.stream("/download/${secret}", {
     params: { api_key: "${secret}" }, sensitiveParams: { api_key: "${secret}" },
   });
   const chunks = [];
   for await (const chunk of response.bytes()) chunks.push(chunk);
   const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
   if (parsed.echo !== "${secret}") throw new Error("handler did not receive original stream");
   return { ok: true };
 }, } } };
`,
			);

			const process = Bun.spawn({
				cmd: [
					"bun",
					join(repoRoot, "bin", "apifuse.ts"),
					"record",
					providerDir,
					"--operation",
					"download",
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
			const evidence = findStreamEvidenceRecord(JSON.parse(fixtureSource) as unknown);
			if (!evidence) throw new Error("Expected recorded stream evidence.");
			const preview = Buffer.from(evidence.body_preview_base64, "base64").toString("utf8");
			expect(fixtureSource).not.toContain(secret);
			expect(evidence.request?.path).toBe("/download/[REDACTED]");
			expect(evidence.headers["content-disposition"]).toBe("attachment; filename=[REDACTED].json");
			expect(preview).not.toContain(secret);
			expect(JSON.parse(preview)).toEqual({
				echo: "[REDACTED]",
				prose: "request /download/[REDACTED]?api_key=[REDACTED] completed",
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("redacts captured sensitive values when the operation throws after a request", async () => {
		const secret = "record-error-secret";
		const upstream = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true }));
		});
		await new Promise<void>((resolve, reject) => {
			upstream.once("error", reject);
			upstream.listen(0, "127.0.0.1", resolve);
		});

		try {
			const address = upstream.address();
			if (address === null || typeof address === "string") throw new Error("Expected IP address");
			const providerDir = makeTempDir("error-redaction-");
			writeFileSync(join(providerDir, "package.json"), '{"type":"module"}\n');
			writeFileSync(
				join(providerDir, "index.ts"),
				`import { ProviderError, z } from ${JSON.stringify(pathToFileURL(join(repoRoot, "src", "index.ts")).href)};
export default { id: "record-error-redaction", version: "1.0.0", runtime: "standard", http: true,
 operations: { lookup: { input: z.object({}), output: z.unknown(),
 upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
 handler: async (ctx) => {
   await ctx.http.get("/", { sensitiveParams: { token: ${JSON.stringify(secret)} } });
   throw new ProviderError("upstream echoed ${secret}", { code: "failure_${secret}" });
 },
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
			expect(stderr).toContain("upstream echoed [REDACTED]");
			expect(stderr).toContain("code=failure_[REDACTED]");
			expect(stderr).not.toContain(secret);
		} finally {
			await new Promise<void>((resolve, reject) => {
				upstream.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("redacts declared append-history secrets without re-sanitizing historical common fields", async () => {
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
					embeddedShortEcho: "prefix-pin-suffix",
					numericEcho: 123456,
					serviceKey: "public-result",
					"prefixrecord-test-secretsuffix": true,
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
  http: true,
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
			      shortKey: "pin",
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
				JSON.stringify({
					legacy: "/payload?serviceKey=legacy-url-secret",
					echo: "legacy-url-secret",
					prose: "request https://api.test/x?serviceKey=old-secret failed; retry later",
					authorization: "historical-public-value",
				}),
			);

			const process = Bun.spawn({
				cmd: [
					"bun",
					join(repoRoot, "bin", "apifuse.ts"),
					"record",
					providerDir,
					"--operation",
					"lookup",
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
				"/payload?serviceKey=url-secret&page=1&serviceKey=params-secret&serviceKey=123456&serviceKey=record-test-secret&encodedKey=space+%2B%2F%25%3D&shortKey=pin",
			);
			const fixtureSource = readFileSync(join(providerDir, "__fixtures__", "raw.json"), "utf8");
			expect(fixtureSource).not.toContain("record-test-secret");
			expect(fixtureSource).not.toContain("params-secret");
			expect(fixtureSource).not.toContain("url-secret");
			expect(fixtureSource).not.toContain("space +/%=");
			expect(fixtureSource).not.toContain("space+%2B%2f%25%3d");
			expect(JSON.parse(fixtureSource)).toEqual([
				{
					legacy: "/payload?serviceKey=[REDACTED]",
					echo: "[REDACTED]",
					prose: "request https://api.test/x?serviceKey=[REDACTED] failed; retry later",
					authorization: "historical-public-value",
				},
				{
					page: "1",
					requestUrl:
						"/payload?serviceKey=[REDACTED]&page=1&serviceKey=[REDACTED]&serviceKey=[REDACTED]&serviceKey=[REDACTED]&encodedKey=[REDACTED]&shortKey=[REDACTED]",
					unrelatedEcho: "[REDACTED]",
					embeddedShortEcho: "prefix-[REDACTED]-suffix",
					numericEcho: "[REDACTED]",
					serviceKey: "public-result",
					"prefix[REDACTED]suffix": true,
					"prefix-[REDACTED]-suffix": false,
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
  id: "record-post-put", version: "1.0.0", runtime: "standard", http: true,
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
			expect(fixtureSource).not.toContain("654321");
			expect(JSON.parse(fixtureSource)).toEqual({
				postEcho: "[REDACTED]",
				putEcho: "[REDACTED]",
				numericEcho: "[REDACTED]",
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
			if (url.pathname === "/direct") {
				response.writeHead(302, { location: "/direct-final?directKey=rotated-direct-secret" });
				response.end();
				return;
			}
			if (url.pathname === "/redirect") {
				response.writeHead(302, { location: "/final?redirectKey=rotated-secret" });
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
  stealth: { browser: "chrome", os: "macos" },
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
			expect(receivedSecrets).toEqual([
				"direct-secret",
				"rotated-direct-secret",
				"session-secret",
				"redirect-secret",
				"rotated-secret",
			]);
			const fixtureSource = readFileSync(join(providerDir, "__fixtures__", "raw.json"), "utf8");
			for (const secret of receivedSecrets) expect(fixtureSource).not.toContain(secret);
			expect(JSON.parse(fixtureSource)).toEqual({
				receivedSecrets: ["[REDACTED]", "[REDACTED]", "[REDACTED]", "[REDACTED]", "[REDACTED]"],
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
					differentlyCasedUrl: "/callback?ServiceKey=public",
					emptyName: "",
					emptyNote: "",
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
export default { id: "record-default", version: "1.0.0", runtime: "standard", http: true,
 operations: { lookup: { input: z.object({}), output: z.unknown(),
 upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
 handler: async (ctx) => (await ctx.http.get("/", {
   sensitiveParams: { serviceKey: "default-secret", shortKey: "api", longKey: "long-value", emptyKey: "" },
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
				differentlyCasedUrl: "/callback?ServiceKey=public",
				emptyName: "",
				emptyNote: "",
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
export default { id: "record-invalid", version: "1.0.0", runtime: "standard", http: true,
 operations: { lookup: { input: z.object({}), output: z.unknown(),
 upstream: { baseUrl: "http://127.0.0.1:${address.port}" },
 handler: async (ctx) => (await ctx.http.get("/", {
   // @ts-expect-error test-invalid: runtime sensitiveParams validation must reject numbers.
   sensitiveParams: { pin: 123456 },
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
