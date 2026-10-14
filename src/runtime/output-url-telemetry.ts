import type { OutputUrlDrop, OutputUrlDropReason, OutputUrlKind } from "../output-url.js";
import type { OutputUrlDropSink } from "./output-url-observer.js";
import type { SpanIndex, TelemetryContributor } from "./request-telemetry.js";
import { boundedText } from "./resolver-telemetry.js";

/** One kind of dropped output URL, grouped by kind, reason and field label. */
export type OutputUrlDropGroup = {
	kind: OutputUrlKind;
	reason: OutputUrlDropReason;
	field?: string;
	count: number;
	/**
	 * First dropped value of the group, query and fragment removed, redacted and
	 * bounded; only the scheme for reason `scheme`; `[<typeof>]` for a value that
	 * is not a string; absent for a value whose authority carries `@`.
	 */
	example?: string;
};

/** `events` of the request log line: the output URLs mappers left out during the request. */
export type OutputUrlEventsLogPayload = {
	telemetryFailed?: true;
	outputUrlDropped: OutputUrlDropGroup[];
};

/**
 * Request-log observation events for output URLs that a constructor left out
 * (`toImageUrl`, `toItemPageUrl`, `toLinkUrl`, ...). Log-only: the `events`
 * key never reaches the gateway telemetry header. Groups are keyed by the
 * declared field label, so their number is bounded by the mapper code, not by
 * the size of the response. The header payload type is `Record<string, never>`
 * because `events` sits outside HEADER_PRIORITY and none is ever produced.
 */
export class OutputUrlTelemetryCollector
	implements
		TelemetryContributor<OutputUrlEventsLogPayload, Record<string, never>>,
		OutputUrlDropSink
{
	readonly key = "events" as const;
	readonly #redact?: (text: string) => string;
	readonly #groups = new Map<string, OutputUrlDropGroup>();
	#telemetryFailed = false;

	constructor(options: { redact?: (text: string) => string } = {}) {
		this.#redact = options.redact;
	}

	markTelemetryFailed(): void {
		this.#telemetryFailed = true;
	}

	recordDrop(drop: OutputUrlDrop): void {
		const key = JSON.stringify([drop.kind, drop.reason, drop.field ?? null]);
		const existing = this.#groups.get(key);
		if (existing) {
			existing.count = Math.min(Number.MAX_SAFE_INTEGER, existing.count + 1);
			return;
		}
		const example = drop.value === undefined ? undefined : this.#example(drop.value);
		this.#groups.set(key, {
			kind: drop.kind,
			reason: drop.reason,
			...(drop.field === undefined ? {} : { field: boundedText(drop.field, this.#redact) }),
			count: 1,
			...(example === undefined ? {} : { example }),
		});
	}

	toLogPayload(_spans: SpanIndex): OutputUrlEventsLogPayload | undefined {
		if (this.#groups.size === 0 && !this.#telemetryFailed) return undefined;
		return {
			...(this.#telemetryFailed ? { telemetryFailed: true as const } : {}),
			outputUrlDropped: [...this.#groups.values()].map((group) => ({ ...group })),
		};
	}

	toHeaderPayload(_log: OutputUrlEventsLogPayload): Record<string, never> | undefined {
		return undefined;
	}

	#example(value: string): string {
		// Query strings and fragments carry signatures and tracking tokens; the
		// scheme, host and path are what locate a mapping defect.
		const cut = value.search(/[?#]/);
		return boundedText(cut === -1 ? value : value.slice(0, cut), this.#redact);
	}
}
