import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

import type { ProviderDeploymentOverrides } from "../../types.js";
import {
	DEPLOYMENT_PROFILE_DEFAULTS,
	deploymentIntentsEquivalent,
	normalizeLegacyDeployment,
	parseDeploymentIntent,
	redundantDeploymentDefaults,
	type ResolvedDeploymentIntent,
	resolveDeploymentIntent,
	subtractDeploymentDefaults,
} from "../deployment-intent.js";
import {
	DEPLOYMENT_RUNTIME_AXIS_COMMENT,
	type DeploymentIntentMigration,
	findDeployModuleConsumers,
	findSpreadExportDeploymentProperty,
	migrateDeploymentIntent,
	readDeclaredDeploymentIntent,
	readLegacyDeployFile,
	stripCodeownersDeployLock,
} from "../migrate-deployment-intent.js";

/**
 * Fixtures: every `deploy.ts` of the 91 provider repositories snapshotted on
 * 2026-09-08 (45 platform-generated mirrors, 6 of them hand-edited; 46
 * hand-written `satisfies` files), plus synthetic `index.ts` declaration
 * shapes covering the fleet's defineProvider() call forms.
 */
const FIXTURES_DIR = join(import.meta.dir, "fixtures", "migrate-deployment-intent");
const FLEET = readdirSync(FIXTURES_DIR)
	.filter((name) => name.endsWith(".deploy.ts.txt"))
	.sort()
	.map((name) => ({
		id: name.replace(/\.deploy\.ts\.txt$/, ""),
		deploySource: readFileSync(join(FIXTURES_DIR, name), "utf8"),
	}));

function fleetDeploy(id: string): string {
	const entry = FLEET.find((candidate) => candidate.id === id);
	if (entry === undefined) throw new Error(`missing fleet fixture ${id}`);
	return entry.deploySource;
}

const IMPORTS = `import { defineProvider, type ProviderContextOf } from "@apifuse/provider-sdk/provider";

import { providerMeta } from "./meta";
import { operations } from "./operations";
`;

const DECLARATION_BODY = `  id: "probe",
  version: "1.0.0",
  runtime: "standard",
  allowedHosts: ["api.example.com"],
  reviewed: "community",
  auth: { mode: "none" },
  meta: providerMeta,`;

/** 79 fleet repos: two-phase declaration with an object-literal argument. */
const LITERAL_INDEX = `${IMPORTS}
const buildProvider = defineProvider({
${DECLARATION_BODY}
});

export type ProviderContext = ProviderContextOf<typeof buildProvider>;

export default buildProvider({ operations });
`;

/** 11 fleet repos spread a shared object inside the argument literal. */
const SPREAD_ARGUMENT_INDEX = `${IMPORTS}
const BASE_DECLARATION = { version: "1.0.0", reviewed: "community" } as const;

const buildProvider = defineProvider({
  ...BASE_DECLARATION,
  id: "probe",
  runtime: "standard",
  allowedHosts: ["api.example.com"],
  auth: { mode: "none" },
  meta: providerMeta,
});

export type ProviderContext = ProviderContextOf<typeof buildProvider>;

export default buildProvider({ operations });
`;

/** Declaration bound to a top-level const literal before the call. */
const VARIABLE_LITERAL_INDEX = `${IMPORTS}
const declaration = {
${DECLARATION_BODY}
} satisfies Parameters<typeof defineProvider>[0];

const buildProvider = defineProvider(declaration);

export type ProviderContext = ProviderContextOf<typeof buildProvider>;

export default buildProvider({ operations });
`;

/** tabelog: the declaration is destructured out of a factory call. */
const FACTORY_VARIABLE_INDEX = `${IMPORTS}
import { createProvider } from "./operations/provider";

const { operations: built, ...declaration } = createProvider();
const buildProvider = defineProvider(declaration);

export type ProviderContext = ProviderContextOf<typeof buildProvider>;

export default buildProvider({ operations: built });
`;

/** japan-*: the key rides a spread default export. */
const SPREAD_EXPORT_INDEX = `${IMPORTS}
const buildProvider = defineProvider({
${DECLARATION_BODY}
});

export type ProviderContext = ProviderContextOf<typeof buildProvider>;

const provider = buildProvider({ operations });

export default {
  ...provider,
  deployment: {
    cache: { redis: { enabled: true } },
  },
};
`;

const SPREAD_EXPORT_WITH_EXTRA_INDEX = `${IMPORTS}
import { healthAccountSeedInputs } from "./health";

const buildProvider = defineProvider({
${DECLARATION_BODY}
});

export type ProviderContext = ProviderContextOf<typeof buildProvider>;

const provider = buildProvider({ operations });

export default {
  ...provider,
  deployment: { cache: { redis: { enabled: true } } },
  healthAccountSeedInputs,
};
`;

/** tablecheck: deploy.ts is imported and attached to the spread export. */
const IMPORT_DEPLOY_INDEX = `import { defineProvider, type ProviderContextOf } from "@apifuse/provider-sdk/provider";

import deployment from "./deploy";
import { providerMeta } from "./meta";
import { operations } from "./operations";

const buildProvider = defineProvider({
${DECLARATION_BODY}
});

export type ProviderContext = ProviderContextOf<typeof buildProvider>;

const provider = buildProvider({ operations: operations });

export default { ...provider, deployment: deployment };
`;

/** kakaotalk: a comment mentions defineProvider( and deployment; one real call. */
const COMMENT_MENTION_INDEX = `${IMPORTS}
// Extracted from the defineProvider() argument: the provider-registry
// deployment-key guard statically scans the defineProvider call span.
const continueFlow = async () => ({ deployment: "unrelated" });

const buildProvider = defineProvider({
${DECLARATION_BODY}
});

export type ProviderContext = ProviderContextOf<typeof buildProvider>;

export default buildProvider({ operations, continueFlow });
`;

const EXISTING_KEY_INDEX = `${IMPORTS}
const buildProvider = defineProvider({
${DECLARATION_BODY}
  deployment: { runtime: "browser" },
});

export type ProviderContext = ProviderContextOf<typeof buildProvider>;

export default buildProvider({ operations });
`;

const TAB_INDEX = `${IMPORTS}
const buildProvider = defineProvider({
\tid: "probe",
\tversion: "1.0.0",
\truntime: "standard",
\tauth: { mode: "none" },
\tmeta: providerMeta,
});

export default buildProvider({ operations });
`;

const BROWSER_LEGACY_DEPLOY = `export default {
  "runtime": "browser",
  "language": "typescript",
  "replicas": 1,
  "hpa": { "enabled": true, "minReplicas": 1, "maxReplicas": 1, "targetCPUUtilizationPercentage": 70 },
  "resources": { "cpu": "200m", "memory": "256Mi" }
};
`;

const CODEOWNERS_WITH_BLOCK = `/.github/ @APIFuseHQ/provider-operators
/Dockerfile @APIFuseHQ/provider-operators
/index.ts @APIFuseHQ/provider-operators
# Platform-generated deployment mirror (TEMPORARY until the SDK deployment
# passthrough lands): deployment intent is platform-owned, so changes to the
# generated deploy.ts require operator review.
/deploy.ts @APIFuseHQ/provider-operators
`;

const CODEOWNERS_CLEAN = `/.github/ @APIFuseHQ/provider-operators
/Dockerfile @APIFuseHQ/provider-operators
/index.ts @APIFuseHQ/provider-operators
`;

