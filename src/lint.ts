import {
	SDK_ERROR_REGISTRY_BY_CODE,
	SDK_RUNTIME_OWNED_ERROR_CODES,
	SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES,
} from "./error-resolution.js";
import { isExpectedErrorByCode } from "./health-scenario.js";
import {
	isProviderFailureCategory,
	type ProviderErrorSource,
	type ProviderFailureCategory,
	sourceForCategory,
} from "./observability.js";
import { lintPublicSchemaFieldNames } from "./public-schema-field-lint.js";
import {
	isStealthOwnedHeaderName,
	SDK_OWNED_CHROME_HEADER_PREFIX,
} from "./runtime/stealth-owned-headers.js";
import type { AuthMode } from "./types.js";
import { getTypeScript, scriptKindForSourceFile } from "./typescript-module.js";

const CREDENTIAL_BEARING_AUTH_MODES = [
	"credentials",
	"oauth2",
	"oauth2_proxied",
] satisfies readonly AuthMode[];

function isCredentialBearingAuthMode(mode: AuthMode | undefined): boolean {
	return CREDENTIAL_BEARING_AUTH_MODES.some((credentialMode) => credentialMode === mode);
}

/** The declaration shape the lint reads structurally; validity is `defineProvider`'s job. */
type ProviderAuthLike = {
	mode?: AuthMode;
	flow?: {
		start?: unknown;
		continue?: unknown;
		poll?: unknown;
		abort?: unknown;
		refresh?: unknown;
	};
};

// Operations that perform an auth-lifecycle action belong on the single
// `auth.flow` interface, never on a provider operation:
//   - entry (login / signin / authenticate) => auth.flow.start/continue
//   - exit  (logout / signout / disconnect) => auth.flow.abort
//
// Matching works on `-`/`_` separated segments rather than a raw substring or a
// leading anchor, so `shop-logout`, `shop_logout` and `user-sign-out-everywhere`
// are all recognised: a domain prefix does not make the operation any less of an
// auth-lifecycle action, and operation ids may use either separator.
//
// Vocabulary is split into two tiers because auth words collide with ordinary
// domain verbs. Measured against the live fleet plus synthetic domain ids:
//   - `authorize-payment`, `revoke-invitation`, `unlink-record`,
//     `disconnect-device` are domain actions that never touch the connection
//     credential, so these verbs are NOT matched as segments;
//   - the same verbs as a complete operation id (`authorize`, `revoke`) do
//     refer to the credential itself, so they are matched only in that form.
// `exchange`, `callback`, `connect`, `session`, `token`, `credential`,
// `password` and `otp` stay out entirely for the same reason.
const AUTH_LIFECYCLE_SEGMENT_WORDS = new Set([
	"login",
	"logout",
	"signin",
	"signout",
	"signup",
	"authenticate",
	"reauth",
	"auth",
]);

// Ambiguous as a prefix, unambiguous when they are the whole operation id.
const AUTH_LIFECYCLE_WHOLE_ID_WORDS = new Set(["authorize", "revoke", "unlink", "disconnect"]);

// A verb stem followed by a direction word across two segments: `sign-out`,
// `user_sign_up_flow`, and the spelled-out `log-in` / `shop-log-out` forms
// (their fused equivalents `login`/`logout` live in the segment set above).
// `sign` pairs match anywhere; `log` pairs match only at the END of the id,
// because mid-id `log` is the noun in domain phrases measured against real
// fleets (`audit-log-in-range`, `change-log-out-of-band` are reads of a log,
// while `shop-log-out` is a logout).
const AUTH_DIRECTION_PAIRS: ReadonlyMap<
	string,
	{ directions: ReadonlySet<string>; endOnly: boolean }
> = new Map([
	["sign", { directions: new Set(["in", "out", "up"]), endOnly: false }],
	["log", { directions: new Set(["in", "out"]), endOnly: true }],
]);

// Legacy anchored form kept for token-plumbing words whose bare use is only
// auth-related when it leads the operation id (`exchange-code`, `refresh`).
const AUTH_OPERATION_ID_PATTERN =
	/^(?:auth[-_])?(?:login|exchange|continue|refresh|callback)(?:[-_]|$)/i;

function isAuthLifecycleOperationId(operationId: string, authMode: string): boolean {
	const segments = operationId.toLowerCase().split(/[-_]+/).filter(Boolean);

	if (segments.some((segment) => AUTH_LIFECYCLE_SEGMENT_WORDS.has(segment))) return true;

	// A verb stem + direction spread across two segments (`sign-out`,
	// `sign_up`, `shop-log-out`); see AUTH_DIRECTION_PAIRS for positioning.
	if (
		segments.some((segment, index) => {
			const pair = AUTH_DIRECTION_PAIRS.get(segment);
			if (pair === undefined || index + 1 >= segments.length) return false;
			if (!pair.directions.has(segments[index + 1] as string)) return false;
			return pair.endOnly ? index + 2 === segments.length : true;
		})
	) {
		return true;
	}

	if (segments.length === 1 && AUTH_LIFECYCLE_WHOLE_ID_WORDS.has(segments[0] as string)) {
		return true;
	}

	// The legacy anchored pattern keeps its original scope. It matches ordinary
	// domain ids such as `exchange-rates` and `refresh-catalog`, so extending it
	// to `oauth2_proxied` would spread that behavior to providers it never
	// applied to; proxied providers are covered by the segment tiers above.
	if (authMode === "credentials" || authMode === "oauth2") {
		return AUTH_OPERATION_ID_PATTERN.test(operationId);
	}

	return false;
}

type ProviderContractMetaLike = {
	publicSchemaFieldNames?: "normalized";
	pinnedWireFieldPaths?: readonly {
		readonly path: string;
		readonly reason: string;
	}[];
};

export interface LintDiagnostic {
	rule: string;
	level: "error" | "warn";
	message: string;
	field?: string;
}

/**
 * `official` for fleet providers, `standalone` for bounty submissions
 * (`apifuse submit-check`). Drives the level of the browser-driver findings in
 * `bundleProvider`.
 */
export type ProviderLintMode = "official" | "standalone";

/**
 * @deprecated `lintProvider` takes no options: the browser-driver level the
 * mode used to drive now belongs to `bundleProvider(providerRoot, { mode })`.
 * The argument is ignored and is removed in the next major.
 */
type ProviderLintOptions = {
	mode?: ProviderLintMode;
};

let warnedProviderLintOptions = false;

function warnProviderLintOptionsOnce(options: ProviderLintOptions | undefined): void {
	if (options === undefined || warnedProviderLintOptions) return;
	warnedProviderLintOptions = true;
	console.warn(
		"[@apifuse/provider-sdk] lintProvider(provider, options) is deprecated: the options argument is ignored and is removed in the next major; pass mode to bundleProvider(providerRoot, { mode }) instead.",
	);
}

/**
 * A non-blocking audit line: a finding the author acknowledged with
 * `// @apifuse-allow <rule>: <reason>`, kept visible in `apifuse check` output.
 */
export interface ProviderLintInformation {
	rule: string;
	message: string;
	field?: string;
}

/** Diagnostics plus the acknowledged findings that accompany them. */
export interface ProviderLintResult {
	diagnostics: LintDiagnostic[];
	information: ProviderLintInformation[];
}

type ProviderSourceLike = {
	authFlowSource?: string;
	providerSourceFiles?: Record<string, string>;
	operations?: Record<string, { handler?: unknown; source?: string }>;
};

function hasBidirectionalFixtures(fixtures: unknown): boolean {
	if (!fixtures || typeof fixtures !== "object") {
		return true;
	}

	return "request" in fixtures && "response" in fixtures;
}

function getOperationSource(operation: { handler?: unknown; source?: string }): string {
	if (operation.source) {
		return operation.source;
	}
	return typeof operation.handler === "function" ? operation.handler.toString() : "";
}

