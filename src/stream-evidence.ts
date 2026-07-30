import { createHash } from "node:crypto";

import { readableBytes, readableLines, readableTextChunks } from "./stream.js";
import type { HttpStreamResponse } from "./types.js";

export const STREAM_PREVIEW_BYTES = 4096;
const STREAM_EVIDENCE_HEADER_NAMES = [
	"content-disposition",
	"content-length",
	"content-type",
] as const;
const STREAM_EVIDENCE_HEADERS = new Set<string>(STREAM_EVIDENCE_HEADER_NAMES);

export interface StreamEvidenceRecord {
	__apifuse_stream__: true;
	status: number;
	ok: boolean;
	headers: Record<string, string>;
	body_sha256: string;
	body_bytes: number;
	body_preview_base64: string;
}

export type StreamEvidenceReplayResponse = HttpStreamResponse & {
	evidence_only: true;
	body_sha256: string;
	body_bytes: number;
};

export interface StreamEvidenceCapture {
	response: HttpStreamResponse;
	getEvidence(): Promise<StreamEvidenceRecord>;
}

export type StreamEvidenceCaptureOptions = {
	requestUrl: string;
	sanitizeFixture?: (value: unknown) => unknown;
};

export function parseStreamEvidenceRecord(value: unknown): StreamEvidenceRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Stream evidence must be an object.");
	}

	const record = value as Record<string, unknown>;
	if (record.__apifuse_stream__ !== true) {
		throw new Error('Stream evidence field "__apifuse_stream__" must be true.');
	}
	if (
		!Number.isInteger(record.status) ||
		(record.status as number) < 100 ||
		(record.status as number) > 599
	) {
		throw new Error('Stream evidence field "status" must be an integer from 100 through 599.');
	}
	if (typeof record.ok !== "boolean") {
		throw new Error('Stream evidence field "ok" must be a boolean.');
	}
	if (record.ok !== ((record.status as number) >= 200 && (record.status as number) < 300)) {
		throw new Error('Stream evidence field "ok" is inconsistent with "status".');
	}
	if (!isStringRecord(record.headers)) {
		throw new Error('Stream evidence field "headers" must contain only string values.');
	}
	for (const name of Object.keys(record.headers)) {
		if (!STREAM_EVIDENCE_HEADERS.has(name)) {
			throw new Error(`Stream evidence header "${name}" is not allowlisted.`);
		}
	}
	if (typeof record.body_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.body_sha256)) {
		throw new Error('Stream evidence field "body_sha256" must be a lowercase SHA-256 hex digest.');
	}
	if (!Number.isSafeInteger(record.body_bytes) || (record.body_bytes as number) < 0) {
		throw new Error('Stream evidence field "body_bytes" must be a non-negative safe integer.');
	}
	if (typeof record.body_preview_base64 !== "string") {
		throw new Error('Stream evidence field "body_preview_base64" must be a string.');
	}

	const preview = Buffer.from(record.body_preview_base64, "base64");
	if (preview.toString("base64") !== record.body_preview_base64) {
		throw new Error('Stream evidence field "body_preview_base64" must be canonical base64.');
	}
	const expectedPreviewBytes = Math.min(record.body_bytes as number, STREAM_PREVIEW_BYTES);
	if (preview.byteLength !== expectedPreviewBytes) {
		throw new Error(
			`Stream evidence preview must decode to ${expectedPreviewBytes} bytes for body_bytes=${String(record.body_bytes)}.`,
		);
	}

	return record as unknown as StreamEvidenceRecord;
}

export function isStreamEvidenceRecord(value: unknown): value is StreamEvidenceRecord {
	try {
		parseStreamEvidenceRecord(value);
		return true;
	} catch {
		return false;
	}
}

export function findStreamEvidenceRecord(value: unknown): StreamEvidenceRecord | undefined {
	const candidates = Array.isArray(value) ? value : [value];
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index];
		if (hasStreamEvidenceMarker(candidate)) {
			return parseStreamEvidenceRecord(candidate);
		}
	}
	return undefined;
}

export function isStreamEvidenceReplayResponse(
	response: HttpStreamResponse,
): response is StreamEvidenceReplayResponse {
	const candidate = response as Partial<StreamEvidenceReplayResponse>;
	return (
		candidate.evidence_only === true &&
		typeof candidate.body_sha256 === "string" &&
		Number.isSafeInteger(candidate.body_bytes)
	);
}