const PROFILE_HPA = { ...DEPLOYMENT_PROFILE_DEFAULTS.hpa };

function expectMigrated(
	result: DeploymentIntentMigration,
): Extract<DeploymentIntentMigration, { status: "migrated" }> {
	if (result.status !== "migrated") {
		throw new Error(
			`expected migrated, got ${result.status}${result.status === "refused" ? `: ${result.reason}` : ""}`,
		);
	}
	return result;
}

function expectRefused(result: DeploymentIntentMigration): string {
	if (result.status !== "refused") throw new Error(`expected refused, got ${result.status}`);
	return result.reason;
}

function parses(code: string): boolean {
	const source = ts.createSourceFile(
		"index.ts",
		code,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: ts.DiagnosticWithLocation[] })
		.parseDiagnostics;
	return diagnostics === undefined || diagnostics.length === 0;
}

/** Resolve the key the transform wrote back into a resolved view. */
function resolveDeclared(indexSource: string): ResolvedDeploymentIntent {
	const declared = readDeclaredDeploymentIntent(indexSource);
	if (!declared.ok) throw new Error(declared.reason);
	if (declared.value === undefined) return resolveDeploymentIntent();
	const parsed = parseDeploymentIntent(declared.value);
	if (!parsed.ok) throw new Error(parsed.reason);
	return resolveDeploymentIntent(parsed.value);
}

function legacyOf(deploySource: string): ResolvedDeploymentIntent {
	const legacy = readLegacyDeployFile(deploySource);
	if (!legacy.ok) throw new Error(legacy.reason);
	return legacy.value;
}

describe("deployment-intent helpers", () => {
	it("resolves the shared profile from an empty key and the browser profile from runtime alone", () => {
		expect(resolveDeploymentIntent()).toEqual({
			runtime: "shared",
			language: "typescript",
			replicas: 1,
			hpa: PROFILE_HPA,
			resources: { cpu: "25m", memory: "128Mi" },
			buildContext: ".",
		});
		expect(resolveDeploymentIntent({ runtime: "browser" }).resources).toEqual({
			cpu: "200m",
			memory: "256Mi",
		});
	});

	it("rejects intents the registry rejects: dedicated without resources, non-default buildContext", () => {
		expect(() => resolveDeploymentIntent({ runtime: "dedicated" })).toThrow(/no profile default/);
		expect(() => resolveDeploymentIntent({ buildContext: "providers/x" })).toThrow(/buildContext/);
	});

	it("normalizes a legacy file with the legacy schema defaults, not the profile defaults", () => {
		const legacy = normalizeLegacyDeployment({
			runtime: "shared",
			language: "typescript",
			resources: { cpu: "25m", memory: "128Mi" },
		});
		expect(legacy.ok).toBe(true);
		if (!legacy.ok) return;
		// A legacy file without hpa resolved to a disabled HPA — that intent
		// must survive as an explicit key, never be "defaulted" away.
		expect(legacy.value.hpa).toEqual({ enabled: false });
		expect(legacy.value.replicas).toBe(1);
		expect(legacy.value.buildContext).toBe(".");
		expect(subtractDeploymentDefaults(legacy.value)).toEqual({ hpa: { enabled: false } });
	});

	it("subtracts every profile default and keeps hpa/resources whole when they differ", () => {
		const allDefaults = resolveDeploymentIntent();
		expect(subtractDeploymentDefaults(allDefaults)).toEqual({});

		const browserDefaults = resolveDeploymentIntent({ runtime: "browser" });
		expect(subtractDeploymentDefaults(browserDefaults)).toEqual({ runtime: "browser" });

		const partialHpa = subtractDeploymentDefaults({
			...allDefaults,
			hpa: { ...PROFILE_HPA, maxReplicas: 3 },
			network: { additionalTcpPorts: [] },
		});
		expect(partialHpa).toEqual({ hpa: { ...PROFILE_HPA, maxReplicas: 3 } });

		const dedicated = subtractDeploymentDefaults({
			...allDefaults,
			runtime: "dedicated",
			resources: { cpu: "1", memory: "1Gi" },
		});
		expect(dedicated).toEqual({ runtime: "dedicated", resources: { cpu: "1", memory: "1Gi" } });
		expect(resolveDeploymentIntent(dedicated).resources).toEqual({ cpu: "1", memory: "1Gi" });
	});

	it("treats empty network/cache shells as equivalent to their absence", () => {
		const base = resolveDeploymentIntent();
		expect(
			deploymentIntentsEquivalent(base, {
				...base,
				network: { additionalTcpPorts: [] },
				cache: {},
			}),
		).toBe(true);
		expect(
			deploymentIntentsEquivalent(base, { ...base, network: { additionalTcpPorts: [8088] } }),
		).toBe(false);
	});

	it("flags every restated profile default and nothing on a minimal key", () => {
		const paths = redundantDeploymentDefaults({
			runtime: "shared",
			language: "typescript",
			replicas: 1,
			hpa: PROFILE_HPA,
			resources: { cpu: "25m", memory: "128Mi" },
			buildContext: ".",
			network: { additionalTcpPorts: [] },
			cache: {},
		}).map((entry) => entry.path);
		expect(paths).toEqual([
			"runtime",
			"language",
			"replicas",
			"hpa",
			"resources",
			"buildContext",
			"network",
			"cache",
		]);
		expect(
			redundantDeploymentDefaults({
				runtime: "browser",
				resources: { cpu: "200m", memory: "256Mi" },
			}).map((entry) => entry.path),
		).toEqual(["resources"]);
		expect(redundantDeploymentDefaults({ cache: { redis: { enabled: true } } })).toEqual([]);
		expect(redundantDeploymentDefaults(undefined)).toEqual([]);
	});
});

describe("readLegacyDeployFile", () => {
	it("reads the generated mirror shape and the hand-written satisfies shape", () => {
		const mirror = readLegacyDeployFile(fleetDeploy("korea-etf"));
		expect(mirror.ok).toBe(true);
		if (mirror.ok) expect(mirror.value.resources).toEqual({ cpu: "25m", memory: "128Mi" });

		const handWritten = readLegacyDeployFile(fleetDeploy("kakaot"));
		expect(handWritten.ok).toBe(true);
		if (handWritten.ok) {
			expect(handWritten.value.cache).toEqual({ redis: { enabled: true } });
			// `replicas` is omitted in the file; the legacy schema defaulted it.
			expect(handWritten.value.replicas).toBe(1);
		}
	});

	it("refuses shapes it cannot evaluate statically", () => {
		expect(
			readLegacyDeployFile(
				`import { defineProviderDeployment } from "@apifuse/provider-registry";\nexport default defineProviderDeployment({ runtime: "shared" });\n`,
			),
		).toMatchObject({ ok: false, reason: expect.stringContaining("not a static literal") });
		expect(
			readLegacyDeployFile(`export const deployment = { runtime: "shared" };\n`),
		).toMatchObject({
			ok: false,
			reason: expect.stringContaining("export default"),
		});
		expect(
			readLegacyDeployFile(
				`const base = { language: "typescript" };\nexport default { ...base, runtime: "shared" };\n`,
			),
		).toMatchObject({ ok: false, reason: expect.stringContaining("spread") });
		expect(readLegacyDeployFile(`export default { runtime: "shared" };\n`)).toMatchObject({
			ok: false,
			reason: expect.stringContaining("not a valid deployment config"),
		});
	});
});