function lintCredentialWriteUsage(provider: {
	operations?: Record<string, { handler?: unknown; source?: string }>;
}): LintDiagnostic[] {
	if (!provider.operations) {
		return [];
	}

	return Object.entries(provider.operations).flatMap(([operationKey, operation]) => {
		const source = getOperationSource(operation);
		if (!/\bctx\.credential\.(?:set|setMany)\s*\(/.test(source)) {
			return [];
		}

		return [
			{
				rule: "ctx-credential-write-forbidden-in-handler",
				level: "error" as const,
				field: `operations.${operationKey}.handler`,
				message:
					"Operation handlers must not mutate credentials; return refreshed credentials from auth.flow.refresh instead.",
			},
		];
	});
}

// Captures the constructor name so a rule can pick its own scope (the
// health-check expectedErrors rule reads ProviderError, AuthError and
// ValidationError sites).
const THROWN_ERROR_CONSTRUCTION_PATTERN = /new\s+(ProviderError|AuthError|ValidationError)\s*\(/g;

const TEST_SOURCE_FILE_PATTERN = /(?:^|\/)(?:__tests__|__mocks__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const RECORDED_FIXTURE_SOURCE_FILE_PATTERN =
	/(?:^|\/)__fixtures__(?:\/|$)|(?:^|\/)__tests__\/fixtures(?:\/|$)/;
const JAVASCRIPT_SOURCE_FILE_PATTERN = /\.[cm]?[jt]sx?$/;
const VERSIONED_PROFILE_LITERAL_PATTERN =
	/\b(?:chrome|chromium|firefox|safari|edge|opera|ios[-_]safari)[-_]\d+(?:[._-]\d+)*(?=$|[^A-Za-z0-9])/i;
const VERSIONED_USER_AGENT_PATTERN = /\b(?:Chrome|CriOS|Firefox|FxiOS|EdgA?|OPR)\/\d+(?:\.\d+)*/i;
const VERSIONED_SAFARI_USER_AGENT_PATTERN = /\bVersion\/(\d+(?:\.\d+)*)(?=[\s\S]*\bSafari\/\d)/i;
const VERSIONED_CLIENT_HINT_PATTERN = /(?:^|[;,\s])v\s*=\s*["']?\d+/i;
// Calls that write a header entry as (name, value): Headers/Map `set` and
// `append`, Node's `setHeader`. Predicates, replacements, and logging calls
// take string arguments too and must not count as header writes.
const HEADER_SETTER_CALLEE_PATTERN = /^(?:set|append|setHeader|addHeader)$/;
const OWNED_CLIENT_HINT_HEADER_PREFIX = "sec-ch-ua";

type BrowserVersionLiteralKind = "profile" | "user-agent" | "sec-ch-ua" | "owned-header";

type BrowserVersionLiteralFinding = {
	kind: BrowserVersionLiteralKind;
	literal: string;
	position: number;
};

function staticStringText(node: import("typescript").Node | undefined): string | undefined {
	if (!node) return undefined;
	const ts = getTypeScript();
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	return undefined;
}

function staticPropertyName(node: import("typescript").PropertyName): string | undefined {
	const ts = getTypeScript();
	if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
		return node.text;
	}
	if (ts.isComputedPropertyName(node)) return staticStringText(node.expression);
	return undefined;
}

function isSecChUaHeaderName(value: string | undefined): boolean {
	return value?.toLowerCase() === "sec-ch-ua";
}

/**
 * True for the code paths that reach the stealth transport: `ctx.stealth`,
 * `ctx["stealth"]`, and `const { stealth } = ctx`. Read from the AST so a
 * comment or string that mentions ctx.stealth does not scope a ctx.http file
 * into this rule.
 */
function isStealthContextAccess(node: import("typescript").Node): boolean {
	const ts = getTypeScript();
	if (ts.isPropertyAccessExpression(node)) {
		return (
			ts.isIdentifier(node.expression) &&
			node.expression.text === "ctx" &&
			node.name.text === "stealth"
		);
	}
	if (ts.isElementAccessExpression(node)) {
		return (
			ts.isIdentifier(node.expression) &&
			node.expression.text === "ctx" &&
			staticStringText(node.argumentExpression) === "stealth"
		);
	}
	if (ts.isBindingElement(node)) {
		const key = node.propertyName ?? node.name;
		if (!ts.isIdentifier(key) || key.text !== "stealth") return false;
		const declaration = node.parent?.parent;
		return (
			declaration !== undefined &&
			ts.isVariableDeclaration(declaration) &&
			declaration.initializer !== undefined &&
			ts.isIdentifier(declaration.initializer) &&
			declaration.initializer.text === "ctx"
		);
	}
	return false;
}

function isTupleTypeNode(type: import("typescript").TypeNode | undefined): boolean {
	if (!type) return false;
	const ts = getTypeScript();
	if (ts.isTypeOperatorNode(type)) return isTupleTypeNode(type.type);
	return ts.isTupleTypeNode(type);
}

/**
 * True where a two-element array is consumed as a `[name, value]` header entry:
 * inside an entries list (`new Headers([[name, value]])`,
 * `Object.fromEntries([...])`), passed to a call such as `tuples.push(...)`, or
 * declared with a tuple type. A two-name list is bound, iterated, or handed to
 * a constructor instead — `const STRIP = ["sec-fetch-dest", "referer"]`,
 * `for (const name of [...])`, `new Set([...])` — and is not an entry. The
 * position decides because a Sec-Fetch-* value ("document", "navigate") is
 * token-shaped exactly like a header name.
 */
function isHeaderEntryPosition(node: import("typescript").ArrayLiteralExpression): boolean {
	const ts = getTypeScript();
	let child: import("typescript").Node = node;
	let parent = node.parent;
	while (
		parent &&
		(ts.isParenthesizedExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isSatisfiesExpression(parent) ||
			ts.isTypeAssertionExpression(parent))
	) {
		if (!ts.isParenthesizedExpression(parent) && isTupleTypeNode(parent.type)) return true;
		child = parent;
		parent = parent.parent;
	}
	if (!parent) return false;
	if (ts.isArrayLiteralExpression(parent)) return true;
	if (ts.isCallExpression(parent)) return parent.arguments.some((argument) => argument === child);
	if (ts.isVariableDeclaration(parent)) {
		return parent.initializer === child && isTupleTypeNode(parent.type);
	}
	return false;
}

function isStaticUndefined(node: import("typescript").Node | undefined): boolean {
	if (!node) return false;
	const ts = getTypeScript();
	return (ts.isIdentifier(node) && node.text === "undefined") || ts.isVoidExpression(node);
}

function calleeName(node: import("typescript").CallExpression): string | undefined {
	const ts = getTypeScript();
	if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
	if (ts.isIdentifier(node.expression)) return node.expression.text;
	return undefined;
}

/**
 * Header names this rule reports in ctx.stealth files: the Sec-Fetch-* and
 * client-hint (sec-ch-ua*) families, restricted to what the stealth runtime
 * really rejects (isStealthOwnedHeaderName). Deliberately narrower than the
 * runtime rejection: host, connection, and accept-encoding are left alone
 * because ctx.http callers set them legitimately in the same files, and
 * user-agent only reaches a finding through the "user-agent" kind, which
 * matches a versioned literal value rather than the name.
 *
 * This rule is the early, same-file signal only. The complete check is the
 * offline test harness: `runStandardTests` runs every `ctx.stealth` request
 * through the runtime's own `assertCallerHeadersSupported`, so a header spread
 * from another module, or a user-agent read from a variable or
 * `getStealthProfile(...)`, fails the provider's tests exactly as it would fail
 * in production.
 */
function isReportedOwnedHeaderName(value: string | undefined): boolean {
	if (value === undefined) return false;
	const name = value.toLowerCase();
	if (!isStealthOwnedHeaderName(name)) return false;
	if (name.startsWith(SDK_OWNED_CHROME_HEADER_PREFIX)) {
		return name.length > SDK_OWNED_CHROME_HEADER_PREFIX.length;
	}
	return name.startsWith(OWNED_CLIENT_HINT_HEADER_PREFIX);
}

function collectBrowserVersionLiteralFindings(
	fileName: string,
	source: string,
): BrowserVersionLiteralFinding[] {
	const ts = getTypeScript();
	const sourceFile = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKindForSourceFile(ts, fileName),
	);
	let findings: BrowserVersionLiteralFinding[] = [];
	const seen = new Set<string>();
	// Owned-header entries only count once the file is known to reach
	// ctx.stealth, which may appear after the entry; collect them and decide
	// after the walk.
	let stealthAccess = false;
	const ownedHeaderEntries: Array<{ name: string; position: number; valuePosition?: number }> = [];

	const addFinding = (kind: BrowserVersionLiteralKind, literal: string, position: number) => {
		const key = `${kind}:${position}:${literal}`;
		if (seen.has(key)) return;
		seen.add(key);
		findings.push({ kind, literal, position });
	};

	const inspectLiteral = (text: string, position: number) => {
		const profile = text.match(VERSIONED_PROFILE_LITERAL_PATTERN)?.[0];
		if (profile) addFinding("profile", profile, position);

		const userAgent =
			text.match(VERSIONED_USER_AGENT_PATTERN)?.[0] ??
			text.match(VERSIONED_SAFARI_USER_AGENT_PATTERN)?.[0];
		if (userAgent) addFinding("user-agent", userAgent, position);
	};

	const inspectSecChUaValue = (node: import("typescript").Node | undefined) => {
		const text = staticStringText(node);
		if (text && VERSIONED_CLIENT_HINT_PATTERN.test(text)) {
			addFinding("sec-ch-ua", "sec-ch-ua", node!.getStart(sourceFile));
		}
	};

	// A header entry `name: value` in any of the shapes below. In a ctx.stealth
	// file an owned name is the finding (the runtime rejects it whatever the
	// value); elsewhere only a versioned sec-ch-ua value is. A statically
	// undefined value is exempt only in the "record" shapes, the ones the
	// runtime drops before the ownership check (`normalizedHeaderEntries`):
	// `Headers.set(name, undefined)` stringifies to "undefined" and still
	// throws, so it stays a finding.
	const inspectHeaderEntry = (
		nameNode: import("typescript").Node,
		name: string | undefined,
		valueNode: import("typescript").Node | undefined,
		ownedHeaderShape: false | "record" | "entry",
	) => {
		if (name === undefined) return;
		if (
			ownedHeaderShape !== false &&
			isReportedOwnedHeaderName(name) &&
			!(ownedHeaderShape === "record" && isStaticUndefined(valueNode))
		) {
			ownedHeaderEntries.push({
				name,
				position: nameNode.getStart(sourceFile),
				valuePosition: valueNode?.getStart(sourceFile),
			});
		}
		if (isSecChUaHeaderName(name)) inspectSecChUaValue(valueNode);
	};

	const visit = (node: import("typescript").Node) => {
		const text = staticStringText(node);
		if (text !== undefined) inspectLiteral(text, node.getStart(sourceFile));
		if (isStealthContextAccess(node)) stealthAccess = true;

		if (ts.isPropertyAssignment(node)) {
			inspectHeaderEntry(node.name, staticPropertyName(node.name), node.initializer, "record");
		}

		if (ts.isCallExpression(node) && node.arguments[0]) {
			// Only `headers.set(name, value)`-style calls write a header;
			// `name.startsWith("sec-fetch-")` or `log("sec-fetch-dest", x)` do not.
			inspectHeaderEntry(
				node.arguments[0],
				staticStringText(node.arguments[0]),
				node.arguments[1],
				node.arguments.length >= 2 && HEADER_SETTER_CALLEE_PATTERN.test(calleeName(node) ?? "")
					? "entry"
					: false,
			);
		}

		if (ts.isArrayLiteralExpression(node) && node.elements[0]) {
			// Only a `[name, value]` tuple is a header: a two-element array in an
			// entry position (isHeaderEntryPosition) whose second element is not
			// itself an owned name.
			const second = node.elements[1];
			inspectHeaderEntry(
				node.elements[0],
				staticStringText(node.elements[0]),
				second,
				node.elements.length === 2 &&
					isHeaderEntryPosition(node) &&
					!isStealthOwnedHeaderName(staticStringText(second) ?? "")
					? "entry"
					: false,
			);
		}

		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
			ts.isElementAccessExpression(node.left)
		) {
			const nameNode = node.left.argumentExpression;
			inspectHeaderEntry(nameNode, staticStringText(nameNode), node.right, "record");
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	if (stealthAccess) {
		// The owned name is the finding; do not also report its sec-ch-ua value.
		const shadowedValues = new Set(ownedHeaderEntries.map((entry) => entry.valuePosition));
		findings = findings.filter(
			(finding) => !(finding.kind === "sec-ch-ua" && shadowedValues.has(finding.position)),
		);
		for (const entry of ownedHeaderEntries) {
			addFinding("owned-header", entry.name, entry.position);
		}
	}
	return findings.sort((left, right) => left.position - right.position);
}

function browserVersionLiteralMessage(finding: BrowserVersionLiteralFinding): string {
	switch (finding.kind) {
		case "profile":
			return `Hardcoded stealth profile "${finding.literal}" pins a browser version and will rot. Select the browser and OS structurally, for example stealth: { browser: "chrome", os: "macos" }.`;
		case "user-agent":
			return `Hardcoded User-Agent browser version "${finding.literal}" can disagree with the stealth TLS fingerprint. Remove the literal. ctx.stealth owns User-Agent and rejects a caller value with STEALTH_HEADER_OVERRIDE_UNSUPPORTED, so omit the header there and select the profile with stealth: { browser: "chrome", os: "macos" }. For ctx.http only, derive it from getStealthProfile({ browser: "chrome", os: "macos" }).userAgent.`;
		case "sec-ch-ua":
			return 'Hardcoded sec-ch-ua versions can disagree with the stealth TLS fingerprint. Remove the literal and let ctx.stealth generate client hints from stealth: { browser: "chrome", os: "macos" }. ctx.stealth also owns User-Agent, so omit that header there as well; for ctx.http only, derive it from getStealthProfile({ browser: "chrome", os: "macos" }).userAgent.';
		case "owned-header":
			return `ctx.stealth owns the "${finding.literal}" header and rejects a caller value with STEALTH_HEADER_OVERRIDE_UNSUPPORTED (HTTP 500 at request time). Remove it; declare stealth: { requestClass: "navigation" | "form-post" | "xhr" | "post" } to drive Sec-Fetch-* and select the profile with stealth: { browser: "chrome", os: "macos" } for client hints.`;
	}
}

function lintBrowserVersionLiterals(provider: ProviderSourceLike): LintDiagnostic[] {
	const sources: Array<{ field: string; fileName: string; source: string }> = [];
	const sourceFiles = Object.entries(provider.providerSourceFiles ?? {}).filter(
		([filePath]) =>
			JAVASCRIPT_SOURCE_FILE_PATTERN.test(filePath) &&
			!TEST_SOURCE_FILE_PATTERN.test(filePath) &&
			!RECORDED_FIXTURE_SOURCE_FILE_PATTERN.test(filePath),
	);
	if (sourceFiles.length > 0) {
		for (const [filePath, source] of sourceFiles) {
			sources.push({ field: `sourceFiles.${filePath}`, fileName: filePath, source });
		}
	} else {
		if (provider.authFlowSource)
			sources.push({
				field: "auth.flow",
				fileName: "auth-flow.ts",
				source: provider.authFlowSource,
			});
		for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
			const source = getOperationSource(operation);
			if (source)
				sources.push({
					field: `operations.${operationKey}.handler`,
					fileName: `${operationKey}.ts`,
					source,
				});
		}
	}

	return sources.flatMap(({ field, fileName, source }) =>
		collectBrowserVersionLiteralFindings(fileName, source).map((finding) => ({
			rule: "browser-version-literal",
			level: "error" as const,
			field,
			message: browserVersionLiteralMessage(finding),
		})),
	);
}

/**
 * Skips a string literal starting at `startIndex` (which must point at the
 * opening quote). Returns the index of the closing quote, or -1 when the
 * literal is unterminated. Template literals handle nested `${...}`
 * expressions, including strings inside them.
 */
function skipStringLiteral(source: string, startIndex: number): number {
	const quote = source[startIndex];
	for (let index = startIndex + 1; index < source.length; index++) {
		const char = source[index];
		if (char === "\\") {
			index++;
			continue;
		}
		if (quote === "`" && char === "$" && source[index + 1] === "{") {
			index = skipTemplateExpression(source, index + 2);
			if (index < 0) {
				return -1;
			}
			continue;
		}
		if (char === quote) {
			return index;
		}
		if (quote !== "`" && char === "\n") {
			return -1;
		}
	}
	return -1;
}

function skipTemplateExpression(source: string, startIndex: number): number {
	let depth = 1;
	for (let index = startIndex; index < source.length; index++) {
		const char = source[index];
		if (char === '"' || char === "'" || char === "`") {
			index = skipStringLiteral(source, index);
			if (index < 0) {
				return -1;
			}
			continue;
		}
		if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth--;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

/**
 * Extracts the argument text of a call whose opening paren has already been
 * consumed (`startIndex` points just past it). Returns undefined when the
 * call never closes in this source, which the caller treats as "skip
 * silently" — this scanner is conservative by design.
 */
function extractBalancedCallArguments(source: string, startIndex: number): string | undefined {
	let depth = 1;
	for (let index = startIndex; index < source.length; index++) {
		const char = source[index];
		if (char === '"' || char === "'" || char === "`") {
			index = skipStringLiteral(source, index);
			if (index < 0) {
				return undefined;
			}
			continue;
		}
		if (char === "/" && source[index + 1] === "/") {
			const newline = source.indexOf("\n", index);
			if (newline === -1) {
				return undefined;
			}
			index = newline;
			continue;
		}
		if (char === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			if (end === -1) {
				return undefined;
			}
			index = end + 1;
			continue;
		}
		if (char === "(") {
			depth++;
		} else if (char === ")") {
			depth--;
			if (depth === 0) {
				return source.slice(startIndex, index);
			}
		}
	}
	return undefined;
}

/**
 * Option names whose value is read as a `true` / `false` literal instead of a
 * string literal. Collected as the text "true" / "false".
 */
const BOOLEAN_ERROR_OPTION_NAMES: ReadonlySet<string> = new Set(["retryable"]);

/**
 * Collects literal string values of the named top-level properties inside a
 * ProviderError/AuthError/ValidationError options object. Only plain `"..."` /
 * `'...'` literals at options-object depth count; computed values (identifiers,
 * ternaries, template substitutions, concatenations, escapes) are skipped
 * silently so the rules never guess. The first literal wins per property name.
 * Names in BOOLEAN_ERROR_OPTION_NAMES are read as boolean literals instead.
 */
function collectLiteralErrorOptionValues(
	args: string,
	optionNames: readonly string[],
	/**
	 * Receives every option name the object sets without a plain string literal:
	 * a variable or expression value (`category: mapped.category`), a shorthand
	 * member (`{ code, category }`), or a top-level spread whose text names it
	 * (`...(mapped.category ? { category: mapped.category } : {})`).
	 */
	nonLiteral?: Set<string>,
): Record<string, string> {
	const collected: Record<string, string> = {};
	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let previousSignificantChar = "";
	// Start of the top-level `...spread` member being read, or -1.
	let spreadStart = -1;
	const closeSpread = (end: number) => {
		if (spreadStart < 0) return;
		const text = args.slice(spreadStart, end);
		for (const name of optionNames) {
			if (new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`).test(text)) {
				nonLiteral?.add(name);
			}
		}
		spreadStart = -1;
	};
	for (let index = 0; index < args.length; index++) {
		const char = args[index] ?? "";
		if (char === '"' || char === "'" || char === "`") {
			const end = skipStringLiteral(args, index);
			if (end < 0) {
				return collected;
			}
			index = end;
			previousSignificantChar = char;
			continue;
		}
		if (char === "/" && args[index + 1] === "/") {
			const newline = args.indexOf("\n", index);
			if (newline === -1) {
				return collected;
			}
			index = newline;
			continue;
		}
		if (char === "/" && args[index + 1] === "*") {
			const end = args.indexOf("*/", index + 2);
			if (end === -1) {
				return collected;
			}
			index = end + 1;
			continue;
		}
		if (/\s/.test(char)) {
			continue;
		}
		if (char === "{") {
			braceDepth++;
		} else if (char === "}") {
			braceDepth--;
			if (braceDepth === 0) closeSpread(index);
		} else if (char === "(") {
			parenDepth++;
		} else if (char === ")") {
			parenDepth--;
		} else if (char === "[") {
			bracketDepth++;
		} else if (char === "]") {
			bracketDepth--;
		} else if (char === "," && braceDepth === 1 && parenDepth === 0 && bracketDepth === 0) {
			closeSpread(index);
		} else if (
			braceDepth === 1 &&
			parenDepth === 0 &&
			bracketDepth === 0 &&
			(previousSignificantChar === "{" || previousSignificantChar === ",")
		) {
			if (args.startsWith("...", index)) {
				spreadStart = index + 3;
				index += 2;
				previousSignificantChar = ".";
				continue;
			}
			const optionName = optionNames.find((name) => startsWithOptionName(args, index, name));
			if (optionName === undefined) {
				previousSignificantChar = char;
				continue;
			}
			let cursor = index + optionName.length;
			while (cursor < args.length && /\s/.test(args[cursor] ?? "")) {
				cursor++;
			}
			if (args[cursor] === ":") {
				cursor++;
				while (cursor < args.length && /\s/.test(args[cursor] ?? "")) {
					cursor++;
				}
				const quote = args[cursor];
				if (quote === '"' || quote === "'") {
					const end = skipStringLiteral(args, cursor);
					if (end > cursor) {
						const value = args.slice(cursor + 1, end);
						let after = end + 1;
						while (after < args.length && /\s/.test(args[after] ?? "")) {
							after++;
						}
						const nextChar = after < args.length ? (args[after] ?? "") : "";
						if (
							!value.includes("\\") &&
							(nextChar === "," || nextChar === "}" || nextChar === "")
						) {
							collected[optionName] ??= value;
						} else {
							nonLiteral?.add(optionName);
						}
						index = end;
						previousSignificantChar = quote;
						continue;
					}
					return collected;
				}
				if (BOOLEAN_ERROR_OPTION_NAMES.has(optionName)) {
					const word = args.startsWith("true", cursor)
						? "true"
						: args.startsWith("false", cursor)
							? "false"
							: undefined;
					if (word !== undefined) {
						let after = cursor + word.length;
						while (after < args.length && /\s/.test(args[after] ?? "")) {
							after++;
						}
						const nextChar = after < args.length ? (args[after] ?? "") : "";
						if (nextChar === "," || nextChar === "}" || nextChar === "") {
							collected[optionName] ??= word;
							index = cursor + word.length - 1;
							previousSignificantChar = word[word.length - 1] ?? "";
							continue;
						}
					}
				}
				nonLiteral?.add(optionName);
			} else if (args[cursor] === "," || args[cursor] === "}") {
				// Shorthand member: the value is a variable of the same name.
				nonLiteral?.add(optionName);
			}
		}
		previousSignificantChar = char;
	}
	return collected;
}

/** True when `name` starts at `index` and is not the prefix of a longer identifier. */
function startsWithOptionName(args: string, index: number, name: string): boolean {
	if (!args.startsWith(name, index)) return false;
	const next = args[index + name.length] ?? "";
	return !/[A-Za-z0-9_$]/.test(next);
}

/** One `new ProviderError|AuthError|ValidationError(...)` construction found by source scan. */
type ThrownErrorConstructionSite = {
	/** Constructor name, e.g. `ProviderError`. */
	readonly errorClass: string;
	readonly code?: string;
	readonly messageKey?: string;
	readonly fixKey?: string;
	/** Literal `category` option, when the site sets one. */
	readonly category?: string;
	/** Literal `retryable: true | false` option, when the site sets one. */
	readonly retryable?: boolean;
	/**
	 * The site sets `category` from something other than a string literal (a
	 * variable, a shorthand member, or a spread that names it), so it may carry
	 * any category.
	 */
	readonly nonLiteralCategory?: true;
};

const THROWN_ERROR_SCANNED_OPTION_NAMES = [
	"code",
	"messageKey",
	"fixKey",
	"category",
	"retryable",
] as const;

function collectThrownErrorConstructionSites(source: string): ThrownErrorConstructionSite[] {
	const sites: ThrownErrorConstructionSite[] = [];
	THROWN_ERROR_CONSTRUCTION_PATTERN.lastIndex = 0;
	for (
		let match = THROWN_ERROR_CONSTRUCTION_PATTERN.exec(source);
		match;
		match = THROWN_ERROR_CONSTRUCTION_PATTERN.exec(source)
	) {
		const argsStart = match.index + match[0].length;
		const args = extractBalancedCallArguments(source, argsStart);
		if (args !== undefined) {
			const nonLiteral = new Set<string>();
			const values = collectLiteralErrorOptionValues(
				args,
				THROWN_ERROR_SCANNED_OPTION_NAMES,
				nonLiteral,
			);
			sites.push({
				errorClass: match[1] ?? "",
				...(values.code === undefined ? {} : { code: values.code }),
				...(values.messageKey === undefined ? {} : { messageKey: values.messageKey }),
				...(values.fixKey === undefined ? {} : { fixKey: values.fixKey }),
				...(values.category === undefined ? {} : { category: values.category }),
				...(values.retryable === undefined ? {} : { retryable: values.retryable === "true" }),
				...(nonLiteral.has("category") ? { nonLiteralCategory: true as const } : {}),
			});
		}
		THROWN_ERROR_CONSTRUCTION_PATTERN.lastIndex = argsStart;
	}
	return sites;
}

type ThrowSiteLintSource = { readonly field: string; readonly source: string };

/**
 * The provider sources a throw-site rule scans, with the diagnostic field path
 * each one reports under. Prefers the CLI-collected source files (whole-repo
 * coverage) and falls back to the handler/auth-flow function text available
 * when `lintProvider` is called without them. Test sources are excluded.
 */
function collectThrowSiteLintSources(provider: {
	authFlowSource?: string;
	providerSourceFiles?: Record<string, string>;
	operations?: Record<string, { handler?: unknown; source?: string }>;
}): ThrowSiteLintSource[] {
	const sourceFiles = Object.entries(provider.providerSourceFiles ?? {}).filter(
		([filePath]) => !TEST_SOURCE_FILE_PATTERN.test(filePath),
	);
	if (sourceFiles.length > 0) {
		return sourceFiles.map(([filePath, source]) => ({
			field: `sourceFiles.${filePath}`,
			source,
		}));
	}
	const sources: ThrowSiteLintSource[] = [];
	if (provider.authFlowSource) {
		sources.push({ field: "auth.flow", source: provider.authFlowSource });
	}
	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		const source = getOperationSource(operation);
		if (source) {
			sources.push({ field: `operations.${operationKey}.handler`, source });
		}
	}
	return sources;
}

const STALE_IF_ERROR_OPTION = "staleIfErrorMs";
const STALE_IF_ERROR_PATTERN = /\bstaleIfErrorMs\b/;

/**
 * Whether a property assignment's initializer leaves no stale window.
 * `staleIfErrorMs: 0` makes `staleUntil` equal `freshUntil` in
 * `runtime/cache.ts`, so a loader failure propagates instead of being answered
 * from cache — a provider deliberately turning stale serving OFF must not be
 * told its probes conceal outages.
 */
function disablesStaleWindow(
	ts: typeof import("typescript"),
	initializer: import("typescript").Expression,
): boolean {
	if (ts.isNumericLiteral(initializer)) return Number(initializer.text) === 0;
	return ts.isIdentifier(initializer) && initializer.text === "undefined";
}

/**
 * Whether executable source configures a stale-if-error window.
 *
 * Parsed, not matched: comments and unrelated string literals must not count,
 * and a regex cannot tell them apart (an `Accept: "*​/*"` header literal opens a
 * block comment to a stripping regex and swallows the cache call after it).
 * This is the approach `findLegacyChoiceUsage` already uses here. All three
 * spellings of the option count — `staleIfErrorMs: n`, the shorthand
 * `{ ttlMs, staleIfErrorMs }`, and the quoted `"staleIfErrorMs": n` — because
 * refactoring between them must not change the verdict. Falls back to the raw
 * identifier match when TypeScript is not installed, which is the fail-closed
 * direction for this rule: it warns rather than goes quiet.
 */
function servesStaleIfError(source: string, fileName = "provider.ts"): boolean {
	if (!source.includes(STALE_IF_ERROR_OPTION)) return false;
	let ts: typeof import("typescript");
	try {
		ts = getTypeScript();
	} catch {
		return STALE_IF_ERROR_PATTERN.test(source);
	}
	const file = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		false,
		scriptKindForSourceFile(ts, fileName),
	);
	/** The statically known name of a property, however it is written. */
	const propertyName = (name: import("typescript").PropertyName): string | undefined => {
		if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
		if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
			return name.expression.text;
		}
		return undefined;
	};
	/**
	 * A type declaring the option is not a cache call setting it. Skipping these
	 * whole subtrees also stops a `CachePolicy` interface from overriding the
	 * disabled-window exemption for a provider whose only real call passes 0.
	 */
	const isTypeOnly = (node: import("typescript").Node): boolean =>
		ts.isInterfaceDeclaration(node) ||
		ts.isTypeAliasDeclaration(node) ||
		ts.isTypeLiteralNode(node) ||
		ts.isPropertySignature(node) ||
		ts.isTypeReferenceNode(node) ||
		ts.isTypeParameterDeclaration(node);
	/**
	 * The cache write options that travel with `staleIfErrorMs`
	 * (`ProviderCacheWriteOptions`). An object literal carrying one of these
	 * alongside the option is a cache configuration wherever it is declared.
	 */
	const siblingCacheOptions = new Set(["ttlMs", "jitterPct"]);
	/**
	 * A callee that writes the provider cache: `ctx.cache.getOrSet(...)`,
	 * `ctx.cache.set(...)`, and the `cached*` helpers built on them. An unrelated
	 * call receiving an object that happens to carry the name is not cache
	 * configuration. Every one of these takes its options LAST.
	 */
	const isCacheCallee = (expression: import("typescript").Expression): boolean => {
		if (ts.isIdentifier(expression)) return /^cached[A-Z]/.test(expression.text);
		if (!ts.isPropertyAccessExpression(expression)) return false;
		if (expression.name.text === "getOrSet") return true;
		return (
			(expression.name.text === "set" || expression.name.text === "write") &&
			ts.isPropertyAccessExpression(expression.expression) &&
			expression.expression.name.text === "cache"
		);
	};
	/**
	 * `const POLICY = { ... }` object literals, so `{ ...POLICY }` can be judged.
	 * Keyed by name file-wide: a shadowed name may resolve to the wrong literal,
	 * which at warning level is a mis-nudge rather than a wrong build — but the
	 * expansion below still has to be cycle-safe, because shadowing can make the
	 * resolution circular in valid source.
	 */
	const literalsByName = new Map<string, import("typescript").ObjectLiteralExpression>();
	const collect = (node: import("typescript").Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer !== undefined &&
			ts.isObjectLiteralExpression(node.initializer)
		) {
			literalsByName.set(node.name.text, node.initializer);
		}
		ts.forEachChild(node, collect);
	};
	collect(file);

	type OptionReading = { window: "enabled" | "disabled" | undefined; hasSibling: boolean };

	/**
	 * The EFFECTIVE stale-window setting of an object literal, spreads expanded
	 * and later properties overriding earlier ones the way JavaScript does — so
	 * `{ ...policy, staleIfErrorMs: 0 }` reads as disabled even when `policy`
	 * enables it.
	 */
	const readOptions = (
		literal: import("typescript").ObjectLiteralExpression,
		seen: Set<import("typescript").ObjectLiteralExpression>,
	): OptionReading => {
		if (seen.has(literal)) return { window: undefined, hasSibling: false };
		seen.add(literal);
		let window: OptionReading["window"];
		let hasSibling = false;
		for (const property of literal.properties) {
			if (ts.isSpreadAssignment(property)) {
				const target = ts.isIdentifier(property.expression)
					? literalsByName.get(property.expression.text)
					: ts.isObjectLiteralExpression(property.expression)
						? property.expression
						: undefined;
				if (target === undefined) continue;
				const inner = readOptions(target, seen);
				if (inner.window !== undefined) window = inner.window;
				hasSibling ||= inner.hasSibling;
				continue;
			}
			if (ts.isShorthandPropertyAssignment(property)) {
				if (property.name.text === STALE_IF_ERROR_OPTION) window = "enabled";
				else if (siblingCacheOptions.has(property.name.text)) hasSibling = true;
				continue;
			}
			if (!ts.isPropertyAssignment(property)) continue;
			const name = propertyName(property.name);
			if (name === STALE_IF_ERROR_OPTION) {
				window = disablesStaleWindow(ts, property.initializer) ? "disabled" : "enabled";
			} else if (name !== undefined && siblingCacheOptions.has(name)) {
				hasSibling = true;
			}
		}
		seen.delete(literal);
		return { window, hasSibling };
	};

	let found = false;
	/**
	 * `inOptionsArgument` is the second way to recognise a cache configuration:
	 * the literal is the options argument of a cache call. Together with the
	 * sibling-option test this covers the real shapes, while an upstream payload
	 * that merely carries a field of the same name does not count.
	 */
	const visit = (node: import("typescript").Node, inOptionsArgument: boolean): void => {
		if (found || isTypeOnly(node)) return;
		if (ts.isObjectLiteralExpression(node)) {
			const { window, hasSibling } = readOptions(node, new Set());
			if (window === "enabled" && (hasSibling || inOptionsArgument)) {
				found = true;
				return;
			}
		}
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			const argumentList = node.arguments ?? [];
			// Options come last on every cache API; the earlier arguments are the
			// key, the loader, or the value being cached.
			const optionsIndex = isCacheCallee(node.expression) ? argumentList.length - 1 : -1;
			visit(node.expression, false);
			for (const [index, argument] of [...argumentList].entries()) {
				visit(argument, index === optionsIndex);
			}
			return;
		}
		ts.forEachChild(node, (child) => visit(child, false));
	};
	visit(file, false);
	return found;
}

