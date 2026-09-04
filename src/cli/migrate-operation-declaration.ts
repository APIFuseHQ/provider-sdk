import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

import type TS from "typescript";

import { assertProviderLocaleKey } from "../i18n/keys.js";
import { operationIdToLocaleNamespace } from "../i18n/operation-locale-namespace.js";

const ts: typeof import("typescript") = await loadTypeScript();

async function loadTypeScript(): Promise<typeof import("typescript")> {
	try {
		return await import("typescript");
	} catch {
		console.error(
			"apifuse migrate-operation-declaration requires typescript; install it in the workspace running the CLI (bun add -d typescript)",
		);
		process.exit(1);
	}
}

const OPERATION_HELPERS = new Set(["defineOperation", "defineStreamOperation"]);
const SAFETY_VALUES = new Set(["read", "write", "destructive", "external-send"]);
const DOCS_FIELDS = new Set([
	"titleKey",
	"descriptionKey",
	"summaryKey",
	"markdownKey",
	"normalizationNotesKeys",
	"errorCodes",
]);
const ANNOTATION_FIELDS = new Set([
	"destructive",
	"readOnly",
	"openWorld",
	"idempotent",
	"rateLimit",
	"timeoutMs",
]);
const TOOL_ROUTER_FIELDS = new Set([
	"name",
	"riskClass",
	"approval",
	"connectionMode",
	"connectionExternalRefParam",
	"requiresConnection",
]);
const TOP_LEVEL_DELETIONS = new Set(["derivations", "retryOnAuthRefresh", "title", "description"]);
const SOURCE_SKIP_DIRECTORIES = new Set([
	"node_modules",
	"__tests__",
	"__fixtures__",
	".git",
	"dist",
]);
const SIDECAR_NAME = "migrate-operation-declaration.locales-todo.json";

export type OperationDeclarationRefusalReason =
	| "no_safety"
	| "safety_conflict"
	| "locale_key_conflict"
	| "connection_mode_conflict"
	| "execution_conflict"
	| "approval_conflict"
	| "non_literal"
	| "unsupported_member"
	| "factory_composed_operations"
	| "source_syntax"
	| "codemod_syntax"
	| "missing_english_locale"
	| "operation_id_unresolved"
	| "factory_operation_id_ambiguous"
	| "no_operations_discovered"
	| "examples_conflict"
	| "invalid_locale_key"
	| "locale_todo_conflict";

export type OperationDeclarationRefusal = {
	readonly file: string;
	readonly operationKey: string;
	readonly reason: OperationDeclarationRefusalReason;
	readonly detail: string;
};

export type LocaleTodo = {
	readonly localeFile: string;
	readonly operationKey: string;
	readonly key: string;
	readonly originalProse: string;
};

export type OperationDeclarationMigration =
	| {
			readonly status: "migrated";
			readonly code: string;
			readonly operations: number;
			readonly localeTodos: readonly LocaleTodo[];
	  }
	| {
			readonly status: "unchanged";
			readonly code: string;
			readonly operations: number;
	  }
	| {
			readonly status: "refused";
			readonly refusals: readonly OperationDeclarationRefusal[];
	  };

export type OperationDeclarationMigrationOptions = {
	/** Exact operation ids proven from a static operations map, keyed by local binding name. */
	readonly operationIds?: ReadonlyMap<string, string>;
	/** Locale paths relative to the provider root. */
	readonly localeFiles?: readonly string[];
};

type TextEdit = {
	readonly start: number;
	readonly end: number;
	readonly text: string;
};

type ResolvedMember = {
	readonly name: string;
	readonly property: TS.ObjectLiteralElementLike;
	readonly initializer?: TS.Expression;
	readonly fromSpread?: boolean;
	readonly source: TS.SourceFile;
};

type StaticObjectReference = {
	readonly object: TS.ObjectLiteralExpression;
	readonly source: TS.SourceFile;
};

type StaticObjectResolver = (
	expression: TS.Expression,
	source: TS.SourceFile,
) => StaticObjectReference | undefined;

type RepositoryMigrationContext = {
	readonly operationSites?: ReadonlyMap<number, string>;
	readonly excludedBindings?: ReadonlySet<string>;
	readonly staticObjectResolver?: StaticObjectResolver;
	readonly runtimeComposedInitializers?: ReadonlySet<number>;
	readonly recordDiscoveredSites?: (count: number) => void;
};

type OperationSite = {
	readonly object: TS.ObjectLiteralExpression;
	operationKey: string;
	readonly bindingName?: string;
	readonly operationIdProven: boolean;
};

type PlannedOperation = {
	readonly edits: readonly TextEdit[];
	readonly localeTodos: readonly LocaleTodo[];
};

/**
 * Rewrite every operation declaration in one TypeScript module.
 *
 * The function is file-atomic: a single refusal discards every planned edit.
 * It uses AST ranges as a string/comment/template-aware brace balancer and
 * copies every untouched source slice byte-for-byte.
 */
export function migrateOperationDeclaration(
	sourceText: string,
	fileName: string,
	options: OperationDeclarationMigrationOptions = {},
): OperationDeclarationMigration {
	return migrateOperationDeclarationInternal(sourceText, fileName, options);
}

function migrateOperationDeclarationInternal(
	sourceText: string,
	fileName: string,
	options: OperationDeclarationMigrationOptions,
	context: RepositoryMigrationContext = {},
): OperationDeclarationMigration {
	const source = parseSource(fileName, sourceText);
	const parseError = firstSyntaxError(source);
	if (parseError !== undefined) {
		return {
			status: "refused",
			refusals: [refusal(fileName, "<unknown>", "source_syntax", parseError)],
		};
	}

	const constObjects = collectModuleConstObjects(source);
	const constArrays = collectModuleConstArrays(source);
	const discovery = discoverOperationSites(
		source,
		fileName,
		constObjects,
		options.operationIds,
		context.operationSites,
		context.excludedBindings,
		context.runtimeComposedInitializers,
	);
	context.recordDiscoveredSites?.(discovery.discoveredCount);
	if (discovery.refusals.length > 0) {
		return { status: "refused", refusals: discovery.refusals };
	}

	const edits: TextEdit[] = [];
	const todos: LocaleTodo[] = [];
	const refusals: OperationDeclarationRefusal[] = [];
	for (const site of discovery.sites) {
		const plan = planOperationMigration(
			source,
			fileName,
			site,
			constObjects,
			constArrays,
			options.localeFiles ?? [],
			context.staticObjectResolver,
		);
		if ("refusal" in plan) {
			refusals.push(plan.refusal);
			continue;
		}
		edits.push(...plan.edits);
		todos.push(...plan.localeTodos);
	}
	if (refusals.length > 0) return { status: "refused", refusals };
	const invalidLocaleKey = findInvalidLocaleTodo(todos, fileName);
	if (invalidLocaleKey !== undefined) {
		return { status: "refused", refusals: [invalidLocaleKey] };
	}

	if (edits.length === 0) {
		return {
			status: "unchanged",
			code: sourceText,
			operations: discovery.sites.length,
		};
	}

	const normalizedEdits = normalizeEdits(edits, fileName);
	if ("refusal" in normalizedEdits) {
		return { status: "refused", refusals: [normalizedEdits.refusal] };
	}

	const code = applyEdits(sourceText, normalizedEdits.edits);
	const outputRefusal = verifyOperationDeclarationRewrite(code, fileName);
	if (outputRefusal !== undefined) {
		return {
			status: "refused",
			refusals: [outputRefusal],
		};
	}

	return {
		status: "migrated",
		code,
		operations: discovery.sites.length,
		localeTodos: todos,
	};
}

/** Parse a proposed rewrite and classify a codemod-introduced syntax failure. */
export function verifyOperationDeclarationRewrite(
	code: string,
	fileName: string,
): OperationDeclarationRefusal | undefined {
	const outputError = firstSyntaxError(parseSource(fileName, code));
	if (outputError === undefined) return undefined;
	return refusal(
		fileName,
		"<file>",
		"codemod_syntax",
		`Transform output did not parse: ${outputError}`,
	);
}

function planOperationMigration(
	source: TS.SourceFile,
	fileName: string,
	site: OperationSite,
	constObjects: ReadonlyMap<string, TS.ObjectLiteralExpression>,
	constArrays: ReadonlyMap<string, TS.ArrayLiteralExpression>,
	localeFiles: readonly string[],
	staticObjectResolver?: StaticObjectResolver,
): PlannedOperation | { readonly refusal: OperationDeclarationRefusal } {
	if (site.object.properties.some(ts.isSpreadAssignment)) {
		return {
			refusal: refusal(
				fileName,
				site.operationKey,
				"non_literal",
				"Top-level operation spreads cannot be rewritten without changing their shared declaration.",
			),
		};
	}
	const expanded = expandMembers(
		site.object,
		source,
		constObjects,
		fileName,
		site.operationKey,
		staticObjectResolver,
	);
	if ("refusal" in expanded) return expanded;

	const top = indexMembers(expanded.members, fileName, site.operationKey);
	if ("refusal" in top) return top;
	if (top.spreads.length > 0) {
		return {
			refusal: refusal(
				fileName,
				site.operationKey,
				"non_literal",
				"Top-level operation spreads cannot be rewritten without changing their shared declaration.",
			),
		};
	}

	const containers = new Map<string, ResolvedMember[]>();
	for (const containerName of ["annotations", "toolRouter", "docs"] as const) {
		const member = top.byName.get(containerName);
		if (member === undefined) continue;
		const resolvedObject = resolveObjectInitializer(
			member,
			source,
			constObjects,
			staticObjectResolver,
		);
		if (resolvedObject === undefined) {
			return {
				refusal: refusal(
					fileName,
					site.operationKey,
					"non_literal",
					`${containerName} must be an object literal or a module-level const object literal.`,
				),
			};
		}
		const members = expandMembers(
			resolvedObject.object,
			resolvedObject.source,
			constObjects,
			fileName,
			site.operationKey,
			staticObjectResolver,
		);
		if ("refusal" in members) return members;
		const indexed = indexMembers(members.members, fileName, site.operationKey);
		if ("refusal" in indexed) return indexed;
		if (indexed.spreads.length > 0) {
			return {
				refusal: refusal(
					fileName,
					site.operationKey,
					"non_literal",
					`${containerName} contains an unresolved spread.`,
				),
			};
		}
		containers.set(containerName, members.members);
	}

	const annotations = memberMap(containers.get("annotations") ?? []);
	const toolRouter = memberMap(containers.get("toolRouter") ?? []);
	const docs = memberMap(containers.get("docs") ?? []);
	const unknownAnnotation = firstUnknown(annotations, ANNOTATION_FIELDS);
	if (unknownAnnotation !== undefined) {
		return unsupportedContainerMember(
			fileName,
			site.operationKey,
			"annotations",
			unknownAnnotation,
		);
	}
	const unknownTool = firstUnknown(toolRouter, TOOL_ROUTER_FIELDS);
	if (unknownTool !== undefined) {
		return unsupportedContainerMember(fileName, site.operationKey, "toolRouter", unknownTool);
	}
	const unknownDocs = firstUnknown(
		docs,
		new Set([...DOCS_FIELDS, "requestExample", "responseExample"]),
	);
	if (unknownDocs !== undefined) {
		return unsupportedContainerMember(fileName, site.operationKey, "docs", unknownDocs);
	}

	const risk = resolveRiskClass(top.byName, annotations, toolRouter, fileName, site.operationKey);
	if ("refusal" in risk) return risk;

	const insertions = new Map<string, { source: string; text: string }[]>();
	const removals: TS.ObjectLiteralElementLike[] = [];
	const nestedContainers = ["annotations", "toolRouter", "docs"] as const;
	for (const name of nestedContainers) {
		const member = top.byName.get(name);
		if (member !== undefined) removals.push(member.property);
	}
	for (const name of TOP_LEVEL_DELETIONS) {
		const member = top.byName.get(name);
		if (member !== undefined) removals.push(member.property);
	}

	if (top.byName.get("riskClass") === undefined) {
		const sourceContainer = risk.source === "annotations" ? "annotations" : "toolRouter";
		addInsertion(insertions, sourceContainer, `riskClass: ${risk.text}`);
	}

	const timeout = mergeFlatAndNested(
		"timeoutMs",
		top.byName.get("timeoutMs"),
		annotations.get("timeoutMs"),
		fileName,
		site.operationKey,
		"execution_conflict",
	);
	if ("refusal" in timeout) return timeout;
	if (timeout.insert !== undefined) addInsertion(insertions, "annotations", timeout.insert);

	const connection = resolveConnectionMode(top.byName, toolRouter, fileName, site.operationKey);
	if ("refusal" in connection) return connection;
	if (connection.insert !== undefined) {
		addInsertion(insertions, "toolRouter", connection.insert);
	}

	const externalRef = mergeFlatAndNested(
		"connectionExternalRefParam",
		top.byName.get("connectionExternalRefParam"),
		toolRouter.get("connectionExternalRefParam"),
		fileName,
		site.operationKey,
		"connection_mode_conflict",
	);
	if ("refusal" in externalRef) return externalRef;
	if (externalRef.insert !== undefined) {
		addInsertion(insertions, "toolRouter", externalRef.insert);
	}

	const approval = resolveApproval(
		top.byName.get("approval"),
		toolRouter.get("approval"),
		risk.value,
		fileName,
		site.operationKey,
	);
	if ("refusal" in approval) return approval;
	if (approval.removeTop !== undefined) removals.push(approval.removeTop);
	if (approval.insert !== undefined) addInsertion(insertions, "toolRouter", approval.insert);

	for (const field of DOCS_FIELDS) {
		const merged = mergeFlatAndNested(
			field,
			top.byName.get(field),
			docs.get(field),
			fileName,
			site.operationKey,
			"locale_key_conflict",
		);
		if ("refusal" in merged) return merged;
		if (merged.insert !== undefined) addInsertion(insertions, "docs", merged.insert);
	}

	const title = planTitleLocale(
		top.byName.get("title"),
		top.byName.get("titleKey"),
		docs.get("titleKey"),
		fileName,
		site,
		localeFiles,
	);
	if ("refusal" in title) return title;
	const localeNamespace =
		top.byName.get("inputExamples") === undefined
			? { namespace: site.operationKey }
			: resolveOperationLocaleNamespace(
					[
						top.byName.get("titleKey"),
						docs.get("titleKey"),
						top.byName.get("descriptionKey"),
						docs.get("descriptionKey"),
					],
					fileName,
					site,
				);
	if ("refusal" in localeNamespace) return localeNamespace;

	const examples = planExamples(
		top.byName.get("inputExamples"),
		top.byName.get("examples"),
		fileName,
		site,
		source,
		constArrays,
		localeFiles,
		localeNamespace.namespace,
	);
	if ("refusal" in examples) return examples;

	const edits: TextEdit[] = [...examples.edits];
	for (const containerName of nestedContainers) {
		const member = top.byName.get(containerName);
		if (member === undefined) continue;
		const generated = insertions.get(containerName) ?? [];
		if (generated.length === 0) continue;
		const indentation = indentationAt(source.getFullText(), member.property.getStart(source));
		edits.push({
			start: member.property.getStart(source),
			end: member.property.getEnd(),
			text: generated.map((item) => item.text).join(`,\n${indentation}`),
		});
		removeFirst(removals, member.property);
	}

	const removalEdits = removalRanges(site.object, removals, source);
	for (const edit of removalEdits) {
		if (!edits.some((existing) => rangesOverlap(existing, edit))) edits.push(edit);
	}

	return { edits, localeTodos: [...title.localeTodos, ...examples.localeTodos] };
}