describe("stripCodeownersDeployLock", () => {
	it("removes the mirror line and the exact scaffold comment above it", () => {
		expect(stripCodeownersDeployLock(CODEOWNERS_WITH_BLOCK)).toEqual({
			text: CODEOWNERS_CLEAN,
			changed: true,
		});
	});

	it("removes a bare lock line and leaves unrelated comments alone", () => {
		const bare = `${CODEOWNERS_CLEAN}# operator lock\n/deploy.ts @APIFuseHQ/provider-operators\n/start.ts @APIFuseHQ/provider-operators\n`;
		expect(stripCodeownersDeployLock(bare)).toEqual({
			text: `${CODEOWNERS_CLEAN}# operator lock\n/start.ts @APIFuseHQ/provider-operators\n`,
			changed: true,
		});
	});

	it("is a no-op without the lock", () => {
		expect(stripCodeownersDeployLock(CODEOWNERS_CLEAN)).toEqual({
			text: CODEOWNERS_CLEAN,
			changed: false,
		});
	});
});

describe("migrateDeploymentIntent", () => {
	it("deletes a zero-config mirror without touching index.ts and keeps the CODEOWNERS lock by default", () => {
		const result = expectMigrated(
			migrateDeploymentIntent({
				indexSource: LITERAL_INDEX,
				deploySource: fleetDeploy("korea-etf"),
				codeownersSource: CODEOWNERS_WITH_BLOCK,
			}),
		);
		expect(result.shape).toBe("literal-argument");
		expect(result.intent).toEqual({});
		expect(result.indexChanged).toBe(false);
		expect(result.indexSource).toBe(LITERAL_INDEX);
		expect(result.removeDeployFile).toBe(true);
		// The platform still resolves a re-added deploy.ts until its legacy
		// fallback is retired, so the operator lock outlives the file.
		expect(result.codeownersChanged).toBe(false);
		expect(result.codeownersSource).toBe(CODEOWNERS_WITH_BLOCK);
		expect(result.notes).toEqual([expect.stringContaining("--drop-codeowners-lock")]);
		expect(result.legacy).toEqual(resolveDeploymentIntent());
	});

	it("drops the CODEOWNERS lock only when asked (after the platform retires the fallback)", () => {
		const result = expectMigrated(
			migrateDeploymentIntent({
				indexSource: LITERAL_INDEX,
				deploySource: fleetDeploy("korea-etf"),
				codeownersSource: CODEOWNERS_WITH_BLOCK,
				dropCodeownersLock: true,
			}),
		);
		expect(result.removeDeployFile).toBe(true);
		expect(result.codeownersChanged).toBe(true);
		expect(result.codeownersSource).toBe(CODEOWNERS_CLEAN);
		expect(result.notes).toEqual([]);
	});

	it("inserts a compact key right after the execution runtime property", () => {
		const result = expectMigrated(
			migrateDeploymentIntent({ indexSource: LITERAL_INDEX, deploySource: fleetDeploy("kakaot") }),
		);
		expect(result.intent).toEqual({ cache: { redis: { enabled: true } } });
		expect(result.indexSource).toContain(
			'  runtime: "standard",\n  deployment: { cache: { redis: { enabled: true } } },\n  allowedHosts:',
		);
		expect(result.indexSource).not.toContain(DEPLOYMENT_RUNTIME_AXIS_COMMENT);
		expect(parses(result.indexSource)).toBe(true);
	});

	it("moves hand-edited mirror values instead of regenerating the profile", () => {
		// google-flights: header says "generated from the shared profile" but
		// the file carries 100m/512Mi — the live deployment. Regenerating
		// would silently downgrade it.
		const result = expectMigrated(
			migrateDeploymentIntent({
				indexSource: LITERAL_INDEX,
				deploySource: fleetDeploy("google-flights"),
			}),
		);
		expect(result.intent).toEqual({ resources: { cpu: "100m", memory: "512Mi" } });
		expect(result.indexSource).toContain(
			'  deployment: { resources: { cpu: "100m", memory: "512Mi" } },\n',
		);
	});

	it("expands a key that does not fit one line, one property per line with trailing commas", () => {
		const result = expectMigrated(
			migrateDeploymentIntent({
				indexSource: LITERAL_INDEX,
				deploySource: fleetDeploy("tablecheck"),
			}),
		);
		expect(result.indexSource).toContain(`  runtime: "standard",
  deployment: {
    hpa: {
      enabled: true,
      minReplicas: 1,
      maxReplicas: 2,
      targetCPUUtilizationPercentage: 70,
    },
    resources: { cpu: "25m", memory: "256Mi" },
    cache: { redis: { enabled: true } },
  },
  allowedHosts:`);
	});

	it("marks the deployment runtime axis with a comment only when the key carries runtime", () => {
		const browser = expectMigrated(
			migrateDeploymentIntent({ indexSource: LITERAL_INDEX, deploySource: BROWSER_LEGACY_DEPLOY }),
		);
		expect(browser.intent).toEqual({ runtime: "browser" });
		expect(browser.indexSource).toContain(
			`  runtime: "standard",\n  ${DEPLOYMENT_RUNTIME_AXIS_COMMENT}\n  deployment: { runtime: "browser" },\n`,
		);
		const catchtable = expectMigrated(
			migrateDeploymentIntent({
				indexSource: LITERAL_INDEX,
				deploySource: fleetDeploy("catchtable"),
			}),
		);
		expect(catchtable.intent).toEqual({ runtime: "browser", cache: { redis: { enabled: true } } });
		expect(catchtable.indexSource).toContain(
			'  deployment: { runtime: "browser", cache: { redis: { enabled: true } } },\n',
		);
	});

	it("handles a spread inside the declaration argument (spreads are not the transform's concern)", () => {
		const result = expectMigrated(
			migrateDeploymentIntent({
				indexSource: SPREAD_ARGUMENT_INDEX,
				deploySource: fleetDeploy("kakaot"),
			}),
		);
		expect(result.shape).toBe("literal-argument");
		expect(result.indexSource).toContain(
			'  ...BASE_DECLARATION,\n  id: "probe",\n  runtime: "standard",\n  deployment: { cache: { redis: { enabled: true } } },\n',
		);
	});

	it("inserts into a top-level const literal passed to defineProvider by name", () => {
		const result = expectMigrated(
			migrateDeploymentIntent({
				indexSource: VARIABLE_LITERAL_INDEX,
				deploySource: fleetDeploy("kakaot"),
			}),
		);
		expect(result.shape).toBe("variable-literal-argument");
		expect(result.indexSource).toContain(
			'const declaration = {\n  id: "probe",\n  version: "1.0.0",\n  runtime: "standard",\n  deployment: { cache: { redis: { enabled: true } } },\n',
		);
		expect(parses(result.indexSource)).toBe(true);
	});

	it("accounts for spreads inside the declaration: inspectable ones pass, deployment-bearing or opaque ones refuse", () => {
		// A spread that resolves to a const literal without `deployment` is fine
		// (SPREAD_ARGUMENT_INDEX above). One that carries the key would be the
		// effective value, so the transform must not write a competing property.
		const carrying = SPREAD_ARGUMENT_INDEX.replace(
			'const BASE_DECLARATION = { version: "1.0.0", reviewed: "community" } as const;',
			'const BASE_DECLARATION = { version: "1.0.0", deployment: { runtime: "browser" } } as const;',
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({ indexSource: carrying, deploySource: fleetDeploy("korea-etf") }),
			),
		).toContain("through `...BASE_DECLARATION`");

		// Explicit property AFTER a deployment-bearing spread wins (last-wins):
		// the transform compares it and keeps the file deletion safe.
		const explicitWins = carrying.replace(
			'  runtime: "standard",\n',
			'  runtime: "standard",\n  deployment: { runtime: "browser" },\n',
		);
		const result = expectMigrated(
			migrateDeploymentIntent({ indexSource: explicitWins, deploySource: BROWSER_LEGACY_DEPLOY }),
		);
		expect(result.indexChanged).toBe(false);
		expect(result.removeDeployFile).toBe(true);

		// A spread the transform cannot see into could carry the key.
		const opaque = SPREAD_ARGUMENT_INDEX.replace(
			'const BASE_DECLARATION = { version: "1.0.0", reviewed: "community" } as const;',
			'import { BASE_DECLARATION } from "./base";',
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({ indexSource: opaque, deploySource: fleetDeploy("korea-etf") }),
			),
		).toContain("does not resolve to a top-level const object literal");
		const nestedOpaque = SPREAD_ARGUMENT_INDEX.replace(
			'const BASE_DECLARATION = { version: "1.0.0", reviewed: "community" } as const;',
			'import { INNER } from "./base";\nconst BASE_DECLARATION = { ...INNER, version: "1.0.0" } as const;',
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({
					indexSource: nestedOpaque,
					deploySource: fleetDeploy("korea-etf"),
				}),
			),
		).toContain("`...INNER`");
	});

	it("refuses a declaration that declares deployment twice", () => {
		const twice = LITERAL_INDEX.replace(
			'  runtime: "standard",\n',
			'  runtime: "standard",\n  deployment: { runtime: "browser" },\n  deployment: { runtime: "shared" },\n',
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({ indexSource: twice, deploySource: BROWSER_LEGACY_DEPLOY }),
			),
		).toContain("more than once");
	});

	it("refuses default-export spreads that could override the deployment property", () => {
		// Provider spread after the property: the property may not be effective.
		const providerAfter = SPREAD_EXPORT_INDEX.replace(
			"export default {\n  ...provider,\n  deployment: {\n    cache: { redis: { enabled: true } },\n  },\n};",
			"export default {\n  deployment: {\n    cache: { redis: { enabled: true } },\n  },\n  ...provider,\n};",
		);
		expect(providerAfter).not.toBe(SPREAD_EXPORT_INDEX);
		expect(
			expectRefused(
				migrateDeploymentIntent({
					indexSource: providerAfter,
					deploySource: fleetDeploy("japan-open-data"),
				}),
			),
		).toContain("spreads the built provider after its deployment property");

		// A later const spread that carries deployment overrides the property.
		const laterCarrying = SPREAD_EXPORT_INDEX.replace(
			"const provider = buildProvider({ operations });",
			'const provider = buildProvider({ operations });\nconst overrides = { deployment: { runtime: "browser" } };',
		).replace(
			"    cache: { redis: { enabled: true } },\n  },\n};",
			"    cache: { redis: { enabled: true } },\n  },\n  ...overrides,\n};",
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({
					indexSource: laterCarrying,
					deploySource: fleetDeploy("japan-open-data"),
				}),
			),
		).toContain("also spreads an object that carries a deployment key");

		// A later const spread WITHOUT deployment is harmless and survives.
		const laterExtras = laterCarrying.replace(
			'const overrides = { deployment: { runtime: "browser" } };',
			"const overrides = { healthAccountSeedInputs: [] };",
		);
		const kept = expectMigrated(
			migrateDeploymentIntent({
				indexSource: laterExtras,
				deploySource: fleetDeploy("japan-open-data"),
			}),
		);
		expect(kept.indexSource).toContain("export default {\n  ...provider,\n  ...overrides,\n};");

		// An opaque spread (imported) cannot be proven deployment-free.
		const opaque = SPREAD_EXPORT_INDEX.replace(
			"const provider = buildProvider({ operations });",
			'import { extras } from "./extras";\nconst provider = buildProvider({ operations });',
		).replace(
			"    cache: { redis: { enabled: true } },\n  },\n};",
			"    cache: { redis: { enabled: true } },\n  },\n  ...extras,\n};",
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({
					indexSource: opaque,
					deploySource: fleetDeploy("japan-open-data"),
				}),
			),
		).toContain("`...extras`");

		// Duplicate deployment properties on the export.
		const twice = SPREAD_EXPORT_INDEX.replace(
			"    cache: { redis: { enabled: true } },\n  },\n};",
			'    cache: { redis: { enabled: true } },\n  },\n  deployment: { runtime: "browser" },\n};',
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({
					indexSource: twice,
					deploySource: fleetDeploy("japan-open-data"),
				}),
			),
		).toContain("more than once");
	});

	it("refuses a declaration built by a factory call (tabelog) rather than guessing", () => {
		const reason = expectRefused(
			migrateDeploymentIntent({
				indexSource: FACTORY_VARIABLE_INDEX,
				deploySource: fleetDeploy("tabelog"),
			}),
		);
		expect(reason).toContain("not a top-level const object literal");
	});

	it("refuses zero or several defineProvider calls but ignores mentions inside comments", () => {
		expect(
			expectRefused(
				migrateDeploymentIntent({ indexSource: IMPORTS, deploySource: fleetDeploy("korea-etf") }),
			),
		).toContain("No defineProvider");
		expect(
			expectRefused(
				migrateDeploymentIntent({
					indexSource: `${LITERAL_INDEX}\nconst other = defineProvider({ id: "b" });\n`,
					deploySource: fleetDeploy("korea-etf"),
				}),
			),
		).toContain("Found 2");
		const commented = expectMigrated(
			migrateDeploymentIntent({
				indexSource: COMMENT_MENTION_INDEX,
				deploySource: fleetDeploy("kakaotalk"),
			}),
		);
		expect(commented.intent).toEqual({
			hpa: { enabled: false },
			resources: { cpu: "100m", memory: "256Mi" },
		});
	});

	it("hoists a spread-export deployment into the declaration and folds the export", () => {
		const result = expectMigrated(
			migrateDeploymentIntent({
				indexSource: SPREAD_EXPORT_INDEX,
				deploySource: fleetDeploy("japan-open-data"),
			}),
		);
		expect(result.intent).toEqual({ cache: { redis: { enabled: true } } });
		expect(result.indexSource).toContain("export default provider;\n");
		expect(result.indexSource).not.toContain("...provider");
		expect(result.indexSource).toContain(
			'  runtime: "standard",\n  deployment: { cache: { redis: { enabled: true } } },\n',
		);
		expect(parses(result.indexSource)).toBe(true);
	});

	it("keeps a spread export that carries other extras", () => {
		const result = expectMigrated(
			migrateDeploymentIntent({
				indexSource: SPREAD_EXPORT_WITH_EXTRA_INDEX,
				deploySource: fleetDeploy("japan-gsi-geo"),
			}),
		);
		expect(result.indexSource).toContain(
			"export default {\n  ...provider,\n  healthAccountSeedInputs,\n};\n",
		);
		expect(parses(result.indexSource)).toBe(true);
	});

	it("removes an imported ./deploy attached to the spread export (tablecheck)", () => {
		const result = expectMigrated(
			migrateDeploymentIntent({
				indexSource: IMPORT_DEPLOY_INDEX,
				deploySource: fleetDeploy("tablecheck"),
			}),
		);
		expect(result.indexSource).not.toContain('from "./deploy"');
		expect(result.indexSource).toContain("export default provider;\n");
		expect(result.indexSource).toContain('    resources: { cpu: "25m", memory: "256Mi" },\n');
		expect(result.indexSource).toContain(
			'import { defineProvider, type ProviderContextOf } from "@apifuse/provider-sdk/provider";\n\nimport { providerMeta } from "./meta";\n',
		);
		expect(parses(result.indexSource)).toBe(true);
	});

	it("refuses when a type imported from ./deploy stays in use, and drops unused type-only bindings", () => {
		const mixedImport = IMPORT_DEPLOY_INDEX.replace(
			'import deployment from "./deploy";',
			'import deployment, { type DeploymentConfig } from "./deploy";',
		);
		const stillUsed = mixedImport.replace(
			"export type ProviderContext",
			"export type LegacyDeployment = DeploymentConfig;\n\nexport type ProviderContext",
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({
					indexSource: stillUsed,
					deploySource: fleetDeploy("tablecheck"),
				}),
			),
		).toContain("`DeploymentConfig`");

		const unused = expectMigrated(
			migrateDeploymentIntent({
				indexSource: mixedImport,
				deploySource: fleetDeploy("tablecheck"),
			}),
		);
		expect(unused.indexSource).not.toContain('from "./deploy"');
		expect(unused.indexSource).not.toContain("DeploymentConfig");
		expect(parses(unused.indexSource)).toBe(true);

		const typeOnlyUsed = LITERAL_INDEX.replace(
			IMPORTS,
			`${IMPORTS}import type { DeploymentConfig } from "./deploy";\n`,
		).replace(
			"export type ProviderContext",
			"export type LegacyDeployment = DeploymentConfig;\n\nexport type ProviderContext",
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({ indexSource: typeOnlyUsed, deploySource: fleetDeploy("kakaot") }),
			),
		).toContain("`DeploymentConfig`");
	});

	it("refuses when ./deploy is imported but deploy.ts is missing or used elsewhere", () => {
		expect(expectRefused(migrateDeploymentIntent({ indexSource: IMPORT_DEPLOY_INDEX }))).toContain(
			"deploy.ts is missing",
		);
		const usedElsewhere = IMPORT_DEPLOY_INDEX.replace(
			"export default { ...provider, deployment: deployment };",
			"console.log(deployment.runtime);\nexport default { ...provider, deployment: deployment };",
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({
					indexSource: usedElsewhere,
					deploySource: fleetDeploy("tablecheck"),
				}),
			),
		).toContain("still referenced");
	});

	it("only deletes the file when the declaration already carries an equivalent key", () => {
		const result = expectMigrated(
			migrateDeploymentIntent({
				indexSource: EXISTING_KEY_INDEX,
				deploySource: BROWSER_LEGACY_DEPLOY,
			}),
		);
		expect(result.indexChanged).toBe(false);
		expect(result.removeDeployFile).toBe(true);
		expect(result.intent).toEqual({ runtime: "browser" });
	});

	it("refuses when the authored key and deploy.ts disagree", () => {
		expect(
			expectRefused(
				migrateDeploymentIntent({
					indexSource: EXISTING_KEY_INDEX,
					deploySource: fleetDeploy("korea-etf"),
				}),
			),
		).toContain("resolve to different deployments");
		expect(
			expectRefused(
				migrateDeploymentIntent({
					indexSource: SPREAD_EXPORT_INDEX,
					deploySource: fleetDeploy("korea-etf"),
				}),
			),
		).toContain("resolve to different deployments");
	});

	it("rewrites an existing key to its minimal form and drops one that only restates defaults", () => {
		const restated = LITERAL_INDEX.replace(
			'  runtime: "standard",\n',
			'  runtime: "standard",\n  deployment: {\n    runtime: "shared",\n    resources: { cpu: "25m", memory: "128Mi" },\n    cache: { redis: { enabled: true } },\n  },\n',
		);
		const minimal = expectMigrated(migrateDeploymentIntent({ indexSource: restated }));
		expect(minimal.indexSource).toContain(
			'  runtime: "standard",\n  deployment: { cache: { redis: { enabled: true } } },\n',
		);
		expect(minimal.notes).toEqual([
			"Rewrote the deployment key to the minimal (profile-subtracted) form.",
		]);

		const onlyDefaults = LITERAL_INDEX.replace(
			'  runtime: "standard",\n',
			'  runtime: "standard",\n  deployment: { runtime: "shared", replicas: 1 },\n',
		);
		const dropped = expectMigrated(migrateDeploymentIntent({ indexSource: onlyDefaults }));
		expect(dropped.indexSource).toBe(LITERAL_INDEX);
		expect(dropped.notes).toEqual([
			"Removed a deployment key that only restated profile defaults.",
		]);
	});

	it("reports unchanged when there is nothing to move, but clears a stale CODEOWNERS lock on request", () => {
		expect(migrateDeploymentIntent({ indexSource: LITERAL_INDEX })).toEqual({
			status: "unchanged",
			notes: [],
		});
		expect(
			migrateDeploymentIntent({
				indexSource: EXISTING_KEY_INDEX,
				codeownersSource: CODEOWNERS_CLEAN,
			}),
		).toEqual({ status: "unchanged", notes: [] });
		// Without the flag a lingering lock is reported, not removed.
		expect(
			migrateDeploymentIntent({
				indexSource: LITERAL_INDEX,
				codeownersSource: CODEOWNERS_WITH_BLOCK,
			}),
		).toEqual({ status: "unchanged", notes: [expect.stringContaining("--drop-codeowners-lock")] });
		const stale = expectMigrated(
			migrateDeploymentIntent({
				indexSource: LITERAL_INDEX,
				codeownersSource: CODEOWNERS_WITH_BLOCK,
				dropCodeownersLock: true,
			}),
		);
		expect(stale.indexChanged).toBe(false);
		expect(stale.removeDeployFile).toBe(false);
		expect(stale.codeownersSource).toBe(CODEOWNERS_CLEAN);
	});

	it("preserves tab indentation", () => {
		const result = expectMigrated(
			migrateDeploymentIntent({ indexSource: TAB_INDEX, deploySource: fleetDeploy("tablecheck") }),
		);
		expect(result.indexSource).toContain(
			'\truntime: "standard",\n\tdeployment: {\n\t\thpa: {\n\t\t\tenabled: true,\n',
		);
		expect(result.indexSource).toContain(
			"\n\t\tcache: { redis: { enabled: true } },\n\t},\n\tauth:",
		);
	});

	it("is idempotent: a migrated module reports unchanged", () => {
		for (const deploySource of [
			fleetDeploy("kakaot"),
			fleetDeploy("tablecheck"),
			BROWSER_LEGACY_DEPLOY,
		]) {
			const first = expectMigrated(
				migrateDeploymentIntent({
					indexSource: LITERAL_INDEX,
					deploySource,
					codeownersSource: CODEOWNERS_WITH_BLOCK,
				}),
			);
			// The kept lock is reported on every run until it is dropped.
			expect(
				migrateDeploymentIntent({
					indexSource: first.indexSource,
					codeownersSource: first.codeownersSource,
				}),
			).toEqual({
				status: "unchanged",
				notes: [expect.stringContaining("--drop-codeowners-lock")],
			});
			const dropped = expectMigrated(
				migrateDeploymentIntent({
					indexSource: LITERAL_INDEX,
					deploySource,
					codeownersSource: CODEOWNERS_WITH_BLOCK,
					dropCodeownersLock: true,
				}),
			);
			expect(
				migrateDeploymentIntent({
					indexSource: dropped.indexSource,
					codeownersSource: dropped.codeownersSource,
					dropCodeownersLock: true,
				}),
			).toEqual({ status: "unchanged", notes: [] });
		}
	});
});

