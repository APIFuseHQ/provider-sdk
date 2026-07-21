import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";

import { AUTH_TURN_SCHEMA } from "../auth-turn/index.js";
import { TurnValidationError } from "../errors.js";
import { validateCeremonyOutput } from "./index.js";

interface NamedFixture {
	name: string;
	turn: Record<string, unknown>;
}

const FIXTURES_DIR = join(import.meta.dir, "..", "auth-turn", "fixtures");

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

const contractAjv = new Ajv2020({
	allErrors: true,
	strict: true,
	strictSchema: true,
});
const contractAccepts = contractAjv.compile(AUTH_TURN_SCHEMA);

function runtimeAccepts(turn: unknown): boolean {
	try {
		validateCeremonyOutput(turn);
		return true;
	} catch (error) {
		expect(error).toBeInstanceOf(TurnValidationError);
		return false;
	}
}

describe("ceremonies runtime validation derives from the auth-turn contract", () => {
	it("accepts every golden fixture through both validators", () => {
		expect(validFixtures.length).toBeGreaterThan(0);
		for (const { name, turn } of validFixtures) {
			expect(`${name}: ${contractAccepts(turn)}`).toBe(`${name}: true`);
			expect(validateCeremonyOutput(turn)).toBe(turn);
		}
	});

	it("rejects every invalid fixture through both validators", () => {
		expect(invalidFixtures.length).toBeGreaterThan(0);
		for (const { name, turn } of invalidFixtures) {
			expect(`${name}: ${contractAccepts(turn)}`).toBe(`${name}: false`);
			expect(`${name}: ${runtimeAccepts(turn)}`).toBe(`${name}: false`);
		}
	});

	it("agrees with the contract on edge probes beyond the fixture set", () => {
		const probes: unknown[] = [
			{ kind: "form", turnId: "probe.minimal" },
			{ kind: "totally_custom", turnId: "probe.unknown-kind" },
			{ kind: "poll", turnId: "probe.timing", timing: {} },
			{
				kind: "poll",
				turnId: "probe.timing-zero",
				timing: { suggestedPollIntervalMs: 0 },
			},
			{ kind: "form", turnId: "probe.hint-non-string", hint: 42 },
			{ kind: "form", turnId: "probe.data-array", data: [] },
			{ kind: "form", turnId: "" },
			{ kind: "form", turnId: "probe.extra", extra: true },
			"not-an-object",
			null,
			{},
		];
		for (const probe of probes) {
			expect(`${JSON.stringify(probe)}: ${runtimeAccepts(probe)}`).toBe(
				`${JSON.stringify(probe)}: ${contractAccepts(probe)}`,
			);
		}
	});
});
