import { describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { defineProvider } from "../define.js";
import * as sdk from "../index.js";
import { isStreamEvidenceReplayResponse } from "../stream-evidence.js";
import { createSnapshotContext } from "../testing/run.js";
import {
	describeTransform,
	runStandardTests,
	snapshotTransform,
	toMatchShape,
} from "../testing/index.js";
import { executeStandardTestHandler } from "../testing/run.js";

const testProvider = defineProvider({
	id: "test-provider",
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Test Provider",
		descriptionKey: "test-provider.description",
		category: "test",
	},
})({ operations: {
		search: {
			riskClass: "read",
			input: z.object({ q: z.string() }),
			output: z.object({ result: z.string() }),
			handler: async (_ctx, input: unknown) => {
				const { q } = z.object({ q: z.string() }).parse(input);

				return { result: `found: ${q}` };
			},
			fixtures: {
				request: { q: "hello" },
				response: { result: "found: hello" },
			},
			healthCheckUnsupported: { reason: "test fixture" },
		},
	} });

const snapshotFixtureDir = `/tmp/apifuse-standard-tests-${Date.now()}/__fixtures__`;
mkdirSync(snapshotFixtureDir, { recursive: true });
const streamSnapshotFixtureDir = join(import.meta.dir, "fixtures", "stream-snapshot");
const multiStreamSnapshotFixtureDir = join(import.meta.dir, "fixtures", "multi-stream-snapshot");

