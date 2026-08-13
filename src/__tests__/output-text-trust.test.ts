import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { canonicalJson } from "../contract-json.js";
import { describeSchema } from "../contract-serialization.js";
import {
	APIFUSE_TEXT_TRUST_META_KEY,
	AUTO_TRUSTED_ZOD_STRING_FORMATS,
	collectOutputTextTrust,
	findUnclassifiedOutputTextPaths,
	textTrust,
} from "../schema.js";

function projectedTextTrustValues(value: unknown): unknown[] {
	if (Array.isArray(value)) return value.flatMap(projectedTextTrustValues);
	if (!value || typeof value !== "object") return [];
	return Object.entries(value).flatMap(([key, child]) =>
		key === APIFUSE_TEXT_TRUST_META_KEY ? [child] : projectedTextTrustValues(child),
	);
}

describe("output text-trust metadata", () => {
	it("attaches versioned metadata with method and function authoring APIs", () => {
		const methodSchema = z.string().textTrust("untrusted");
		const functionSchema = textTrust(z.string(), "untrusted");

		expect(methodSchema.meta()?.[APIFUSE_TEXT_TRUST_META_KEY]).toEqual({
			v: 1,
			trust: "untrusted",
		});
		expect(functionSchema.meta()?.[APIFUSE_TEXT_TRUST_META_KEY]).toEqual(
			methodSchema.meta()?.[APIFUSE_TEXT_TRUST_META_KEY],
		);
	});

	it("traverses objects, arrays, unions, wrappers, records, and tuples", () => {
		const schema = z.object({
			optional: z.object({ prose: z.string().textTrust("untrusted") }).optional(),
			array: z.array(z.string().textTrust("untrusted")),
			union: z.union([z.literal("ready"), z.string().textTrust("untrusted")]).nullable(),
			record: z.record(z.string().regex(/^[a-z_]{1,32}$/), z.string().textTrust("untrusted")),
			tuple: z.tuple(
				[z.iso.datetime(), z.string().textTrust("untrusted")],
				z.string().textTrust("untrusted"),
			),
			defaulted: z.string().textTrust("untrusted").default("fallback"),
		});

		const classifications = collectOutputTextTrust(schema);
		expect(classifications).toEqual({
			'$["array"][*]': "untrusted",
			'$["defaulted"]': "untrusted",
			'$["optional"]["prose"]': "untrusted",
			'$["record"]<record-key>': "trusted",
			'$["record"][*]': "untrusted",
			'$["tuple"][*]': "untrusted",
			'$["tuple"][0]': "trusted",
			'$["tuple"][1]': "untrusted",
			'$["union"]<union:0>': "trusted",
			'$["union"]<union:1>': "untrusted",
		});
		expect(findUnclassifiedOutputTextPaths(schema)).toEqual([]);
		expect(
			projectedTextTrustValues(describeSchema(schema, { outputTextTrust: true }))
				.map((value) => (value as { trust: string }).trust)
				.sort(),
		).toEqual(Object.values(classifications).sort());
	});

	it("keeps reusable shared sub-schema paths distinct", () => {
		const shared = z.object({ id: z.uuid(), label: z.string().textTrust("untrusted") });
		const schema = z.object({ left: shared, right: shared });

		expect(collectOutputTextTrust(schema)).toEqual({
			'$["left"]["id"]': "trusted",
			'$["left"]["label"]': "untrusted",
			'$["right"]["id"]': "trusted",
			'$["right"]["label"]': "untrusted",
		});
	});

	it("bounds recursive traversal with an explicit repeated-segment marker", () => {
		type Node = { name: string; next?: Node };
		let nodeSchema: z.ZodType<Node>;
		nodeSchema = z.object({
			name: z.string().textTrust("untrusted"),
			next: z.lazy(() => nodeSchema).optional(),
		});

		expect(collectOutputTextTrust(nodeSchema)).toEqual({
			'$["name"]': "untrusted",
			'$["next"]<recursive>["name"]': "untrusted",
		});
		expect(findUnclassifiedOutputTextPaths(nodeSchema)).toEqual([]);
		const projection = JSON.stringify(describeSchema(nodeSchema, { outputTextTrust: true }));
		expect(projection).toContain('"x-apifuse-text-trust":{"v":1,"trust":"untrusted"}');
	});

	it("handles discriminated unions and object catchalls", () => {
		const schema = z
			.object({
				result: z.discriminatedUnion("kind", [
					z.object({ kind: z.literal("ok"), value: z.string().textTrust("untrusted") }),
					z.object({ kind: z.literal("error"), reason: z.string().textTrust("untrusted") }),
				]),
			})
			.catchall(z.string().textTrust("untrusted"));

		expect(collectOutputTextTrust(schema)).toEqual({
			'$["result"]<union:0>["kind"]': "trusted",
			'$["result"]<union:0>["value"]': "untrusted",
			'$["result"]<union:1>["kind"]': "trusted",
			'$["result"]<union:1>["reason"]': "untrusted",
			"$[*]": "untrusted",
		});
	});

	it("auto-derives finite literals, enums, and restrictive grammars", () => {
		const schema = z.object({
			literal: z.literal("fixed"),
			enum: z.enum(["queued", "done"]),
			forcedUntrusted: z.literal("opaque").textTrust("untrusted"),
			pattern: z.string().regex(/^[A-Z0-9_-]{1,32}$/),
			brandedId: z
				.string()
				.regex(/^id_[a-f0-9]{16}$/)
				.brand("OpaqueId"),
			timestamp: z.iso.datetime(),
			uuid: z.uuid(),
		});

		expect(collectOutputTextTrust(schema)).toEqual({
			'$["brandedId"]': "trusted",
			'$["enum"]': "trusted",
			'$["forcedUntrusted"]': "untrusted",
			'$["literal"]': "trusted",
			'$["pattern"]': "trusted",
			'$["timestamp"]': "trusted",
			'$["uuid"]': "trusted",
		});
		expect(findUnclassifiedOutputTextPaths(schema)).toEqual([]);
	});

	it("auto-derives the documented restrictive format allowlist", () => {
		const formats = {
			cidrv4: z.cidrv4(),
			cidrv6: z.cidrv6(),
			cuid: z.cuid(),
			cuid2: z.cuid2(),
			date: z.iso.date(),
			datetime: z.iso.datetime(),
			duration: z.iso.duration(),
			e164: z.e164(),
			guid: z.guid(),
			ipv4: z.ipv4(),
			ipv6: z.ipv6(),
			ksuid: z.ksuid(),
			nanoid: z.nanoid(),
			time: z.iso.time(),
			ulid: z.ulid(),
			uuid: z.uuid(),
			xid: z.xid(),
		};

		expect(Object.keys(formats)).toEqual([...AUTO_TRUSTED_ZOD_STRING_FORMATS]);
		expect(new Set(Object.values(collectOutputTextTrust(z.object(formats))))).toEqual(
			new Set(["trusted"]),
		);
		expect(findUnclassifiedOutputTextPaths(z.object(formats))).toEqual([]);
	});

	it("reports missing, invalid, and structurally unsound trusted declarations as debt", () => {
		const invalid = z.string().meta({
			[APIFUSE_TEXT_TRUST_META_KEY]: { v: 2, trust: "trusted" },
		});
		const schema = z.object({
			missing: z.string(),
			invalid,
			plainTrusted: z.string().textTrust("trusted"),
			explicitUntrusted: z.string().textTrust("untrusted"),
		});

		expect(collectOutputTextTrust(schema)).toEqual({
			'$["explicitUntrusted"]': "untrusted",
			'$["invalid"]': "untrusted",
			'$["missing"]': "untrusted",
			'$["plainTrusted"]': "untrusted",
		});
		expect(findUnclassifiedOutputTextPaths(schema)).toEqual([
			'$["invalid"]',
			'$["missing"]',
			'$["plainTrusted"]',
		]);
	});

	it("projects the closed versioned vocabulary on output string leaves only", () => {
		const schema = z.object({
			message: z.string(),
			status: z.literal("ok"),
			requestedTrustedProse: z.string().textTrust("trusted"),
			invalidMetadata: z.string().meta({
				[APIFUSE_TEXT_TRUST_META_KEY]: { v: 999, trust: "unknown" },
			}),
			invalidWrapperMetadata: z
				.string()
				.default("fallback")
				.meta({ [APIFUSE_TEXT_TRUST_META_KEY]: { v: 999, trust: "unknown" } }),
		});
		const inputDescription = describeSchema(schema) as {
			jsonSchema?: { properties?: Record<string, Record<string, unknown>> };
		};
		const outputDescription = describeSchema(schema, { outputTextTrust: true }) as {
			jsonSchema?: { properties?: Record<string, Record<string, unknown>> };
		};

		expect(inputDescription.jsonSchema?.properties?.message?.[APIFUSE_TEXT_TRUST_META_KEY]).toBe(
			undefined,
		);
		expect(
			outputDescription.jsonSchema?.properties?.message?.[APIFUSE_TEXT_TRUST_META_KEY],
		).toEqual({ v: 1, trust: "untrusted" });
		expect(outputDescription.jsonSchema?.properties?.status?.[APIFUSE_TEXT_TRUST_META_KEY]).toEqual(
			{ v: 1, trust: "trusted" },
		);
		expect(
			outputDescription.jsonSchema?.properties?.requestedTrustedProse?.[
				APIFUSE_TEXT_TRUST_META_KEY
			],
		).toEqual({ v: 1, trust: "untrusted" });
		expect(
			outputDescription.jsonSchema?.properties?.invalidMetadata?.[APIFUSE_TEXT_TRUST_META_KEY],
		).toEqual({ v: 1, trust: "untrusted" });
		expect(
			outputDescription.jsonSchema?.properties?.invalidWrapperMetadata?.[
				APIFUSE_TEXT_TRUST_META_KEY
			],
		).toEqual({ v: 1, trust: "untrusted" });
		expect(JSON.stringify(outputDescription)).not.toContain('"unknown"');
		expect(JSON.stringify(outputDescription)).not.toContain("999");
	});

	it("produces a byte-identical deterministic projection", () => {
		const schema = z.object({
			zeta: z.string().textTrust("untrusted"),
			alpha: z.enum(["a", "b"]),
		});

		const first = canonicalJson(describeSchema(schema, { outputTextTrust: true }));
		const second = canonicalJson(describeSchema(schema, { outputTextTrust: true }));
		expect(first).toBe(second);
	});

	it("mutation probe changes projection and removing annotation creates debt", () => {
		const untrusted = z.object({
			value: z
				.string()
				.regex(/^[A-Z]{2}$/)
				.textTrust("untrusted"),
		});
		const trusted = z.object({
			value: z
				.string()
				.regex(/^[A-Z]{2}$/)
				.textTrust("trusted"),
		});
		const missing = z.object({ value: z.string() });

		expect(canonicalJson(describeSchema(untrusted, { outputTextTrust: true }))).not.toBe(
			canonicalJson(describeSchema(trusted, { outputTextTrust: true })),
		);
		expect(collectOutputTextTrust(untrusted)).not.toEqual(collectOutputTextTrust(trusted));
		expect(findUnclassifiedOutputTextPaths(untrusted)).toEqual([]);
		expect(findUnclassifiedOutputTextPaths(missing)).toEqual(['$["value"]']);
	});
});