describe("migrateDeploymentIntent hardening", () => {
	it("refuses to remove a default-only key that shadows a deployment carried by a declaration spread", () => {
		const index = `${IMPORTS}
const BASE = { version: "1.0.0", deployment: { runtime: "browser" } } as const;

const buildProvider = defineProvider({
  ...BASE,
  id: "probe",
  runtime: "standard",
  deployment: { runtime: "shared" },
  auth: { mode: "none" },
  meta: providerMeta,
});

export default buildProvider({ operations });
`;
		expect(expectRefused(migrateDeploymentIntent({ indexSource: index }))).toContain(
			"expose the deployment carried by a spread",
		);
	});

	it("refuses a spread export whose other spread carries a deployment, even before the property", () => {
		const index = `${IMPORTS}
const buildProvider = defineProvider({
${DECLARATION_BODY}
});

const extras = { deployment: { runtime: "browser" } };
const provider = buildProvider({ operations });

export default { ...provider, ...extras, deployment: { cache: { redis: { enabled: true } } } };
`;
		expect(expectRefused(migrateDeploymentIntent({ indexSource: index }))).toContain(
			"also spreads an object that carries a deployment key",
		);
	});

	it("resolves an attached ./deploy import as the platform does and refuses when the readings differ", () => {
		// Attached as the key, an omitted hpa takes the profile default; as a
		// legacy file it meant disabled. The two readings disagree.
		const noHpa =
			'export default { runtime: "shared", language: "typescript", resources: { cpu: "25m", memory: "128Mi" } };\n';
		expect(
			expectRefused(
				migrateDeploymentIntent({ indexSource: IMPORT_DEPLOY_INDEX, deploySource: noHpa }),
			),
		).toContain("resolves differently");

		const explicit =
			'export default { runtime: "shared", language: "typescript", replicas: 1, hpa: { enabled: true, minReplicas: 1, maxReplicas: 1, targetCPUUtilizationPercentage: 70 }, resources: { cpu: "25m", memory: "128Mi" } };\n';
		const result = expectMigrated(
			migrateDeploymentIntent({ indexSource: IMPORT_DEPLOY_INDEX, deploySource: explicit }),
		);
		expect(result.intent).toEqual({});
		expect(result.indexSource).toContain("export default provider;");
	});

	it("refuses const-backed values that are mutated, aliased, or passed to a call", () => {
		const mutated = `const config = { runtime: "shared", language: "typescript", resources: { cpu: "25m", memory: "128Mi" } };
config.resources.memory = "512Mi";
export default config;
`;
		const read = readLegacyDeployFile(mutated);
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.reason).toContain("mutated, aliased, or passed to a call");

		const mutatedDeclaration = VARIABLE_LITERAL_INDEX.replace(
			"const buildProvider = defineProvider(declaration);",
			'declaration.deployment = { runtime: "browser" };\nconst buildProvider = defineProvider(declaration);',
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({
					indexSource: mutatedDeclaration,
					deploySource: fleetDeploy("kakaot"),
				}),
			),
		).toContain("`declaration` is mutated");

		const escapedSpread = SPREAD_ARGUMENT_INDEX.replace(
			"const buildProvider = defineProvider({",
			"Object.assign(BASE_DECLARATION, {});\n\nconst buildProvider = defineProvider({",
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({
					indexSource: escapedSpread,
					deploySource: fleetDeploy("kakaot"),
				}),
			),
		).toContain("...BASE_DECLARATION`, which is mutated");
	});

	it("removes a ./deploy import that shares its line with another statement without touching the neighbor", () => {
		const shared = IMPORT_DEPLOY_INDEX.replace(
			'import { defineProvider, type ProviderContextOf } from "@apifuse/provider-sdk/provider";\n\nimport deployment from "./deploy";\n',
			'import { defineProvider, type ProviderContextOf } from "@apifuse/provider-sdk/provider"; import deployment from "./deploy";\n',
		);
		expect(shared).not.toBe(IMPORT_DEPLOY_INDEX);
		const result = expectMigrated(
			migrateDeploymentIntent({ indexSource: shared, deploySource: fleetDeploy("tablecheck") }),
		);
		expect(result.indexSource).toContain(
			'import { defineProvider, type ProviderContextOf } from "@apifuse/provider-sdk/provider";\n',
		);
		expect(result.indexSource).not.toContain("./deploy");
		expect(parses(result.indexSource)).toBe(true);
	});

	it("tracks a type-only namespace import from ./deploy", () => {
		const index = LITERAL_INDEX.replace(
			IMPORTS,
			`${IMPORTS}import type * as Legacy from "./deploy";\n`,
		).replace(
			"export type ProviderContext",
			"export type LegacyConfig = Legacy.Config;\n\nexport type ProviderContext",
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({ indexSource: index, deploySource: fleetDeploy("kakaot") }),
			),
		).toContain("`Legacy`");
	});

	it("keeps an exported deployment const when hoisting it off the spread export", () => {
		const index = `${IMPORTS}
const buildProvider = defineProvider({
${DECLARATION_BODY}
});

export const deployment = { cache: { redis: { enabled: true } } };
const provider = buildProvider({ operations });

export default { ...provider, deployment };
`;
		const result = expectMigrated(migrateDeploymentIntent({ indexSource: index }));
		expect(result.indexSource).toContain(
			"export const deployment = { cache: { redis: { enabled: true } } };",
		);
		expect(result.indexSource).toContain("export default provider;");
		expect(result.indexSource).toContain("deployment: { cache: { redis: { enabled: true } } },");
	});
});

