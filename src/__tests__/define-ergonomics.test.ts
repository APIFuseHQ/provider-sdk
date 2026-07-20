import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { defineOperation, defineProvider, defineStreamOperation } from "../define.js";
import { ProviderError } from "../errors.js";
import { event } from "../stream.js";
import type { StandardSchemaV1 } from "../types.js";

const callDefineProvider = (config: unknown): unknown =>
	Reflect.apply(defineProvider, undefined, [config]);

const makeProviderConfig = () => ({
	id: "ergonomic-provider",
	version: "1.0.0",
	runtime: "standard" as const,
	meta: { displayName: "Ergonomic Provider", category: "test" },
	operations: {
		lookup: {
			input: z.object({ id: z.string() }),
			output: z.object({ result: z.string() }),
			async handler(_ctx, input) {
				const id: string = input.id;
				return { result: id.toUpperCase() };
			},
			fixtures: {
				request: { id: "coin" },
				response: { result: "COIN" },
			},
			healthCheckUnsupported: { reason: "test fixture" },
		},
	},
});

describe("defineProvider ergonomics", () => {
	it("narrows handler input from the operation input schema", async () => {
		const provider = defineProvider(makeProviderConfig());

		await expect(
			Reflect.apply(provider.operations.lookup.handler, undefined, [undefined, { id: "coin" }]),
		).resolves.toEqual({ result: "COIN" });
	});

	it("defineOperation composes factored operations with inferred input", async () => {
		const search = defineOperation({
			input: z.object({ q: z.string() }),
			output: z.object({ count: z.number() }),
			async handler(_ctx, input) {
				const q: string = input.q;
				return { count: q.length };
			},
		});

		const provider = defineProvider({
			...makeProviderConfig(),
			operations: {
				search: {
					...search,
					healthCheckUnsupported: { reason: "test fixture" },
				},
			},
		});

		await expect(
			Reflect.apply(provider.operations.search.handler, undefined, [undefined, { q: "abc" }]),
		).resolves.toEqual({ count: 3 });
	});

	it("defineProvider accepts generated readonly metadata and factored operation maps", async () => {
		const search = defineOperation({
			input: z.object({ q: z.string() }),
			output: z.object({ count: z.number() }),
			async handler(_ctx, input) {
				return { count: input.q.length };
			},
			upstream: { baseUrl: "https://example.com" },
			healthCheckUnsupported: { reason: "test fixture" },
		});
		const operations = { search } as const;
		const providerMeta = {
			displayName: "Generated Provider",
			descriptionKey: "meta.description",
			category: "test",
			tags: ["generated", "starter"] as const,
		} as const;

		const provider = defineProvider({
			...makeProviderConfig(),
			meta: providerMeta,
			operations,
		});

		await expect(
			Reflect.apply(provider.operations.search.handler, undefined, [undefined, { q: "abcd" }]),
		).resolves.toEqual({ count: 4 });
		expect(provider.operations.search.upstream?.baseUrl).toBe("https://example.com");
	});

	it("defineStreamOperation composes operations with explicit non-JSON transport", () => {
		const events = defineStreamOperation({
			input: z.object({ topic: z.string() }),
			output: z.object({ accepted: z.boolean() }),
			transport: {
				kind: "sse",
				events: {
					delta: z.object({ value: z.number() }),
				},
			},
			async *handler(_ctx, input) {
				const topic: string = input.topic;
				yield event("delta", { value: topic.length });
			},
		});

		const provider = defineProvider({
			...makeProviderConfig(),
			operations: {
				events: {
					...events,
					healthCheckUnsupported: { reason: "test fixture" },
				},
			},
		});

		expect(provider.operations.events.transport?.kind).toBe("sse");
	});

	it("accepts Standard Schema operations and validates fixtures", () => {
		const InputSchema = {
			"~standard": {
				version: 1,
				vendor: "test",
				validate(value) {
					if (
						typeof value === "object" &&
						value !== null &&
						"slug" in value &&
						typeof value.slug === "string"
					) {
						return { value: { slug: value.slug } };
					}
					return { issues: [{ message: "slug must be a string" }] };
				},
			},
		} satisfies StandardSchemaV1<unknown, { slug: string }>;

		const OutputSchema = {
			"~standard": {
				version: 1,
				vendor: "test",
				validate(value) {
					if (
						typeof value === "object" &&
						value !== null &&
						"ok" in value &&
						typeof value.ok === "boolean"
					) {
						return { value: { ok: value.ok } };
					}
					return { issues: [{ message: "ok must be a boolean" }] };
				},
			},
		} satisfies StandardSchemaV1<unknown, { ok: boolean }>;

		const provider = defineProvider({
			...makeProviderConfig(),
			operations: {
				standard: {
					input: InputSchema,
					output: OutputSchema,
					async handler(_ctx, input) {
						const slug: string = input.slug;
						return { ok: slug.length > 0 };
					},
					fixtures: { request: { slug: "abc" }, response: { ok: true } },
					healthCheckUnsupported: { reason: "test fixture" },
				},
			},
		});

		expect(provider.operations.standard.fixtures?.request).toEqual({
			slug: "abc",
		});
	});

	it("names missing required fields in defineProvider errors", () => {
		expect(() => callDefineProvider({ ...makeProviderConfig(), version: undefined })).toThrow(
			/missing required field "version"/,
		);
	});

	it("names invalid auth.mode in defineProvider errors", () => {
		expect(() =>
			callDefineProvider({
				...makeProviderConfig(),
				auth: { mode: "api-key" },
			}),
		).toThrow(/invalid auth\.mode/);
	});

	it("rejects operation ids that conflict with server paths", () => {
		expect(() =>
			defineProvider({
				...makeProviderConfig(),
				operations: { "auth/start": makeProviderConfig().operations.lookup },
			}),
		).toThrow(ProviderError);
	});
});