export function captureStreamEvidence(
	response: HttpStreamResponse,
	options: StreamEvidenceCaptureOptions,
): StreamEvidenceCapture {
	const reader = response.body.getReader();
	const hash = createHash("sha256");
	const preview = new Uint8Array(STREAM_PREVIEW_BYTES);
	let bodyBytes = 0;
	let previewBytes = 0;
	let evidence: StreamEvidenceRecord | undefined;
	let terminalError: Error | undefined;
	let handlerPull: Promise<void> | undefined;
	let handlerCanceled = false;
	let finalizing = false;
	let evidencePromise: Promise<StreamEvidenceRecord> | undefined;

	function retainChunk(chunk: Uint8Array): void {
		hash.update(chunk);
		bodyBytes += chunk.byteLength;
		if (previewBytes < STREAM_PREVIEW_BYTES) {
			const retained = chunk.subarray(0, STREAM_PREVIEW_BYTES - previewBytes);
			preview.set(retained, previewBytes);
			previewBytes += retained.byteLength;
		}
	}

	function finishCapture(): StreamEvidenceRecord {
		evidence ??= createEvidenceRecord(
			response,
			hash.digest("hex"),
			bodyBytes,
			preview.subarray(0, previewBytes),
			options.sanitizeFixture,
		);
		return evidence;
	}

	function captureReadFailure(error: unknown): Error {
		terminalError ??= streamCaptureError(
			"read failed",
			options.requestUrl,
			response,
			bodyBytes,
			error,
		);
		return terminalError;
	}

	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (finalizing) return;

			const currentPull = (async () => {
				try {
					const result = await reader.read();
					if (result.done) {
						finishCapture();
						if (!handlerCanceled) controller.close();
						return;
					}

					retainChunk(result.value);
					if (!handlerCanceled) controller.enqueue(result.value);
				} catch (error) {
					controller.error(captureReadFailure(error));
				}
			})();
			handlerPull = currentPull;
			try {
				await currentPull;
			} finally {
				if (handlerPull === currentPull) handlerPull = undefined;
			}
		},
		cancel() {
			handlerCanceled = true;
			// Keep the upstream reader alive so finalization can capture the complete body.
		},
	});

	return {
		response: streamResponseFromBody(response.status, response.ok, response.headers, body),
		getEvidence() {
			if (evidence) return Promise.resolve(evidence);
			if (terminalError) return Promise.reject(terminalError);
			if (evidencePromise) return evidencePromise;

			finalizing = true;
			evidencePromise = (async () => {
				await handlerPull;
				if (terminalError) throw terminalError;
				if (evidence) return evidence;

				for (;;) {
					let result: Awaited<ReturnType<typeof reader.read>>;
					try {
						result = await reader.read();
					} catch (error) {
						throw captureReadFailure(error);
					}
					if (result.done) return finishCapture();
					retainChunk(result.value);
				}
			})();
			return evidencePromise;
		},
	};
}

export function replayStreamEvidence(evidence: StreamEvidenceRecord): StreamEvidenceReplayResponse {
	const validEvidence = parseStreamEvidenceRecord(evidence);
	const preview = new Uint8Array(Buffer.from(validEvidence.body_preview_base64, "base64"));
	const replayHeaders = Object.fromEntries(
		Object.entries(validEvidence.headers).filter(([name]) => name !== "content-length"),
	);
	return {
		...streamResponseFromBytes(validEvidence.status, validEvidence.ok, replayHeaders, preview),
		evidence_only: true,
		body_sha256: validEvidence.body_sha256,
		body_bytes: validEvidence.body_bytes,
	};
}

function createEvidenceRecord(
	response: HttpStreamResponse,
	bodySha256: string,
	bodyBytes: number,
	preview: Uint8Array,
	sanitizeFixture?: (value: unknown) => unknown,
): StreamEvidenceRecord {
	const contentType = headerValue(response.headers, "content-type");
	const safePreview =
		sanitizeFixture && isTextualContentType(contentType)
			? sanitizeTextualPreview(preview, bodyBytes, contentType, sanitizeFixture)
			: preview;

	return {
		__apifuse_stream__: true,
		status: response.status,
		ok: response.ok,
		headers: evidenceHeaders(response.headers),
		body_sha256: bodySha256,
		body_bytes: bodyBytes,
		body_preview_base64: Buffer.from(safePreview).toString("base64"),
	};
}