/** The operation-step field that distinguishes a stale-if-error serve. */
const SERVED_STALE_CACHE_OPERAND = "served_stale_cache";

/**
 * Sources that describe behaviour rather than serve it. Mirrors the broadest
 * test-source predicate in this module (`SHARED_TEST_SOURCE_FILE_PATTERN`, which
 * covers a plain `tests/` directory and `__mocks__/` as well as `__tests__/`)
 * and adds recorded-fixture directories, so a mock that mentions
 * `staleIfErrorMs` cannot raise a warning about code the runtime never serves.
 */
const NON_SERVING_SOURCE_FILE_PATTERN =
	/(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Operator tooling and bootstrap entrypoints: a cache option used by a fixture recorder or a
 * start script is not the request path a probe reads through.
 */
const NON_SERVING_TOOLING_DIRECTORY_PATTERN = /^(?:scripts|tools|bin)\//;
const NON_SERVING_BOOTSTRAP_FILE_PATTERN = /^(?:dev|start|deploy)\.[cm]?[jt]sx?$/;

function isServingProviderSourcePath(relativePath: string): boolean {
	return (
		JAVASCRIPT_SOURCE_FILE_PATTERN.test(relativePath) &&
		!NON_SERVING_SOURCE_FILE_PATTERN.test(relativePath) &&
		!NON_SERVING_TOOLING_DIRECTORY_PATTERN.test(relativePath) &&
		!NON_SERVING_BOOTSTRAP_FILE_PATTERN.test(relativePath)
	);
}

function isLintRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads `healthCheck.cases` structurally. The lint input is the loaded provider
 * declaration, which `defineProvider` has already validated, but this rule must
 * not throw on a shape it did not expect.
 */
function readHealthCheckCases(healthCheck: unknown): Record<string, unknown>[] {
	if (!isLintRecord(healthCheck)) return [];
	const cases = healthCheck.cases;
	if (!Array.isArray(cases)) return [];
	return cases.filter(isLintRecord);
}

/**
 * The `result` bindings of the `operation` steps that invoke `operationId`.
 *
 * Scoped to the probe's own operation on purpose: a scenario may invoke a
 * preparatory read before the operation the case is about, and a guard on the
 * preparation's result says nothing about whether the checked operation was
 * answered from a stale cache.
 */
function operationStepBindings(steps: readonly unknown[], operationId: string): Set<string> {
	const bindings = new Set<string>();
	for (const step of steps) {
		if (
			isLintRecord(step) &&
			step.kind === "operation" &&
			step.operationId === operationId &&
			typeof step.result === "string"
		) {
			bindings.add(step.result);
		}
	}
	return bindings;
}

/**
 * Whether an operand is the operand: the runtime's `served_stale_cache`
 * projection on an operation step result for the probe's own operation.
 *
 * Exact on three counts, because each looser form is a way to silence the rule
 * without checking cache provenance: a literal `"served_stale_cache"` in an
 * `inputTemplate` or a `reasonKey` is not a reference at all;
 * `["data", "served_stale_cache"]` is an upstream payload field the provider
 * happens to have named that way; and a reference bound to an `extract` result
 * is not the operation step this probe invoked.
 */
function isStaleCacheOperand(operand: unknown, bindings: ReadonlySet<string>): boolean {
	if (!isLintRecord(operand)) return false;
	const reference = operand.ref;
	return (
		isLintRecord(reference) &&
		reference.namespace === "steps" &&
		typeof reference.binding === "string" &&
		bindings.has(reference.binding) &&
		Array.isArray(reference.path) &&
		reference.path.length === 1 &&
		reference.path[0] === SERVED_STALE_CACHE_OPERAND
	);
}

/**
 * Whether a single predicate over the operand is FALSE for a stale serve, under
 * `negated` negation depth. `served_stale_cache` is always present and always a
 * boolean, so `exists` and `type_is: "boolean"` pass for a stale serve too —
 * reading the operand is not the same as rejecting it.
 */
function predicateRejectsStaleServe(
	predicate: Record<string, unknown>,
	bindings: ReadonlySet<string>,
	negated: boolean,
): boolean {
	// `equals`/`not_equals` are symmetric and the schema allows a reference on
	// either side, so `equals(actual: false, expected: <ref>)` is the same check
	// written the other way round.
	const onActual = isStaleCacheOperand(predicate.actual, bindings);
	const onExpected = isStaleCacheOperand(predicate.expected, bindings);
	if (!onActual && !onExpected) return false;
	const { operator } = predicate;
	const literal = onActual ? predicate.expected : predicate.actual;
	const failsWhenStale =
		(operator === "not_equals" && literal === true) || (operator === "equals" && literal === false);
	const holdsWhenStale =
		(operator === "is_true" && onActual) ||
		(operator === "equals" && literal === true) ||
		(operator === "not_equals" && literal === false);
	return negated ? holdsWhenStale : failsWhenStale;
}

/**
 * Whether an assertion expression evaluates FALSE when the operation step was
 * answered from a stale cache — the only thing that makes a guard degrade or an
 * assert fail. A clause under `any` only counts if every sibling branch also
 * rejects the stale serve, because `any` is satisfied by the branch that still
 * passes (`status_2xx` on a stale 200 being the obvious one).
 */
function rejectsStaleServe(node: unknown, bindings: ReadonlySet<string>, negated = false): boolean {
	if (!isLintRecord(node)) return false;
	if (node.kind === "not") return rejectsStaleServe(node.clause, bindings, !negated);
	if (node.kind === "all" || node.kind === "any") {
		if (!Array.isArray(node.clauses)) return false;
		// `all` fails if ANY clause fails; `any` fails only if EVERY clause fails.
		// Negation swaps which of the two the operator behaves like.
		const conjunctive = negated ? node.kind === "any" : node.kind === "all";
		return conjunctive
			? node.clauses.some((clause) => rejectsStaleServe(clause, bindings, negated))
			: node.clauses.every((clause) => rejectsStaleServe(clause, bindings, negated));
	}
	if (node.kind === "predicate") return predicateRejectsStaleServe(node, bindings, negated);
	return false;
}

/**
 * Whether a guard's degrade lands on the operation the case is about. A guard
 * whose condition reads the checked operation's freshness but attributes the
 * failure to a different operation leaves the checked one green through the
 * stale serve — covered on paper, not on the status page.
 */
/**
 * Whether an assert records its verdict against the checked operation. Same
 * concern as `guardAttributesTo`: an assertion that covers only some other
 * operation fails that one, not this one.
 */
function assertCoversOperation(coversOperations: unknown, operationId: string): boolean {
	return Array.isArray(coversOperations) && coversOperations.includes(operationId);
}

function guardAttributesTo(onFail: unknown, operationId: string): boolean {
	if (!isLintRecord(onFail) || !Array.isArray(onFail.attribute)) return false;
	return onFail.attribute.some((entry) => isLintRecord(entry) && entry.operationId === operationId);
}

/**
 * Whether a scenario reaches a verdict on freshness: a `guard` condition
 * (degraded, the shape this rule recommends) or an `assert` expression (down,
 * harsher but still real coverage). Any other position — an extract selector,
 * an operation input — is not a verdict.
 *
 * Order matters, and this is the rule the guidance states: the freshness
 * verdict must come before any OTHER guard. Every guard stops the scenario when
 * it fires, so a row or emptiness guard placed first answers a stale serve that
 * happens to be empty with its own reason and the freshness guard never runs —
 * the probe degrades for the wrong cause and the tenant reads "no rows" during
 * an upstream outage. Asserts before it are fine; they are the evidence clauses
 * and only stop the scenario by failing it outright.
 */
function scenarioChecksFreshness(scenario: unknown, operationId: string): boolean {
	if (!isLintRecord(scenario) || !Array.isArray(scenario.steps)) return false;
	const bindings = [...operationStepBindings(scenario.steps, operationId)];
	if (bindings.length === 0) return false;
	// EVERY read of the operation must be checked. A scenario that invokes it
	// twice with different inputs has two chances to serve stale, and one fresh
	// read must not conceal the other.
	return bindings.every((binding) =>
		resultBindingChecksFreshness(
			scenario.steps as readonly unknown[],
			binding,
			operationId,
			bindings,
		),
	);
}

function resultBindingChecksFreshness(
	steps: readonly unknown[],
	binding: string,
	operationId: string,
	siblingBindings: readonly string[],
): boolean {
	const operand = new Set([binding]);
	let produced = false;
	for (const step of steps) {
		if (!isLintRecord(step)) continue;
		if (!produced) {
			// Nothing before the read can have checked its freshness.
			produced = step.kind === "operation" && step.result === binding;
			continue;
		}
		if (
			step.kind === "assert" &&
			rejectsStaleServe(step.expression, operand) &&
			assertCoversOperation(step.coversOperations, operationId)
		) {
			return true;
		}
		if (step.kind !== "guard") continue;
		if (rejectsStaleServe(step.condition, operand)) {
			return guardAttributesTo(step.onFail, operationId);
		}
		// A freshness guard for ANOTHER read of the same operation is not a row or
		// emptiness guard masking the cause: it degrades on exactly this concern,
		// so `read A, read B, guard A, guard B` covers both. Anything else stops
		// the scenario first and shadows a later freshness guard.
		const coversSibling = siblingBindings.some(
			(sibling) =>
				sibling !== binding &&
				rejectsStaleServe(step.condition, new Set([sibling])) &&
				guardAttributesTo(step.onFail, operationId),
		);
		if (!coversSibling) return false;
	}
	return false;
}

/**
 * Whether a freshness guard for this operation still attributes
 * `expected_absence` — the only code the attribution schema admitted before
 * `served_stale_cache` existed, so earlier guidance recommended it. It IS
 * freshness coverage (the guard runs and stops the scenario), which is why
 * `scenarioChecksFreshness` accepts it; but the platform publishes
 * `expected_absence` as a non-incident status, so the stale serve it catches
 * would read as "nothing to return" instead of `degraded`.
 */
function freshnessGuardAttributesExpectedAbsence(scenario: unknown, operationId: string): boolean {
	if (!isLintRecord(scenario) || !Array.isArray(scenario.steps)) return false;
	const bindings = operationStepBindings(scenario.steps, operationId);
	if (bindings.size === 0) return false;
	return scenario.steps.some(
		(step) =>
			isLintRecord(step) &&
			step.kind === "guard" &&
			rejectsStaleServe(step.condition, bindings) &&
			isLintRecord(step.onFail) &&
			Array.isArray(step.onFail.attribute) &&
			step.onFail.attribute.some(
				(entry) =>
					isLintRecord(entry) &&
					entry.operationId === operationId &&
					entry.reasonCode === "expected_absence",
			),
	);
}

/** How many uncovered probes the stale-serve message names before eliding. */
const STALE_SERVE_MESSAGE_PROBE_LIMIT = 8;

/**
 * Stale-if-error serves no probe can see, on the deprecated per-call path.
 *
 * An operation that declares `cache: { staleIfErrorMs }` gets the freshness
 * guard attached by `defineProvider` and is never linted here. An operation
 * that still passes `staleIfErrorMs` to `ctx.cache.getOrSet` / `set` (kept
 * one release, `@deprecated`, runtime warn) has nothing attached, so for that
 * release the two rules main carried stay for exactly that path and are
 * removed together with the per-call option in the next minor:
 *
 * - `health-check-stale-serve-unguarded`: the provider serves stale-if-error
 *   per call and a case of an undeclared operation never checks
 *   `served_stale_cache`. During an upstream outage the cache answers HTTP 200
 *   with a schema-valid body, so every clause over `status_code` and `data`
 *   passes and the probe reports `ok` for the whole stale window.
 * - `health-check-stale-serve-reason`: a freshness guard of such an operation
 *   attributes `expected_absence`, which the platform publishes as a
 *   non-incident status, so the outage it catches reads as "nothing to
 *   return" instead of `degraded`.
 *
 * Both messages name the declaration as the fix: it replaces the per-call
 * option and the hand-written guard at once.
 */
function lintHealthCheckStaleServe(provider: {
	id?: string;
	providerSourceFiles?: Record<string, string>;
	operations?: Record<
		string,
		{ handler?: unknown; source?: string; healthCheck?: unknown; cache?: unknown }
	>;
}): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const providerLabel = provider.id ? `Provider "${provider.id}"` : "Provider";
	// Attribution. A handler that carries the cache call in its OWN source names
	// exactly the operation that serves stale. A file does not: the linter cannot
	// follow the call graph, and it cannot reliably tell a handler's own file
	// from a shared helper either — `getOperationSource` returns the runtime's
	// `handler.toString()`, which type erasure and reformatting make textually
	// unequal to the TypeScript on disk. So any file-level evidence degrades the
	// verdict to "somewhere in this provider", and the message says so instead of
	// implying every listed probe reads through that cache.
	const sources = new Set<string>();
	const operationsServingStale = new Set<string>();
	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		if (servesStaleIfError(getOperationSource(operation), `${operationKey}.ts`)) {
			sources.add(`operations.${operationKey} handler`);
			operationsServingStale.add(operationKey);
		}
	}
	let unattributed = false;
	for (const [filePath, source] of Object.entries(provider.providerSourceFiles ?? {})) {
		if (!isServingProviderSourcePath(filePath) || !servesStaleIfError(source, filePath)) continue;
		sources.add(filePath);
		unattributed = true;
	}
	if (sources.size === 0) return diagnostics;
	const attributable = !unattributed;

	// Freshness is judged per CASE. Operation-level bookkeeping would let one
	// guarded case silence its unguarded siblings, which still report `ok`
	// through a stale serve. An operation that declares `cache` is skipped
	// outright: the SDK attached its guard.
	const uncoveredByOperation = new Map<string, string[]>();
	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		if (operation.cache !== undefined) continue;
		if (attributable && !operationsServingStale.has(operationKey)) continue;
		const absenceAttributed: string[] = [];
		for (const [caseIndex, healthCase] of readHealthCheckCases(operation.healthCheck).entries()) {
			const caseLabel =
				typeof healthCase.name === "string" && healthCase.name.length > 0
					? `"${healthCase.name}"`
					: `[${caseIndex}]`;
			if (!scenarioChecksFreshness(healthCase.scenario, operationKey)) {
				const uncovered = uncoveredByOperation.get(operationKey) ?? [];
				uncovered.push(`${operationKey} ${caseLabel}`);
				uncoveredByOperation.set(operationKey, uncovered);
			}
			if (freshnessGuardAttributesExpectedAbsence(healthCase.scenario, operationKey)) {
				absenceAttributed.push(caseLabel);
			}
		}
		if (absenceAttributed.length > 0) {
			diagnostics.push({
				rule: "health-check-stale-serve-reason",
				level: "warn",
				field: `operations.${operationKey}.healthCheck.cases`,
				message: `${providerLabel} operation "${operationKey}" health-check ${absenceAttributed.length === 1 ? "case" : "cases"} ${absenceAttributed.join(", ")} guard ${SERVED_STALE_CACHE_OPERAND} but attribute reasonCode "expected_absence". The platform publishes expected_absence as a non-incident status (neither ok nor degraded, excluded from uptime and incidents), so an upstream outage this guard catches would read as "nothing to return" instead of degraded. Declare cache: { staleIfErrorMs } on the operation and delete the per-call option and this guard: the SDK attaches a guard that attributes "served_stale_cache". Until then, attribute reasonCode "served_stale_cache"; the reasonKey and its copy can stay.`,
			});
		}
	}
	if (uncoveredByOperation.size === 0) return diagnostics;
	const uncovered = [...uncoveredByOperation]
		.filter(([operationKey]) => !attributable || operationsServingStale.has(operationKey))
		.flatMap(([, probes]) => probes);
	if (uncovered.length === 0) return diagnostics;

	const elided = uncovered.length - STALE_SERVE_MESSAGE_PROBE_LIMIT;
	const named = uncovered
		.slice(0, STALE_SERVE_MESSAGE_PROBE_LIMIT)
		.join(", ")
		.concat(elided > 0 ? `, and ${elided} more` : "");
	const caveat = attributable
		? ""
		: ` The cache call is in provider source the linter cannot attribute to one operation, so every uncovered probe is listed — skip any whose operation does not read through that cache.`;
	diagnostics.push({
		rule: "health-check-stale-serve-unguarded",
		level: "warn",
		field: "healthCheck",
		message: `${providerLabel} serves stale-if-error (staleIfErrorMs in ${[...sources].sort().join(", ")}) and these health-check cases never check ${SERVED_STALE_CACHE_OPERAND}: ${named}. During an upstream outage the cache answers HTTP 200 with a schema-valid body, so every clause over status_code and data still passes and those probes report ok for the whole stale window. Add one guard step per affected probe on { ref: { namespace: "steps", binding: "<operation step result>", path: ["${SERVED_STALE_CACHE_OPERAND}"] } } attributing status "degraded" with reasonCode "served_stale_cache" (a stale serve is an upstream fault; "expected_absence" is the non-incident status for an absence the provider declares in advance), placed before any row or emptiness guard, or declare cache: { staleIfErrorMs } on the operation and delete the per-call option: the SDK then attaches that guard and this rule no longer applies. The per-call option and this rule are removed in the next minor.${caveat}`,
	});
	return diagnostics;
}

