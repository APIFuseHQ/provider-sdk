import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { z } from "zod";

import { defineProvider } from "../define.js";
import * as sdk from "../index.js";
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
		category: "test",
	},
	operations: {
		search: {
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
	},
});

const snapshotFixtureDir = `/tmp/apifuse-standard-tests-${Date.now()}/__fixtures__`;
mkdirSync(snapshotFixtureDir, { recursive: true });
const streamSnapshotFixtureDir = `/tmp/apifuse-stream-standard-tests-${Date.now()}/__fixtures__`;
mkdirSync(streamSnapshotFixtureDir, { recursive: true });

const streamEvidenceFixture = {
	__apifuse_stream__: true as const,
	status: 200,
	ok: true,
	headers: { "content-type": "application/octet-stream" },
	body_sha256: "a".repeat(64),
	body_bytes: 805_000,
	body_preview_base64: Buffer.from("recorded stream preview").toString("base64"),
};

const fixtureHarnessProvider = defineProvider({
	id: "fixture-harness-provider",
	version: "1.0.0",
	runtime: "standard",
	meta: { displayName: "Fixture Harness Provider", category: "test" },
	operations: {
		lookup: {
			input: z.object({ q: z.string() }),
			output: z.object({ result: z.string() }),
			handler: async (_ctx, input) => ({ result: input.q }),
			fixtures: {
				request: { q: "fixture" },
				response: { result: "fixture" },
			},
			healthCheckUnsupported: { reason: "test fixture" },
		},
	},
});

const snapshotHarnessProvider = defineProvider({
	id: "snapshot-harness-provider",
	version: "1.0.0",
	runtime: "standard",
	meta: { displayName: "Snapshot Harness Provider", category: "test" },
	operations: {
		normalize: {
			input: z.object({ id: z.string() }),
			output: z.object({ id: z.string(), label: z.string() }),
			handler: async (ctx, input) => {
				const raw = await ctx.http.get("https://example.test/raw");
				const body = await raw.json<{ label: string }>();

				return { id: input.id, label: body.label };
			},
			fixtures: {
				request: { id: "snap" },
				response: { id: "snap", label: "golden" },
			},
			healthCheckUnsupported: { reason: "test fixture" },
		},
	},
});

const streamSnapshotHarnessProvider = defineProvider({
	id: "stream-snapshot-harness-provider",
	version: "1.0.0",
	runtime: "standard",
	meta: { displayName: "Stream Snapshot Harness Provider", category: "test" },
	operations: {
		download: {
			input: z.object({}),
			output: z.object({
				body: z.string(),
				bodyBytes: z.number(),
				bodySha256: z.string(),
				evidenceOnly: z.boolean(),
			}),
			handler: async (ctx) => {
				const response = await ctx.http.stream("https://example.test/download");
				const replay = response as typeof response & {
					evidence_only: true;
					body_sha256: string;
					body_bytes: number;
				};
				const chunks: Uint8Array[] = [];
				for await (const chunk of response.bytes()) chunks.push(chunk);
				const body = Buffer.concat(chunks).toString("utf8");
				if (
					body !== "recorded stream preview" ||
					replay.evidence_only !== true ||
					replay.body_sha256 !== streamEvidenceFixture.body_sha256 ||
					replay.body_bytes !== streamEvidenceFixture.body_bytes
				) {
					throw new Error("stream evidence replay did not preserve preview and metadata");
				}

				return {
					body,
					bodyBytes: replay.body_bytes,
					bodySha256: replay.body_sha256,
					evidenceOnly: replay.evidence_only,
				};
			},
			fixtures: {
				request: {},
				response: {
					body: "recorded stream preview",
					bodyBytes: 805_000,
					bodySha256: "a".repeat(64),
					evidenceOnly: true,
				},
			},
			healthCheckUnsupported: { reason: "test fixture" },
		},
	},
});

const authHarnessProvider = defineProvider({
	id: "auth-harness-provider",
	version: "1.0.0",
	runtime: "standard",
	auth: {
		mode: "credentials",
		flow: {
			start: async () => ({ kind: "complete", turnId: "turn_done" }),
			continue: async () => ({ kind: "complete", turnId: "turn_done" }),
		},
	},
	credential: { keys: ["apiKey"] },
	meta: { displayName: "Auth Harness Provider", category: "test" },
	operations: {
		me: {
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			handler: async () => ({ ok: true }),
			fixtures: { request: {}, response: { ok: true } },
			healthCheckUnsupported: { reason: "test fixture" },
		},
	},
});

const handlerE2eProvider = defineProvider({
	id: "handler-e2e-provider",
	version: "1.0.0",
	runtime: "standard",
	meta: { displayName: "Handler E2E Provider", category: "test" },
	operations: {
		lookup: {
			input: z.object({
				id: z.string(),
				date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
			}),
			output: z.object({ result: z.string() }),
			handler: async (ctx, input) => {
				const response = await ctx.http.get(
					`https://example.test/items/${input.id}?date=${input.date}`,
				);
				const body = await response.json<{ label: string }>();
				return { result: body.label };
			},
			fixtures: {
				request: { id: "fixture-id", date: "+45d" },
				response: { result: "Recorded label" },
			},
			healthCheckUnsupported: { reason: "test fixture" },
		},
	},
});

const brokenHandlerProvider = defineProvider({
	...handlerE2eProvider,
	id: "broken-handler-provider",
	operations: {
		lookup: {
			...handlerE2eProvider.operations.lookup,
			handler: async (ctx, input) => {
				const response = await ctx.http.get(
					`https://example.test/items/${input.id}?date=${input.date}`,
				);
				const body = await response.json<{ label: string }>();
				return { wrong: body.label } as unknown as { result: string };
			},
		},
	},
});

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

runStandardTests(streamSnapshotHarnessProvider, streamEvidenceFixture, undefined, {
	snapshot: true,
	fixtureDir: streamSnapshotFixtureDir,
});

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
});

describe("testing exports", () => {
	it("does not re-export Bun-only testing helpers from package root", () => {
		expect("runStandardTests" in sdk).toBe(false);
		expect("describeTransform" in sdk).toBe(false);
		expect("toMatchShape" in sdk).toBe(false);
		expect("snapshotTransform" in sdk).toBe(false);
	});

	it("exposes snapshotTransform from testing entrypoint", () => {
		expect(typeof snapshotTransform).toBe("function");
	});
});