async function runGeneratedStandardTest(source: string): Promise<{
	exitCode: number;
	output: string;
}> {
	const testPath = join(snapshotFixtureDir, `generated-${randomUUID()}.test.ts`);
	writeFileSync(testPath, source);
	const process = Bun.spawn({
		cmd: ["bun", "test", testPath],
		cwd: join(import.meta.dir, "..", ".."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	return { exitCode, output: `${stdout}\n${stderr}` };
}

const streamPreview = "recorded stream preview";
const streamPreviewSha256 = createHash("sha256").update(streamPreview).digest("hex");
const streamEvidenceFixture = {
	__apifuse_stream__: true as const,
	status: 200,
	ok: true,
	headers: { "content-type": "application/octet-stream" },
	body_sha256: streamPreviewSha256,
	body_bytes: Buffer.byteLength(streamPreview),
	body_preview_base64: Buffer.from(streamPreview).toString("base64"),
	request: { ordinal: 1, method: "GET", path: "/download" },
};
const secondStreamPreview = "second recorded stream preview";
const secondStreamPreviewSha256 = createHash("sha256").update(secondStreamPreview).digest("hex");
const firstStreamEvidenceFixture = {
	...streamEvidenceFixture,
	request: { ordinal: 1, method: "GET", path: "/first" },
};
const secondStreamEvidenceFixture = {
	...streamEvidenceFixture,
	body_sha256: secondStreamPreviewSha256,
	body_bytes: Buffer.byteLength(secondStreamPreview),
	body_preview_base64: Buffer.from(secondStreamPreview).toString("base64"),
	request: { ordinal: 2, method: "GET", path: "/second" },
};

const fixtureHarnessProvider = defineProvider({
	id: "fixture-harness-provider",
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Fixture Harness Provider",
		descriptionKey: "fixture-harness-provider.description",
		category: "test",
	},
})({ operations: {
		lookup: {
			riskClass: "read",
			input: z.object({ q: z.string() }),
			output: z.object({ result: z.string() }),
			handler: async (_ctx, input: unknown) => {
				const { q } = z.object({ q: z.string() }).parse(input);
				return { result: q };
			},
			fixtures: {
				request: { q: "fixture" },
				response: { result: "fixture" },
			},
			healthCheckUnsupported: { reason: "test fixture" },
		},
	} });

const snapshotHarnessProvider = defineProvider({
	id: "snapshot-harness-provider",
	version: "1.0.0",
	runtime: "standard",
	http: true,
	meta: {
		displayName: "Snapshot Harness Provider",
		descriptionKey: "snapshot-harness-provider.description",
		category: "test",
	},
})({ operations: {
		normalize: {
			riskClass: "read",
			input: z.object({ id: z.string() }),
			output: z.object({ id: z.string(), label: z.string() }),
			handler: async (ctx, input: unknown) => {
				const { id } = z.object({ id: z.string() }).parse(input);
				const raw = await ctx.http.get("https://example.test/raw");
				const body = await raw.json<{ label: string }>();

				return { id, label: body.label };
			},
			fixtures: {
				request: { id: "snap" },
				response: { id: "snap", label: "golden" },
			},
			healthCheckUnsupported: { reason: "test fixture" },
		},
	} });

const streamSnapshotHarnessProvider = defineProvider({
	id: "stream-snapshot-harness-provider",
	version: "1.0.0",
	runtime: "standard",
	http: true,
	meta: {
		displayName: "Stream Snapshot Harness Provider",
		descriptionKey: "stream-snapshot-harness-provider.description",
		category: "test",
	},
})({ operations: {
		download: {
			riskClass: "read",
			input: z.object({}),
			output: z.object({
				body: z.string(),
				bodyBytes: z.number(),
				bodySha256: z.string(),
				evidenceOnly: z.boolean(),
				cleanup: z.string(),
			}),
			handler: async (ctx) => {
				const response = await ctx.http.stream("https://example.test/download");
				if (!isStreamEvidenceReplayResponse(response)) {
					throw new Error("stream evidence replay metadata is missing");
				}
				const chunks: Uint8Array[] = [];
				for await (const chunk of response.bytes()) chunks.push(chunk);
				const body = Buffer.concat(chunks).toString("utf8");
				if (
					body !== streamPreview ||
					response.body_sha256 !== streamEvidenceFixture.body_sha256 ||
					response.body_bytes !== streamEvidenceFixture.body_bytes
				) {
					throw new Error("stream evidence replay did not preserve preview and metadata");
				}
				const cleanupResponse = await ctx.http.get("https://example.test/cleanup");
				const cleanup = await cleanupResponse.json<{ cleanup: string }>();

				return {
					body,
					bodyBytes: response.body_bytes,
					bodySha256: response.body_sha256,
					evidenceOnly: response.evidence_only,
					cleanup: cleanup.cleanup,
				};
			},
			fixtures: {
				request: {},
				response: {
					body: streamPreview,
					bodyBytes: Buffer.byteLength(streamPreview),
					bodySha256: streamPreviewSha256,
					evidenceOnly: true,
					cleanup: "complete",
				},
			},
			healthCheckUnsupported: { reason: "test fixture" },
		},
	} });

const multiStreamSnapshotHarnessProvider = defineProvider({
	id: "multi-stream-snapshot-harness-provider",
	version: "1.0.0",
	runtime: "standard",
	http: true,
	meta: {
		displayName: "Multi Stream Snapshot Harness Provider",
		descriptionKey: "multi-stream-snapshot-harness-provider.description",
		category: "test",
	},
})({ operations: {
		download: {
			riskClass: "read",
			input: z.object({}),
			output: z.object({ first: z.string(), second: z.string() }),
			handler: async (ctx) => {
				const read = async (path: string) => {
					const response = await ctx.http.stream(`https://example.test${path}`);
					const chunks: Uint8Array[] = [];
					for await (const chunk of response.bytes()) chunks.push(chunk);
					return Buffer.concat(chunks).toString("utf8");
				};
				return { first: await read("/first"), second: await read("/second") };
			},
			fixtures: {
				request: {},
				response: { first: streamPreview, second: secondStreamPreview },
			},
			healthCheckUnsupported: { reason: "test fixture" },
		},
	} });

const authHarnessProvider = defineProvider({
	id: "auth-harness-provider",
	version: "1.0.0",
	runtime: "standard",
	auth: {
		mode: "credentials",
		flow: {
			start: async (_ctx) => ({ kind: "complete", turnId: "turn_done" }),
			continue: async () => ({ kind: "complete", turnId: "turn_done" }),
		},
	},
	credential: { keys: ["apiKey"] },
	meta: {
		displayName: "Auth Harness Provider",
		descriptionKey: "auth-harness-provider.description",
		category: "test",
	},
})({ operations: {
		me: {
			riskClass: "read",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			handler: async () => ({ ok: true }),
			fixtures: { request: {}, response: { ok: true } },
			healthCheckUnsupported: { reason: "test fixture" },
		},
	} });

const handlerE2eProvider = defineProvider({
	id: "handler-e2e-provider",
	version: "1.0.0",
	runtime: "standard",
	http: true,
	meta: {
		displayName: "Handler E2E Provider",
		descriptionKey: "handler-e2e-provider.description",
		category: "test",
	},
})({ operations: {
		lookup: {
			riskClass: "read",
			input: z.object({
				id: z.string(),
				date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
			}),
			output: z.object({ result: z.string() }),
			handler: async (ctx, input: unknown) => {
				const inputSchema = z.object({
					id: z.string(),
					date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
				});
				const { id, date } = inputSchema.parse(input);
				const response = await ctx.http.get(`https://example.test/items/${id}?date=${date}`);
				const body = await response.json<{ label: string }>();
				return { result: body.label };
			},
			fixtures: {
				request: { id: "fixture-id", date: "+45d" },
				response: { result: "Recorded label" },
			},
			healthCheckUnsupported: { reason: "test fixture" },
		},
	} });

const { operations: _handlerOperations, ...handlerE2eDeclaration } = handlerE2eProvider;
const brokenHandlerProvider = defineProvider({
	...handlerE2eDeclaration,
	id: "broken-handler-provider",
	http: true,
})({ operations: {
		lookup: {
			...handlerE2eProvider.operations.lookup,
			handler: async (ctx, input: unknown) => {
				const inputSchema = z.object({
					id: z.string(),
					date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
				});
				const { id, date } = inputSchema.parse(input);
				const response = await ctx.http.get(`https://example.test/items/${id}?date=${date}`);
				const body = await response.json<{ label: string }>();
				return { wrong: body.label };
			},
		},
	} });

const nativeEgressHarnessProvider = defineProvider({
	id: "native-egress-harness",
	version: "1.0.0",
	runtime: "standard",
	meta: {
		displayName: "Native Egress Harness",
		descriptionKey: "meta.description",
		category: "test",
	},
	native: {
		network: {
			tcp: [{ host: "allowed.example", ports: [443], tls: "disabled" }],
			dynamicTcp: [
				{
					sourceHost: "bootstrap.example",
					sourcePorts: [443],
					targetHostSuffixes: ["session.example"],
					targetPorts: [5228],
					tls: "disabled",
					ttlMs: 30_000,
					maxGrants: 1,
				},
			],
		},
	},
})({ operations: {
		"snapshot-connect": {
			riskClass: "read",
			input: z.object({}),
			output: z.object({ reads: z.number() }),
			fixtures: { request: {}, response: { reads: 1 } },
			healthCheckUnsupported: { reason: "native transport harness" },
			handler: async (ctx) => {
				const network = ctx.native.network;
				let reads = 0;
				const target = {
					get host() {
						reads += 1;
						return reads === 1 ? "allowed.example" : "evil.example";
					},
					port: 443,
				};
				await (await network.connectTcp(target)).close();
				return { reads };
			},
		},
		denied: {
			riskClass: "read",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			fixtures: { request: {}, response: { ok: true } },
			healthCheckUnsupported: { reason: "native transport harness" },
			handler: async (ctx) => {
				await ctx.native.network.connectTcp({ host: "undeclared.example", port: 5228 });
				return { ok: true };
			},
		},
		"grant-lifecycle": {
			riskClass: "read",
			input: z.object({}),
			output: z.object({ revokedCode: z.string() }),
			fixtures: {
				request: {},
				response: { revokedCode: "native_egress_not_declared" },
			},
			healthCheckUnsupported: { reason: "native transport harness" },
			handler: async (ctx) => {
				const network = ctx.native.network;
				const target = { host: "session.example", port: 5228 };
				const grant = network.grantTcpEgress({
					sourceHost: "bootstrap.example",
					sourcePort: 443,
					...target,
					tls: "disabled",
				});
				await (await network.connectTcp(target)).close();
				grant.revoke();
				try {
					await network.connectTcp(target);
				} catch (error) {
					return { revokedCode: String((error as { code?: unknown }).code) };
				}
				return { revokedCode: "missing_denial" };
			},
		},
	} });

const handlerE2eStub = ({ url }: { url?: string }) =>
	/^https:\/\/example\.test\/items\/fixture-id\?date=\d{4}-\d{2}-\d{2}$/.test(url ?? "")
		? { body: { label: "Live normalized label" } }
		: undefined;

const standardTestsResult = runStandardTests(testProvider);

runStandardTests(
	fixtureHarnessProvider,
	{ request: { q: "fixture" }, response: { result: "fixture" } },
	{ auth: "none", signature: "unit-signature" },
	{ validateFixture: true, verifyManifest: true },
);

runStandardTests(snapshotHarnessProvider, { label: "golden" }, undefined, {
	snapshot: true,
	fixtureDir: snapshotFixtureDir,
});

runStandardTests(
	streamSnapshotHarnessProvider,
	{
		__apifuse_capture__: true,
		items: [
			{ kind: "stream", evidence: streamEvidenceFixture },
			{ kind: "response", value: { cleanup: "complete" } },
		],
	},
	undefined,
	{
		snapshot: true,
		fixtureDir: streamSnapshotFixtureDir,
		requireSnapshot: true,
	},
);

runStandardTests(
	multiStreamSnapshotHarnessProvider,
	{
		__apifuse_capture__: true,
		items: [
			{ kind: "stream", evidence: firstStreamEvidenceFixture },
			{ kind: "stream", evidence: secondStreamEvidenceFixture },
		],
	},
	undefined,
	{ snapshot: true, fixtureDir: multiStreamSnapshotFixtureDir, requireSnapshot: true },
);

runStandardTests(
	authHarnessProvider,
	{ ok: true },
	{ auth: "credentials" },
	{ validateAuthMode: true },
);

runStandardTests(handlerE2eProvider, { upstreamStub: handlerE2eStub });

describeTransform("double-value", { value: 2 }, { doubled: 4 }, (raw) => ({
	doubled: raw.value * 2,
}));

describe("toMatchShape", () => {
	it("passes when all shape keys match", () => {
		expect(() => {
			toMatchShape({ name: "Alice", age: 30, extra: "ignored" }, { name: "Alice", age: 30 });
		}).not.toThrow();
	});

	it("supports nested type descriptors", () => {
		expect(() => {
			toMatchShape(
				{
					name: "Alice",
					age: 30,
					tags: ["pro"],
					metadata: { source: "fixture" },
				},
				{
					name: "string",
					age: "number",
					tags: "array",
					metadata: { source: "string" },
				},
			);
		}).not.toThrow();
	});

	it("fails when shape key does not match", () => {
		expect(() => {
			toMatchShape({ name: "Bob" }, { name: "Alice" });
		}).toThrow();
	});

	it("fails when type descriptor does not match", () => {
		expect(() => {
			toMatchShape({ name: 123 }, { name: "string" });
		}).toThrow();
	});
});

describe("runStandardTests handler E2E", () => {
	it("returns a valid real-handler result using the canned upstream", async () => {
		await expect(
			executeStandardTestHandler(handlerE2eProvider, "lookup", handlerE2eStub),
		).resolves.toEqual({ result: "Live normalized label" });
	});

	it("fails with a JSON diff when handler wiring returns the wrong shape", async () => {
		await expect(
			executeStandardTestHandler(brokenHandlerProvider, "lookup", handlerE2eStub),
		).rejects.toThrow(/Handler output.*failed schema validation[\s\S]*JSON diff/);
	});

	it("rejects unmatched upstream calls instead of passing through to live network", async () => {
		await expect(
			executeStandardTestHandler(handlerE2eProvider, "lookup", () => undefined),
		).rejects.toThrow(/Unmatched upstream call.*live network passthrough is disabled/);
	});

	it("surfaces per-operation warnings when upstreamStub is omitted", () => {
		expect(standardTestsResult.warnings).toEqual([
			'[provider-sdk] Operation "test-provider.search" has no handler E2E coverage in runStandardTests; configure upstreamStub to invoke the real handler.',
		]);
	});

	it("enforces native declarations in the offline transport double", async () => {
		let calls = 0;
		const urls: string[] = [];
		const stub = ({ url }: { url?: string }) => {
			calls += 1;
			if (url) urls.push(url);
			return { body: "" };
		};
		await expect(
			executeStandardTestHandler(nativeEgressHarnessProvider, "snapshot-connect", stub),
		).resolves.toEqual({ reads: 1 });
		expect(urls).toEqual(["tcp://allowed.example:443"]);
		await expect(
			executeStandardTestHandler(nativeEgressHarnessProvider, "denied", stub),
		).rejects.toMatchObject({ code: "native_egress_not_declared" });
		expect(calls).toBe(1);
		await expect(
			executeStandardTestHandler(nativeEgressHarnessProvider, "grant-lifecycle", stub),
		).resolves.toEqual({ revokedCode: "native_egress_not_declared" });
		expect(calls).toBe(2);
	});
});

describe("testing exports", () => {
	it("fails closed when requireSnapshot points to a missing snapshot", async () => {
		const fixtureDir = join(snapshotFixtureDir, "missing-required-snapshot");
		const testingModule = pathToFileURL(join(import.meta.dir, "..", "testing", "run.ts")).href;
		const result = await runGeneratedStandardTest(`
import { runStandardTests } from ${JSON.stringify(testingModule)};
const provider = {
  id: "missing-snapshot-harness", version: "1.0.0", runtime: "standard",
  meta: { displayName: "Missing Snapshot Harness", category: "test" },
  operations: { check: { input: {}, output: {}, handler: async () => ({ ok: true }) } },
};
runStandardTests(provider, {}, undefined, {
  snapshot: true,
  fixtureDir: ${JSON.stringify(fixtureDir)},
  requireSnapshot: true,
});
`);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("Required golden snapshot is missing");
	});

	it("rejects a replay envelope with a trailing unconsumed capture", async () => {
		const testingModule = pathToFileURL(join(import.meta.dir, "..", "testing", "run.ts")).href;
		const preview = "recorded stream preview";
		const digest = createHash("sha256").update(preview).digest("hex");
		const result = await runGeneratedStandardTest(`
import { runStandardTests } from ${JSON.stringify(testingModule)};
const provider = {
  id: "unconsumed-capture-harness", version: "1.0.0", runtime: "standard",
  meta: { displayName: "Unconsumed Capture Harness", category: "test" },
  operations: { check: {
    input: {}, output: {},
    handler: async (ctx) => { await ctx.http.stream("https://example.test/download"); return { ok: true }; },
  } },
};
runStandardTests(provider, {
  __apifuse_capture__: true,
  items: [
    { kind: "stream", evidence: {
      __apifuse_stream__: true, status: 200, ok: true, headers: {},
      body_sha256: ${JSON.stringify(digest)},
      body_bytes: ${Buffer.byteLength(preview)},
      body_preview_base64: ${JSON.stringify(Buffer.from(preview).toString("base64"))},
      request: { ordinal: 1, method: "GET", path: "/download" },
    } },
    { kind: "response", value: { trailing: true } },
  ],
}, undefined, { snapshot: true, fixtureDir: ${JSON.stringify(join(snapshotFixtureDir, "unconsumed"))} });
`);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("1 unconsumed capture item after handler completion");
	});

	it("diagnoses a method-only stream replay provenance mismatch", async () => {
		const context = createSnapshotContext(streamEvidenceFixture);
		await expect(
			context.http.stream("https://example.test/download", { method: "POST" }),
		).rejects.toThrow(/expected GET \/download.*received POST \/download/);
	});

	it("diagnoses a path-only stream replay provenance mismatch", async () => {
		const context = createSnapshotContext(streamEvidenceFixture);
		await expect(context.http.stream("https://example.test/not-download")).rejects.toThrow(
			/expected GET \/download.*received GET \/not-download/,
		);
	});

	it("resolves a query-only replay request against the recorded resource path", async () => {
		const context = createSnapshotContext({
			...streamEvidenceFixture,
			request: { ordinal: 1, method: "GET", path: "/resource" },
		});
		await expect(context.http.stream("?format=raw")).resolves.toBeDefined();
	});

	it("fails fast when a mixed replay exhausts its ordinary responses", async () => {
		const context = createSnapshotContext({
			__apifuse_capture__: true,
			items: [
				{ kind: "response", value: { cleanup: "complete" } },
				{ kind: "stream", evidence: streamEvidenceFixture },
			],
		});
		expect((await context.http.get("https://example.test/cleanup")).data).toEqual({
			cleanup: "complete",
		});
		await expect(context.http.get("https://example.test/extra")).rejects.toThrow(
			/call-order mismatch.*expected a stream call.*ordinary HTTP call/,
		);
	});

	it("does not re-export Bun-only testing helpers from package root", () => {
		expect("runStandardTests" in sdk).toBe(false);
		expect("describeTransform" in sdk).toBe(false);
		expect("toMatchShape" in sdk).toBe(false);
		expect("snapshotTransform" in sdk).toBe(false);
		expect("isStreamEvidenceReplayResponse" in sdk).toBe(false);
	});

	it("exposes snapshotTransform from testing entrypoint", () => {
		expect(typeof snapshotTransform).toBe("function");
	});
});
