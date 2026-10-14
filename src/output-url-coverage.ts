/**
 * Output URL coverage report (openspec `add-output-url-kinds`, quality-gates
 * delta). Two warnings, printed by `apifuse check` and never failing it, with
 * no count threshold:
 *
 * - `output-url-unclassified`: a recorded fixture output carries an absolute
 *   `http(s)` URL (or the output schema declares `format: "uri"`) at a string
 *   path that no URL kind helper declares.
 * - `output-url-item-coverage`: the output has an object array but declares no
 *   `image()`/`imageList()`/`itemPage()` field anywhere and the operation has
 *   no `noMedia`. Operation level, so an auxiliary array (facets, filters)
 *   next to an annotated item array is not warned.
 *
 * Evidence is the fixture value or the declared schema, never the field name.
 */

import { zodSchemaToJson } from "./contract-serialization.js";
import {
	APIFUSE_URL_KIND_META_KEY,
	appendPropertyPath,
	inspectOutputUrlKinds,
	isRecord,
	localReference,
} from "./output-url.js";

export const OUTPUT_URL_COVERAGE_RULES = {
	unclassifiedUrl: "output-url-unclassified",
	itemCoverage: "output-url-item-coverage",
} as const;

export type OutputUrlCoverageRule =
	(typeof OUTPUT_URL_COVERAGE_RULES)[keyof typeof OUTPUT_URL_COVERAGE_RULES];

export interface OutputUrlCoverageWarning {
	rule: OutputUrlCoverageRule;
	operationId: string;
	/** Response-value path (`items[].detail_url`, `$` for the root). */
	path: string;
	message: string;
	/** How to turn the warning off. */
	fix: string;
}

/** The parts of an operation the report reads. */
export interface OutputUrlCoverageOperation {
	readonly output?: unknown;
	readonly fixtures?: { readonly response?: unknown } | undefined;
	readonly noMedia?: unknown;
}

type JsonRecord = Record<string, unknown>;

const ABSOLUTE_HTTP_URL = /^https?:\/\/[^\s/?#]+[^\s]*$/i;

/** True for a whole value that is an absolute `http(s)://` URL with a host. */
export function isAbsoluteHttpUrl(value: string): boolean {
	return ABSOLUTE_HTTP_URL.test(value) && URL.canParse(value);
}

/**
 * Every string value of a fixture output by response-value path, array
 * positions collapsed to `[]` (`items[].image_url`).
 */
export function collectFixtureStrings(value: unknown): Map<string, string[]> {
	const out = new Map<string, string[]>();
	const visit = (node: unknown, path: string, depth: number): void => {
		if (depth > 64) return;
		if (typeof node === "string") {
			const values = out.get(path);
			if (values) values.push(node);
			else out.set(path, [node]);
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) visit(item, `${path}[]`, depth + 1);
			return;
		}
		if (isRecord(node))
			for (const [key, child] of Object.entries(node))
				visit(child, appendPropertyPath(path, key), depth + 1);
	};
	visit(value, "", 0);
	return out;
}

type PathSegment = { key: string } | { items: true } | { any: true };

const PATH_TOKEN = /\[\]|\["((?:[^"\\]|\\.)*)"\]|\.?\*|\.?([A-Za-z_][A-Za-z0-9_]*)/gy;

function parsePath(path: string): PathSegment[] | undefined {
	const segments: PathSegment[] = [];
	PATH_TOKEN.lastIndex = 0;
	while (PATH_TOKEN.lastIndex < path.length) {
		const start = PATH_TOKEN.lastIndex;
		const match = PATH_TOKEN.exec(path);
		if (!match || PATH_TOKEN.lastIndex === start) return undefined;
		const token = match[0];
		if (token === "[]") segments.push({ items: true });
		else if (token === "*" || token === ".*") segments.push({ any: true });
		else if (match[1] !== undefined) segments.push({ key: JSON.parse(`"${match[1]}"`) as string });
		else if (match[2] !== undefined) segments.push({ key: match[2] });
	}
	return segments;
}

/** True when a concrete fixture path matches a schema path (`.*` matches any one key). */
export function outputPathMatches(schemaPath: string, valuePath: string): boolean {
	if (schemaPath === valuePath) return true;
	const pattern = parsePath(schemaPath);
	const value = parsePath(valuePath);
	if (!pattern || !value || pattern.length !== value.length) return false;
	return pattern.every((segment, index) => {
		const actual = value[index];
		if (!actual) return false;
		if ("any" in segment) return "key" in actual;
		if ("items" in segment) return "items" in actual;
		return "key" in actual && actual.key === segment.key;
	});
}