describe("migrateDeploymentIntent hardening (bindings and specifiers)", () => {
	const spreadExport = (extra: string, exportLiteral: string): string => `${IMPORTS}
const buildProvider = defineProvider({
${DECLARATION_BODY}
});

${extra}
const provider = buildProvider({ operations });

export default ${exportLiteral};
`;

	it("refuses a spread-export deployment const that is mutated after its initializer", () => {
		const index = spreadExport(
			"const deployment = { replicas: 2 };\ndeployment.replicas = 3;",
			"{ ...provider, deployment }",
		);
		expect(expectRefused(migrateDeploymentIntent({ indexSource: index }))).toContain(
			"`deployment` is mutated",
		);
	});

	it("refuses when the built-provider binding is mutated before the spread export", () => {
		const index = spreadExport("", "{ ...provider, deployment: { replicas: 2 } }").replace(
			"const provider = buildProvider({ operations });\n",
			"const provider = buildProvider({ operations });\nprovider.deployment = { replicas: 3 };\n",
		);
		// The mutated binding no longer counts as the built provider, so the
		// spread is an opaque object the transform cannot see into.
		expect(expectRefused(migrateDeploymentIntent({ indexSource: index }))).toContain(
			"`...provider`, which does not resolve to a top-level const object literal",
		);
	});

	it("refuses when the declaration builder binding is not an immutable top-level const", () => {
		const reassigned = spreadExport(
			"",
			"{ ...provider, deployment: { cache: { redis: { enabled: true } } } }",
		)
			.replace("const buildProvider = defineProvider({", "let buildProvider = defineProvider({")
			.replace(
				"const provider = buildProvider({ operations });",
				"buildProvider = otherBuilder;\nconst provider = buildProvider({ operations });",
			);
		// Without an immutable builder binding the spread cannot be linked to
		// the declaration, so it is an opaque object the transform refuses.
		expect(expectRefused(migrateDeploymentIntent({ indexSource: reassigned }))).toContain(
			"`...provider`, which does not resolve to a top-level const object literal",
		);
	});

	it("hoists from a single-phase spread export (provider bound to the defineProvider call itself)", () => {
		const singlePhase = `${IMPORTS}
const provider = defineProvider({
${DECLARATION_BODY}
  operations,
});

export default { ...provider, deployment: { cache: { redis: { enabled: true } } } };
`;
		const result = expectMigrated(migrateDeploymentIntent({ indexSource: singlePhase }));
		expect(result.indexSource).toContain(
			'  runtime: "standard",\n  deployment: { cache: { redis: { enabled: true } } },\n',
		);
		expect(result.indexSource).toContain("export default provider;\n");
		expect(parses(result.indexSource)).toBe(true);
	});

	it("removes the property without folding when the declaration is inlined in the spread", () => {
		const inline = `${IMPORTS}
export default {
  ...defineProvider({
${DECLARATION_BODY}
    deployment: { runtime: "shared" },
    operations,
  }),
  deployment: { runtime: "shared" },
};

export const sentinel = "keep";
`;
		const result = expectMigrated(migrateDeploymentIntent({ indexSource: inline }));
		expect(result.indexSource).toContain('export const sentinel = "keep";');
		expect(result.indexSource).not.toContain("deployment");
		expect(result.indexSource).toContain("export default {\n  ...defineProvider({");
		expect(parses(result.indexSource)).toBe(true);
	});

	it("treats member reads on the exported provider as reads (yogiyo-phone-otp shape)", () => {
		const index = `${IMPORTS}
const buildProvider = defineProvider({
${DECLARATION_BODY}
});

const provider = buildProvider({ operations });

export async function reuse(ctx: unknown) {
  return provider.operations["restaurant-full"].handler(ctx, {});
}

export default provider;
`;
		const result = expectMigrated(
			migrateDeploymentIntent({ indexSource: index, deploySource: fleetDeploy("kakaot") }),
		);
		expect(result.intent).toEqual({ cache: { redis: { enabled: true } } });
	});

	it("refuses when the provider behind `export default provider` is mutated first", () => {
		const index = `${IMPORTS}
const buildProvider = defineProvider({
${DECLARATION_BODY}
  deployment: { replicas: 1 },
});

const provider = buildProvider({ operations });
provider.deployment!.replicas = 2;

export default provider;
`;
		expect(expectRefused(migrateDeploymentIntent({ indexSource: index }))).toContain(
			"`provider` is mutated",
		);
	});

	it("refuses a defineProvider call nested in a function, where bindings can be shadowed", () => {
		const nested = `${IMPORTS}
const settings = { replicas: 1 };

function make() {
  const settings = { replicas: 3 };
  return defineProvider({
${DECLARATION_BODY}
    deployment: settings,
  });
}

export default make()({ operations });
`;
		expect(expectRefused(migrateDeploymentIntent({ indexSource: nested }))).toContain(
			"inside a function or block",
		);
	});

	it("refuses hoisting from a default export that never spreads the built provider", () => {
		const index = spreadExport(
			'const other = { id: "other" };',
			"{ ...other, deployment: { cache: { redis: { enabled: true } } } }",
		);
		expect(expectRefused(migrateDeploymentIntent({ indexSource: index }))).toContain(
			"does not spread the built provider",
		);
	});

	it("treats a legacy config placed in a dereferenced container as aliased", () => {
		const aliased = `const config = { runtime: "shared", language: "typescript", resources: { cpu: "25m", memory: "128Mi" } };
const holder = { config };
holder.config.resources.memory = "512Mi";
export default config;
`;
		const read = readLegacyDeployFile(aliased);
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.reason).toContain("`config` is mutated, aliased");

		// Nested mutation through calls is a mutation too.
		for (const mutation of [
			'Object.assign(config.resources, { memory: "512Mi" });',
			"config.network.additionalTcpPorts.push(8088);",
			"const ports = config.network.additionalTcpPorts;",
		]) {
			const nested = `const config = { runtime: "shared", language: "typescript", resources: { cpu: "25m", memory: "128Mi" }, network: { additionalTcpPorts: [] } };
${mutation}
export default config;
`;
			const read = readLegacyDeployFile(nested);
			expect(read.ok).toBe(false);
			if (!read.ok) expect(read.reason).toContain("`config` is mutated, aliased");
		}

		// A container that is itself only exported is still a read.
		const anchored = `const resources = { cpu: "25m", memory: "128Mi" };
const config = { runtime: "shared", language: "typescript", resources };
export default config;
`;
		expect(readLegacyDeployFile(anchored).ok).toBe(true);
	});

	it("matches every spelling of the deploy module in index.ts", () => {
		const dotted = IMPORT_DEPLOY_INDEX.replace('from "./deploy"', 'from "././deploy.ts"');
		const migrated = expectMigrated(
			migrateDeploymentIntent({ indexSource: dotted, deploySource: fleetDeploy("tablecheck") }),
		);
		expect(migrated.indexSource).not.toContain("deploy.ts");

		const lazy = LITERAL_INDEX.replace(
			"export default buildProvider",
			"export const lazy = () => import(`./deploy`);\n\nexport default buildProvider",
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({ indexSource: lazy, deploySource: fleetDeploy("kakaot") }),
			),
		).toContain("still references the ./deploy module");

		const importEquals = LITERAL_INDEX.replace(
			IMPORTS,
			`${IMPORTS}import legacy = require("./deploy");\n`,
		);
		expect(
			expectRefused(
				migrateDeploymentIntent({ indexSource: importEquals, deploySource: fleetDeploy("kakaot") }),
			),
		).toContain("still references the ./deploy module");
	});
});

