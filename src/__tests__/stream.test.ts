import { describe, expect, it } from "bun:test";

import {
	APIFUSE_STREAM_ERROR_EVENT,
	done,
	encodeSseEvent,
	error,
	event,
	parseSseStream,
} from "../stream.js";

function streamFromText(value: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(value));
			controller.close();
		},
	});
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}

describe("stream helpers", () => {
	it("encodes typed SSE events", () => {
		expect(encodeSseEvent(event("delta", { id: "item_1", value: 42 }, { id: "evt_1" }))).toBe(
			'id: evt_1\nevent: delta\ndata: {"id":"item_1","value":42}\n\n',
		);
	});

	it("rejects SSE field injection in encoded event metadata", () => {
		expect(() => encodeSseEvent(event("delta", "ok", { id: "evt_1\nevent: forged" }))).toThrow(
			"SSE id must not contain CR or LF",
		);
		expect(() => encodeSseEvent(event("delta", "ok", { retry: -1 }))).toThrow(
			"SSE retry must be a non-negative integer",
		);
	});

	it("creates terminal error and done events", () => {
		expect(error("upstream_failed", "Upstream failed").event).toBe(APIFUSE_STREAM_ERROR_EVENT);
		expect(done().event).toBe("apifuse.done");
	});

	it("parses SSE messages with ids, retry, comments, and JSON data", async () => {
		const messages = await collect(
			parseSseStream(
				streamFromText(
					[": heartbeat", "id: evt_1", "event: delta", "retry: 1500", 'data: {"ok":true}', ""].join(
						"\n",
					),
				),
			),
		);

		expect(messages).toHaveLength(1);
		expect(messages[0]?.event).toBe("delta");
		expect(messages[0]?.id).toBe("evt_1");
		expect(messages[0]?.retry).toBe(1500);
		expect(messages[0]?.json<{ ok: boolean }>()).toEqual({ ok: true });
	});
});
