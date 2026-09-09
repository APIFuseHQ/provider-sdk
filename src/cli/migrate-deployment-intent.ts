import path from "node:path";

import type TS from "typescript";

import type { ProviderDeploymentOverrides } from "../types.js";
import {
	DEPLOYMENT_INTENT_FIELD_ORDER,
	deepEqual,
	deploymentIntentsEquivalent,
	normalizeLegacyDeployment,
	parseDeploymentIntent,
	type ResolvedDeploymentIntent,
	resolveDeploymentIntent,
	subtractDeploymentDefaults,
} from "./deployment-intent.js";

export const TYPESCRIPT_REQUIRED_MESSAGE =
	"apifuse migrate-deployment requires typescript; install it in the workspace running the CLI (bun add -d typescript)";

const ts: typeof import("typescript") = await loadTypeScript();

/**
 * Throws (rather than exiting) when the compiler is missing so importers can
 * decide: the migrate command reports and exits, `apifuse check` skips its
 * source-shape inspection.
 */
async function loadTypeScript(): Promise<typeof import("typescript")> {
	try {
		return await import("typescript");
	} catch (error) {
		throw new Error(TYPESCRIPT_REQUIRED_MESSAGE, { cause: error });
	}
}

/**
 * Deployment-intent migration: retire a provider repository's standalone
 * `deploy.ts`.
 *
 * End state: deployment intent lives only in the `deployment` key of the
 * `defineProvider({...})` declaration, and only the fields that differ from
 * the runtime profile are written. Everything else goes: the `deploy.ts`
 * file, a `deployment` extra on a `{ ...provider, deployment }` default
 * export, and an `import deployment from "./deploy"`. The `/deploy.ts`
 * CODEOWNERS lock is kept by default: the platform still honors a committed
 * legacy file until its fallback is retired, so re-adding one must keep
 * needing operator review. `dropCodeownersLock` removes it once that
 * fallback is gone.
 *
 * The transform never regenerates values from the profile — it moves the
 * values the file actually declares (hand-edited "mirrors" exist in the
 * fleet) and proves equivalence: the key it writes must resolve to exactly
 * what the legacy file resolved to, or it refuses. Like the other codemods
 * it is conservative: anything it cannot fully account for is reported as
 * `refused` with a reason rather than partially migrated.
 */

/** How the `defineProvider()` declaration literal was located. */
export type DeploymentDeclarationShape =
	/** `defineProvider({ ... })` — the literal is the argument (spreads inside are fine). */
	| "literal-argument"
	/** `const declaration = { ... }; defineProvider(declaration)` — top-level const literal. */
	| "variable-literal-argument";

export interface DeploymentIntentMigrationInput {
	/** Current `index.ts` text. */
	readonly indexSource: string;
	/** Current `deploy.ts` text, or undefined when the repository has none. */
	readonly deploySource?: string;
	/** Current `.github/CODEOWNERS` text, or undefined when absent. */
	readonly codeownersSource?: string;
	/**
	 * Remove the `/deploy.ts` CODEOWNERS lock (and the scaffold's TEMPORARY
	 * comment above it). Off by default — see the module comment.
	 */
	readonly dropCodeownersLock?: boolean;
	readonly indexFileName?: string;
}

export type DeploymentIntentMigration =
	| {
			readonly status: "migrated";
			readonly shape: DeploymentDeclarationShape;
			readonly indexSource: string;
			readonly indexChanged: boolean;
			readonly codeownersSource?: string;
			readonly codeownersChanged: boolean;
			/** True when `deploy.ts` existed and must be deleted. */
			readonly removeDeployFile: boolean;
			/** Resolved view the legacy `deploy.ts` declared, when it existed. */
			readonly legacy?: ResolvedDeploymentIntent;
			/** The minimal key now authored in the declaration (empty = profile defaults). */
			readonly intent: ProviderDeploymentOverrides;
			/** What the key resolves to; equals `legacy` when a legacy file existed. */
			readonly resolved: ResolvedDeploymentIntent;
			readonly notes: readonly string[];
	  }
	| {
			readonly status: "unchanged";
			readonly notes: readonly string[];
	  }
	| {
			readonly status: "refused";
			readonly reason: string;
	  };

const DEPLOYMENT_PROPERTY_NAME = "deployment";
/** index.ts sits at the repository root; the deploy module is its sibling. */
const INDEX_VIRTUAL_DIRECTORY = "/";
const DEPLOY_MODULE_VIRTUAL_PATH = "/deploy";
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const LINE_WIDTH = 80;
/**
 * Emitted above the key only when it carries `runtime`: the deployment
 * runtime axis sits next to the execution `runtime` property and must not
 * be read as the same axis.
 */
export const DEPLOYMENT_RUNTIME_AXIS_COMMENT =
	"// Deployment runtime axis (shared | dedicated | browser); not the execution runtime above.";

/** CODEOWNERS block the platform scaffold emitted for the mirror; removed verbatim only. */
const CODEOWNERS_MIRROR_COMMENT = [
	"# Platform-generated deployment mirror (TEMPORARY until the SDK deployment",
	"# passthrough lands): deployment intent is platform-owned, so changes to the",
	"# generated deploy.ts require operator review.",
];
const CODEOWNERS_DEPLOY_LINE = /^\/deploy\.ts(?:\s|$)/;