describe("findDeployModuleConsumers", () => {
	it("finds imports of the deploy module from nested sources and ignores look-alikes", () => {
		const consumers = findDeployModuleConsumers("/repo", [
			{ path: "__tests__/ready-promotion.test.ts", text: 'import deployment from "../deploy";\n' },
			{
				path: "operations/search.ts",
				text: 'import { helper } from "./deploy-helpers";\nexport const x = 1;\n',
			},
			{ path: "scripts/check.ts", text: 'const legacy = await import("../deploy.ts");\n' },
			{ path: "lib/types.ts", text: 'export type Config = import("../deploy").default;\n' },
			{ path: "other.ts", text: 'import x from "./deployments/deploy";\n' },
			{ path: "legacy/bridge.ts", text: 'import deployment = require("../deploy");\n' },
			{ path: "legacy/template.ts", text: "const m = await import(`../deploy`);\n" },
		]);
		expect(consumers).toEqual([
			"__tests__/ready-promotion.test.ts",
			"legacy/bridge.ts",
			"legacy/template.ts",
			"lib/types.ts",
			"scripts/check.ts",
		]);
	});

	it("matches under a root whose path carries an extension-like segment, and in JSX sources", () => {
		expect(
			findDeployModuleConsumers("/srv/provider.ts", [
				{ path: "__tests__/probe.test.ts", text: 'import deployment from "../deploy.ts";\n' },
				{
					path: "ui/panel.jsx",
					text: 'import deployment from "../deploy";\nexport const P = () => <div />;\n',
				},
				{ path: "ui/other.tsx", text: 'import x from "../deploy-helpers";\n' },
			]),
		).toEqual(["__tests__/probe.test.ts", "ui/panel.jsx"]);
	});
});