/**
 * Health-check cases the platform monitor cannot execute.
 *
 * The monitor runs a case's SERIALIZED `scenario` and nothing else — a closure
 * cannot cross the registry's serialization boundary. A case carrying only
 * `assertions` is still published as a probe, but the registry projects it as
 * `legacy_function_assertions_not_serializable` and the monitor answers
 * `unknown` / `monitoring_unavailable` for it forever: the operation reads as
 * monitored on the status page while nothing is checked.
 *
 * Kept as a rule rather than a type because the only structural fix is making
 * `scenario` required on `HealthCheckCase`, which removes the self-test-only
 * `assertions` shape; that is a deprecation release, and this is the old
 * path's rule until then. A warning while the fleet migrates; it becomes an
 * error once no repository carries an unmonitored case.
 */
function lintHealthCheckMonitorability(provider: {
	id?: string;
	operations?: Record<string, { healthCheck?: unknown }>;
}): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const providerLabel = provider.id ? `Provider "${provider.id}"` : "Provider";
	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		const unmonitored = readHealthCheckCases(operation.healthCheck).flatMap(
			(healthCase, caseIndex) =>
				healthCase.scenario === undefined
					? [
							typeof healthCase.name === "string" && healthCase.name.length > 0
								? `"${healthCase.name}"`
								: `[${caseIndex}]`,
						]
					: [],
		);
		if (unmonitored.length > 0) {
			diagnostics.push({
				rule: "health-check-assertions-not-monitored",
				level: "warn",
				field: `operations.${operationKey}.healthCheck.cases`,
				message: `${providerLabel} operation "${operationKey}" health-check ${unmonitored.length === 1 ? "case" : "cases"} ${unmonitored.join(", ")} declare assertions without a scenario. The platform health monitor executes only a case's serialized scenario, so this operation publishes a probe whose outcome is permanently unknown/monitoring_unavailable — it reads as monitored while nothing is checked. Express the checks as scenario: defineHealthScenario({ ... }).`,
			});
		}
	}
	return diagnostics;
}