function displayPath(path: string): string {
	return path.length === 0 ? "$" : path;
}

interface StringLeaf {
	path: string;
	annotated: boolean;
	format?: string;
}

interface OutputShape {
	strings: StringLeaf[];
	objectArrays: string[];
}

/** String leaves (annotated or not) and object-array paths of an output JSON Schema. */
function describeOutputShape(schema: unknown): OutputShape {
	const strings: StringLeaf[] = [];
	const objectArrays = new Set<string>();
	if (!isRecord(schema)) return { strings, objectArrays: [] };
	const root = schema;
	const resolve = (node: unknown, seen = new Set<object>()): JsonRecord | undefined => {
		if (!isRecord(node) || seen.has(node)) return undefined;
		seen.add(node);
		if (typeof node.$ref === "string") return resolve(localReference(root, node.$ref), seen);
		return node;
	};
	const declaresObject = (candidate: unknown, seen = new Set<object>()): boolean => {
		const node = resolve(candidate);
		if (!node || seen.has(node)) return false;
		seen.add(node);
		if (isRecord(node.properties) && Object.keys(node.properties).length > 0) return true;
		for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
			const branches = node[keyword];
			if (Array.isArray(branches) && branches.some((branch) => declaresObject(branch, seen)))
				return true;
		}
		return false;
	};
	const active = new Set<object>();
	const visit = (candidate: unknown, path: string): void => {
		const node = resolve(candidate);
		if (!node || active.has(node)) return;
		active.add(node);
		try {
			if (typeof node[APIFUSE_URL_KIND_META_KEY] === "string") {
				strings.push({ path, annotated: true });
				return;
			}
			const type = node.type;
			if (type === "string" || (Array.isArray(type) && type.includes("string")))
				strings.push({
					path,
					annotated: false,
					...(typeof node.format === "string" ? { format: node.format } : {}),
				});
			if (isRecord(node.properties))
				for (const [property, child] of Object.entries(node.properties))
					visit(child, appendPropertyPath(path, property));
			if (isRecord(node.items)) {
				if (declaresObject(node.items)) objectArrays.add(`${path}[]`);
				visit(node.items, `${path}[]`);
			}
			if (Array.isArray(node.prefixItems))
				for (const item of node.prefixItems) visit(item, `${path}[]`);
			if (isRecord(node.additionalProperties)) visit(node.additionalProperties, `${path}.*`);
			for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
				const branches = node[keyword];
				if (Array.isArray(branches)) for (const branch of branches) visit(branch, path);
			}
		} finally {
			active.delete(node);
		}
	};
	visit(root, "");
	return { strings, objectArrays: [...objectArrays].sort() };
}

const IMAGE_FILE = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;

/** The picture-file extension of a URL's path (`.jpg`), or `undefined`. */
export function imageFileExtension(value: string): string | undefined {
	try {
		return IMAGE_FILE.exec(new URL(value).pathname)?.[0];
	} catch {
		return undefined;
	}
}

/** True when the URL's path ends in a picture-file extension. */
export function looksLikeImageFile(value: string): boolean {
	return imageFileExtension(value) !== undefined;
}

/**
 * `scheme://host/…` of an absolute URL, or `undefined`. Fixtures are
 * sanitized, but a query or path is noise in a report line.
 */
export function urlOrigin(value: string): string | undefined {
	try {
		const url = new URL(value);
		return `${url.protocol}//${url.host}/…`;
	} catch {
		return undefined;
	}
}