function planTitleLocale(
	title: ResolvedMember | undefined,
	flatTitleKey: ResolvedMember | undefined,
	nestedTitleKey: ResolvedMember | undefined,
	fileName: string,
	site: OperationSite,
	localeFiles: readonly string[],
):
	| { readonly localeTodos: readonly LocaleTodo[] }
	| { readonly refusal: OperationDeclarationRefusal } {
	if (title === undefined) return { localeTodos: [] };
	const originalProse = literalString(title.initializer);
	if (originalProse === undefined) {
		return nonLiteral(
			fileName,
			site.operationKey,
			"title must be a string literal so its authored prose can be preserved in the English locale catalog.",
		);
	}
	if (!site.operationIdProven) {
		return {
			refusal: refusal(
				fileName,
				site.operationKey,
				"operation_id_unresolved",
				"title requires an exact operation id proven from a static operations map.",
			),
		};
	}
	if (!localeFiles.includes("locales/en.json")) {
		return {
			refusal: refusal(
				fileName,
				site.operationKey,
				"missing_english_locale",
				"title cannot be migrated because locales/en.json does not exist.",
			),
		};
	}

	let selectedTitleKey = flatTitleKey ?? nestedTitleKey;
	if (flatTitleKey !== undefined && nestedTitleKey !== undefined) {
		const same = equivalentLiteral(flatTitleKey.initializer, nestedTitleKey.initializer);
		if (same === undefined) {
			return nonLiteral(
				fileName,
				site.operationKey,
				"titleKey must be literal when both top-level and nested declarations exist.",
			);
		}
		if (!same) {
			return {
				refusal: refusal(
					fileName,
					site.operationKey,
					"locale_key_conflict",
					"Top-level titleKey conflicts with nested titleKey.",
				),
			};
		}
		selectedTitleKey = flatTitleKey;
	}
	const explicitTitleKey =
		selectedTitleKey === undefined ? undefined : literalString(selectedTitleKey.initializer);
	if (selectedTitleKey !== undefined && explicitTitleKey === undefined) {
		return nonLiteral(
			fileName,
			site.operationKey,
			"titleKey must be a string literal so the title locale destination is provable.",
		);
	}
	let selectedTitleLocaleKey: string;
	if (explicitTitleKey !== undefined) {
		selectedTitleLocaleKey = explicitTitleKey;
	} else {
		try {
			selectedTitleLocaleKey = `operations.${operationIdToLocaleNamespace(site.operationKey)}.title`;
		} catch (error) {
			return {
				refusal: invalidLocaleKeyRefusal(
					fileName,
					site.operationKey,
					`operations.${site.operationKey}.title`,
					error,
				),
			};
		}
	}
	return {
		localeTodos: [
			{
				localeFile: "locales/en.json",
				operationKey: site.operationKey,
				key: selectedTitleLocaleKey,
				originalProse,
			},
		],
	};
}

function resolveRiskClass(
	top: ReadonlyMap<string, ResolvedMember>,
	annotations: ReadonlyMap<string, ResolvedMember>,
	toolRouter: ReadonlyMap<string, ResolvedMember>,
	fileName: string,
	operationKey: string,
):
	| {
			readonly value: string;
			readonly text: string;
			readonly source: "top" | "toolRouter" | "annotations";
	  }
	| { readonly refusal: OperationDeclarationRefusal } {
	const topRisk = top.get("riskClass");
	const toolRisk = toolRouter.get("riskClass");
	let declared: { member: ResolvedMember; source: "top" | "toolRouter" } | undefined;
	if (topRisk !== undefined && toolRisk !== undefined) {
		const topValue = literalString(topRisk.initializer);
		const toolValue = literalString(toolRisk.initializer);
		if (topValue === undefined || toolValue === undefined) {
			return nonLiteral(fileName, operationKey, "riskClass must be a string literal.");
		}
		if (topValue !== toolValue) {
			return {
				refusal: refusal(
					fileName,
					operationKey,
					"safety_conflict",
					`Top-level riskClass ${JSON.stringify(topValue)} conflicts with toolRouter.riskClass ${JSON.stringify(toolValue)}.`,
				),
			};
		}
		declared = { member: topRisk, source: "top" };
	} else if (topRisk !== undefined) {
		declared = { member: topRisk, source: "top" };
	} else if (toolRisk !== undefined) {
		declared = { member: toolRisk, source: "toolRouter" };
	}

	const destructive = literalBooleanMember(
		annotations.get("destructive"),
		fileName,
		operationKey,
		"annotations.destructive",
	);
	if ("refusal" in destructive) return destructive;
	const readOnly = literalBooleanMember(
		annotations.get("readOnly"),
		fileName,
		operationKey,
		"annotations.readOnly",
	);
	if ("refusal" in readOnly) return readOnly;

	if (declared !== undefined) {
		const value = literalString(declared.member.initializer);
		if (value === undefined || !SAFETY_VALUES.has(value)) {
			return nonLiteral(
				fileName,
				operationKey,
				"riskClass must be a literal read, write, destructive, or external-send value.",
			);
		}
		if (destructive.value === true && value !== "destructive") {
			return {
				refusal: refusal(
					fileName,
					operationKey,
					"safety_conflict",
					`Declared riskClass ${JSON.stringify(value)} contradicts annotations.destructive: true.`,
				),
			};
		}
		return {
			value,
			text: declared.member.initializer?.getText() ?? JSON.stringify(value),
			source: declared.source,
		};
	}

	if (destructive.value === true) {
		return { value: "destructive", text: '"destructive"', source: "annotations" };
	}
	if (readOnly.value === true) {
		return { value: "read", text: '"read"', source: "annotations" };
	}
	return {
		refusal: refusal(
			fileName,
			operationKey,
			"no_safety",
			"No authored riskClass, annotations.destructive: true, or annotations.readOnly: true declaration exists; refusing to invent write.",
		),
	};
}

function resolveConnectionMode(
	top: ReadonlyMap<string, ResolvedMember>,
	toolRouter: ReadonlyMap<string, ResolvedMember>,
	fileName: string,
	operationKey: string,
): { readonly insert?: string } | { readonly refusal: OperationDeclarationRefusal } {
	const flat = top.get("connectionMode");
	const nested = toolRouter.get("connectionMode");
	if (flat !== undefined && nested !== undefined) {
		const same = equivalentLiteral(flat.initializer, nested.initializer);
		if (same === undefined) {
			return nonLiteral(
				fileName,
				operationKey,
				"Conflicting connectionMode declarations must be literal values.",
			);
		}
		if (!same) {
			return {
				refusal: refusal(
					fileName,
					operationKey,
					"connection_mode_conflict",
					"Top-level connectionMode conflicts with toolRouter.connectionMode.",
				),
			};
		}
		return {};
	}
	if (flat !== undefined) return {};
	if (nested !== undefined) {
		return { insert: memberText(nested, "connectionMode") };
	}

	const required = toolRouter.get("requiresConnection");
	if (required === undefined) return {};
	const value = literalBooleanMember(
		required,
		fileName,
		operationKey,
		"toolRouter.requiresConnection",
	);
	if ("refusal" in value) return value;
	return { insert: `connectionMode: ${value.value ? '"required"' : '"none"'}` };
}

function resolveApproval(
	flat: ResolvedMember | undefined,
	nested: ResolvedMember | undefined,
	riskClass: string,
	fileName: string,
	operationKey: string,
):
	| { readonly insert?: string; readonly removeTop?: TS.ObjectLiteralElementLike }
	| { readonly refusal: OperationDeclarationRefusal } {
	let selected = flat ?? nested;
	if (flat !== undefined && nested !== undefined) {
		const same = equivalentLiteral(flat.initializer, nested.initializer);
		if (same === undefined) {
			return nonLiteral(fileName, operationKey, "approval declarations must be string literals.");
		}
		if (!same) {
			return {
				refusal: refusal(
					fileName,
					operationKey,
					"approval_conflict",
					"Top-level approval conflicts with toolRouter.approval.",
				),
			};
		}
		selected = flat;
	}
	if (selected === undefined) return {};
	const value = literalString(selected.initializer);
	if (value === undefined) {
		return nonLiteral(fileName, operationKey, "approval must be a string literal.");
	}
	const defaultValue = defaultApprovalPolicy(riskClass);
	if (value === defaultValue) {
		return flat === undefined ? {} : { removeTop: flat.property };
	}
	if (flat !== undefined) return {};
	return { insert: memberText(selected, "approval") };
}

