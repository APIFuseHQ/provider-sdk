import type TS from "typescript";

const ts: typeof import("typescript") = await loadTypeScript();

async function loadTypeScript(): Promise<typeof import("typescript")> {
	try {
		return await import("typescript");
	} catch {
		console.error(
			"apifuse migrate-shape requires typescript; install it in the workspace running the CLI (bun add -d typescript)",
		);
		process.exit(1);
	}
}

/**
 * Operation authoring-shape migration.
 *
 * `defineOperation` / `defineStreamOperation` changed alongside the provider
 * builder in 2.2.0-beta.37: the identity helper became a curried,
 * context-typed factory.
 *
 *   before: defineOperation({ ...config })
 *   after:  defineOperation<ProviderContext>()({ ...config })
 *
 * The old call still type-checks against an older pin, but under the new SDK
 * it returns the INNER FACTORY FUNCTION with the config swallowed as an
 * ignored argument, so every operation in the map becomes a function and the
 * provider fails `finalizeProvider` with a misleading "declares neither
 * healthCheck nor healthCheckUnsupported" error. Measured fleet blast radius
 * (2026-08-29): 53 of 84 repositories, 450 legacy call sites.
 *
 * Same contract as the provider-shape transform: rewrite only what is fully
 * understood, report a reasoned skip otherwise, never emit a partial file.
 */

export type OperationShapeMigration =
	| {
			readonly status: "migrated";
			readonly code: string;
			/** Number of call sites rewritten in this file. */
			readonly rewrites: number;
			/** True when a `ProviderContext` type import was added. */
			readonly importAdded: boolean;
	  }
	| { readonly status: "unchanged"; readonly code: string }
	| { readonly status: "skipped"; readonly reason: string };

const OPERATION_HELPERS = new Set(["defineOperation", "defineStreamOperation"]);
const PROVIDER_CONTEXT_TYPE_NAME = "ProviderContext";
const PROVIDER_SDK_PROVIDER_SUBPATH = "@apifuse/provider-sdk/provider";

/**
 * Migrate legacy `defineOperation(config)` calls in one source file to the
 * curried `defineOperation<ProviderContext>()(config)` form.
 *
 * @param contextImportSpecifier module specifier the `ProviderContext` type
 * import should come from when one has to be added — `"../index"` for
 * operation modules, `"./index"` is never needed because index.ts declares
 * the alias itself. Callers pass the correct relative path per file.
 */
export function migrateOperationShape(
	sourceText: string,
	fileName: string,
	contextImportSpecifier: string,
): OperationShapeMigration {
	const source = ts.createSourceFile(
		fileName,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	const parseError = firstSyntaxError(source);
	if (parseError !== undefined) {
		return { status: "skipped", reason: parseError };
	}

	// Every legacy call site: a direct call to the bare helper identifier
	// whose single argument is the config (i.e. NOT the curried form, whose
	// outer call has zero arguments and optional type arguments).
	const legacyCalls: TS.CallExpression[] = [];
	let sawCurried = false;
	const visit = (node: TS.Node): void => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			OPERATION_HELPERS.has(node.expression.text)
		) {
			if (node.arguments.length === 0) {
				sawCurried = true; // already-migrated outer call
			} else {
				legacyCalls.push(node);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);

	if (legacyCalls.length === 0) {
		return { status: "unchanged", code: sourceText };
	}

	// A file mixing both forms almost certainly had a partial hand-migration;
	// refuse rather than guess which convention the author wants.
	if (sawCurried) {
		return {
			status: "skipped",
			reason:
				"File mixes legacy defineOperation(config) with curried defineOperation<...>()(config); migrate it by hand.",
		};
	}

	const declaresContextAlias = source.statements.some(
		(statement) =>
			ts.isTypeAliasDeclaration(statement) &&
			statement.name.text === PROVIDER_CONTEXT_TYPE_NAME,
	);
	const importsContext = sourceText.includes(PROVIDER_CONTEXT_TYPE_NAME);
	const needsImport = !declaresContextAlias && !importsContext;

	const edits: { start: number; end: number; text: string }[] = [];
	for (const call of legacyCalls) {
		// `defineOperation(` -> `defineOperation<ProviderContext>()(`
		const callee = call.expression;
		edits.push({
			start: callee.getEnd(),
			end: callee.getEnd(),
			text: `<${PROVIDER_CONTEXT_TYPE_NAME}>()`,
		});
	}

	let importAdded = false;
	if (needsImport) {
		const lastImport = [...source.statements]
			.reverse()
			.find((statement) => ts.isImportDeclaration(statement));
		const insertAt = lastImport ? lastImport.getEnd() : 0;
		const importText = `${lastImport ? "\n" : ""}import type { ${PROVIDER_CONTEXT_TYPE_NAME} } from "${contextImportSpecifier}";${lastImport ? "" : "\n"}`;
		edits.push({ start: insertAt, end: insertAt, text: importText });
		importAdded = true;
	}

	const ordered = edits.sort((a, b) => b.start - a.start);
	let code = sourceText;
	for (const edit of ordered) {
		code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
	}

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
		code,
		rewrites: legacyCalls.length,
		importAdded,
	};
}

function firstSyntaxError(source: TS.SourceFile): string | undefined {
	const diagnostics = (
		source as TS.SourceFile & { parseDiagnostics?: TS.DiagnosticWithLocation[] }
	).parseDiagnostics;
	if (diagnostics === undefined || diagnostics.length === 0) return undefined;
	const first = diagnostics[0];
	if (first === undefined) return undefined;
	const message = ts.flattenDiagnosticMessageText(first.messageText, " ");
	const { line } = source.getLineAndCharacterOfPosition(first.start);
	return `${message} (line ${line + 1})`;
}