describe("findSpreadExportDeploymentProperty", () => {
	it("locates a deployment extra on a spread default export and ignores declaration keys", () => {
		const exportLine = (code: string): number =>
			code.split("\n").findIndex((line) => line.startsWith("export default")) + 1;
		expect(findSpreadExportDeploymentProperty(IMPORT_DEPLOY_INDEX)).toEqual({
			line: exportLine(IMPORT_DEPLOY_INDEX),
		});
		expect(findSpreadExportDeploymentProperty(SPREAD_EXPORT_INDEX)).toEqual({
			line: exportLine(SPREAD_EXPORT_INDEX) + 2,
		});
		expect(findSpreadExportDeploymentProperty(LITERAL_INDEX)).toBeUndefined();
		expect(findSpreadExportDeploymentProperty(EXISTING_KEY_INDEX)).toBeUndefined();
	});
});

describe("fleet deploy.ts fixtures (91 repositories)", () => {
	it("parses every fleet file under the legacy contract", () => {
		expect(FLEET).toHaveLength(91);
		for (const { id, deploySource } of FLEET) {
			const legacy = readLegacyDeployFile(deploySource);
			if (!legacy.ok) throw new Error(`${id}: ${legacy.reason}`);
		}
	});

	it("collapses to the measured end-state distribution", () => {
		const buckets = new Map<string, string[]>();
		for (const { id, deploySource } of FLEET) {
			const intent = subtractDeploymentDefaults(legacyOf(deploySource));
			const signature = Object.keys(intent).sort().join("+") || "(none)";
			buckets.set(signature, [...(buckets.get(signature) ?? []), id]);
		}
		const counts = Object.fromEntries(
			[...buckets.entries()].map(([key, ids]) => [key, ids.length]),
		);
		expect(counts).toEqual({
			"(none)": 40,
			cache: 21,
			"hpa+resources": 10,
			resources: 7,
			"cache+resources": 5,
			"cache+hpa+resources": 3,
			"cache+network": 2,
			"cache+runtime": 1,
			network: 1,
			runtime: 1,
		});
		expect(buckets.get("runtime")).toEqual(["triple"]);
		expect(buckets.get("cache+runtime")).toEqual(["catchtable"]);
		expect(buckets.get("network")).toEqual(["korea-parcel-tracking"]);
		expect(buckets.get("cache+network")).toEqual(["seoul-bike", "seoul-density"]);
		// The six hand-edited "generated" mirrors keep their live values.
		expect(buckets.get("resources")).toEqual([
			"ekitan",
			"google-flights",
			"hyundai-card",
			"jalan",
			"korea-corporate-info",
			"shinhan-bank",
			"suumo",
		]);
	});

	it("round-trips every fleet file: the written key resolves to the legacy view and re-runs are unchanged", () => {
		let zeroConfig = 0;
		for (const { id, deploySource } of FLEET) {
			const legacy = legacyOf(deploySource);
			const result = migrateDeploymentIntent({
				indexSource: LITERAL_INDEX,
				deploySource,
				codeownersSource: CODEOWNERS_WITH_BLOCK,
			});
			if (result.status !== "migrated") {
				throw new Error(
					`${id}: ${result.status} ${result.status === "refused" ? result.reason : ""}`,
				);
			}
			if (!parses(result.indexSource)) throw new Error(`${id}: output does not parse`);
			if (!deploymentIntentsEquivalent(resolveDeclared(result.indexSource), legacy)) {
				throw new Error(`${id}: written key does not resolve to the legacy deployment`);
			}
			if (!deploymentIntentsEquivalent(result.resolved, legacy))
				throw new Error(`${id}: reported view drifted`);
			if (Object.keys(result.intent).length === 0) {
				zeroConfig += 1;
				if (result.indexSource !== LITERAL_INDEX)
					throw new Error(`${id}: zero-config repo had index.ts edited`);
			}
			const again = migrateDeploymentIntent({
				indexSource: result.indexSource,
				codeownersSource: result.codeownersSource,
			});
			if (again.status !== "unchanged")
				throw new Error(`${id}: second run reported ${again.status}`);
		}
		expect(zeroConfig).toBe(40);
	});
});

