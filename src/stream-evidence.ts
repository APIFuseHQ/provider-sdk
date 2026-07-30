import { createHash } from "node:crypto";

import {
	isSensitiveFixtureKey,
	REDACTED_FIXTURE_VALUE,
	sanitizeUrlForLogs,
} from "./fixture-sanitization.js";
import { readableBytes, readableLines, readableTextChunks } from "./stream.js";
import type { HttpStreamResponse } from "./types.js";

export const STREAM_PREVIEW_BYTES = 4096;
export const STREAM_FINALIZE_TIMEOUT_MS = 30_000;
const STREAM_EVIDENCE_HEADER_NAMES = [
	"content-disposition",
	"content-length",
	"content-type",
] as const;
const STREAM_EVIDENCE_HEADERS = new Set<string>(STREAM_EVIDENCE_HEADER_NAMES);

export interface StreamEvidenceHeaders {
	"content-disposition"?: string;
	"content-length"?: string;
	"content-type"?: string;
}

export interface StreamEvidenceRequest {
	ordinal: number;
	method: string;
	path: string;
}

export type StreamEvidenceRedactionReason =
	| "invalid-utf8"
	| "malformed-json"
	| "sanitized-preview-too-large"
	| "sanitizer-error"
	| "sanitizer-output-invalid"
	| "sensitive-delimited-column"
	| "textual-xml"
	| "truncated-json";

export interface StreamEvidenceRecord {
	__apifuse_stream__: true;
	status: number;
	ok: boolean;
	headers: StreamEvidenceHeaders;
	body_sha256: string;
	body_bytes: number;
	body_preview_base64: string;
	request?: StreamEvidenceRequest;
	preview_sanitized?: true;
	preview_redaction_reason?: StreamEvidenceRedactionReason;
}

export type StreamEvidenceReplayResponse = HttpStreamResponse & {
	evidence_only: true;
	body_sha256: string;
	body_bytes: number;
	preview_sanitized?: true;
	preview_redaction_reason?: StreamEvidenceRedactionReason;
};

export interface StreamEvidenceCapture {
	response: HttpStreamResponse;
	getEvidence(): Promise<StreamEvidenceRecord>;
}

export type StreamEvidenceCaptureOptions = {
	requestUrl: string;
	sanitizeFixture?: (value: unknown) => unknown;
	request?: StreamEvidenceRequest;
	finalizeTimeoutMs?: number;
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
	if (record.request !== undefined) validateStreamEvidenceRequest(record.request);
	if (record.preview_sanitized !== undefined && record.preview_sanitized !== true) {
		throw new Error('Stream evidence field "preview_sanitized" must be true when present.');
	}
	if (
		record.preview_redaction_reason !== undefined &&
		!isStreamEvidenceRedactionReason(record.preview_redaction_reason)
	) {
		throw new Error('Stream evidence field "preview_redaction_reason" is invalid.');
	}
	if (record.preview_redaction_reason !== undefined && record.preview_sanitized !== true) {
		throw new Error(
			'Stream evidence field "preview_redaction_reason" requires "preview_sanitized".',
		);
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

	const headers = streamEvidenceHeaders(record.headers);
	return {
		__apifuse_stream__: true,
		status: record.status as number,
		ok: record.ok,
		headers,
		body_sha256: record.body_sha256,
		body_bytes: record.body_bytes as number,
		body_preview_base64: record.body_preview_base64,
		...(record.request === undefined ? {} : { request: streamEvidenceRequest(record.request) }),
		...(record.preview_sanitized === true ? { preview_sanitized: true as const } : {}),
		...(record.preview_redaction_reason === undefined
			? {}
			: { preview_redaction_reason: record.preview_redaction_reason }),
	};
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
	return findStreamEvidenceRecords(value).at(-1);
}

/**
 * Selects every stream captured by the latest recording invocation, in stream call order.
 * Evidence without request ordinals uses the legacy latest-record-only behavior.
 */
export function findStreamEvidenceRecords(value: unknown): StreamEvidenceRecord[] {
	const group = findLatestStreamCaptureGroup(value);
	if (!group) return [];
	return group
		.filter(hasStreamEvidenceMarker)
		.map((candidate) => parseStreamEvidenceRecord(candidate));
}

/** Returns the latest mixed response group used by evidence-only snapshot replay. */
export function findStreamCaptureGroup(value: unknown): unknown[] | undefined {
	return findLatestStreamCaptureGroup(value);
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
			options.request,
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
					if (terminalError) throw terminalError;
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
			if (terminalError) return Promise.reject(terminalError);
			if (evidence) return Promise.resolve(evidence);
			if (evidencePromise) return evidencePromise;

			finalizing = true;
			const drainPromise = (async () => {
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
					if (terminalError) throw terminalError;
					if (result.done) return finishCapture();
					retainChunk(result.value);
				}
			})();
			const timeoutMs = options.finalizeTimeoutMs ?? STREAM_FINALIZE_TIMEOUT_MS;
			evidencePromise = withFinalizationTimeout(drainPromise, timeoutMs, async () => {
				const timeoutError = streamCaptureError(
					`finalization timed out after ${timeoutMs}ms`,
					options.requestUrl,
					response,
					bodyBytes,
				);
				terminalError ??= timeoutError;
				await reader.cancel(timeoutError).catch(() => undefined);
				return timeoutError;
			});
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
		...(validEvidence.preview_sanitized ? { preview_sanitized: true as const } : {}),
		...(validEvidence.preview_redaction_reason
			? { preview_redaction_reason: validEvidence.preview_redaction_reason }
			: {}),
	};
}