function defaultApprovalPolicy(riskClass: string): string {
	if (riskClass === "read") return "never";
	if (riskClass === "write") return "risk-based";
	return "always";
}

function mergeFlatAndNested(
	field: string,
	flat: ResolvedMember | undefined,
	nested: ResolvedMember | undefined,
	fileName: string,
	operationKey: string,
	reason: "locale_key_conflict" | "connection_mode_conflict" | "execution_conflict",
): { readonly insert?: string } | { readonly refusal: OperationDeclarationRefusal } {
	if (nested === undefined) return {};
	if (flat === undefined) return { insert: memberText(nested, field) };
	const same = equivalentLiteral(flat.initializer, nested.initializer);
	if (same === undefined) {
		return nonLiteral(
			fileName,
			operationKey,
			`${field} must be literal when both top-level and nested declarations exist.`,
		);
	}
	if (!same) {
		// A shared imported docs template is intentionally lower-precedence than
		// an operation's explicit flat locale key. Keep direct-vs-direct
		// conflicts fail-closed, but do not let a spread default replace the
		// operation-specific key during flattening.
		if (reason === "locale_key_conflict" && nested.fromSpread === true) return {};
		return {
			refusal: refusal(
				fileName,
				operationKey,
				reason,
				`Top-level ${field} conflicts with nested ${field}.`,
			),
		};
	}
	return {};
}

function planExamples(
	inputExamples: ResolvedMember | undefined,
	existingExamples: ResolvedMember | undefined,
	fileName: string,
	site: OperationSite,
	source: TS.SourceFile,
	constArrays: ReadonlyMap<string, TS.ArrayLiteralExpression>,
	localeFiles: readonly string[],
	localeNamespace: string,
):
	| { readonly edits: readonly TextEdit[]; readonly localeTodos: readonly LocaleTodo[] }
	| { readonly refusal: OperationDeclarationRefusal } {
	if (inputExamples === undefined) return { edits: [], localeTodos: [] };
	if (existingExamples !== undefined) {
		return {
			refusal: refusal(
				fileName,
				site.operationKey,
				"examples_conflict",
				"Both inputExamples and examples are declared.",
			),
		};
	}
	const array = unwrapExpression(inputExamples.initializer);
	if (array === undefined || !ts.isArrayLiteralExpression(array)) {
		return nonLiteral(fileName, site.operationKey, "inputExamples must be an array literal.");
	}
	const expanded = expandArrayElements(array, constArrays, fileName, site.operationKey);
	if ("refusal" in expanded) return expanded;
	if (expanded.elements.length > 0 && !site.operationIdProven) {
		return {
			refusal: refusal(
				fileName,
				site.operationKey,
				"operation_id_unresolved",
				"inputExamples requires an exact operation id proven from a static operations map.",
			),
		};
	}
	if (expanded.elements.length > 0 && !localeFiles.includes("locales/en.json")) {
		return {
			refusal: refusal(
				fileName,
				site.operationKey,
				"missing_english_locale",
				"inputExamples cannot be migrated because locales/en.json does not exist.",
			),
		};
	}

	const edits: TextEdit[] = [];
	const todos: LocaleTodo[] = [];
	const propertyNameNode = inputExamples.property.name;
	if (propertyNameNode === undefined) {
		return nonLiteral(
			fileName,
			site.operationKey,
			"inputExamples uses an unsupported property name.",
		);
	}
	edits.push({
		start: propertyNameNode.getStart(source),
		end: propertyNameNode.getEnd(),
		text: "examples",
	});

	for (let index = 0; index < expanded.elements.length; index += 1) {
		const element = expanded.elements[index];
		const object = element === undefined ? undefined : unwrapExpression(element);
		if (object === undefined || !ts.isObjectLiteralExpression(object)) {
			return nonLiteral(
				fileName,
				site.operationKey,
				`inputExamples[${index}] must be an object literal.`,
			);
		}
		const members = indexMembersFromObject(object, fileName, site.operationKey);
		if ("refusal" in members) return members;
		const allowed = new Set(["scenario", "input", "rationale"]);
		const unknown = firstUnknown(members.byName, allowed);
		if (unknown !== undefined) {
			return unsupportedContainerMember(
				fileName,
				site.operationKey,
				`inputExamples[${index}]`,
				unknown,
			);
		}
		const scenario = members.byName.get("scenario");
		const input = members.byName.get("input");
		if (scenario === undefined || input === undefined) {
			return nonLiteral(
				fileName,
				site.operationKey,
				`inputExamples[${index}] must declare scenario and input.`,
			);
		}
		const scenarioProse = literalString(scenario.initializer);
		if (scenarioProse === undefined) {
			return nonLiteral(
				fileName,
				site.operationKey,
				`inputExamples[${index}].scenario must be a string literal.`,
			);
		}
		const scenarioKey = `operations.${localeNamespace}.examples.${index}.scenario`;
		edits.push(replaceExampleLocaleMember(scenario, "scenarioKey", scenarioKey, source));
		for (const localeFile of localeFiles) {
			todos.push({
				localeFile,
				operationKey: site.operationKey,
				key: scenarioKey,
				originalProse: scenarioProse,
			});
		}

		const rationale = members.byName.get("rationale");
		if (rationale !== undefined) {
			const rationaleProse = literalString(rationale.initializer);
			if (rationaleProse === undefined) {
				return nonLiteral(
					fileName,
					site.operationKey,
					`inputExamples[${index}].rationale must be a string literal.`,
				);
			}
			const rationaleKey = `operations.${localeNamespace}.examples.${index}.rationale`;
			edits.push(replaceExampleLocaleMember(rationale, "rationaleKey", rationaleKey, source));
			for (const localeFile of localeFiles) {
				todos.push({
					localeFile,
					operationKey: site.operationKey,
					key: rationaleKey,
					originalProse: rationaleProse,
				});
			}
		}
	}
	return { edits, localeTodos: todos };
}

function resolveOperationLocaleNamespace(
	members: readonly (ResolvedMember | undefined)[],
	fileName: string,
	site: OperationSite,
): { readonly namespace: string } | { readonly refusal: OperationDeclarationRefusal } {
	const authoredNamespaces = new Set<string>();
	const directMembers = members.filter(
		(member) => member !== undefined && member.fromSpread !== true,
	);
	const namespaceMembers = directMembers.length > 0 ? directMembers : members;
	for (const member of namespaceMembers) {
		const localeKey = literalString(member?.initializer);
		if (localeKey === undefined) continue;
		const segments = localeKey.split(".");
		if (segments[0] === "operations" && segments[1] !== undefined) {
			authoredNamespaces.add(segments[1]);
		}
	}
	if (authoredNamespaces.size > 1) {
		return {
			refusal: refusal(
				fileName,
				site.operationKey,
				"locale_key_conflict",
				`Operation titleKey and descriptionKey declarations use different locale namespaces: ${[...authoredNamespaces].join(", ")}.`,
			),
		};
	}
	const authored = authoredNamespaces.values().next().value;
	if (authored !== undefined) return { namespace: authored };
	// planExamples proves the id before using this placeholder to construct a
	// locale key. Avoid validating an unproven binding such as <anonymous> as
	// though it were an authored operation id.
	if (!site.operationIdProven) return { namespace: site.operationKey };

	try {
		return { namespace: operationIdToLocaleNamespace(site.operationKey) };
	} catch (error) {
		return {
			refusal: invalidLocaleKeyRefusal(
				fileName,
				site.operationKey,
				`operations.${site.operationKey}.examples`,
				error,
			),
		};
	}
}

function replaceExampleLocaleMember(
	member: ResolvedMember,
	newName: string,
	localeKey: string,
	source: TS.SourceFile,
): TextEdit {
	return {
		start: member.property.getStart(source),
		end: member.property.getEnd(),
		text: `${newName}: ${JSON.stringify(localeKey)}`,
	};
}