function sanitizeTextualPreview(
	preview: Uint8Array,
	bodyBytes: number,
	contentType: string | undefined,
	sanitizeFixture: (value: unknown) => unknown,
): Uint8Array {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(preview);
	} catch {
		return redactedPreview(preview.byteLength);
	}

	const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	let sanitizedText: string;
	if (isJsonContentType(mediaType) || looksLikeJson(text)) {
		if (bodyBytes > preview.byteLength) return redactedPreview(preview.byteLength);
		try {
			sanitizedText = JSON.stringify(sanitizeFixture(JSON.parse(text)));
		} catch {
			return redactedPreview(preview.byteLength);
		}
	} else if (mediaType === "application/x-www-form-urlencoded") {
		if (bodyBytes > preview.byteLength) return redactedPreview(preview.byteLength);
		const form = new URLSearchParams(text);
		const sanitized = sanitizeFixture(Object.fromEntries(form.entries()));
		sanitizedText = new URLSearchParams(sanitized as Record<string, string>).toString();
	} else if (mediaType.includes("xml")) {
		return redactedPreview(preview.byteLength);
	} else {
		sanitizedText = redactSensitiveTextAssignments(text);
	}

	return fitSanitizedPreview(new TextEncoder().encode(sanitizedText), preview.byteLength);
}

function redactSensitiveTextAssignments(text: string): string {
	return text.replace(
		/((?:["']?(?:authorization|[\w-]*token[\w-]*|[\w-]*api[-_]?key[\w-]*)["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n&,;]+)/gi,
		(_match, prefix: string, value: string) => {
			const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
			return `${prefix}${quote}[REDACTED]${quote}`;
		},
	);
}

function fitSanitizedPreview(sanitized: Uint8Array, targetBytes: number): Uint8Array {
	if (sanitized.byteLength > targetBytes) return redactedPreview(targetBytes);
	if (sanitized.byteLength === targetBytes) return sanitized;

	const fitted = new Uint8Array(targetBytes);
	fitted.fill(0x20);
	fitted.set(sanitized);
	return fitted;
}

function redactedPreview(byteLength: number): Uint8Array {
	const redacted = new Uint8Array(byteLength);
	redacted.fill(0x20);
	redacted.set(new TextEncoder().encode("[REDACTED]").subarray(0, byteLength));
	return redacted;
}

function isTextualContentType(contentType: string | undefined): boolean {
	const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return (
		mediaType.startsWith("text/") ||
		isJsonContentType(mediaType) ||
		mediaType === "application/xml" ||
		mediaType.endsWith("+xml") ||
		mediaType === "application/x-www-form-urlencoded"
	);
}

function isJsonContentType(mediaType: string): boolean {
	return mediaType === "application/json" || mediaType.endsWith("+json");
}

function looksLikeJson(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function hasStreamEvidenceMarker(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"__apifuse_stream__" in value
	);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.values(value).every((entry) => typeof entry === "string")
	);
}

function evidenceHeaders(headers: Record<string, string>): Record<string, string> {
	const evidence: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const normalizedName = name.toLowerCase();
		if (STREAM_EVIDENCE_HEADERS.has(normalizedName)) {
			evidence[normalizedName] = value;
		}
	}
	return evidence;
}

function headerValue(headers: Record<string, string>, targetName: string): string | undefined {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() === targetName) return value;
	}
	return undefined;
}

function streamCaptureError(
	phase: string,
	requestUrl: string,
	response: HttpStreamResponse,
	bodyBytes: number,
	cause?: unknown,
): Error {
	return new Error(
		`Stream capture ${phase}: url=${requestUrl} status=${response.status} bytes_read=${bodyBytes}`,
		cause === undefined ? undefined : { cause },
	);
}

function streamResponseFromBytes(
	status: number,
	ok: boolean,
	headers: Record<string, string>,
	bytes: Uint8Array,
): HttpStreamResponse {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			if (bytes.byteLength > 0) controller.enqueue(bytes.slice());
			controller.close();
		},
	});
	return streamResponseFromBody(status, ok, headers, body);
}

function streamResponseFromBody(
	status: number,
	ok: boolean,
	headers: Record<string, string>,
	body: ReadableStream<Uint8Array>,
): HttpStreamResponse {
	return {
		status,
		ok,
		headers: { ...headers },
		body,
		bytes: () => readableBytes(body),
		textChunks: () => readableTextChunks(body),
		lines: () => readableLines(body),
	};
}