export function migrateDeploymentIntent(
	input: DeploymentIntentMigrationInput,
): DeploymentIntentMigration {
	const notes: string[] = [];
	const fileName = input.indexFileName ?? "index.ts";
	const source = parseSource(fileName, input.indexSource);
	const syntaxError = firstSyntaxError(source);
	if (syntaxError !== undefined) {
		return { status: "refused", reason: `index.ts does not parse: ${syntaxError}` };
	}

	let codeowners: { readonly text: string; readonly changed: boolean } | undefined;
	if (input.codeownersSource !== undefined) {
		const stripped = stripCodeownersDeployLock(input.codeownersSource);
		if (input.dropCodeownersLock === true) {
			codeowners = stripped;
		} else {
			codeowners = { text: input.codeownersSource, changed: false };
			if (stripped.changed) {
				notes.push(
					"Kept the /deploy.ts CODEOWNERS entry: the platform still honors a re-added deploy.ts until its legacy fallback is retired; re-run with --drop-codeowners-lock after that.",
				);
			}
		}
	}

	// ── Legacy file
	let legacy: ResolvedDeploymentIntent | undefined;
	let legacyRaw: unknown;
	if (input.deploySource !== undefined) {
		const parsed = readLegacyDeployFile(input.deploySource);
		if (!parsed.ok) return { status: "refused", reason: parsed.reason };
		legacy = parsed.value;
		legacyRaw = parsed.raw;
	}

	// ── Declaration literal
	const calls = collectDefineProviderCalls(source);
	if (calls.length === 0) {
		return {
			status: "refused",
			reason: "No defineProvider(...) call found; this file does not declare a provider.",
		};
	}
	if (calls.length > 1) {
		return {
			status: "refused",
			reason: `Found ${calls.length} defineProvider(...) calls; the transform rewrites exactly one declaration.`,
		};
	}
	const call = calls[0];
	if (call === undefined)
		return { status: "refused", reason: "Internal: defineProvider call vanished." };
	if (!isTopLevelNode(call)) {
		return {
			status: "refused",
			reason:
				"defineProvider(...) is called inside a function or block; the transform only rewrites a top-level declaration, where bindings cannot be shadowed.",
		};
	}
	const located = locateDeclarationLiteral(source, call);
	if (located.status === "refused") return located;
	const { literal: declaration, shape } = located;

	// ── Existing key inside the declaration
	const existingProperty = resolveDeclarationDeployment(declaration, source);
	if (existingProperty.status === "refused") return existingProperty;
	let existingIntent: ProviderDeploymentOverrides | undefined;
	let existingResolved: ResolvedDeploymentIntent | undefined;
	let existingOpaque = false;
	if (existingProperty.property !== undefined) {
		const evaluated = evaluateStatic(existingProperty.property.initializer, source);
		if (evaluated.ok) {
			const parsedIntent = parseDeploymentIntent(evaluated.value);
			if (!parsedIntent.ok) {
				return {
					status: "refused",
					reason: `The declaration's deployment key is invalid: ${parsedIntent.reason}`,
				};
			}
			existingIntent = parsedIntent.value;
			try {
				existingResolved = resolveDeploymentIntent(existingIntent);
			} catch (error) {
				return {
					status: "refused",
					reason: `The declaration's deployment key does not resolve: ${describeError(error)}`,
				};
			}
		} else {
			existingOpaque = true;
		}
	}

	// ── Default-export spread carrying `deployment`
	const spread = analyzeSpreadExport(source, call, builderVariableName(call, source));
	if (spread.status === "refused") return spread;
	const deployImports = collectLegacyDeployImports(source);
	if (deployImports.status === "refused") return deployImports;

	let spreadResolved: ResolvedDeploymentIntent | undefined;
	if (spread.deploymentProperty !== undefined) {
		const valueNode = spread.deploymentProperty.value;
		if (valueNode.kind === "deploy-import") {
			if (legacy === undefined) {
				return {
					status: "refused",
					reason:
						"index.ts imports the default export of ./deploy but deploy.ts is missing; restore the file or remove the import first.",
				};
			}
			// The platform reads the attached object as the deployment KEY
			// (omitted fields resolve to profile defaults), not as a legacy
			// file (omitted hpa meant disabled). Resolve it the way the platform
			// does and require agreement with the legacy reading before the
			// file that satisfies both is deleted.
			const asKey = parseDeploymentIntent(legacyRaw);
			if (!asKey.ok) {
				return {
					status: "refused",
					reason: `deploy.ts is attached as the default export's deployment key but is not a valid key: ${asKey.reason}`,
				};
			}
			try {
				spreadResolved = resolveDeploymentIntent(asKey.value);
			} catch (error) {
				return {
					status: "refused",
					reason: `deploy.ts, attached as the default export's deployment key, does not resolve: ${describeError(error)}`,
				};
			}
			if (!deploymentIntentsEquivalent(spreadResolved, legacy)) {
				return {
					status: "refused",
					reason:
						"deploy.ts resolves differently as the attached deployment key (omitted fields take profile defaults) than as a legacy file (omitted hpa is disabled); make the file explicit by hand before migrating.",
				};
			}
		} else {
			const parsedIntent = parseDeploymentIntent(valueNode.value);
			if (!parsedIntent.ok) {
				return {
					status: "refused",
					reason: `The default export's deployment property is invalid: ${parsedIntent.reason}`,
				};
			}
			try {
				spreadResolved = resolveDeploymentIntent(parsedIntent.value);
			} catch (error) {
				return {
					status: "refused",
					reason: `The default export's deployment property does not resolve: ${describeError(error)}`,
				};
			}
		}
	} else if (deployImports.defaultImport !== undefined) {
		return {
			status: "refused",
			reason:
				"index.ts imports ./deploy but does not attach it as `deployment` on the default export; the transform cannot tell how the value is used.",
		};
	}

	// ── Which resolved view is authoritative
	if (existingOpaque && (legacy !== undefined || spreadResolved !== undefined)) {
		return {
			status: "refused",
			reason:
				"The declaration already carries a deployment key that is not a static literal, so it cannot be compared with the legacy deploy.ts value.",
		};
	}
	if (
		existingResolved !== undefined &&
		spreadResolved !== undefined &&
		!deploymentIntentsEquivalent(existingResolved, spreadResolved)
	) {
		return {
			status: "refused",
			reason:
				"The declaration's deployment key and the default export's deployment property resolve to different deployments; reconcile them by hand.",
		};
	}
	const keyResolved = spreadResolved ?? existingResolved;
	if (
		legacy !== undefined &&
		keyResolved !== undefined &&
		!deploymentIntentsEquivalent(keyResolved, legacy)
	) {
		return {
			status: "refused",
			reason:
				"deploy.ts and the authored deployment key resolve to different deployments (the key is authoritative for the platform); reconcile them by hand before deleting the file.",
		};
	}
	const target = keyResolved ?? legacy;

	if (target === undefined) {
		// Nothing to move: no deploy.ts, no key to hoist. Only the CODEOWNERS
		// lock on a file that no longer exists may still need cleanup.
		if (existingOpaque) {
			notes.push(
				"The declaration's deployment key is not a static literal; it was left untouched.",
			);
		}
		if (codeowners?.changed) {
			return {
				status: "migrated",
				shape,
				indexSource: input.indexSource,
				indexChanged: false,
				codeownersSource: codeowners.text,
				codeownersChanged: true,
				removeDeployFile: false,
				intent: {},
				resolved: resolveDeploymentIntent(),
				notes,
			};
		}
		return { status: "unchanged", notes };
	}

	const intent = subtractDeploymentDefaults(target);
	const resolved = resolveDeploymentIntent(intent);
	if (!deploymentIntentsEquivalent(resolved, target)) {
		return {
			status: "refused",
			reason:
				"Internal: the minimal deployment key does not resolve back to the declared deployment; refusing to write it.",
		};
	}

	// ── Edits
	const edits: TextEdit[] = [];
	if (existingProperty.property !== undefined) {
		if (existingIntent === undefined || !deepEqual(existingIntent, intent)) {
			if (Object.keys(intent).length === 0) {
				if (existingProperty.spreadCarriesDeployment === true) {
					return {
						status: "refused",
						reason:
							"The declaration's deployment key only restates profile defaults, but removing it would expose the deployment carried by a spread in the same literal; reconcile the spread by hand first.",
					};
				}
				edits.push(removeObjectProperty(existingProperty.property, declaration, source));
				notes.push("Removed a deployment key that only restated profile defaults.");
			} else {
				const indent = lineIndentation(source, existingProperty.property.getStart(source));
				const unit = indentUnitFor(source, declaration, indent);
				edits.push({
					start: existingProperty.property.initializer.getStart(source),
					end: existingProperty.property.initializer.getEnd(),
					text: formatIntentLiteral(intent, indent, unit),
				});
				notes.push("Rewrote the deployment key to the minimal (profile-subtracted) form.");
			}
		}
	} else if (Object.keys(intent).length > 0) {
		edits.push(insertDeploymentProperty(declaration, intent, source));
	}

	if (spread.deploymentProperty !== undefined) {
		edits.push(...removeSpreadDeploymentProperty(spread, declaration, source));
		const valueNode = spread.deploymentProperty.value;
		if (
			valueNode.kind === "const" &&
			countIdentifierReferences(source, valueNode.name) === 1 &&
			!hasExportModifier(valueNode.statement)
		) {
			edits.push(removeStatement(valueNode.statement, source));
		}
	}
	for (const statement of deployImports.removable) {
		edits.push(removeStatement(statement, source));
	}

	if (editsOverlap(edits)) {
		return {
			status: "refused",
			reason: "Internal: the planned source edits overlap; refusing to emit a partial migration.",
		};
	}
	const output = applyEdits(input.indexSource, edits);
	const verified = parseSource(fileName, output);
	const outputError = firstSyntaxError(verified);
	if (outputError !== undefined) {
		return {
			status: "refused",
			reason: `Transform produced source that does not parse (${outputError}); refusing to emit a partial migration.`,
		};
	}
	if (deployImports.defaultImport !== undefined) {
		const remaining = countIdentifierReferences(verified, deployImports.defaultImport);
		if (remaining > 0) {
			return {
				status: "refused",
				reason: `\`${deployImports.defaultImport}\` (imported from ./deploy) is still referenced after removing the default-export property; the transform cannot delete deploy.ts.`,
			};
		}
	}
	for (const typeName of deployImports.typeOnlyNames) {
		if (countIdentifierReferences(verified, typeName) > 0) {
			return {
				status: "refused",
				reason: `index.ts still uses \`${typeName}\`, a type imported from ./deploy, after the import is removed; deploy.ts is being deleted, so replace it (for example with \`ProviderDeploymentOverrides\` from @apifuse/provider-sdk) by hand before migrating.`,
			};
		}
	}
	if (referencesLegacyDeployModule(verified)) {
		return {
			status: "refused",
			reason:
				"index.ts still references the ./deploy module after the transform; remove that usage by hand.",
		};
	}

	const indexChanged = output !== input.indexSource;
	const removeDeployFile = input.deploySource !== undefined;
	if (!indexChanged && !removeDeployFile && !codeowners?.changed) {
		return { status: "unchanged", notes };
	}
	return {
		status: "migrated",
		shape,
		indexSource: output,
		indexChanged,
		...(codeowners === undefined ? {} : { codeownersSource: codeowners.text }),
		codeownersChanged: codeowners?.changed ?? false,
		removeDeployFile,
		...(legacy === undefined ? {} : { legacy }),
		intent,
		resolved,
		notes,
	};
}

