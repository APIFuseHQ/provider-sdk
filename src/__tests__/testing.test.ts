import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { z } from "zod";

import { defineProvider } from "../define";
import * as sdk from "../index";
import {
	describeTransform,
	runStandardTests,
	snapshotTransform,
	toMatchShape,
} from "../testing";

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

runStandardTests(testProvider);

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
	authHarnessProvider,
	{ ok: true },
	{ auth: "credentials" },
	{ validateAuthMode: true },
);

describeTransform("double-value", { value: 2 }, { doubled: 4 }, (raw) => ({
	doubled: raw.value * 2,
}));

describe("toMatchShape", () => {
	it("passes when all shape keys match", () => {
		expect(() => {
			toMatchShape(
				{ name: "Alice", age: 30, extra: "ignored" },
				{ name: "Alice", age: 30 },
			);
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
