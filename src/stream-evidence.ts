import { createHash } from "node:crypto";

import {
	isSensitiveFixtureKey,
	isSensitiveFixtureValue,
	REDACTED_FIXTURE_VALUE,
	sanitizeDiagnosticText,
	sanitizeFixtureString,
	sanitizeUrlForLogs,
} from "./fixture-sanitization.js";
import { toJsonValue, type JsonValue } from "./contract-json.js";
import { readableBytes, readableLines, readableTextChunks } from "./stream.js";
import type { HttpStreamResponse } from "./types.js";

export const STREAM_PREVIEW_BYTES = 4096;
export const STREAM_FINALIZE_TIMEOUT_MS = 30_000;
const STREAM_EVIDENCE_HEADER_NAMES = [
	"content-disposition",
	"content-length",
	"content-type",
] as const;
type StreamEvidenceHeaderName = (typeof STREAM_EVIDENCE_HEADER_NAMES)[number];
const STREAM_EVIDENCE_HEADERS = new Set<string>(STREAM_EVIDENCE_HEADER_NAMES);

export type StreamEvidenceHeaders = Partial<Record<StreamEvidenceHeaderName, string>>;

export interface StreamEvidenceRequest {
	ordinal: number;
	method: string;
	path: string;
}

const STREAM_EVIDENCE_REDACTION_REASONS = [
	"high-entropy-token",
	"malformed-json",
	"pem-private-key",
	"sanitized-preview-too-large",
	"sanitizer-output-invalid",
	"sensitive-delimited-column",
	"textual-xml",
	"truncated-form",
	"truncated-json",
	"undecodable-text",
] as const;
const STREAM_EVIDENCE_REDACTION_REASON_SET = new Set<string>(STREAM_EVIDENCE_REDACTION_REASONS);
export type StreamEvidenceRedactionReason = (typeof STREAM_EVIDENCE_REDACTION_REASONS)[number];

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

export type StreamCaptureGroupItem =
	| { kind: "stream"; evidence: StreamEvidenceRecord }
	| { kind: "response"; value: JsonValue };

export interface StreamCaptureGroup {
	items: StreamCaptureGroupItem[];
}

export interface StreamCaptureEnvelope {
	__apifuse_capture__: true;
	items: StreamCaptureGroupItem[];
}