function discoverOperationSites(
	source: TS.SourceFile,
	fileName: string,
	constObjects: ReadonlyMap<string, TS.ObjectLiteralExpression>,
	operationIds: ReadonlyMap<string, string> | undefined,
	operationSites: ReadonlyMap<number, string> | undefined,
	excludedBindings: ReadonlySet<string> | undefined,
	runtimeComposedInitializers: ReadonlySet<number> | undefined,
): {
	readonly sites: OperationSite[];
	readonly discoveredCount: number;
	readonly refusals: OperationDeclarationRefusal[];
} {
	const sitesByStart = new Map<number, OperationSite>();
	const discoveredStarts = new Set<number>();
	const localIds = new Map(operationIds ?? []);
	const localExcludedBindings = new Set(excludedBindings ?? []);
	const refusals: OperationDeclarationRefusal[] = [];
	const operationFactories = collectSimpleOperationFactories(source);
	const factoryCallIds = new Map<string, Set<string>>();

	for (const map of collectOperationsMaps(
		source,
		constObjects,
		fileName,
		refusals,
		runtimeComposedInitializers,
	)) {
		for (const property of map.properties) {
			if (ts.isSpreadAssignment(property)) continue;
			const key = staticPropertyName(property.name);
			if (key === undefined) {
				refusals.push(
					refusal(
						fileName,
						"<computed>",
						"non_literal",
						"An operations map uses a computed operation key.",
					),
				);
				continue;
			}
			const value = propertyValue(property);
			if (value === undefined) continue;
			const unwrapped = unwrapExpression(value);
			if (unwrapped === undefined) continue;
			if (ts.isIdentifier(unwrapped)) {
				localIds.set(unwrapped.text, key);
				continue;
			}
			const operationObject = operationObjectFromExpression(unwrapped);
			if (operationObject !== undefined) {
				sitesByStart.set(operationObject.getStart(source), {
					object: operationObject,
					operationKey: key,
					operationIdProven: true,
				});
				continue;
			}
			if (
				ts.isCallExpression(unwrapped) &&
				ts.isIdentifier(unwrapped.expression) &&
				operationFactories.has(unwrapped.expression.text) &&
				!localExcludedBindings.has(unwrapped.expression.text)
			) {
				const factoryName = unwrapped.expression.text;
				const operationIdsForFactory = factoryCallIds.get(factoryName) ?? new Set<string>();
				operationIdsForFactory.add(key);
				factoryCallIds.set(factoryName, operationIdsForFactory);
				continue;
			}
			if (ts.isObjectLiteralExpression(unwrapped)) {
				sitesByStart.set(unwrapped.getStart(source), {
					object: unwrapped,
					operationKey: key,
					operationIdProven: true,
				});
			}
		}
	}
	for (const [factoryName, operationIdsForFactory] of factoryCallIds) {
		const ids = [...operationIdsForFactory];
		if (ids.length === 1) {
			const operationId = ids[0];
			if (operationId !== undefined) localIds.set(factoryName, operationId);
			continue;
		}
		localExcludedBindings.add(factoryName);
		refusals.push(
			refusal(
				fileName,
				factoryName,
				"factory_operation_id_ambiguous",
				`Factory ${factoryName} is registered under multiple operation ids: ${ids
					.map((id) => JSON.stringify(id))
					.join(", ")}. A shared operation body cannot own one examples locale namespace.`,
			),
		);
	}

	const visit = (node: TS.Node): void => {
		if (ts.isObjectLiteralExpression(node)) {
			const indexedOperationKey = operationSites?.get(node.getStart(source));
			if (indexedOperationKey !== undefined) {
				sitesByStart.set(node.getStart(source), {
					object: node,
					operationKey: indexedOperationKey,
					operationIdProven: true,
				});
			}
		}
		if (ts.isCallExpression(node) && isOperationHelperCall(node)) {
			const argument = operationArgument(node);
			const bindingName = enclosingBindingName(node);
			const unwrappedArgument = unwrapExpression(argument);
			if (unwrappedArgument !== undefined && ts.isObjectLiteralExpression(unwrappedArgument)) {
				discoveredStarts.add(unwrappedArgument.getStart(source));
			}
			if (bindingName !== undefined && localExcludedBindings.has(bindingName)) return;
			const operationKey =
				(bindingName === undefined ? undefined : localIds.get(bindingName)) ??
				bindingName ??
				"<anonymous>";
			if (unwrappedArgument === undefined || !ts.isObjectLiteralExpression(unwrappedArgument)) {
				refusals.push(
					refusal(
						fileName,
						operationKey,
						"non_literal",
						"Operation helper argument must be an object literal.",
					),
				);
			} else {
				const object = unwrappedArgument;
				if (ts.isObjectLiteralExpression(object)) {
					const existing = sitesByStart.get(object.getStart(source));
					if (existing === undefined) {
						const operationIdProven = bindingName !== undefined && localIds.has(bindingName);
						sitesByStart.set(object.getStart(source), {
							object,
							operationKey,
							bindingName,
							operationIdProven,
						});
					} else if (existing.operationKey.startsWith("<")) {
						existing.operationKey = operationKey;
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	for (const start of sitesByStart.keys()) discoveredStarts.add(start);
	return {
		sites: [...sitesByStart.values()].sort(
			(left, right) => left.object.getStart(source) - right.object.getStart(source),
		),
		discoveredCount: discoveredStarts.size,
		refusals,
	};
}

function collectSimpleOperationFactories(source: TS.SourceFile): ReadonlySet<string> {
	const factories = new Set<string>();
	for (const statement of source.statements) {
		if (
			!ts.isFunctionDeclaration(statement) ||
			statement.name === undefined ||
			statement.body === undefined ||
			statement.body.statements.length !== 1
		) {
			continue;
		}
		const returned = statement.body.statements[0];
		if (!ts.isReturnStatement(returned) || returned.expression === undefined) continue;
		const expression = unwrapExpression(returned.expression);
		if (
			expression !== undefined &&
			ts.isCallExpression(expression) &&
			isOperationHelperCall(expression)
		) {
			const argument = operationArgument(expression);
			const object = argument === undefined ? undefined : unwrapExpression(argument);
			if (object !== undefined && ts.isObjectLiteralExpression(object)) {
				factories.add(statement.name.text);
			}
		}
	}
	return factories;
}

function collectOperationsMaps(
	source: TS.SourceFile,
	constObjects: ReadonlyMap<string, TS.ObjectLiteralExpression>,
	fileName: string,
	refusals: OperationDeclarationRefusal[],
	runtimeComposedInitializers?: ReadonlySet<number>,
): TS.ObjectLiteralExpression[] {
	const maps = new Map<number, TS.ObjectLiteralExpression>();
	const inspect = (expression: TS.Expression, label: string): void => {
		const unwrapped = unwrapExpression(expression);
		if (unwrapped === undefined) return;
		if (ts.isObjectLiteralExpression(unwrapped)) {
			maps.set(unwrapped.getStart(source), unwrapped);
			return;
		}
		if (ts.isIdentifier(unwrapped)) {
			const object = constObjects.get(unwrapped.text);
			if (object !== undefined) maps.set(object.getStart(source), object);
			return;
		}
		if (ts.isCallExpression(unwrapped)) {
			if (runtimeComposedInitializers?.has(expression.getStart(source)) === true) return;
			refusals.push(
				refusal(
					fileName,
					label,
					"factory_composed_operations",
					"The operations map is produced by a factory call and cannot be statically enumerated.",
				),
			);
		}
	};

	for (const statement of source.statements) {
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.name.text === "operations" &&
					declaration.initializer !== undefined
				) {
					inspect(declaration.initializer, "<operations>");
				}
			}
		}
	}

	const visit = (node: TS.Node): void => {
		if (ts.isPropertyAssignment(node) && staticPropertyName(node.name) === "operations") {
			// Only provider declarations own an `operations` map: the property
			// must sit inside an argument of defineProvider()/buildProvider()-style
			// call, or its initializer (possibly via a same-file const) must
			// contain defineOperation/defineStreamOperation members. A bare
			// `operations:` key elsewhere (a zod schema field, a config object)
			// is not a declaration site; treating it as one produced false
			// factory_composed_operations refusals on ekitan's
			// scripts/fixture-integrity.ts, whose schema field calls
			// .superRefine(...).
			if (isProviderOperationsProperty(node, constObjects)) {
				inspect(node.initializer, "<operations>");
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return [...maps.values()];
}

function isProviderOperationsProperty(
	node: TS.PropertyAssignment,
	constObjects: ReadonlyMap<string, TS.ObjectLiteralExpression>,
): boolean {
	// (a) The initializer (direct or via same-file const) mentions
	// defineOperation / defineStreamOperation — the strongest signal.
	const target = ts.isIdentifier(unwrapExpression(node.initializer) ?? node.initializer)
		? constObjects.get((unwrapExpression(node.initializer) as TS.Identifier).text)
		: undefined;
	const initializerText = (target ?? node.initializer).getText();
	if (/\bdefine(?:Stream)?Operation\b/.test(initializerText)) return true;

	// (b) The property is inside a call argument whose callee looks like a
	// provider builder (defineProvider(...)(...) / buildProvider(...)).
	let current: TS.Node = node;
	while (current.parent !== undefined) {
		const parent: TS.Node = current.parent;
		if (ts.isCallExpression(parent)) {
			const callee = parent.expression.getText();
			if (/(?:defineProvider|Provider)\b/.test(callee)) return true;
			// A call expression that is itself the invocation of a
			// defineProvider(...) result: defineProvider({...})({operations})
			if (ts.isCallExpression(parent.expression)) {
				if (/\bdefineProvider\b/.test(parent.expression.expression.getText())) {
					return true;
				}
			}
			return false;
		}
		if (ts.isSourceFile(parent)) return false;
		current = parent;
	}
	return false;
}

function operationObjectFromExpression(
	expression: TS.Expression,
): TS.ObjectLiteralExpression | undefined {
	const unwrapped = unwrapExpression(expression);
	if (unwrapped === undefined || !ts.isCallExpression(unwrapped)) return undefined;
	if (!isOperationHelperCall(unwrapped)) return undefined;
	const argument = operationArgument(unwrapped);
	const object = argument === undefined ? undefined : unwrapExpression(argument);
	return object !== undefined && ts.isObjectLiteralExpression(object) ? object : undefined;
}

function isOperationHelperCall(call: TS.CallExpression): boolean {
	if (ts.isIdentifier(call.expression) && OPERATION_HELPERS.has(call.expression.text)) {
		return call.arguments.length === 1;
	}
	return (
		ts.isCallExpression(call.expression) &&
		ts.isIdentifier(call.expression.expression) &&
		OPERATION_HELPERS.has(call.expression.expression.text) &&
		call.expression.arguments.length === 0 &&
		call.arguments.length === 1
	);
}

function operationArgument(call: TS.CallExpression): TS.Expression | undefined {
	if (ts.isIdentifier(call.expression) && OPERATION_HELPERS.has(call.expression.text)) {
		return call.arguments.length === 1 ? call.arguments[0] : undefined;
	}
	if (
		ts.isCallExpression(call.expression) &&
		ts.isIdentifier(call.expression.expression) &&
		OPERATION_HELPERS.has(call.expression.expression.text) &&
		call.expression.arguments.length === 0
	) {
		return call.arguments.length === 1 ? call.arguments[0] : undefined;
	}
	return undefined;
}

function enclosingBindingName(node: TS.Node): string | undefined {
	let current: TS.Node | undefined = node;
	while (current !== undefined) {
		if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
			return current.name.text;
		}
		if (ts.isFunctionDeclaration(current) && current.name !== undefined) {
			return current.name.text;
		}
		if (ts.isPropertyAssignment(current)) return staticPropertyName(current.name);
		if (ts.isExportAssignment(current)) return "default";
		current = current.parent;
	}
	return undefined;
}

function collectModuleConstObjects(source: TS.SourceFile): Map<string, TS.ObjectLiteralExpression> {
	const objects = new Map<string, TS.ObjectLiteralExpression>();
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
			const expression = unwrapExpression(declaration.initializer);
			if (expression !== undefined && ts.isObjectLiteralExpression(expression)) {
				objects.set(declaration.name.text, expression);
			}
		}
	}
	return objects;
}

function collectModuleConstArrays(source: TS.SourceFile): Map<string, TS.ArrayLiteralExpression> {
	const arrays = new Map<string, TS.ArrayLiteralExpression>();
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
			const expression = unwrapExpression(declaration.initializer);
			if (expression !== undefined && ts.isArrayLiteralExpression(expression)) {
				arrays.set(declaration.name.text, expression);
			}
		}
	}
	return arrays;
}

function expandArrayElements(
	array: TS.ArrayLiteralExpression,
	constArrays: ReadonlyMap<string, TS.ArrayLiteralExpression>,
	fileName: string,
	operationKey: string,
	seen = new Set<TS.ArrayLiteralExpression>(),
): { readonly elements: TS.Expression[] } | { readonly refusal: OperationDeclarationRefusal } {
	if (seen.has(array)) {
		return nonLiteral(fileName, operationKey, "A module-level array spread is recursive.");
	}
	seen.add(array);
	const elements: TS.Expression[] = [];
	for (const element of array.elements) {
		if (!ts.isSpreadElement(element)) {
			elements.push(element);
			continue;
		}
		const expression = unwrapExpression(element.expression);
		const spreadArray =
			expression !== undefined && ts.isArrayLiteralExpression(expression)
				? expression
				: expression !== undefined && ts.isIdentifier(expression)
					? constArrays.get(expression.text)
					: undefined;
		if (spreadArray === undefined) {
			return nonLiteral(
				fileName,
				operationKey,
				"inputExamples contains an unresolved array spread.",
			);
		}
		const expanded = expandArrayElements(
			spreadArray,
			constArrays,
			fileName,
			operationKey,
			new Set(seen),
		);
		if ("refusal" in expanded) return expanded;
		elements.push(...expanded.elements);
	}
	return { elements };
}

function expandMembers(
	object: TS.ObjectLiteralExpression,
	source: TS.SourceFile,
	constObjects: ReadonlyMap<string, TS.ObjectLiteralExpression>,
	fileName: string,
	operationKey: string,
	staticObjectResolver?: StaticObjectResolver,
	seen = new Set<TS.ObjectLiteralExpression>(),
): { readonly members: ResolvedMember[] } | { readonly refusal: OperationDeclarationRefusal } {
	if (seen.has(object)) {
		return nonLiteral(fileName, operationKey, "A module-level object spread is recursive.");
	}
	seen.add(object);
	const members: ResolvedMember[] = [];
	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property)) {
			const spreadObject = resolveStaticObjectExpression(
				property.expression,
				source,
				constObjects,
				staticObjectResolver,
			);
			if (spreadObject === undefined) {
				members.push({ name: "<spread>", property, source });
				continue;
			}
			const expanded = expandMembers(
				spreadObject.object,
				spreadObject.source,
				constObjects,
				fileName,
				operationKey,
				staticObjectResolver,
				new Set(seen),
			);
			if ("refusal" in expanded) return expanded;
			members.push(...expanded.members.map((member) => ({ ...member, fromSpread: true as const })));
			continue;
		}
		const name = staticPropertyName(property.name);
		if (name === undefined) {
			return nonLiteral(fileName, operationKey, "A declaration member uses a computed name.");
		}
		const initializer = propertyValue(property);
		members.push({ name, property, initializer, source });
	}
	return { members };
}

function indexMembers(
	members: readonly ResolvedMember[],
	fileName: string,
	operationKey: string,
):
	| { readonly byName: Map<string, ResolvedMember>; readonly spreads: ResolvedMember[] }
	| { readonly refusal: OperationDeclarationRefusal } {
	const byName = new Map<string, ResolvedMember>();
	const spreads: ResolvedMember[] = [];
	for (const member of members) {
		if (member.name === "<spread>") {
			spreads.push(member);
			continue;
		}
		const previous = byName.get(member.name);
		if (previous !== undefined && previous.fromSpread !== true && member.fromSpread !== true) {
			return nonLiteral(
				fileName,
				operationKey,
				`Duplicate ${member.name} declarations cannot be collapsed safely.`,
			);
		}
		byName.set(member.name, member);
	}
	return { byName, spreads };
}