/**
 * Codes an `expectedErrors` entry may never name, whatever status they serve:
 * the upstream refusing the platform-managed key, the caller needing to
 * re-authenticate, an unprovisioned secret, and every rate-limit code. Each
 * one is a measured fault the platform publishes as such; declaring it an
 * absence would publish an outage as a non-incident.
 */
const EXPECTED_ERROR_FORBIDDEN_CODES: ReadonlySet<string> = new Set([
	"AUTH_REQUIRED",
	"reauth_required",
	"MISSING_SECRET",
	...Array.from(SDK_ERROR_REGISTRY_BY_CODE)
		.filter(
			([, registration]) =>
				registration.category === "upstream_auth" ||
				registration.category === "upstream_rate_limited",
		)
		.map(([code]) => code),
]);

/** Statuses the `expectedErrors` schema excludes; a code that serves one is not an absence. */
const EXPECTED_ERROR_FORBIDDEN_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

type ExpectedErrorEntry = { status: number; code: string };

/**
 * The by-code `expectedErrors` entries of one operation step, read
 * structurally. A reference entry (`{ error: errors.X, attribute }`) is
 * declared, status-bound and refusal-free by construction and serializes to
 * the same `{ status, code, attribute }`, so only the entries
 * `defineHealthScenario` tagged as authored by code are read; the reference
 * path has no rule (DX rule 2).
 */
