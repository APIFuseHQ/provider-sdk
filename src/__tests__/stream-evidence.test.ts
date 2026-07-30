import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import { readableBytes, readableLines, readableTextChunks } from "../stream.js";
import {
	captureStreamEvidence,
	findStreamEvidenceRecord,
	parseStreamEvidenceRecord,
	replayStreamEvidence,
	STREAM_PREVIEW_BYTES,
} from "../stream-evidence.js";
import type { HttpStreamResponse } from "../types.js";

function streamResponse(
	body: ReadableStream<Uint8Array>,
	headers: Record<string, string> = { "content-type": "application/octet-stream" },
): HttpStreamResponse {
	return {
		status: 200,
		ok: true,
		headers,
		body,
		bytes: () => readableBytes(body),
		textChunks: () => readableTextChunks(body),
		lines: () => readableLines(body),
	};
}

function evidenceFor(preview: Uint8Array, bodyBytes = preview.byteLength) {
	return {
		__apifuse_stream__: true as const,
		status: 200,
		ok: true,
		headers: {
			"content-length": String(bodyBytes),
			"content-type": "application/octet-stream",
		},
		body_sha256: createHash("sha256").update(preview).digest("hex"),
		body_bytes: bodyBytes,
		body_preview_base64: Buffer.from(preview).toString("base64"),
	};
}

describe("stream evidence capture", () => {
	it("passes chunks through before EOF and retains only the configured preview", async () => {
		let nextChunk = 0;
		const chunk = new Uint8Array(1024).fill(0x61);
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (nextChunk === 32) {
					controller.close();
					return;
				}
				controller.enqueue(chunk.slice());
				nextChunk += 1;
			},
		});
		const capture = captureStreamEvidence(streamResponse(source), {
			requestUrl: "https://example.test/large.bin",
		});
		const iterator = capture.response.bytes()[Symbol.asyncIterator]();

		const first = await iterator.next();
		expect(first.done).toBe(false);
		expect(nextChunk).toBeLessThan(32);

		let receivedBytes = first.value?.byteLength ?? 0;
		for (;;) {
			const result = await iterator.next();
			if (result.done) break;
			receivedBytes += result.value.byteLength;
		}
		const evidence = await capture.getEvidence();

		expect(receivedBytes).toBe(32 * chunk.byteLength);
		expect(evidence.body_bytes).toBe(receivedBytes);
		expect(Buffer.from(evidence.body_preview_base64, "base64")).toHaveLength(STREAM_PREVIEW_BYTES);
	});

	it("drains partial consumption to the same evidence as full consumption", async () => {
		const chunks = [
			new Uint8Array(2048).fill(0x61),
			new Uint8Array(3072).fill(0x62),
			new Uint8Array(1024).fill(0x63),
		];
		const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
		const createSource = () =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk.slice());
					controller.close();
				},
			});
		const fullCapture = captureStreamEvidence(streamResponse(createSource()), {
			requestUrl: "https://example.test/full.bin",
		});
		for await (const _chunk of fullCapture.response.bytes()) {
			// Consume the full comparison stream.
		}

		const partialCapture = captureStreamEvidence(streamResponse(createSource()), {
			requestUrl: "https://example.test/partial.bin",
		});
		const reader = partialCapture.response.body.getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);
		reader.releaseLock();

		const [fullEvidence, partialEvidence] = await Promise.all([
			fullCapture.getEvidence(),
			partialCapture.getEvidence(),
		]);
		expect(partialEvidence.body_bytes).toBe(body.byteLength);
		expect(partialEvidence.body_sha256).toBe(createHash("sha256").update(body).digest("hex"));
		expect(partialEvidence).toEqual(fullEvidence);
	});

	it("drains from the retained upstream reader after the handler cancels", async () => {
		const body = new Uint8Array(STREAM_PREVIEW_BYTES + 257).map((_, index) => index % 251);
		let upstreamCanceled = false;
		let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				sourceController = controller;
				controller.enqueue(body.subarray(0, 1024));
			},
			cancel() {
				upstreamCanceled = true;
			},
		});
		const capture = captureStreamEvidence(streamResponse(source), {
			requestUrl: "https://example.test/canceled.bin",
		});
		const reader = capture.response.body.getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);
		await reader.cancel("handler has enough metadata");

		const evidencePromise = capture.getEvidence();
		sourceController?.enqueue(body.subarray(1024));
		sourceController?.close();
		const evidence = await evidencePromise;
		expect(upstreamCanceled).toBe(false);
		expect(evidence.body_bytes).toBe(body.byteLength);
		expect(evidence.body_sha256).toBe(createHash("sha256").update(body).digest("hex"));
		expect(Buffer.from(evidence.body_preview_base64, "base64")).toEqual(
			Buffer.from(body.subarray(0, STREAM_PREVIEW_BYTES)),
		);
	});

	it("preserves a stream read failure as the contextual error cause", async () => {
		const originalError = new Error("socket reset");
		let pulls = 0;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls === 1) controller.enqueue(new Uint8Array([1, 2]));
				else controller.error(originalError);
			},
		});
		const capture = captureStreamEvidence(streamResponse(source), {
			requestUrl: "https://example.test/fails",
		});

		let thrown: unknown;
		try {
			for await (const _chunk of capture.response.bytes()) {
				// Consume until the upstream read fails.
			}
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toMatch(/read failed.*status=200.*bytes_read=2/);
		expect((thrown as Error).cause).toBe(originalError);
		await expect(capture.getEvidence()).rejects.toBe(thrown);
	});

	it("fails loudly when the upstream errors while finalization drains it", async () => {
		const originalError = new Error("connection aborted");
		let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				sourceController = controller;
				controller.enqueue(new Uint8Array([1, 2]));
			},
		});
		const capture = captureStreamEvidence(streamResponse(source), {
			requestUrl: "https://example.test/drain-fails",
		});
		const reader = capture.response.body.getReader();
		await reader.read();
		reader.releaseLock();

		const evidencePromise = capture.getEvidence();
		sourceController?.error(originalError);

		let thrown: unknown;
		try {
			await evidencePromise;
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toMatch(
			/read failed.*url=https:\/\/example\.test\/drain-fails.*status=200.*bytes_read=2/,
		);
		expect((thrown as Error).cause).toBe(originalError);
	});
});