function indexMembersFromObject(
	object: TS.ObjectLiteralExpression,
	fileName: string,
	operationKey: string,
):
	| { readonly byName: Map<string, ResolvedMember> }
	| { readonly refusal: OperationDeclarationRefusal } {
	const members: ResolvedMember[] = [];
	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property)) {
			return nonLiteral(fileName, operationKey, "Example objects cannot contain spreads.");
		}
		const name = staticPropertyName(property.name);
		const initializer = propertyValue(property);
		if (name === undefined || initializer === undefined) {
			return nonLiteral(fileName, operationKey, "Example members must be literal properties.");
		}
		members.push({ name, property, initializer, source: object.getSourceFile() });
	}
	const indexed = indexMembers(members, fileName, operationKey);
	if ("refusal" in indexed) return indexed;
	return { byName: indexed.byName };
}

function resolveObjectInitializer(
	member: ResolvedMember,
	rootSource: TS.SourceFile,
	constObjects: ReadonlyMap<string, TS.ObjectLiteralExpression>,
	staticObjectResolver?: StaticObjectResolver,
): StaticObjectReference | undefined {
	if (member.initializer === undefined) return undefined;
	return resolveStaticObjectExpression(
		member.initializer,
		member.source,
		constObjects,
		staticObjectResolver,
		rootSource,
	);
}

function resolveStaticObjectExpression(
	expression: TS.Expression,
	source: TS.SourceFile,
	constObjects: ReadonlyMap<string, TS.ObjectLiteralExpression>,
	staticObjectResolver?: StaticObjectResolver,
	rootSource: TS.SourceFile = source,
): StaticObjectReference | undefined {
	const unwrapped = unwrapExpression(expression);
	if (unwrapped === undefined) return undefined;
	if (ts.isObjectLiteralExpression(unwrapped)) return { object: unwrapped, source };
	const externallyResolved = staticObjectResolver?.(unwrapped, source);
	if (externallyResolved !== undefined) return externallyResolved;
	if (source === rootSource && ts.isIdentifier(unwrapped)) {
		const object = constObjects.get(unwrapped.text);
		if (object !== undefined) return { object, source };
	}
	return undefined;
}

function memberMap(members: readonly ResolvedMember[]): Map<string, ResolvedMember> {
	return new Map(members.map((member) => [member.name, member]));
}

function firstUnknown(
	members: ReadonlyMap<string, ResolvedMember>,
	allowed: ReadonlySet<string>,
): string | undefined {
	for (const name of members.keys()) {
		if (!allowed.has(name)) return name;
	}
	return undefined;
}

function unsupportedContainerMember(
	fileName: string,
	operationKey: string,
	container: string,
	member: string,
): { readonly refusal: OperationDeclarationRefusal } {
	return {
		refusal: refusal(
			fileName,
			operationKey,
			"unsupported_member",
			`${container}.${member} has no declared ADR-0009 transform.`,
		),
	};
}

function literalBooleanMember(
	member: ResolvedMember | undefined,
	fileName: string,
	operationKey: string,
	label: string,
): { readonly value: boolean | undefined } | { readonly refusal: OperationDeclarationRefusal } {
	if (member === undefined) return { value: undefined };
	const expression = unwrapExpression(member.initializer);
	if (expression?.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
	if (expression?.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
	return nonLiteral(fileName, operationKey, `${label} must be a boolean literal.`);
}

function literalString(expression: TS.Expression | undefined): string | undefined {
	const value = unwrapExpression(expression);
	if (value === undefined) return undefined;
	if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
	return undefined;
}

function equivalentLiteral(
	left: TS.Expression | undefined,
	right: TS.Expression | undefined,
): boolean | undefined {
	const leftValue = literalValue(left);
	const rightValue = literalValue(right);
	if (leftValue === NOT_LITERAL || rightValue === NOT_LITERAL) return undefined;
	return JSON.stringify(leftValue) === JSON.stringify(rightValue);
}

const NOT_LITERAL = Symbol("not-literal");

function literalValue(expression: TS.Expression | undefined): unknown | typeof NOT_LITERAL {
	const node = unwrapExpression(expression);
	if (node === undefined) return NOT_LITERAL;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isNumericLiteral(node)) return Number(node.text);
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (node.kind === ts.SyntaxKind.NullKeyword) return null;
	if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
		if (node.operator === ts.SyntaxKind.MinusToken) return -Number(node.operand.text);
		if (node.operator === ts.SyntaxKind.PlusToken) return Number(node.operand.text);
	}
	if (ts.isArrayLiteralExpression(node)) {
		const result: unknown[] = [];
		for (const element of node.elements) {
			if (ts.isSpreadElement(element)) return NOT_LITERAL;
			const value = literalValue(element);
			if (value === NOT_LITERAL) return NOT_LITERAL;
			result.push(value);
		}
		return result;
	}
	if (ts.isObjectLiteralExpression(node)) {
		const result: Record<string, unknown> = {};
		for (const property of node.properties) {
			if (!ts.isPropertyAssignment(property)) return NOT_LITERAL;
			const name = staticPropertyName(property.name);
			const value = literalValue(property.initializer);
			if (name === undefined || value === NOT_LITERAL) return NOT_LITERAL;
			result[name] = value;
		}
		return result;
	}
	return NOT_LITERAL;
}

function memberText(member: ResolvedMember, name: string): string {
	if (member.initializer === undefined) return name;
	return `${name}: ${member.initializer.getText(member.source)}`;
}

function addInsertion(
	insertions: Map<string, { source: string; text: string }[]>,
	sourceContainer: string,
	text: string,
): void {
	const items = insertions.get(sourceContainer) ?? [];
	items.push({ source: sourceContainer, text });
	insertions.set(sourceContainer, items);
}

function removalRanges(
	object: TS.ObjectLiteralExpression,
	properties: readonly TS.ObjectLiteralElementLike[],
	source: TS.SourceFile,
): TextEdit[] {
	const unique = [...new Set(properties)];
	const text = source.getFullText();
	const ranges: TextEdit[] = [];
	for (const property of unique) {
		let start = property.getStart(source);
		let end = property.getEnd();
		let cursor = end;
		while (cursor < object.getEnd() && /\s/.test(text.charAt(cursor))) cursor += 1;
		if (text.charAt(cursor) === ",") {
			end = cursor + 1;
		} else {
			cursor = start - 1;
			while (cursor > object.getStart(source) && /\s/.test(text.charAt(cursor))) cursor -= 1;
			if (text.charAt(cursor) === ",") start = cursor;
		}
		ranges.push({ start, end, text: "" });
	}
	return mergeRemovalEdits(ranges);
}

function mergeRemovalEdits(edits: readonly TextEdit[]): TextEdit[] {
	const ordered = [...edits].sort((left, right) => left.start - right.start);
	const merged: TextEdit[] = [];
	for (const edit of ordered) {
		const previous = merged.at(-1);
		if (previous !== undefined && edit.start <= previous.end) {
			merged[merged.length - 1] = {
				start: previous.start,
				end: Math.max(previous.end, edit.end),
				text: "",
			};
		} else {
			merged.push(edit);
		}
	}
	return merged;
}

function removeFirst(
	items: TS.ObjectLiteralElementLike[],
	value: TS.ObjectLiteralElementLike,
): void {
	const index = items.indexOf(value);
	if (index >= 0) items.splice(index, 1);
}

function rangesOverlap(left: TextEdit, right: TextEdit): boolean {
	return left.start < right.end && right.start < left.end;
}

function applyEdits(sourceText: string, edits: readonly TextEdit[]): string {
	const ordered = [...edits].sort(
		(left, right) => right.start - left.start || right.end - left.end,
	);
	let code = sourceText;
	for (const edit of ordered) {
		code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
	}
	return code;
}

function normalizeEdits(
	edits: readonly TextEdit[],
	fileName: string,
): { readonly edits: readonly TextEdit[] } | { readonly refusal: OperationDeclarationRefusal } {
	const unique = new Map<string, TextEdit>();
	for (const edit of edits) {
		const key = `${edit.start}:${edit.end}`;
		const previous = unique.get(key);
		if (previous === undefined) {
			unique.set(key, edit);
			continue;
		}
		if (previous.text !== edit.text) {
			return nonLiteral(
				fileName,
				"<shared>",
				"A module-level input examples array is shared by operations that need different locale keys.",
			);
		}
	}
	return { edits: [...unique.values()] };
}

function indentationAt(text: string, position: number): string {
	const lineStart = text.lastIndexOf("\n", position - 1) + 1;
	return text.slice(lineStart, position).match(/^\s*/)?.[0] ?? "";
}

function propertyValue(property: TS.ObjectLiteralElementLike): TS.Expression | undefined {
	if (ts.isPropertyAssignment(property)) return property.initializer;
	if (ts.isShorthandPropertyAssignment(property)) return property.name;
	return undefined;
}

function staticPropertyName(name: TS.PropertyName | undefined): string | undefined {
	if (name === undefined) return undefined;
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}
	return undefined;
}

function unwrapExpression(expression: TS.Expression | undefined): TS.Expression | undefined {
	let current = expression;
	while (current !== undefined) {
		if (
			ts.isParenthesizedExpression(current) ||
			ts.isAsExpression(current) ||
			ts.isTypeAssertionExpression(current) ||
			ts.isSatisfiesExpression(current) ||
			ts.isNonNullExpression(current)
		) {
			current = current.expression;
			continue;
		}
		return current;
	}
	return undefined;
}

