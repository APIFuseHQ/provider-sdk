import { glob } from "node:fs/promises";

import ts from "typescript";

const justificationMarker = "test-invalid:";
const expectErrorDirective = "@ts-expect-error";

export interface TestTypesafetyViolation {
	line: number;
	message: string;
}

interface CommentRange extends ts.CommentRange {
	text: string;
}

function collectCommentRanges(sourceFile: ts.SourceFile): CommentRange[] {
	const source = sourceFile.text;
	const ranges = new Map<string, CommentRange>();

	const addRanges = (comments: readonly ts.CommentRange[] | undefined): void => {
		for (const comment of comments ?? []) {
			ranges.set(`${comment.pos}:${comment.end}`, {
				...comment,
				text: source.slice(comment.pos, comment.end),
			});
		}
	};

	const visit = (node: ts.Node): void => {
		addRanges(ts.getLeadingCommentRanges(source, node.getFullStart()));
		addRanges(ts.getTrailingCommentRanges(source, node.getEnd()));
		for (const child of node.getChildren(sourceFile)) visit(child);
	};

	visit(sourceFile);
	return [...ranges.values()].sort((left, right) => left.pos - right.pos);
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
	return sourceFile.getLineAndCharacterOfPosition(position).line;
}

function assertionAnchor(node: ts.AsExpression | ts.TypeAssertion): ts.Node {
	if (ts.isTypeAssertionExpression(node)) return node;

	const asToken = node
		.getChildren(node.getSourceFile())
		.find((child) => child.kind === ts.SyntaxKind.AsKeyword);
	return asToken ?? node.type;
}

function unwrapTypeNode(type: ts.TypeNode): ts.TypeNode {
	let current = type;
	while (ts.isParenthesizedTypeNode(current)) current = current.type;
	return current;
}

function typeText(node: ts.AsExpression | ts.TypeAssertion, sourceFile: ts.SourceFile): string {
	const type = unwrapTypeNode(node.type);
	// globalThis.Error names the same built-in as Error; collapse the qualifier
	// so the hard rule cannot be sidestepped by qualification.
	if (ts.isTypeReferenceNode(type) && ts.isQualifiedName(type.typeName)) {
		const { left, right } = type.typeName;
		if (ts.isIdentifier(left) && left.text === "globalThis") return right.text;
	}
	return type.getText(sourceFile);
}

function assertionOperand(
	expression: ts.Expression,
): ts.AsExpression | ts.TypeAssertion | undefined {
	let operand = expression;
	while (ts.isParenthesizedExpression(operand) || ts.isSatisfiesExpression(operand)) {
		operand = operand.expression;
	}
	return ts.isAsExpression(operand) || ts.isTypeAssertionExpression(operand) ? operand : undefined;
}

function enclosingStatement(node: ts.Node): ts.Statement | undefined {
	return ts.findAncestor(node.parent, ts.isStatement);
}

function endsStatement(node: ts.AsExpression, sourceFile: ts.SourceFile): boolean {
	const statement = enclosingStatement(node);
	if (!statement) return false;

	const lastToken = statement.getLastToken(sourceFile);
	return lastToken?.kind === ts.SyntaxKind.SemicolonToken && lastToken.getFullStart() === node.end;
}

function isReflectApplyCall(node: ts.CallExpression): boolean {
	return (
		ts.isPropertyAccessExpression(node.expression) &&
		ts.isIdentifier(node.expression.expression) &&
		node.expression.expression.text === "Reflect" &&
		node.expression.name.text === "apply"
	);
}

function isFunctionCallee(expression: ts.Expression): boolean {
	return (
		(ts.isIdentifier(expression) && expression.text === "Function") ||
		(ts.isPropertyAccessExpression(expression) &&
			ts.isIdentifier(expression.expression) &&
			expression.expression.text === "globalThis" &&
			expression.name.text === "Function")
	);
}

function attachedLeadingComments(
	statement: ts.Statement,
	sourceFile: ts.SourceFile,
): CommentRange[] {
	const source = sourceFile.text;
	const ranges = (ts.getLeadingCommentRanges(source, statement.getFullStart()) ?? []).map(
		(comment) => ({ ...comment, text: source.slice(comment.pos, comment.end) }),
	);
	const attached: CommentRange[] = [];
	let boundaryLine = lineOf(sourceFile, statement.getStart(sourceFile));

	for (let index = ranges.length - 1; index >= 0; index -= 1) {
		const comment = ranges[index];
		if (!comment) continue;
		const commentEndLine = lineOf(sourceFile, comment.end);
		if (boundaryLine - commentEndLine > 1) break;
		attached.push(comment);
		boundaryLine = lineOf(sourceFile, comment.pos);
	}

	return attached;
}

function isStandaloneComment(comment: CommentRange, sourceFile: ts.SourceFile): boolean {
	const source = sourceFile.text;
	const lineStarts = sourceFile.getLineStarts();
	const startLine = lineOf(sourceFile, comment.pos);
	const endLine = lineOf(sourceFile, comment.end);
	const lineStart = lineStarts[startLine] ?? 0;
	const lineEnd = lineStarts[endLine + 1] ?? source.length;
	return (
		source.slice(lineStart, comment.pos).trim() === "" &&
		source.slice(comment.end, lineEnd).trim() === ""
	);
}

