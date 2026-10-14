import { AsyncLocalStorage } from "node:async_hooks";
import type { OutputUrlDrop } from "../output-url.js";

/** Receives every URL value an output-URL constructor dropped during one operation call. */
export interface OutputUrlDropSink {
	recordDrop(drop: OutputUrlDrop): void;
	markTelemetryFailed?(): void;
}

const scopes = new AsyncLocalStorage<OutputUrlDropSink>();

/**
 * Runs `fn` with `sink` as the receiver of output-URL drops made by mappers it
 * calls. Without a sink the drops are not observed; the dropped values are
 * still left out of the output.
 */
export function observeOutputUrlDrops<T>(sink: OutputUrlDropSink | undefined, fn: () => T): T {
	return sink ? scopes.run(sink, fn) : fn();
}

/** Records one dropped value on the active sink. Observation never fails the caller. */
export function recordOutputUrlDrop(drop: OutputUrlDrop): void {
	const sink = scopes.getStore();
	if (!sink) return;
	try {
		sink.recordDrop(drop);
	} catch {
		try {
			sink.markTelemetryFailed?.();
		} catch {
			// The failure marker is an observer too.
		}
	}
}