function parseSource(fileName: string, sourceText: string): TS.SourceFile {
	return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function firstSyntaxError(source: TS.SourceFile): string | undefined {
	const diagnostics = (source as TS.SourceFile & { parseDiagnostics?: TS.DiagnosticWithLocation[] })
		.parseDiagnostics;
	if (diagnostics === undefined || diagnostics.length === 0) return undefined;
	const first = diagnostics[0];
	if (first === undefined) return undefined;
	const message = ts.flattenDiagnosticMessageText(first.messageText, " ");
	const { line } = source.getLineAndCharacterOfPosition(first.start);
	return `${message} (line ${line + 1})`;
}

function refusal(
	file: string,
	operationKey: string,
	reason: OperationDeclarationRefusalReason,
	detail: string,
): OperationDeclarationRefusal {
	return { file, operationKey, reason, detail };
}

function findInvalidLocaleTodo(
	todos: readonly LocaleTodo[],
	fileName: string,
): OperationDeclarationRefusal | undefined {
	for (const todo of todos) {
		try {
			assertProviderLocaleKey(todo.key);
		} catch (error) {
			return invalidLocaleKeyRefusal(fileName, todo.operationKey, todo.key, error);
		}
	}
	return undefined;
}

function invalidLocaleKeyRefusal(
	fileName: string,
	operationKey: string,
	localeKey: string,
	error: unknown,
): OperationDeclarationRefusal {
	const validatorDetail = error instanceof Error ? error.message : String(error);
	return refusal(
		fileName,
		operationKey,
		"invalid_locale_key",
		`Refusing to write invalid provider locale key ${JSON.stringify(localeKey)}: ${validatorDetail}`,
	);
}

function nonLiteral(
	fileName: string,
	operationKey: string,
	detail: string,
): { readonly refusal: OperationDeclarationRefusal } {
	return {
		refusal: refusal(fileName, operationKey, "non_literal", detail),
	};
}

export type OperationDeclarationRepositoryResult =
	| {
			readonly status: "migrated" | "would-migrate" | "unchanged";
			readonly providerRoot: string;
			readonly changedFiles: readonly string[];
			readonly operationCount: number;
			readonly notes: readonly OperationDeclarationNote[];
			readonly sidecar?: string;
			readonly localeTodoCount: number;
	  }
	| {
			readonly status: "refused";
			readonly providerRoot: string;
			readonly refusals: readonly OperationDeclarationRefusal[];
			/** Operations that were independently migratable before repository-atomic refusal. */
			readonly operationCount: number;
			readonly notes: readonly OperationDeclarationNote[];
			readonly changedFiles: readonly string[];
			readonly localeTodoCount: number;
	  };

export type OperationDeclarationNote = {
	readonly code: "runtime_composed_registry";
	readonly path: string;
	readonly initializer: string;
};

/** Run the file transform repository-wide, committing writes only if every file is provable. */
export function migrateOperationDeclarationRepository(
	providerRootInput: string,
	options: { readonly check?: boolean } = {},
): OperationDeclarationRepositoryResult {
	const providerRoot = resolve(providerRootInput);
	const sourceFiles = collectSourceFiles(providerRoot);
	const localeFiles = collectLocaleFiles(providerRoot);
	const repositoryIndex = buildRepositoryOperationIndex(sourceFiles, providerRoot);
	const pendingWrites = new Map<string, string>();
	const changedFiles: string[] = [];
	const todos: LocaleTodo[] = [];
	const refusals: OperationDeclarationRefusal[] = [...repositoryIndex.refusals];
	let operationCount = 0;
	let repositoryDiscoveredCount = 0;

	for (const sourcePath of sourceFiles) {
		const relativePath = slash(relative(providerRoot, sourcePath));
		const result = migrateOperationDeclarationInternal(
			readFileSync(sourcePath, "utf8"),
			relativePath,
			{
				operationIds: repositoryIndex.operationIds.get(sourcePath),
				localeFiles,
			},
			{
				operationSites: repositoryIndex.operationSites.get(sourcePath),
				excludedBindings: repositoryIndex.excludedBindings.get(sourcePath),
				staticObjectResolver: repositoryIndex.staticObjectResolverFor(sourcePath),
				runtimeComposedInitializers: repositoryIndex.runtimeComposedInitializers.get(sourcePath),
				recordDiscoveredSites: (count) => {
					repositoryDiscoveredCount += count;
				},
			},
		);
		if (result.status === "refused") {
			refusals.push(...result.refusals);
			continue;
		}
		operationCount += result.operations;
		if (result.status === "migrated") {
			pendingWrites.set(sourcePath, result.code);
			changedFiles.push(relativePath);
			todos.push(...result.localeTodos);
		}
	}
	const notes: OperationDeclarationNote[] =
		repositoryDiscoveredCount === 0
			? []
			: repositoryIndex.declarations.flatMap((declaration) =>
					declaration.runtimeInitializer === undefined
						? []
						: [
								{
									code: "runtime_composed_registry" as const,
									path: slash(relative(providerRoot, declaration.path)),
									initializer: declaration.runtimeInitializer,
								},
							],
				);
	if (repositoryIndex.declarations.length > 0 && repositoryDiscoveredCount === 0) {
		for (const declaration of repositoryIndex.declarations) {
			refusals.push(
				refusal(
					slash(relative(providerRoot, declaration.path)),
					"<operations>",
					"no_operations_discovered",
					`Provider construct ${declaration.construct} declares operations via unresolved initializer ${JSON.stringify(
						declaration.initializer.getText(declaration.initializer.getSourceFile()),
					)}, but repository-wide discovery found zero operation sites.`,
				),
			);
		}
	}

	const todoConflict = findLocaleTodoConflict(todos);
	if (todoConflict !== undefined) refusals.push(todoConflict);
	if (refusals.length > 0) {
		return {
			status: "refused",
			providerRoot,
			refusals,
			operationCount,
			notes,
			changedFiles,
			localeTodoCount: todos.length,
		};
	}
	for (const [path, code] of renderLocaleCatalogWrites(providerRoot, todos)) {
		pendingWrites.set(path, code);
	}

	if (pendingWrites.size === 0) {
		return {
			status: "unchanged",
			providerRoot,
			changedFiles: [],
			operationCount,
			notes,
			localeTodoCount: 0,
		};
	}

	const sidecar = todos.length > 0 ? SIDECAR_NAME : undefined;
	if (!options.check) {
		for (const [path, code] of pendingWrites) writeFileSync(path, code, "utf8");
		if (sidecar !== undefined) {
			writeFileSync(join(providerRoot, sidecar), renderLocaleTodoSidecar(todos), "utf8");
		}
	}
	return {
		status: options.check ? "would-migrate" : "migrated",
		providerRoot,
		changedFiles,
		operationCount,
		notes,
		sidecar,
		localeTodoCount: todos.length,
	};
}

export function renderLocaleTodoSidecar(todos: readonly LocaleTodo[]): string {
	const localeFiles: Record<string, Record<string, string>> = {};
	for (const todo of [...todos].sort(
		(left, right) =>
			left.localeFile.localeCompare(right.localeFile) || left.key.localeCompare(right.key),
	)) {
		localeFiles[todo.localeFile] ??= {};
		localeFiles[todo.localeFile][todo.key] = todo.originalProse;
	}
	return `${JSON.stringify({ schemaVersion: 1, localeFiles }, null, 2)}\n`;
}

function renderLocaleCatalogWrites(
	providerRoot: string,
	todos: readonly LocaleTodo[],
): Map<string, string> {
	const todosByFile = new Map<string, LocaleTodo[]>();
	for (const todo of todos) {
		const fileTodos = todosByFile.get(todo.localeFile) ?? [];
		fileTodos.push(todo);
		todosByFile.set(todo.localeFile, fileTodos);
	}

	const englishPath = "locales/en.json";
	const englishTodos = todosByFile.get(englishPath);
	if (englishTodos === undefined) return new Map();

	const english = readLocaleCatalog(join(providerRoot, englishPath));
	applyLocaleTodos(english, englishTodos);
	const writes = new Map<string, string>([
		[join(providerRoot, englishPath), renderCanonicalLocaleCatalog(english)],
	]);

	for (const [localeFile, fileTodos] of todosByFile) {
		if (localeFile === englishPath) continue;
		const catalog = readLocaleCatalog(join(providerRoot, localeFile));
		applyLocaleTodos(catalog, fileTodos);
		writes.set(
			join(providerRoot, localeFile),
			renderCanonicalLocaleCatalog(reorderLikeReference(english, catalog)),
		);
	}
	return writes;
}

function readLocaleCatalog(path: string): Record<string, unknown> {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(value)) throw new Error(`${path} must contain a JSON object.`);
	return value;
}

function applyLocaleTodos(catalog: Record<string, unknown>, todos: readonly LocaleTodo[]): void {
	for (const todo of todos) {
		const segments = todo.key.split(".");
		const leaf = segments.pop();
		if (leaf === undefined) continue;
		let cursor = catalog;
		for (const segment of segments) {
			const child = cursor[segment];
			if (isRecord(child)) {
				cursor = child;
				continue;
			}
			const created: Record<string, unknown> = {};
			cursor[segment] = created;
			cursor = created;
		}
		cursor[leaf] = todo.originalProse;
	}
}

/** Match provider-contract's canonical locale serialization exactly. */
function renderCanonicalLocaleCatalog(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Put shared keys first in English order, then retain locale-only authored order.
 * Arrays keep their shape and use the English item at the same index as a reference.
 */
function reorderLikeReference(reference: unknown, value: unknown): unknown {
	if (Array.isArray(value)) {
		const referenceArray = Array.isArray(reference) ? reference : [];
		return value.map((item, index) => reorderLikeReference(referenceArray[index], item));
	}
	if (!isRecord(value)) return value;

	const referenceRecord = isRecord(reference) ? reference : {};
	const ordered: Record<string, unknown> = {};
	for (const key of Object.keys(referenceRecord)) {
		if (Object.hasOwn(value, key)) {
			ordered[key] = reorderLikeReference(referenceRecord[key], value[key]);
		}
	}
	for (const [key, child] of Object.entries(value)) {
		if (!Object.hasOwn(ordered, key)) {
			ordered[key] = reorderLikeReference(
				Object.hasOwn(referenceRecord, key) ? referenceRecord[key] : undefined,
				child,
			);
		}
	}
	return ordered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findLocaleTodoConflict(
	todos: readonly LocaleTodo[],
): OperationDeclarationRefusal | undefined {
	const values = new Map<string, LocaleTodo>();
	for (const todo of todos) {
		const id = `${todo.localeFile}\0${todo.key}`;
		const previous = values.get(id);
		if (previous !== undefined && previous.originalProse !== todo.originalProse) {
			return refusal(
				SIDECAR_NAME,
				todo.operationKey,
				"locale_todo_conflict",
				`${todo.localeFile} receives conflicting prose for ${todo.key}.`,
			);
		}
		values.set(id, todo);
	}
	return undefined;
}

function collectSourceFiles(root: string): string[] {
	const files: string[] = [];
	if (!existsSync(root)) return files;
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (SOURCE_SKIP_DIRECTORIES.has(entry.name)) continue;
				const child = join(directory, entry.name);
				if (existsSync(join(child, ".git"))) continue;
				walk(child);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".test.ts")) continue;
			files.push(join(directory, entry.name));
		}
	};
	walk(root);
	return files.sort();
}

function collectLocaleFiles(root: string): string[] {
	const localeDirectory = join(root, "locales");
	if (!existsSync(localeDirectory)) return [];
	return readdirSync(localeDirectory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && extname(entry.name) === ".json")
		.map((entry) => `locales/${entry.name}`)
		.sort();
}

type LocatedExpression = {
	readonly path: string;
	readonly source: TS.SourceFile;
	readonly expression: TS.Expression;
	readonly bindingName?: string;
};

type StaticResolution =
	| { readonly status: "resolved"; readonly value: LocatedExpression }
	| { readonly status: "missing" }
	| { readonly status: "refused"; readonly detail: string };

type ProviderOperationsDeclaration = {
	readonly path: string;
	readonly construct: string;
	readonly initializer: TS.Expression;
	readonly runtimeInitializer?: string;
};

type RepositoryOperationIndex = {
	readonly operationIds: Map<string, Map<string, string>>;
	readonly operationSites: Map<string, Map<number, string>>;
	readonly excludedBindings: Map<string, Set<string>>;
	readonly runtimeComposedInitializers: Map<string, Set<number>>;
	readonly refusals: OperationDeclarationRefusal[];
	readonly declarations: ProviderOperationsDeclaration[];
	readonly staticObjectResolverFor: (path: string) => StaticObjectResolver;
};

