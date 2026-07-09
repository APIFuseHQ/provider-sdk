import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
	AUTH_TURN_ENVELOPE_MAJOR,
	AUTH_TURN_SCHEMA,
	AUTH_TURN_SCHEMA_ARTIFACT_PATH,
	type KnownAuthTurnKind,
	TURN_KINDS,
} from "./index";

interface NamedFixture {
	name: string;
	turn: Record<string, unknown>;
}

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

function loadFixtures(subdirectory: "valid" | "invalid"): NamedFixture[] {
	const directory = join(FIXTURES_DIR, subdirectory);
	return readdirSync(directory)
		.filter((entry) => entry.endsWith(".json"))
		.sort()
		.map((entry) => ({
			name: entry,
			turn: JSON.parse(readFileSync(join(directory, entry), "utf8")),
		}));
}

const validFixtures = loadFixtures("valid");
const invalidFixtures = loadFixtures("invalid");

const ajv = new Ajv2020({ allErrors: true, strict: true, strictSchema: true });
const validateEnvelope = ajv.compile(AUTH_TURN_SCHEMA);

describe("auth-turn contract", () => {
	it("exports envelope major 1 as an integer", () => {
		expect(AUTH_TURN_ENVELOPE_MAJOR).toBe(1);
		expect(Number.isInteger(AUTH_TURN_ENVELOPE_MAJOR)).toBe(true);
	});

	it("keeps the schema $id aligned with the envelope major", () => {
		expect(AUTH_TURN_SCHEMA.$id).toBe(
			`https://apifuse.com/contracts/auth-turn/v${AUTH_TURN_ENVELOPE_MAJOR}`,
		);
		expect(AUTH_TURN_SCHEMA_ARTIFACT_PATH).toBe(
			`dist/auth-turn/auth-turn.v${AUTH_TURN_ENVELOPE_MAJOR}.schema.json`,
		);
	});

	it("keeps the committed schema artifact identical to the exported document", () => {
		const committed = JSON.parse(
			readFileSync(join(import.meta.dir, "auth-turn.v1.schema.json"), "utf8"),
		);
		expect(committed).toEqual(AUTH_TURN_SCHEMA);
	});

	it("accepts every golden fixture", () => {
		expect(validFixtures.length).toBeGreaterThan(0);
		for (const { name, turn } of validFixtures) {
			expect(validateEnvelope(turn)).toBe(true);
			expect(`${name}: ${JSON.stringify(validateEnvelope.errors)}`).toBe(`${name}: null`);
		}
	});

	it("rejects every invalid fixture", () => {
		expect(invalidFixtures.length).toBeGreaterThan(0);
		for (const { name, turn } of invalidFixtures) {
			expect(`${name}: ${validateEnvelope(turn)}`).toBe(`${name}: false`);
		}
	});

	it("ships one golden fixture per registered turn kind", () => {
		const fixtureKinds = new Set(validFixtures.map(({ turn }) => turn.kind as string));
		for (const descriptor of TURN_KINDS) {
			expect(fixtureKinds).toContain(descriptor.kind);
			const fixtureFile = validFixtures.find(({ name }) => name === `${descriptor.kind}.json`);
			expect(fixtureFile?.turn.kind).toBe(descriptor.kind);
		}
	});

	it("covers only registered kinds plus the openness pin in golden fixtures", () => {
		const registeredKinds = new Set<string>(TURN_KINDS.map((descriptor) => descriptor.kind));
		const fixtureKinds = new Set(validFixtures.map(({ turn }) => turn.kind as string));
		const unregistered = [...fixtureKinds].filter((kind) => !registeredKinds.has(kind));
		expect(unregistered).toEqual(["totally_custom"]);
	});

	it("keeps kind open on the wire — unknown kinds stay valid", () => {
		expect(validateEnvelope({ kind: "totally_custom", turnId: "openness-pin" })).toBe(true);
		expect(validateEnvelope({ kind: "another_future_kind", turnId: "openness-pin" })).toBe(true);
	});

	it("registers each turn kind exactly once with a valid descriptor", () => {
		const kinds = TURN_KINDS.map((descriptor) => descriptor.kind);
		expect(new Set(kinds).size).toBe(kinds.length);
		expect(kinds).toEqual([...kinds].sort());
		for (const descriptor of TURN_KINDS) {
			expect(descriptor.since).toBeLessThanOrEqual(AUTH_TURN_ENVELOPE_MAJOR);
			expect(["custom", "schema", "terminal"]).toContain(descriptor.rendering);
		}
	});

	it("resolves terminal payload schemas and validates terminal fixtures against them", () => {
		const terminalDescriptors = TURN_KINDS.filter(
			(descriptor) => descriptor.rendering === "terminal",
		);
		expect(terminalDescriptors.map((descriptor) => descriptor.kind)).toEqual(["abort", "complete"]);
		for (const descriptor of terminalDescriptors) {
			const pointer = descriptor.payloadSchema;
			expect(pointer).toStartWith("#/$defs/");
			const definitionKey = (pointer as string).slice("#/$defs/".length);
			const payloadSchema =
				AUTH_TURN_SCHEMA.$defs[definitionKey as keyof typeof AUTH_TURN_SCHEMA.$defs];
			expect(payloadSchema).toBeDefined();

			const fixture = validFixtures.find(({ name }) => name === `${descriptor.kind}.json`);
			const payloadAjv = new Ajv2020({ allErrors: true, strict: true });
			expect(payloadAjv.validate(payloadSchema, fixture?.turn.data)).toBe(true);
		}
	});

	it("uses only synthetic credentials in the complete golden fixture", () => {
		const complete = validFixtures.find(({ name }) => name === "complete.json");
		expect(JSON.stringify(complete?.turn)).toContain("fixture-fake-");
	});

	it("pins the known-kind union at the type level", () => {
		// Record<KnownAuthTurnKind, true> forces this literal to stay in exact
		// lockstep with TURN_KINDS: adding or removing a registry kind without
		// updating (and re-fixturing) it fails `bun run type-check`.
		const coverage: Record<KnownAuthTurnKind, true> = {
			abort: true,
			challenge: true,
			complete: true,
			form: true,
			message: true,
			multi_choice: true,
			pending: true,
			poll: true,
			redirect: true,
			retry: true,
		};
		expect(Object.keys(coverage).sort()).toEqual(TURN_KINDS.map((descriptor) => descriptor.kind));
	});
});