export type StreamEvidenceCaptureOptions = {
	requestUrl: string;
	sanitizeFixture?: (value: JsonValue) => JsonValue;
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
			throw new Error(
				`Stream evidence header "${sanitizeDiagnosticText(name)}" is not allowlisted.`,
			);
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
	if (
		record.preview_sanitized !== true &&
		(record.body_bytes as number) <= STREAM_PREVIEW_BYTES &&
		createHash("sha256").update(preview).digest("hex") !== record.body_sha256
	) {
		throw new Error(
			'Stream evidence field "body_sha256" must match a complete unsanitized preview.',
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
	if (isStreamCaptureEnvelope(value)) {
		return parseStreamCaptureEnvelope(value).items.flatMap((item) =>
			item.kind === "stream" ? [item.evidence] : [],
		);
	}
	if (Array.isArray(value) && isStreamCaptureEnvelope(value.at(-1))) {
		return parseStreamCaptureEnvelope(value.at(-1) as StreamCaptureEnvelope).items.flatMap(
			(item) => (item.kind === "stream" ? [item.evidence] : []),
		);
	}
	const group = findLatestStreamCaptureGroup(value);
	if (!group) return [];
	return group
		.filter(hasStreamEvidenceMarker)
		.map((candidate) => parseStreamEvidenceRecord(candidate));
}

/** Returns a tagged latest mixed response group used by evidence-only snapshot replay. */
export function findStreamCaptureGroup(value: unknown): StreamCaptureGroup | undefined {
	if (isStreamCaptureEnvelope(value)) return parseStreamCaptureEnvelope(value);
	if (Array.isArray(value)) {
		const latest = value.at(-1);
		if (isStreamCaptureEnvelope(latest)) return parseStreamCaptureEnvelope(latest);
		if (Array.isArray(latest)) {
			const nested = findStreamCaptureGroup(latest);
			if (nested) return nested;
		}
	}
	const group = findLatestStreamCaptureGroup(value);
	if (!group) return undefined;
	return {
		items: group.map((item): StreamCaptureGroupItem => {
			if (hasStreamEvidenceMarker(item)) {
				return { kind: "stream", evidence: parseStreamEvidenceRecord(item) };
			}
			const json = toJsonValue(item);
			if (json === undefined) {
				throw new Error("Stream capture group contains a non-JSON response value.");
			}
			return { kind: "response", value: json };
		}),
	};
}

/** Creates a discriminated invocation envelope so ordinary arrays cannot mimic capture timelines. */
export function createStreamCaptureEnvelope(
	items: StreamCaptureGroupItem[],
): StreamCaptureEnvelope {
	if (!items.some((item) => item.kind === "stream")) {
		throw new Error("A stream capture envelope must contain at least one stream item.");
	}
	return { __apifuse_capture__: true, items };
}

function isStreamCaptureEnvelope(value: unknown): value is StreamCaptureEnvelope {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(value as Record<string, unknown>).__apifuse_capture__ === true
	);
}

function parseStreamCaptureEnvelope(value: StreamCaptureEnvelope): StreamCaptureGroup {
	if (!Array.isArray(value.items) || value.items.length === 0) {
		throw new Error("Stream capture envelope items must be a non-empty array.");
	}
	const items = value.items.map((item): StreamCaptureGroupItem => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			throw new Error("Stream capture envelope item must be an object.");
		}
		if (item.kind === "stream") {
			return { kind: "stream", evidence: parseStreamEvidenceRecord(item.evidence) };
		}
		if (item.kind === "response") {
			const json = toJsonValue(item.value);
			if (json === undefined) {
				throw new Error("Stream capture response item must contain a JSON value.");
			}
			return { kind: "response", value: json };
		}
		throw new Error('Stream capture envelope item kind must be "stream" or "response".');
	});
	if (!items.some((item) => item.kind === "stream")) {
		throw new Error("Stream capture envelope must contain at least one stream item.");
	}
	return { items };
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
			evidencePromise = withFinalizationTimeout(drainPromise, timeoutMs, () => {
				const timeoutError = streamCaptureError(
					`finalization timed out after ${timeoutMs}ms`,
					options.requestUrl,
					response,
					bodyBytes,
				);
				terminalError ??= timeoutError;
				void reader.cancel(timeoutError).catch((cancelError: unknown) => {
					timeoutError.cause = cancelError;
				});
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
	sanitizeFixture?: (value: JsonValue) => JsonValue,
	request?: StreamEvidenceRequest,
): StreamEvidenceRecord {
	const contentType = headerValue(response.headers, "content-type");
	const sanitized = sanitizeFixture
		? sanitizePreview(preview, bodyBytes, contentType, sanitizeFixture)
		: undefined;
	const safePreview = sanitized?.preview ?? preview;
	const previewChanged = !bytesEqual(safePreview, preview);
	const previewSanitized = previewChanged || sanitized?.redactionReason !== undefined;

	return {
		__apifuse_stream__: true,
		status: response.status,
		ok: response.ok,
		headers: evidenceHeaders(response.headers, sanitizeFixture !== undefined),
		body_sha256: bodySha256,
		body_bytes: bodyBytes,
		body_preview_base64: Buffer.from(safePreview).toString("base64"),
		...(request ? { request } : {}),
		...(previewSanitized ? { preview_sanitized: true as const } : {}),
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
	sanitizeFixture: (value: JsonValue) => JsonValue,
): SanitizedPreview | undefined {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(preview);
	} catch {
		return sanitizePartiallyDecodablePreview(preview);
	}

	const declaredTextual = isTextualContentType(contentType);
	const sniffedTextual = looksLikeJson(text) || looksLikeXml(text) || looksLikeText(text);
	const sanitizedPrimitive = sanitizeFixtureString(text);
	const containsTextualSecret = sanitizedPrimitive !== text;
	if (hasKnownBinaryMagic(preview) && !containsTextualSecret) return undefined;
	if (!declaredTextual && !sniffedTextual) return undefined;

	const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (looksLikePemPrivateKey(text)) {
		return redactedSanitizedPreview(preview.byteLength, "pem-private-key");
	}
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
			sanitizedText = JSON.stringify(sanitizeFixture(JSON.parse(text) as JsonValue));
		} catch (error) {
			if (!(error instanceof SyntaxError)) {
				throw new Error("Stream JSON preview sanitizer failed.", { cause: error });
			}
			return redactedSanitizedPreview(preview.byteLength, "malformed-json", true);
		}
	} else if (mediaType === "application/x-www-form-urlencoded") {
		if (bodyBytes > preview.byteLength) {
			return redactedSanitizedPreview(preview.byteLength, "truncated-form");
		}
		const form = new URLSearchParams(text);
		let sanitized: JsonValue;
		try {
			sanitized = sanitizeFixture(Object.fromEntries(form.entries()));
		} catch (error) {
			throw new Error("Stream form preview sanitizer failed.", { cause: error });
		}
		if (!isStringRecord(sanitized)) {
			return redactedSanitizedPreview(preview.byteLength, "sanitizer-output-invalid");
		}
		sanitizedText = new URLSearchParams(sanitized).toString();
	} else {
		if (hasSensitiveDelimitedHeader(text)) {
			return redactedSanitizedPreview(preview.byteLength, "sensitive-delimited-column");
		}
		const tokenRedaction = redactHighEntropyTokens(text);
		sanitizedText = sanitizeFixtureString(tokenRedaction.text);
		const sanitizedBytes = new TextEncoder().encode(sanitizedText);
		if (sanitizedBytes.byteLength > preview.byteLength) {
			return redactedSanitizedPreview(preview.byteLength, "sanitized-preview-too-large");
		}
		return {
			preview: fitSanitizedPreview(sanitizedBytes, preview.byteLength),
			...(tokenRedaction.redacted ? { redactionReason: "high-entropy-token" as const } : {}),
		};
	}

	const sanitizedBytes = new TextEncoder().encode(sanitizedText);
	if (sanitizedBytes.byteLength > preview.byteLength) {
		return redactedSanitizedPreview(preview.byteLength, "sanitized-preview-too-large", jsonPreview);
	}
	return { preview: fitSanitizedPreview(sanitizedBytes, preview.byteLength) };
}