/**
 * Statically read the `deployment` key authored inside the declaration
 * literal of `indexSource` (undefined when absent). Used to prove round
 * trips: the value the transform wrote must resolve to the legacy view.
 */
export function readDeclaredDeploymentIntent(
	indexSource: string,
	fileName = "index.ts",
):
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly reason: string } {
	const source = parseSource(fileName, indexSource);
	const calls = collectDefineProviderCalls(source);
	const call = calls[0];
	if (calls.length !== 1 || call === undefined) {
		return { ok: false, reason: `expected exactly one defineProvider call, found ${calls.length}` };
	}
	const located = locateDeclarationLiteral(source, call);
	if (located.status === "refused") return { ok: false, reason: located.reason };
	const property = resolveDeclarationDeployment(located.literal, source);
	if (property.status === "refused") return { ok: false, reason: property.reason };
	if (property.property === undefined) return { ok: true, value: undefined };
	return evaluateStatic(property.property.initializer, source);
}

/**
 * Line (1-based) of a `deployment` property attached to a spread default
 * export (`export default { ...provider, deployment }`), or undefined when
 * the module has no such legacy surface. Used by `apifuse check`: the loaded
 * module cannot tell that extra apart from a declaration-level key, so the
 * source shape is inspected instead.
 */
export function findSpreadExportDeploymentProperty(
	indexSource: string,
	fileName = "index.ts",
): { readonly line: number } | undefined {
	const source = parseSource(fileName, indexSource);
	const exportAssignment = findDefaultExport(source);
	if (exportAssignment === undefined) return undefined;
	const exported = unwrapExpression(exportAssignment.expression);
	if (!ts.isObjectLiteralExpression(exported)) return undefined;
	if (!exported.properties.some(ts.isSpreadAssignment)) return undefined;
	for (const property of exported.properties) {
		if (ts.isSpreadAssignment(property)) continue;
		const name = property.name;
		if (name === undefined) continue;
		let text: string | undefined;
		if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) text = name.text;
		else if (ts.isComputedPropertyName(name)) {
			const inner = unwrapExpression(name.expression);
			if (ts.isStringLiteralLike(inner)) text = inner.text;
		}
		if (text === DEPLOYMENT_PROPERTY_NAME) {
			return { line: source.getLineAndCharacterOfPosition(property.getStart(source)).line + 1 };
		}
	}
	return undefined;
}

/** Parse a legacy `deploy.ts` module text into the resolved deployment view. */
export function readLegacyDeployFile(
	deploySource: string,
):
	| { readonly ok: true; readonly value: ResolvedDeploymentIntent; readonly raw: unknown }
	| { readonly ok: false; readonly reason: string } {
	const source = parseSource("deploy.ts", deploySource);
	const syntaxError = firstSyntaxError(source);
	if (syntaxError !== undefined) {
		return { ok: false, reason: `deploy.ts does not parse: ${syntaxError}` };
	}
	const exportAssignment = findDefaultExport(source);
	if (exportAssignment === undefined) {
		return {
			ok: false,
			reason: "deploy.ts has no `export default`; the transform cannot read its deployment config.",
		};
	}
	const evaluated = evaluateStatic(exportAssignment.expression, source);
	if (!evaluated.ok) {
		return {
			ok: false,
			reason: `deploy.ts default export is not a static literal: ${evaluated.reason}`,
		};
	}
	const normalized = normalizeLegacyDeployment(evaluated.value);
	if (!normalized.ok) return normalized;
	return { ok: true, value: normalized.value, raw: evaluated.value };
}

/**
 * Repository sources (other than index.ts and deploy.ts themselves) that
 * import the deploy module — `import x from "../deploy"`, re-exports, dynamic
 * `import("./deploy")`, `require("./deploy")`. Deleting deploy.ts while one
 * exists breaks that consumer, so the command refuses until it is removed.
 * `files` carry paths relative to or absolute under `providerRoot`.
 */
export function findDeployModuleConsumers(
	providerRoot: string,
	files: readonly { readonly path: string; readonly text: string }[],
): string[] {
	const deployModule = path.resolve(providerRoot, "deploy");
	const consumers: string[] = [];
	for (const file of files) {
		const absolute = path.resolve(providerRoot, file.path);
		const source = parseSource(absolute, file.text);
		if (sourceImportsModule(source, path.dirname(absolute), deployModule)) {
			consumers.push(path.relative(providerRoot, absolute));
		}
	}
	return consumers.sort();
}

/**
 * Remove the `/deploy.ts` CODEOWNERS line and, when it is preceded by the
 * exact platform-scaffold comment block, that block too. Any other content
 * is preserved byte for byte.
 */
export function stripCodeownersDeployLock(text: string): {
	readonly text: string;
	readonly changed: boolean;
} {
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(newline);
	const output: string[] = [];
	let changed = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!CODEOWNERS_DEPLOY_LINE.test(line)) {
			output.push(line);
			continue;
		}
		changed = true;
		const commentStart = output.length - CODEOWNERS_MIRROR_COMMENT.length;
		if (
			commentStart >= 0 &&
			CODEOWNERS_MIRROR_COMMENT.every(
				(expected, offset) => output[commentStart + offset] === expected,
			)
		) {
			output.splice(commentStart, CODEOWNERS_MIRROR_COMMENT.length);
		}
	}
	return { text: changed ? output.join(newline) : text, changed };
}

// ── Declaration location ───────────────────────────────────────────────────

type DeclarationLocation =
	| {
			readonly status: "ok";
			readonly literal: TS.ObjectLiteralExpression;
			readonly shape: DeploymentDeclarationShape;
	  }
	| { readonly status: "refused"; readonly reason: string };

function locateDeclarationLiteral(
	source: TS.SourceFile,
	call: TS.CallExpression,
): DeclarationLocation {
	const argument = call.arguments[0];
	if (argument === undefined) {
		return {
			status: "refused",
			reason: "defineProvider() is called without a declaration argument.",
		};
	}
	const unwrapped = unwrapExpression(argument);
	if (ts.isObjectLiteralExpression(unwrapped)) {
		return { status: "ok", literal: unwrapped, shape: "literal-argument" };
	}
	if (ts.isIdentifier(unwrapped)) {
		const declaration = findTopLevelConst(source, unwrapped.text);
		if (declaration?.initializer !== undefined) {
			const initializer = unwrapExpression(declaration.initializer);
			if (ts.isObjectLiteralExpression(initializer)) {
				if (!identifierUsesAreReadOnly(source, unwrapped.text)) {
					return {
						status: "refused",
						reason: `\`${unwrapped.text}\` is mutated, aliased, or passed to a call after its initializer, so the transform cannot prove the literal is the effective declaration.`,
					};
				}
				return { status: "ok", literal: initializer, shape: "variable-literal-argument" };
			}
		}
		return {
			status: "refused",
			reason: `defineProvider(${unwrapped.text}) is called with a variable whose initializer is not a top-level const object literal, so the transform cannot place the deployment key.`,
		};
	}
	return {
		status: "refused",
		reason:
			"defineProvider(...) is called with a non-literal argument, so the transform cannot place the deployment key.",
	};
}

type NamedPropertyLookup =
	| {
			readonly status: "ok";
			readonly property: TS.PropertyAssignment | undefined;
			/** A spread in the literal statically carries a `deployment` key (shadowed by `property`). */
			readonly spreadCarriesDeployment?: boolean;
	  }
	| { readonly status: "refused"; readonly reason: string };

/**
 * The declaration literal's effective `deployment` property. Object literals
 * are last-wins, so spreads inside the literal are inspected statically: a
 * spread that resolves to a top-level const object literal is scanned
 * (recursively) for a `deployment` key; anything the transform cannot inspect
 * is refused because it cannot prove the spread carries no deployment. A
 * deployment-bearing spread that is the last contributor — or the only one —
 * refuses too, since inserting or rewriting a plain property would not change
 * (or would silently change) the effective deployment.
 */