function buildRepositoryOperationIndex(
	sourceFiles: readonly string[],
	providerRoot: string,
): RepositoryOperationIndex {
	const sources = new Map<string, TS.SourceFile>();
	for (const path of sourceFiles) {
		const source = parseSource(path, readFileSync(path, "utf8"));
		if (firstSyntaxError(source) === undefined) sources.set(path, source);
	}

	const operationIds = buildOperationIdIndex(sourceFiles);
	const operationSites = new Map<string, Map<number, string>>();
	const excludedBindings = new Map<string, Set<string>>();
	const runtimeComposedInitializers = new Map<string, Set<number>>();
	const refusals: OperationDeclarationRefusal[] = [];
	const declarations: ProviderOperationsDeclaration[] = [];
	const indexedProviderProperties = new Set<string>();
	const factoryIds = new Map<string, { path: string; name: string; ids: Set<string> }>();
	const bindingCandidates = new Map<string, { path: string; name: string; ids: Set<string> }>();

	const relativePath = (path: string): string => slash(relative(providerRoot, path));
	const resolutionRefusal = (path: string, operationKey: string, detail: string): void => {
		refusals.push(refusal(relativePath(path), operationKey, "non_literal", detail));
	};

	const resolveExport = (
		path: string,
		exportedName: string,
		active: ReadonlySet<string>,
	): StaticResolution => {
		const key = `${path}\0export\0${exportedName}`;
		if (active.has(key)) {
			return {
				status: "refused",
				detail: `Static relative export cycle while resolving ${JSON.stringify(exportedName)} from ${relativePath(path)}.`,
			};
		}
		const source = sources.get(path);
		if (source === undefined) return { status: "missing" };
		const nextActive = new Set(active);
		nextActive.add(key);
		const explicit: Array<() => StaticResolution> = [];
		const exportStars: string[] = [];

		for (const statement of source.statements) {
			if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					if (
						ts.isIdentifier(declaration.name) &&
						declaration.name.text === exportedName &&
						declaration.initializer !== undefined
					) {
						const initializer = declaration.initializer;
						const bindingName = declaration.name.text;
						explicit.push(() => ({
							status: "resolved",
							value: {
								path,
								source,
								expression: initializer,
								bindingName,
							},
						}));
					}
				}
			}
			if (
				ts.isExportAssignment(statement) &&
				!statement.isExportEquals &&
				exportedName === "default"
			) {
				explicit.push(() => ({
					status: "resolved",
					value: { path, source, expression: statement.expression },
				}));
			}
			if (!ts.isExportDeclaration(statement)) continue;
			const specifier =
				statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
					? statement.moduleSpecifier.text
					: undefined;
			if (statement.exportClause === undefined) {
				if (specifier !== undefined) exportStars.push(specifier);
				continue;
			}
			if (!ts.isNamedExports(statement.exportClause)) continue;
			for (const element of statement.exportClause.elements) {
				if (element.name.text !== exportedName) continue;
				const localName = element.propertyName?.text ?? element.name.text;
				explicit.push(() => {
					if (specifier === undefined) {
						return resolveIdentifier(path, localName, nextActive);
					}
					const target = resolveStaticModule(path, specifier, sources);
					if (target.status !== "resolved") return target;
					return resolveExport(target.path, localName, nextActive);
				});
			}
		}

		if (explicit.length > 1) {
			return {
				status: "refused",
				detail: `Export ${JSON.stringify(exportedName)} is ambiguous in ${relativePath(path)}.`,
			};
		}
		if (explicit.length === 1) return explicit[0]?.() ?? { status: "missing" };

		const resolvedStars: LocatedExpression[] = [];
		let firstStarRefusal: StaticResolution | undefined;
		for (const specifier of exportStars) {
			const target = resolveStaticModule(path, specifier, sources);
			if (target.status !== "resolved") {
				if (target.status === "refused") firstStarRefusal ??= target;
				continue;
			}
			const candidate = resolveExport(target.path, exportedName, nextActive);
			if (candidate.status === "resolved") resolvedStars.push(candidate.value);
			else if (candidate.status === "refused") firstStarRefusal ??= candidate;
		}
		const origins = new Set(
			resolvedStars.map((item) => `${item.path}\0${item.expression.getStart(item.source)}`),
		);
		if (origins.size > 1) {
			return {
				status: "refused",
				detail: `Export ${JSON.stringify(exportedName)} is ambiguous across relative re-exports from ${relativePath(path)}.`,
			};
		}
		if (firstStarRefusal !== undefined) return firstStarRefusal;
		const resolved = resolvedStars[0];
		return resolved === undefined ? { status: "missing" } : { status: "resolved", value: resolved };
	};

	const resolveIdentifier = (
		path: string,
		name: string,
		active: ReadonlySet<string>,
	): StaticResolution => {
		const source = sources.get(path);
		if (source === undefined) return { status: "missing" };
		for (const statement of source.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
			for (const declaration of statement.declarationList.declarations) {
				if (
					ts.isIdentifier(declaration.name) &&
					declaration.name.text === name &&
					declaration.initializer !== undefined
				) {
					return {
						status: "resolved",
						value: {
							path,
							source,
							expression: declaration.initializer,
							bindingName: name,
						},
					};
				}
			}
		}
		for (const statement of source.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
				continue;
			}
			let exportedName: string | undefined;
			if (statement.importClause?.name?.text === name) exportedName = "default";
			const bindings = statement.importClause?.namedBindings;
			if (bindings !== undefined && ts.isNamedImports(bindings)) {
				for (const element of bindings.elements) {
					if (element.name.text === name) {
						exportedName = element.propertyName?.text ?? element.name.text;
					}
				}
			}
			if (exportedName === undefined) continue;
			const specifier = statement.moduleSpecifier.text;
			const target = resolveStaticModule(path, specifier, sources);
			if (target.status !== "resolved") return target;
			return resolveExport(target.path, exportedName, active);
		}
		return { status: "missing" };
	};

	const resolveLocatedExpression = (
		located: LocatedExpression,
		active: ReadonlySet<string>,
	): StaticResolution => {
		const expression = unwrapExpression(located.expression);
		if (expression === undefined) return { status: "missing" };
		if (!ts.isIdentifier(expression)) {
			return { status: "resolved", value: { ...located, expression } };
		}
		const key = `${located.path}\0identifier\0${expression.text}`;
		if (active.has(key)) {
			return {
				status: "refused",
				detail: `Static identifier cycle while resolving ${JSON.stringify(expression.text)} in ${relativePath(located.path)}.`,
			};
		}
		const nextActive = new Set(active);
		nextActive.add(key);
		const resolved = resolveIdentifier(located.path, expression.text, nextActive);
		return resolved.status === "resolved"
			? resolveLocatedExpression(resolved.value, nextActive)
			: resolved;
	};

	type RegistryEntry = { readonly operationId: string; readonly value: LocatedExpression };
	const flattenRegistry = (
		locatedInput: LocatedExpression,
		active: ReadonlySet<string>,
	): { readonly entries: Map<string, RegistryEntry> } | { readonly detail: string } => {
		const resolved = resolveLocatedExpression(locatedInput, active);
		if (resolved.status === "refused") return { detail: resolved.detail };
		if (resolved.status === "missing") {
			return {
				detail: `Operations initializer ${JSON.stringify(locatedInput.expression.getText(locatedInput.source))} is not a static local or relative-imported object.`,
			};
		}
		const expression = unwrapExpression(resolved.value.expression);
		if (expression === undefined || !ts.isObjectLiteralExpression(expression)) {
			return {
				detail: `Operations initializer ${JSON.stringify(resolved.value.expression.getText(resolved.value.source))} is not a static object literal.`,
			};
		}
		const cycleKey = `${resolved.value.path}\0object\0${expression.getStart(resolved.value.source)}`;
		if (active.has(cycleKey)) {
			return {
				detail: `Static operations registry spread cycle reaches ${relativePath(resolved.value.path)}.`,
			};
		}
		const nextActive = new Set(active);
		nextActive.add(cycleKey);
		const entries = new Map<string, RegistryEntry>();
		for (const property of expression.properties) {
			if (ts.isSpreadAssignment(property)) {
				const spread = flattenRegistry(
					{
						path: resolved.value.path,
						source: resolved.value.source,
						expression: property.expression,
					},
					nextActive,
				);
				if ("detail" in spread) return spread;
				for (const [operationId, entry] of spread.entries) entries.set(operationId, entry);
				continue;
			}
			const operationId = staticPropertyName(property.name);
			const value = propertyValue(property);
			if (operationId === undefined) {
				return {
					detail: `Operations registry in ${relativePath(resolved.value.path)} uses a computed key.`,
				};
			}
			if (value === undefined) {
				return { detail: `Operation ${JSON.stringify(operationId)} has a non-static initializer.` };
			}
			entries.set(operationId, {
				operationId,
				value: {
					path: resolved.value.path,
					source: resolved.value.source,
					expression: value,
				},
			});
		}
		return { entries };
	};

	const addBindingCandidate = (path: string, name: string, operationId: string): void => {
		const key = `${path}\0${name}`;
		const candidate = bindingCandidates.get(key) ?? { path, name, ids: new Set<string>() };
		candidate.ids.add(operationId);
		bindingCandidates.set(key, candidate);
	};
	const addObjectSite = (
		path: string,
		source: TS.SourceFile,
		object: TS.ObjectLiteralExpression,
		operationId: string,
	): void => {
		const sites = operationSites.get(path) ?? new Map<number, string>();
		const start = object.getStart(source);
		const previous = sites.get(start);
		if (previous !== undefined && previous !== operationId) {
			resolutionRefusal(
				path,
				operationId,
				`One static operation object is registered under both ${JSON.stringify(previous)} and ${JSON.stringify(operationId)}.`,
			);
			return;
		}
		sites.set(start, operationId);
		operationSites.set(path, sites);
	};

	const classifyEntry = (entry: RegistryEntry): void => {
		const resolved = resolveLocatedExpression(entry.value, new Set());
		if (resolved.status === "refused") {
			resolutionRefusal(entry.value.path, entry.operationId, resolved.detail);
			return;
		}
		if (resolved.status === "missing") {
			resolutionRefusal(
				entry.value.path,
				entry.operationId,
				`Operation initializer ${JSON.stringify(entry.value.expression.getText(entry.value.source))} is not statically resolvable.`,
			);
			return;
		}
		const expression = unwrapExpression(resolved.value.expression);
		if (expression === undefined) return;
		if (ts.isObjectLiteralExpression(expression)) {
			addObjectSite(resolved.value.path, resolved.value.source, expression, entry.operationId);
			return;
		}
		if (ts.isCallExpression(expression) && isOperationHelperCall(expression)) {
			const argument = operationArgument(expression);
			const object = argument === undefined ? undefined : unwrapExpression(argument);
			if (object === undefined || !ts.isObjectLiteralExpression(object)) {
				resolutionRefusal(
					resolved.value.path,
					entry.operationId,
					"Operation helper argument must be a static object literal.",
				);
				return;
			}
			if (resolved.value.bindingName !== undefined) {
				addBindingCandidate(resolved.value.path, resolved.value.bindingName, entry.operationId);
			}
			addObjectSite(resolved.value.path, resolved.value.source, object, entry.operationId);
			return;
		}
		if (
			ts.isCallExpression(expression) &&
			ts.isIdentifier(expression.expression) &&
			collectSimpleOperationFactories(resolved.value.source).has(expression.expression.text)
		) {
			const name = expression.expression.text;
			const key = `${resolved.value.path}\0${name}`;
			const factory = factoryIds.get(key) ?? {
				path: resolved.value.path,
				name,
				ids: new Set<string>(),
			};
			factory.ids.add(entry.operationId);
			factoryIds.set(key, factory);
			return;
		}
		resolutionRefusal(
			resolved.value.path,
			entry.operationId,
			`Operation initializer ${JSON.stringify(expression.getText(resolved.value.source))} is not a raw object, operation helper, or simple same-file factory call.`,
		);
	};

	const inspectProviderProperty = (
		path: string,
		source: TS.SourceFile,
		node: TS.PropertyAssignment,
		construct: string,
	): void => {
		const key = `${path}\0${node.getStart(source)}`;
		if (indexedProviderProperties.has(key)) return;
		indexedProviderProperties.add(key);
		const resolvedInitializer = resolveLocatedExpression(
			{ path, source, expression: node.initializer },
			new Set(),
		);
		let runtimeInitializer: string | undefined;
		if (resolvedInitializer.status === "resolved") {
			const resolvedExpression = unwrapExpression(resolvedInitializer.value.expression);
			if (resolvedExpression !== undefined && ts.isCallExpression(resolvedExpression)) {
				runtimeInitializer = resolvedExpression.getText(resolvedInitializer.value.source);
				const initializers = runtimeComposedInitializers.get(path) ?? new Set<number>();
				initializers.add(node.initializer.getStart(source));
				runtimeComposedInitializers.set(path, initializers);
			}
		}
		declarations.push({ path, construct, initializer: node.initializer, runtimeInitializer });
		const flattened = flattenRegistry({ path, source, expression: node.initializer }, new Set());
		if ("detail" in flattened) {
			if (runtimeInitializer === undefined) {
				resolutionRefusal(path, "<operations>", flattened.detail);
			}
		} else {
			for (const entry of flattened.entries.values()) classifyEntry(entry);
		}
	};

	for (const [path, source] of sources) {
		const constObjects = collectModuleConstObjects(source);
		const visit = (node: TS.Node): void => {
			if (
				ts.isPropertyAssignment(node) &&
				staticPropertyName(node.name) === "operations" &&
				isProviderOperationsProperty(node, constObjects)
			) {
				inspectProviderProperty(path, source, node, providerConstructName(node));
			}
			if (ts.isCallExpression(node)) {
				const construct = providerCallConstruct(node);
				if (construct !== undefined) {
					for (const argument of node.arguments) {
						const resolved = resolveLocatedExpression(
							{ path, source, expression: argument },
							new Set(),
						);
						if (resolved.status !== "resolved") continue;
						const object = unwrapExpression(resolved.value.expression);
						if (object === undefined || !ts.isObjectLiteralExpression(object)) continue;
						for (const property of object.properties) {
							if (
								ts.isPropertyAssignment(property) &&
								staticPropertyName(property.name) === "operations"
							) {
								inspectProviderProperty(
									resolved.value.path,
									resolved.value.source,
									property,
									construct,
								);
							}
						}
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}

	for (const candidate of bindingCandidates.values()) {
		const ids = [...candidate.ids];
		const indexed = operationIds.get(candidate.path) ?? new Map<string, string>();
		if (ids.length === 1) {
			const operationId = ids[0];
			if (operationId !== undefined) indexed.set(candidate.name, operationId);
		} else {
			indexed.delete(candidate.name);
			const excluded = excludedBindings.get(candidate.path) ?? new Set<string>();
			excluded.add(candidate.name);
			excludedBindings.set(candidate.path, excluded);
		}
		operationIds.set(candidate.path, indexed);
	}
	for (const factory of factoryIds.values()) {
		const indexed = operationIds.get(factory.path) ?? new Map<string, string>();
		const ids = [...factory.ids];
		if (ids.length === 1) {
			const operationId = ids[0];
			if (operationId !== undefined) indexed.set(factory.name, operationId);
		} else {
			indexed.delete(factory.name);
			const excluded = excludedBindings.get(factory.path) ?? new Set<string>();
			excluded.add(factory.name);
			excludedBindings.set(factory.path, excluded);
			refusals.push(
				refusal(
					relativePath(factory.path),
					factory.name,
					"factory_operation_id_ambiguous",
					`Factory ${factory.name} is registered under multiple operation ids: ${ids
						.map((id) => JSON.stringify(id))
						.join(", ")}. A shared operation body cannot own one examples locale namespace.`,
				),
			);
		}
		operationIds.set(factory.path, indexed);
	}

	const resolveStaticObject = (
		expressionInput: TS.Expression,
		path: string,
		active = new Set<string>(),
	): StaticObjectReference | undefined => {
		const expression = unwrapExpression(expressionInput);
		if (expression === undefined) return undefined;
		if (ts.isObjectLiteralExpression(expression)) {
			const source = sources.get(path) ?? expression.getSourceFile();
			return { object: expression, source };
		}
		if (ts.isIdentifier(expression)) {
			const key = `${path}\0member\0${expression.text}`;
			if (active.has(key)) return undefined;
			const nextActive = new Set(active);
			nextActive.add(key);
			const resolved = resolveIdentifier(path, expression.text, nextActive);
			return resolved.status === "resolved"
				? resolveStaticObject(resolved.value.expression, resolved.value.path, nextActive)
				: undefined;
		}
		if (ts.isPropertyAccessExpression(expression)) {
			const owner = resolveStaticObject(expression.expression, path, active);
			if (owner === undefined) return undefined;
			for (const property of owner.object.properties) {
				if (ts.isSpreadAssignment(property)) continue;
				if (staticPropertyName(property.name) !== expression.name.text) continue;
				const value = propertyValue(property);
				if (value === undefined) return undefined;
				return resolveStaticObject(value, owner.source.fileName, active);
			}
		}
		return undefined;
	};

	return {
		operationIds,
		operationSites,
		excludedBindings,
		runtimeComposedInitializers,
		refusals,
		declarations,
		staticObjectResolverFor: (currentPath) => (expression, source) =>
			resolveStaticObject(expression, sources.has(source.fileName) ? source.fileName : currentPath),
	};
}

function hasExportModifier(node: TS.Node): boolean {
	return (
		ts.canHaveModifiers(node) &&
		ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
			true
	);
}

function resolveStaticModule(
	containingPath: string,
	specifier: string,
	sources: ReadonlyMap<string, TS.SourceFile>,
):
	| { readonly status: "resolved"; readonly path: string }
	| Exclude<StaticResolution, { status: "resolved" }> {
	if (!specifier.startsWith(".")) {
		return {
			status: "refused",
			detail: `Static operation discovery refuses non-relative import ${JSON.stringify(specifier)}.`,
		};
	}
	const path = resolveLocalModule(containingPath, specifier, sources);
	if (path === undefined) {
		return {
			status: "refused",
			detail: `Static relative import ${JSON.stringify(specifier)} from ${containingPath} could not be resolved.`,
		};
	}
	return { status: "resolved", path };
}

function providerConstructName(node: TS.PropertyAssignment): string {
	let current: TS.Node = node;
	while (current.parent !== undefined) {
		const parent = current.parent;
		if (ts.isCallExpression(parent)) {
			return providerCallConstruct(parent) ?? parent.expression.getText();
		}
		current = parent;
	}
	return "provider declaration";
}

function providerCallConstruct(call: TS.CallExpression): string | undefined {
	if (
		ts.isIdentifier(call.expression) &&
		/(?:defineProvider|Provider)\b/.test(call.expression.text)
	) {
		return call.expression.text;
	}
	if (
		ts.isCallExpression(call.expression) &&
		ts.isIdentifier(call.expression.expression) &&
		/\bdefineProvider\b/.test(call.expression.expression.text)
	) {
		return call.expression.expression.text;
	}
	return undefined;
}

function buildOperationIdIndex(sourceFiles: readonly string[]): Map<string, Map<string, string>> {
	const result = new Map<string, Map<string, string>>();
	const idsByPath = new Map<string, Map<string, string | null>>();
	const ambiguousBindingsByPath = new Map<string, Set<string>>();
	const sources = new Map<string, TS.SourceFile>();
	for (const path of sourceFiles) {
		const source = parseSource(path, readFileSync(path, "utf8"));
		if (firstSyntaxError(source) === undefined) sources.set(path, source);
	}

	const record = (path: string, binding: string, operationId: string): void => {
		const map = result.get(path) ?? new Map<string, string>();
		const ids = idsByPath.get(path) ?? new Map<string, string | null>();
		const ambiguousBindings = ambiguousBindingsByPath.get(path) ?? new Set<string>();

		// An operation id is usable only when it identifies exactly one binding.
		// Keep an explicit null marker for an ambiguous id so a later occurrence
		// cannot accidentally make it usable again.
		const previousBinding = ids.get(operationId);
		if (ids.has(operationId)) {
			if (
				previousBinding !== undefined &&
				previousBinding !== null &&
				previousBinding !== binding
			) {
				map.delete(previousBinding);
				map.delete(binding);
				ambiguousBindings.add(previousBinding);
				ambiguousBindings.add(binding);
				ids.set(operationId, null);
			}
		} else {
			ids.set(operationId, binding);
		}

		// A binding registered under two different ids is likewise ambiguous.
		const previousId = map.get(binding);
		if (previousId !== undefined && previousId !== operationId) {
			map.delete(binding);
			ambiguousBindings.add(binding);
		} else if (!ambiguousBindings.has(binding) && ids.get(operationId) === binding) {
			map.set(binding, operationId);
		}
		result.set(path, map);
		idsByPath.set(path, ids);
		ambiguousBindingsByPath.set(path, ambiguousBindings);
	};

	for (const [path, source] of sources) {
		const imports = collectImports(source, path, sources);
		const constObjects = collectModuleConstObjects(source);
		const ignored: OperationDeclarationRefusal[] = [];
		for (const map of collectOperationsMaps(source, constObjects, path, ignored)) {
			for (const property of map.properties) {
				if (ts.isSpreadAssignment(property)) continue;
				const operationId = staticPropertyName(property.name);
				const value = propertyValue(property);
				const expression = value === undefined ? undefined : unwrapExpression(value);
				if (operationId === undefined || expression === undefined || !ts.isIdentifier(expression)) {
					continue;
				}
				const imported = imports.get(expression.text);
				if (imported === undefined) record(path, expression.text, operationId);
				else record(imported.path, imported.exportedName, operationId);
			}
		}

		// Some providers keep their operation registry in a same-file const with
		// an arbitrary name (for example, `companionsOperations`). This scan is
		// deliberately ID-only: it accepts only static object members whose value
		// is a same-file operation binding, and never evaluates spreads, factories,
		// or imported values.
		const operationBindings = collectModuleOperationBindings(source);
		const importedBindings = collectImportedBindingNames(source);
		for (const entry of collectStaticOperationRegistryEntries(source, operationBindings)) {
			if (importedBindings.has(entry.binding)) continue;
			record(path, entry.binding, entry.operationId);
		}
	}
	return result;
}

type StaticOperationRegistryEntry = {
	readonly operationId: string;
	readonly binding: string;
};

function collectModuleOperationBindings(source: TS.SourceFile): ReadonlySet<string> {
	const bindings = new Set<string>();
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
			const initializer = unwrapExpression(declaration.initializer);
			if (
				initializer !== undefined &&
				ts.isCallExpression(initializer) &&
				isOperationHelperCall(initializer)
			) {
				bindings.add(declaration.name.text);
			}
		}
	}
	return bindings;
}

function collectImportedBindingNames(source: TS.SourceFile): ReadonlySet<string> {
	const bindings = new Set<string>();
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const clause = statement.importClause;
		if (clause?.name !== undefined) bindings.add(clause.name.text);
		const named = clause?.namedBindings;
		if (named === undefined) continue;
		if (ts.isNamespaceImport(named)) {
			bindings.add(named.name.text);
			continue;
		}
		for (const element of named.elements) bindings.add(element.name.text);
	}
	return bindings;
}

