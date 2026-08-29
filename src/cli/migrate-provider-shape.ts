import ts from "typescript";

/**
 * Provider authoring shape migration.
 *
 * `defineProvider` changed in 2.2.0-beta.37 from returning a finished provider
 * to returning a builder, splitting authoring into two phases:
 *
 *   const buildProvider = defineProvider(<declaration>);
 *   export type ProviderContext = ProviderContextOf<typeof buildProvider>;
 *   export default buildProvider({ operations });
 *
 * Source written against the single-phase shape still type-checks against an
 * older pin but default-exports a builder function once the pin moves, so
 * `loadProviderDefinition` rejects it. Bumping the pin without migrating the
 * source therefore breaks the module. This transform performs the source half
 * so the SDK bump fan-out can ship both in one commit.
 *
 * The transform is deliberately conservative: it rewrites only the shapes it
 * can fully account for and reports `skipped` with a reason for anything else,
 * rather than emitting a partial migration a reviewer would have to audit.
 */

/** Every source shape this transform recognizes. */
export type ProviderShapeKind =
	/** `export default defineProvider({ ..., operations })` */
	| "single-phase-default-export"
	/** `const p = defineProvider({ ..., operations }); export default p;` */
	| "single-phase-variable-export"
	/** `const p = defineProvider({ ..., operations }); export default { ...p, deployment };` */
	| "single-phase-variable-spread-export"
	/** Already `const b = defineProvider(...); export default b({ operations })` */
	| "two-phase";

export type ProviderShapeMigration =
	| {
			readonly status: "migrated";
			readonly kind: ProviderShapeKind;
			readonly code: string;
			/** Source text the operations map was supplied as, for reporting. */
			readonly operationsExpression: string;
	  }
	| {
			readonly status: "unchanged";
			readonly kind: "two-phase";
			readonly code: string;
	  }
	| {
			readonly status: "skipped";
			readonly reason: string;
	  };

const DECLARATION_BUILDER_NAME = "buildProvider";
const PROVIDER_CONTEXT_TYPE_NAME = "ProviderContext";
const PROVIDER_CONTEXT_OF_TYPE_NAME = "ProviderContextOf";
const PROVIDER_SDK_PROVIDER_SUBPATH = "@apifuse/provider-sdk/provider";

/**
 * Migrate one provider `index.ts` to the two-phase authoring shape.
 *
 * Returns the rewritten source on success. Callers MUST treat `skipped` as a
 * hard stop for that provider — a skipped provider needs a human, and pairing
 * a pin bump with a skipped migration produces an unloadable module.
 */