function readExpectedErrors(step: Record<string, unknown>): ExpectedErrorEntry[] {
	if (step.kind !== "operation" || !Array.isArray(step.expectedErrors)) return [];
	return step.expectedErrors.flatMap((entry) =>
		isLintRecord(entry) &&
		isExpectedErrorByCode(entry) &&
		typeof entry.status === "number" &&
		typeof entry.code === "string"
			? [{ status: entry.status, code: entry.code }]
			: [],
	);
}

/**
 * The declaration the runtime reads for a code: `buildOperationErrorCodeLookup`
 * builds a `Map` from the list, so a duplicate code resolves to its LAST entry.
 */
function lastErrorCodeDeclaration<T extends { code: string }>(
	errorCodes: readonly T[] | undefined,
	code: string,
): T | undefined {
	if (errorCodes === undefined) return undefined;
	for (let index = errorCodes.length - 1; index >= 0; index -= 1) {
		const entry = errorCodes[index];
		if (entry?.code === code) return entry;
	}
	return undefined;
}

/** What an operation declares for a code, from either declaration shape. */
type ExpectedErrorDeclaration = {
	readonly status?: number;
	readonly category?: ProviderFailureCategory;
};

/**
 * A declaration's category as serve reads it: a provider-failure category, or
 * none. `defineErrors` only makes declarations with one; a declaration from an
 * SDK copy that took every category may carry a platform word, which serve
 * reads as unset, and so does this rule.
 */
