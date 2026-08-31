import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

import type TS from "typescript";

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
	| "examples_conflict"
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
	const source = parseSource(fileName, sourceText);
	const parseError = firstSyntaxError(source);
	if (parseError !== undefined) {
		return {
			status: "refused",
			refusals: [refusal(fileName, "<unknown>", "source_syntax", parseError)],
		};
	}

	const constObjects = collectModuleConstObjects(source);
	const discovery = discoverOperationSites(source, fileName, constObjects, options.operationIds);
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
			options.localeFiles ?? [],
		);
		if ("refusal" in plan) {
			refusals.push(plan.refusal);
			continue;
		}
		edits.push(...plan.edits);
		todos.push(...plan.localeTodos);
	}
	if (refusals.length > 0) return { status: "refused", refusals };

	if (edits.length === 0) {
		return {
			status: "unchanged",
			code: sourceText,
			operations: discovery.sites.length,
		};
	}

	const code = applyEdits(sourceText, edits);
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
	localeFiles: readonly string[],
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
	const expanded = expandMembers(site.object, constObjects, fileName, site.operationKey);
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
		const object = resolveObjectInitializer(member, constObjects);
		if (object === undefined) {
			return {
				refusal: refusal(
					fileName,
					site.operationKey,
					"non_literal",
					`${containerName} must be an object literal or a module-level const object literal.`,
				),
			};
		}
		const members = expandMembers(object, constObjects, fileName, site.operationKey);
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
		source,
		"execution_conflict",
	);
	if ("refusal" in timeout) return timeout;
	if (timeout.insert !== undefined) addInsertion(insertions, "annotations", timeout.insert);

	const connection = resolveConnectionMode(
		top.byName,
		toolRouter,
		fileName,
		site.operationKey,
		source,
	);
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
		source,
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
		source,
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
			source,
			"locale_key_conflict",
		);
		if ("refusal" in merged) return merged;
		if (merged.insert !== undefined) addInsertion(insertions, "docs", merged.insert);
	}

	const examples = planExamples(
		top.byName.get("inputExamples"),
		top.byName.get("examples"),
		fileName,
		site,
		source,
		localeFiles,
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

	return { edits, localeTodos: examples.localeTodos };
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
	source: TS.SourceFile,
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
		return { insert: memberText(nested, "connectionMode", source) };
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
	source: TS.SourceFile,
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
	return { insert: memberText(selected, "approval", source) };
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
	source: TS.SourceFile,
	reason: "locale_key_conflict" | "connection_mode_conflict" | "execution_conflict",
): { readonly insert?: string } | { readonly refusal: OperationDeclarationRefusal } {
	if (nested === undefined) return {};
	if (flat === undefined) return { insert: memberText(nested, field, source) };
	const same = equivalentLiteral(flat.initializer, nested.initializer);
	if (same === undefined) {
		return nonLiteral(
			fileName,
			operationKey,
			`${field} must be literal when both top-level and nested declarations exist.`,
		);
	}
	if (!same) {
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
	localeFiles: readonly string[],
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
	if (array.elements.length > 0 && !site.operationIdProven) {
		return {
			refusal: refusal(
				fileName,
				site.operationKey,
				"operation_id_unresolved",
				"inputExamples requires an exact operation id proven from a static operations map.",
			),
		};
	}
	if (array.elements.length > 0 && !localeFiles.includes("locales/en.json")) {
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

	for (let index = 0; index < array.elements.length; index += 1) {
		const element = array.elements[index];
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
		const scenarioKey = `operations.${site.operationKey}.examples.${index}.scenario`;
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
			const rationaleKey = `operations.${site.operationKey}.examples.${index}.rationale`;
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
): {
	readonly sites: OperationSite[];
	readonly refusals: OperationDeclarationRefusal[];
} {
	const sitesByStart = new Map<number, OperationSite>();
	const localIds = new Map(operationIds ?? []);
	const refusals: OperationDeclarationRefusal[] = [];

	for (const map of collectOperationsMaps(source, constObjects, fileName, refusals)) {
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
			if (ts.isObjectLiteralExpression(unwrapped)) {
				sitesByStart.set(unwrapped.getStart(source), {
					object: unwrapped,
					operationKey: key,
					operationIdProven: true,
				});
			}
		}
	}

	const visit = (node: TS.Node): void => {
		if (ts.isCallExpression(node) && isOperationHelperCall(node)) {
			const argument = operationArgument(node);
			const bindingName = enclosingBindingName(node);
			const operationKey =
				(bindingName === undefined ? undefined : localIds.get(bindingName)) ??
				bindingName ??
				"<anonymous>";
			const unwrappedArgument = unwrapExpression(argument);
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
	return {
		sites: [...sitesByStart.values()].sort(
			(left, right) => left.object.getStart(source) - right.object.getStart(source),
		),
		refusals,
	};
}

function collectOperationsMaps(
	source: TS.SourceFile,
	constObjects: ReadonlyMap<string, TS.ObjectLiteralExpression>,
	fileName: string,
	refusals: OperationDeclarationRefusal[],
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
			inspect(node.initializer, "<operations>");
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return [...maps.values()];
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

function expandMembers(
	object: TS.ObjectLiteralExpression,
	constObjects: ReadonlyMap<string, TS.ObjectLiteralExpression>,
	fileName: string,
	operationKey: string,
	seen = new Set<TS.ObjectLiteralExpression>(),
): { readonly members: ResolvedMember[] } | { readonly refusal: OperationDeclarationRefusal } {
	if (seen.has(object)) {
		return nonLiteral(fileName, operationKey, "A module-level object spread is recursive.");
	}
	seen.add(object);
	const members: ResolvedMember[] = [];
	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property)) {
			const expression = unwrapExpression(property.expression);
			const spreadObject =
				expression !== undefined && ts.isIdentifier(expression)
					? constObjects.get(expression.text)
					: undefined;
			if (spreadObject === undefined) {
				members.push({ name: "<spread>", property });
				continue;
			}
			const expanded = expandMembers(
				spreadObject,
				constObjects,
				fileName,
				operationKey,
				new Set(seen),
			);
			if ("refusal" in expanded) return expanded;
			members.push(...expanded.members);
			continue;
		}
		const name = staticPropertyName(property.name);
		if (name === undefined) {
			return nonLiteral(fileName, operationKey, "A declaration member uses a computed name.");
		}
		const initializer = propertyValue(property);
		members.push({ name, property, initializer });
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
		if (byName.has(member.name)) {
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
		members.push({ name, property, initializer });
	}
	const indexed = indexMembers(members, fileName, operationKey);
	if ("refusal" in indexed) return indexed;
	return { byName: indexed.byName };
}

function resolveObjectInitializer(
	member: ResolvedMember,
	constObjects: ReadonlyMap<string, TS.ObjectLiteralExpression>,
): TS.ObjectLiteralExpression | undefined {
	const initializer = unwrapExpression(member.initializer);
	if (initializer === undefined) return undefined;
	if (ts.isObjectLiteralExpression(initializer)) return initializer;
	if (ts.isIdentifier(initializer)) return constObjects.get(initializer.text);
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

function memberText(member: ResolvedMember, name: string, source: TS.SourceFile): string {
	if (member.initializer === undefined) return name;
	return `${name}: ${member.initializer.getText(source)}`;
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
			readonly sidecar?: string;
			readonly localeTodoCount: number;
	  }
	| {
			readonly status: "refused";
			readonly providerRoot: string;
			readonly refusals: readonly OperationDeclarationRefusal[];
	  };

/** Run the file transform repository-wide, committing writes only if every file is provable. */
export function migrateOperationDeclarationRepository(
	providerRootInput: string,
	options: { readonly check?: boolean } = {},
): OperationDeclarationRepositoryResult {
	const providerRoot = resolve(providerRootInput);
	const sourceFiles = collectSourceFiles(providerRoot);
	const localeFiles = collectLocaleFiles(providerRoot);
	const operationIds = buildOperationIdIndex(sourceFiles);
	const pendingWrites = new Map<string, string>();
	const changedFiles: string[] = [];
	const todos: LocaleTodo[] = [];
	const refusals: OperationDeclarationRefusal[] = [];
	let operationCount = 0;

	for (const sourcePath of sourceFiles) {
		const relativePath = slash(relative(providerRoot, sourcePath));
		const result = migrateOperationDeclaration(readFileSync(sourcePath, "utf8"), relativePath, {
			operationIds: operationIds.get(sourcePath),
			localeFiles,
		});
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

	const todoConflict = findLocaleTodoConflict(todos);
	if (todoConflict !== undefined) refusals.push(todoConflict);
	if (refusals.length > 0) {
		return { status: "refused", providerRoot, refusals };
	}

	if (pendingWrites.size === 0) {
		return {
			status: "unchanged",
			providerRoot,
			changedFiles: [],
			operationCount,
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
				walk(join(directory, entry.name));
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

function buildOperationIdIndex(sourceFiles: readonly string[]): Map<string, Map<string, string>> {
	const result = new Map<string, Map<string, string>>();
	const sources = new Map<string, TS.SourceFile>();
	for (const path of sourceFiles) {
		const source = parseSource(path, readFileSync(path, "utf8"));
		if (firstSyntaxError(source) === undefined) sources.set(path, source);
	}

	const record = (path: string, binding: string, operationId: string): void => {
		const map = result.get(path) ?? new Map<string, string>();
		const previous = map.get(binding);
		if (previous === undefined || previous === operationId) map.set(binding, operationId);
		else map.delete(binding);
		result.set(path, map);
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
	}
	return result;
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
	for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
		if (sources.has(candidate)) return candidate;
	}
	return undefined;
}

function slash(path: string): string {
	return path.split("\\").join("/");
}
