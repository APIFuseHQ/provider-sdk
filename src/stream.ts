import type { SseMessage } from "./types";

export interface SseEvent<TData = unknown> {
	event: string;
	data: TData;
	id?: string;
	retry?: number;
}

export interface SseErrorData {
	code: string;
	message: string;
	requestId?: string;
	retryable?: boolean;
	details?: unknown;
}

export const APIFUSE_STREAM_ERROR_EVENT = "apifuse.error";
export const APIFUSE_STREAM_DONE_EVENT = "apifuse.done";

export function event<TData>(
	eventName: string,
	data: TData,
	options: { id?: string; retry?: number } = {},
): SseEvent<TData> {
	return {
		event: eventName,
		data,
		...(options.id ? { id: options.id } : {}),
		...(options.retry !== undefined ? { retry: options.retry } : {}),
	};
}

export function error(
	code: string,
	message: string,
	options: Omit<SseErrorData, "code" | "message"> & {
		id?: string;
		retry?: number;
	} = {},
): SseEvent<SseErrorData> {
	const { id, retry, ...dataOptions } = options;
	return event(
		APIFUSE_STREAM_ERROR_EVENT,
		{ code, message, ...dataOptions },
		{ ...(id ? { id } : {}), ...(retry !== undefined ? { retry } : {}) },
	);
}

export function done(): SseEvent<Record<string, never>>;
export function done<TData>(
	data: TData,
	options?: { id?: string; retry?: number },
): SseEvent<TData>;
export function done<TData>(
	data?: TData,
	options: { id?: string; retry?: number } = {},
): SseEvent<TData | Record<string, never>> {
	return event(APIFUSE_STREAM_DONE_EVENT, data ?? {}, options);
}

export function encodeSseEvent(input: SseEvent): string {
	const lines: string[] = [];
	if (input.id !== undefined)
		lines.push(`id: ${sseFieldValue(input.id, "id")}`);
	if (input.event) lines.push(`event: ${sseFieldValue(input.event, "event")}`);
	if (input.retry !== undefined) {
		if (!Number.isInteger(input.retry) || input.retry < 0) {
			throw new TypeError("SSE retry must be a non-negative integer.");
		}
		lines.push(`retry: ${input.retry}`);
	}
	const data =
		typeof input.data === "string" ? input.data : JSON.stringify(input.data);
	for (const line of data.split(/\r?\n/)) {
		lines.push(`data: ${line}`);
	}
	return `${lines.join("\n")}\n\n`;
}

function sseFieldValue(value: string, field: "event" | "id"): string {
	if (/[\r\n]/.test(value)) {
		throw new TypeError(`SSE ${field} must not contain CR or LF.`);
	}
	return value;
}

export async function* readableBytes(
	body: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
	const reader = body.getReader();
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			if (value) yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

export async function* readableTextChunks(
	body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
	const decoder = new TextDecoder();
	for await (const chunk of readableBytes(body)) {
		yield decoder.decode(chunk, { stream: true });
	}
	const tail = decoder.decode();
	if (tail) yield tail;
}

export async function* readableLines(
	body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
	let buffer = "";
	for await (const chunk of readableTextChunks(body)) {
		buffer += chunk;
		for (;;) {
			const index = buffer.search(/\r?\n/);
			if (index < 0) break;
			const line = buffer.slice(0, index);
			const newlineLength =
				buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
			buffer = buffer.slice(index + newlineLength);
			yield line;
		}
	}
	if (buffer) yield buffer;
}

function createSseMessage(
	eventName: string,
	data: string,
	options: { id?: string; retry?: number },
): SseMessage {
	return {
		event: eventName || "message",
		data,
		...(options.id !== undefined ? { id: options.id } : {}),
		...(options.retry !== undefined ? { retry: options.retry } : {}),
		json<T = unknown>() {
			return parseJson<T>(data);
		},
	};
}

function parseJson<T>(data: string): T {
	return JSON.parse(data);
}

export async function* parseSseStream(
	body: ReadableStream<Uint8Array>,
): AsyncIterable<SseMessage> {
	let eventName = "message";
	let dataLines: string[] = [];
	let id: string | undefined;
	let retry: number | undefined;

	const dispatch = function* () {
		if (dataLines.length === 0 && id === undefined && retry === undefined) {
			return;
		}
		yield createSseMessage(eventName, dataLines.join("\n"), { id, retry });
		eventName = "message";
		dataLines = [];
		retry = undefined;
	};

	for await (const line of readableLines(body)) {
		if (line === "") {
			yield* dispatch();
			continue;
		}
		if (line.startsWith(":")) continue;
		const separator = line.indexOf(":");
		const field = separator < 0 ? line : line.slice(0, separator);
		const rawValue = separator < 0 ? "" : line.slice(separator + 1);
		const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
		switch (field) {
			case "event":
				eventName = value;
				break;
			case "data":
				dataLines.push(value);
				break;
			case "id":
				id = value;
				break;
			case "retry": {
				const parsed = Number(value);
				if (Number.isInteger(parsed) && parsed >= 0) retry = parsed;
				break;
			}
		}
	}
	yield* dispatch();
}

export const stream = {
	event,
	error,
	done,
	encodeSseEvent,
	parseSseStream,
	readableBytes,
	readableTextChunks,
	readableLines,
};
