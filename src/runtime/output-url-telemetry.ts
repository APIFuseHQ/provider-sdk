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
	/** First dropped value of the group, query and fragment removed; absent for credential-bearing URLs. */
	example?: string;
};

export type OutputUrlEventsLogPayload = {
	telemetryFailed?: true;
	outputUrlDropped: OutputUrlDropGroup[];
};

/** Never sent: the `events` key is log-only. Declared for the contributor contract. */
type OutputUrlEventsHeaderPayload = { count: number };

/**
 * Request-log observation events for output URLs that a constructor left out
 * (`toImageUrl`, `toItemPageUrl`, `toLinkUrl`, ...). Log-only: the `events`
 * key never reaches the gateway telemetry header. Groups are keyed by the
 * declared field label, so their number is bounded by the mapper code, not by
 * the size of the response.
 */
export class OutputUrlTelemetryCollector
	implements
		TelemetryContributor<OutputUrlEventsLogPayload, OutputUrlEventsHeaderPayload>,
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

	toHeaderPayload(_log: OutputUrlEventsLogPayload): OutputUrlEventsHeaderPayload | undefined {
		return undefined;
	}

	#example(value: string): string {
		// Query strings and fragments carry signatures and tracking tokens; the
		// scheme, host and path are what locate a mapping defect.
		const cut = value.search(/[?#]/);
		return boundedText(cut === -1 ? value : value.slice(0, cut), this.#redact);
	}
}
