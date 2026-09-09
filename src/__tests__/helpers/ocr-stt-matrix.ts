import { expect } from "bun:test";

export function assertNamedOcrCell(
	projection: { log?: { ocr?: unknown } | null; header: { ocr?: unknown } },
	cell: string,
): void {
	expect(projection.log?.ocr, `OCR sink missing: ${cell}`).toBeDefined();
	expect(projection.header.ocr, `OCR sink missing from header: ${cell}`).toBeDefined();
}
