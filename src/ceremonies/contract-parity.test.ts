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

function runtimeDiagnostics(turn: unknown): string {
	try {
		validateCeremonyOutput(turn);
		return "";
	} catch (error) {
		expect(error).toBeInstanceOf(TurnValidationError);
		return (error as TurnValidationError).message;
	}
}

function oracleDiagnostics(turn: unknown): string {
	if (contractAccepts(turn)) return "";
	return (contractAccepts.errors ?? [])
		.map((error) => {
			const message =
				error.keyword === "additionalProperties"
					? `must NOT have additional property '${String(error.params.additionalProperty)}'`
					: (error.message ?? "invalid");
			return `${error.instancePath} ${message}`;
		})
		.join("; ");
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

	it("matches AJV verdicts across every known kind and malformed edge cases", () => {
		const corpus: NamedFixture[] = [
			...validFixtures,
			{ name: "unknown-kind", turn: { kind: "totally_custom", turnId: "probe.unknown-kind" } },
			{
				name: "nested-type",
				turn: {
					kind: "poll",
					turnId: "probe.nested-type",
					timing: { suggestedPollIntervalMs: "fast" },
				},
			},
			{ name: "missing-required", turn: { kind: "form" } },
			{ name: "additional-property", turn: { kind: "form", turnId: "probe.extra", extra: true } },
			{
				name: "nested-additional-property",
				turn: { kind: "poll", turnId: "probe.nested-extra", timing: { extra: true } },
			},
			{
				name: "constructor-property",
				turn: { kind: "form", turnId: "probe.constructor", constructor: "unexpected" },
			},
			{
				name: "toString-property",
				turn: { kind: "form", turnId: "probe.toString", toString: "unexpected" },
			},
			{
				name: "json-proto-property",
				turn: JSON.parse(
					'{"kind":"form","turnId":"probe.__proto__","__proto__":"unexpected"}',
				),
			},
		];

		for (const { name, turn } of corpus) {
			const oracleAccepts = contractAccepts(turn);
			expect(`${name}: ${runtimeAccepts(turn)}`).toBe(`${name}: ${oracleAccepts}`);
		}
	});

	it("matches AJV instance paths and joined diagnostics for representative failures", () => {
		const nestedType = {
			kind: "poll",
			turnId: "diagnostic.nested-type",
			timing: { suggestedPollIntervalMs: "fast" },
		};
		const nestedAdditional = {
			kind: "poll",
			turnId: "diagnostic.nested-additional",
			timing: { unexpected: true },
		};
		const joinedFailures = {
			kind: "",
			turnId: "diagnostic.joined",
			hint: 42,
			unexpected: true,
		};

		expect(runtimeDiagnostics(nestedType)).toBe(oracleDiagnostics(nestedType));
		expect(runtimeDiagnostics(nestedType)).toBe(
			"/timing/suggestedPollIntervalMs must be number",
		);
		expect(runtimeDiagnostics(nestedAdditional)).toBe(oracleDiagnostics(nestedAdditional));
		expect(runtimeDiagnostics(nestedAdditional)).toBe(
			"/timing must NOT have additional property 'unexpected'",
		);
		expect(runtimeDiagnostics(joinedFailures)).toBe(oracleDiagnostics(joinedFailures));
		expect(runtimeDiagnostics(joinedFailures)).toBe(
			" must NOT have additional property 'unexpected'; /kind must NOT have fewer than 1 characters; /hint must be string",
		);
	});
});