describe("stream evidence validation and replay", () => {
	it("enforces canonical bounded previews and allowlisted headers", () => {
		const preview = new Uint8Array(STREAM_PREVIEW_BYTES).fill(0x42);
		expect(parseStreamEvidenceRecord(evidenceFor(preview, 805_000)).body_bytes).toBe(805_000);

		expect(() => parseStreamEvidenceRecord(evidenceFor(new Uint8Array([1, 2, 3]), 10))).toThrow(
			/preview must decode to 10 bytes/,
		);
		expect(() =>
			parseStreamEvidenceRecord({
				...evidenceFor(new Uint8Array([1, 2, 3])),
				headers: { authorization: "Bearer secret" },
			}),
		).toThrow(/header "authorization" is not allowlisted/);
		expect(() =>
			parseStreamEvidenceRecord({
				...evidenceFor(new Uint8Array(STREAM_PREVIEW_BYTES + 1)),
				body_bytes: STREAM_PREVIEW_BYTES + 1,
			}),
		).toThrow(new RegExp(`preview must decode to ${STREAM_PREVIEW_BYTES} bytes`));
	});

	it("selects the latest appended evidence record and diagnoses malformed markers", () => {
		const first = evidenceFor(new Uint8Array([1]));
		const latest = evidenceFor(new Uint8Array([2]));
		expect(findStreamEvidenceRecord([{ ordinary: true }, first, latest])).toEqual(latest);
		expect(() =>
			findStreamEvidenceRecord([{ ordinary: true }, { ...latest, body_preview_base64: "%%%" }]),
		).toThrow(/body_preview_base64.*canonical base64/);
	});

	it("omits the original content-length when replaying only the preview", async () => {
		const preview = new Uint8Array(STREAM_PREVIEW_BYTES).fill(0x63);
		const replay = replayStreamEvidence(evidenceFor(preview, 9000));
		let replayBytes = 0;
		for await (const chunk of replay.bytes()) replayBytes += chunk.byteLength;

		expect(replayBytes).toBe(STREAM_PREVIEW_BYTES);
		expect(replay.headers["content-length"]).toBeUndefined();
		expect(replay.body_bytes).toBe(9000);
	});
});