function createEvidenceRecord(
	response: HttpStreamResponse,
	bodySha256: string,
	bodyBytes: number,
	preview: Uint8Array,
	sanitizeFixture?: (value: unknown) => unknown,
	request?: StreamEvidenceRequest,
): StreamEvidenceRecord {
	const contentType = headerValue(response.headers, "content-type");
	const sanitized = sanitizeFixture
		? sanitizePreview(preview, bodyBytes, contentType, sanitizeFixture)
		: undefined;
	const safePreview = sanitized?.preview ?? preview;
	const previewChanged = !bytesEqual(safePreview, preview);

	return {
		__apifuse_stream__: true,
		status: response.status,
		ok: response.ok,
		headers: evidenceHeaders(response.headers),
		body_sha256: bodySha256,
		body_bytes: bodyBytes,
		body_preview_base64: Buffer.from(safePreview).toString("base64"),
		...(request ? { request } : {}),
		...(previewChanged ? { preview_sanitized: true as const } : {}),
		...(sanitized?.redactionReason ? { preview_redaction_reason: sanitized.redactionReason } : {}),
	};
}

type SanitizedPreview = {
	preview: Uint8Array;
	redactionReason?: StreamEvidenceRedactionReason;
};

function sanitizePreview(
	preview: Uint8Array,
	bodyBytes: number,
	contentType: string | undefined,
	sanitizeFixture: (value: unknown) => unknown,
): SanitizedPreview | undefined {
	const decodedText = new TextDecoder().decode(preview);
	const declaredTextual = isTextualContentType(contentType);
	const sniffedTextual =
		looksLikeJson(decodedText) || looksLikeXml(decodedText) || looksLikeText(decodedText);
	if (!declaredTextual && !sniffedTextual) return undefined;

	let text = decodedText;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(preview);
	} catch {
		return redactedSanitizedPreview(preview.byteLength, "invalid-utf8");
	}

	const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (mediaType.includes("xml") || looksLikeXml(text)) {
		return redactedSanitizedPreview(preview.byteLength, "textual-xml");
	}
	let sanitizedText: string;
	const jsonPreview = isJsonContentType(mediaType) || looksLikeJson(text);
	if (jsonPreview) {
		if (bodyBytes > preview.byteLength) {
			return redactedSanitizedPreview(preview.byteLength, "truncated-json");
		}
		try {
			sanitizedText = JSON.stringify(sanitizeFixture(JSON.parse(text)));
		} catch (error) {
			return redactedSanitizedPreview(
				preview.byteLength,
				error instanceof SyntaxError ? "malformed-json" : "sanitizer-error",
				true,
			);
		}
	} else if (mediaType === "application/x-www-form-urlencoded") {
		if (bodyBytes > preview.byteLength) {
			return redactedSanitizedPreview(preview.byteLength, "sanitizer-error");
		}
		const form = new URLSearchParams(text);
		let sanitized: unknown;
		try {
			sanitized = sanitizeFixture(Object.fromEntries(form.entries()));
		} catch {
			return redactedSanitizedPreview(preview.byteLength, "sanitizer-error");
		}
		if (!isStringRecord(sanitized)) {
			return redactedSanitizedPreview(preview.byteLength, "sanitizer-output-invalid");
		}
		sanitizedText = new URLSearchParams(sanitized).toString();
	} else {
		if (hasSensitiveDelimitedHeader(text)) {
			return redactedSanitizedPreview(preview.byteLength, "sensitive-delimited-column");
		}
		sanitizedText = redactSensitiveTextAssignments(text);
	}

	const sanitizedBytes = new TextEncoder().encode(sanitizedText);
	if (sanitizedBytes.byteLength > preview.byteLength) {
		return redactedSanitizedPreview(preview.byteLength, "sanitized-preview-too-large", jsonPreview);
	}
	return { preview: fitSanitizedPreview(sanitizedBytes, preview.byteLength) };
}