function declaredFailureCategory(
	declared: ExpectedErrorDeclaration | undefined,
): ProviderFailureCategory | undefined {
	const category: unknown = declared?.category;
	return typeof category === "string" && isProviderFailureCategory(category) ? category : undefined;
}

/**
 * The declaration the runtime reads for a code on an operation: a listed
 * `defineErrors` factory's declaration (the one `buildOperationErrorCodeLookup`
 * keeps when both shapes name the code, since factories are added after the
 * table) or the last legacy `errorCodes` row.
 */
function expectedErrorDeclaration(
	operation:
		| {
				errorCodes?: ReadonlyArray<{ code: string; status?: number }>;
				errors?: ReadonlyArray<{ declaration: ExpectedErrorDeclaration & { code: string } }>;
		  }
		| undefined,
	code: string,
): ExpectedErrorDeclaration | undefined {
	if (operation === undefined) return undefined;
	const factory = lastErrorCodeDeclaration(
		operation.errors?.map((entry) => entry.declaration),
		code,
	);
	if (factory !== undefined) return factory;
	return lastErrorCodeDeclaration(operation.errorCodes, code);
}

/**
 * The category the serve layer derives for a code when the throw site sets
 * none (`resolveProviderErrorContract`): the declaration's own category (a
 * `defineErrors` declaration always carries one), then a declared rejection
 * status, then the registered code's category. `undefined` leaves the class
 * default.
 */
function derivedExpectedErrorCategory(
	code: string,
	declared: ExpectedErrorDeclaration | undefined,
): ProviderFailureCategory | undefined {
	const declaredCategory = declaredFailureCategory(declared);
	if (declaredCategory !== undefined) return declaredCategory;
	const declaredStatus = declared?.status;
	if (declaredStatus === 409 || declaredStatus === 410 || declaredStatus === 422)
		return "upstream_rejected";
	return SDK_ERROR_REGISTRY_BY_CODE.get(code)?.category;
}

/**
 * Every `source` the serve layer can put on the envelope of a thrown code, as
 * far as the linter can see: `publicErrorSource` pins MISSING_SECRET,
 * UPSTREAM_ERROR and BLOCKED, and otherwise follows the category — the throw
 * site's literal `category` when it sets a provider-failure one (serve reads
 * any other word as unset), else the derived category, else
 * the class default (`provider_error` for ProviderError, `input_validation`
 * for ValidationError).
 *
 * A site whose `code` is not a literal (a helper that receives the code) may be
 * the one that throws this code, so it counts; a site with another literal
 * code does not. A candidate site that sets `category` from something other
 * than a literal (a mapping table's `...(mapped.category ? { category:
 * mapped.category } : {})`, a helper's `{ code, category }`) may carry an
 * upstream category, so it counts as possibly `upstream_failure` beside its
 * literal/derived resolution — the same reading as a non-literal `code`. With
 * no candidate site at all the derived resolution is the answer, which for a
 * provider code that nothing registers is `apifuse`. A `defineErrors`
 * declaration is thrown through its factory (`errors.X(...)`), which is not a
 * construction site, so its own category always counts beside any legacy site
 * that still hand-builds the code.
 */
function expectedErrorEnvelopeSources(
	code: string,
	declared: ExpectedErrorDeclaration | undefined,
	sites: readonly ThrownErrorConstructionSite[],
): ReadonlySet<ProviderErrorSource> {
	if (code === "MISSING_SECRET") return new Set(["apifuse"]);
	if (code === "UPSTREAM_ERROR" || code === "BLOCKED") return new Set(["upstream_failure"]);
	const derived = derivedExpectedErrorCategory(code, declared);
	const candidates = sites.filter((site) => site.code === code || site.code === undefined);
	if (candidates.length === 0) return new Set([sourceForCategory(derived ?? "provider_error")]);
	const declaredCategory = declaredFailureCategory(declared);
	const declaredSource: ProviderErrorSource[] =
		declaredCategory === undefined ? [] : [sourceForCategory(declaredCategory)];
	return new Set([
		...declaredSource,
		...candidates.flatMap((site): ProviderErrorSource[] => {
			const literal =
				site.category !== undefined && isProviderFailureCategory(site.category)
					? site.category
					: undefined;
			const fallback =
				site.errorClass === "ValidationError" ? "input_validation" : "provider_error";
			const resolved = sourceForCategory(literal ?? derived ?? fallback);
			return site.nonLiteralCategory === true ? [resolved, "upstream_failure"] : [resolved];
		}),
	]);
}

/**
 * `expectedErrors` entries the runtime can never produce as a matching
 * envelope, and entries that would turn a credential or rate-limit refusal
 * into an absence.
 *
 * `expectedErrors` on an operation step tells the platform monitor that one
 * specific non-2xx answer — this `status` and `code`, served by the
 * provider's own upstream envelope (`source: "upstream_failure"`) — is the
 * provider's declared "nothing to return". The monitor matches all three, so
 * an entry naming a code the operation never serves, a status the runtime
 * never serves for that code, or a code whose envelope the serve layer
 * attributes elsewhere (`upstream_rule` for a declared rejection status or a
 * registered refusal, `apifuse` for a provider code thrown without an
 * upstream `category`) is silently dead: the quiet day stays recorded as
 * `down`, which is the defect the clause exists to fix. The served status and
 * source are the ones `toStatusCode` / `publicErrorSource` resolve, read the
 * way the runtime reads them: a listed `defineErrors` factory (`errors:
 * [errors.X]`) or the legacy `errorCodes` row (a duplicate entry resolves to
 * its last declaration).
 *
 * Error level: a dead or dangerous entry has no partial value.
 *
 * The rule of the deprecated by-code form only. The reference form
 * (`errorRefs(errorCodes).X`) makes an undeclared code, a status outside the
 * absence class and a refusal code compile errors, so it is never linted;
 * both rules are removed together with the by-code form in the next minor.
 */
function lintHealthCheckExpectedErrors(provider: {
	id?: string;
	authFlowSource?: string;
	providerSourceFiles?: Record<string, string>;
	operations?: Record<
		string,
		{
			handler?: unknown;
			source?: string;
			healthCheck?: unknown;
			errorCodes?: ReadonlyArray<{ code: string; status?: number }>;
			errors?: ReadonlyArray<{
				declaration: { code: string; status?: number; category?: ProviderFailureCategory };
			}>;
		}
	>;
}): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const providerLabel = provider.id ? `Provider "${provider.id}"` : "Provider";
	const operations = provider.operations ?? {};
	let scannedSites: ThrownErrorConstructionSite[] | undefined;
	const throwSites = (): ThrownErrorConstructionSite[] => {
		scannedSites ??= collectThrowSiteLintSources(provider).flatMap(({ source }) =>
			collectThrownErrorConstructionSites(source),
		);
		return scannedSites;
	};
	for (const [operationKey, operation] of Object.entries(operations)) {
		const cases = readHealthCheckCases(operation.healthCheck);
		for (const [caseIndex, healthCase] of cases.entries()) {
			const scenario = healthCase.scenario;
			if (!isLintRecord(scenario) || !Array.isArray(scenario.steps)) continue;
			for (const [stepIndex, step] of scenario.steps.entries()) {
				if (!isLintRecord(step)) continue;
				const entries = readExpectedErrors(step);
				if (entries.length === 0) continue;
				const stepOperationId = typeof step.operationId === "string" ? step.operationId : "";
				const owning = operations[stepOperationId];
				for (const [entryIndex, entry] of entries.entries()) {
					const field = `operations.${operationKey}.healthCheck.cases[${caseIndex}].scenario.steps[${stepIndex}].expectedErrors[${entryIndex}]`;
					const label = `${providerLabel} operation "${operationKey}" health-check case [${caseIndex}] step "${typeof step.id === "string" ? step.id : stepIndex}" declares expectedErrors ${entry.status} "${entry.code}" for operation "${stepOperationId}"`;
					const declared = expectedErrorDeclaration(owning, entry.code);
					const canonicalStatus = SDK_STATUS_MAPPED_PROVIDER_ERROR_CODES.get(entry.code);
					// Mirrors toStatusCode: an SDK-owned code ignores the declaration,
					// any other declared status wins over the canonical mapping.
					const sdkOwned = SDK_RUNTIME_OWNED_ERROR_CODES.has(entry.code);
					const servedStatus = sdkOwned ? canonicalStatus : (declared?.status ?? canonicalStatus);
					if (
						EXPECTED_ERROR_FORBIDDEN_CODES.has(entry.code) ||
						(servedStatus !== undefined && EXPECTED_ERROR_FORBIDDEN_STATUSES.has(servedStatus))
					) {
						diagnostics.push({
							rule: "health-check-expected-error-not-an-absence",
							level: "error",
							field,
							message: `${label}, but that code is a credential or rate-limit refusal${servedStatus === undefined ? "" : ` (served ${servedStatus})`}: a measured fault the platform publishes as degraded or down, never an absence. Remove the entry; declare only the code the handler throws when the upstream has nothing to return.`,
						});
						continue;
					}
					if (declared === undefined && canonicalStatus === undefined) {
						diagnostics.push({
							rule: "health-check-expected-error-unmatchable",
							level: "error",
							field,
							message: `${label}, which neither declares that code (a defineErrors factory in errors, or an errorCodes row) nor is it SDK-registered; the runtime serves HTTP 500 for it, so this entry can never match and the absence it describes is recorded as down. Declare the code with status ${entry.status} and list it in the owning operation's errors, or name the registered code the handler actually throws.`,
						});
						continue;
					}
					if (servedStatus === undefined) {
						diagnostics.push({
							rule: "health-check-expected-error-unmatchable",
							level: "error",
							field,
							message: `${label}, but the errorCodes declaration for "${entry.code}" carries no status and the SDK has no canonical one, so the runtime serves HTTP 500 for it and this entry can never match. Add status ${entry.status} to that errorCodes entry.`,
						});
						continue;
					}
					if (servedStatus !== entry.status) {
						diagnostics.push({
							rule: "health-check-expected-error-unmatchable",
							level: "error",
							field,
							message: `${label}, but the runtime serves status ${servedStatus} for that code (${declared?.status !== undefined && !sdkOwned ? "its declaration" : "the SDK's canonical status"}); the monitor matches status and code together, so this entry can never match. Use status ${servedStatus}.`,
						});
						continue;
					}
					const sources = expectedErrorEnvelopeSources(
						entry.code,
						sdkOwned ? undefined : declared,
						throwSites(),
					);
					if (sources.has("upstream_failure")) continue;
					const registered = SDK_ERROR_REGISTRY_BY_CODE.get(entry.code);
					const hint =
						registered !== undefined
							? `A code registered as ${registered.category} is an upstream refusal, not an absence; throw the registered code the upstream answer means (NO_DATA for an empty result).`
							: servedStatus === 409 || servedStatus === 410 || servedStatus === 422
								? `A declared status of ${servedStatus} classes the code as an upstream refusal (upstream_rejected → upstream_rule); an absence is a 404-class answer.`
								: `A provider code thrown without a category is classed provider_error (source "apifuse"). Set category: "upstream_http" on the new ProviderError(...) that throws it — the linter reads construction sites, so a helper that builds the error must set the category there (a literal, or a variable or spread it passes through).`;
					diagnostics.push({
						rule: "health-check-expected-error-unmatchable",
						level: "error",
						field,
						message: `${label}, but the runtime serves that code with source ${[...sources].map((source) => `"${source}"`).join(" or ")}; the monitor honours expectedErrors only for the provider's own upstream envelope (source "upstream_failure"), so this entry can never match. ${hint}`,
					});
				}
			}
		}
	}
	return diagnostics;
}