function unclassifiedWarning(
	operationId: string,
	path: string,
	values: readonly string[],
): OutputUrlCoverageWarning {
	const absolute = values.filter((value) => isAbsoluteHttpUrl(value));
	// A picture value makes image() the suggestion. image() refuses every
	// http:// value, picture file or not, so any one decides how to get there
	// and is the one the line cites.
	const picture = absolute.find((value) => looksLikeImageFile(value));
	const insecure = absolute.find((value) => /^http:/i.test(value));
	const example = picture === undefined ? absolute[0] : (insecure ?? picture);
	const evidence =
		example === undefined
			? 'it is declared format: "uri" (z.string().url())'
			: `the recorded fixture holds ${urlOrigin(example) ?? "an absolute URL"}`;
	let fix: string;
	if (example === undefined)
		fix =
			"declare it with image() for a picture, itemPage() for the item's own page or link() for any other URL.";
	else if (picture === undefined)
		fix = "declare it with itemPage() if it is the item's own page, otherwise link().";
	else if (insecure === undefined)
		fix =
			"declare it with image() (imageList() for a list) if it is the item's picture, otherwise link().";
	else {
		// image() admits https only: declared over an http:// fixture, the
		// declaration check fails instead of warning.
		const host = hostOf(insecure);
		fix = `if it is the item's picture, first make the mapper publish https: toImageUrl(raw, { upgradeHttp: [${JSON.stringify(host)}] }) once ${host} is measured to serve the same path over https, or an https value from the upstream; re-record the fixture, then declare image() (imageList() for a list). Declaring image() over the http:// fixture fails the declaration check. Otherwise link().`;
	}
	return {
		rule: OUTPUT_URL_COVERAGE_RULES.unclassifiedUrl,
		operationId,
		path: displayPath(path),
		message: `${evidence}, but no URL kind helper declares this field.`,
		fix,
	};
}

function hostOf(value: string): string {
	try {
		return new URL(value).hostname;
	} catch {
		return value;
	}
}

/**
 * The coverage warnings of a provider's operations. Pure and side-effect
 * free; an output schema that cannot be converted to JSON Schema is skipped
 * (the declaration check reports it).
 */
export function reportOutputUrlCoverage(
	operations: Readonly<Record<string, OutputUrlCoverageOperation>>,
): OutputUrlCoverageWarning[] {
	const warnings: OutputUrlCoverageWarning[] = [];
	for (const operationId of Object.keys(operations).sort()) {
		const operation = operations[operationId];
		if (!operation) continue;
		let schema: unknown;
		try {
			schema = zodSchemaToJson(operation.output);
		} catch {
			continue;
		}
		if (schema === undefined) continue;
		const shape = describeOutputShape(schema);
		const unannotated = shape.strings.filter((leaf) => !leaf.annotated);
		const annotated = shape.strings.filter((leaf) => leaf.annotated);
		const warned = new Set<string>();

		const fixtureStrings = collectFixtureStrings(operation.fixtures?.response);
		for (const [path, values] of [...fixtureStrings.entries()].sort(([left], [right]) =>
			left.localeCompare(right),
		)) {
			if (!values.some((value) => isAbsoluteHttpUrl(value))) continue;
			// A path the schema declares with a helper is covered; a path the
			// schema does not declare as a string (a passthrough payload) cannot
			// be declared and is not warned.
			if (annotated.some((leaf) => outputPathMatches(leaf.path, path))) continue;
			const leaf = unannotated.find((candidate) => outputPathMatches(candidate.path, path));
			if (!leaf || warned.has(leaf.path)) continue;
			warned.add(leaf.path);
			warnings.push(unclassifiedWarning(operationId, path, values));
		}
		for (const leaf of unannotated) {
			if (leaf.format !== "uri" || warned.has(leaf.path)) continue;
			// Another branch (an intersection, a union) declares it with a helper.
			if (annotated.some((candidate) => outputPathMatches(candidate.path, leaf.path))) continue;
			warned.add(leaf.path);
			warnings.push(unclassifiedWarning(operationId, leaf.path, []));
		}

		if (operation.noMedia !== undefined || shape.objectArrays.length === 0) continue;
		const media = inspectOutputUrlKinds(schema).entries.filter((entry) => entry.kind !== "link");
		if (media.length > 0) continue;
		warnings.push({
			rule: OUTPUT_URL_COVERAGE_RULES.itemCoverage,
			operationId,
			path: "$",
			message: `the output has object array${shape.objectArrays.length > 1 ? "s" : ""} ${shape.objectArrays.join(", ")} but declares no image(), imageList() or itemPage() field anywhere.`,
			fix: `declare the item's picture with image() and its own page with itemPage(), or declare noMedia("<upstream evidence>") on operations.${operationId}.`,
		});
	}
	return warnings;
}

/** One `WARN` line as `apifuse check` prints it. */
export function formatOutputUrlCoverageWarning(warning: OutputUrlCoverageWarning): string {
	return `WARN ${warning.rule} ${warning.operationId} ${warning.path}: ${warning.message} Turn off: ${warning.fix}`;
}