function sanitizePartiallyDecodablePreview(preview: Uint8Array): SanitizedPreview | undefined {
	const text = new TextDecoder("utf-8").decode(preview);
	const containsTextualSecret = sanitizeFixtureString(text) !== text;

	if (!containsTextualSecret) {
		if (hasKnownBinaryMagic(preview)) return undefined;
		// Undecodable non-binary data cannot be proven safe. Declared text in particular must fail closed.
		return redactedSanitizedPreview(preview.byteLength, "undecodable-text");
	}

	let sanitized = sanitizeDecodableWindows(preview);
	const retainedText = new TextDecoder("utf-8").decode(sanitized);
	if (sanitizeFixtureString(retainedText) !== retainedText) {
		sanitized = redactedPreview(preview.byteLength);
	}
	return {
		preview: sanitized,
		...(looksLikePemPrivateKey(text)
			? { redactionReason: "pem-private-key" as const }
			: redactHighEntropyTokens(text).redacted
				? { redactionReason: "high-entropy-token" as const }
				: {}),
	};
}

function sanitizeDecodableWindows(preview: Uint8Array): Uint8Array {
	const sanitized = preview.slice();
	let start = 0;
	for (let index = 0; index <= preview.byteLength; index += 1) {
		const byte = preview[index];
		if (index < preview.byteLength && byte !== undefined && byte < 0x80) continue;
		if (index > start) {
			const window = preview.subarray(start, index);
			const text = new TextDecoder("utf-8", { fatal: true }).decode(window);
			const safeText = sanitizeFixtureString(text);
			if (safeText !== text) {
				sanitized.set(
					fitSanitizedPreview(new TextEncoder().encode(safeText), window.byteLength),
					start,
				);
			}
		}
		start = index + 1;
	}
	return sanitized;
}