function resolveDeclarationDeployment(
	literal: TS.ObjectLiteralExpression,
	source: TS.SourceFile,
): NamedPropertyLookup {
	let explicit: TS.PropertyAssignment | undefined;
	let lastSource: "explicit" | "spread" | undefined;
	let lastSpreadText = "";
	let anySpreadCarries = false;
	for (const property of literal.properties) {
		if (ts.isSpreadAssignment(property)) {
			const scan = spreadCarriesDeployment(property.expression, source, new Set());
			if (scan.status === "refused") {
				return { status: "refused", reason: `The declaration spreads ${scan.reason}` };
			}
			if (scan.carries) {
				anySpreadCarries = true;
				lastSource = "spread";
				lastSpreadText = property.expression.getText(source);
			}
			continue;
		}
		const named = matchDeploymentProperty(property, "declaration");
		if (named.status === "refused") return named;
		if (named.property === undefined) continue;
		if (explicit !== undefined) {
			return {
				status: "refused",
				reason: "The declaration declares `deployment` more than once; keep a single property.",
			};
		}
		explicit = named.property;
		lastSource = "explicit";
	}
	if (lastSource === "spread") {
		return {
			status: "refused",
			reason: `The declaration receives its deployment key through \`...${lastSpreadText}\`; hoist that key into a plain \`deployment\` property by hand before migrating.`,
		};
	}
	return { status: "ok", property: explicit, spreadCarriesDeployment: anySpreadCarries };
}

/**
 * Match one non-spread object-literal element against the `deployment`
 * name. Only a plain `deployment: <expr>` assignment can be rewritten;
 * shorthand, accessor, method, and computed spellings refuse.
 */
function matchDeploymentProperty(
	property: TS.ObjectLiteralElementLike,
	context: string,
): NamedPropertyLookup {
	const propertyName = property.name;
	if (propertyName === undefined) return { status: "ok", property: undefined };
	if (ts.isComputedPropertyName(propertyName)) {
		const inner = unwrapExpression(propertyName.expression);
		if (ts.isStringLiteralLike(inner)) {
			if (inner.text !== DEPLOYMENT_PROPERTY_NAME) return { status: "ok", property: undefined };
			return {
				status: "refused",
				reason: `The ${context} spells \`${DEPLOYMENT_PROPERTY_NAME}\` as a computed property name; write it as a plain property first.`,
			};
		}
		return {
			status: "refused",
			reason: `The ${context} carries a computed property whose name is not static; it could evaluate to \`${DEPLOYMENT_PROPERTY_NAME}\`, so the transform refuses.`,
		};
	}
	if (!(ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName))) {
		return { status: "ok", property: undefined };
	}
	if (propertyName.text !== DEPLOYMENT_PROPERTY_NAME) return { status: "ok", property: undefined };
	if (ts.isPropertyAssignment(property)) return { status: "ok", property };
	return {
		status: "refused",
		reason: `The ${context}'s \`${DEPLOYMENT_PROPERTY_NAME}\` property is a ${ts.isShorthandPropertyAssignment(property) ? "shorthand" : "method or accessor"} form the transform cannot rewrite.`,
	};
}

type SpreadScan =
	| { readonly status: "ok"; readonly carries: boolean }
	| { readonly status: "refused"; readonly reason: string };

/** Whether a spread expression statically resolves to an object that owns a `deployment` key. */
function spreadCarriesDeployment(
	expression: TS.Expression,
	source: TS.SourceFile,
	seen: Set<string>,
): SpreadScan {
	const expr = unwrapExpression(expression);
	if (ts.isObjectLiteralExpression(expr)) return objectCarriesDeployment(expr, source, seen);
	if (ts.isIdentifier(expr)) {
		if (seen.has(expr.text)) {
			return {
				status: "refused",
				reason: `\`...${expr.text}\`, which is defined in terms of itself.`,
			};
		}
		const declaration = findTopLevelConst(source, expr.text);
		if (declaration?.initializer !== undefined) {
			const initializer = unwrapExpression(declaration.initializer);
			if (ts.isObjectLiteralExpression(initializer)) {
				if (!identifierUsesAreReadOnly(source, expr.text)) {
					return {
						status: "refused",
						reason: `\`...${expr.text}\`, which is mutated, aliased, or passed to a call after its initializer, so the transform cannot prove what it carries.`,
					};
				}
				const next = new Set(seen);
				next.add(expr.text);
				return objectCarriesDeployment(initializer, source, next);
			}
		}
		return {
			status: "refused",
			reason: `\`...${expr.text}\`, which does not resolve to a top-level const object literal, so the transform cannot prove it carries no \`deployment\` key.`,
		};
	}
	return {
		status: "refused",
		reason: `\`...${expr.getText(source)}\`, which is not a statically inspectable object, so the transform cannot prove it carries no \`deployment\` key.`,
	};
}

function objectCarriesDeployment(
	literal: TS.ObjectLiteralExpression,
	source: TS.SourceFile,
	seen: Set<string>,
): SpreadScan {
	let carries = false;
	for (const property of literal.properties) {
		if (ts.isSpreadAssignment(property)) {
			const nested = spreadCarriesDeployment(property.expression, source, seen);
			if (nested.status === "refused") return nested;
			carries = carries || nested.carries;
			continue;
		}
		const name = property.name;
		if (name === undefined) continue;
		if (ts.isComputedPropertyName(name)) {
			const inner = unwrapExpression(name.expression);
			if (!ts.isStringLiteralLike(inner)) {
				return {
					status: "refused",
					reason: `an object with a computed property name that is not static, so the transform cannot prove it carries no \`deployment\` key.`,
				};
			}
			if (inner.text === DEPLOYMENT_PROPERTY_NAME) carries = true;
			continue;
		}
		if (
			(ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
			name.text === DEPLOYMENT_PROPERTY_NAME
		) {
			carries = true;
		}
	}
	return { status: "ok", carries };
}

/**
 * Name of the variable the `defineProvider(...)` call is bound to — only
 * when that binding is a top-level `const` that is never reassigned, so a
 * later `builder({ operations })` call provably builds THIS declaration.
 */
function builderVariableName(call: TS.CallExpression, source: TS.SourceFile): string | undefined {
	const parent = call.parent;
	if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name)) return undefined;
	const list = parent.parent;
	if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0)
		return undefined;
	const statement = list.parent;
	if (!ts.isVariableStatement(statement) || statement.parent !== source) return undefined;
	return isReassigned(source, parent.name.text) ? undefined : parent.name.text;
}

