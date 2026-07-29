import { createHash } from "node:crypto";

import { readableBytes, readableLines, readableTextChunks } from "./stream.js";
import type { HttpStreamResponse } from "./types.js";

const STREAM_PREVIEW_BYTES = 4096;
const STREAM_EVIDENCE_HEADERS = new Set(["content-disposition", "content-length", "content-type"]);

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

export function isStreamEvidenceRecord(value: unknown): value is StreamEvidenceRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const record = value as Record<string, unknown>;
	return (
		record.__apifuse_stream__ === true &&
		Number.isInteger(record.status) &&
		typeof record.ok === "boolean" &&
		isStringRecord(record.headers) &&
		typeof record.body_sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(record.body_sha256) &&
		Number.isInteger(record.body_bytes) &&
		(record.body_bytes as number) >= 0 &&
		typeof record.body_preview_base64 === "string"
	);
}

export async function captureStreamEvidence(
	response: HttpStreamResponse,
): Promise<{ evidence: StreamEvidenceRecord; response: HttpStreamResponse }> {
	const chunks: Uint8Array[] = [];
	const previewChunks: Uint8Array[] = [];
	const hash = createHash("sha256");
	let bodyBytes = 0;
	let previewBytes = 0;

	for await (const chunk of response.bytes()) {
		const ownedChunk = chunk.slice();
		chunks.push(ownedChunk);
		hash.update(ownedChunk);
		bodyBytes += ownedChunk.byteLength;

		if (previewBytes < STREAM_PREVIEW_BYTES) {
			const previewChunk = ownedChunk.slice(0, STREAM_PREVIEW_BYTES - previewBytes);
			previewChunks.push(previewChunk);
			previewBytes += previewChunk.byteLength;
		}
	}

	const body = concatBytes(chunks, bodyBytes);
	const preview = concatBytes(previewChunks, previewBytes);
	const evidence: StreamEvidenceRecord = {
		__apifuse_stream__: true,
		status: response.status,
		ok: response.ok,
		headers: evidenceHeaders(response.headers),
		body_sha256: hash.digest("hex"),
		body_bytes: bodyBytes,
		body_preview_base64: Buffer.from(preview).toString("base64"),
	};

	return {
		evidence,
		response: streamResponseFromBytes(response.status, response.ok, response.headers, body),
	};
}

export function replayStreamEvidence(evidence: StreamEvidenceRecord): StreamEvidenceReplayResponse {
	const preview = new Uint8Array(Buffer.from(evidence.body_preview_base64, "base64"));
	return {
		...streamResponseFromBytes(evidence.status, evidence.ok, evidence.headers, preview),
		evidence_only: true,
		body_sha256: evidence.body_sha256,
		body_bytes: evidence.body_bytes,
	};
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

function concatBytes(chunks: Uint8Array[], totalBytes: number): Uint8Array {
	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined;
}

function streamResponseFromBytes(
	status: number,
	ok: boolean,
	headers: Record<string, string>,
	bytes: Uint8Array,
): HttpStreamResponse {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			if (bytes.byteLength > 0) {
				controller.enqueue(bytes.slice());
			}
			controller.close();
		},
	});

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