export function migrateProviderShape(
	sourceText: string,
	fileName = "index.ts",
): ProviderShapeMigration {
	const source = ts.createSourceFile(
		fileName,
		sourceText,
		ts.ScriptTarget.Latest,
		/* setParentNodes */ true,
		ts.ScriptKind.TS,
	);

	const syntaxError = firstSyntaxError(source);
	if (syntaxError !== undefined) {
		return { status: "skipped", reason: syntaxError };
	}

	const calls = collectDefineProviderCalls(source);
	if (calls.length === 0) {
		return {
			status: "skipped",
			reason:
				"No defineProvider(...) call found; this file does not declare a provider.",
		};
	}
	if (calls.length > 1) {
		return {
			status: "skipped",
			reason: `Found ${calls.length} defineProvider(...) calls; the transform rewrites exactly one declaration.`,
		};
	}

	const call = calls[0];
	if (call === undefined) {
		return { status: "skipped", reason: "Internal: defineProvider call vanished." };
	}

	const exportAssignment = findDefaultExport(source);
	if (exportAssignment === undefined) {
		return {
			status: "skipped",
			reason:
				"No `export default` found; the provider module must default-export its provider.",
		};
	}

	const declaration = call.arguments[0];
	if (declaration === undefined || !ts.isObjectLiteralExpression(declaration)) {
		return {
			status: "skipped",
			reason:
				"defineProvider(...) is called with a non-literal argument, so the declaration's operations key cannot be located.",
		};
	}

	const operationsProperty = findOperationsProperty(declaration);

	// Already migrated: the declaration carries no operations key and the
	// default export path calls a builder variable rather than defineProvider.
	if (
		operationsProperty === undefined &&
		isAlreadyTwoPhase(source, exportAssignment, call)
	) {
		return { status: "unchanged", kind: "two-phase", code: sourceText };
	}

	if (operationsProperty === undefined) {
		return {
			status: "skipped",
			reason:
				"The declaration has no `operations` key and the default export does not call a declaration builder, so the intended shape is ambiguous.",
		};
	}

	const operationsText = operationsPropertyValueText(operationsProperty, source);
	if (operationsText === undefined) {
		return {
			status: "skipped",
			reason:
				"The `operations` property uses a form the transform cannot relocate (getter, setter, method, spread, or computed name).",
		};
	}

	const shape = classifyShape(source, call, exportAssignment);
	if (shape.status === "skipped") {
		return shape;
	}

	const edits: TextEdit[] = [];
	const builderName = pickBuilderName(source);

	// 1. Remove `operations` from the declaration literal.
	edits.push(...removeOperationsProperty(operationsProperty, declaration, source));

	// 2. Bind the declaration to `const buildProvider = defineProvider({...})`.
	edits.push(...introduceBuilder(source, call, shape, builderName));

	// 3. Route the default export through `buildProvider({ operations })`.
	edits.push(
		...rewriteDefaultExport(source, exportAssignment, shape, builderName, operationsText),
	);

	// 4. `export type ProviderContext = ProviderContextOf<typeof buildProvider>;`
	//    plus the type-only import, when neither is already present.
	edits.push(...ensureProviderContextType(source, call, shape, builderName));

	const code = applyEdits(sourceText, edits);

	// Re-parse the output: a transform that emits unparseable source is worse
	// than one that skips, because the pin bump would ship alongside it.
	const verified = ts.createSourceFile(
		fileName,
		code,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const outputError = firstSyntaxError(verified);
	if (outputError !== undefined) {
		return {
			status: "skipped",
			reason: `Transform produced source that does not parse (${outputError}); refusing to emit a partial migration.`,
		};
	}

	return {
		status: "migrated",
		kind: shape.kind,
		code,
		operationsExpression: operationsText,
	};
}

type TextEdit = {
	readonly start: number;
	readonly end: number;
	readonly text: string;
};

type ShapeClassification =
	| {
			readonly status: "ok";
			readonly kind: Exclude<ProviderShapeKind, "two-phase">;
			/** Variable the declaration is currently bound to, when it is bound. */
			readonly variableName?: string;
			readonly variableStatement?: ts.VariableStatement;
			/** Extra properties on a `{ ...provider, deployment }` default export. */
			readonly spreadExportExtras?: string;
	  }
	| { readonly status: "skipped"; readonly reason: string };

function classifyShape(
	source: ts.SourceFile,
	call: ts.CallExpression,
	exportAssignment: ts.ExportAssignment,
): ShapeClassification {
	const variableStatement = enclosingVariableStatement(call);

	if (variableStatement === undefined) {
		// `export default defineProvider({...})`
		if (exportAssignment.expression === call) {
			return { status: "ok", kind: "single-phase-default-export" };
		}
		return {
			status: "skipped",
			reason:
				"defineProvider(...) is neither bound to a variable nor the default-export expression, so the transform cannot place the builder.",
		};
	}

	const declarations = variableStatement.declarationList.declarations;
	if (declarations.length !== 1) {
		return {
			status: "skipped",
			reason:
				"The defineProvider(...) result is declared alongside other bindings in one statement; split the declaration first.",
		};
	}
	const declaration = declarations[0];
	if (declaration === undefined || !ts.isIdentifier(declaration.name)) {
		return {
			status: "skipped",
			reason: "The defineProvider(...) result is bound to a destructuring pattern.",
		};
	}
	if (declaration.initializer !== call) {
		return {
			status: "skipped",
			reason:
				"defineProvider(...) is nested inside a larger initializer expression the transform cannot rewrite.",
		};
	}
	const variableName = declaration.name.text;

	const exported = exportAssignment.expression;

	if (ts.isIdentifier(exported) && exported.text === variableName) {
		return {
			status: "ok",
			kind: "single-phase-variable-export",
			variableName,
			variableStatement,
		};
	}

	if (ts.isObjectLiteralExpression(exported)) {
		const spreads = exported.properties.filter(ts.isSpreadAssignment);
		const spreadsProvider = spreads.some(
			(property) =>
				ts.isIdentifier(property.expression) &&
				property.expression.text === variableName,
		);
		if (!spreadsProvider) {
			return {
				status: "skipped",
				reason: `The default export is an object literal that does not spread \`${variableName}\`, so the provider value it exports is unclear.`,
			};
		}
		if (spreads.length > 1) {
			return {
				status: "skipped",
				reason:
					"The default export spreads more than one value; the transform cannot tell which carries the provider.",
			};
		}
		const extras = exported.properties.filter(
			(property) => !ts.isSpreadAssignment(property),
		);
		return {
			status: "ok",
			kind: "single-phase-variable-spread-export",
			variableName,
			variableStatement,
			spreadExportExtras: extras
				.map((property) => property.getText(source))
				.join(",\n  "),
		};
	}

	return {
		status: "skipped",
		reason: `The default export is neither \`${variableName}\` nor an object literal spreading it.`,
	};
}

function collectDefineProviderCalls(source: ts.SourceFile): ts.CallExpression[] {
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node): void => {
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

function findDefaultExport(source: ts.SourceFile): ts.ExportAssignment | undefined {
	for (const statement of source.statements) {
		if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) {
			return statement;
		}
	}
	return undefined;
}

function defaultExportCallsBuilder(
	exportAssignment: ts.ExportAssignment,
	declarationCall: ts.CallExpression,
): boolean {
	const expression = exportAssignment.expression;
	if (!ts.isCallExpression(expression)) return false;
	if (expression === declarationCall) return false;
	return ts.isIdentifier(expression.expression);
}

/**
 * True when the module is already in the two-phase shape: the default export
 * resolves to a builder-call result. Covers the three migrated layouts —
 * `export default buildProvider({...})`, an intermediate
 * `const provider = buildProvider({...}); export default provider;`, and the
 * spread export `export default { ...provider, deployment }` over such a
 * binding. Without the latter two, re-running the transform on its own
 * spread-shape output reports "ambiguous" instead of "unchanged", which
 * breaks idempotency for repeated fan-out runs.
 */
function isAlreadyTwoPhase(
	source: ts.SourceFile,
	exportAssignment: ts.ExportAssignment,
	declarationCall: ts.CallExpression,
): boolean {
	if (defaultExportCallsBuilder(exportAssignment, declarationCall)) return true;

	const exported = exportAssignment.expression;
	const candidateNames: string[] = [];
	if (ts.isIdentifier(exported)) {
		candidateNames.push(exported.text);
	} else if (ts.isObjectLiteralExpression(exported)) {
		for (const property of exported.properties) {
			if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
				candidateNames.push(property.expression.text);
			}
		}
	}
	if (candidateNames.length === 0) return false;

	// Does any spread/exported identifier bind a call to an identifier other
	// than defineProvider — i.e. a builder call?
	let found = false;
	const visit = (node: ts.Node): void => {
		if (found) return;
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			candidateNames.includes(node.name.text) &&
			node.initializer !== undefined &&
			ts.isCallExpression(node.initializer) &&
			node.initializer !== declarationCall &&
			ts.isIdentifier(node.initializer.expression) &&
			node.initializer.expression.text !== "defineProvider"
		) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

function findOperationsProperty(
	declaration: ts.ObjectLiteralExpression,
): ts.ObjectLiteralElementLike | undefined {
	for (const property of declaration.properties) {
		if (ts.isSpreadAssignment(property)) continue;
		const name = property.name;
		if (name === undefined) continue;
		if (
			(ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
			name.text === "operations"
		) {
			return property;
		}
	}
	return undefined;
}

/**
 * Source text of the value to hand the builder. Shorthand becomes the bare
 * identifier so `{ operations }` stays idiomatic; a property assignment keeps
 * its initializer verbatim, including a multi-line inline map.
 */
function operationsPropertyValueText(
	property: ts.ObjectLiteralElementLike,
	source: ts.SourceFile,
): string | undefined {
	if (ts.isShorthandPropertyAssignment(property)) {
		return property.name.text;
	}
	if (ts.isPropertyAssignment(property)) {
		return property.initializer.getText(source);
	}
	return undefined;
}

function removeOperationsProperty(
	property: ts.ObjectLiteralElementLike,
	declaration: ts.ObjectLiteralExpression,
	source: ts.SourceFile,
): TextEdit[] {
	const properties = declaration.properties;
	const index = properties.indexOf(property);
	const start = property.getFullStart();
	let end = property.getEnd();

	// Absorb the trailing comma so the remaining literal stays well-formed,
	// whether the key sat mid-list or last.
	const text = source.getFullText();
	let cursor = end;
	while (cursor < text.length && /\s/.test(text.charAt(cursor))) cursor += 1;
	if (text.charAt(cursor) === ",") {
		end = cursor + 1;
	} else if (index > 0) {
		// Last property with no trailing comma: drop the preceding one instead.
		const previous = properties[index - 1];
		if (previous !== undefined) {
			let back = previous.getEnd();
			while (back < text.length && /\s/.test(text.charAt(back))) back += 1;
			if (text.charAt(back) === ",") {
				return [{ start: back, end, text: "" }];
			}
		}
	}

	return [{ start, end, text: "" }];
}

function introduceBuilder(
	source: ts.SourceFile,
	call: ts.CallExpression,
	shape: Extract<ShapeClassification, { status: "ok" }>,
	builderName: string,
): TextEdit[] {
	if (shape.kind === "single-phase-default-export") {
		// `export default defineProvider({...})` becomes a standalone builder
		// declaration; the default export is re-appended separately.
		const exportStatement = call.parent;
		if (!ts.isExportAssignment(exportStatement)) return [];
		return [
			{
				start: exportStatement.getStart(source),
				end: call.getStart(source),
				text: `const ${builderName} = `,
			},
		];
	}

	const statement = shape.variableStatement;
	if (statement === undefined || shape.variableName === undefined) return [];

	// Rename the existing binding to the builder name. The old name is
	// re-introduced for the built provider only in the spread-export shape,
	// which needs an intermediate value to spread.
	const declaration = statement.declarationList.declarations[0];
	if (declaration === undefined || !ts.isIdentifier(declaration.name)) return [];
	return [
		{
			start: declaration.name.getStart(source),
			end: declaration.name.getEnd(),
			text: builderName,
		},
	];
}

function rewriteDefaultExport(
	source: ts.SourceFile,
	exportAssignment: ts.ExportAssignment,
	shape: Extract<ShapeClassification, { status: "ok" }>,
	builderName: string,
	operationsText: string,
): TextEdit[] {
	const operationsArgument =
		operationsText === "operations"
			? "{ operations }"
			: `{ operations: ${operationsText} }`;
	const call = `${builderName}(${operationsArgument})`;

	if (shape.kind === "single-phase-default-export") {
		// The builder declaration replaced the `export default` prefix; the
		// export itself is appended after what is now the builder statement.
		return [
			{
				start: exportAssignment.getEnd(),
				end: exportAssignment.getEnd(),
				text: `\n\nexport default ${call};`,
			},
		];
	}

	if (shape.kind === "single-phase-variable-export") {
		return [
			{
				start: exportAssignment.expression.getStart(source),
				end: exportAssignment.expression.getEnd(),
				text: call,
			},
		];
	}

	// Spread export: re-introduce the provider binding so the extra properties
	// (currently `deployment`) still spread over a built provider.
	const providerName = shape.variableName ?? "provider";
	const extras = shape.spreadExportExtras ?? "";
	const rebuilt =
		extras.length > 0
			? `{\n  ...${providerName},\n  ${extras},\n}`
			: `{ ...${providerName} }`;
	return [
		{
			start: exportAssignment.getStart(source),
			end: exportAssignment.getStart(source),
			text: `const ${providerName} = ${call};\n\n`,
		},
		{
			start: exportAssignment.expression.getStart(source),
			end: exportAssignment.expression.getEnd(),
			text: rebuilt,
		},
	];
}

/**
 * Add `export type ProviderContext = ProviderContextOf<typeof buildProvider>`
 * and the type-only import when absent. Operation handlers reference this
 * type, so a migration that omits it leaves the provider without the context
 * type the two-phase shape exists to provide.
 */
function ensureProviderContextType(
	source: ts.SourceFile,
	call: ts.CallExpression,
	shape: Extract<ShapeClassification, { status: "ok" }>,
	builderName: string,
): TextEdit[] {
	const text = source.getFullText();
	const edits: TextEdit[] = [];

	const hasContextTypeAlias = source.statements.some(
		(statement) =>
			ts.isTypeAliasDeclaration(statement) &&
			statement.name.text === PROVIDER_CONTEXT_TYPE_NAME,
	);

	if (!hasContextTypeAlias) {
		// After the builder statement — which is the variable statement when the
		// declaration was bound, or the rewritten export statement otherwise.
		const anchor =
			shape.variableStatement ??
			(ts.isExportAssignment(call.parent) ? call.parent : undefined);
		if (anchor !== undefined) {
			const insertAt = anchor.getEnd();
			edits.push({
				start: insertAt,
				end: insertAt,
				text: `\n\nexport type ${PROVIDER_CONTEXT_TYPE_NAME} = ${PROVIDER_CONTEXT_OF_TYPE_NAME}<typeof ${builderName}>;`,
			});
		}
	}

	if (text.includes(PROVIDER_CONTEXT_OF_TYPE_NAME)) {
		return edits;
	}

	const providerImport = findProviderSdkImport(source);
	if (providerImport === undefined) {
		// No named import from the provider subpath to extend; adding a new
		// import line without knowing the module's style is riskier than
		// leaving the type import to `bun run check` feedback.
		return edits;
	}
	const named = providerImport.importClause?.namedBindings;
	if (named === undefined || !ts.isNamedImports(named)) {
		return edits;
	}
	const last = named.elements[named.elements.length - 1];
	if (last === undefined) {
		return edits;
	}
	edits.push({
		start: last.getEnd(),
		end: last.getEnd(),
		text: `, type ${PROVIDER_CONTEXT_OF_TYPE_NAME}`,
	});
	return edits;
}

function findProviderSdkImport(
	source: ts.SourceFile,
): ts.ImportDeclaration | undefined {
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const moduleSpecifier = statement.moduleSpecifier;
		if (!ts.isStringLiteral(moduleSpecifier)) continue;
		if (moduleSpecifier.text !== PROVIDER_SDK_PROVIDER_SUBPATH) continue;
		const named = statement.importClause?.namedBindings;
		if (named !== undefined && ts.isNamedImports(named)) {
			const importsDefineProvider = named.elements.some(
				(element) => element.name.text === "defineProvider",
			);
			if (importsDefineProvider) return statement;
		}
	}
	return undefined;
}

/**
 * `buildProvider` unless the module already binds that name, in which case a
 * numbered suffix keeps the transform from shadowing an existing binding.
 */
function pickBuilderName(source: ts.SourceFile): string {
	const taken = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			taken.add(node.name.text);
		}
		if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
			taken.add(node.name.text);
		}
		if (ts.isImportSpecifier(node)) {
			taken.add(node.name.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);

	if (!taken.has(DECLARATION_BUILDER_NAME)) return DECLARATION_BUILDER_NAME;
	for (let suffix = 2; suffix < 100; suffix += 1) {
		const candidate = `${DECLARATION_BUILDER_NAME}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${DECLARATION_BUILDER_NAME}Migrated`;
}

function enclosingVariableStatement(node: ts.Node): ts.VariableStatement | undefined {
	let current: ts.Node | undefined = node.parent;
	while (current !== undefined) {
		if (ts.isVariableStatement(current)) return current;
		if (ts.isSourceFile(current)) return undefined;
		current = current.parent;
	}
	return undefined;
}

function firstSyntaxError(source: ts.SourceFile): string | undefined {
	const diagnostics = (
		source as ts.SourceFile & { parseDiagnostics?: ts.DiagnosticWithLocation[] }
	).parseDiagnostics;
	if (diagnostics === undefined || diagnostics.length === 0) return undefined;
	const first = diagnostics[0];
	if (first === undefined) return undefined;
	const message = ts.flattenDiagnosticMessageText(first.messageText, " ");
	const { line } = source.getLineAndCharacterOfPosition(first.start);
	return `${message} (line ${line + 1})`;
}

/** Apply edits back-to-front so earlier offsets stay valid. */
function applyEdits(text: string, edits: readonly TextEdit[]): string {
	const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
	let output = text;
	for (const edit of ordered) {
		output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
	}
	return output;
}