/** Whether any expression assigns to (or increments) the binding `name`. */
function isReassigned(source: TS.SourceFile, name: string): boolean {
	let reassigned = false;
	const visit = (node: TS.Node): void => {
		if (reassigned) return;
		if (ts.isIdentifier(node) && node.text === name && isIdentifierReference(node)) {
			const parent = node.parent;
			if (
				(ts.isBinaryExpression(parent) &&
					parent.left === node &&
					parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
					parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
				ts.isPrefixUnaryExpression(parent) ||
				ts.isPostfixUnaryExpression(parent)
			) {
				reassigned = true;
				return;
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return reassigned;
}

// ── Default-export spread ─────────────────────────────────────────────────

type SpreadDeploymentValue =
	| { readonly kind: "literal"; readonly value: unknown }
	| {
			readonly kind: "const";
			readonly value: unknown;
			readonly name: string;
			readonly statement: TS.VariableStatement;
	  }
	| { readonly kind: "deploy-import" };

type SpreadExportAnalysis =
	| {
			readonly status: "ok";
			readonly exportAssignment?: TS.ExportAssignment;
			readonly literal?: TS.ObjectLiteralExpression;
			readonly deploymentProperty?: {
				readonly node: TS.PropertyAssignment | TS.ShorthandPropertyAssignment;
				readonly value: SpreadDeploymentValue;
			};
	  }
	| { readonly status: "refused"; readonly reason: string };

function analyzeSpreadExport(
	source: TS.SourceFile,
	declarationCall: TS.CallExpression,
	builderName: string | undefined,
): SpreadExportAnalysis {
	const exportAssignment = findDefaultExport(source);
	if (exportAssignment === undefined) return { status: "ok" };
	const exported = unwrapExpression(exportAssignment.expression);
	if (ts.isIdentifier(exported)) {
		// `export default provider;` — the binding must reach the export
		// untouched (`provider.deployment!.replicas = 2` would make the
		// declaration key the transform rewrites not the effective one).
		if (
			findTopLevelConst(source, exported.text) !== undefined &&
			!identifierUsesAreReadOnly(source, exported.text, new Set(), "provider")
		) {
			return {
				status: "refused",
				reason: `The default export \`${exported.text}\` is mutated, aliased, or passed to a call before it is exported, so the declaration's deployment key may not be the effective one; reconcile by hand.`,
			};
		}
		return { status: "ok" };
	}
	if (!ts.isObjectLiteralExpression(exported)) return { status: "ok" };
	if (!exported.properties.some(ts.isSpreadAssignment)) return { status: "ok" };

	let deploymentProperty: Extract<SpreadExportAnalysis, { status: "ok" }>["deploymentProperty"];
	let deploymentIndex = -1;
	let providerSpreadIndex = -1;
	let lastDeploymentSpreadIndex = -1;
	for (const [index, property] of exported.properties.entries()) {
		if (ts.isSpreadAssignment(property)) {
			if (isBuiltProviderSpread(property.expression, source, declarationCall, builderName)) {
				providerSpreadIndex = index;
				continue;
			}
			// Any other spread must be statically inspectable: a spread the
			// transform cannot see into could carry (and, if it comes later,
			// override) the deployment key it is about to hoist.
			const scan = spreadCarriesDeployment(property.expression, source, new Set());
			if (scan.status === "refused") {
				return { status: "refused", reason: `The default export spreads ${scan.reason}` };
			}
			if (scan.carries) lastDeploymentSpreadIndex = index;
			continue;
		}
		const named = matchDeploymentProperty(property, "default export");
		if (named.status === "refused") {
			// Shorthand `deployment` on the export is a legitimate legacy shape;
			// resolve the identifier instead of refusing it.
			if (
				ts.isShorthandPropertyAssignment(property) &&
				property.name.text === DEPLOYMENT_PROPERTY_NAME
			) {
				if (deploymentProperty !== undefined) return duplicateExportDeployment();
				const value = resolveSpreadValueIdentifier(source, property.name);
				if (value.status === "refused") return value;
				deploymentProperty = { node: property, value: value.value };
				deploymentIndex = index;
				continue;
			}
			return named;
		}
		if (named.property === undefined) continue;
		if (deploymentProperty !== undefined) return duplicateExportDeployment();
		const initializer = unwrapExpression(named.property.initializer);
		if (ts.isIdentifier(initializer)) {
			const value = resolveSpreadValueIdentifier(source, initializer);
			if (value.status === "refused") return value;
			deploymentProperty = { node: named.property, value: value.value };
		} else {
			const evaluated = evaluateStatic(initializer, source);
			if (!evaluated.ok) {
				return {
					status: "refused",
					reason: `The default export's deployment property is not a static literal: ${evaluated.reason}`,
				};
			}
			deploymentProperty = {
				node: named.property,
				value: { kind: "literal", value: evaluated.value },
			};
		}
		deploymentIndex = index;
	}

	if (deploymentProperty === undefined) {
		if (lastDeploymentSpreadIndex >= 0) {
			return {
				status: "refused",
				reason:
					"The default export receives a deployment key through a spread; hoist that key into the declaration by hand before migrating.",
			};
		}
		return { status: "ok", exportAssignment, literal: exported };
	}
	if (providerSpreadIndex < 0) {
		return {
			status: "refused",
			reason:
				"The default export carries a deployment property but does not spread the built provider (or that binding is mutated afterwards), so a key hoisted into the declaration would never reach the export; reconcile by hand.",
		};
	}
	if (providerSpreadIndex > deploymentIndex) {
		return {
			status: "refused",
			reason:
				"The default export spreads the built provider after its deployment property, so the property may not be the effective deployment; move the spread first or reconcile by hand.",
		};
	}
	if (lastDeploymentSpreadIndex >= 0) {
		// After the property: it is not the effective deployment. Before it:
		// removing the property would expose the spread's deployment.
		return {
			status: "refused",
			reason:
				"The default export also spreads an object that carries a deployment key, so removing its deployment property would change the effective deployment; reconcile by hand.",
		};
	}
	return { status: "ok", exportAssignment, literal: exported, deploymentProperty };
}

function duplicateExportDeployment(): SpreadExportAnalysis {
	return {
		status: "refused",
		reason: "The default export declares `deployment` more than once; keep a single property.",
	};
}

/**
 * `...provider` where `provider` is the declaration's built provider: bound
 * to a call of the declaration builder (`const provider = buildProvider({
 * operations })`), to the `defineProvider(...)` call itself (single-phase
 * shape), or that call inline. The built provider carries exactly the
 * declaration's deployment key, which the transform already accounts for.
 */
function isBuiltProviderSpread(
	expression: TS.Expression,
	source: TS.SourceFile,
	declarationCall: TS.CallExpression,
	builderName: string | undefined,
): boolean {
	let expr = unwrapExpression(expression);
	if (ts.isIdentifier(expr)) {
		const declaration = findTopLevelConst(source, expr.text);
		if (declaration?.initializer === undefined) return false;
		// A binding mutated after the builder call (`provider.deployment = …`)
		// no longer carries exactly the declaration's deployment.
		if (!identifierUsesAreReadOnly(source, expr.text, new Set(), "provider")) return false;
		expr = unwrapExpression(declaration.initializer);
	}
	if (expr === declarationCall) return true;
	return (
		builderName !== undefined &&
		ts.isCallExpression(expr) &&
		ts.isIdentifier(expr.expression) &&
		expr.expression.text === builderName
	);
}

function resolveSpreadValueIdentifier(
	source: TS.SourceFile,
	identifier: TS.Identifier,
):
	| { readonly status: "ok"; readonly value: SpreadDeploymentValue }
	| { readonly status: "refused"; readonly reason: string } {
	const imports = collectLegacyDeployImports(source);
	if (imports.status === "ok" && imports.defaultImport === identifier.text) {
		return { status: "ok", value: { kind: "deploy-import" } };
	}
	const declaration = findTopLevelConst(source, identifier.text);
	if (declaration?.initializer !== undefined) {
		// Evaluate the identifier itself so the binding's other uses are
		// checked for mutation, not just its initializer text.
		const evaluated = evaluateStatic(identifier, source);
		if (!evaluated.ok) {
			return {
				status: "refused",
				reason: `\`${identifier.text}\` (attached as deployment on the default export) is not a static literal: ${evaluated.reason}`,
			};
		}
		const statement = declaration.parent.parent;
		if (!ts.isVariableStatement(statement)) {
			return {
				status: "refused",
				reason: `\`${identifier.text}\` is not declared by a plain variable statement.`,
			};
		}
		return {
			status: "ok",
			value: { kind: "const", value: evaluated.value, name: identifier.text, statement },
		};
	}
	return {
		status: "refused",
		reason: `\`${identifier.text}\` (attached as deployment on the default export) does not resolve to a top-level const or the ./deploy default import.`,
	};
}

function removeSpreadDeploymentProperty(
	spread: Extract<SpreadExportAnalysis, { status: "ok" }>,
	declaration: TS.ObjectLiteralExpression,
	source: TS.SourceFile,
): TextEdit[] {
	const { exportAssignment, literal, deploymentProperty } = spread;
	if (exportAssignment === undefined || literal === undefined || deploymentProperty === undefined)
		return [];
	const remaining = literal.properties.filter((property) => property !== deploymentProperty.node);
	const onlySpread = remaining[0];
	// Folding re-emits the spread's source text; when the declaration literal
	// lives inside it (`{ ...defineProvider({...}), deployment }`) that text
	// would overlap the declaration edits, so only the property is removed.
	const declarationInsideSpread =
		onlySpread !== undefined &&
		declaration.getStart(source) >= onlySpread.getStart(source) &&
		declaration.getEnd() <= onlySpread.getEnd();
	if (
		remaining.length === 1 &&
		onlySpread !== undefined &&
		ts.isSpreadAssignment(onlySpread) &&
		!declarationInsideSpread
	) {
		// `export default { ...provider }` folds to `export default provider;`.
		return [
			{
				start: exportAssignment.expression.getStart(source),
				end: exportAssignment.expression.getEnd(),
				text: onlySpread.expression.getText(source),
			},
		];
	}
	return [removeObjectProperty(deploymentProperty.node, literal, source)];
}

// ── ./deploy imports ──────────────────────────────────────────────────────

type LegacyDeployImports =
	| {
			readonly status: "ok";
			/** Local name bound by `import <name> from "./deploy"`, when present. */
			readonly defaultImport?: string;
			/** Import declarations that only reference ./deploy and can be dropped. */
			readonly removable: readonly TS.ImportDeclaration[];
			/**
			 * Local names of type-only bindings imported from ./deploy (`import
			 * type Config from`, `{ type Config }`). The file is deleted with the
			 * import, so any remaining reference to these names would no longer
			 * type-check; the transform refuses when one survives.
			 */
			readonly typeOnlyNames: readonly string[];
	  }
	| { readonly status: "refused"; readonly reason: string };

function collectLegacyDeployImports(source: TS.SourceFile): LegacyDeployImports {
	let defaultImport: string | undefined;
	const removable: TS.ImportDeclaration[] = [];
	const typeOnlyNames: string[] = [];
	const collectNamed = (bindings: TS.NamedImportBindings | undefined): void => {
		if (bindings === undefined) return;
		if (ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) typeOnlyNames.push(element.name.text);
		} else {
			typeOnlyNames.push(bindings.name.text);
		}
	};
	for (const statement of source.statements) {
		if (ts.isExportDeclaration(statement)) {
			const specifier = statement.moduleSpecifier;
			if (
				specifier !== undefined &&
				ts.isStringLiteralLike(specifier) &&
				isDeployModuleSpecifier(specifier.text, INDEX_VIRTUAL_DIRECTORY, DEPLOY_MODULE_VIRTUAL_PATH)
			) {
				return {
					status: "refused",
					reason:
						"index.ts re-exports from ./deploy; remove that re-export by hand before deleting the file.",
				};
			}
			continue;
		}
		if (!ts.isImportDeclaration(statement)) continue;
		const specifier = statement.moduleSpecifier;
		if (
			!ts.isStringLiteralLike(specifier) ||
			!isDeployModuleSpecifier(specifier.text, INDEX_VIRTUAL_DIRECTORY, DEPLOY_MODULE_VIRTUAL_PATH)
		) {
			continue;
		}
		const clause = statement.importClause;
		if (clause === undefined) {
			return {
				status: "refused",
				reason: "index.ts has a side-effect import of ./deploy; remove it by hand.",
			};
		}
		if (clause.isTypeOnly) {
			if (clause.name !== undefined) typeOnlyNames.push(clause.name.text);
			collectNamed(clause.namedBindings);
			removable.push(statement);
			continue;
		}
		if (clause.namedBindings !== undefined) {
			if (
				ts.isNamedImports(clause.namedBindings) &&
				clause.namedBindings.elements.every((element) => element.isTypeOnly)
			) {
				// `{ type Config }` alongside the default binding, or alone.
				collectNamed(clause.namedBindings);
				if (clause.name === undefined) {
					removable.push(statement);
					continue;
				}
			} else {
				return {
					status: "refused",
					reason:
						"index.ts imports named or namespace bindings from ./deploy; only the default export can be hoisted.",
				};
			}
		}
		if (clause.name !== undefined) {
			if (defaultImport !== undefined) {
				return { status: "refused", reason: "index.ts imports ./deploy more than once." };
			}
			defaultImport = clause.name.text;
			removable.push(statement);
		}
	}
	return {
		status: "ok",
		...(defaultImport === undefined ? {} : { defaultImport }),
		removable,
		typeOnlyNames,
	};
}

function referencesLegacyDeployModule(source: TS.SourceFile): boolean {
	return sourceImportsModule(source, INDEX_VIRTUAL_DIRECTORY, DEPLOY_MODULE_VIRTUAL_PATH);
}

/**
 * Whether `source` (located in `fromDirectory`) imports the module at
 * `moduleAbsolutePath` (extension-less) through any specifier position:
 * static import/re-export, dynamic `import()`, `require()`, `import x =
 * require()`, or an `import("…")` type. Template-literal specifiers count.
 */
function sourceImportsModule(
	source: TS.SourceFile,
	fromDirectory: string,
	moduleAbsolutePath: string,
): boolean {
	let found = false;
	const visit = (node: TS.Node): void => {
		if (found) return;
		if (
			ts.isStringLiteralLike(node) &&
			isModuleSpecifierPosition(node) &&
			isDeployModuleSpecifier(node.text, fromDirectory, moduleAbsolutePath)
		) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function isModuleSpecifierPosition(node: TS.StringLiteralLike): boolean {
	const parent = node.parent;
	return (
		ts.isImportDeclaration(parent) ||
		ts.isExportDeclaration(parent) ||
		ts.isExternalModuleReference(parent) ||
		(ts.isCallExpression(parent) &&
			parent.arguments[0] === node &&
			(parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(parent.expression) && parent.expression.text === "require"))) ||
		(ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent))
	);
}

/** A relative specifier that resolves (extension-less) to `moduleAbsolutePath`. */
function isDeployModuleSpecifier(
	specifier: string,
	fromDirectory: string,
	moduleAbsolutePath: string,
): boolean {
	if (!specifier.startsWith(".")) return false;
	const resolved = path.resolve(fromDirectory, specifier);
	// Strip the extension from the file name only; a directory segment such
	// as `/srv/provider.ts/` must survive untouched.
	const withoutExtension = path.join(
		path.dirname(resolved),
		path.basename(resolved).replace(SOURCE_EXTENSION, ""),
	);
	return withoutExtension === moduleAbsolutePath;
}

// ── Static evaluation ─────────────────────────────────────────────────────

type StaticValue =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly reason: string };

function evaluateStatic(
	node: TS.Expression,
	source: TS.SourceFile,
	seen: Set<string> = new Set(),
): StaticValue {
	const expression = unwrapExpression(node);
	if (ts.isObjectLiteralExpression(expression)) {
		const value: Record<string, unknown> = {};
		for (const property of expression.properties) {
			if (ts.isSpreadAssignment(property)) {
				return { ok: false, reason: "object literal contains a spread" };
			}
			const name = property.name;
			if (
				name === undefined ||
				!(ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
			) {
				return { ok: false, reason: "object literal has a computed or non-static property name" };
			}
			if (Object.hasOwn(value, name.text)) {
				return { ok: false, reason: `object literal repeats property \`${name.text}\`` };
			}
			let element: StaticValue;
			if (ts.isPropertyAssignment(property)) {
				element = evaluateStatic(property.initializer, source, seen);
			} else if (ts.isShorthandPropertyAssignment(property)) {
				element = evaluateStatic(property.name, source, seen);
			} else {
				return { ok: false, reason: `property \`${name.text}\` is a method or accessor` };
			}
			if (!element.ok) return element;
			value[name.text] = element.value;
		}
		return { ok: true, value };
	}
	if (ts.isArrayLiteralExpression(expression)) {
		const items: unknown[] = [];
		for (const element of expression.elements) {
			if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
				return { ok: false, reason: "array literal contains a spread or hole" };
			}
			const item = evaluateStatic(element, source, seen);
			if (!item.ok) return item;
			items.push(item.value);
		}
		return { ok: true, value: items };
	}
	if (ts.isStringLiteralLike(expression)) return { ok: true, value: expression.text };
	if (ts.isNumericLiteral(expression)) return { ok: true, value: Number(expression.text) };
	if (
		ts.isPrefixUnaryExpression(expression) &&
		expression.operator === ts.SyntaxKind.MinusToken &&
		ts.isNumericLiteral(expression.operand)
	) {
		return { ok: true, value: -Number(expression.operand.text) };
	}
	if (expression.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
	if (expression.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
	if (expression.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
	if (ts.isIdentifier(expression)) {
		if (expression.text === "undefined") return { ok: true, value: undefined };
		if (seen.has(expression.text)) {
			return { ok: false, reason: `\`${expression.text}\` is defined in terms of itself` };
		}
		if (!isTopLevelNode(expression)) {
			return {
				ok: false,
				reason: `\`${expression.text}\` is referenced inside a nested scope where a local binding could shadow the top-level const`,
			};
		}
		const declaration = findTopLevelConst(source, expression.text);
		if (declaration?.initializer === undefined) {
			return {
				ok: false,
				reason: `\`${expression.text}\` does not resolve to a top-level const with a literal initializer`,
			};
		}
		if (!identifierUsesAreReadOnly(source, expression.text)) {
			return {
				ok: false,
				reason: `\`${expression.text}\` is mutated, aliased, or passed to a call after its initializer, so the initializer may not be its effective value`,
			};
		}
		const next = new Set(seen);
		next.add(expression.text);
		return evaluateStatic(declaration.initializer, source, next);
	}
	return { ok: false, reason: `${ts.SyntaxKind[expression.kind]} is not a static literal` };
}

function unwrapExpression(node: TS.Expression): TS.Expression {
	let current = node;
	for (;;) {
		if (ts.isParenthesizedExpression(current)) current = current.expression;
		else if (ts.isAsExpression(current)) current = current.expression;
		else if (ts.isSatisfiesExpression(current)) current = current.expression;
		else if (ts.isTypeAssertionExpression(current)) current = current.expression;
		else if (ts.isNonNullExpression(current)) current = current.expression;
		else return current;
	}
}

function findTopLevelConst(
	source: TS.SourceFile,
	name: string,
): TS.VariableDeclaration | undefined {
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
				return statement.declarationList.declarations.length === 1 ? declaration : undefined;
			}
		}
	}
	return undefined;
}

/** Whether an identifier node is a reference (not a declared or property name). */
function isIdentifierReference(node: TS.Identifier): boolean {
	const parent = node.parent;
	const isDeclaredOrPropertyName =
		(ts.isPropertyAssignment(parent) && parent.name === node) ||
		(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
		(ts.isMethodDeclaration(parent) && parent.name === node) ||
		(ts.isPropertySignature(parent) && parent.name === node) ||
		(ts.isImportSpecifier(parent) && parent.propertyName === node) ||
		ts.isImportClause(parent) ||
		(ts.isVariableDeclaration(parent) && parent.name === node);
	return !isDeclaredOrPropertyName;
}

/** Identifier references to `name` in expression position (property names excluded). */
function countIdentifierReferences(source: TS.SourceFile, name: string): number {
	let count = 0;
	const visit = (node: TS.Node): void => {
		if (ts.isIdentifier(node) && node.text === name && isIdentifierReference(node)) count += 1;
		ts.forEachChild(node, visit);
	};
	visit(source);
	return count;
}

/**
 * True when every reference to the top-level binding `name` is a plain read
 * the transform accounts for: spread into an object literal, a property
 * value, a shorthand property, the default export, or a `defineProvider()`
 * argument. Anything else — a member assignment, an alias, a call that
 * receives the object — could change or observe the value after its
 * initializer, so callers refuse instead of trusting the literal.
 */
/**
 * What member access on the binding may mean:
 * - `"value"` (a deployment config or declaration object): every member is
 *   deployment-relevant, so any member access — `config.resources.memory =
 *   …`, `Object.assign(config.resources, …)`, `….push(…)` — disqualifies it.
 * - `"provider"` (a built provider): only `.deployment` matters; other member
 *   reads such as `provider.operations.x.handler(…)` are fine unless they are
 *   assignment, delete, or update targets.
 */
type BindingKind = "value" | "provider";

function identifierUsesAreReadOnly(
	source: TS.SourceFile,
	name: string,
	seen: ReadonlySet<string> = new Set(),
	kind: BindingKind = "value",
): boolean {
	if (seen.has(name)) return true;
	const next = new Set(seen);
	next.add(name);
	let readOnly = true;
	const visit = (node: TS.Node): void => {
		if (!readOnly) return;
		if (ts.isIdentifier(node) && node.text === name && isIdentifierReference(node)) {
			let use: TS.Node = node;
			while (
				ts.isParenthesizedExpression(use.parent) ||
				ts.isAsExpression(use.parent) ||
				ts.isSatisfiesExpression(use.parent) ||
				ts.isNonNullExpression(use.parent)
			) {
				use = use.parent;
			}
			const parent = use.parent;
			let plainRead = ts.isExportAssignment(parent) || isDefineProviderArgument(parent, use);
			if (
				!plainRead &&
				kind === "provider" &&
				(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
				parent.expression === use
			) {
				// `provider.operations.x.handler(...)` is a read; `provider.x = …`
				// is not, and reaching `.deployment` directly is refused outright.
				plainRead = memberAccessIsRead(parent);
			}
			if (
				!plainRead &&
				(ts.isSpreadAssignment(parent) ||
					(ts.isPropertyAssignment(parent) && parent.initializer === use) ||
					ts.isShorthandPropertyAssignment(parent)) &&
				ts.isObjectLiteralExpression(parent.parent)
			) {
				// Placing the object (or a shallow copy sharing its nested
				// objects) inside another literal is only a read when that
				// literal itself cannot be reached and mutated afterwards.
				plainRead = literalIsAnchored(parent.parent, source, next);
			}
			if (!plainRead) readOnly = false;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return readOnly;
}

/**
 * A member-access chain rooted at the binding is a read unless it (or the
 * chain it starts) is assigned, deleted, or updated, or unless its first
 * member is `deployment` itself (or not statically nameable): anything
 * touching the deployment object directly is left to a human.
 */
function memberAccessIsRead(
	access: TS.PropertyAccessExpression | TS.ElementAccessExpression,
): boolean {
	let firstMember: string | undefined;
	if (ts.isPropertyAccessExpression(access)) firstMember = access.name.text;
	else if (ts.isStringLiteralLike(access.argumentExpression)) {
		firstMember = access.argumentExpression.text;
	}
	if (firstMember === undefined || firstMember === DEPLOYMENT_PROPERTY_NAME) return false;
	let chain: TS.Node = access;
	for (;;) {
		const parent: TS.Node | undefined = chain.parent;
		if (parent === undefined) return true;
		if (
			(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
			parent.expression === chain
		) {
			chain = parent;
			continue;
		}
		if (ts.isNonNullExpression(parent) || ts.isParenthesizedExpression(parent)) {
			chain = parent;
			continue;
		}
		if (
			ts.isBinaryExpression(parent) &&
			parent.left === chain &&
			parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
		) {
			return false;
		}
		return !(
			ts.isDeleteExpression(parent) ||
			ts.isPrefixUnaryExpression(parent) ||
			ts.isPostfixUnaryExpression(parent)
		);
	}
}

function isDefineProviderArgument(parent: TS.Node, use: TS.Node): boolean {
	return (
		ts.isCallExpression(parent) &&
		ts.isIdentifier(parent.expression) &&
		parent.expression.text === "defineProvider" &&
		parent.arguments.some((argument) => argument === use)
	);
}

/**
 * An object literal is anchored when, climbing through enclosing literals
 * and wrappers, it ends up as the default export, a `defineProvider()`
 * argument, or the initializer of a top-level const whose own uses are
 * read-only. Anything else (a `holder` that is later dereferenced, a call
 * argument, a return value) may alias and mutate the contents.
 */
function literalIsAnchored(
	literal: TS.ObjectLiteralExpression,
	source: TS.SourceFile,
	seen: ReadonlySet<string>,
): boolean {
	let node: TS.Node = literal;
	for (;;) {
		const parent: TS.Node | undefined = node.parent;
		if (parent === undefined) return false;
		if (
			ts.isParenthesizedExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isSatisfiesExpression(parent) ||
			ts.isNonNullExpression(parent) ||
			ts.isPropertyAssignment(parent) ||
			ts.isSpreadAssignment(parent) ||
			ts.isObjectLiteralExpression(parent) ||
			ts.isArrayLiteralExpression(parent)
		) {
			node = parent;
			continue;
		}
		if (ts.isExportAssignment(parent)) return true;
		if (isDefineProviderArgument(parent, node)) return true;
		if (
			ts.isVariableDeclaration(parent) &&
			parent.initializer === node &&
			ts.isIdentifier(parent.name) &&
			ts.isVariableDeclarationList(parent.parent) &&
			(parent.parent.flags & ts.NodeFlags.Const) !== 0 &&
			ts.isVariableStatement(parent.parent.parent) &&
			parent.parent.parent.parent === source
		) {
			return identifierUsesAreReadOnly(source, parent.name.text, seen);
		}
		return false;
	}
}

function hasExportModifier(statement: TS.VariableStatement): boolean {
	return (
		ts
			.getModifiers(statement)
			?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
	);
}

// ── Emission ──────────────────────────────────────────────────────────────

function insertDeploymentProperty(
	declaration: TS.ObjectLiteralExpression,
	intent: ProviderDeploymentOverrides,
	source: TS.SourceFile,
): TextEdit {
	const anchor =
		findAnchorProperty(declaration, "runtime") ??
		findAnchorProperty(declaration, "version") ??
		findAnchorProperty(declaration, "id") ??
		declaration.properties[0];
	const text = source.getFullText();
	if (anchor === undefined) {
		// Empty declaration literal: `{}`.
		const indent = lineIndentation(source, declaration.getStart(source));
		const unit = indent.startsWith("\t") ? "\t" : "  ";
		const inner = `${indent}${unit}`;
		const body = renderPropertyLines(intent, inner, unit);
		return {
			start: declaration.getStart(source) + 1,
			end: declaration.getEnd() - 1,
			text: `\n${body}\n${indent}`,
		};
	}
	const indent = lineIndentation(source, anchor.getStart(source));
	const unit = indentUnitFor(source, declaration, indent);
	// Insert after the anchor's trailing comma when it has one; otherwise
	// give the anchor a comma so the literal stays well-formed.
	let cursor = anchor.getEnd();
	while (cursor < text.length && /[ \t]/.test(text.charAt(cursor))) cursor += 1;
	const hasComma = text.charAt(cursor) === ",";
	const insertAt = hasComma ? cursor + 1 : anchor.getEnd();
	const prefix = hasComma ? "" : ",";
	return {
		start: insertAt,
		end: insertAt,
		text: `${prefix}\n${renderPropertyLines(intent, indent, unit)}`,
	};
}

function renderPropertyLines(
	intent: ProviderDeploymentOverrides,
	indent: string,
	unit: string,
): string {
	const lines: string[] = [];
	if (intent.runtime !== undefined) lines.push(`${indent}${DEPLOYMENT_RUNTIME_AXIS_COMMENT}`);
	lines.push(`${indent}${DEPLOYMENT_PROPERTY_NAME}: ${formatIntentLiteral(intent, indent, unit)},`);
	return lines.join("\n");
}

function findAnchorProperty(
	declaration: TS.ObjectLiteralExpression,
	name: string,
): TS.ObjectLiteralElementLike | undefined {
	for (const property of declaration.properties) {
		if (ts.isSpreadAssignment(property)) continue;
		const propertyName = property.name;
		if (
			propertyName !== undefined &&
			(ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName)) &&
			propertyName.text === name
		) {
			return property;
		}
	}
	return undefined;
}

/**
 * Format the key's object literal starting at column `indent.length +
 * "deployment: ".length`: inline when it fits the line width, otherwise
 * expanded one property per line (recursively), trailing commas included —
 * the same decisions a formatter would keep.
 */
export function formatIntentLiteral(
	intent: ProviderDeploymentOverrides,
	indent: string,
	unit: string,
): string {
	const ordered: Record<string, unknown> = {};
	for (const key of DEPLOYMENT_INTENT_FIELD_ORDER) {
		if (intent[key] !== undefined) ordered[key] = intent[key];
	}
	return formatValue(ordered, indent, unit, `${DEPLOYMENT_PROPERTY_NAME}: `.length, 1);
}

function formatValue(
	value: unknown,
	indent: string,
	unit: string,
	prefixWidth: number,
	suffixWidth: number,
): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => formatValue(item, indent, unit, 0, 0)).join(", ")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value).filter(([, item]) => item !== undefined);
		if (entries.length === 0) return "{}";
		const inline = `{ ${entries
			.map(([key, item]) => `${key}: ${formatValue(item, indent, unit, 0, 0)}`)
			.join(", ")} }`;
		if (indent.length + prefixWidth + inline.length + suffixWidth <= LINE_WIDTH) return inline;
		const inner = `${indent}${unit}`;
		const lines = entries.map(
			([key, item]) => `${inner}${key}: ${formatValue(item, inner, unit, `${key}: `.length, 1)},`,
		);
		return `{\n${lines.join("\n")}\n${indent}}`;
	}
	if (typeof value === "string") return JSON.stringify(value);
	return String(value);
}

function lineIndentation(source: TS.SourceFile, position: number): string {
	const text = source.getFullText();
	const lineStart = text.lastIndexOf("\n", position - 1) + 1;
	const match = /^[ \t]*/.exec(text.slice(lineStart, position));
	return match?.[0] ?? "";
}

function indentUnitFor(
	source: TS.SourceFile,
	literal: TS.ObjectLiteralExpression,
	propertyIndent: string,
): string {
	if (propertyIndent.startsWith("\t")) return "\t";
	const literalIndent = lineIndentation(source, literal.getStart(source));
	if (propertyIndent.length > literalIndent.length && propertyIndent.startsWith(literalIndent)) {
		return propertyIndent.slice(literalIndent.length);
	}
	return propertyIndent.length > 0 ? propertyIndent : "  ";
}

// ── Shared AST helpers ────────────────────────────────────────────────────

type TextEdit = {
	readonly start: number;
	readonly end: number;
	readonly text: string;
};

function parseSource(fileName: string, text: string): TS.SourceFile {
	return ts.createSourceFile(
		fileName,
		text,
		ts.ScriptTarget.Latest,
		/* setParentNodes */ true,
		ts.ScriptKind.TS,
	);
}

function collectDefineProviderCalls(source: TS.SourceFile): TS.CallExpression[] {
	const calls: TS.CallExpression[] = [];
	const visit = (node: TS.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "defineProvider"
		) {
			calls.push(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return calls;
}

function findDefaultExport(source: TS.SourceFile): TS.ExportAssignment | undefined {
	for (const statement of source.statements) {
		if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) return statement;
	}
	return undefined;
}

/** Remove one property from an object literal, absorbing a neighboring comma. */
function removeObjectProperty(
	property: TS.ObjectLiteralElementLike,
	literal: TS.ObjectLiteralExpression,
	source: TS.SourceFile,
): TextEdit {
	const properties = literal.properties;
	const index = properties.indexOf(property);
	const text = source.getFullText();
	const start = property.getFullStart();
	let end = property.getEnd();
	let cursor = end;
	while (cursor < text.length && /\s/.test(text.charAt(cursor))) cursor += 1;
	if (text.charAt(cursor) === ",") {
		end = cursor + 1;
	} else if (index > 0) {
		const previous = properties[index - 1];
		if (previous !== undefined) {
			let back = previous.getEnd();
			while (back < text.length && /\s/.test(text.charAt(back))) back += 1;
			if (text.charAt(back) === ",") return { start: back, end, text: "" };
		}
	}
	return { start, end, text: "" };
}

/**
 * Remove a statement's own lines (from the start of its first line through
 * the line break after it), keeping surrounding blank lines and any comment
 * block above it intact.
 */
function removeStatement(statement: TS.Statement, source: TS.SourceFile): TextEdit {
	const text = source.getFullText();
	const statementStart = statement.getStart(source);
	const lineStart = text.lastIndexOf("\n", statementStart - 1) + 1;
	// Only take the whole line when the statement owns it; a statement that
	// shares its line with an earlier one is cut out in place.
	const ownsLine = /^[ \t]*$/.test(text.slice(lineStart, statementStart));
	let start = ownsLine ? lineStart : statementStart;
	let end = statement.getEnd();
	if (ownsLine) {
		if (text.charAt(end) === "\r") end += 1;
		if (text.charAt(end) === "\n") end += 1;
	} else {
		// Absorb the separating whitespace before the statement so the
		// neighbor keeps its own line ending intact.
		while (start > lineStart && /[ \t]/.test(text.charAt(start - 1))) start -= 1;
	}
	return { start, end, text: "" };
}

function firstSyntaxError(source: TS.SourceFile): string | undefined {
	const diagnostics = (source as TS.SourceFile & { parseDiagnostics?: TS.DiagnosticWithLocation[] })
		.parseDiagnostics;
	const first = diagnostics?.[0];
	if (first === undefined) return undefined;
	const message = ts.flattenDiagnosticMessageText(first.messageText, " ");
	const { line } = source.getLineAndCharacterOfPosition(first.start);
	return `${message} (line ${line + 1})`;
}

function editsOverlap(edits: readonly TextEdit[]): boolean {
	const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
	for (let index = 1; index < ordered.length; index += 1) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		if (previous !== undefined && current !== undefined && current.start < previous.end)
			return true;
	}
	return false;
}

/** Whether `node` sits directly in the module scope (no enclosing function, class, or block). */
function isTopLevelNode(node: TS.Node): boolean {
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (
			ts.isFunctionLike(current) ||
			ts.isClassLike(current) ||
			ts.isBlock(current) ||
			ts.isModuleBlock(current)
		) {
			return false;
		}
	}
	return true;
}

function applyEdits(text: string, edits: readonly TextEdit[]): string {
	const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
	let output = text;
	for (const edit of ordered) {
		output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
	}
	return output;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
