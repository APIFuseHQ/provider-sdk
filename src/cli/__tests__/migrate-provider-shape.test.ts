import { describe, expect, it } from "bun:test";
import ts from "typescript";

import {
	migrateProviderShape,
	type ProviderShapeMigration,
} from "../migrate-provider-shape.js";

/**
 * Fixtures mirror the four shape classes measured across the 84 polyrepo
 * provider repositories on 2026-08-28 (apifuse issue #1699 analysis), plus
 * the already-migrated shape and the loud-skip contract.
 */

const IMPORTS = `import { defineProvider } from "@apifuse/provider-sdk/provider";

import { providerMeta } from "./meta";
import { operations } from "./operations";
`;

const DECLARATION_BODY = `	id: "probe",
	version: "1.0.0",
	runtime: "standard",
	allowedHosts: ["api.example.com"],
	reviewed: "community",
	auth: { mode: "none" },
	meta: providerMeta,`;

/** Fleet class 1 (44 repos): single-phase, direct default export. */
const SINGLE_PHASE_DEFAULT_EXPORT = `${IMPORTS}
export default defineProvider({
${DECLARATION_BODY}
	operations: operations,
});
`;

/** Fleet class 2 (20 repos): single-phase, intermediate const. */
const SINGLE_PHASE_VARIABLE_EXPORT = `${IMPORTS}
const provider = defineProvider({
${DECLARATION_BODY}
	operations: operations,
});

export default provider;
`;

/** Fleet class 3 (10 repos): intermediate const with an inline operations map. */
const SINGLE_PHASE_INLINE_OPERATIONS = `${IMPORTS}
const provider = defineProvider({
${DECLARATION_BODY}
	operations: {
		ping: {
			descriptionKey: "operations.ping.description",
			input: {},
			output: {},
			handler: async () => ({ ok: true }),
		},
	},
});

export default provider;
`;

/** Fleet class 4 (3+1 repos): spread export carrying a deployment key. */
const SINGLE_PHASE_SPREAD_EXPORT = `${IMPORTS}
const provider = defineProvider({
${DECLARATION_BODY}
	operations: operations,
});

export default {
	...provider,
	deployment: { resources: { cpu: "200m", memory: "512Mi" } },
};
`;

/** Scaffold output for beta.39+: already two-phase. Must be untouched. */
const TWO_PHASE = `import { defineProvider, type ProviderContextOf } from "@apifuse/provider-sdk/provider";

import { providerMeta } from "./meta";
import { operations } from "./operations";

const buildProvider = defineProvider({
${DECLARATION_BODY}
});

export type ProviderContext = ProviderContextOf<typeof buildProvider>;

export default buildProvider({ operations });
`;

function expectMigrated(
	result: ProviderShapeMigration,
): Extract<ProviderShapeMigration, { status: "migrated" }> {
	if (result.status !== "migrated") {
		throw new Error(
			`expected migrated, got ${result.status}${
				result.status === "skipped" ? `: ${result.reason}` : ""
			}`,
		);
	}
	return result;
}