export function lintOperation(op: {
	descriptionKey?: string;
	whenToUseKeys?: readonly string[];
	whenNotToUseKeys?: readonly string[];
	input: unknown;
	output: unknown;
	fixtures?: unknown;
}): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];
	const hasDescriptionKey = typeof op.descriptionKey === "string" && op.descriptionKey.length > 0;

	// Stays one release: making `descriptionKey` required on OperationDefinition
	// touches 66 SDK test files (~300 operation literals) that wave 2 lanes edit
	// concurrently; the fleet declares it on every operation (0 missing / 135).
	if (!hasDescriptionKey) {
		diagnostics.push({
			rule: "description-key-required",
			level: "error",
			field: "descriptionKey",
			message: "Operation must declare a locale-backed descriptionKey.",
		});
	}

	if (!hasBidirectionalFixtures(op.fixtures)) {
		diagnostics.push({
			rule: "fixtures-both-directions",
			level: "error",
			field: "fixtures",
			message: "Fixtures must include both request and response.",
		});
	}

	return diagnostics;
}

function declaredPinnedWireFieldPaths(provider: {
	meta?: { contract?: ProviderContractMetaLike };
}): readonly { readonly path: string; readonly reason: string }[] {
	const pins = provider.meta?.contract?.pinnedWireFieldPaths;
	if (!Array.isArray(pins)) return [];
	return pins.filter(
		(pin) =>
			pin !== null &&
			typeof pin === "object" &&
			typeof pin.path === "string" &&
			pin.path.trim().length > 0 &&
			typeof pin.reason === "string" &&
			pin.reason.trim().length > 0,
	);
}

function applyPinnedWireFieldPaths(
	provider: { meta?: { contract?: ProviderContractMetaLike } },
	diagnostics: readonly LintDiagnostic[],
): ProviderLintResult {
	const pins = declaredPinnedWireFieldPaths(provider);
	if (pins.length === 0) {
		return { diagnostics: [...diagnostics], information: [] };
	}

	const pinsByPath = new Map(pins.map((pin) => [pin.path, pin]));
	const matchedPaths = new Set<string>();
	const remainingDiagnostics = diagnostics.filter((diagnostic) => {
		if (
			diagnostic.rule !== "public-schema-upstream-field" ||
			diagnostic.field === undefined ||
			!pinsByPath.has(diagnostic.field)
		) {
			return true;
		}
		matchedPaths.add(diagnostic.field);
		return false;
	});

	const information: ProviderLintInformation[] = [];
	for (const pin of pins) {
		if (matchedPaths.has(pin.path)) {
			information.push({
				rule: "public-schema-pinned-wire-field",
				field: pin.path,
				message: `Suppressed exact public-schema-upstream-field diagnostic. Reason: ${pin.reason}`,
			});
			continue;
		}

		remainingDiagnostics.push({
			rule: "public-schema-pinned-wire-field-stale",
			level: "error",
			field: pin.path,
			message: `Pinned wire field path ${JSON.stringify(pin.path)} matches no current public-schema-upstream-field diagnostic; remove the stale declaration.`,
		});
	}

	return { diagnostics: remainingDiagnostics, information };
}

export function lintProvider(
	provider: {
		id?: string;
		auth?: ProviderAuthLike;
		authFlowSource?: string;
		providerSourceFiles?: Record<string, string>;
		operations?: Record<
			string,
			{
				descriptionKey?: string;
				whenToUseKeys?: readonly string[];
				whenNotToUseKeys?: readonly string[];
				connectionMode?: "none" | "optional" | "required";
				input: unknown;
				output: unknown;
				fixtures?: unknown;
				handler?: unknown;
				source?: string;
				/** Read structurally by the health-check monitorability rules. */
				healthCheck?: unknown;
				/** `cache: { staleIfErrorMs }`; an operation that declares it is never stale-serve linted. */
				cache?: unknown;
				errorCodes?: ReadonlyArray<{
					code: string;
					status?: number;
					retryable?: boolean;
					messageKey?: string;
					fixKey?: string;
				}>;
				/** `defineErrors` factories the operation lists; read by the health-check expectedErrors rule. */
				errors?: ReadonlyArray<{
					declaration: { code: string; status?: number; category?: ProviderFailureCategory };
				}>;
			}
		>;
		meta?: {
			contract?: ProviderContractMetaLike;
		};
		/** Declared handle kinds (ADR-0012); read structurally, see lintLegacyHandleDeclarations. */
		handle?: unknown;
		state?: unknown;
	},
	/** @deprecated Ignored; pass `mode` to `bundleProvider(providerRoot, { mode })`. Removed in the next major. */
	options?: ProviderLintOptions,
): LintDiagnostic[] {
	return lintProviderWithInformation(provider, options).diagnostics;
}

/**
 * The `errorCodes` table is still read (`@deprecated`) but `defineErrors` is
 * the declaration: each operation still on the table is named with the move.
 * Warning level: the table keeps serving, so this must not fail `apifuse check`.
 */
function lintDeprecatedErrorCodesTable(provider: {
	id?: string;
	operations?: Record<string, { errorCodes?: ReadonlyArray<{ code: string }> }>;
}): LintDiagnostic[] {
	const providerId = provider.id ?? "unknown";
	const diagnostics: LintDiagnostic[] = [];
	for (const [operationKey, operation] of Object.entries(provider.operations ?? {})) {
		const codes = (operation.errorCodes ?? []).flatMap((entry) =>
			typeof entry?.code === "string" ? [entry.code] : [],
		);
		if (codes.length === 0) continue;
		diagnostics.push({
			rule: "deprecated-error-codes-table",
			level: "warn",
			field: `operations.${operationKey}.errorCodes`,
			message: `Provider "${providerId}" operation "${operationKey}" declares ${codes.join(", ")} in the deprecated errorCodes table. Declare each code once with defineErrors({ ${codes[0]}: { status, category, description } }) (an SDK-registered code is sdkErrors.${codes[0]}) and list the factories as errors: [errors.${codes[0]}, ...]; status, retryable and the locale keys then come from that declaration (apifuse migrate --only errors-hoist).`,
		});
	}
	return diagnostics;
}

/** Internal detailed result used by the CLI to render suppression audits. */
export function lintProviderWithInformation(
	provider: Parameters<typeof lintProvider>[0],
	/** @deprecated Ignored; pass `mode` to `bundleProvider(providerRoot, { mode })`. Removed in the next major. */
	options?: ProviderLintOptions,
): ProviderLintResult {
	warnProviderLintOptionsOnce(options);
	const diagnostics: LintDiagnostic[] = [
		...lintCredentialWriteUsage(provider),
		...lintBrowserVersionLiterals(provider),
		...lintHealthCheckMonitorability(provider),
		...lintHealthCheckStaleServe(provider),
		...lintHealthCheckExpectedErrors(provider),
		...lintDeprecatedErrorCodesTable(provider),
	];
	if (provider.operations) {
		const authMode = provider.auth?.mode;
		for (const [operationKey, operation] of Object.entries(provider.operations)) {
			// Kept as lint: the operation literal does not carry connectionMode
			// through defineOperation, so the builder cannot see it, and the SDK
			// runtime never reads it (gateway-facing contract metadata), so a
			// build-time refusal would be on the gateway's behalf.
			if (isCredentialBearingAuthMode(authMode) && operation.connectionMode === undefined) {
				diagnostics.push({
					rule: "mixed-auth-connection-mode-required",
					level: "error",
					field: `operations.${operationKey}.connectionMode`,
					message: `Provider "${provider.id ?? "unknown"}" uses credential-bearing auth.mode "${authMode}"; operation "${operationKey}" must declare connectionMode explicitly.`,
				});
			}
		}
		// Every authenticated mode owns an auth.flow; `oauth2_proxied` was
		// previously exempt, which let auth-lifecycle operations ship on
		// proxied providers unchecked.
		if (authMode === "credentials" || authMode === "oauth2" || authMode === "oauth2_proxied") {
			for (const operationKey of Object.keys(provider.operations)) {
				if (isAuthLifecycleOperationId(operationKey, authMode)) {
					diagnostics.push({
						rule: "auth-operation-unsupported",
						level: "error",
						field: `operations.${operationKey}`,
						message: `Provider "${provider.id ?? "unknown"}" operation "${operationKey}" performs an auth-lifecycle action (login, logout, token exchange or similar). Authenticated providers must expose the whole credential lifecycle through the single auth.flow interface because Gateway persists only auth.flow complete turn data.credential as the connection credential, and an operation that mutates the session outside that interface leaves the stored connection stale. Move sign-in logic into auth.flow.start/continue and sign-out/disconnect logic into auth.flow.abort (served by POST /auth/disconnect) instead of a provider operation.`,
					});
				}
			}
		}
	}

	if (!provider.operations) {
		return applyPinnedWireFieldPaths(provider, diagnostics);
	}

	diagnostics.push(
		...Object.entries(provider.operations).flatMap(([operationKey, operation]) =>
			[
				...lintOperation({
					descriptionKey: operation.descriptionKey,
					whenToUseKeys: operation.whenToUseKeys,
					whenNotToUseKeys: operation.whenNotToUseKeys,
					input: operation.input,
					output: operation.output,
					fixtures: operation.fixtures,
				}),
				...lintPublicSchemaFieldNames(
					provider.id,
					operationKey,
					operation.input,
					operation.output,
					provider.meta?.contract?.publicSchemaFieldNames === "normalized",
				),
			].map((diagnostic) => ({
				...diagnostic,
				field: diagnostic.field
					? `operations.${operationKey}.${diagnostic.field}`
					: `operations.${operationKey}`,
				message: `[${operationKey}] ${diagnostic.message}`,
			})),
		),
	);

	return applyPinnedWireFieldPaths(provider, diagnostics);
}
