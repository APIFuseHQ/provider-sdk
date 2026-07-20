import {
	parseXml,
	XmlDocumentType,
	XmlElement,
	XmlError,
	XmlProcessingInstruction,
} from "@rgrove/parse-xml";
import { Buffer } from "node:buffer";

import {
	childXmlContext,
	hasSemanticXmlFailure,
	isXmlErrorRootName,
	normalizedXmlName,
	rootXmlContext,
	type XmlSemanticBranch,
} from "./submit-check-xml-semantics.js";

const MIN_RECORDED_XML_LENGTH = 128;
// Recorded fixtures must remain reviewable; this pre-allocation cap also bounds the parser tree.
export const MAX_RECORDED_XML_BYTES = 4 * 1024 * 1024;
const MAX_RECORDED_XML_DEPTH = 64;
const MAX_RECORDED_XML_ELEMENTS = 50_000;
const XML_DOCTYPE_PATTERN = /<!DOCTYPE\b/i;
const REJECTED_RECORDED_XML_ROOT_NAMES: ReadonlySet<string> = new Set(["body", "html", "head"]);

// Recognizes a recorded operation value that is a substantive, well-formed XML
// success payload — the shape captured by `apifuse record` against upstreams
// that return XML (e.g. Korean public-data APIs). Fails closed on malformed XML,
// HTML, DTD/processing-instruction payloads, oversized/deep/wide trees, error
// roots, and failure/control-only envelopes. Uses a maintained parser rather
// than regex so entity/namespace/CDATA handling is correct.
export function hasSubstantiveXmlStructure(
	value: string,
	parser: typeof parseXml = parseXml,
): boolean {
	if (Buffer.byteLength(value, "utf8") > MAX_RECORDED_XML_BYTES) {
		return false;
	}
	const xml = value.trim();
	if (xml.length < MIN_RECORDED_XML_LENGTH || XML_DOCTYPE_PATTERN.test(xml)) {
		return false;
	}

	let document: ReturnType<typeof parseXml>;
	try {
		document = parser(xml, { preserveDocumentType: true });
	} catch (error) {
		if (error instanceof XmlError || error instanceof RangeError) {
			return false;
		}
		throw error;
	}
	if (
		document.children.some(
			(child) => child instanceof XmlDocumentType || child instanceof XmlProcessingInstruction,
		)
	) {
		return false;
	}

	const root = document.root;
	if (root === null) {
		return false;
	}
	const rootName = normalizedXmlName(root.name);
	if (REJECTED_RECORDED_XML_ROOT_NAMES.has(rootName) || isXmlErrorRootName(rootName)) {
		return false;
	}

	const pending: Array<{
		readonly branch: XmlSemanticBranch;
		readonly element: XmlElement;
		readonly depth: number;
	}> = [
		{
			element: root,
			depth: 1,
			branch: rootXmlContext(rootName),
		},
	];
	const leafNames = new Set<string>();
	let leafTextLength = 0;
	let elementCount = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) {
			break;
		}
		elementCount += 1;
		if (
			elementCount > MAX_RECORDED_XML_ELEMENTS ||
			current.depth > MAX_RECORDED_XML_DEPTH ||
			hasSemanticXmlFailure(current.element, current.branch)
		) {
			return false;
		}

		const childElements: XmlElement[] = [];
		for (const child of current.element.children) {
			if (child instanceof XmlProcessingInstruction) {
				return false;
			}
			if (child instanceof XmlElement) {
				childElements.push(child);
			}
		}
		if (childElements.length === 0) {
			const leafText = current.element.text.trim();
			// Only substantive *domain* leaves count as evidence. Control/error
			// leaves (resultCode, resultMsg, header status, …) are not payload data,
			// so a control-only success envelope with no real records is rejected.
			if (
				leafText.length > 0 &&
				current.depth >= 3 &&
				current.branch !== "control" &&
				current.branch !== "error"
			) {
				leafNames.add(normalizedXmlName(current.element.name));
				leafTextLength += leafText.length;
			}
			continue;
		}
		for (const child of childElements) {
			const childName = normalizedXmlName(child.name);
			pending.push({
				element: child,
				depth: current.depth + 1,
				branch: childXmlContext(current.branch, childName),
			});
		}
	}
	return leafNames.size >= 2 && leafTextLength >= 16;
}