function immediatelyPrecedingCommentBlock(
	anchor: ts.Node,
	comments: readonly CommentRange[],
	sourceFile: ts.SourceFile,
): CommentRange[] {
	const anchorStart = anchor.getStart(sourceFile);
	const anchorLine = lineOf(sourceFile, anchorStart);
	const preceding = comments.filter((comment) => comment.end <= anchorStart);
	const attached: CommentRange[] = [];
	let boundaryLine = anchorLine;

	for (let index = preceding.length - 1; index >= 0; index -= 1) {
		const comment = preceding[index];
		if (!comment) continue;
		const commentEndLine = lineOf(sourceFile, comment.end);
		if (boundaryLine - commentEndLine > 1 || !isStandaloneComment(comment, sourceFile)) break;
		attached.push(comment);
		boundaryLine = lineOf(sourceFile, comment.pos);
	}

	return attached;
}

function hasJustification(
	node: ts.Node,
	anchor: ts.Node,
	comments: readonly CommentRange[],
	sourceFile: ts.SourceFile,
): boolean {
	const anchorLine = lineOf(sourceFile, anchor.getStart(sourceFile));
	if (
		comments.some(
			(comment) =>
				lineOf(sourceFile, comment.pos) <= anchorLine &&
				lineOf(sourceFile, comment.end) >= anchorLine &&
				comment.text.includes(justificationMarker),
		)
	) {
		return true;
	}

	const statement = enclosingStatement(node);
	if (
		statement !== undefined &&
		attachedLeadingComments(statement, sourceFile).some((comment) =>
			comment.text.includes(justificationMarker),
		)
	) {
		return true;
	}

	return immediatelyPrecedingCommentBlock(anchor, comments, sourceFile).some((comment) =>
		comment.text.includes(justificationMarker),
	);
}

function scanParsedSource(sourceFile: ts.SourceFile): TestTypesafetyViolation[] {
	const comments = collectCommentRanges(sourceFile);
	const violations: TestTypesafetyViolation[] = [];

	const addViolation = (node: ts.Node, message: string): void => {
		violations.push({
			line: lineOf(sourceFile, node.getStart(sourceFile)) + 1,
			message,
		});
	};

	for (const comment of comments) {
		if (
			comment.text.includes(expectErrorDirective) &&
			!comment.text.includes(justificationMarker)
		) {
			const directivePosition = comment.pos + comment.text.indexOf(expectErrorDirective);
			violations.push({
				line: lineOf(sourceFile, directivePosition) + 1,
				message: "@ts-expect-error requires a test-invalid justification",
			});
		}
	}

	const visit = (node: ts.Node): void => {
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
			const anchor = assertionAnchor(node);
			const assertedType = typeText(node, sourceFile);
			const form = ts.isAsExpression(node) ? "as" : "angle";

			if (assertedType === "any" || assertedType === "Error") {
				addViolation(anchor, `forbidden unchecked ${form} assertion to ${assertedType}`);
			}

			const operand = assertionOperand(node.expression);
			if (operand && typeText(operand, sourceFile) === "unknown") {
				addViolation(anchor, "forbidden double assertion through unknown");
			}

			if (ts.isAsExpression(node) && assertedType === "T" && endsStatement(node, sourceFile)) {
				addViolation(anchor, "forbidden unchecked assertion as T at statement end");
			}

			if (assertedType === "never" && !hasJustification(node, anchor, comments, sourceFile)) {
				addViolation(
					anchor,
					`unchecked ${form} assertion to never requires a test-invalid justification`,
				);
			}
		}

		if (ts.isCallExpression(node) && isReflectApplyCall(node)) {
			if (!hasJustification(node, node.expression, comments, sourceFile)) {
				addViolation(
					node.expression,
					"unchecked Reflect.apply call requires a test-invalid justification",
				);
			}
		}

		if (
			(ts.isCallExpression(node) || ts.isNewExpression(node)) &&
			isFunctionCallee(node.expression)
		) {
			if (!hasJustification(node, node.expression, comments, sourceFile)) {
				addViolation(
					node.expression,
					"unchecked Function constructor requires a test-invalid justification",
				);
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return violations.sort((left, right) => left.line - right.line);
}

function scanSourceText(source: string, path: string): TestTypesafetyViolation[] {
	return scanParsedSource(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true));
}

export function scanTestTypesafety(source: string | string[]): TestTypesafetyViolation[] {
	return scanSourceText(typeof source === "string" ? source : source.join("\n"), "<test>.ts");
}

async function main(): Promise<void> {
	const files = [
		...(await Array.fromAsync(glob("src/**/*.test.ts"))),
		...(await Array.fromAsync(glob("src/**/*.spec.ts"))),
		...(await Array.fromAsync(glob("src/*.test.ts"))),
	];
	const uniqueFiles = [...new Set(files)];
	const violations: string[] = [];

	for (const file of uniqueFiles) {
		for (const violation of scanSourceText(await Bun.file(file).text(), file)) {
			violations.push(`${file}:${violation.line}: ${violation.message}`);
		}
	}

	if (violations.length > 0) {
		console.error("test-typesafety: unchecked test escape(s) found");
		for (const violation of violations) console.error(violation);
		process.exit(1);
	}

	console.log(
		`test-typesafety: checked ${uniqueFiles.length} test files; no unchecked escapes found`,
	);
}

if (import.meta.main) await main();