function parses(code: string): boolean {
	const source = ts.createSourceFile(
		"index.ts",
		code,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const diagnostics = (
		source as ts.SourceFile & { parseDiagnostics?: ts.DiagnosticWithLocation[] }
	).parseDiagnostics;
	return diagnostics === undefined || diagnostics.length === 0;
}

describe("migrateProviderShape", () => {
	it("migrates the direct default-export shape", () => {
		const result = expectMigrated(migrateProviderShape(SINGLE_PHASE_DEFAULT_EXPORT));

		expect(result.kind).toBe("single-phase-default-export");
		expect(parses(result.code)).toBe(true);
		expect(result.code).toContain("const buildProvider = defineProvider({");
		expect(result.code).toContain("export default buildProvider({ operations });");
		expect(result.code).toContain(
			"export type ProviderContext = ProviderContextOf<typeof buildProvider>;",
		);
		expect(result.code).toContain(", type ProviderContextOf");
		// The declaration literal no longer carries operations.
		expect(result.code).not.toMatch(/operations: operations,?\s*\}\);/);
	});

	it("migrates the intermediate-variable shape and reuses the binding for the builder", () => {
		const result = expectMigrated(migrateProviderShape(SINGLE_PHASE_VARIABLE_EXPORT));

		expect(result.kind).toBe("single-phase-variable-export");
		expect(parses(result.code)).toBe(true);
		expect(result.code).toContain("const buildProvider = defineProvider({");
		expect(result.code).toContain("export default buildProvider({ operations });");
		// The old binding name is gone entirely.
		expect(result.code).not.toContain("const provider =");
		expect(result.code).not.toMatch(/export default provider;/);
	});

	it("migrates an inline operations map by moving the literal into the builder call", () => {
		const result = expectMigrated(migrateProviderShape(SINGLE_PHASE_INLINE_OPERATIONS));

		expect(result.kind).toBe("single-phase-variable-export");
		expect(parses(result.code)).toBe(true);
		expect(result.code).toContain("export default buildProvider({ operations: {");
		expect(result.code).toContain("descriptionKey");
		// The declaration literal itself no longer holds the map.
		const declarationSlice = result.code.slice(
			result.code.indexOf("defineProvider({"),
			result.code.indexOf("});"),
		);
		expect(declarationSlice).not.toContain("operations:");
	});

	it("migrates the spread-export shape and keeps the deployment key spreading a built provider", () => {
		const result = expectMigrated(migrateProviderShape(SINGLE_PHASE_SPREAD_EXPORT));

		expect(result.kind).toBe("single-phase-variable-spread-export");
		expect(parses(result.code)).toBe(true);
		expect(result.code).toContain("const buildProvider = defineProvider({");
		expect(result.code).toContain("const provider = buildProvider({ operations });");
		expect(result.code).toContain("...provider");
		expect(result.code).toContain("deployment: { resources:");
	});

	it("returns the two-phase shape unchanged, byte for byte", () => {
		const result = migrateProviderShape(TWO_PHASE);

		expect(result.status).toBe("unchanged");
		if (result.status === "unchanged") {
			expect(result.code).toBe(TWO_PHASE);
		}
	});

	it("is idempotent: migrating a migrated output returns unchanged", () => {
		const first = expectMigrated(migrateProviderShape(SINGLE_PHASE_VARIABLE_EXPORT));
		const second = migrateProviderShape(first.code);

		expect(second.status).toBe("unchanged");
	});

	it("is idempotent on the spread-export shape too", () => {
		const first = expectMigrated(migrateProviderShape(SINGLE_PHASE_SPREAD_EXPORT));
		const second = migrateProviderShape(first.code);

		expect(second.status).toBe("unchanged");
	});

	it("skips loudly when no defineProvider call exists", () => {
		const result = migrateProviderShape(`export default { id: "x" };\n`);

		expect(result.status).toBe("skipped");
		if (result.status === "skipped") {
			expect(result.reason).toContain("No defineProvider");
		}
	});

	it("skips loudly when the module has no default export", () => {
		const result = migrateProviderShape(
			`${IMPORTS}\nexport const provider = defineProvider({\n${DECLARATION_BODY}\n\toperations: operations,\n});\n`,
		);

		expect(result.status).toBe("skipped");
		if (result.status === "skipped") {
			expect(result.reason).toContain("export default");
		}
	});

	it("skips loudly on multiple defineProvider calls", () => {
		const result = migrateProviderShape(
			`${IMPORTS}\nconst a = defineProvider({ id: "a" });\nconst b = defineProvider({ id: "b" });\nexport default a;\n`,
		);

		expect(result.status).toBe("skipped");
		if (result.status === "skipped") {
			expect(result.reason).toContain("2 defineProvider");
		}
	});

	it("skips loudly when operations uses a form it cannot relocate", () => {
		const result = migrateProviderShape(
			`${IMPORTS}\nexport default defineProvider({\n${DECLARATION_BODY}\n\tget operations() { return operations; },\n});\n`,
		);

		expect(result.status).toBe("skipped");
		if (result.status === "skipped") {
			expect(result.reason).toContain("cannot relocate");
		}
	});

	it("skips loudly on a non-literal declaration argument", () => {
		const result = migrateProviderShape(
			`${IMPORTS}\nconst config = { id: "x", operations };\nexport default defineProvider(config);\n`,
		);

		expect(result.status).toBe("skipped");
		if (result.status === "skipped") {
			expect(result.reason).toContain("non-literal");
		}
	});

	it("skips loudly on unparseable source instead of guessing", () => {
		const result = migrateProviderShape(`const = defineProvider({;\n`);

		expect(result.status).toBe("skipped");
	});

	it("avoids shadowing an existing buildProvider binding", () => {
		const withCollision = `${IMPORTS}
const buildProvider = () => null;

export default defineProvider({
${DECLARATION_BODY}
	operations: operations,
});
`;
		const result = expectMigrated(migrateProviderShape(withCollision));

		expect(parses(result.code)).toBe(true);
		expect(result.code).toContain("const buildProvider2 = defineProvider({");
		expect(result.code).toContain("export default buildProvider2({ operations });");
	});

	it("preserves shorthand operations as shorthand", () => {
		const shorthand = `${IMPORTS}
export default defineProvider({
${DECLARATION_BODY}
	operations,
});
`;
		const result = expectMigrated(migrateProviderShape(shorthand));

		expect(parses(result.code)).toBe(true);
		expect(result.code).toContain("export default buildProvider({ operations });");
	});

	it("does not duplicate an existing ProviderContext alias", () => {
		const withAlias = `${IMPORTS}
export type ProviderContext = { env: never };

const provider = defineProvider({
${DECLARATION_BODY}
	operations: operations,
});

export default provider;
`;
		const result = expectMigrated(migrateProviderShape(withAlias));

		const occurrences = result.code.match(/export type ProviderContext/g) ?? [];
		expect(occurrences.length).toBe(1);
	});
});