/**
 * Opt-in: run against a local checkout of every provider repository
 * (`APIFUSE_FLEET_SNAPSHOT_DIR=<dir with <id>/index.ts>`). Exercises the
 * real index.ts declaration shapes, which are too large to vendor here.
 */
const snapshotDir = process.env.APIFUSE_FLEET_SNAPSHOT_DIR;
describe.skipIf(snapshotDir === undefined)("fleet snapshot (APIFUSE_FLEET_SNAPSHOT_DIR)", () => {
	it("migrates every repository except the factory-built declaration", () => {
		if (snapshotDir === undefined) return;
		const refused: string[] = [];
		let migrated = 0;
		for (const id of readdirSync(snapshotDir).sort()) {
			const dir = join(snapshotDir, id);
			if (!existsSync(join(dir, "index.ts"))) continue;
			const read = (name: string): string | undefined =>
				existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : undefined;
			const indexSource = read("index.ts");
			if (indexSource === undefined) continue;
			const deploySource = read("deploy.ts");
			const result = migrateDeploymentIntent({
				indexSource,
				deploySource,
				codeownersSource: read(".github/CODEOWNERS"),
			});
			if (result.status === "refused") {
				refused.push(id);
				continue;
			}
			if (result.status !== "migrated") throw new Error(`${id}: unexpected ${result.status}`);
			if (!parses(result.indexSource)) throw new Error(`${id}: output does not parse`);
			if (deploySource !== undefined) {
				const legacy = legacyOf(deploySource);
				if (!deploymentIntentsEquivalent(resolveDeclared(result.indexSource), legacy)) {
					throw new Error(`${id}: written key does not resolve to the legacy deployment`);
				}
			}
			const again = migrateDeploymentIntent({
				indexSource: result.indexSource,
				codeownersSource: result.codeownersSource,
			});
			if (again.status !== "unchanged")
				throw new Error(`${id}: second run reported ${again.status}`);
			migrated += 1;
		}
		expect(refused).toEqual(["tabelog"]);
		expect(migrated).toBe(90);
	}, 120_000);
});

// Type-level guard: the emitted key is the SDK's authored contract.
const _typeCheck: ProviderDeploymentOverrides = subtractDeploymentDefaults(
	resolveDeploymentIntent(),
);
void _typeCheck;