function looksLikePemPrivateKey(text: string): boolean {
	return /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text);
}

function redactHighEntropyTokens(text: string): { text: string; redacted: boolean } {
	let redacted = false;
	const sanitized = text.replace(/[A-Za-z0-9_+/=.:~-]{24,}/g, (candidate) => {
		if (!isSensitiveFixtureValue(candidate)) return candidate;
		redacted = true;
		return REDACTED_FIXTURE_VALUE;
	});
	return { text: sanitized, redacted };
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
		const character = row.charAt(index);
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

function hasKnownBinaryMagic(bytes: Uint8Array): boolean {
	const signatures = [
		[0x89, 0x50, 0x4e, 0x47], // PNG
		[0xff, 0xd8, 0xff], // JPEG
		[0x47, 0x49, 0x46, 0x38], // GIF
		[0x25, 0x50, 0x44, 0x46], // PDF
		[0x50, 0x4b, 0x03, 0x04], // ZIP and ZIP-based formats
		[0x1f, 0x8b], // gzip
		[0x7f, 0x45, 0x4c, 0x46], // ELF
		[0x52, 0x61, 0x72, 0x21], // RAR
		[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
	] as const;
	return signatures.some(
		(signature) =>
			bytes.byteLength >= signature.length &&
			signature.every((byte, index) => bytes[index] === byte),
	);
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

	let startIndex = directRecords[0]?.index ?? 0;
	let previous = directRecords[0];
	if (!previous) return undefined;
	for (const current of directRecords.slice(1)) {
		const previousRequest = previous.record.request;
		const currentRequest = current.record.request;
		if (!previousRequest || !currentRequest) {
			throw new Error("Stream capture grouping invariant violated: request provenance is missing.");
		}
		if (currentRequest.ordinal <= previousRequest.ordinal) {
			startIndex = current.index;
		}
		previous = current;
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
	return typeof value === "string" && STREAM_EVIDENCE_REDACTION_REASON_SET.has(value);
}

function streamEvidenceHeaders(headers: Record<string, string>): StreamEvidenceHeaders {
	return selectEvidenceHeaders(Object.entries(headers));
}

function evidenceHeaders(
	headers: Record<string, string>,
	sanitize: boolean,
): StreamEvidenceHeaders {
	return selectEvidenceHeaders(
		Object.entries(headers).map(([name, value]) => {
			const normalizedName = name.toLowerCase();
			return [
				normalizedName,
				sanitize ? sanitizeEvidenceHeaderValue(normalizedName, value) : value,
			];
		}),
	);
}

function sanitizeEvidenceHeaderValue(name: string, value: string): string {
	if (name === "content-disposition") return sanitizeFixtureString(value);
	if (name !== "content-type") return value;
	const [mediaType = "", ...parameters] = value.split(";");
	if (parameters.length === 0) return mediaType;
	return [mediaType, ...parameters.map((parameter) => sanitizeFixtureString(parameter))].join(";");
}

function selectEvidenceHeaders(
	entries: Iterable<readonly [string, string]>,
): StreamEvidenceHeaders {
	const source = Object.fromEntries(entries);
	return Object.fromEntries(
		STREAM_EVIDENCE_HEADER_NAMES.flatMap((name) => {
			const value = source[name];
			return value === undefined ? [] : [[name, value]];
		}),
	);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	return left.every((byte, index) => byte === right[index]);
}

function withFinalizationTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	onTimeout: () => Error,
): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
	return new Promise<T>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(onTimeout());
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