function collectStaticOperationRegistryEntries(
	source: TS.SourceFile,
	operationBindings: ReadonlySet<string>,
): StaticOperationRegistryEntry[] {
	const entries: StaticOperationRegistryEntry[] = [];
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
			const object = unwrapExpression(declaration.initializer);
			if (object === undefined || !ts.isObjectLiteralExpression(object)) continue;
			for (const property of object.properties) {
				if (ts.isSpreadAssignment(property)) continue;
				const name = property.name;
				if (name === undefined || (!ts.isIdentifier(name) && !ts.isStringLiteral(name))) continue;
				const value = propertyValue(property);
				const binding = unwrapExpression(value);
				if (binding === undefined || !ts.isIdentifier(binding)) continue;
				if (!operationBindings.has(binding.text)) continue;
				entries.push({ operationId: name.text, binding: binding.text });
			}
		}
	}
	return entries;
}

function collectImports(
	source: TS.SourceFile,
	containingPath: string,
	sources: ReadonlyMap<string, TS.SourceFile>,
): Map<string, { path: string; exportedName: string }> {
	const imports = new Map<string, { path: string; exportedName: string }>();
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
			continue;
		}
		const target = resolveLocalModule(containingPath, statement.moduleSpecifier.text, sources);
		if (target === undefined) continue;
		const clause = statement.importClause;
		if (clause?.name !== undefined) {
			imports.set(clause.name.text, { path: target, exportedName: "default" });
		}
		const bindings = clause?.namedBindings;
		if (bindings !== undefined && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				imports.set(element.name.text, {
					path: target,
					exportedName: element.propertyName?.text ?? element.name.text,
				});
			}
		}
	}
	return imports;
}

function resolveLocalModule(
	containingPath: string,
	specifier: string,
	sources: ReadonlyMap<string, TS.SourceFile>,
): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = resolve(dirname(containingPath), specifier);
	const emittedExtensionSource = /\.(?:c|m)?js$/.test(base)
		? base.replace(/\.(?:c|m)?js$/, ".ts")
		: undefined;
	for (const candidate of [base, emittedExtensionSource, `${base}.ts`, join(base, "index.ts")]) {
		if (candidate === undefined) continue;
		if (sources.has(candidate)) return candidate;
	}
	return undefined;
}

function slash(path: string): string {
	return path.split("\\").join("/");
}