function redactSensitiveTextAssignments(text: string): string {
	return text.replace(
		/((["']?)([\w-]+)\2\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n&,;]+)/gi,
		(match, prefix: string, _keyQuote: string, key: string, value: string) => {
			if (!isSensitiveFixtureKey(key)) return match;
			const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
			return `${prefix}${quote}${REDACTED_FIXTURE_VALUE}${quote}`;
		},
	);
}

function hasSensitiveDelimitedHeader(text: string): boolean {
	const lines = text.split(/\r?\n/);
	const firstLine = lines[0]?.trim();
	if (!firstLine) return false;
	if (lines.length > 1 && isSensitiveFixtureKey(firstLine)) return true;
	for (const delimiter of [",", "\t", ";", "|"]) {
		const columns = splitDelimitedRow(firstLine, delimiter);
		if (columns.length > 1 && columns.some((column) => isSensitiveFixtureKey(column.trim()))) {
			return true;
		}
	}
	return false;
}

function splitDelimitedRow(row: string, delimiter: string): string[] {
	const values: string[] = [];
	let value = "";
	let quote = "";
	for (let index = 0; index < row.length; index += 1) {
		const character = row[index] ?? "";
		if (quote) {
			if (character === quote && row[index + 1] === quote) {
				value += quote;
				index += 1;
			} else if (character === quote) {
				quote = "";
			} else {
				value += character;
			}
		} else if ((character === '"' || character === "'") && value.length === 0) {
			quote = character;
		} else if (character === delimiter) {
			values.push(value);
			value = "";
		} else {
			value += character;
		}
	}
	values.push(value);
	return values;
}

function fitSanitizedPreview(sanitized: Uint8Array, targetBytes: number): Uint8Array {
	if (sanitized.byteLength > targetBytes) return validRedactedPreview(targetBytes);
	if (sanitized.byteLength === targetBytes) return sanitized;

	const fitted = new Uint8Array(targetBytes);
	fitted.fill(0x20);
	fitted.set(sanitized);
	return fitted;
}

function redactedPreview(byteLength: number): Uint8Array {
	const redacted = new Uint8Array(byteLength);
	redacted.fill(0x20);
	redacted.set(new TextEncoder().encode(REDACTED_FIXTURE_VALUE).subarray(0, byteLength));
	return redacted;
}

function validRedactedPreview(byteLength: number): Uint8Array {
	if (byteLength >= 2) {
		const redacted = new Uint8Array(byteLength);
		redacted.fill(0x20);
		redacted.set(new TextEncoder().encode("{}"));
		return redacted;
	}
	return redactedPreview(byteLength);
}

function redactedSanitizedPreview(
	byteLength: number,
	redactionReason: StreamEvidenceRedactionReason,
	validJson = false,
): SanitizedPreview {
	return {
		preview: validJson ? validRedactedPreview(byteLength) : redactedPreview(byteLength),
		redactionReason,
	};
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

function looksLikeXml(text: string): boolean {
	return /^\s*<\??[a-z_][\w:.-]*/i.test(text);
}

function looksLikeText(text: string): boolean {
	if (text.length === 0 || text.includes("\0")) return false;
	let readable = 0;
	let suspicious = 0;
	for (const character of text) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (character === "\uFFFD" || (codePoint < 0x20 && !"\t\n\r".includes(character))) {
			suspicious += 1;
		} else {
			readable += 1;
		}
	}
	return readable > 0 && suspicious / (readable + suspicious) < 0.02;
}

function findLatestStreamCaptureGroup(value: unknown): unknown[] | undefined {
	if (hasStreamEvidenceMarker(value)) {
		parseStreamEvidenceRecord(value);
		return [value];
	}
	if (!Array.isArray(value)) return undefined;

	let rightmostDirectMarker = -1;
	for (let index = value.length - 1; index >= 0; index -= 1) {
		const candidate = value[index];
		if (Array.isArray(candidate)) {
			const nested = findLatestStreamCaptureGroup(candidate);
			if (nested) return nested;
		}
		if (hasStreamEvidenceMarker(candidate)) {
			rightmostDirectMarker = index;
			break;
		}
	}
	if (rightmostDirectMarker < 0) return undefined;

	const directRecords = value
		.map((candidate, index) =>
			hasStreamEvidenceMarker(candidate)
				? { index, record: parseStreamEvidenceRecord(candidate) }
				: undefined,
		)
		.filter(
			(candidate): candidate is { index: number; record: StreamEvidenceRecord } =>
				candidate !== undefined,
		);
	if (directRecords.some(({ record }) => record.request === undefined)) {
		return [value[rightmostDirectMarker]];
	}

	let startIndex = 0;
	for (let index = 1; index < directRecords.length; index += 1) {
		const previous = directRecords[index - 1]?.record.request?.ordinal ?? 0;
		const current = directRecords[index]?.record.request?.ordinal ?? 0;
		if (current <= previous) startIndex = directRecords[index]?.index ?? startIndex;
	}
	return value.slice(startIndex);
}

export function hasStreamEvidenceMarker(value: unknown): boolean {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.__apifuse_stream__ === true &&
		("body_sha256" in record ||
			"body_bytes" in record ||
			"body_preview_base64" in record ||
			"headers" in record)
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

function validateStreamEvidenceRequest(value: unknown): void {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error('Stream evidence field "request" must be an object.');
	}
	const request = value as Record<string, unknown>;
	if (!Number.isSafeInteger(request.ordinal) || (request.ordinal as number) < 1) {
		throw new Error('Stream evidence request field "ordinal" must be a positive safe integer.');
	}
	if (typeof request.method !== "string" || !/^[A-Z]+$/.test(request.method)) {
		throw new Error('Stream evidence request field "method" must be an uppercase HTTP method.');
	}
	if (
		typeof request.path !== "string" ||
		!request.path.startsWith("/") ||
		request.path.includes("?") ||
		request.path.includes("#")
	) {
		throw new Error('Stream evidence request field "path" must be a query-free absolute path.');
	}
}

function streamEvidenceRequest(value: unknown): StreamEvidenceRequest {
	validateStreamEvidenceRequest(value);
	const request = value as Record<string, unknown>;
	return {
		ordinal: request.ordinal as number,
		method: request.method as string,
		path: request.path as string,
	};
}

function isStreamEvidenceRedactionReason(value: unknown): value is StreamEvidenceRedactionReason {
	return (
		value === "invalid-utf8" ||
		value === "malformed-json" ||
		value === "sanitized-preview-too-large" ||
		value === "sanitizer-error" ||
		value === "sanitizer-output-invalid" ||
		value === "sensitive-delimited-column" ||
		value === "textual-xml" ||
		value === "truncated-json"
	);
}

function streamEvidenceHeaders(headers: Record<string, string>): StreamEvidenceHeaders {
	return {
		...(headers["content-disposition"] === undefined
			? {}
			: { "content-disposition": headers["content-disposition"] }),
		...(headers["content-length"] === undefined
			? {}
			: { "content-length": headers["content-length"] }),
		...(headers["content-type"] === undefined ? {} : { "content-type": headers["content-type"] }),
	};
}

function evidenceHeaders(headers: Record<string, string>): StreamEvidenceHeaders {
	const evidence: StreamEvidenceHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		const normalizedName = name.toLowerCase();
		if (normalizedName === "content-disposition") evidence["content-disposition"] = value;
		if (normalizedName === "content-length") evidence["content-length"] = value;
		if (normalizedName === "content-type") evidence["content-type"] = value;
	}
	return evidence;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	return left.every((byte, index) => byte === right[index]);
}

function withFinalizationTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	onTimeout: () => Promise<Error>,
): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
	return new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(() => {
			void onTimeout().then(reject, reject);
		}, timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
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
		`Stream capture ${phase}: url=${sanitizeUrlForLogs(requestUrl)} status=${response.status} bytes_read=${bodyBytes}`,
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
